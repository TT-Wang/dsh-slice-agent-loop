/**
 * Append-only session tape on the stock ordered surface.
 *
 * Every completed turn beyond `keepRecentTurns` is sealed into one frozen
 * `[slice tape v1 …]` entry at that turn's own position, at the first step of
 * the next turn (protected nodes can split one turn into multiple entries).
 * An entry is rendered once from logged evidence and NEVER re-rendered or
 * nested. Sealing only touches the unsealed tail after
 * existing entries. It preserves that established message prefix; it does not
 * guarantee provider cache hits or an append-only relationship between every
 * request. The rewritten suffix can include previously shown tool messages and
 * recent turns kept raw by the policy.
 *
 * That is the one property this module exists to protect. The alternative it
 * replaced — leave history raw, then collapse the OLDEST turns under pressure —
 * kept more verbatim tool output but rewrote the prefix at its first replaced
 * message. User nodes stay raw; assistant visible text is complete by default.
 *
 * Superseded runtime-context snapshots are absorbed only while they remain in
 * the unsealed tail. Snapshots ahead of an existing entry keep their position:
 * the host's newest projection already declares earlier snapshots obsolete.
 * Existing entries, including snapshot-only entries from older builds, freeze
 * the whole prefix through their position and are never rewritten here.
 */
import { createUserMessage, type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, deriveEventMessage, type Session, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import { renderTapeReply, type ReplyCaps } from './slice/tape.js'
import { readHistory, readIndexLine, readsForResult, type ReadHistory, type ReadRef } from './context-reads.js'
import { userMessageTurn } from './turn-ownership.js'

export const HISTORY_SOURCE = 'slice:history'
export const CHECKPOINT_PREFIX = '[slice checkpoint v1 · turns '
/** Header of a sealed entry. Sessions written by the pressure-archive build carry CHECKPOINT_PREFIX; both parse. */
export const TAPE_PREFIX = '[slice tape v1 · turns '
/** Stand-in for a superseded runtime snapshot inside the entry that seals its turn. */
export const SNAPSHOT_NOTE_PREFIX = '[slice note · '
/** The host's runtime-context projection (dsh-agent-loop RuntimeContextProjection). */
export const RUNTIME_CONTEXT_SOURCE = '@deepseek-ai/dsh-system-prompt'
/** Enough space for the range header and an intact recall command. */
export const MIN_ENTRY_MAX_CHARS = 256

export interface HistoryPolicy {
  /** Completed turns kept raw at the tail; 0 seals a turn as soon as the next one starts. */
  keepRecentTurns: number
  /** Optional hard character limit for one new sealed entry; at least MIN_ENTRY_MAX_CHARS. */
  entryMaxChars?: number
}

export interface PlannedAppend {
  message: UserMessage
  start: SessionSeq
  end: SessionSeq
  sources: SessionSeq[]
}

export interface ArchivePlan {
  appends: PlannedAppend[]
  /** Lazily measured serialized final view (history + pending messages) after the plan. */
  viewChars: number
  /** Serialized rendered history after the plan. */
  historyChars: number
}

/** Operator-facing notices (the plugin wires this to ctx.logger.warn). */
export type Warn = (message: string) => void

const TOOL_LINES_PER_TURN = 6

function chars(value: unknown): number {
  return textChars(JSON.stringify(value))
}

function textChars(text: string): number {
  let count = text.length
  // Count surrogate pairs without allocating an array of every character;
  // native regexp scanning also keeps large ASCII tool payloads cheap.
  const pairs = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g
  while (pairs.exec(text)) count -= 1
  return count
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
  /** Turn range the node belongs to (a checkpoint spans several turns). */
  turns: [number, number]
  protected: boolean
  /** A superseded runtime snapshot still in the unsealed tail. Render only as a note. */
  superseded: boolean
  /** Turns recall_turn attributes the snapshot(s) to (userMessageTurn), 0 for none. */
  recallTurns: number[]
}

interface Layout { nodes: Node[]; completedThrough: number; lastTurn: number; toolNames: Map<string, string> }

/**
 * Protection per surface node. All user input, instruction and plugin messages,
 * including multimodal content, and the LIVE runtime snapshot keep their positions.
 * The live snapshot is the newest one: the one `pending` is about to append when
 * the host projected a change this step, else the newest on the surface. It is
 * never shadowed — the host's RuntimeContextProjection retains that one seq and
 * would reproject if a replacement named it. Older snapshots may be absorbed
 * only in the still-unsealed tail; those ahead of an existing entry stay raw.
 * A snapshot no recall page serves (one projected before the first turn)
 * stays protected: omitting it would be unrecoverable.
 */
function inspectSurface(session: Session, pending: readonly Message[]): Layout {
  const turnAt = new Map<SessionSeq, number>()
  // Share recall's userMessageTurn attribution for both human input and runtime
  // snapshots: the open turn, else the turn that just ended, else 0.
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
    recallAt.set(event.seq, userMessageTurn(open || null, ended || null) ?? 0)
    if (event.type === 'turn/end') {
      completedThrough = event.seq
      lastTurn = Math.max(lastTurn, event.data.turn)
      ended = event.data.turn
      if (event.data.turn === open) open = 0
    }
  }
  const turnOf = (event: SessionEvent): number =>
    event.type === 'assistant/message' || event.type === 'tool/result' ? event.data.turn
      : event.type === 'user/message' ? recallAt.get(event.seq) ?? 0 : turnAt.get(event.seq) ?? 0
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
  const nodes: Node[] = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)!
    const message = deriveEventMessage(event)
    const turns = rangeOf(event)
    let guarded = seq > completedThrough || turns[0] < 1
    let superseded = false
    let recallTurns = [recallAt.get(seq) ?? 0]
    if (event.type === 'system/message') {
      // DSH v3 persists both the prompt head and in-history prompt updates on
      // the surface. Their system role and placement belong to the host.
      guarded = true
    } else if (runtimeSnapshot(event)) {
      // Not the open-turn guard: a dead snapshot of the open turn is still dead.
      guarded = seq === live || recallTurns[0]! < 1
      superseded = !guarded
    } else if (!ours(event) && event.type === 'user/message') {
      // Keep human requirements in their original role, position and bytes.
      // Foreign replacements and plugin messages retain their existing guards.
      guarded = true
    }
    nodes.push({ seq, event, message, turns, protected: guarded,
      superseded: superseded && !guarded, recallTurns })
  }
  // The surface order, not event seq, defines the paid prefix: replacements are
  // appended to the log but occupy their original positions. A snapshot may
  // become obsolete many turns after entries were sealed behind it. Keep that
  // whole prefix frozen rather than backfilling a replacement into it. The host
  // already declares old snapshots superseded in its latest projection.
  const lastEntry = nodes.reduce((last, node, index) => ours(node.event) ? index : last, -1)
  for (let index = 0; index <= lastEntry; index += 1) {
    nodes[index]!.protected = true
    nodes[index]!.superseded = false
  }
  return { nodes, completedThrough, lastTurn, toolNames }
}

interface Run { nodes: Node[]; message: UserMessage }

interface TurnItem { kind: 'turn'; turn: number; replies: Array<{ seq: SessionSeq; step: number; text: string }>; emptyReplies: number; tools: string[]; reads: ReadRef[]; snapshots: number[] }
interface EarlierItem { kind: 'earlier'; turns: [number, number] }

function excerpt(text: string, head: number, tail: number): string {
  const all = Array.from(text)
  if (all.length <= head + tail) return text
  return `${all.slice(0, head).join('')}…[+${all.length - head - tail} chars, recall_turn]…${all.slice(all.length - tail).join('')}`
}

function collectItems(session: Session, run: readonly Node[], toolNames: Map<string, string>, history: ReadHistory): Array<TurnItem | EarlierItem> {
  const items: Array<TurnItem | EarlierItem> = []
  let current: TurnItem | undefined
  for (const node of run) {
    const { event } = node
    if (ours(event) && !node.superseded) { items.push({ kind: 'earlier', turns: node.turns }); current = undefined; continue }
    const turn = node.turns[0]
    if (!current || current.turn !== turn) { current = { kind: 'turn', turn, replies: [], emptyReplies: 0, tools: [], reads: [], snapshots: [] }; items.push(current) }
    // A superseded snapshot is neither user speech nor current truth: never a request line.
    if (node.superseded) { current.snapshots.push(...node.recallTurns); continue }
    if (event.type === 'assistant/message') {
      const text = node.message ? textOf(node.message) : ''
      if (text.length) current.replies.push({ seq: event.seq, step: event.data.step, text })
      else if (!event.data.message.content.some(block => block.type === 'tool-call')) current.emptyReplies += 1
    } else if (event.type === 'tool/result') {
      // Point at the original append record: it contains the logged text or a
      // spill locator, rather than a later surface digest.
      const origin = event.surfaceOp === 'append' ? event : session.eventAt(event.sourceEventSeqs?.[0] ?? event.seq) ?? event
      const source = origin.type === 'tool/result' ? origin : event
      const blocks = source.data.message.content
      current.reads.push(...readsForResult(history, source))
      const name = blocks.map(block => toolNames.get(block.toolCallId) ?? 'tool').filter((n, i, a) => a.indexOf(n) === i).join(', ')
      const size = blocks.flatMap(block => block.content ?? []).reduce((n, b) => n + (b.type === 'text' ? textChars(b.text) : 0), 0)
      current.tools.push(`[tool turn ${turn} step ${source.data.step} seq ${source.seq} · ${name} · ${size} chars · expand_result({"seq":${source.seq},"formatVersion":${SESSION_FORMAT_VERSION}})]`)
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

interface Shrink { tools: boolean; readChars: number; reply: ReplyCaps | null; compact?: boolean }

/** 条目里的每个 recall 指针都走默认视图(dialogue):`view:"full"` 大两个数量级,按 KERNEL 与工具描述只在
 *  真的要工具输入或原始推理时才取——压到最狠的 compact 档同样如此,那恰好是积压最大、最不该整轮取 full 的时候。 */
function renderItems(items: ReadonlyArray<TurnItem | EarlierItem>, range: [number, number], count: number, shrink: Shrink, history: ReadHistory): string {
  const lines = [shrink.compact
    ? `${TAPE_PREFIX}${range[0]}-${range[1]} · ${count} turn(s) sealed · details: recall_turn({"turn":"${range[0]}"}); repeat for each turn through ${range[1]}]`
    : `${TAPE_PREFIX}${range[0]}-${range[1]} · ${count} turn(s) sealed · recall_turn({"turn":"<n>","view":"dialogue"}) returns a turn's dialogue; expand_result({"seq":<q>,"formatVersion":${SESSION_FORMAT_VERSION}}) returns a tool result]`]
  for (const item of items) {
    if (item.kind === 'earlier') { lines.push(`[earlier checkpoint covered turns ${item.turns[0]}-${item.turns[1]}; recall_turn for details]`); continue }
    lines.push(`[turn ${item.turn}]`)
    if (item.snapshots.length) lines.push(shrink.compact
      ? `[${item.snapshots.length} runtime-context snapshot(s) superseded; recall_turn({"turn":"${item.turn}"})]`
      : snapshotNote(item.snapshots))
    for (const reply of item.replies) lines.push(shrink.compact && shrink.reply
      ? `[reply step ${reply.step} seq ${reply.seq}] ${excerpt(reply.text, shrink.reply.head, shrink.reply.tail)}`
      : renderTapeReply(`slice-turn-${item.turn}-step-${reply.step}-seq-${reply.seq}`, reply.text, shrink.reply).trimEnd())
    if (item.emptyReplies) lines.push(`[${item.emptyReplies} assistant message(s) contained no visible text or tool calls]`)
    if (item.reads.length && shrink.readChars) {
      const index = readIndexLine(item.reads, item.turn, history, shrink.readChars)
      if (index) lines.push(index)
    }
    if (shrink.tools && item.tools.length) {
      lines.push(...item.tools.slice(0, TOOL_LINES_PER_TURN))
      if (item.tools.length > TOOL_LINES_PER_TURN) lines.push(`[+${item.tools.length - TOOL_LINES_PER_TURN} more tool results]`)
    }
  }
  return lines.join('\n')
}

/**
 * Deterministic entry text keeps all assistant visible text by default. Only an
 * explicit cap drops tool lines, then shrinks indexes and replies; a large
 * backlog falls back to a complete range/recall marker. User nodes are never
 * part of the entry. Never cut locators or rewrite an existing sealed entry.
 */
export function renderCheckpoint(session: Session, run: readonly Node[], toolNames: Map<string, string>, maxChars?: number): string {
  checkEntryLimit(maxChars)
  const history = readHistory(session)
  const items = collectItems(session, run, toolNames, history)
  const covered = new Set<number>()
  for (const item of items) {
    if (item.kind === 'turn') covered.add(item.turn)
    else for (let t = item.turns[0]; t <= item.turns[1]; t += 1) covered.add(t)
  }
  const range: [number, number] = [Math.min(...covered), Math.max(...covered)]
  const full: Shrink = { tools: true, readChars: 2_000, reply: null }
  if (maxChars === undefined) return renderItems(items, range, covered.size, full, history)
  const levels: Shrink[] = [full]
  levels.push({ ...levels[0]!, tools: false })
  levels.push({ tools: false, readChars: Math.min(2_000, maxChars), reply: { cap: 2000, head: 1400, tail: 500 } })
  for (let divisor = 2; divisor <= 16; divisor *= 2) {
    levels.push({ tools: false, readChars: Math.floor(2_000 / divisor),
      reply: { cap: Math.floor(2000 / divisor), head: Math.floor(1400 / divisor), tail: Math.floor(500 / divisor) } })
  }
  levels.push({ tools: false, readChars: 128, reply: { cap: 48, head: 32, tail: 16 }, compact: true })
  levels.push({ ...levels.at(-1)!, readChars: 0 })
  let text = ''
  for (const level of levels) {
    text = renderItems(items, range, covered.size, level, history)
    if (textChars(text) <= maxChars) return text
  }
  return `${TAPE_PREFIX}${range[0]}-${range[1]} · ${covered.size} turn(s) sealed]\n[details omitted to fit entry; recall_turn({"turn":"${range[0]}"}); repeat for each turn through ${range[1]}]`
}

function checkEntryLimit(maxChars: number | undefined): void {
  if (maxChars === undefined) return
  if (!Number.isSafeInteger(maxChars) || maxChars < MIN_ENTRY_MAX_CHARS) throw new RangeError(`history.entryMaxChars must be a safe integer >= ${MIN_ENTRY_MAX_CHARS}`)
}

const warnedCuts = new WeakMap<Session, Set<string>>()

/**
 * Decide the whole seal before any append. Returns an empty plan when every
 * completed turn beyond the keep window is already sealed.
 *
 * The seal lands after every existing entry, so the prefix before it is
 * byte-identical to the previous request. There is no request budget and no
 * refusal: entries accumulate with completed turns, and the only hard limit is
 * the model's own context window, which belongs to the host. A budget that
 * refused instead — and poisoned every later turn of the session — arrived with
 * the 2026-09-08 refactor and is gone again.
 */
export function planSeal(session: Session, pending: readonly Message[], policy: HistoryPolicy, warn?: Warn): ArchivePlan {
  checkEntryLimit(policy.entryMaxChars)
  const layout = inspectSurface(session, pending)
  const incoming = [...pending]
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
      if (!node.protected && node.message) historyChars += chars(node.message)
    }
    return { viewChars: chars([...messages, ...incoming]), historyChars }
  }
  /** An entry already on the surface. Frozen: re-rendering one rewrites the prefix it sits in. */
  const sealedEntry = (node: Node): boolean => ours(node.event)
  // Seal completed turns beyond the configured raw tail. Never backfill a seal
  // ahead of an established entry, even when an old protected node becomes eligible.
  const sealBefore = layout.lastTurn - policy.keepRecentTurns + 1

  const cuts = new Map<string, string>()
  const buildRuns = (before: number): Run[] => {
    const runs: Run[] = []
    let current: Node[] = []
    const push = (nodes: Node[]): void => {
      if (!nodes.length) return
      const text = renderCheckpoint(session, nodes, layout.toolNames, policy.entryMaxChars)
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
          const key = JSON.stringify([turn[0]!.seq, [...unpaired].sort()])
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
      if (!node.protected && node.turns[1] < before && !sealedEntry(node)) current.push(node)
      else flush()
    }
    flush()
    return runs
  }
  const plan = buildRuns(sealBefore)
  if (warn && cuts.size) {
    let emitted = warnedCuts.get(session)
    if (!emitted) { emitted = new Set(); warnedCuts.set(session, emitted) }
    for (const [key, message] of cuts) {
      if (emitted.has(key)) continue
      warn(message)
      emitted.add(key)
    }
  }
  const appends = plan.map(run => ({
    message: run.message,
    start: run.nodes[0]!.seq, end: run.nodes[run.nodes.length - 1]!.seq, sources: run.nodes.map(node => node.seq),
  }))
  // Normal sealing needs no request-size scan. Preserve diagnostic fields for
  // callers that ask, measured against this plan's immutable layout exactly once.
  let measure: { viewChars: number; historyChars: number } | undefined
  const measured = () => measure ??= view(plan)
  return { appends, get viewChars() { return measured().viewChars }, get historyChars() { return measured().historyChars } }
}

export function applySeal(session: Session, plan: ArchivePlan): void {
  for (const append of plan.appends) {
    session.append('user/message', append.message, { surfaceOp: { op: 'replace', startSeq: append.start, endSeq: append.end }, sourceEventSeqs: append.sources })
  }
}

/** Plan and apply in one call; the decision is complete before the first append. */
export function sealCompletedTurns(session: Session, pending: readonly Message[], policy: HistoryPolicy, warn?: Warn): ArchivePlan {
  const plan = planSeal(session, pending, policy, warn)
  applySeal(session, plan)
  return plan
}
