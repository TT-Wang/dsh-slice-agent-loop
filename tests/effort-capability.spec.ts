/** A-RT-01: the factory effort default must never make a whole session undispatchable. */
import { afterEach, describe, expect, it } from 'vitest'
import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { nativeHarness, nativeSend, nativeText, type NativeHarness } from './native-harness.js'
import type { Config } from '../src/index.js'

const live: NativeHarness[] = []
afterEach(async () => {
  for (const harness of live.splice(0).reverse()) await harness.ctx.fiber.dispose()
})

/** `undefined` declares no reasoning at all; the host then rejects any effort. */
class CapabilityAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly efforts: string[] | undefined) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: model, inputModalities: ['text'],
      ...this.efforts === undefined ? {} : {
        reasoning: {
          efforts: this.efforts.map(id => ({ id: ReasoningEffortId(id), name: id })),
          ...this.efforts.length === 0 ? {} : { defaultEffort: ReasoningEffortId(this.efforts[0]!) },
        },
      },
    })
  }

  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    for (const chunk of nativeText('capability answer')) yield chunk
  }
}

async function dispatch(id: string, efforts: string[] | undefined, config: Config = {}) {
  const harness = await nativeHarness([], { config })
  live.push(harness)
  const adapter = new CapabilityAdapter(efforts)
  harness.ctx.llm.registerAdapter([id], adapter)
  const { agent } = await harness.ctx.agents.create({
    sessionId: SessionId(id), agentOptions: { provider: id, model: 'audited' },
  })
  await nativeSend(agent, 'first question')
  await nativeSend(agent, 'second question')
  return { harness, adapter }
}

describe('reasoning effort capability guard', () => {
  it('dispatches under factory defaults on a model that declares only high', async () => {
    const { harness, adapter } = await dispatch('high-only', ['high'])
    expect(harness.errors).toEqual([])
    expect(adapter.requests).toHaveLength(2)
    // Nothing injected, so the adapter's own default is materialized downstream.
    expect(adapter.requests.map(request => request.reasoningEffort)).toEqual(['high', 'high'])
    expect(harness.warns.filter(message => message.startsWith('slice defaultReasoningEffort='))).toEqual([
      'slice defaultReasoningEffort=low is not declared by high-only/audited (declared: high); inheriting the adapter default',
    ])
  })

  it('dispatches under factory defaults on a model that declares no reasoning', async () => {
    const { harness, adapter } = await dispatch('no-reasoning', undefined)
    expect(harness.errors).toEqual([])
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests.map(request => request.reasoningEffort)).toEqual([undefined, undefined])
  })

  it('still injects the configured default when the model declares it', async () => {
    const { harness, adapter } = await dispatch('declares-low', ['high', 'low'], { defaultReasoningEffort: 'low' })
    expect(harness.errors).toEqual([])
    expect(adapter.requests.map(request => request.reasoningEffort)).toEqual(['low', 'low'])
    expect(harness.warns.filter(message => message.startsWith('slice defaultReasoningEffort='))).toEqual([])
  })

  it('inherits rather than failing when an explicitly configured effort is undeclared', async () => {
    const { harness, adapter } = await dispatch('max-configured', ['high'], { defaultReasoningEffort: 'max' })
    expect(harness.errors).toEqual([])
    expect(adapter.requests.map(request => request.reasoningEffort)).toEqual(['high', 'high'])
  })

  it('never overrides an effort an outer contributor chose explicitly', async () => {
    const harness = await nativeHarness([], {})
    live.push(harness)
    const adapter = new CapabilityAdapter(['high', 'low'])
    harness.ctx.llm.registerAdapter(['explicit-choice'], adapter)
    harness.ctx.on('agent/request', async (_payload, next) => ({ ...await next(), reasoningEffort: ReasoningEffortId('high') }), { prepend: true })
    const { agent } = await harness.ctx.agents.create({
      sessionId: SessionId('explicit-choice'), agentOptions: { provider: 'explicit-choice', model: 'audited' },
    })
    await nativeSend(agent, 'first question')
    expect(harness.errors).toEqual([])
    expect(adapter.requests[0]!.reasoningEffort).toBe('high')
  })
})
