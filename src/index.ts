/**
 * dsh-slice-agent-loop — the SliceAgent concrete agent loop plugin.
 *
 * Registers the SliceAgentLifecycle factory into ctx.agents (single
 * registration enforced by the interface: loading beside the stock AgentLoop
 * factory fails loudly, never an order-dependent pick — plan v2.1 phase 0).
 */

import { Context } from 'cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SliceAgentLifecycle, type LifecycleAgent } from './lifecycle.js'
import { SliceLoopAgent } from './driver.js'

export interface Config {
  maxParallelToolCalls?: number
}

export const name = 'slice-agent-loop'

export function apply(ctx: Context, _config: Config = {} as Config): void {
  const lifecycle = new SliceAgentLifecycle(
    ctx,
    (loopCtx: Context, id: SessionId, options: AgentOptions, session: Session): LifecycleAgent =>
      new SliceLoopAgent(loopCtx, id, options, session),
  )
  ctx.effect(() => ctx.agents.setFactory(lifecycle), 'sliceLoop.setFactory()')
}

export default apply
