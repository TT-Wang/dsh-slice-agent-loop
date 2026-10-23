/**
 * Working-set retention for the session tape (opt-in: `history.workingSet`).
 *
 * When a completed turn seals, the steps that make up the model's current view
 * of each file it is working on stay raw at their own positions instead of
 * entering the entry: the step with the file's latest full view in that turn (a
 * complete `read`, or a `write`, whose arguments are the content) and every later
 * step of the turn that changed the file (`edit`, `write`, a recognised shell
 * write, a code-dispatched write/edit). A turn that changes a file without
 * viewing it again extends the file's raw view from an earlier turn, if that view
 * and every change since are still raw. "Working on" means changed by the model
 * in the sealed turn or in the `turns` turns before it. A file that is only read
 * seals as before; so does an earlier view of a file the same turn viewed again
 * (superseded), and every other step.
 *
 * The unit kept is a whole step, the assistant message that issued the calls
 * plus every result answering them, because a tool call cannot be shown without
 * its results: sibling results of a kept step stay raw too, and count toward the
 * per-turn `maxChars` cap. A step whose other results outweigh its working-set
 * content (beyond SIBLING_ALLOWANCE) is not kept: a small file read beside a
 * large log must not carry the log along. A file's steps are kept all or
 * nothing, files changed in more turns of the window first, then the most
 * recently touched; a file whose steps do not fit, or are not all on the surface
 * with every result, is sealed as today. A later view of a file never retires an
 * earlier kept one: that would rewrite a carried prefix. So nothing bounds the
 * kept text of a whole session but `maxChars` per sealed turn: where every turn
 * has to read the file again before editing it (one process per turn resets the
 * host's edit guard), every coding turn keeps one more view.
 *
 * Cache safety: a kept step is protected exactly like a human message, so it
 * cuts the entry instead of being rewritten. The decision for turn N reads the
 * log as it stood when turn N ended: which reads were full views, and every
 * size, come from the original results or from another producer's in-place view
 * made before the turn ended (the fold condenses a result before the first
 * request that shows it). A replacement made after the turn ended changes
 * nothing: the fold condensing a step-capped turn's last results at the next
 * step, right after this seal kept them, must not undo the decision at the next
 * seal. The surface is consulted only for which steps are still there, and a
 * step a seal kept stays there. So every later seal, and a resumed process,
 * makes the same decision for turn N: kept nodes are never sealed later, sealed
 * nodes are never thawed, and the prefix through the last entry stays frozen as
 * before.
 */
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { isReplacementSurfaceEvent, SessionLogOffset, type Session, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { shellWriteTargets } from './shell-writes.js'

export interface WorkingSetPolicy {
  /** Completed turns before the sealed one whose changes still put a file in the working set. */
  turns: number
  /** Cap on the characters (visible text, reasoning, call arguments, result text) kept raw per sealed turn. */
  maxChars: number
}

/**
 * K = 2 covers the usual pause in work on a file: an edit, then a turn that only
 * tests or reviews it, or one that asks a question, before the next edit. A
 * longer window keeps re-reads of files the model stopped changing. 48,000
 * characters (about 14K tokens at the ~3.4 characters per input token measured
 * on the 2026-10-23 logs, reasoning included) holds a full read of a ~500-line
 * source file plus a turn's edits to it: replaying the 2026-10-23 coding task
 * (lh1, 8 turns), the edited file's steps fit in 7 of 8 turns; the eighth
 * carried 27K characters of reasoning in one edit step.
 */
export const DEFAULT_WORKING_SET: Readonly<WorkingSetPolicy> = { turns: 2, maxChars: 48_000 }

/** What a sealed turn's entry says about the steps it left raw. */
export interface WorkingSetNote {
  /** Step numbers of the kept steps, ascending. */
  steps: number[]
  /** Files whose view the kept steps hold, in the order they were chosen. */
  files: string[]
}

export interface KeptSteps {
  /** Surface nodes left raw: kept assistant messages and their results. */
  seqs: Set<SessionSeq>
  /** Turns with kept steps; only turns still being sealed render their note. */
  notes: Map<number, WorkingSetNote>
}

export interface SurfaceNode { seq: SessionSeq; event: SessionEvent; message: Message | null }

type Op = 'view' | 'write' | 'edit' | 'seen'

interface FileEvent {
  /** The outer call whose step shows this event: the direct call, or the run_code call around a dispatch. */
  key: string
  turn: number
  op: Op
  /** Canonical path of a file tool result. */
  path?: string
  /** Shell write targets as the command spells them, resolved against known paths at decision time. */
  targets?: string[]
}

interface Call { name: string; arguments: unknown; turn: number; step: number; id: string }

interface Cache {
  nextSeq: number
  calls: Map<string, Call>
  roots: Map<string, Call>
  dispatches: Map<string, Call>
  byTurn: Map<number, FileEvent[]>
  /** Turns that ended (turn/end), and the latest turn started: every turn before it is over too. */
  ended: Set<number>
  started: number
  /** Result records (original, or an in-turn replacement of one) to their call key and turn. */
  results: Map<SessionSeq, { key: string; turn: number }>
  /** Per call key: result characters as the turn ended. */
  sizes: Map<string, number>
  /** Per original assistant record: characters it costs to carry. */
  assistants: Map<SessionSeq, number>
  /** Direct full reads by call key, until a replacement within the turn turns them into a mere sighting. */
  views: Map<string, FileEvent>
}

const caches = new WeakMap<Session, Cache>()
const callKey = (turn: number, step: number, id: string): string => JSON.stringify([turn, step, id])

/**
 * Characters of results outside the working set a kept step may carry beyond its own working-set
 * content: a README read beside the source file is fine, a 13K-character log beside a short notes
 * file is not (the 2026-10-23 flood session read one blob and its digest file in parallel each turn).
 */
export const SIBLING_ALLOWANCE = 4_000

const READ_ENVELOPE = /^<path>([^\n]*)<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/
const EDIT_RESULT = /^The file (.+) has been updated(?: successfully)?\./

function argumentsOf(value: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

function textOf(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function normalize(path: string): string {
  const absolute = path.startsWith('/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop()
    else parts.push(part)
  }
  return `${absolute ? '/' : ''}${parts.join('/')}`
}

function argumentPath(args: Record<string, unknown>): string | undefined {
  const value = args.file_path ?? args.path ?? args.filePath
  return typeof value === 'string' && value.trim() ? normalize(value) : undefined
}

/** A DSH `read` result that starts at line 1 and reaches the end of the file uncapped. */
function fullRead(text: string): boolean {
  const body = READ_ENVELOPE.exec(text)?.[2]
  if (body === undefined) return false
  const total = /\(End of file - total (\d+) lines\)$/.exec(body)
  return total !== null && (total[1] === '0' || body.startsWith('1: '))
}

/** One file tool outcome, or undefined when it neither shows nor changes a file. */
function classify(name: string, rawArgs: unknown, text: string, isError: boolean, direct: boolean): Pick<FileEvent, 'op' | 'path' | 'targets'> | undefined {
  const args = argumentsOf(rawArgs)
  if (name === 'bash') {
    // A failed command may still have written before it failed: the step shows what was run.
    const command = typeof args.command === 'string' ? args.command : ''
    const targets = command ? shellWriteTargets(command) : []
    return targets.length ? { op: 'edit', targets } : undefined
  }
  if (isError) return undefined
  if (name === 'read') {
    const path = READ_ENVELOPE.exec(text)?.[1] ?? argumentPath(args)
    // A code-channel read reached the program, not necessarily the model.
    return path === undefined ? undefined : { op: direct && fullRead(text) ? 'view' : 'seen', path }
  }
  if (name === 'write') {
    const path = READ_ENVELOPE.exec(text)?.[1] ?? argumentPath(args)
    return path === undefined ? undefined : { op: direct ? 'write' : 'edit', path }
  }
  if (name === 'edit') {
    const path = EDIT_RESULT.exec(text)?.[1] ?? argumentPath(args)
    return path === undefined ? undefined : { op: 'edit', path }
  }
  return undefined
}

/** File events per turn and sizes as each turn ended, scanned incrementally from the append-only log (like context-reads). */
function fileEvents(session: Session): Cache {
  let cache = caches.get(session)
  if (!cache) {
    cache = { nextSeq: 0, calls: new Map(), roots: new Map(), dispatches: new Map(), byTurn: new Map(), ended: new Set(), started: -Infinity, results: new Map(), sizes: new Map(), assistants: new Map(), views: new Map() }
    caches.set(session, cache)
  }
  if (cache.nextSeq === session.seq) return cache
  const { calls, roots, dispatches, byTurn, ended, results, sizes, assistants, views } = cache
  const record = (call: Call, event: Omit<FileEvent, 'key' | 'turn'>): FileEvent => {
    const list = byTurn.get(call.turn) ?? []
    const file: FileEvent = { key: callKey(call.turn, call.step, call.id), turn: call.turn, ...event }
    list.push(file)
    byTurn.set(call.turn, list)
    return file
  }
  const remember = (call: Call): void => { calls.set(callKey(call.turn, call.step, call.id), call); roots.set(call.id, call) }
  // A turn with no turn/end of its own (a crashed process) is over once a later turn starts.
  const over = (turn: number): boolean => ended.has(turn) || turn < cache.started
  const nextSeq = session.seq
  for (const event of session.snapshotEvents(SessionLogOffset(cache.nextSeq), nextSeq)) {
    if (event.type === 'turn/start') cache.started = Math.max(cache.started, event.data.turn)
    else if (event.type === 'turn/end') ended.add(event.data.turn)
    else if (event.type === 'assistant/message' && event.surfaceOp === 'append') {
      assistants.set(event.seq, keptChars(event.data.message))
      for (const block of event.data.message.content) {
        if (block.type === 'tool-call') remember({ name: block.name, arguments: block.arguments, turn: event.data.turn, step: event.data.step, id: block.id })
      }
    } else if (event.type === 'tool/call') {
      remember({ name: event.data.name, arguments: event.data.arguments, turn: event.data.turn, step: event.data.step, id: event.data.callId })
    } else if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      const message = event.data.message
      const key = callKey(event.data.turn, event.data.step, message.toolCallId)
      results.set(event.seq, { key, turn: event.data.turn })
      sizes.set(key, keptChars(message))
      const call = calls.get(key)
      const outcome = call && classify(call.name, call.arguments, textOf(message.content), message.isError === true, true)
      if (call && outcome) {
        const file = record(call, outcome)
        if (file.op === 'view') views.set(key, file)
      }
    } else if (event.type === 'tool/result' && isReplacementSurfaceEvent(event)) {
      // Another producer's in-place view of a result (the fold, the host's pruner). Made before the turn
      // ended, it is what the turn's requests carried: its size counts, and a read it condensed was never
      // seen whole. Made after, it changes nothing here (see the module comment).
      const origin = (event.sourceEventSeqs ?? []).map(seq => results.get(seq)).find(found => found !== undefined)
      if (origin && !over(origin.turn)) {
        results.set(event.seq, origin)
        sizes.set(origin.key, keptChars(event.data.message))
        const view = views.get(origin.key)
        if (view) { view.op = 'seen'; views.delete(origin.key) }
      }
    } else if (event.type === 'tool/ptc-dispatch-start') {
      const root = roots.get(event.data.rootCallId)
      if (root) dispatches.set(event.data.subCallId, root)
    } else if (event.type === 'tool/ptc-dispatch') {
      const root = dispatches.get(event.data.subCallId) ?? roots.get(event.data.rootCallId)
      dispatches.delete(event.data.subCallId)
      const outcome = root && classify(event.data.name, event.data.arguments, textOf(event.data.content), event.data.isError === true, false)
      if (root && outcome) record(root, outcome)
    }
  }
  cache.nextSeq = nextSeq
  return cache
}

function textChars(text: string): number {
  let count = text.length
  const pairs = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g
  while (pairs.exec(text)) count -= 1
  return count
}

/** What a kept message costs to carry: visible text, reasoning, call arguments and result text. */
function keptChars(message: Message | null): number {
  let count = 0
  for (const block of message?.content ?? []) {
    if (block.type === 'text' || block.type === 'reasoning') count += textChars(block.text)
    else if (block.type === 'tool-call') count += textChars(block.arguments)
  }
  return count
}

interface Step {
  step: number
  members: SessionSeq[]
  chars: number
  intact: boolean
  /** Per call key: argument and result characters, for the sibling rule. */
  calls: Map<string, { args: number; result: number }>
}

/**
 * Surface steps: each assistant message with calls, and the result nodes answering them. A result
 * node may be another producer's in-place view of the result (a fold); it still answers the call.
 * Sizes come from the log as the turn ended, never from the surface node.
 */
function surfaceSteps(nodes: readonly SurfaceNode[], cache: Cache): Map<string, Step> {
  const results = new Map<string, SurfaceNode>()
  for (const node of nodes) {
    const { event } = node
    if (event.type === 'tool/result') results.set(callKey(event.data.turn, event.data.step, event.data.message.toolCallId), node)
  }
  const steps = new Map<string, Step>()
  for (const node of nodes) {
    const { event } = node
    if (event.type !== 'assistant/message') continue
    const calls = (node.message?.content ?? []).flatMap(block => block.type === 'tool-call' ? [block] : [])
    if (!calls.length) continue
    const step: Step = { step: event.data.step, members: [node.seq], chars: cache.assistants.get(node.seq) ?? keptChars(node.message), intact: true, calls: new Map() }
    for (const call of calls) {
      const key = callKey(event.data.turn, event.data.step, call.id)
      const result = results.get(key)
      const size = result ? cache.sizes.get(key) ?? keptChars(result.message) : 0
      if (result) { step.members.push(result.seq); step.chars += size } else step.intact = false
      step.calls.set(key, { args: textChars(call.arguments), result: size })
      steps.set(key, step)
    }
  }
  return steps
}

/** Known canonical paths a shell target can name: equal, or ending in it at a path boundary. */
function resolve(target: string, known: ReadonlySet<string>): string[] {
  const bare = target.replace(/^(?:\$\{?PWD\}?\/)+/, '')
  if (/[$*?[\]{}~`]/.test(bare)) return []
  const path = normalize(bare).replace(/^(?:\.\.\/)+/, '').replace(/^\/+/, '')
  if (!path || path === '..') return []
  return [...known].filter(candidate => candidate === `/${path}` || candidate === path || candidate.endsWith(`/${path}`))
}

/**
 * Decide which surface nodes of turns before `before` (the turns this seal may
 * seal, all completed) stay raw. `nodes` is the current surface in order; only
 * assistant messages and tool results are ever kept.
 */
export function keepWorkingSet(session: Session, nodes: readonly SurfaceNode[], before: number, policy: WorkingSetPolicy): KeptSteps {
  const kept: KeptSteps = { seqs: new Set(), notes: new Map() }
  const cache = fileEvents(session)
  const { byTurn } = cache
  const steps = surfaceSteps(nodes, cache)
  const known = new Set<string>()
  const changedIn = new Map<number, Set<string>>()
  /** The file's latest view and every later change are still raw on the surface. */
  const live = new Map<string, boolean>()
  const order = [...byTurn.keys()].filter(t => t < before).sort((a, b) => a - b)
  for (const turn of order) {
    const events = byTurn.get(turn)!
    for (const event of events) if (event.path !== undefined) known.add(event.path)
    const perFile = new Map<string, FileEvent[]>()
    for (const event of events) {
      for (const file of event.path !== undefined ? [event.path] : event.targets!.flatMap(target => resolve(target, known))) {
        const list = perFile.get(file) ?? []
        if (list.at(-1) !== event) list.push(event)
        perFile.set(file, list)
      }
    }
    const changed = new Set([...perFile].flatMap(([file, list]) => list.some(event => event.op === 'write' || event.op === 'edit') ? [file] : []))
    changedIn.set(turn, changed)
    /** Turns of the window in which the file changed: 0 means it is not in the working set. */
    // The window never reaches before the first turn with file events, however large `turns` is.
    const persistence = (file: string): number => {
      let count = 0
      for (let t = Math.max(turn - policy.turns, order[0]!); t <= turn; t += 1) if (changedIn.get(t)?.has(file)) count += 1
      return count
    }
    // A full view as the turn ended; whether its step is still on the surface is checked with the chain.
    const visible = (event: FileEvent): boolean => event.op === 'write' || event.op === 'view'
    const candidates: Array<{ file: string; chain: FileEvent[]; turns: number; last: number }> = []
    for (const [file, list] of perFile) {
      const turns = persistence(file)
      if (!turns) continue
      let reset = -1
      list.forEach((event, index) => { if (visible(event)) reset = index })
      const changes = (from: number) => list.slice(from).filter(event => event.op === 'edit' || event.op === 'write')
      const chain = reset >= 0 ? [list[reset]!, ...changes(reset + 1)] : live.get(file) === true ? changes(0) : []
      if (chain.length) candidates.push({ file, chain, turns, last: events.indexOf(list.at(-1)!) })
    }
    // A file changed across more of the window is the one being worked on, not a one-off script; then recency.
    candidates.sort((a, b) => b.turns - a.turns || b.last - a.last)
    // Working-set content of a step: its calls that view or change a working-set file, read from the log
    // alone, so a kept step stays lean however later seals change which views are visible.
    const own = new Set([...perFile].flatMap(([file, list]) => persistence(file) ? list.flatMap(event => event.op === 'seen' ? [] : [event.key]) : []))
    const lean = (step: Step): boolean => {
      let inside = 0
      let outside = 0
      for (const [key, size] of step.calls) {
        if (own.has(key)) inside += size.args + size.result
        else outside += size.result
      }
      return outside <= Math.max(inside, SIBLING_ALLOWANCE)
    }
    const chosen = new Set<Step>()
    const files: string[] = []
    let used = 0
    for (const { file, chain } of candidates) {
      const needed = [...new Set(chain.map(event => steps.get(event.key)))]
      if (needed.some(step => step === undefined || !step.intact || !lean(step))) continue
      const extra = (needed as Step[]).filter(step => !chosen.has(step)).reduce((sum, step) => sum + step.chars, 0)
      if (used + extra > policy.maxChars) continue
      for (const step of needed as Step[]) chosen.add(step)
      used += extra
      files.push(file)
    }
    for (const file of perFile.keys()) {
      if (files.includes(file)) live.set(file, true)
      else if (changed.has(file)) live.set(file, false)
    }
    if (!chosen.size) continue
    for (const step of chosen) for (const seq of step.members) kept.seqs.add(seq)
    kept.notes.set(turn, { steps: [...chosen].map(step => step.step).sort((a, b) => a - b), files })
  }
  return kept
}

const NOTE_FILES = 6

/** Entry line for a turn that left steps raw. Labels drop the files' shared directory; locators are not needed, the steps are on the surface. */
export function workingSetNote(note: WorkingSetNote): string {
  const shown = note.files.slice(0, NOTE_FILES)
  const split = shown.map(file => file.split('/'))
  let shared = Math.min(...split.map(parts => parts.length - 1))
  for (let index = 0; index < shared; index += 1) {
    if (split.some(parts => parts[index] !== split[0]![index])) { shared = index; break }
  }
  const labels = split.map(parts => {
    const label = parts.slice(shared).join('/')
    return label.length > 120 ? `…${label.slice(label.length - 119)}` : label
  })
  const more = note.files.length > shown.length ? `, +${note.files.length - shown.length} more` : ''
  return `[slice note · working set: step(s) ${note.steps.join(', ')} of this turn kept raw in place for ${labels.join(', ')}${more}]`
}
