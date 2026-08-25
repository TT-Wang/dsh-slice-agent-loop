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
import { Context, Service } from '@deepseek-ai/cordis';
export interface Config {
    maxParallelToolCalls?: number;
    maxStepsPerTurn?: number;
}
/** Default maximum in-flight parallel-safe tool calls per agent step. */
export declare const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10;
/**
 * Default hard ceiling on continuation steps within one turn.
 *
 * This is a BOUND, not a diagnosis. An earlier proposal paired it with stall
 * detection ("a continuation step with no assistant text and no new file
 * anchor is a stalled step; warn at 4, terminate at 8"). Replayed against a
 * real 19-turn session that predicate would have cut 45 of 143 steps — 31% —
 * including 24 steps off a turn that did 74 distinct tool calls of real work,
 * and it fired a warning on ordinary 5-step turns. The reason is that for a
 * reasoning model "no visible text plus tool calls" is the NORMAL shape of
 * investigation: narration goes into reasoning blocks and visible text only
 * appears at the close. A productive 49-step turn and a futile 20-step turn
 * were indistinguishable on that axis, and on repetition too (both 0%).
 *
 * So: no heuristic that pretends to know whether the model is making
 * progress. Just a ceiling. 50 clears every legitimate turn observed in that
 * session (longest was 49) while still bounding the trajectory.
 */
export declare const DEFAULT_MAX_STEPS_PER_TURN = 50;
export declare class SliceLoopPlugin extends Service {
    static inject: string[];
    constructor(ctx: Context, config?: Config);
}
export default SliceLoopPlugin;
