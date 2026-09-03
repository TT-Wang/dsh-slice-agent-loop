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
    /** reasoningEffort 插件默认档(无人显式选择时注入);'inherit' 退出。缺省 'low'。 */
    defaultReasoningEffort?: 'off' | 'low' | 'high' | 'max' | 'inherit';
    /** 轮内封存(提案 2026-09-02)。缺省关闭;A/B 裁决后再定出厂值。 */
    inTurnSeal?: {
        enabled?: boolean;
        sealTokens?: number;
        batchSteps?: number;
        keepSteps?: number;
    };
    /** 'slice'(缺省)或 'state':世界状态循环(提案 2026-09-02)。 */
    mode?: 'slice' | 'state' | 'stream';
    /** v3 追加流的注入时摘要策略。 */
    digest?: {
        enabled?: boolean;
        minChars?: number;
        headLines?: number;
        tailLines?: number;
        maxKeepRatio?: number;
        structuredBlockCap?: number;
        structuredBlockMin?: number;
        logMinChars?: number;
        logMaxErrors?: number;
        logContextLines?: number;
    };
    state?: {
        hotWindowSteps?: number;
        pinSteps?: number;
        pushHits?: number;
        extractRules?: boolean;
        sideEffort?: 'off' | 'low' | 'high' | 'max' | 'inherit';
        contractBounceBudget?: number;
        extractAtStep?: number;
        enforceFromStep?: number;
    };
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
/**
 * 切片贡献登记口 —— loop 对插件开放的第四个报名处（前三个是 DSH 自己的：
 * 提示词段、运行时上下文、工具）。插件在启动时登记一个渲染函数；driver 每轮
 * 把事实包交给每个登记者，非空返回按 order 排好进切片的 PLUGIN CONTEXT 段。
 *
 * loop 永远不认识具体插件：这里只存 {name, order, render}。出场规则（第几轮
 * 出现、看什么条件）写在插件自己的 render 里 —— loop 提供事实，不定政策。
 */
export interface SliceContributionFacts {
    /** 用户这轮的原话。 */
    readonly request: string;
    /** 第几轮（1 起）。 */
    readonly turn: number;
    /** 已经在 tape 上的文件路径。 */
    readonly tapePaths: readonly string[];
    /** 会话工作目录。 */
    readonly cwd: string;
}
export interface SliceContributor {
    readonly name: string;
    /** 段内排序，小的在前。缺省 50。 */
    readonly order?: number;
    /** 返回要塞进切片的文本；空串 = 这轮不出场。报错/超时按空串处理。 */
    render(facts: SliceContributionFacts): string | Promise<string>;
}
export interface SliceContextService {
    /** 登记一个贡献者；返回注销函数（配 ctx.effect 与插件同生共死）。 */
    contribute(entry: SliceContributor): () => void;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        sliceContext: SliceContextService;
    }
}
export declare class SliceLoopPlugin extends Service {
    static inject: string[];
    constructor(ctx: Context, config?: Config);
}
export default SliceLoopPlugin;
