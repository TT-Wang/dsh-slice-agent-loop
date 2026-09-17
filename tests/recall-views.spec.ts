/** recall batch 2: recall_turn views and recall_search scope/locators, driven on the stock DSH loop. */
import { afterEach, describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { nativeHarness, nativeSend, nativeText, nativeTool, type NativeHarness } from './native-harness.js'
import { recallToolDefinition, renderSealedTurn, renderSearchHits, searchSessionEvents, TOOL_OUTPUT_SLOTS, TOOL_SNIPPET_CHARS } from '../src/recall.js'

const live: NativeHarness[] = []
afterEach(async () => {
  for (const harness of live.splice(0).reverse()) await harness.ctx.fiber.dispose()
})

async function boot(...args: Parameters<typeof nativeHarness>): Promise<NativeHarness> {
  const harness = await nativeHarness(...args)
  live.push(harness)
  return harness
}

/** A reasoning block followed by a text block, in one assistant step. */
function reasonedText(reasoning: string, text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: reasoning },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text },
    { type: 'block-end', index: 1, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

const CONFIG = `PORT_SENTINEL=7443\n${'filler line of configuration text\n'.repeat(60)}`
const TRAP = 'benign output mentioning the literal "isError":true string TRAP_SENTINEL'

function toolResultText(h: NativeHarness, sessionId: string, callId: string): { seq: number; text: string } {
  const agent = h.ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) throw new Error(`no agent ${sessionId}`)
  const event = agent.session.snapshotEvents().find((e) => e.type === 'tool/result'
    && e.surfaceOp === 'append' && e.data.message.content[0]?.toolCallId === callId)
  if (event?.type !== 'tool/result') throw new Error(`missing tool result ${callId}`)
  const text = event.data.message.content.flatMap((b) => b.content.flatMap((inner) => inner.type === 'text' ? [inner.text] : [])).join('\n')
  return { seq: event.seq, text }
}

/**
 * Turn 1: read config (tool), reasoning + text. Turn 2: a throwing tool and
 * a trap output, text. Turn 3: recall_turn dialogue view. Turn 4:
 * recall_search over everything. Turn 5: a closing text so turn 4 is sealed.
 */
async function session(id: string) {
  const h = await boot([
    nativeTool('read-1', 'read_config', { path: 'app.toml' }),
    reasonedText('HIDDEN_REASONING_SENTINEL', 'ASSISTANT_ONE_SENTINEL the config is loaded'),
    nativeTool('boom-1', 'boom'), nativeTool('trap-1', 'trap'), nativeText('ASSISTANT_TWO_SENTINEL'),
    nativeTool('recall-1', 'recall_turn', { turn: '1', view: 'dialogue' }), nativeText('recalled'),
    nativeTool('search-1', 'recall_search', { query: 'PORT_SENTINEL' }), nativeText('searched'),
    nativeText('closing'),
  ])
  h.ctx.tools.register(defineContentToolFixture({
    name: 'read_config', description: 'Read config', parameters: { path: { type: 'string', required: true } },
    execute: async () => [{ type: 'text', text: CONFIG }],
  }))
  h.ctx.tools.register(defineContentToolFixture({
    name: 'boom', description: 'Fail', parameters: {},
    execute: async () => { throw new Error('BOOM_ERROR_SENTINEL: disk on fire') },
  }))
  h.ctx.tools.register(defineContentToolFixture({
    name: 'trap', description: 'Trap', parameters: {},
    execute: async () => [{ type: 'text', text: TRAP }],
  }))
  const { agent } = await h.ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'native-mock', model: 'deterministic' } })
  await nativeSend(agent, 'USER_ONE_SENTINEL read the config')
  await nativeSend(agent, 'USER_TWO_SENTINEL run the failing tool')
  await nativeSend(agent, 'recall the first turn as dialogue')
  await nativeSend(agent, 'search for the port')
  await nativeSend(agent, 'wrap up')
  expect(h.errors).toEqual([])
  return { h, agent, events: agent.session.snapshotEvents() }
}

describe('recall_turn views', () => {
  it('dialogue view carries each text once, no reasoning, no records JSON, and one locator line per tool result', async () => {
    const { h, events } = await session('views-dialogue')
    const read = toolResultText(h, 'views-dialogue', 'read-1')
    const page = renderSealedTurn(events, 1, { view: 'dialogue' })!
    expect(page.userMessages).toBe(1)
    expect(page.assistantSteps).toBe(1)
    const text = page.rendered
    expect(text.split('USER_ONE_SENTINEL')).toHaveLength(2)
    expect(text.split('ASSISTANT_ONE_SENTINEL')).toHaveLength(2)
    expect(text).not.toContain('HIDDEN_REASONING_SENTINEL')
    expect(text).not.toContain('## Original records')
    expect(text).not.toContain('PORT_SENTINEL')
    expect(text).toContain(`[tool step 1 seq ${read.seq} · read_config · ${CONFIG.length} chars · expand_result({"seq":${read.seq},"formatVersion":3})]`)
    expect(text.split('[tool step')).toHaveLength(2)
    expect(text).toContain('view dialogue')
    expect(text).toContain('recall_turn({"turn":"1","view":"full"})')

    // The same page came back through the real tool call.
    const recalled = toolResultText(h, 'views-dialogue', 'recall-1')
    expect(recalled.text).toBe(text)
  })

  it('full view still carries reasoning and the original records JSON, but only when asked for', async () => {
    const { events } = await session('views-full')
    const full = renderSealedTurn(events, 1, { view: 'full' })!
    expect(renderSealedTurn(events, 1)!.rendered).toBe(renderSealedTurn(events, 1, { view: 'dialogue' })!.rendered)
    expect(full.rendered).toContain('## Original records (including reasoning, tool output and recorded file metadata)')
    expect(full.rendered).toContain('HIDDEN_REASONING_SENTINEL')
    expect(full.rendered).toContain('PORT_SENTINEL=7443')
    expect(full.rendered).not.toContain('[tool step')
    const records = JSON.parse(full.rendered.split('## Original records (including reasoning, tool output and recorded file metadata)\n')[1]!) as Array<{ type: string }>
    expect(records.map((r) => r.type)).toEqual(['user/message', 'assistant/message', 'tool/call', 'tool/result', 'assistant/message'])
  })
})

describe('recall_turn default view', () => {
  /**
   * The default used to be "full": one call returned every original record as
   * JSON, two orders of magnitude more characters than the said text. The
   * cheap page is the default now; "full" is served only when named.
   */
  it('defaults to dialogue through the real tool, and still serves the records on explicit view "full"', async () => {
    const h = await boot([
      nativeTool('read-1', 'read_config', { path: 'app.toml' }),
      reasonedText('HIDDEN_REASONING_SENTINEL', 'ASSISTANT_ONE_SENTINEL the config is loaded'),
      nativeTool('recall-default', 'recall_turn', { turn: '1' }), nativeText('recalled by default'),
      nativeTool('recall-full', 'recall_turn', { turn: '1', view: 'full' }), nativeText('recalled in full'),
    ])
    // A working turn's tool output is what makes "full" expensive: the said
    // text is a few hundred chars, the records are tens of thousands.
    const document = `PORT_SENTINEL=7443\n${'row = stable value\n'.repeat(2_000)}`
    h.ctx.tools.register(defineContentToolFixture({
      name: 'read_config', description: 'Read config', parameters: { path: { type: 'string', required: true } },
      execute: async () => [{ type: 'text', text: document }],
    }))
    const { agent } = await h.ctx.agents.create({ sessionId: SessionId('views-default'), agentOptions: { provider: 'native-mock', model: 'deterministic' } })
    await nativeSend(agent, 'USER_ONE_SENTINEL read the config')
    await nativeSend(agent, 'recall the first turn')
    await nativeSend(agent, 'now recall it in full')
    expect(h.errors).toEqual([])

    const byDefault = toolResultText(h, 'views-default', 'recall-default').text
    expect(byDefault).toBe(renderSealedTurn(agent.session.snapshotEvents(), 1, { view: 'dialogue' })!.rendered)
    expect(byDefault).toContain('view dialogue (default')
    expect(byDefault).toContain('USER_ONE_SENTINEL')
    expect(byDefault).not.toContain('## Original records')
    expect(byDefault).not.toContain('HIDDEN_REASONING_SENTINEL')
    expect(byDefault).not.toContain('PORT_SENTINEL')

    const full = toolResultText(h, 'views-default', 'recall-full').text
    expect(full).toContain('## Original records (including reasoning, tool output and recorded file metadata)')
    expect(full).toContain('HIDDEN_REASONING_SENTINEL')
    expect(full).toContain('PORT_SENTINEL=7443')
    expect(full.length).toBeGreaterThan(byDefault.length * 50)
  })

  it('tells the model in the tool description that dialogue is the default and what full costs', () => {
    const definition = recallToolDefinition()
    expect(definition.description).toContain('view "dialogue" (default)')
    expect(definition.description).toContain('two orders of magnitude larger')
    expect(definition.description).not.toContain('view "full" (default)')
    expect(JSON.stringify(definition.parameters)).toContain('\\"dialogue\\" (default)')
  })
})

describe('recall_search scope and locators', () => {
  it('scope auto finds a fact that exists only in a tool result and names its durable seq', async () => {
    const { h, events } = await session('search-auto')
    const read = toolResultText(h, 'search-auto', 'read-1')
    expect(read.text).toContain('PORT_SENTINEL=7443')
    const hits = searchSessionEvents(events, 'PORT_SENTINEL', { scope: 'auto' })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ turn: 1, step: 1, kind: 'tool_output', seq: read.seq, locator: `expand_result({"seq":${read.seq},"formatVersion":3})` })
    expect(hits[0]!.snippet).toContain('PORT_SENTINEL=7443')
    expect(Array.from(hits[0]!.snippet).length).toBeLessThanOrEqual(TOOL_SNIPPET_CHARS + 2)
    expect(events[read.seq]?.type).toBe('tool/result')

    // The tool's own rendering (default scope auto) named the same locator.
    const searched = toolResultText(h, 'search-auto', 'search-1')
    expect(searched.text).toContain(`seq ${read.seq} [tool_output]`)
    expect(searched.text).toContain(`→ expand_result({"seq":${read.seq},"formatVersion":3})`)
    // Dialogue hits name the dialogue view of their turn.
    expect(renderSearchHits('q', searchSessionEvents(events, 'ASSISTANT_ONE_SENTINEL'))).toContain('→ recall_turn({"turn":"1","view":"dialogue"})')
  })

  it('scope dialogue and the pure default skip raw tool output; explicit kinds are respected', async () => {
    const { events } = await session('search-kinds')
    expect(searchSessionEvents(events, 'PORT_SENTINEL', { scope: 'dialogue' })).toEqual([])
    expect(searchSessionEvents(events, 'PORT_SENTINEL')).toEqual([])
    expect(searchSessionEvents(events, 'PORT_SENTINEL', { kinds: ['user', 'assistant'], scope: 'auto' })).toEqual([])
    const userOnly = searchSessionEvents(events, 'SENTINEL', { kinds: ['user'] })
    expect(userOnly.length).toBeGreaterThan(0)
    expect(userOnly.every((hit) => hit.kind === 'user')).toBe(true)
    const toolOnly = searchSessionEvents(events, 'PORT_SENTINEL', { kinds: ['tool_output'], scope: 'dialogue' })
    expect(toolOnly.map((hit) => hit.kind)).toEqual(['tool_output'])
  })

  it('does not index the inputs or outputs of the recall family', async () => {
    const { h, events } = await session('search-exclusion')
    const recalled = toolResultText(h, 'search-exclusion', 'recall-1')
    // The phrase really is in the log — inside the recall_turn output — and nowhere else.
    expect(recalled.text).toContain('locators')
    expect(searchSessionEvents(events, 'locators', { scope: 'auto' })).toEqual([])
    expect(searchSessionEvents(events, 'locators', { kinds: ['tool_input', 'tool_output', 'tool_error', 'user', 'assistant'] })).toEqual([])
    // The recall_turn call's own arguments ({"turn":"1","view":"dialogue"}) are not tool_input evidence either.
    expect(searchSessionEvents(events, 'view', { kinds: ['tool_input'] })).toEqual([])
    // Text that the recall_turn output copied from turn 1 is found once, in turn 1 — never a second time via the copy.
    const copied = searchSessionEvents(events, 'ASSISTANT_ONE_SENTINEL', { scope: 'auto' })
    expect(copied.map((hit) => [hit.turn, hit.kind])).toEqual([[1, 'assistant']])
    // The recall_search output (turn 4) is not evidence for the port either.
    const port = searchSessionEvents(events, 'PORT_SENTINEL', { scope: 'auto' })
    expect(port.map((hit) => hit.turn)).toEqual([1])
  })

  it('classifies tool errors by the isError field, not by substring', async () => {
    const { h, events } = await session('search-iserror')
    const trap = toolResultText(h, 'search-iserror', 'trap-1')
    expect(trap.text).toContain('"isError":true')
    const errors = searchSessionEvents(events, 'BOOM_ERROR_SENTINEL', { scope: 'auto' })
    expect(errors.map((hit) => hit.kind)).toEqual(['tool_error'])
    expect(errors[0]!.locator).toBe(`expand_result({"seq":${errors[0]!.seq},"formatVersion":3})`)
    expect(events[errors[0]!.seq!]?.type).toBe('tool/result')
    expect(searchSessionEvents(events, 'BOOM_ERROR_SENTINEL', { kinds: ['tool_output'] })).toEqual([])
    expect(searchSessionEvents(events, 'TRAP_SENTINEL', { scope: 'auto' }).map((hit) => hit.kind)).toEqual(['tool_output'])
    expect(searchSessionEvents(events, 'TRAP_SENTINEL', { kinds: ['tool_error'] })).toEqual([])
  })

  it('bounds tool-output hits to the auto slots while dialogue hits keep the limit', () => {
    const ev = (type: string, data: unknown, seq: number) => ({ type, data, seq })
    const events: Array<{ type: string; data: unknown; seq: number }> = []
    let seq = 0
    const push = (type: string, data: unknown) => { events.push(ev(type, data, seq)); seq += 1 }
    for (let turn = 1; turn <= 6; turn += 1) {
      push('turn/start', { turn })
      push('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: `NEEDLE asked in turn ${turn}` }] })
      push('assistant/message', { turn, step: 1, message: { content: [{ type: 'tool-call', id: `c${turn}`, name: 'cat', arguments: '{}' }] } })
      push('tool/result', { turn, step: 1, message: { content: [{ type: 'tool-result', toolCallId: `c${turn}`, isError: false,
        content: [{ type: 'text', text: `${'flood '.repeat(400)} NEEDLE buried ${'flood '.repeat(400)}` }] }] } })
      push('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const hits = searchSessionEvents(events, 'NEEDLE', { scope: 'auto', limit: 4 })
    const toolHits = hits.filter((hit) => hit.kind === 'tool_output')
    expect(toolHits).toHaveLength(TOOL_OUTPUT_SLOTS)
    expect(hits.filter((hit) => hit.kind === 'user')).toHaveLength(4)
    for (const hit of toolHits) {
      expect(Array.from(hit.snippet).length).toBeLessThanOrEqual(TOOL_SNIPPET_CHARS + 2)
      expect(hit.locator).toBe(`expand_result({"seq":${hit.seq},"formatVersion":3})`)
      expect(events[hit.seq!]?.type).toBe('tool/result')
    }
    expect(searchSessionEvents(events, 'NEEDLE', { kinds: ['tool_output'], limit: 6 })).toHaveLength(6)
  })
})

describe('generated context in recall', () => {
  it('serves superseded runtime snapshots from both views and from search, never as the user request', () => {
    const plugin = { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }
    const events: Array<{ type: string; data: unknown; seq: number }> = []
    let seq = 0
    const push = (type: string, data: unknown) => { events.push({ type, data, seq }); seq += 1 }
    for (let turn = 1; turn <= 3; turn += 1) {
      push('turn/start', { turn })
      push('user/message', { source: plugin, content: [{ type: 'text', text: `RUNTIME_SNAPSHOT_${turn} This snapshot supersedes earlier runtime-context snapshots.` }] })
      push('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: `USER_ASK_${turn}` }] })
      push('assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: `REPLY_${turn}` }] } })
      push('turn/end', { turn, reason: { kind: 'completed' } })
    }
    for (const view of ['dialogue', 'full'] as const) {
      const page = renderSealedTurn(events, 2, { view })!
      expect(page.userMessages).toBe(1)
      expect(page.contextMessages).toBe(1)
      const request = page.rendered.split('## User request (verbatim)\n')[1]!.split('\n## Assistant response')[0]!
      expect(request).toContain('USER_ASK_2')
      expect(request).not.toContain('RUNTIME_SNAPSHOT_2')
      expect(page.rendered).toContain('## Generated context recorded during this turn (verbatim)\n[@deepseek-ai/dsh-system-prompt]\nRUNTIME_SNAPSHOT_2')
      expect(page.rendered).toContain('1 generated context message(s)')
    }
    const hits = searchSessionEvents(events, 'RUNTIME_SNAPSHOT_2', { scope: 'auto' })
    expect(hits[0]).toMatchObject({ turn: 2, kind: 'context', locator: 'recall_turn({"turn":"2","view":"dialogue"})' })
    expect(searchSessionEvents(events, 'RUNTIME_SNAPSHOT_2')[0]).toMatchObject({ turn: 2, kind: 'context' })
    expect(searchSessionEvents(events, 'RUNTIME_SNAPSHOT_2', { kinds: ['user'] })).toEqual([])
  })
})
