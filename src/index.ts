/**
 * dsh-slice-agent-loop — the SliceAgent concrete agent loop plugin.
 *
 * Registers the SliceAgentLifecycle factory into ctx.agents (single
 * registration enforced by the interface: loading beside the stock AgentLoop
 * factory fails loudly, never an order-dependent pick — plan v2.1 phase 0).
 *
 * The plugin owns its scheduler configuration: maxParallelToolCalls is
 * validated at construction and handed to every driver instance, replacing
 * the stock loop's `ctx.agentLoop.config` lookup.
 */

import { Context, Service } from 'cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SliceAgentLifecycle, type LifecycleAgent } from './lifecycle.js'
import { SliceLoopAgent } from './driver.js'

export interface Config {
  maxParallelToolCalls?: number
}

/** Default maximum in-flight parallel-safe tool calls per agent step. */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10

function resolveMaxParallelToolCalls(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error('maxParallelToolCalls must be a positive integer')
  }
  return resolved
}

export class SliceLoopPlugin extends Service {
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sliceAgentLoop')
    const maxParallelToolCalls = resolveMaxParallelToolCalls(config.maxParallelToolCalls)
    // 提示词变量所有权（架构文档：the loop supplies provider/model/cwd）——
    // stock agent-loop/index.ts:312-314 同构；缺了 persona 节的 {{cwd}} 解析不了。
    ctx.systemPrompt.variable('provider', (context) => context.agent?.options.provider)
    ctx.systemPrompt.variable('model', (context) => context.agent?.options.model)
    ctx.systemPrompt.variable('cwd', (context) => context.agent?.session.header.cwd)
    const lifecycle = new SliceAgentLifecycle(
      ctx,
      (loopCtx: Context, id: SessionId, options: AgentOptions, session: Session): LifecycleAgent =>
        new SliceLoopAgent(loopCtx, id, options, session, { maxParallelToolCalls }),
    )
    ctx.effect(() => ctx.agents.setFactory(lifecycle), 'sliceLoop.setFactory()')
  }
}

export default SliceLoopPlugin
