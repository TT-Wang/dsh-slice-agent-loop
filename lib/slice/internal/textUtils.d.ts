/** Collapse all runs of whitespace to a single space and strip. null/non-str -> ''. */
export declare function normalizeWs(s: unknown): string;
/** normalizeWs truncated to n code points. */
export declare function oneLine(s: unknown, n?: number): string;
