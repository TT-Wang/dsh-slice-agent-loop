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
import { Context, Service } from 'cordis';
export interface Config {
    maxParallelToolCalls?: number;
}
/** Default maximum in-flight parallel-safe tool calls per agent step. */
export declare const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10;
export declare class SliceLoopPlugin extends Service {
    static inject: string[];
    constructor(ctx: Context, config?: Config);
}
export default SliceLoopPlugin;
