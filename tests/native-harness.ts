/** Real DSH services with only the external model replaced (no settings provider is needed). */
import { Context, type Plugin } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlModule from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import SliceLoopPlugin, { type Config } from '../src/index.js'
import { FixtureWorkingDirectory } from './fixture-code-runtime.js'
import { requireReconstructableRequests } from './request-reconstruction.js'

/**
 * The real JSONL persistence plugin. 0.2.0-rc.2 default-exports it as a class;
 * since 0.2.1 the module itself is the plugin (`name`, `Config`, `apply`) and has
 * no default export (upstream dfca3c3c6f). YAML rows name the package and load
 * either shape; only an `import X from` breaks.
 */
export const JsonlPersistence = ((JsonlModule as { default?: Plugin }).default ?? JsonlModule) as Plugin

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

  /** The response the next model call will receive. */
  peek(): readonly StreamChunk[] | undefined {
    return this.responses[0]
  }

  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('native test adapter exhausted')
    for (const chunk of response) yield chunk
  }
}

export interface NativeHarnessOptions {
  config?: Config
  persistenceRoot?: string
  slice?: boolean
}

/**
 * Mount the stock loop with the request-reconstruction check, optionally with
 * real JSONL persistence. The host's own runtime invariants are gone since 0.2.1;
 * see tests/request-reconstruction.ts for the check that replaces the one the
 * suite relied on.
 */
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
    await ctx.plugin(SystemPrompt, { personaPrefix: 'Native-context integration fixture.' })
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(FixtureWorkingDirectory)
    await ctx.plugin(AgentRegistry)
    if (options.persistenceRoot !== undefined) {
      await ctx.plugin(JsonlPersistence, { root: options.persistenceRoot, compression: 'none' })
    }
    await ctx.plugin(AgentLoop, { agents: [] })
    requireReconstructableRequests(ctx)
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

/**
 * Present each scripted step in the one mode its model call needs.
 *
 * Up to 0.2.0-rc.2 an agent could present its tools as `both`: direct calls and
 * `run_code` side by side. 0.2.1 accepts only `native`, which hides `run_code`,
 * or `ptc`, which refuses every other direct call (upstream note "One tool
 * invocation form per agent", guide v0.2.1-alpha.1/tool-presentation-mode).
 * Some sessions here interleave direct results with `run_code` results and their
 * nested `tool/ptc-dispatch` records, as a 0.2.0 `both` session or a session
 * resumed under the other mode leaves them in its log. Switching the mode
 * between steps writes such a log with supported modes on both hosts: `ptc` when
 * the next scripted response calls `run_code`, `native` when it calls another
 * tool, and no change when it calls none. The loop assembles a step's tools and
 * system prompt before `agent/pre-step`, so the switch happens when the previous
 * step ends. Each switch changes the request's tool set and system prompt, which
 * the log records as host-owned surface nodes, as a real change of presentation would.
 */
export function presentPerStep(harness: NativeHarness, agent: Agent): void {
  let current: 'native' | 'ptc' | undefined
  let release: (() => void) | undefined
  const present = () => {
    const calls = (harness.adapter.peek() ?? []).flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? [chunk.block.name] : [])
    if (calls.includes(RUN_CODE_NAME) && calls.some(name => name !== RUN_CODE_NAME)) {
      throw new Error('one scripted step cannot call run_code beside a direct tool under a single presentation mode')
    }
    const mode = calls.length === 0 ? current ?? 'native' : calls.includes(RUN_CODE_NAME) ? 'ptc' : 'native'
    if (mode === current) return
    release?.()
    release = agent.ctx.tools.presentAs(mode)
    current = mode
  }
  present()
  harness.ctx.on('session/event', (session, event) => {
    if (session === agent.session && event.type === 'step/end') present()
  })
}

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
