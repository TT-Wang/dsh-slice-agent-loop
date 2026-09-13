/** Successful read evidence for immutable tape entries. The log is the source,
 * not a claim about the present filesystem or everything the model has seen. */
import { createHash } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'

const READ_TOOLS = new Set(['read', 'read_section', 'read_file'])
const READ_INDEX_LIMIT = 10

interface Call {
  name: string
  arguments: unknown
  turn: number
  step: number
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
}

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
    lines: text === '' ? 0 : text.split('\n').length,
  }
}

function canonical(reads: readonly ReadRef[]): ReadRef[] {
  const latest = new Map<string, ReadRef>()
  for (const read of reads) latest.set(read.key, read)
  return [...latest.values()]
}

/** Errors never enter the successful index or comparison history. A successful
 * retry replaces earlier success for that window; a later error does not. */
export function readHistory(session: Session): ReadHistory {
  const calls = new Map<string, Call>()
  const reads: ReadRef[] = []
  for (const event of session.snapshotEvents()) {
    if (event.type === 'assistant/message' && event.surfaceOp === 'append') {
      for (const block of event.data.message.content) {
        if (block.type === 'tool-call') calls.set(block.id, { name: block.name, arguments: block.arguments, turn: event.data.turn, step: event.data.step })
      }
    } else if (event.type === 'tool/call') {
      calls.set(event.data.callId, { name: event.data.name, arguments: event.data.arguments, turn: event.data.turn, step: event.data.step })
    } else if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      event.data.message.content.forEach((block, index) => {
        const call = calls.get(block.toolCallId)
        if (!call || block.isError) return
        const read = readRef(call, event.seq, block.content ?? [], { block: index + 1 })
        if (read) reads.push(read)
      })
    } else if (event.type === 'tool/code-dispatch' && !event.data.isError) {
      const root = calls.get(event.data.rootCallId)
      if (!root) continue
      const read = readRef({ ...root, name: event.data.name, arguments: event.data.arguments }, event.seq, event.data.content, { rootCallId: event.data.rootCallId })
      if (read) reads.push(read)
    }
  }
  const byTurn = new Map<number, ReadRef[]>()
  for (const read of reads) {
    const list = byTurn.get(read.turn) ?? []
    list.push(read)
    byTurn.set(read.turn, list)
  }
  const prior = new Map<string, ReadRef[]>()
  for (const entries of byTurn.values()) {
    for (const read of canonical(entries)) {
      const list = prior.get(read.key) ?? []
      list.push(read)
      prior.set(read.key, list)
    }
  }
  return { reads, prior }
}

/** A code dispatch is log-only. Associate it with its enclosing outer result,
 * but never imply that returning a value to code exposed those bytes to the model. */
export function readsForResult(history: ReadHistory, event: SessionEvent<'tool/result'>): ReadRef[] {
  const roots = new Set(event.data.message.content.map(block => String(block.toolCallId)))
  return history.reads.filter(read => read.rootCallId === undefined ? read.seq === event.seq
    : roots.has(read.rootCallId) && read.turn === event.data.turn && read.step === event.data.step && read.seq < event.seq)
}

function location(read: ReadRef): string {
  return `step ${read.step}, ${read.block === undefined ? 'dispatch ' : ''}seq ${read.seq}${read.block === undefined ? '' : ` block ${read.block}`}`
}

export function readIndexLine(reads: readonly ReadRef[], turn: number, history: ReadHistory): string {
  const unique = canonical(reads)
  const shown = unique.slice(0, READ_INDEX_LIMIT).map(read => {
    const prior = (history.prior.get(read.key) ?? []).filter(entry => entry.turn < turn).at(-1)
    const change = prior === undefined ? '' : `, ${prior.digest === read.digest ? '=' : '≠'} turn ${prior.turn} ${location(prior)}`
    const channel = read.block === undefined ? `, code log; model visibility not implied; recall_turn({"turn":"${read.turn}","view":"full"})` : ', logged result'
    return `${read.target} (${read.lines} lines, ${read.digest}, ${location(read)}, ${read.tool} window ${read.window}${channel}${change})`
  })
  return `[files read this turn: ${shown.join(', ')}${unique.length > shown.length ? `, +${unique.length - shown.length} more` : ''}]`
}
