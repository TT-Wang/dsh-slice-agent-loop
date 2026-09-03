export declare function _h(text: string): string;
export interface TapeEntryInit {
    kind: string;
    rendered: string;
    path?: string;
    payload?: string;
    noNl?: boolean;
    postHash?: string;
    ref?: string;
    refEnd?: string;
    task?: string;
}
export declare class TapeEntry {
    readonly kind: string;
    readonly rendered: string;
    readonly path: string;
    readonly payload: string;
    readonly noNl: boolean;
    readonly postHash: string;
    readonly ref: string;
    readonly refEnd: string;
    readonly task: string;
    constructor(init: TapeEntryInit);
    toRecord(): Record<string, unknown>;
    static fromRecord(d: Record<string, unknown>): TapeEntry;
}
export declare function renderTapeBase(path: string, body: string): string;
export declare function baseEntry(path: string, body: string): TapeEntry;
/** The TRUE delta of a host-applied edit: unified diff over newline-normalized views (n=1). */
export declare function unifiedPatch(path: string, before: string, after: string): string;
export declare function renderTapePatch(path: string, diff: string, postHash: string, opts?: {
    noNl?: boolean;
}): string;
export declare function patchEntry(path: string, before: string, after: string): TapeEntry;
/** Apply one of OUR deterministic unified diffs (n=1, a/b labels) to `before`'s normalized view. */
export declare function applyUnified(before: string, diffText: string): string;
/** Post-state exact bytes for a base/patch entry (journal replay). */
export declare function composeAfter(entry: TapeEntry, before: string): string;
export declare function renderTapeExternal(path: string, newHash: string, reason: string): string;
export declare function externalEntry(path: string, newHash: string, reason: string): TapeEntry;
export declare const REPLY_CAP_CHARS = 2000;
/** 与 ask 同理:长答复的结论/判定常在结尾,头+尾同预算严格多信息。 */
export declare const REPLY_HEAD_CHARS = 1400;
export declare const REPLY_TAIL_CHARS = 500;
export interface ReplyCaps {
    cap: number;
    head: number;
    tail: number;
}
export declare const DEFAULT_REPLY_CAPS: ReplyCaps;
export declare function renderTapeReply(artifactId: string, text: string, caps?: ReplyCaps): string;
export declare function replyEntry(artifactId: string, text: string, caps?: ReplyCaps): TapeEntry | null;
export declare const REASONING_CAP_CHARS = 4000;
export declare function reasoningEntry(artifactId: string, text: string): TapeEntry | null;
/** THE identity of a finding/knowledge payload: redacted, stripped. */
export declare function canonicalText(text: string): string;
export declare function findingHash(line: string): string;
export declare function knowledgeHash(text: string): string;
export declare function findingEntry(line: string, opts?: {
    task?: string;
}): TapeEntry | null;
export declare function knowledgeEntry(text: string, opts?: {
    task?: string;
}): TapeEntry | null;
export declare function digestEntry(renderedDigest: string, artifactId?: string): TapeEntry;
export declare function tapeRender(tape: readonly TapeEntry[]): string;
export declare function tapeChars(tape: readonly TapeEntry[]): number;
export declare const TAPE_BUDGET_CHARS = 120000;
export interface TapeFileState {
    hash: string;
    content: string;
    /** 自上一次完整基线以来累积的 patch 数(rebaseAfterPatches 用)。 */
    patches?: number;
}
export interface CompactInfo {
    gc_removed: number;
    epoch_folds: number;
}
/** Mutates `tape` in place (like the Python list), exactly as compact_tape does. */
/**
 * 封存时立刻清掉被新 base 取代的文件历史(2026-09-03「开轮更便宜」):种子里每个文件只剩一份现行
 * 基线,模型开轮不必在多份副本里认哪份是当前的。删除会改写它之后的前缀(缓存未命中),所以只在
 * "改写掉的字节 ≤ 该文件新 base 的字节"时做——单文件编码循环里旧 base 后面只有上一轮的回复,几乎
 * 免费;多轮没碰过的文件留给 compactTape 的按预算 GC。返回删掉的条目数。
 */
export declare function gcSupersededFileHistory(tape: TapeEntry[]): number;
export declare function compactTape(tape: TapeEntry[], files: Record<string, TapeFileState>, opts?: {
    budget?: number;
}): CompactInfo;
export declare function reconcileTapeWithDigests(tape: TapeEntry[], digestPairs: readonly (readonly [string, string])[], opts?: {
    lastReply?: readonly [string, string] | null;
}): number;
export type TapeEntryOp = {
    op: "digest";
    rendered: string;
    ref?: string;
} | {
    op: "base";
    path: string;
    body: string;
} | {
    op: "patch";
    path: string;
    before: string;
    after: string;
} | {
    op: "external";
    path: string;
    new_hash: string;
    reason: string;
} | {
    op: "reply";
    artifact_id: string;
    text: string;
} | {
    op: "reasoning";
    artifact_id: string;
    text: string;
} | {
    op: "finding";
    line: string;
    task?: string;
} | {
    op: "knowledge";
    text: string;
    task?: string;
} | {
    op: "epoch";
    rendered: string;
    ref?: string;
    ref_end?: string;
};
export declare function entryFromOp(op: TapeEntryOp): TapeEntry | null;
