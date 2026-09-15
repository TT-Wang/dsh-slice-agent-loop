import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { MIN_ENTRY_MAX_CHARS, planSeal, sealCompletedTurns, type HistoryPolicy } from '../src/context.js'
import { readHistory, readsForResult } from '../src/context-reads.js'
import { renderSealedTurn } from '../src/recall.js'

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, createHash: vi.fn(actual.createHash) }
})
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

const policy: HistoryPolicy = { keepRecentTurns: 0, pinFirstTurn: false, pinUserChars: 1_200, entryMaxChars: 2_000 }
function start(session: Session, turn: number, question = `QUESTION_${turn}`) {
  session.append('turn/start', { turn })
  return session.append('user/message', createUserMessage({ content: [{ type: 'text', text: question }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}
function assistant(session: Session, turn: number, step: number, content: ContentBlock[]) {
  return session.append('assistant/message', { turn, step, stream: [], message: createMessage({ role: 'assistant', content, source: { kind: 'model', provider: 'mock', model: 'mock' } }) }, { surfaceOp: 'append' })
}
function call(session: Session, turn: number, step: number, id: string, name: string, args: object) {
  const callId = ToolCallId(id)
  const arguments_ = JSON.stringify(args)
  assistant(session, turn, step, [{ type: 'tool-call', id: callId, name, arguments: arguments_ }])
  return session.append('tool/call', { turn, step, callId, name, arguments: arguments_ })
}
function result(session: Session, turn: number, step: number, id: string, text: string, isError = false) {
  return session.append('tool/result', { turn, step, message: createToolResultMessage({ callId: ToolCallId(id), isError, content: [{ type: 'text', text }] }) }, { surfaceOp: 'append' })
}
function read(session: Session, turn: number, step: number, path: string, text: string, window = '') {
  const id = `read-${step}` // Deliberately reused across turns.
  call(session, turn, step, id, 'read', { file_path: path, section: window })
  return result(session, turn, step, id, text)
}
function end(session: Session, turn: number, content: ContentBlock[] = [{ type: 'text', text: `ANSWER_${turn}` }]) {
  assistant(session, turn, 999, content)
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}
const entryText = (plan: ReturnType<typeof planSeal>) => plan.appends.map(append => append.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))

describe('bounded tape entries and incremental read evidence', () => {
  it('bounds a 13-turn backlog of long paths and selectors without truncating recall commands', () => {
    const session = Session.create(SessionId('bounded-read-backlog'))
    const originals: SessionEvent<'tool/result'>[] = []
    for (let turn = 1; turn <= 13; turn += 1) {
      start(session, turn)
      for (let step = 1; step <= 10; step += 1) originals.push(read(session, turn, step,
        `src/${'long-path-'.repeat(55)}${step}.ts`, `BODY_${turn}_${step}`, `section-${'selector'.repeat(100)}-${turn}`))
      end(session, turn)
    }
    const plan = sealCompletedTurns(session, [], policy)
    expect(plan.appends).toHaveLength(1)
    const [text] = entryText(plan)
    expect([...text!].length).toBeLessThanOrEqual(policy.entryMaxChars)
    expect(text).toContain('turns 1-13 · 13 turn(s) sealed')
    const commands = [...text!.matchAll(/recall_turn\((\{[^\n]*?\})\)/g)].map(match => JSON.parse(match[1]!))
    expect(commands).toContainEqual({ turn: '1', view: 'full' })
    expect(renderSealedTurn(session.snapshotEvents(), Number(commands[0].turn), { view: 'full' })?.rendered).toContain('BODY_1_1')
    for (const original of originals) expect(session.eventAt(original.seq)).toEqual(original)

    // Later seals may use a different cap; the previous entry stays byte-identical.
    const frozen = plan.appends[0]!.message
    const frozenSeq = session.surface.nodes[0]!
    start(session, 14)
    read(session, 14, 1, `src/${'path'.repeat(500)}.ts`, 'LATER')
    end(session, 14)
    const next = sealCompletedTurns(session, [], { ...policy, entryMaxChars: MIN_ENTRY_MAX_CHARS })
    expect(entryText(next).every(entry => [...entry].length <= MIN_ENTRY_MAX_CHARS)).toBe(true)
    const prior = session.eventAt(frozenSeq)
    expect(prior?.type).toBe('user/message')
    if (prior?.type === 'user/message') expect(prior.data).toEqual(frozen)
    expect(session.surface.nodes[0]).toBe(frozenSeq)
  })

  it('uses an intact range marker when even tiny per-turn traces cannot fit', () => {
    const session = Session.create(SessionId('bounded-minimum-entry'))
    for (let turn = 1; turn <= 80; turn += 1) { start(session, turn); end(session, turn) }
    const plan = sealCompletedTurns(session, [], { ...policy, entryMaxChars: MIN_ENTRY_MAX_CHARS })
    const [text] = entryText(plan)
    expect([...text!].length).toBeLessThanOrEqual(MIN_ENTRY_MAX_CHARS)
    expect(text).toContain('turns 1-80 · 80 turn(s) sealed')
    expect(text).toContain('recall_turn({"turn":"1","view":"full"}); repeat for each turn through 80')
    expect(renderSealedTurn(session.snapshotEvents(), 80)?.rendered).toContain('ANSWER_80')
    expect(() => planSeal(session, [], { ...policy, entryMaxChars: MIN_ENTRY_MAX_CHARS - 1 })).toThrow('>= 256')
  })

  it('hashes each of 400 logged read payloads once across repeated sealing reads', () => {
    const session = Session.create(SessionId('incremental-reads-400'))
    const payload = `${'payload'.repeat(9_000)}\nlast line`
    const snapshots = vi.spyOn(session, 'snapshotEvents')
    vi.mocked(createHash).mockClear()
    let previousSeq = 0
    for (let turn = 1; turn <= 400; turn += 1) {
      start(session, turn)
      read(session, turn, 1, 'same.ts', payload)
      end(session, turn)
      const history = readHistory(session)
      expect(history.reads).toHaveLength(turn)
      expect(vi.mocked(createHash)).toHaveBeenCalledTimes(turn)
      expect(snapshots.mock.calls.at(-1)?.[0]).toBe(previousSeq)
      previousSeq = session.seq
      readHistory(session)
      expect(snapshots).toHaveBeenCalledTimes(turn)
      expect(vi.mocked(createHash)).toHaveBeenCalledTimes(turn)
    }
    expect(readHistory(session).prior.values().next().value).toHaveLength(400)
  })

  it('replays a restored session once and isolates reused call ids and pending code reads', () => {
    const session = Session.create(SessionId('incremental-read-owners'))
    const dispatch = (turn: number, body: string, outerError = false) => {
      start(session, turn)
      call(session, turn, 1, 'same-root', 'run_code', { code: 'fixture' })
      const data = { rootCallId: ToolCallId('same-root'), parentCallId: ToolCallId('same-root'), subCallId: ToolCallId('same-child'), name: 'read', arguments: { file_path: `${turn}.ts` } }
      session.append('tool/ptc-dispatch-start', data)
      session.append('tool/ptc-dispatch', { ...data, isError: false, content: [{ type: 'text', text: body }] })
      readHistory(session) // Cache while the outer call has not settled.
      const outer = result(session, turn, 1, 'same-root', `processed ${turn}`, outerError)
      end(session, turn)
      return outer
    }
    const first = dispatch(1, 'FIRST')
    const second = dispatch(2, 'SECOND', true) // A later program failure cannot erase a successful inner read.
    const original = readHistory(session)
    expect(readsForResult(original, first).map(read => read.target)).toEqual(['1.ts'])
    expect(readsForResult(original, second).map(read => read.target)).toEqual(['2.ts'])
    const restored = Session.create(SessionId('restored-read-owners'), session.snapshotEvents())
    vi.mocked(createHash).mockClear()
    const reloaded = readHistory(restored)
    expect(vi.mocked(createHash)).toHaveBeenCalledTimes(2)
    expect(reloaded.reads).toEqual(original.reads)
    expect(reloaded.prior).toEqual(original.prior)
    expect(reloaded.results).toEqual(original.results)
    readHistory(restored)
    expect(vi.mocked(createHash)).toHaveBeenCalledTimes(2)

    start(restored, 3)
    // An orphan result reusing a previous call id cannot inherit its read path.
    const orphan = result(restored, 3, 1, 'same-root', 'NOT_A_READ')
    expect(readsForResult(readHistory(restored), orphan)).toEqual([])
    expect(vi.mocked(createHash)).toHaveBeenCalledTimes(2)
    read(restored, 3, 2, '3.ts', 'THIRD')
    expect(readHistory(restored).reads).toHaveLength(3)
    expect(readHistory(session).reads).toHaveLength(2)
  })

  it('keeps explicit empty-message traces without calling a pinned user message empty', () => {
    const session = Session.create(SessionId('empty-tape-evidence'))
    start(session, 1, 'PINNED_QUESTION')
    end(session, 1)
    start(session, 2, '  \n\t ')
    end(session, 2, [])
    start(session, 3, '')
    end(session, 3, [{ type: 'text', text: ' \n ' }])
    const [text] = entryText(sealCompletedTurns(session, [], { ...policy, pinFirstTurn: true }))
    expect(text?.split('[turn 2]')[0]).not.toContain('[user message contained no visible text]')
    expect(text?.match(/\[user message contained no visible text\]/g)).toHaveLength(2)
    expect(text?.match(/\[1 assistant message\(s\) contained no visible text or tool calls\]/g)).toHaveLength(2)
    expect(text).toContain('3 turn(s) sealed')
  })

  it('emits each unpaired-cut warning once and retains the unmatched native blocks', () => {
    const session = Session.create(SessionId('warn-unpaired-once'))
    start(session, 1)
    const unpaired = call(session, 1, 1, 'unclosed', 'read', { file_path: 'unfinished.ts' })
    end(session, 1)
    const warn = vi.fn()
    planSeal(session, [], policy) // No logger: a later observed plan still warns.
    for (let repeat = 0; repeat < 4; repeat += 1) expect(sealCompletedTurns(session, [], policy, warn).appends).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(session.eventAt(unpaired.seq)).toEqual(unpaired)
    expect(JSON.stringify(session.deriveMessages())).toContain('unclosed')
  })

  it('does not serialize the request for unused size diagnostics', () => {
    const session = Session.create(SessionId('lazy-size-diagnostic'))
    start(session, 1, '🙂'.repeat(50_000))
    const stringify = vi.spyOn(JSON, 'stringify')
    const plan = planSeal(session, [], policy)
    expect(plan.appends).toEqual([])
    expect(stringify).not.toHaveBeenCalled()
    const measured = plan.viewChars
    expect(stringify).toHaveBeenCalledTimes(1)
    expect(plan.historyChars).toBe(0)
    expect(stringify).toHaveBeenCalledTimes(1)
    stringify.mockRestore()
    expect(measured).toBe([...JSON.stringify(session.deriveMessages())].length)
  })
})
