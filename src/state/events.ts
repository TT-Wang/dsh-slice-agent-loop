/** Durable log input. No plugin event vocabulary is added to Harness. */
export interface RecordedEvent {
  type: string
  data: unknown
  seq?: number
  surfaceOp?: unknown
}

/** A presented address is a hint, never a backend FsTarget identity. */
export interface RecordedFileAddress {
  kind: 'display' | 'argument'
  path: string
}

/** Partial tool evidence cannot establish exact full-file storage text. */
export interface RecordedFileObservation {
  turn: number
  address: RecordedFileAddress
  operation: 'read' | 'write' | 'edit'
  content:
    | { kind: 'read-window'; offset: number; totalLines: number; lines: Array<{ number: number; text: string }> }
    | { kind: 'diff-hunks'; diffs: Array<{ path: string; oldText: string | null; newText: string }> }
    | { kind: 'unavailable' }
  provenance: {
    tool: string
    callId: string
    rootCallId: string
    nested: boolean
    eventSeq?: number
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}
