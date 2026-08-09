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

export class SequenceMatcher {
  private readonly a: string[];
  private readonly b: string[];
  private readonly autojunk: boolean;
  private b2j: Map<string, number[]> = new Map();
  private matchingBlocks: Match[] | null = null;

  constructor(a: string[], b: string[], autojunk = true) {
    this.a = a;
    this.b = b;
    this.autojunk = autojunk;
    this.chainB();
  }

  private chainB(): void {
    const b = this.b;
    const b2j = new Map<string, number[]>();
    for (let i = 0; i < b.length; i += 1) {
      const indices = b2j.get(b[i]);
      if (indices) indices.push(i);
      else b2j.set(b[i], [i]);
    }
    // isjunk is None for unified_diff: no junk purge.
    // Purge popular elements that are not junk.
    const n = b.length;
    if (this.autojunk && n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [elt, idxs] of b2j) {
        if (idxs.length > ntest) b2j.delete(elt);
      }
    }
    this.b2j = b2j;
  }

  findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Match {
    const { a, b, b2j } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    const nothing: number[] = [];
    for (let i = alo; i < ahi; i += 1) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i]) ?? nothing) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    // Extend the best by non-junk elements on each end. bjunk is empty when
    // isjunk is None, so the two junk-extension loops in CPython never fire.
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi
           && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize += 1;
    }
    return { a: besti, b: bestj, size: bestsize };
  }

  getMatchingBlocks(): Match[] {
    if (this.matchingBlocks !== null) return this.matchingBlocks;
    const la = this.a.length;
    const lb = this.b.length;
    const queue: Array<[number, number, number, number]> = [[0, la, 0, lb]];
    const matchingBlocks: Match[] = [];
    while (queue.length > 0) {
      const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
      const x = this.findLongestMatch(alo, ahi, blo, bhi);
      const { a: i, b: j, size: k } = x;
      if (k > 0) {
        matchingBlocks.push(x);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    matchingBlocks.sort((m1, m2) => (m1.a - m2.a) || (m1.b - m2.b) || (m1.size - m2.size));
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    const nonAdjacent: Match[] = [];
    for (const { a: i2, b: j2, size: k2 } of matchingBlocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1 > 0) nonAdjacent.push({ a: i1, b: j1, size: k1 });
        i1 = i2;
        j1 = j2;
        k1 = k2;
      }
    }
    if (k1 > 0) nonAdjacent.push({ a: i1, b: j1, size: k1 });
    nonAdjacent.push({ a: la, b: lb, size: 0 });
    this.matchingBlocks = nonAdjacent;
    return nonAdjacent;
  }

  getOpcodes(): Opcode[] {
    const opcodes: Opcode[] = [];
    let i = 0;
    let j = 0;
    for (const { a: ai, b: bj, size } of this.getMatchingBlocks()) {
      let tag: Opcode[0] | "" = "";
      if (i < ai && j < bj) tag = "replace";
      else if (i < ai) tag = "delete";
      else if (j < bj) tag = "insert";
      if (tag) opcodes.push([tag, i, ai, j, bj]);
      i = ai + size;
      j = bj + size;
      if (size > 0) opcodes.push(["equal", ai, i, bj, j]);
    }
    return opcodes;
  }

  getGroupedOpcodes(n = 3): Opcode[][] {
    let codes = this.getOpcodes();
    if (codes.length === 0) codes = [["equal", 0, 1, 0, 1]];
    // Fixup leading and trailing groups if they show no changes.
    if (codes[0][0] === "equal") {
      const [tag, i1, i2, j1, j2] = codes[0];
      codes[0] = [tag, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2];
    }
    if (codes[codes.length - 1][0] === "equal") {
      const [tag, i1, i2, j1, j2] = codes[codes.length - 1];
      codes[codes.length - 1] = [tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)];
    }
    const nn = n + n;
    const groups: Opcode[][] = [];
    let group: Opcode[] = [];
    for (const [tag, i1, i2, j1, j2] of codes) {
      if (tag === "equal" && i2 - i1 > nn) {
        group.push([tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
        groups.push(group);
        group = [[tag, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2]];
        continue;
      }
      group.push([tag, i1, i2, j1, j2]);
    }
    if (group.length > 0 && !(group.length === 1 && group[0][0] === "equal")) {
      groups.push(group);
    }
    return groups;
  }
}

function formatRangeUnified(start: number, stop: number): string {
  // Per the docstring: "the range is displayed starting with 1, and the length
  // is omitted if it is 1; an empty range is displayed as start,0 with start
  // one less than the insertion point."
  let beginning = start + 1;
  const length = stop - start;
  if (length === 1) return `${beginning}`;
  if (length === 0) beginning -= 1;
  return `${beginning},${length}`;
}

/** difflib.unified_diff(a, b, fromfile, tofile, n=n, lineterm="\n") — returns the joined text. */
export function unifiedDiff(
  a: string[],
  b: string[],
  opts: { fromfile?: string; tofile?: string; n?: number; lineterm?: string } = {},
): string {
  const fromfile = opts.fromfile ?? "";
  const tofile = opts.tofile ?? "";
  const n = opts.n ?? 3;
  const lineterm = opts.lineterm ?? "\n";
  const matcher = new SequenceMatcher(a, b);
  const out: string[] = [];
  let started = false;
  for (const group of matcher.getGroupedOpcodes(n)) {
    if (!started) {
      started = true;
      out.push(`--- ${fromfile}${lineterm}`);
      out.push(`+++ ${tofile}${lineterm}`);
    }
    const first = group[0];
    const last = group[group.length - 1];
    const file1Range = formatRangeUnified(first[1], last[2]);
    const file2Range = formatRangeUnified(first[3], last[4]);
    out.push(`@@ -${file1Range} +${file2Range} @@${lineterm}`);
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === "equal") {
        for (const line of a.slice(i1, i2)) out.push(` ${line}`);
        continue;
      }
      if (tag === "replace" || tag === "delete") {
        for (const line of a.slice(i1, i2)) out.push(`-${line}`);
      }
      if (tag === "replace" || tag === "insert") {
        for (const line of b.slice(j1, j2)) out.push(`+${line}`);
      }
    }
  }
  return out.join("");
}
