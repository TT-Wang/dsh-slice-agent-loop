/**
 * Session format V4 tool results through every recall surface, on the stock loop:
 * each result is its own tool-role message (`message.toolCallId`, direct content,
 * optional `isError`), parallel siblings are separate events, and a PTC program's
 * nested calls are log-only `tool/ptc-dispatch` records behind one outer result.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { SESSION_FORMAT_VERSION, SessionId, isAppendSurfaceEvent, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { expandResultToolDefinition } from '../src/fold/index.js'
import { recallStepToolDefinition, renderSealedStepPage } from '../src/recall-step.js'
import { renderSealedTurn, searchSessionEvents } from '../src/recall.js'
import { FixtureCodeRuntime } from './fixture-code-runtime.js'
import { nativeHarness, nativeSend, nativeText, nativeTool, type NativeHarness } from './native-harness.js'

const CONFIG = `PORT_SENTINEL=7443\n${'filler line of configuration text\n'.repeat(60)}`
const NESTED = 'NESTED_ONLY_SENTINEL from the program'
const V = SESSION_FORMAT_VERSION

/** Two tool calls in one assistant step: the host executes both and logs one result event each. */
function parallel(...calls: Array<[id: string, name: string, args?: object]>): StreamChunk[] {
  return [
    ...calls.flatMap(([id, name, args = {}], index): StreamChunk[] => [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) } },
    ]),
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Calls the registered tool through its PTC binding, as a model-written program would. */
class NestedRuntime extends FixtureCodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  async run(request: PtcRunSpec): Promise<PtcRunResult> {
    const tools = request.bindings.find(binding => binding.global === 'tools')!.functions
    const nested = await tools.echo_nested!({})
    return { value: `program saw: ${JSON.stringify(nested)}`, logs: [] }
  }
}

const live: NativeHarness[] = []
afterEach(async () => {
  for (const h of live.splice(0).reverse()) await h.ctx.fiber.dispose()
})

/** Turn 1: read_config ‖ boom (error) in step 1, then run_code with one nested call in step 2. Turn 2 closes turn 1. */
async function session(id: string) {
  const h = await nativeHarness([
    parallel(['read-1', 'read_config', { path: 'app.toml' }], ['boom-1', 'boom']),
    nativeTool('code-1', 'run_code', { code: 'nested', description: 'Run a nested call' }),
    nativeText('ASSISTANT_ONE_SENTINEL done'),
    nativeText('closing'),
  ])
  live.push(h)
  await h.ctx.plugin(NestedRuntime)
  h.ctx.tools.register(defineContentToolFixture({
    name: 'read_config', description: 'Read config', parameters: { path: { type: 'string', required: true } },
    execute: async () => [{ type: 'text', text: CONFIG }],
  }))
  h.ctx.tools.register(defineContentToolFixture({
    name: 'boom', description: 'Fail', parameters: {},
    execute: async () => { throw new Error('BOOM_ERROR_SENTINEL: disk on fire') },
  }))
  h.ctx.tools.register(defineContentToolFixture({
    name: 'echo_nested', description: 'Nested evidence', parameters: {},
    execute: async () => [{ type: 'text', text: NESTED }],
  }))
  const { agent } = await h.ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'native-mock', model: 'deterministic' } })
  agent.ctx.tools.presentAs('both')
  await nativeSend(agent, 'USER_ONE_SENTINEL read, fail and run code')
  await nativeSend(agent, 'wrap up')
  expect(h.errors).toEqual([])
  const events = agent.session.snapshotEvents() as readonly SessionEvent[]
  const result = (callId: string) => {
    const event = events.find(e => e.type === 'tool/result' && isAppendSurfaceEvent(e) && e.data.message.toolCallId === callId)
    if (event?.type !== 'tool/result') throw new Error(`missing tool result ${callId}`)
    return event
  }
  const execution = { agent: { session: { snapshotEvents: () => events } } } as unknown as ToolRunContext
  return { events, result, execution }
}

describe('V4 tool-role results through recall', () => {
  it('logs each parallel sibling, the error and the PTC outer result as its own tool-role event', async () => {
    const { events, result } = await session('v4-shape')
    const read = result('read-1')
    const boom = result('boom-1')
    const code = result('code-1')
    expect(read.data.message).toMatchObject({ role: 'tool', toolCallId: 'read-1', source: { kind: 'tool', callId: 'read-1' } })
    expect(boom.data.message).toMatchObject({ role: 'tool', toolCallId: 'boom-1', isError: true })
    expect([read.data.step, boom.data.step, code.data.step]).toEqual([1, 1, 2])
    expect(boom.seq).toBeGreaterThan(read.seq)
    const dispatch = events.find(e => e.type === 'tool/ptc-dispatch')
    expect(dispatch).toMatchObject({ type: 'tool/ptc-dispatch', data: { name: 'echo_nested', rootCallId: 'code-1' } })
    expect(JSON.stringify(events)).not.toContain('"tool-result"')
  })

  it('recall_turn dialogue names every result, errors and the PTC outer result included, by its own V4 seq', async () => {
    const { events, result } = await session('v4-dialogue')
    const page = renderSealedTurn(events, 1, { view: 'dialogue' })!.rendered
    for (const [callId, name, chars] of [['read-1', 'read_config', CONFIG.length], ['boom-1', 'boom', undefined], ['code-1', 'run_code', undefined]] as const) {
      const event = result(callId)
      expect(page).toContain(`[tool step ${event.data.step} seq ${event.seq} · ${name} · ${chars ?? ''}`)
      expect(page).toContain(`expand_result({"seq":${event.seq},"formatVersion":${V}})`)
    }
    // Nested dispatches are log-only: no locator line of their own, no copied text.
    expect(page.split('[tool step')).toHaveLength(4)
    expect(page).not.toContain('echo_nested')
    expect(page).not.toContain('PORT_SENTINEL')
    expect(page).not.toContain('BOOM_ERROR_SENTINEL')
  })

  it('recall_turn full serves the V4 result records verbatim, the PTC outer result included', async () => {
    const { events, result } = await session('v4-full')
    const full = renderSealedTurn(events, 1, { view: 'full' })!.rendered
    const records = JSON.parse(full.split('## Original records (including reasoning, tool output and recorded file metadata)\n')[1]!) as Array<{ type: string; data: { message?: unknown } }>
    const results = records.filter(record => record.type === 'tool/result')
    expect(results.map(record => record.data.message)).toEqual(['read-1', 'boom-1', 'code-1'].map(id => result(id).data.message))
    // The program forwarded its nested evidence into the outer result, which is served verbatim.
    expect(JSON.stringify(result('code-1').data.message)).toContain(NESTED)
    expect(full).toContain('PORT_SENTINEL=7443')
    expect(full).toContain('BOOM_ERROR_SENTINEL')
    expect(full).not.toContain('"tool-result"')
  })

  it('recall_step renders each sibling result in order with its error flag and own locator', async () => {
    const { events, result, execution } = await session('v4-step')
    const page = renderSealedStepPage(events, 1, 1)!
    expect(page).toContain('## Results (verbatim)')
    expect(page).toContain('→ read_config({"path":"app.toml"})')
    expect(page).toContain('→ boom({})')
    const [read, boom] = [result('read-1'), result('boom-1')]
    expect(page.indexOf(`[result]\n${CONFIG}`)).toBeGreaterThan(-1)
    expect(page.indexOf('[error result]\n')).toBeGreaterThan(page.indexOf('[result]\n'))
    expect(page).toContain('BOOM_ERROR_SENTINEL')
    expect(await recallStepToolDefinition().execute({ turn: '1', step: '1' }, execution)).toBe(page)
    const code = renderSealedStepPage(events, 1, 2)!
    expect(code).toContain('→ run_code(')
    expect(code).toContain(NESTED)
    expect(read.seq).not.toBe(boom.seq)
  })

  it('expand_result returns each V4 result by seq or ordinal, errors and the PTC outer result included', async () => {
    const { result, execution } = await session('v4-expand')
    const expand = (args: object) => expandResultToolDefinition().execute(args, execution)
    const [read, boom, code] = [result('read-1'), result('boom-1'), result('code-1')]
    expect(await expand({ seq: read.seq, formatVersion: V })).toBe(`[full result of read_config · seq ${read.seq} (turn 1 step 1 call 1)]\n${CONFIG}`)
    const failed = await expand({ seq: boom.seq, formatVersion: V })
    expect(failed).toMatch(new RegExp(`^\\[full result of boom · seq ${boom.seq} \\(turn 1 step 1 call 2\\)\\]\\n`))
    expect(failed).toContain('BOOM_ERROR_SENTINEL')
    expect(await expand({ turn: 1, step: 1, call: 2 })).toContain('BOOM_ERROR_SENTINEL')
    // Block 1 is the whole V4 result; there is never a second block.
    expect(await expand({ turn: 1, step: 1, call: 1, block: 1 })).toBe(`[full result of read_config · turn 1 step 1 call 1 block 1]\n${CONFIG}`)
    await expect(expand({ seq: read.seq, formatVersion: V, block: 2 })).rejects.toThrow('no result block 2 (result has 1 blocks)')
    const program = await expand({ seq: code.seq, formatVersion: V })
    expect(program).toContain(`[full result of run_code · seq ${code.seq} (turn 1 step 2 call 1)]`)
    expect(program).toContain(NESTED)
    expect(await expand({ seq: read.seq, formatVersion: V, grep: 'PORT_SENTINEL' })).toContain('1: PORT_SENTINEL=7443')
  })

  it('recall_search classifies each V4 result by its isError field and indexes nested evidence once, at the outer result', async () => {
    const { events, result } = await session('v4-search')
    const [read, boom, code] = [result('read-1'), result('boom-1'), result('code-1')]
    expect(searchSessionEvents(events, 'PORT_SENTINEL', { scope: 'auto' })).toMatchObject([
      { turn: 1, step: 1, kind: 'tool_output', seq: read.seq, locator: `expand_result({"seq":${read.seq},"formatVersion":${V}})` },
    ])
    expect(searchSessionEvents(events, 'BOOM_ERROR_SENTINEL', { scope: 'auto' })).toMatchObject([
      { turn: 1, step: 1, kind: 'tool_error', seq: boom.seq, locator: `expand_result({"seq":${boom.seq},"formatVersion":${V}})` },
    ])
    expect(searchSessionEvents(events, 'NESTED_ONLY_SENTINEL', { kinds: ['tool_output'] })).toMatchObject([
      { turn: 1, step: 2, kind: 'tool_output', seq: code.seq },
    ])
  })
})
