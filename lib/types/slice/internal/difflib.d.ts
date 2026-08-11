/**
 * Faithful port of CPython 3.11 difflib SequenceMatcher (isjunk=None) +
 * get_grouped_opcodes + unified_diff. The session tape's patch entries are
 * `difflib.unified_diff(..., fromfile="a", tofile="b", n=1)` output; byte
 * fidelity requires the same matching algorithm including the autojunk
 * popular-element purge (n >= 200, count > n//100 + 1).
 */
interface Match {
    a: number;
    b: number;
    size: number;
}
type Opcode = [tag: "replace" | "delete" | "insert" | "equal", i1: number, i2: number, j1: number, j2: number];
export declare class SequenceMatcher {
    private readonly a;
    private readonly b;
    private readonly autojunk;
    private b2j;
    private matchingBlocks;
    constructor(a: string[], b: string[], autojunk?: boolean);
    private chainB;
    findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Match;
    getMatchingBlocks(): Match[];
    getOpcodes(): Opcode[];
    getGroupedOpcodes(n?: number): Opcode[][];
}
/** difflib.unified_diff(a, b, fromfile, tofile, n=n, lineterm="\n") — returns the joined text. */
export declare function unifiedDiff(a: string[], b: string[], opts?: {
    fromfile?: string;
    tofile?: string;
    n?: number;
    lineterm?: string;
}): string;
export {};
