/**
 * Read evidence already present in Harness's durable tool records. This module
 * never resolves a path, reads a file, or guesses an FsTarget/version token.
 */
import { asRecord } from '../state/events.js'
import type { RecordedEvent, RecordedFileObservation } from '../state/events.js'

interface Call {
  name: string
  arguments: unknown
  callId: string
  rootCallId: string
  nested: boolean
}

function operation(call: Call): RecordedFileObservation['operation'] | undefined {
  if (call.name === 'read' || call.name === 'read_file') return 'read'
  if (call.name === 'write' || call.name === 'write_file') return 'write'
  if (call.name === 'edit' || call.name === 'edit_file') return 'edit'
  if (call.name === 'str_replace_editor') {
    const command = asRecord(call.arguments).command
    return command === 'view' ? 'read' : command === 'create' ? 'write'
      : command === 'str_replace' || command === 'insert' ? 'edit' : undefined
  }
  return undefined
}

function windowFrom(value: unknown): Extract<RecordedFileObservation['content'], { kind: 'read-window' }> | undefined {
  const meta = asRecord(value)
  if (!Number.isSafeInteger(meta.offset) || (meta.offset as number) < 1
    || !Number.isSafeInteger(meta.totalLines) || (meta.totalLines as number) < 0 || !Array.isArray(meta.lines)) return undefined
  const lines: Array<{ number: number; text: string }> = []
  for (const raw of meta.lines) {
    const line = asRecord(raw)
    if (line.number !== (meta.offset as number) + lines.length || typeof line.text !== 'string'
      || (line.number as number) > (meta.totalLines as number)) return undefined
    lines.push({ number: line.number as number, text: line.text })
  }
  return { kind: 'read-window', offset: meta.offset as number, totalLines: meta.totalLines as number, lines }
}

function diffsFrom(value: unknown): Extract<RecordedFileObservation['content'], { kind: 'diff-hunks' }> | undefined {
  const raw = asRecord(value).diffs
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const diffs: Array<{ path: string; oldText: string | null; newText: string }> = []
  for (const entry of raw) {
    const diff = asRecord(entry)
    if (typeof diff.path !== 'string' || typeof diff.newText !== 'string'
      || (typeof diff.oldText !== 'string' && diff.oldText !== null)) return undefined
    diffs.push({ path: diff.path, oldText: diff.oldText, newText: diff.newText })
  }
  return { kind: 'diff-hunks', diffs }
}

/** Full-looking windows still omit trailing-newline identity and can truncate individual lines. */
export function observationFromToolResult(
  call: Call, result: { isError?: unknown; meta?: unknown }, turn: number, eventSeq?: number,
): RecordedFileObservation | undefined {
  if (result.isError === true) return undefined
  const kind = operation(call)
  if (kind === undefined) return undefined
  const args = asRecord(call.arguments)
  const meta = asRecord(result.meta)
  const argumentPath = args.file_path ?? args.path
  const path = typeof meta.path === 'string' ? meta.path : argumentPath
  if (typeof path !== 'string' || !path.trim()) return undefined
  return {
    turn,
    address: { kind: typeof meta.path === 'string' ? 'display' : 'argument', path },
    operation: kind,
    content: kind === 'read' ? windowFrom(result.meta) ?? { kind: 'unavailable' }
      : diffsFrom(result.meta) ?? { kind: 'unavailable' },
    provenance: {
      tool: call.name, callId: call.callId, rootCallId: call.rootCallId, nested: call.nested,
      ...(eventSeq === undefined ? {} : { eventSeq }),
    },
  }
}

/** Native calls and nested code dispatches share this deterministic extraction path. */
export function recordedFileObservations(events: Iterable<RecordedEvent>): RecordedFileObservation[] {
  const observations: RecordedFileObservation[] = []
  const calls = new Map<string, Call>()
  let turn: number | undefined
  for (const event of events) {
    const data = asRecord(event.data)
    if (event.type === 'turn/start') {
      turn = typeof data.turn === 'number' ? data.turn : undefined
      calls.clear()
    } else if (event.type === 'turn/end') {
      turn = undefined
      calls.clear()
    } else if (turn !== undefined && event.type === 'tool/call' && data.turn === turn && typeof data.callId === 'string') {
      let args: unknown
      try { args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments } catch { args = undefined }
      calls.set(data.callId, { name: String(data.name), arguments: args, callId: data.callId, rootCallId: data.callId, nested: false })
    } else if (turn !== undefined && event.type === 'tool/result' && event.surfaceOp === 'append' && data.turn === turn) {
      const content = asRecord(data.message).content
      const block = asRecord(Array.isArray(content) ? content[0] : undefined)
      const call = typeof block.toolCallId === 'string' ? calls.get(block.toolCallId) : undefined
      if (call === undefined) continue
      calls.delete(call.callId)
      const fact = observationFromToolResult(call, { isError: block.isError, meta: data.meta }, turn, event.seq)
      if (fact !== undefined) observations.push(fact)
    } else if (turn !== undefined && event.type === 'tool/code-dispatch' && typeof data.subCallId === 'string'
      && typeof data.name === 'string' && typeof data.rootCallId === 'string') {
      // Alpha.2 deliberately omits nested presentation metadata. Keep provenance
      // and success as an unavailable body, rather than parsing rendered text.
      const fact = observationFromToolResult({
        name: data.name, arguments: data.arguments, callId: data.subCallId, rootCallId: data.rootCallId, nested: true,
      }, { isError: data.isError }, turn, event.seq)
      if (fact !== undefined) observations.push(fact)
    }
  }
  return observations
}
