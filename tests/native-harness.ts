/** Real DSH services with only the external model and settings storage replaced. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as loopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import Invariants from '@deepseek-ai/dsh-invariants'
import LlmRuntime, { createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as sessionInvariant from '@deepseek-ai/dsh-session/invariant'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import SliceLoopPlugin, { type Config } from '../src/index.js'

/** A dispatch-time cut independent of the slice renderer and reducer. */
export interface CapturedRequest {
  request: GenerateOptions
  events: readonly SessionEvent[]
}

/** Small deterministic adapter; both provider and loop requests remain observable. */
export class NativeAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  systemPromptUpdate?: 'in-history'

  constructor(private readonly responses: StreamChunk[][]) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: model, inputModalities: ['text', 'image'],
      reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }], defaultEffort: ReasoningEffortId('low') },
      ...this.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: this.systemPromptUpdate },
    })
  }

  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('native test adapter exhausted')
    for (const chunk of response) yield chunk
  }
}

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private documentForTest: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.documentForTest))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.documentForTest = { ...this.documentForTest, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

export interface NativeHarnessOptions {
  config?: Config
  persistenceRoot?: string
  slice?: boolean
}

/** Mount the stock loop and both stock invariants, with optional real JSONL persistence. */
export async function nativeHarness(responses: StreamChunk[][], options: NativeHarnessOptions = {}) {
  const ctx = new Context()
  const adapter = new NativeAdapter(responses)
  const captured: CapturedRequest[] = []
  const errors: unknown[] = []
  const warns: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export(message) {
    if (message.type === 'warn') warns.push(message.args.map(String).join(' '))
  } })
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'Native-context integration fixture.' })
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    if (options.persistenceRoot !== undefined) {
      await ctx.plugin(JsonlPersistence, { root: options.persistenceRoot, compression: 'none' })
    }
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Invariants)
    await ctx.plugin(sessionInvariant)
    await ctx.plugin(loopInvariant)
    const sliceFiber = options.slice === false ? undefined : ctx.plugin(SliceLoopPlugin, options.config ?? {})
    if (sliceFiber !== undefined) await sliceFiber
    ctx.llm.registerAdapter(['native-mock'], adapter)
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    ctx.on('llm/stream', (request, next) => {
      const session = request.sessionId === undefined ? undefined : ctx.sessions.get(request.sessionId)
      if (session !== undefined) captured.push({ request, events: structuredClone(session.snapshotEvents()) })
      return next()
    }, { global: true })
    return { ctx, adapter, captured, errors, warns, sliceFiber }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

export type NativeHarness = Awaited<ReturnType<typeof nativeHarness>>

export function nativeMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

export async function nativeSend(agent: Agent, text: string): Promise<void> {
  agent.followup(nativeMessage(text))
  await agent.whenIdle()
}

export function nativeText(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export function nativeTool(id: string, name: string, args: object = {}): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

export function nativeFailure(): StreamChunk[] {
  return [{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'retry fixture' } } }]
}
