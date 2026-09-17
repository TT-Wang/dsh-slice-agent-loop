import { describe, expect, it } from 'vitest'
import { buildContinuity, reduceContinuityEvents } from '../src/lab/state-reducer.js'
import { recordedFileObservations } from '../src/lab/observations-files.js'
import { fileObservationsByPath } from '../src/lab/state-selectors.js'
import type { RecordedEvent } from '../src/lab/state-events.js'

const user = (text: string): RecordedEvent => ({
  type: 'user/message', surfaceOp: 'append',
  data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const assistant = (turn: number, text: string): RecordedEvent => ({
  type: 'assistant/message', surfaceOp: 'append',
  data: { turn, step: 1, message: { content: [{ type: 'text', text }] } },
})
const start = (turn: number): RecordedEvent => ({ type: 'turn/start', data: { turn } })
const end = (turn: number): RecordedEvent => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
const call = (turn: number, callId: string, name: string, args: unknown): RecordedEvent => ({
  type: 'tool/call', data: { turn, step: 1, callId, name, arguments: JSON.stringify(args) },
})
const result = (turn: number, callId: string, meta?: unknown, isError = false, text = 'ok'): RecordedEvent => ({
  type: 'tool/result', surfaceOp: 'append',
  data: { turn, step: 1, message: { content: [{ type: 'tool-result', toolCallId: callId, isError, content: [{ type: 'text', text }] }] }, ...(meta === undefined ? {} : { meta }) },
})
const readMeta = (path = 'remote://workspace/a.ts') => ({ path, offset: 1, totalLines: 1, lines: [{ number: 1, text: 'remote text' }] })
const read = (turn: number, callId: string, path = 'remote://workspace/a.ts'): RecordedEvent[] => [
  call(turn, callId, 'read', { file_path: path }), result(turn, callId, readMeta(path)),
]
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown

describe('recorded memory replay', () => {
  it('counts repeated reads once per turn before and after persistence reload', () => {
    const events = [
      start(1), user('Inspect'), ...read(1, 'a'), ...read(1, 'b'), assistant(1, 'Inspected'), end(1),
      start(2), user('Inspect again'), ...read(2, 'c'), assistant(2, 'Rechecked'), end(2),
    ]
    const live = reduceContinuityEvents(events, 'session', { readBasesMinReads: 2 })
    const resumed = reduceContinuityEvents(JSON.parse(JSON.stringify(events)), 'session', { readBasesMinReads: 2 })
    expect(live.readCount['remote://workspace/a.ts']).toBe(2)
    expect(live.touchCount['remote://workspace/a.ts']).toBe(2)
    expect(plain(resumed)).toEqual(plain(live))
    expect(live.tapeFiles).toEqual({})
    expect(live.sessionTape.filter(entry => entry.kind === 'base')).toEqual([])
  })

  it('uses the same snapshot reducer through buildContinuity', () => {
    const events = [start(1), user('hello'), assistant(1, 'world'), end(1)]
    const session = { id: 'session', snapshotEvents: () => events } as unknown as Parameters<typeof buildContinuity>[0]
    expect(plain(buildContinuity(session))).toEqual(plain(reduceContinuityEvents(events, 'session')))
  })

  it('never substitutes a host file for remote evidence with the same display path', () => {
    const events = [start(1), user('Inspect remote hosts'), ...read(1, 'a', '/etc/hosts'), end(1)]
    const files = fileObservationsByPath(events)
    expect(files.get('/etc/hosts')?.content).toEqual({ kind: 'read-window',
      offset: 1, totalLines: 1, lines: [{ number: 1, text: 'remote text' }],
    })
    expect(reduceContinuityEvents(events, 'session').tapeFiles).toEqual({})
    expect(files.get('/etc/hosts')).not.toHaveProperty('targetKey')
    expect(files.get('/etc/hosts')).not.toHaveProperty('version')
  })

  it('keeps full-looking and truncated read windows partial, including empty files', () => {
    const events = [start(1), user('Inspect'),
      call(1, 'a', 'read', { file_path: 'a' }), result(1, 'a', readMeta('a')),
      call(1, 'b', 'read', { file_path: 'b' }), result(1, 'b', { path: 'b', offset: 1, totalLines: 1, lines: [{ number: 1, text: 'abc... (line truncated to 3 chars)' }] }),
      call(1, 'c', 'read', { file_path: 'c' }), result(1, 'c', { path: 'c', offset: 1, totalLines: 0, lines: [] }),
      end(1)]
    expect(recordedFileObservations(events).map(fact => fact.content.kind)).toEqual(['read-window', 'read-window', 'read-window'])
    expect(reduceContinuityEvents(events, 'session').tapeFiles).toEqual({})
  })

  it('never mistakes contextual diff hunks or write arguments for complete provider text', () => {
    const diffs = [{ path: 'a.ts', oldText: 'old\ncontext', newText: 'new\ncontext' }]
    const events = [start(1), user('Edit'),
      call(1, 'a', 'edit', { file_path: 'a.ts', old_string: 'old', new_string: 'new' }), result(1, 'a', { diffs }),
      call(1, 'b', 'write', { file_path: 'a.ts', content: 'proposed text' }), result(1, 'b'),
      end(1)]
    expect(recordedFileObservations(events).map(fact => fact.content)).toEqual([{ kind: 'diff-hunks', diffs }, { kind: 'unavailable' }])
    const c = reduceContinuityEvents(events, 'session', { newFileMinTouches: 2 })
    expect(c.touchCount['a.ts']).toBe(1)
    expect(c.tapeFiles).toEqual({})
  })

  it('records native and nested code outcomes without inventing nested metadata', () => {
    const nested: RecordedEvent = {
      type: 'tool/ptc-dispatch', seq: 8,
      data: { rootCallId: 'outer', parentCallId: 'outer', subCallId: 'outer:code:1', name: 'read', arguments: { file_path: 'remote://workspace/a.ts' }, isError: false, content: [{ type: 'text', text: 'rendered remote text' }] },
    }
    const events = [start(1), user('Read twice'), ...read(1, 'native'), nested, end(1)]
    const observations = recordedFileObservations(events)
    expect(observations[1]?.provenance).toEqual({ tool: 'read', callId: 'outer:code:1', rootCallId: 'outer', nested: true, eventSeq: 8 })
    expect(observations[1]?.content).toEqual({ kind: 'unavailable' })
    expect(reduceContinuityEvents(events, 'session').readCount['remote://workspace/a.ts']).toBe(1)
  })

  it('does not count failed reads or fabricated results without a recorded call', () => {
    const events = [start(1), user('Read'),
      call(1, 'failed', 'read', { file_path: 'a' }), result(1, 'failed', readMeta('a'), true),
      result(1, 'unpaired', readMeta('b')), end(1)]
    expect(recordedFileObservations(events)).toEqual([])
    expect(Object.keys(reduceContinuityEvents(events, 'session').readCount)).toEqual([])
  })

  it('does not ingest generated replacement nodes as new human turns or outcomes', () => {
    const events = [start(1), user('Original ask'), assistant(1, 'Original reply'),
      call(1, 'a', 'read', { file_path: 'a' }), result(1, 'a', undefined, true, 'missing'), end(1),
      { ...user('Generated tape'), surfaceOp: { op: 'replace', startSeq: 0, endSeq: 3 } },
      start(2), user('Follow up'), { ...result(2, 'synthetic'), surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } },
    ]
    const c = reduceContinuityEvents(events, 'session')
    expect(c.turns).toBe(2)
    expect(c.goal).toBe('Original ask')
    expect(c.lastError).toBe('missing')
    expect(c.conversation.map(row => row.user)).toEqual(['Original ask', 'Follow up'])
  })

  it('keeps runtime and plugin contexts out of the human conversation ring', () => {
    const runtime = user('runtime secrets')
    runtime.data = { ...(runtime.data as object), source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'state' } }
    const c = reduceContinuityEvents([start(1), runtime, user('human task'), user('steering'), assistant(1, 'done'), end(1)], 'session')
    expect(c.goal).toBe('human task')
    expect(c.conversation).toEqual([{ user: 'human task\nsteering', assistant: 'done', turn: 1 }])
  })

  it('replays the final error and successful check into the same sealed digest', () => {
    const events = [start(1), user('Run tests'),
      call(1, 'a', 'read', { file_path: 'missing' }), result(1, 'a', undefined, true, 'not found'),
      call(1, 'b', 'bash', { command: 'npm test' }), result(1, 'b', undefined, false, '12 passed'),
      assistant(1, 'tests pass'), end(1)]
    const c = reduceContinuityEvents(events, 'session', { checkInDigest: true })
    expect(c.lastError).toBe('')
    expect(c.sessionTape[0]?.rendered).toContain('check: npm test → 12 passed')
  })

  it('rejects malformed read metadata without dropping the successful read hint', () => {
    const events = [start(1), user('Read'), call(1, 'a', 'read', { file_path: '__proto__' }),
      result(1, 'a', { path: '__proto__', offset: 1, totalLines: 1, lines: [{ number: 0, text: 'bad numbering' }] }), end(1)]
    expect(recordedFileObservations(events)[0]?.content).toEqual({ kind: 'unavailable' })
    expect(reduceContinuityEvents(events, 'session').readCount.__proto__).toBe(1)
  })

  it('does not attribute observations between turns to a completed turn', () => {
    const events = [start(1), user('Done'), end(1), ...read(1, 'orphan')]
    expect(recordedFileObservations(events)).toEqual([])
  })
})
