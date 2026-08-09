/**
 * dsh-slice-agent-loop — the SliceAgent concrete agent loop plugin.
 *
 * Registers the SliceAgentLifecycle factory into ctx.agents (single
 * registration enforced by the interface: loading beside the stock AgentLoop
 * factory fails loudly, never an order-dependent pick — plan v2.1 phase 0).
 */

import { Context, Service } from 'cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SliceAgentLifecycle, type LifecycleAgent } from './lifecycle.js'
import { SliceLoopAgent } from './driver.js'

export interface Config {
  maxParallelToolCalls?: number
}

export class SliceLoopPlugin extends Service {
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']

  constructor(ctx: Context, _config: Config = {}) {
    super(ctx, 'sliceAgentLoop')
    const lifecycle = new SliceAgentLifecycle(
      ctx,
      (loopCtx: Context, id: SessionId, options: AgentOptions, session: Session): LifecycleAgent =>
        new SliceLoopAgent(loopCtx, id, options, session),
    )
    ctx.effect(() => ctx.agents.setFactory(lifecycle), 'sliceLoop.setFactory()')
  }
}

export default SliceLoopPlugin
