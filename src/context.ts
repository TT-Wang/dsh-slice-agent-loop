/**
 * Append-only session tape on the stock ordered surface.
 *
 * Every completed turn beyond `keepRecentTurns` is sealed into one frozen
 * `[slice tape v1 …]` entry at that turn's own position, at the first step of
 * the next turn. An entry is a pure function of the nodes it shadows and is
 * NEVER re-rendered or nested: the seal replaces the newest unsealed span, so
 * every byte before it is identical to the previous request and DeepSeek's
 * prefix cache keeps hitting. The re-billed suffix is the new entry itself,
 * not the whole conversation.
 *
 * That is the one property this module exists to protect. The alternative it
 * replaced — leave history raw, then collapse the OLDEST turns under pressure —
 * kept more verbatim text but rewrote the prefix at its first message, so each
 * archive re-billed the entire view. Measured on 14 recorded member sessions of
 * a live controller: an archive every ~2 turns, ~148K fresh tokens each, ~8.6%
 * of total weighted cost, against ~0.6K per turn for tail sealing.
 *
 * Superseded runtime-context snapshots need no separate shadowing here: the
 * host projects one per change and each declares the earlier ones obsolete, and
 * the turn they belong to absorbs them as one note line when it seals. Only the
 * last-resort tier (a request that cannot fit even with every turn sealed) ever
 * rewrites existing entries, and it says so through `warn`.
 */
import { createUserMessage, type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage, type Session, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import { renderTapeReply, type ReplyCaps } from './slice/tape.js'

export const HISTORY_SOURCE = 'slice:history'
export const CHECKPOINT_PREFIX = '[slice checkpoint v1 · turns '
/** Header of a sealed entry. Sessions written by the pressure-archive build carry CHECKPOINT_PREFIX; both parse. */
export const TAPE_PREFIX = '[slice tape v1 · turns '
/** Stand-in for superseded runtime snapshots in the raw recent tail, appended only at an archive event. */
export const SNAPSHOT_NOTE_PREFIX = '[slice note · '
/** The host's runtime-context projection (dsh-agent-loop RuntimeContextProjection). */
export const RUNTIME_CONTEXT_SOURCE = '@deepseek-ai/dsh-system-prompt'

export class SliceBudgetError extends Error {
  constructor(message: string) { super(message); this.name = 'SliceBudgetError' }
}

export interface HistoryPolicy {
  /** Completed turns kept raw at the tail; 0 seals a turn as soon as the next one starts. */
  keepRecentTurns: number
  pinFirstTurn: boolean
  pinUserChars: number
  /** Target for one sealed entry's text; a span of many short turns may exceed it. */
  entryMaxChars: number
  /** Explicit extra cap on rendered history (entries + retained raw turn text). Exceeding it rewrites entries. */
  maxHistoryChars?: number
  maxRequestChars: number
}

export interface PlannedAppend {
  message: UserMessage
  start: SessionSeq
  end: SessionSeq
  sources: SessionSeq[]
}

export interface ArchivePlan {
  appends: PlannedAppend[]
  /** Serialized final view (history + pending messages) after the plan. */
  viewChars: number
  /** Serialized rendered history after the plan. */
  historyChars: number
}

/** Operator-facing notices (the plugin wires this to ctx.logger.warn). */
export type Warn = (message: string) => void

const USER_HEAD = 600
const USER_TAIL = 300
const TOOL_LINES_PER_TURN = 6

function chars(value: unknown): number {
  return Array.from(JSON.stringify(value)).length
}

function textOf(message: Message): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

export function ours(event: SessionEvent): boolean {
  return event.type === 'user/message' && event.data.source.kind === 'plugin'
    && event.data.source.plugin === HISTORY_SOURCE
}

/**
 * One host-projected runtime-context snapshot. The host emits one per change and
 * each snapshot's own text declares that it supersedes the earlier ones, so only
 * the newest one carries live information.
 */
function runtimeSnapshot(event: SessionEvent): boolean {
  return event.type === 'user/message' && event.data.source.kind === 'plugin'
    && event.data.source.plugin === RUNTIME_CONTEXT_SOURCE
}

/** True for a message the host's runtime-context projection just produced. */
export function isRuntimeSnapshot(message: Message): boolean {
  return message.role === 'user' && message.source.kind === 'plugin'
    && message.source.plugin === RUNTIME_CONTEXT_SOURCE
}

/** Original append events behind a node; only our own replacements are expanded. */
function originsOf(session: Session, seqs: readonly SessionSeq[]): SessionEvent[] {
  const seen = new Set<SessionSeq>()
  const found: SessionEvent[] = []
  const visit = (seq: SessionSeq): void => {
    if (seen.has(seq)) return
    seen.add(seq)
    const event = session.eventAt(seq)
    if (!event) return
    if (ours(event) && 'sourceEventSeqs' in event && event.sourceEventSeqs) event.sourceEventSeqs.forEach(visit)
    else found.push(event)
  }
  seqs.forEach(visit)
  return found.sort((a, b) => a.seq - b.seq)
}

/**
 * Tool-call ids with no partner. A turn is archived only when this is empty:
 * shadowing half of a call/result pair would leave an unmatched tool block on
 * the request surface. Ids rather than a boolean, so the cut can be reported.
 */
function unpairedCalls(messages: readonly Message[]): string[] {
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool-call') calls.add(block.id)
      if (block.type === 'tool-result') results.add(block.toolCallId)
    }
  }
  return [...new Set([...calls, ...results])].filter(id => !calls.has(id) || !results.has(id))
}

interface Node {
  seq: SessionSeq
  event: SessionEvent
  /** Null for surface nodes that derive no message (an empty assistant reply); they still occupy the range. */
  message: Message | null
  size: number
  /** Turn range the node belongs to (a checkpoint spans several turns). */
  turns: [number, number]
  protected: boolean
  /**
   * A runtime snapshot a newer one supersedes, or our own note standing in for such snapshots:
   * archivable, and rendered in a checkpoint only as a note, never as a request line.
   */
  superseded: boolean
  /** Turns recall_turn attributes the snapshot(s) to (src/recall.ts ownerOf), 0 for none. */
  recallTurns: number[]
}

interface Layout { nodes: Node[]; completedThrough: number; lastTurn: number; toolNames: Map<string, string> }

/**
 * Protection per surface node. Current input, instruction and plugin messages,
 * multimodal user content and the LIVE runtime snapshot keep their positions.
 * The live snapshot is the newest one: the one `pending` is about to append when
 * the host projected a change this step, else the newest on the surface. It is
 * never shadowed — the host's RuntimeContextProjection retains that one seq and
 * would reproject if a replacement named it. Every older snapshot is superseded
 * by the host's own declaration and is archivable history — in the open turn
 * too (a turn whose context changes every step), where only noteRuns may touch
 * it. A snapshot no recall page serves (one projected before the first turn)
 * stays protected: omitting it would be unrecoverable.
 */
function inspectSurface(session: Session, pinFirstTurn: boolean, pending: readonly Message[]): Layout {
  const turnAt = new Map<SessionSeq, number>()
  // Recall owner at append time, as src/recall.ts ownerOf attributes a runtime
  // snapshot (a plugin message): the open turn, else the turn that just ended, else 0.
  const recallAt = new Map<SessionSeq, number>()
  const toolNames = new Map<string, string>()
  let turn = 0
  let open = 0
  let ended = 0
  let completedThrough = -1
  let lastTurn = 0
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start') { turn = event.data.turn; open = event.data.turn }
    if (event.type === 'tool/call') toolNames.set(event.data.callId, event.data.name)
    turnAt.set(event.seq, turn)
    recallAt.set(event.seq, open || ended)
    if (event.type === 'turn/end') {
      completedThrough = event.seq
      lastTurn = Math.max(lastTurn, event.data.turn)
      ended = event.data.turn
      if (event.data.turn === open) open = 0
    }
  }
  const turnOf = (event: SessionEvent): number =>
    event.type === 'assistant/message' || event.type === 'tool/result' ? event.data.turn : turnAt.get(event.seq) ?? 0
  const rangeOf = (event: SessionEvent): [number, number] => {
    if (ours(event)) {
      const header = /^\[slice (?:checkpoint|tape) v1 · turns (\d+)-(\d+)/.exec(textOf(deriveEventMessage(event)!))
      if (header) return [Number(header[1]), Number(header[2])]
      const turns = originsOf(session, [event.seq]).map(turnOf).filter(t => t >= 1)
      return turns.length ? [Math.min(...turns), Math.max(...turns)] : [0, 0]
    }
    const t = turnOf(event)
    return [t, t]
  }
  let live: SessionSeq | undefined
  if (!pending.some(isRuntimeSnapshot)) {
    const surface = session.surface.nodes
    for (let index = surface.length - 1; index >= 0 && live === undefined; index -= 1) {
      if (runtimeSnapshot(session.eventAt(surface[index]!)!)) live = surface[index]
    }
  }
  let pinned = false
  const nodes: Node[] = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)!
    const message = deriveEventMessage(event)
    const turns = rangeOf(event)
    let guarded = seq > completedThrough || turns[0] < 1
    let superseded = false
    let recallTurns = [recallAt.get(seq) ?? 0]
    if (runtimeSnapshot(event)) {
      // Not the open-turn guard: a dead snapshot of the open turn is still dead.
      guarded = seq === live || recallTurns[0]! < 1
      superseded = !guarded
    } else if (ours(event)) {
      const sources = 'sourceEventSeqs' in event ? event.sourceEventSeqs ?? [] : []
      if (sources.length && sources.every(source => { const origin = session.eventAt(source); return origin !== undefined && runtimeSnapshot(origin) })) {
        superseded = true
        recallTurns = sources.map(source => recallAt.get(source) ?? 0)
      }
    } else if (event.type === 'user/message') {
      const own = event.surfaceOp === 'append' && event.data.source.kind === 'user' && event.data.content.every(block => block.type === 'text')
      if (!own) guarded = true
      else if (pinFirstTurn && !pinned && turns[0] === 1) { pinned = true; guarded = true }
    }
    nodes.push({ seq, event, message, size: message ? chars(message) : 0, turns, protected: guarded,
      superseded: superseded && !guarded, recallTurns })
  }
  return { nodes, completedThrough, lastTurn, toolNames }
}

interface Run { nodes: Node[]; message: UserMessage }

interface TurnItem { kind: 'turn'; turn: number; users: string[]; reply: string; tools: string[]; snapshots: number[] }
interface EarlierItem { kind: 'earlier'; turns: [number, number] }

function excerpt(text: string, verbatimUpTo: number, head: number, tail: number): string {
  const all = Array.from(text)
  if (all.length <= verbatimUpTo || all.length <= head + tail) return text
  return `${all.slice(0, head).join('')}…[+${all.length - head - tail} chars, recall_turn]…${all.slice(all.length - tail).join('')}`
}

function collectItems(session: Session, run: readonly Node[], toolNames: Map<string, string>): Array<TurnItem | EarlierItem> {
  const items: Array<TurnItem | EarlierItem> = []
  let current: TurnItem | undefined
  for (const node of run) {
    const { event } = node
    if (ours(event) && !node.superseded) { items.push({ kind: 'earlier', turns: node.turns }); current = undefined; continue }
    const turn = node.turns[0]
    if (!current || current.turn !== turn) { current = { kind: 'turn', turn, users: [], reply: '', tools: [], snapshots: [] }; items.push(current) }
    // A superseded snapshot is neither user speech nor current truth: never a request line.
    if (node.superseded) { current.snapshots.push(...node.recallTurns); continue }
    if (!node.message) continue
    if (event.type === 'user/message') current.users.push(textOf(node.message))
    else if (event.type === 'assistant/message') {
      const text = textOf(node.message)
      if (text) current.reply = text
    } else if (event.type === 'tool/result') {
      // Point at the original append record: that is where the full text lives.
      const origin = event.surfaceOp === 'append' ? event : session.eventAt(event.sourceEventSeqs?.[0] ?? event.seq) ?? event
      const source = origin.type === 'tool/result' ? origin : event
      const blocks = source.data.message.content
      const name = blocks.map(block => toolNames.get(block.toolCallId) ?? 'tool').filter((n, i, a) => a.indexOf(n) === i).join(', ')
      const size = blocks.flatMap(block => block.content ?? []).reduce((n, b) => n + (b.type === 'text' ? Array.from(b.text).length : 0), 0)
      current.tools.push(`[tool turn ${turn} step ${source.data.step} seq ${source.seq} · ${name} · ${size} chars · expand_result({"seq":${source.seq}})]`)
    }
  }
  return items
}

/** One line for every superseded runtime snapshot of a turn; the text stays on its recall page. */
export function snapshotNote(recallTurns: readonly number[]): string {
  const count = recallTurns.length
  const noun = count === 1 ? 'runtime-context snapshot' : `${count} runtime-context snapshots`
  const turns = [...new Set(recallTurns.filter(t => t >= 1))]
  const where = turns.length
    ? turns.map(t => `recall_turn({"turn":"${t}"})`).join(', ')
    : 'recall_search({"query":"...","kinds":["context"]})'
  return `${SNAPSHOT_NOTE_PREFIX}${noun} superseded by a later one; not repeated here · verbatim: ${where}]`
}

interface Shrink { tools: boolean; userHead: number; userTail: number; reply: ReplyCaps; bare?: boolean }

function renderItems(items: ReadonlyArray<TurnItem | EarlierItem>, range: [number, number], count: number, pinUserChars: number, shrink: Shrink): string {
  const lines = [`${TAPE_PREFIX}${range[0]}-${range[1]} · ${count} turn(s) sealed · recall_turn({"turn":"<n>","view":"dialogue"}) returns a turn's dialogue; expand_result({"seq":<q>}) returns a tool result]`]
  if (shrink.bare) {
    lines.push('[turn bodies omitted from this request view to fit maxRequestChars; recorded history is unchanged and every turn above is served verbatim by recall_turn]')
    return lines.join('\n')
  }
  for (const item of items) {
    if (item.kind === 'earlier') { lines.push(`[earlier checkpoint covered turns ${item.turns[0]}-${item.turns[1]}; recall_turn for details]`); continue }
    lines.push(`[turn ${item.turn}]`)
    item.users.forEach((text, index) => {
      const body = excerpt(text, shrink.userHead >= USER_HEAD ? pinUserChars : 0, shrink.userHead, shrink.userTail)
      lines.push(index === 0 ? body : `[user]\n${body}`)
    })
    if (item.snapshots.length) lines.push(snapshotNote(item.snapshots))
    if (item.reply) lines.push(renderTapeReply(`slice-turn-${item.turn}`, item.reply, shrink.reply).trimEnd())
    if (shrink.tools && item.tools.length) {
      lines.push(...item.tools.slice(0, TOOL_LINES_PER_TURN))
      if (item.tools.length > TOOL_LINES_PER_TURN) lines.push(`[+${item.tools.length - TOOL_LINES_PER_TURN} more tool results]`)
    }
  }
  return lines.join('\n')
}

/**
 * Deterministic checkpoint text: drop tool lines first, then shrink excerpts until it fits.
 * `maxChars` is a target: the smallest level is returned as is when even it does not fit.
 * `bare` (last-resort degradation only) renders the header and a recall pointer, nothing else.
 */
export function renderCheckpoint(session: Session, run: readonly Node[], toolNames: Map<string, string>, pinUserChars: number, maxChars: number, bare = false): string {
  const items = collectItems(session, run, toolNames)
  const covered = new Set<number>()
  for (const item of items) {
    if (item.kind === 'turn') covered.add(item.turn)
    else for (let t = item.turns[0]; t <= item.turns[1]; t += 1) covered.add(t)
  }
  const range: [number, number] = [Math.min(...covered), Math.max(...covered)]
  const levels: Shrink[] = [{ tools: true, userHead: USER_HEAD, userTail: USER_TAIL, reply: { cap: 2000, head: 1400, tail: 500 } }]
  levels.push({ ...levels[0]!, tools: false })
  for (let divisor = 2; divisor <= 16; divisor *= 2) {
    levels.push({ tools: false, userHead: Math.floor(USER_HEAD / divisor), userTail: Math.floor(USER_TAIL / divisor),
      reply: { cap: Math.floor(2000 / divisor), head: Math.floor(1400 / divisor), tail: Math.floor(500 / divisor) } })
  }
  if (bare) return renderItems(items, range, covered.size, pinUserChars, { ...levels[levels.length - 1]!, bare: true })
  let text = ''
  for (const level of levels) {
    text = renderItems(items, range, covered.size, pinUserChars, level)
    if (Array.from(text).length <= maxChars) return text
  }
  return text
}

/**
 * Decide the whole seal before any append. Returns an empty plan when every
 * completed turn beyond the keep window is already sealed.
 *
 * The first tier seals those turns and nothing else, so the replacement lands
 * after every existing entry and the prefix before it is byte-identical to the
 * previous request. Only a request still above maxRequestChars degrades
 * further: the kept tail is sealed too, then every entry is rewritten bare —
 * which does rewrite the prefix, and says so through `warn`. It throws
 * SliceBudgetError (with no appends) only when the protected floor plus the
 * current input cannot fit on their own.
 */
export function planSeal(session: Session, pending: readonly Message[], policy: HistoryPolicy, warn?: Warn): ArchivePlan {
  const layout = inspectSurface(session, policy.pinFirstTurn, pending)
  const messagesOf = (nodes: readonly Node[]): Message[] => nodes.flatMap(node => node.message ? [node.message] : [])
  const view = (runs: readonly Run[]): { viewChars: number; historyChars: number } => {
    const messages: Message[] = []
    let historyChars = 0
    const replaced = new Map<SessionSeq, Run>()
    const shadowed = new Set<SessionSeq>()
    for (const run of runs) {
      replaced.set(run.nodes[0]!.seq, run)
      run.nodes.forEach(node => shadowed.add(node.seq))
    }
    for (const node of layout.nodes) {
      const run = replaced.get(node.seq)
      if (run) { messages.push(run.message); historyChars += chars(run.message); continue }
      if (shadowed.has(node.seq)) continue
      if (node.message) messages.push(node.message)
      if (!node.protected) historyChars += node.size
    }
    return { viewChars: chars([...messages, ...pending]), historyChars }
  }
  const fits = (measure: { viewChars: number }): boolean => measure.viewChars <= policy.maxRequestChars
  const overHistory = (measure: { historyChars: number }): boolean =>
    policy.maxHistoryChars !== undefined && measure.historyChars > policy.maxHistoryChars
  const initial = view([])
  /** An entry already on the surface. Frozen: re-rendering one rewrites the prefix it sits in. */
  const sealedEntry = (node: Node): boolean => ours(node.event) && !node.superseded
  // The only trigger. One seal costs the entry it writes, so there is nothing to wait for — and waiting is
  // exactly what makes the rewrite expensive, because by then the span to replace sits under everything newer.
  const sealBefore = layout.lastTurn - policy.keepRecentTurns + 1

  const cuts = new Map<string, string>()
  const buildRuns = (before: number, bare: boolean, thaw: boolean): Run[] => {
    const runs: Run[] = []
    let current: Node[] = []
    const push = (nodes: Node[]): void => {
      if (!nodes.length) return
      const text = renderCheckpoint(session, nodes, layout.toolNames, policy.pinUserChars, policy.entryMaxChars, bare)
      runs.push({ nodes, message: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: HISTORY_SOURCE } }) })
    }
    // A turn whose calls are not all closed cuts the run instead of suppressing it (calls close within their turn),
    // and says so: a silent cut looks exactly like an archive that never shrinks the view (A-RT-05).
    const flush = (): void => {
      let segment: Node[] = []
      for (let i = 0; i < current.length;) {
        let j = i + 1
        while (j < current.length && current[j]!.turns[1] === current[i]!.turns[1]) j += 1
        const turn = current.slice(i, j)
        const unpaired = unpairedCalls(messagesOf(turn))
        if (!unpaired.length) segment.push(...turn)
        else {
          const key = `${turn[0]!.seq}`
          if (!cuts.has(key)) cuts.set(key, `slice tape: turn ${turn[0]!.turns[1]} (seq ${turn[0]!.seq}..${turn[turn.length - 1]!.seq}) kept raw and cut the sealed span, unpaired tool call/result ${unpaired.join(', ')}`)
          push(segment)
          segment = []
        }
        i = j
      }
      push(segment)
      current = []
    }
    for (const node of layout.nodes) {
      if (!node.protected && node.turns[1] < before && (thaw || !sealedEntry(node))) current.push(node)
      else flush()
    }
    flush()
    return runs
  }
  // Superseded runtime snapshots no chosen checkpoint covers (the recent tail, a turn cut by an unclosed
  // call) are shadowed by a one-line note at the same event: the prefix is rewritten at the first
  // replacement anyway, so nothing superseded survives an archive and no later turn pays for it.
  const noteRuns = (covered: ReadonlySet<SessionSeq>): Run[] => {
    const runs: Run[] = []
    let group: Node[] = []
    const push = (): void => {
      if (!group.length) return
      const text = snapshotNote(group.flatMap(node => node.recallTurns))
      runs.push({ nodes: group, message: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: HISTORY_SOURCE } }) })
      group = []
    }
    for (const node of layout.nodes) {
      if (node.superseded && runtimeSnapshot(node.event) && !covered.has(node.seq)) group.push(node)
      else push()
    }
    push()
    return runs
  }
  const withNotes = (chosen: readonly Run[]): Run[] => {
    const covered = new Set(chosen.flatMap(run => run.nodes.map(node => node.seq)))
    return [...chosen, ...noteRuns(covered)].sort((a, b) => a.nodes[0]!.seq - b.nodes[0]!.seq)
  }
  const choose = (runs: readonly Run[], notes: boolean): { plan: Run[]; measure: { viewChars: number; historyChars: number } } => {
    const plan = notes ? withNotes(runs) : [...runs]
    return { plan, measure: view(plan) }
  }

  // Degradation tiers, each tried only when the previous one cannot fit maxRequestChars.
  const everything = layout.lastTurn + 1
  const tiers: Array<{ before: number; bare: boolean; thaw: boolean; notes: boolean; note?: string }> = [
    { before: sealBefore, bare: false, thaw: false, notes: false },
    { before: everything, bare: false, thaw: false, notes: false, note: 'sealed the kept recent turn(s) as well' },
    { before: everything, bare: true, thaw: true, notes: true, note: 'rewrote every entry without turn bodies and shadowed superseded runtime snapshots (recall_turn still serves them). This rewrites the request prefix, so the next request pays a full cache miss' },
  ]
  let result = { plan: [] as Run[], measure: initial }
  let used = tiers[0]!
  for (const tier of tiers) {
    result = choose(buildRuns(tier.before, tier.bare, tier.thaw), tier.notes)
    used = tier
    if (fits(result.measure) && !overHistory(result.measure)) break
  }
  for (const message of cuts.values()) warn?.(message)
  const { plan, measure } = result
  if (!fits(measure)) {
    throw new SliceBudgetError(`Request messages need ${measure.viewChars} characters even after sealing every completed turn (${plan.length} entry/entries), above maxRequestChars=${policy.maxRequestChars}: the protected context plus the current input do not fit. Nothing was truncated and the durable record is unchanged, but every later turn of this session fails the same way until maxRequestChars is raised, the protected context shrinks, or a new session is started.`)
  }
  if (used.note && plan.length > 0) warn?.(`slice tape: request needed ${initial.viewChars} characters, above maxRequestChars=${policy.maxRequestChars}; ${used.note}`)
  const appends = plan.map(run => ({
    message: run.message,
    start: run.nodes[0]!.seq, end: run.nodes[run.nodes.length - 1]!.seq, sources: run.nodes.map(node => node.seq),
  }))
  return { appends, ...measure }
}

export function applySeal(session: Session, plan: ArchivePlan): void {
  for (const append of plan.appends) {
    session.append('user/message', append.message, { surfaceOp: { op: 'replace', start: append.start, end: append.end }, sourceEventSeqs: append.sources })
  }
}

/** Plan and apply in one call; the decision is complete before the first append. */
export function sealCompletedTurns(session: Session, pending: readonly Message[], policy: HistoryPolicy, warn?: Warn): ArchivePlan {
  const plan = planSeal(session, pending, policy, warn)
  applySeal(session, plan)
  return plan
}

/**
 * Size of the request this step will build: the current surface plus the
 * messages pre-step's decision is about to append. The loop derives its
 * messages before agent/request runs, so pre-step is the last point at which
 * the session may still be edited.
 */
export function requestChars(session: Session, incoming: readonly Message[] = []): number {
  return chars([...session.deriveMessages(), ...incoming])
}

/** Serialized message bound, deliberately distinct from tokenizer/model capacity. */
export function assertRequestBudget(messages: readonly Message[], maxRequestChars: number): void {
  const size = chars(messages)
  if (size > maxRequestChars) throw new SliceBudgetError(`Request messages need ${size} characters, above maxRequestChars=${maxRequestChars}. Current input and protected context were preserved; increase the budget or start a smaller task.`)
}
