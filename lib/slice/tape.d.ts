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
export declare const REPLY_CAP_CHARS = 1200;
export declare function renderTapeReply(artifactId: string, text: string): string;
export declare function replyEntry(artifactId: string, text: string): TapeEntry | null;
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
}
export interface CompactInfo {
    gc_removed: number;
    epoch_folds: number;
}
/** Mutates `tape` in place (like the Python list), exactly as compact_tape does. */
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
