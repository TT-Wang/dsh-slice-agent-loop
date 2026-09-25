/** Successful read evidence for immutable tape entries. The log is the source,
 * not a claim about the present filesystem or everything the model has seen. */
import { createHash } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, type Session, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'

const READ_TOOLS = new Set(['read', 'read_section', 'read_file'])
const READ_INDEX_LIMIT = 10

interface Call {
  name: string
  arguments: unknown
  turn: number
  step: number
  seq: SessionSeq
}

export interface ReadRef {
  key: string
  target: string
  window: string
  tool: string
  turn: number
  step: number
  seq: SessionSeq
  /** One-based original result block, absent for log-only code dispatches. */
  block?: number
  rootCallId?: string
  digest: string
  lines: number
}

export interface ReadHistory {
  reads: ReadRef[]
  /** Same representative as the visible index: last successful read per window and turn. */
  prior: Map<string, ReadRef[]>
  /** Original outer result seq → its own blocks and enclosed code reads. */
  results: Map<SessionSeq, ReadRef[]>
}

interface ReadCache extends ReadHistory {
  nextSeq: number
  calls: Map<string, Call>
  roots: Map<string, Call>
  dispatches: Map<string, Call>
  pending: Map<SessionSeq, ReadRef[]>
  priorIndex: Map<string, Map<number, number>>
}

// A Session log is immutable and append-only. Restoring/forking creates another
// Session identity and replays its prefix once. The cache retains read metadata,
// never a second copy of result payloads, and disappears with its Session.
const caches = new WeakMap<Session, ReadCache>()
const callKey = (turn: number, step: number, id: string): string => JSON.stringify([turn, step, id])

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sorted(child)]))
  return value
}

function argumentsOf(value: unknown): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch { return undefined }
}

function readRef(call: Call, seq: SessionSeq, content: readonly ContentBlock[], provenance: { block: number } | { rootCallId: string }): ReadRef | undefined {
  if (!READ_TOOLS.has(call.name)) return undefined
  const args = argumentsOf(call.arguments)
  const target = args?.path ?? args?.file_path ?? args?.filePath
  if (typeof target !== 'string' || !target.trim()) return undefined
  // Keep every non-path selector, including an unknown tool's section/window
  // arguments. Different windows or tool renderers are not change comparisons.
  const selectors = Object.fromEntries(Object.entries(args!).filter(([key]) => !['path', 'file_path', 'filePath'].includes(key)))
  const window = Object.keys(selectors).length ? JSON.stringify(sorted(selectors)) : 'default'
  const channel = 'block' in provenance ? 'result' : 'code log'
  const text = content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  // Image-only success is a read, but it is not a text fingerprint. Keep it out
  // of this text evidence index rather than comparing empty-string hashes.
  if (!content.some(block => block.type === 'text')) return undefined
  return {
    key: JSON.stringify([target, call.name, window, channel]), target, window, tool: call.name,
    turn: call.turn, step: call.step, seq, ...provenance,
    digest: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8),
    lines: text === '' ? 0 : 1 + countNewlines(text),
  }
}

function countNewlines(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) count += 1
  return count
}

function canonical(reads: readonly ReadRef[]): ReadRef[] {
  const latest = new Map<string, ReadRef>()
  for (const read of reads) latest.set(read.key, read)
  return [...latest.values()]
}

/** Errors never enter the successful index or comparison history. A successful
 * retry replaces earlier success for that window; a later error does not. */
export function readHistory(session: Session): ReadHistory {
  let cache = caches.get(session)
  if (!cache) {
    cache = { nextSeq: 0, reads: [], prior: new Map(), results: new Map(), calls: new Map(), roots: new Map(),
      dispatches: new Map(), pending: new Map(), priorIndex: new Map() }
    caches.set(session, cache)
  }
  if (cache.nextSeq === session.seq) return cache
  const { calls, roots, dispatches, pending, reads, prior, priorIndex, results } = cache
  const remember = (read: ReadRef): void => {
    reads.push(read)
    let entries = prior.get(read.key)
    let indices = priorIndex.get(read.key)
    if (!entries || !indices) { entries = []; indices = new Map(); prior.set(read.key, entries); priorIndex.set(read.key, indices) }
    const index = indices.get(read.turn)
    if (index === undefined) { indices.set(read.turn, entries.length); entries.push(read) }
    else entries[index] = read
  }
  const nextSeq = session.seq
  for (const event of session.snapshotEvents(SessionLogOffset(cache.nextSeq), nextSeq)) {
    if (event.type === 'assistant/message' && event.surfaceOp === 'append') {
      for (const block of event.data.message.content) {
        if (block.type !== 'tool-call') continue
        const call = { name: block.name, arguments: block.arguments, turn: event.data.turn, step: event.data.step, seq: event.seq }
        calls.set(callKey(call.turn, call.step, block.id), call)
        roots.set(block.id, call)
      }
    } else if (event.type === 'tool/call') {
      const call = { name: event.data.name, arguments: event.data.arguments, turn: event.data.turn, step: event.data.step, seq: event.seq }
      calls.set(callKey(call.turn, call.step, event.data.callId), call)
      roots.set(event.data.callId, call)
    } else if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      // Session format V4: the event's tool-role message is the one result block.
      const owned: ReadRef[] = []
      const result = event.data.message
      const call = calls.get(callKey(event.data.turn, event.data.step, result.toolCallId))
      if (call) {
        // A failed outer program may still have successful log-only reads.
        owned.push(...(pending.get(call.seq) ?? []))
        pending.delete(call.seq)
        if (!result.isError) {
          const read = readRef(call, event.seq, result.content, { block: 1 })
          if (read) { remember(read); owned.push(read) }
        }
      }
      if (owned.length) results.set(event.seq, owned)
    } else if (event.type === 'tool/ptc-dispatch-start') {
      const root = roots.get(event.data.rootCallId)
      if (root) dispatches.set(event.data.subCallId, root)
    } else if (event.type === 'tool/ptc-dispatch' && !event.data.isError) {
      // Modern logs bind a dispatch at start. Older logs without start records
      // still have the native enclosure guarantee: it settles before its root.
      const root = dispatches.get(event.data.subCallId) ?? roots.get(event.data.rootCallId)
      dispatches.delete(event.data.subCallId)
      if (!root) continue
      const read = readRef({ ...root, name: event.data.name, arguments: event.data.arguments }, event.seq, event.data.content, { rootCallId: event.data.rootCallId })
      if (read) {
        remember(read)
        const list = pending.get(root.seq) ?? []
        list.push(read)
        pending.set(root.seq, list)
      }
    } else if (event.type === 'tool/ptc-dispatch') {
      dispatches.delete(event.data.subCallId)
    }
  }
  cache.nextSeq = nextSeq
  return cache
}

/** A code dispatch is log-only. Associate it with its enclosing outer result,
 * but never imply that returning a value to code exposed those bytes to the model. */
export function readsForResult(history: ReadHistory, event: SessionEvent<'tool/result'>): ReadRef[] {
  return history.results.get(event.seq) ?? []
}

function location(read: ReadRef): string {
  return `step ${read.step}, ${read.block === undefined ? 'dispatch ' : ''}seq ${read.seq}${read.block === undefined ? '' : ` block ${read.block}`}`
}

/** Bound display labels only: exact path/selectors remain on the recall page.
 * Locator commands are never truncated; dropping a whole index line is safe. */
function label(text: string, limit: number): string {
  const escaped = /[\r\n\t]/.test(text) ? JSON.stringify(text) : text
  if (escaped.length <= limit) return escaped
  let head = ''
  let count = 0
  for (const point of escaped) {
    if (count < limit - 24) head += point
    count += 1
    if (count > limit) return `${head}…[label shortened]`
  }
  return escaped
}

export function readIndexLine(reads: readonly ReadRef[], turn: number, history: ReadHistory, maxChars = 2_000): string {
  const unique = canonical(reads)
  const shown: string[] = []
  const line = (): string => `[files read this turn: ${shown.join(', ')}${unique.length > shown.length ? `${shown.length ? ', ' : ''}+${unique.length - shown.length} more; recall_turn({"turn":"${turn}","view":"full"})` : ''}]`
  for (const read of unique.slice(0, READ_INDEX_LIMIT)) {
    const prior = (history.prior.get(read.key) ?? []).filter(entry => entry.turn < turn).at(-1)
    const change = prior === undefined ? '' : `, ${prior.digest === read.digest ? '=' : '≠'} turn ${prior.turn} ${location(prior)}`
    const channel = read.block === undefined ? `, code log; model visibility not implied; recall_turn({"turn":"${read.turn}","view":"full"})` : ', logged result'
    shown.push(`${label(read.target, 180)} (${read.lines} lines, ${read.digest}, ${location(read)}, ${read.tool} window ${label(read.window, 140)}${channel}${change})`)
    if ([...line()].length > maxChars) { shown.pop(); break }
  }
  const rendered = line()
  return [...rendered].length <= maxChars ? rendered : ''
}
