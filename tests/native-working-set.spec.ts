/**
 * Working-set retention on the stock DSH loop: native dispatch, the request
 * reconstruction check, recall tools, a code-dispatched edit, JSONL persistence
 * and resume, and loading the configuration key.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { deriveEventMessage, foldSurface, SESSION_FORMAT_VERSION, SessionId, type Session, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import { HISTORY_SOURCE, TAPE_PREFIX } from '../src/context.js'
import type { Config } from '../src/index.js'
import { FixtureCodeRuntime } from './fixture-code-runtime.js'
import { registerFsFixtures } from './fs-fixtures.js'
import { nativeHarness, nativeSend, nativeText, nativeTool, presentPerStep, type CapturedRequest, type NativeHarness } from './native-harness.js'

const live: NativeHarness[] = []
const roots: string[] = []
afterEach(async () => {
  for (const harness of live.splice(0).reverse()) await harness.ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const WORKING_SET: Config = { history: { workingSet: {} } }
const CALC = '/work/calc.py'
const README = '/work/README.md'
const source = (tag: string): string => `${Array.from({ length: 40 }, (_, i) => `def ${tag}_${i}(x):\n    return x + ${i}`).join('\n')}\n`

async function boot(responses: StreamChunk[][], options: { config?: Config; persistenceRoot?: string } = {}) {
  const h = await nativeHarness(responses, { config: options.config ?? WORKING_SET, ...options.persistenceRoot ? { persistenceRoot: options.persistenceRoot } : {} })
  live.push(h)
  const files = new Map([[CALC, source('calc')], [README, '# calc\n\nREADME_SENTINEL: the calculator contract.\n']])
  registerFsFixtures(h.ctx, files)
  return { h, files }
}

async function create(h: NativeHarness, id: string) {
  return (await h.ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'native-mock', model: 'deterministic' } })).agent
}

const textIn = (messages: readonly RequestMessage[]): string => messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
const entriesIn = (messages: readonly RequestMessage[]): string[] => messages.flatMap(message => {
  const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
  return text.startsWith(TAPE_PREFIX) ? [text] : []
})
function firstDivergence(a: readonly RequestMessage[], b: readonly RequestMessage[]): number {
  let i = 0
  while (i < a.length && i < b.length && JSON.stringify(a[i]) === JSON.stringify(b[i])) i += 1
  return i
}
/** A seal lands after every entry the previous request carried. */
function expectStablePrefix(requests: ReadonlyArray<{ messages: readonly RequestMessage[] }>): void {
  for (let i = 1; i < requests.length; i += 1) {
    const earlier = requests[i - 1]!.messages
    const lastEntry = earlier.reduce((last, message, index) => entriesIn([message]).length ? index : last, -1)
    expect(firstDivergence(earlier, requests[i]!.messages)).toBeGreaterThan(lastEntry)
  }
}
function expectReconstructable({ request, events }: CapturedRequest): void {
  const surface = foldSurface(events)
  expect(request.messages).toEqual(surface.nodes.flatMap(seq => { const message = deriveEventMessage(events[seq]!); return message ? [message] : [] }))
}
function expectPaired(messages: readonly RequestMessage[]): void {
  const calls = messages.flatMap(message => message.content.flatMap(block => block.type === 'tool-call' ? [block.id] : [])).sort()
  expect(messages.flatMap(message => message.role === 'tool' ? [message.toolCallId] : []).sort()).toEqual(calls)
}
/** The step (assistant message plus results) that issued `callId`. */
function stepOf(session: Session, callId: string): SessionSeq[] {
  const events = session.snapshotEvents()
  const head = events.find(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'tool-call' && block.id === callId)) as SessionEvent<'assistant/message'>
  const ids = new Set(head.data.message.content.flatMap(block => block.type === 'tool-call' ? [block.id as string] : []))
  return [head.seq, ...events.filter(event => event.type === 'tool/result' && event.surfaceOp === 'append' && ids.has(event.data.message.toolCallId)).map(event => event.seq)]
}
const resultSeq = (session: Session, callId: string): SessionSeq =>
  session.snapshotEvents().find(event => event.type === 'tool/result' && event.surfaceOp === 'append' && event.data.message.toolCallId === callId)!.seq

describe('working-set retention on the native loop', () => {
  it('keeps the working set raw through dispatch, sealing, recall and a durable resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slice-working-set-'))
    roots.push(root)
    const sessionId = SessionId('native-working-set')
    const responses: StreamChunk[][] = [
      nativeTool('t1-read', 'read', { file_path: CALC }),
      nativeTool('t1-readme', 'read', { file_path: README }),
      nativeTool('t1-edit', 'edit', { file_path: CALC, old_string: 'calc_0(x)', new_string: 'calc_zero(x)' }),
      nativeTool('t1-test', 'bash', { command: 'python3 -m unittest -v' }),
      nativeText('TURN_ONE_DONE'),
      nativeTool('t2-edit', 'edit', { file_path: CALC, old_string: 'calc_1(x)', new_string: 'calc_one(x)' }),
      nativeText('TURN_TWO_DONE'),
    ]
    const { h } = await boot(responses, { persistenceRoot: root })
    const agent = await create(h, sessionId)
    await nativeSend(agent, 'implement step one')
    await nativeSend(agent, 'rename calc_1 without reading again')
    expect(h.errors).toEqual([])

    const session = agent.session
    const kept = [...stepOf(session, 't1-read'), ...stepOf(session, 't1-edit')]
    const sealedSteps = [...stepOf(session, 't1-readme'), ...stepOf(session, 't1-test')]
    for (const seq of kept) expect(session.surface.nodes).toContain(seq)
    for (const seq of sealedSteps) expect(session.surface.nodes).not.toContain(seq)
    // The first request of turn 2 carries turn 1's view of calc.py raw, not README.md or the test output.
    const turnTwo = h.adapter.requests[5]!.messages
    expect(textIn(turnTwo)).toContain('1: def calc_0(x):')
    expect(textIn(turnTwo)).not.toContain('README_SENTINEL')
    expect(textIn(turnTwo)).not.toContain('COMMAND_OUTPUT')
    expect(entriesIn(turnTwo).join('\n')).toContain('[slice note · working set: step(s) 1, 3 of this turn kept raw in place for calc.py]')
    expectPaired(turnTwo)

    // Turn 3 recalls both: a kept result and a sealed one resolve through the same tools.
    const keptSeq = resultSeq(session, 't1-read')
    const sealedSeq = resultSeq(session, 't1-readme')
    responses.push(
      nativeTool('t3-kept', 'expand_result', { seq: keptSeq, formatVersion: SESSION_FORMAT_VERSION }),
      nativeTool('t3-sealed', 'expand_result', { seq: sealedSeq, formatVersion: SESSION_FORMAT_VERSION }),
      nativeTool('t3-turn', 'recall_turn', { turn: '1', view: 'full' }),
      nativeText('TURN_THREE_DONE'),
    )
    await nativeSend(agent, 'show me what turn one saw')
    expect(h.errors).toEqual([])
    const resultText = (callId: string) => {
      const event = session.snapshotEvents().find(e => e.type === 'tool/result' && e.surfaceOp === 'append' && e.data.message.toolCallId === callId) as SessionEvent<'tool/result'>
      return event.data.message.content.map(block => block.type === 'text' ? block.text : '').join('')
    }
    expect(resultText('t3-kept')).toContain('def calc_0(x):')
    expect(resultText('t3-sealed')).toContain('README_SENTINEL')
    expect(resultText('t3-turn')).toContain('def calc_0(x):')
    expect(resultText('t3-turn')).toContain('README_SENTINEL')
    // Turn 2 edited without a fresh read: its step extends the raw view from turn 1.
    for (const seq of [...kept, ...stepOf(session, 't2-edit')]) expect(session.surface.nodes).toContain(seq)
    for (const request of h.adapter.requests) expectPaired(request.messages)
    for (const captured of h.captured) expectReconstructable(captured)
    expectStablePrefix(h.adapter.requests)

    const derived = structuredClone(session.deriveMessages())
    const surface = [...session.surface.nodes]
    await h.ctx.fiber.dispose()
    live.splice(live.indexOf(h), 1)

    const second = await boot([nativeText('RESUMED')], { persistenceRoot: root })
    const resumed = await second.h.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'native-mock', model: 'deterministic' } })
    expect(resumed.agent.session.deriveMessages()).toEqual(derived)
    await nativeSend(resumed.agent, 'continue after a restart')
    expect(second.h.errors).toEqual([])
    // The resumed process decides from the same log: every kept node stays raw where it was.
    for (const seq of [...kept, ...stepOf(resumed.agent.session, 't2-edit')]) expect(resumed.agent.session.surface.nodes).toContain(seq)
    expect(resumed.agent.session.surface.nodes.slice(0, surface.indexOf(kept.at(-1)!) + 1)).toEqual(surface.slice(0, surface.indexOf(kept.at(-1)!) + 1))
    expectStablePrefix([{ messages: derived }, ...second.h.adapter.requests])
    for (const captured of second.h.captured) expectReconstructable(captured)
  })

  it('keeps the run_code step whose dispatched edit changed a viewed file', async () => {
    class EditingRuntime extends FixtureCodeRuntime {
      readonly language = 'typescript'
      readonly isolation = 'fixture'
      async run(request: PtcRunSpec): Promise<PtcRunResult> {
        const tools = request.bindings.find(binding => binding.global === 'tools')!.functions
        await tools.edit!({ file_path: CALC, old_string: 'calc_2(x)', new_string: 'calc_two(x)' })
        return { value: 'EDITED_BY_CODE', logs: [] }
      }
    }
    const { h, files } = await boot([
      nativeTool('c1-read', 'read', { file_path: CALC }),
      nativeTool('c1-code', 'run_code', { code: 'edit calc_2', description: 'Rename through code' }),
      nativeTool('c1-test', 'bash', { command: 'python3 -m unittest' }),
      nativeText('CODE_TURN_DONE'),
      nativeText('NEXT_DONE'),
    ])
    await h.ctx.plugin(EditingRuntime)
    const agent = await create(h, 'native-working-set-code')
    presentPerStep(h, agent)
    await nativeSend(agent, 'rename through code')
    await nativeSend(agent, 'next')
    expect(h.errors).toEqual([])
    expect(files.get(CALC)).toContain('calc_two(x)')
    const session = agent.session
    expect(session.snapshotEvents().some(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'edit')).toBe(true)
    for (const seq of [...stepOf(session, 'c1-read'), ...stepOf(session, 'c1-code')]) expect(session.surface.nodes).toContain(seq)
    for (const seq of stepOf(session, 'c1-test')) expect(session.surface.nodes).not.toContain(seq)
    expect(entriesIn(h.adapter.requests.at(-1)!.messages).join('\n')).toContain('step(s) 1, 2 of this turn kept raw in place for calc.py')
    for (const request of h.adapter.requests) expectPaired(request.messages)
    for (const captured of h.captured) expectReconstructable(captured)
    expectStablePrefix(h.adapter.requests)
  })

  it('seals every step as before when the key is omitted', async () => {
    const { h } = await boot([
      nativeTool('off-read', 'read', { file_path: CALC }),
      nativeTool('off-edit', 'edit', { file_path: CALC, old_string: 'calc_0(x)', new_string: 'calc_zero(x)' }),
      nativeText('OFF_DONE'),
      nativeText('NEXT_DONE'),
    ], { config: {} })
    const agent = await create(h, 'native-working-set-off')
    await nativeSend(agent, 'edit')
    await nativeSend(agent, 'next')
    expect(h.errors).toEqual([])
    for (const seq of [...stepOf(agent.session, 'off-read'), ...stepOf(agent.session, 'off-edit')]) expect(agent.session.surface.nodes).not.toContain(seq)
    expect(textIn(h.adapter.requests.at(-1)!.messages)).not.toContain('def calc_0(x):')
    expect(entriesIn(h.adapter.requests.at(-1)!.messages).join('\n')).not.toContain('working set')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === HISTORY_SOURCE)).toHaveLength(1)
  })
})

describe('history.workingSet configuration', () => {
  const load = async (workingSet: unknown) => { live.push(await nativeHarness([], { config: { history: { workingSet } } as never })) }

  it('accepts the documented keys and an empty object for the defaults', async () => {
    await load({})
    await load({ turns: 0, maxChars: 1 })
    await load({ turns: 5, maxChars: 200_000 })
  })

  it.each([true, null, [], 2, 'on'])('rejects a non-object value: %j', async value => {
    await expect(load(value)).rejects.toThrow('history.workingSet must be an object ({} enables the defaults); omit it to seal every step')
  })

  it('names unknown keys and invalid values', async () => {
    await expect(load({ turn: 2 })).rejects.toThrow('Unknown history.workingSet configuration turn; valid keys: turns, maxChars')
    for (const turns of [-1, 1.5, NaN, '2']) await expect(load({ turns })).rejects.toThrow('history.workingSet.turns must be a non-negative safe integer')
    for (const maxChars of [0, -5, 1.5, Infinity, '48000']) await expect(load({ maxChars })).rejects.toThrow('history.workingSet.maxChars must be a positive safe integer')
  })

  it('lists workingSet among the valid history keys', async () => {
    await expect(nativeHarness([], { config: { history: { workingSett: {} } } as never }))
      .rejects.toThrow('Unknown history configuration workingSett; valid keys: keepRecentTurns, entryMaxChars, workingSet')
  })
})
