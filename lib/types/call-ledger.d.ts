export interface NormalizedUsage {
    /** Fresh (cache-MISS) prompt tokens — bench-ledger `input` convention. */
    input: number;
    /** Cache-HIT prompt tokens — bench-ledger `cacheRead` convention. */
    cacheRead: number;
    /** Completion tokens, reasoning included (provider convention). */
    output: number;
    /** Reasoning tokens out of `output` (0 when the provider does not report). */
    reasoning: number;
}
/**
 * Tolerant reader for the usage shapes seen across DeepSeek's OpenAI-compat
 * API and DSH assemblers: snake_case (`prompt_cache_hit_tokens`) first, then
 * camelCase mirrors, then the generic `prompt_tokens_details.cached_tokens`.
 * Returns undefined when nothing recognizable is present.
 */
export declare function normalizeUsage(u: unknown): NormalizedUsage | undefined;
export interface SeedRecordInput {
    turn: number;
    system: string;
    runtimeContext: string;
    user: string;
}
export interface CallRecordInput {
    turn: number;
    step: number;
    /** 旁路调用标签(规则提取等);主路径调用不带。 */
    side?: string;
    /** 本次响应里的工具调用名(诊断用:哪一步在召回、哪一步在写)。 */
    tools?: string[];
    provider: string;
    model: string;
    usage: unknown;
}
/** Test seam: re-read the env var and lift the failure latch. */
export declare function resetCallLedgerForTest(): void;
/** Record the turn's seed bytes (called once per turn, at seed construction). */
export declare function recordSeedEvent(sessionId: string, seed: SeedRecordInput): void;
/** Record one successful LLM call's usage (skipped calls carry no usage). */
export declare function recordCallEvent(sessionId: string, call: CallRecordInput): void;
