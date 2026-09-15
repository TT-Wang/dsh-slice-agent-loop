import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SpillLocal from '@deepseek-ai/dsh-spill-local'
import { defineContentToolFixture, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { renderSealedTurn, searchSessionEvents } from '../src/recall.js'
import { recallStepToolDefinition, renderSealedStepPage } from '../src/recall-step.js'
import { fullResultAt, originalResultText, resultBySeq, spillLocatorOf } from '../src/fold/results.js'
import { expandResultToolDefinition } from '../src/fold/index.js'
import { nativeHarness, nativeSend, nativeText, nativeTool, type NativeHarness } from './native-harness.js'

type Event = { type: string; data: unknown; seq: number; surfaceOp?: unknown }
function siblings(): Event[] {
  const entries = [
    ['turn/start', { turn: 1 }],
    ['user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the input' }] }],
    ['assistant/message', { turn: 1, step: 1, message: { content: [
      { type: 'tool-call', id: 'recall', name: 'recall_turn', arguments: '{"turn":"1"}' },
      { type: 'tool-call', id: 'read', name: 'read', arguments: '{"path":"UNIQUE_INPUT_ONLY.ts"}' },
      { type: 'tool-call', id: 'bad', name: 'bash', arguments: '{"command":"bad"}' },
    ] } }],
    ['tool/result', { turn: 1, step: 1, message: { content: [
      { type: 'tool-result', toolCallId: 'recall', content: [{ type: 'text', text: 'RECALL_COPY_ONLY=1234' }] },
      { type: 'tool-result', toolCallId: 'read', content: [{ type: 'text', text: 'ORIGINAL_SIBLING_ONLY=7443' }] },
      { type: 'tool-result', toolCallId: 'bad', isError: true, content: [{ type: 'text', text: 'ERROR_SIBLING_ONLY=8754' }] },
    ] } }],
    ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
  ] as const
  return entries.map(([type, data], seq) => ({ type, data, seq, surfaceOp: 'append' }))
}

describe('exact original search locators', () => {
  it('routes tool-input hits to a view that contains the matched original arguments', () => {
    const events = siblings()
    const hits = searchSessionEvents(events, 'UNIQUE_INPUT_ONLY.ts', { scope: 'auto' })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ kind: 'tool_input', locator: 'recall_turn({"turn":"1","view":"full"})' })
    expect(renderSealedTurn(events, 1, { view: 'dialogue' })!.rendered).not.toContain('UNIQUE_INPUT_ONLY.ts')
    const args = JSON.parse(hits[0]!.locator.slice('recall_turn('.length, -1)) as { turn: string; view: 'full' }
    expect(renderSealedTurn(events, Number(args.turn), { view: args.view })!.rendered).toContain('UNIQUE_INPUT_ONLY.ts')
  })

  it('excludes only recalled siblings, classifies each original sibling and resolves the exact block', async () => {
    const events = siblings()
    expect(searchSessionEvents(events, 'RECALL_COPY_ONLY', { scope: 'auto' })).toEqual([])
    const hit = searchSessionEvents(events, 'ORIGINAL_SIBLING_ONLY', { scope: 'auto' })[0]!
    expect(hit).toMatchObject({ kind: 'tool_output', seq: 3, block: 2, locator: 'expand_result({"seq":3,"formatVersion":3,"block":2})' })
    expect(searchSessionEvents(events, 'ORIGINAL_SIBLING_ONLY', { kinds: ['tool_error'] })).toEqual([])
    const error = searchSessionEvents(events, 'ERROR_SIBLING_ONLY', { kinds: ['tool_error'] })[0]!
    expect(error).toMatchObject({ kind: 'tool_error', seq: 3, block: 3 })
    expect(searchSessionEvents(events, 'ERROR_SIBLING_ONLY', { kinds: ['tool_output'] })).toEqual([])
    const args = JSON.parse(hit.locator.slice('expand_result('.length, -1)) as { seq: number; block: number }
    const nativeEvents = events as unknown as readonly SessionEvent[]
    expect(resultBySeq(nativeEvents, args.seq, args.block)).toMatchObject({ name: 'read', text: 'ORIGINAL_SIBLING_ONLY=7443' })
    expect(await originalResultText(nativeEvents, { seq: args.seq }, 'test', args.block)).toBe('ORIGINAL_SIBLING_ONLY=7443')
    const execution = { agent: { session: { snapshotEvents: () => nativeEvents } } } as unknown as ToolRunContext
    const expanded = await expandResultToolDefinition().execute(args, execution)
    expect(expanded).toBe('[full result of read · seq 3 (turn 1 step 1 call 1) block 2]\nORIGINAL_SIBLING_ONLY=7443')
    const byOrdinal = await expandResultToolDefinition().execute({ turn: 1, step: 1, call: 1, block: 3 }, execution)
    expect(byOrdinal).toBe('[full result of bash · turn 1 step 1 call 1 block 3]\nERROR_SIBLING_ONLY=8754')
    // Existing whole-result retrieval remains available, including the recorded recall copy.
    expect(fullResultAt(nativeEvents, 1, 1, 1)?.text).toContain('RECALL_COPY_ONLY=1234')
    expect(() => resultBySeq(nativeEvents, args.seq, 4)).toThrow('no result block 4')
    expect(renderSealedTurn(events, 1, { view: 'dialogue' })!.rendered).toContain('expand_result({"seq":3,"formatVersion":3,"block":2})')
  })
})

const live: NativeHarness[] = []
const roots: string[] = []
afterEach(async () => {
  for (const h of live.splice(0).reverse()) await h.ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const LOG = Array.from({ length: 1200 }, (_, i) => `2026-09-13 10:00:00 INFO tick ${i} ${'x'.repeat(30)}`).join('\n')
function textOf(event: SessionEvent): string {
  return event.type === 'tool/result' ? event.data.message.content.flatMap((block) => block.content.flatMap((part) => part.type === 'text' ? [part.text] : [])).join('\n') : ''
}
async function spilledStep(id: string) {
  const h = await nativeHarness([
    nativeTool('source', 'bash'), nativeText('read'),
    nativeTool('recall', 'recall_step', { turn: '1', step: '1' }), nativeText('recalled'),
  ], { config: { fold: { pinSteps: 0, spillPreviewMinBytes: 50_000 } } })
  live.push(h)
  const root = await mkdtemp(join(tmpdir(), 'recall-step-spill-'))
  roots.push(root)
  await h.ctx.plugin(SpillLocal, { root } as never)
  h.ctx.tools.register(defineContentToolFixture({ name: 'bash', description: 'return log', parameters: {}, execute: async () => [{ type: 'text', text: LOG }] }))
  const { agent } = await h.ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'native-mock', model: 'deterministic' } })
  await nativeSend(agent, 'run it')
  const logged = agent.session.snapshotEvents().find((event) => event.type === 'tool/result' && event.surfaceOp === 'append' && event.data.message.content[0]?.toolCallId === 'source')!
  expect(spillLocatorOf(textOf(logged))).toBeDefined()
  expect(textOf(logged)).not.toContain('tick 300 ')
  return { h, agent, logged }
}

describe('spill-aware step recall', () => {
  it.each(['fold', 'native'] as const)('hydrates each inner text part of a %s spill without discarding adjacent text or another spill', async (format) => {
    const root = await mkdtemp(join(tmpdir(), 'recall-inner-spills-'))
    roots.push(root)
    const paths = [join(root, 'one.txt'), join(root, 'two.txt')]
    await writeFile(paths[0]!, 'FIRST_SPILLED_ORIGINAL')
    await writeFile(paths[1]!, 'SECOND_SPILLED_ORIGINAL')
    const preview = (path: string) => format === 'fold'
      ? `[tool · full text (100 bytes) stored at ${path} — open it]\nPREVIEW_ONLY`
      : `PREVIEW_ONLY\n\n(Omitted 100 bytes. Full formatted result stored at: ${path}. Use read with offset/limit, or grep this path to search within it.)`
    const events = siblings()
    const data = events[3]!.data as { message: { content: Array<{ content: Array<{ type: string; text: string }> }> } }
    data.message.content[1]!.content = [preview(paths[0]!), 'INDEPENDENT_PLAIN_TEXT', preview(paths[1]!)].map(text => ({ type: 'text', text }))
    const expected = 'FIRST_SPILLED_ORIGINAL\nINDEPENDENT_PLAIN_TEXT\nSECOND_SPILLED_ORIGINAL'
    const nativeEvents = events as unknown as readonly SessionEvent[]
    expect(await originalResultText(nativeEvents, { seq: 3 }, 'inner parts', 2)).toBe(expected)
    const execution = { agent: { session: { snapshotEvents: () => nativeEvents } } } as unknown as ToolRunContext
    expect(await expandResultToolDefinition().execute({ formatVersion: SESSION_FORMAT_VERSION, seq: 3, block: 2 }, execution)).toBe(`[full result of read · seq 3 (turn 1 step 1 call 1) block 2]\n${expected}`)
    const hydrated = await recallStepToolDefinition().execute({ turn: '1', step: '1' }, execution)
    expect(hydrated).toContain(expected)
    expect(hydrated).toContain('ERROR_SIBLING_ONLY=8754')
    expect(hydrated).not.toContain('PREVIEW_ONLY')

    // A missing later spill must not discard an already recovered part or plain text.
    await rm(paths[1]!)
    const partial = await recallStepToolDefinition().execute({ turn: '1', step: '1' }, execution)
    expect(partial).toContain('FIRST_SPILLED_ORIGINAL\nINDEPENDENT_PLAIN_TEXT')
    expect(partial).toContain('text part 3 preview — NOT full output')
    expect(partial).toContain('expand_result({"seq":3,"formatVersion":3,"block":2})')
    expect(partial).toContain('PREVIEW_ONLY')
    expect(partial).not.toContain('## Results (verbatim)')
  })

  it('recognizes and hydrates the native spill-policy notice as well as the fold preview format', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recall-native-spill-'))
    roots.push(root)
    const path = join(root, 'original. with spaces.txt')
    await writeFile(path, 'NATIVE_ORIGINAL_MIDDLE')
    const events = siblings()
    const data = events[3]!.data as { message: { content: Array<{ content: Array<{ text: string }> }> } }
    data.message.content[1]!.content[0]!.text = `preview\n\n(Omitted 100 bytes. Full formatted result stored at: ${path}. Use read with offset/limit, or grep this path to search within it.)`
    const page = renderSealedStepPage(events, 1, 1)!
    expect(page).toContain('preview — NOT full output')
    expect(page).toContain('expand_result({"seq":3,"formatVersion":3,"block":2})')
    expect(page).not.toContain('undefined bytes')
    const execution = { agent: { session: { snapshotEvents: () => events } } } as unknown as ToolRunContext
    const hydrated = await recallStepToolDefinition().execute({ turn: '1', step: '1' }, execution)
    expect(hydrated).toContain('NATIVE_ORIGINAL_MIDDLE')
    expect(hydrated).toContain('ERROR_SIBLING_ONLY=8754')
    expect(hydrated).not.toContain('NOT full output')
  })

  it('hydrates the spilled original before returning it and preserves recovered middle bytes in the request', async () => {
    const { h, agent, logged } = await spilledStep('recall-spill-full')
    const preview = renderSealedStepPage(agent.session.snapshotEvents(), 1, 1)!
    expect(preview).toContain('preview — NOT full output')
    expect(preview).toContain(`expand_result({"seq":${logged.seq},"formatVersion":3})`)
    expect(preview).not.toContain('## Results (verbatim)')
    await nativeSend(agent, 'recover that whole step')
    const recalled = agent.session.snapshotEvents().find((event) => event.type === 'tool/result' && event.surfaceOp === 'append' && event.data.message.content[0]?.toolCallId === 'recall')!
    expect(textOf(recalled)).toContain('## Results (verbatim)')
    expect(textOf(recalled)).toContain(LOG)
    expect(textOf(recalled)).not.toContain('NOT full output')
    expect(JSON.stringify(h.adapter.requests.at(-1)!.messages)).toContain('tick 300 ')
    expect(h.errors).toEqual([])
  })

  it('marks a missing spill as a preview with its exact expansion locator while preserving other recorded evidence', async () => {
    const { h, agent, logged } = await spilledStep('recall-spill-missing')
    await rm(spillLocatorOf(textOf(logged))!.locator)
    await nativeSend(agent, 'recover that whole step')
    const recalled = agent.session.snapshotEvents().find((event) => event.type === 'tool/result' && event.surfaceOp === 'append' && event.data.message.content[0]?.toolCallId === 'recall')!
    expect(textOf(recalled)).toContain('preview — NOT full output')
    expect(textOf(recalled)).toContain(`expand_result({"seq":${logged.seq},"formatVersion":3})`)
    expect(textOf(recalled)).toContain('→ bash(')
    expect(textOf(recalled)).not.toContain('## Results (verbatim)')
    expect(h.errors).toEqual([])
  })

  it('hydrates each selected sibling before concatenation, preserving old all-block retrieval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recall-sibling-spill-'))
    roots.push(root)
    const paths = [join(root, 'one.txt'), join(root, 'two.txt')]
    await writeFile(paths[0]!, 'ORIGINAL_ONE')
    await writeFile(paths[1]!, 'ORIGINAL_TWO')
    const events = siblings()
    const data = events[3]!.data as { message: { content: Array<{ content: Array<{ text: string }> }> } }
    data.message.content = paths.map((path) => ({ type: 'tool-result', content: [{ type: 'text', text: `[tool · full text (12 bytes) stored at ${path} — open it]\npreview` }] }))
    const nativeEvents = events as unknown as readonly SessionEvent[]
    expect(await originalResultText(nativeEvents, { seq: 3 }, 'siblings')).toBe('ORIGINAL_ONE\nORIGINAL_TWO')
    expect(await originalResultText(nativeEvents, { turn: 1, step: 1, call: 1 }, 'sibling', 2)).toBe('ORIGINAL_TWO')
  })
})
