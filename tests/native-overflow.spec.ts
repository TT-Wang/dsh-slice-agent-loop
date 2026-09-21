import { afterEach, describe, expect, it } from 'vitest'
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { renderSealedTurn } from '../src/recall.js'
import { nativeHarness, nativeSend, nativeText, nativeTool, type NativeHarness } from './native-harness.js'

const live: NativeHarness[] = []
afterEach(async () => {
  for (const harness of live.splice(0).reverse()) await harness.ctx.fiber.dispose()
})

describe('host context overflow contract', () => {
  it('reports provider rejection, keeps the failed raw turn and recalls it after continuation', async () => {
    // The adapter reports a deterministic provider failure; this is not a
    // tokenizer/window-size measurement or a real-provider recovery claim.
    const failure = { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: 'simulated provider context window exceeded', status: 400 }
    const overflow: StreamChunk[] = [{ type: 'finish', reason: { kind: 'error', failure } }]
    const h = await nativeHarness([
      nativeTool('large-result', 'large_fixture'), overflow,
      nativeTool('recall-failed-turn', 'recall_turn', { turn: '1', view: 'full' }), nativeText('continued after recall'),
    ], { config: { fold: { enabled: false } } })
    live.push(h)
    const exactInput = 'OVERFLOW_USER_SENTINEL\n' + 'original request line\n'.repeat(200)
    const exactResult = 'OVERFLOW_RESULT_SENTINEL\n' + 'original returned line\n'.repeat(500)
    h.ctx.tools.register(defineContentToolFixture({
      name: 'large_fixture', description: 'Return a deterministic large observation', parameters: {},
      execute: async () => [{ type: 'text', text: exactResult }],
    }))
    const { agent } = await h.ctx.agents.create({ sessionId: SessionId('native-overflow'), agentOptions: { provider: 'native-mock', model: 'deterministic' } })
    await nativeSend(agent, exactInput)

    expect(h.adapter.requests).toHaveLength(2)
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]).toBeInstanceOf(LlmError)
    expect((h.errors[0] as LlmError).failure).toEqual(failure)
    const failedEvents = structuredClone(agent.session.snapshotEvents())
    expect(failedEvents.find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'error', error: failure } } })
    expect(failedEvents.some(isReplacementSurfaceEvent)).toBe(false)
    for (const event of failedEvents.filter(event => event.surfaceOp === 'append')) {
      expect(agent.session.surface.nodes).toContain(event.seq)
    }
    // The exact failed result bytes live in the original records: the full view.
    const failedPage = renderSealedTurn(failedEvents, 1, { view: 'full' })!.rendered
    expect(failedPage).toContain('status error')
    expect(failedPage).toContain(exactInput)
    expect(failedPage).toContain(JSON.stringify(exactResult))

    await nativeSend(agent, 'Recall the failed turn, then continue.')
    expect(h.adapter.requests).toHaveLength(4)
    expect(h.errors).toHaveLength(1)
    expect(agent.session.snapshotEvents().slice(0, failedEvents.length)).toEqual(failedEvents)
    expect(agent.session.snapshotEvents().some(isReplacementSurfaceEvent)).toBe(true)
    const recalled = agent.session.snapshotEvents().find(event => event.type === 'tool/result'
      && event.data.message.content.some(block => block.toolCallId === 'recall-failed-turn'))
    expect(recalled?.type).toBe('tool/result')
    if (recalled?.type !== 'tool/result') throw new Error('expected the native recall tool result')
    const recalledText = recalled.data.message.content.flatMap(block => block.content.flatMap(part => part.type === 'text' ? [part.text] : [])).join('\n')
    expect(recalledText).toBe(failedPage)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
  })
})
