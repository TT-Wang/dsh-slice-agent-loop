import type { NormalizedUsage } from '../call-ledger.js';
export interface SeedRecord {
    turn: number;
    system: string;
    runtimeContext: string;
    user: string;
}
export interface CallRecord {
    turn: number;
    step: number;
    norm?: NormalizedUsage;
}
/** DeepSeek prefix cache granularity: 64-token blocks. */
export declare const BLOCK_TOKENS = 64;
/** 实测(20260901,两场景 27 轮界):线性自校准后健康轮界的残差散布 ±3 块
 *  (CJK/ASCII 混合比逐轮波动的估算噪音);关注的漂移事件是 +100 块量级。
 *  默认 4 块 = 噪音之上、信号之下。 */
export declare const DEFAULT_TOLERANCE_BLOCKS = 4;
export declare function commonPrefixLen(a: string, b: string): number;
/** Zone label at a char offset of a slice user text: the last zone whose
 *  header starts at or before the offset; 'preamble' before every header. */
export declare function zoneAt(user: string, offset: number): string;
export type DivergenceField = 'system' | 'runtime-context' | 'user' | 'none';
export interface Divergence {
    field: DivergenceField;
    /** First differing char offset within `field`. */
    offset: number;
    /** Zone label (meaningful when field === 'user'). */
    zone: string;
    /** Client-side estimate of the fresh bytes this boundary re-sends:
     *  everything from the divergence point to the end of NEXT's head. */
    freshChars: number;
}
export declare function findDivergence(prev: SeedRecord, next: SeedRecord): Divergence;
/** End offset (exclusive, trailing separator newlines stripped) of the tape
 *  section's sealed CONTENT in a slice user text, or -1 when no tape section
 *  is present. A healthy append-only boundary diverges at or after this
 *  offset (the new entry lands where the old section separator sat); any
 *  divergence before it means sealed bytes changed. The section is bounded by
 *  the next zone header present, or the closing '</context>' fence when the
 *  tape is the last (or only) section. */
export declare function tapeContentEnd(user: string): number;
export type Verdict = 'ok' | 'suspect-size' | 'tape-drift' | 'system-drift' | 'runtime-context-volatile';
export interface BoundaryReport {
    turn: number;
    prevTurn: number;
    divergence: Divergence;
    expectedMissTokens: number;
    /** Server-reported fresh tokens of this turn's first call; undefined when
     *  the sidecar has no usage for it. */
    actualMissTokens?: number;
    /** (actual − expected) in 64-token blocks; 0 when actual is unknown. */
    deltaBlocks: number;
    verdict: Verdict;
}
export interface AnalysisTotals {
    input: number;
    cacheRead: number;
    output: number;
    reasoning: number;
    hitRate: number;
}
export interface Analysis {
    boundaries: BoundaryReport[];
    charsPerToken: number;
    calibratedTurns: number;
    /** Self-calibrated fixed per-first-call overhead (tokens) the client-side
     *  byte diff cannot see — median(actual − expected) over healthy user-field
     *  boundaries, clamped at 0. Real data 20260901: ≈350 tokens, consistent
     *  across scenarios; verdicts compare against expected + envelope. */
    envelopeTokens: number;
    totals: AnalysisTotals;
}
/** chars-per-token from the sidecar itself: head chars vs first-call prompt
 *  tokens, summed over turns where both sides are known. */
export declare function calibrateCharsPerToken(seeds: readonly SeedRecord[], calls: readonly CallRecord[]): {
    charsPerToken: number;
    calibratedTurns: number;
};
export interface AnalyzeOptions {
    toleranceBlocks?: number;
}
export declare function analyze(seedsIn: readonly SeedRecord[], calls: readonly CallRecord[], options?: AnalyzeOptions): Analysis;
