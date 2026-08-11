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
import { Service } from '@deepseek-ai/cordis';
import { SliceAgentLifecycle } from './lifecycle.js';
import { SliceLoopAgent } from './driver.js';
/** Default maximum in-flight parallel-safe tool calls per agent step. */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10;
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
export const DEFAULT_MAX_STEPS_PER_TURN = 50;
function resolveMaxParallelToolCalls(value) {
    const resolved = value ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS;
    if (!Number.isInteger(resolved) || resolved < 1) {
        throw new Error('maxParallelToolCalls must be a positive integer');
    }
    return resolved;
}
function resolveMaxStepsPerTurn(value) {
    const resolved = value ?? DEFAULT_MAX_STEPS_PER_TURN;
    if (!Number.isInteger(resolved) || resolved < 1) {
        throw new Error('maxStepsPerTurn must be a positive integer');
    }
    return resolved;
}
/** The invariant-registry name the stock loop's companion check reserves. */
const STOCK_LOOP_INVARIANT = '@deepseek-ai/dsh-agent-loop';
const INCOMPATIBLE_INVARIANT_MESSAGE = [
    'dsh-slice-agent-loop is incompatible with the @deepseek-ai/dsh-agent-loop/invariant companion.',
    '',
    'That invariant asserts the model request equals session.deriveMessages() byte for byte.',
    'This loop deliberately sends a REBUILT bounded slice instead of the full derived history —',
    'that is what "bounded context per turn" means, so the assertion can never hold. Leaving the',
    'companion mounted makes every model request fail inside llm/stream, and the error is attributed',
    'to a package you have already replaced.',
    '',
    'Fix: remove the `agent-loop-invariant` row from your cordis configuration.',
    'Note that `dsh scaffold` writes it as a row SEPARATE from `agent-loop`, so swapping the loop',
    'does not remove it (packages/scaffold/helper/src/features/builtin/spine.ts).',
].join('\n');
/**
 * Fail at load time when the stock loop's reconstructability invariant is
 * mounted, instead of letting every turn die inside `llm/stream`.
 *
 * The registry rejects a duplicate package name synchronously, so registering a
 * no-op under the stock name does double duty: it detects a companion that
 * loaded first (we catch and explain), and it reserves the slot so a companion
 * loading later fails at boot too. Either order surfaces as one startup error
 * rather than a per-request one.
 *
 * `invariants` is intentionally NOT in `static inject` — a deployment without
 * the service is perfectly valid, and injecting it would suspend this fiber
 * forever instead.
 */
function guardStockLoopInvariant(ctx) {
    const invariants = ctx.get('invariants');
    if (invariants === undefined)
        return;
    try {
        ctx.effect(() => invariants.register(STOCK_LOOP_INVARIANT, () => { }), 'sliceLoop.reserveStockLoopInvariant()');
    }
    catch (error) {
        if (error instanceof Error && error.message.includes('already registered')) {
            throw new Error(INCOMPATIBLE_INVARIANT_MESSAGE, { cause: error });
        }
        throw error;
    }
}
export class SliceLoopPlugin extends Service {
    static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt'];
    constructor(ctx, config = {}) {
        super(ctx, 'sliceAgentLoop');
        const maxParallelToolCalls = resolveMaxParallelToolCalls(config.maxParallelToolCalls);
        const maxStepsPerTurn = resolveMaxStepsPerTurn(config.maxStepsPerTurn);
        guardStockLoopInvariant(ctx);
        // 提示词变量所有权（架构文档：the loop supplies provider/model/cwd）——
        // stock agent-loop/index.ts:312-314 同构；缺了 persona 节的 {{cwd}} 解析不了。
        ctx.systemPrompt.variable('provider', (context) => context.agent?.options.provider);
        ctx.systemPrompt.variable('model', (context) => context.agent?.options.model);
        ctx.systemPrompt.variable('cwd', (context) => context.agent?.session.header.cwd);
        const lifecycle = new SliceAgentLifecycle(ctx, (loopCtx, id, options, session) => new SliceLoopAgent(loopCtx, id, options, session, { maxParallelToolCalls, maxStepsPerTurn }));
        ctx.effect(() => ctx.agents.setFactory(lifecycle), 'sliceLoop.setFactory()');
    }
}
export default SliceLoopPlugin;
