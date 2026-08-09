/**
 * Python string semantics helpers. JS strings are UTF-16; Python str is a sequence
 * of code points. Every place the engine does len(s) / s[a:b] / s.splitlines() in
 * Python must go through these to stay byte-faithful on non-BMP input.
 */

/** Python len(str): code points, not UTF-16 units. */
export function pylen(s: string): number {
  let n = 0;
  for (const _ch of s) n += 1;
  return n;
}

/** Python s[i:j] (code-point indices; negative indices like Python). */
export function pyslice(s: string, start?: number, end?: number): string {
  const chars = Array.from(s);
  return chars.slice(start, end).join("");
}

/** Python s[i] — single code point at index i. */
export function pychar(s: string, i: number): string {
  const chars = Array.from(s);
  return chars[i] ?? "";
}

/**
 * Python str.splitlines(keepends). Python splits on a wider boundary set than JS:
 * \n \r \r\n \v \f \x1c \x1d \x1e \x85 \u2028 \u2029.
 */
const PY_LINE_BOUNDARY = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;

export function pySplitlines(s: string, keepends = false): string[] {
  const out: string[] = [];
  let last = 0;
  PY_LINE_BOUNDARY.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PY_LINE_BOUNDARY.exec(s)) !== null) {
    const end = m.index + m[0].length;
    out.push(keepends ? s.slice(last, end) : s.slice(last, m.index));
    last = end;
  }
  if (last < s.length) {
    out.push(s.slice(last));
  }
  return out;
}

/** Python str.strip() — strips Python-whitespace from both ends. */
const PY_WS = /[\t\n\v\f\r \x1c\x1d\x1e\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

export function pyStrip(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && PY_WS.test(s[start])) start += 1;
  while (end > start && PY_WS.test(s[end - 1])) end -= 1;
  return s.slice(start, end);
}

/** Python str.strip(chars) — strips any char in `chars` from both ends. */
export function pyStripChars(s: string, chars: string): string {
  const set = new Set(Array.from(chars));
  const arr = Array.from(s);
  let start = 0;
  let end = arr.length;
  while (start < end && set.has(arr[start])) start += 1;
  while (end > start && set.has(arr[end - 1])) end -= 1;
  return arr.slice(start, end).join("");
}

/** Python str.split() with no args: split on whitespace runs, drop empties. */
export function pySplitWS(s: string): string[] {
  const stripped = pyStrip(s);
  if (!stripped) return [];
  return stripped.split(/[\t\n\v\f\r \x1c\x1d\x1e\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/);
}

/**
 * Python repr() of a str — used by every f"{x!r}" interpolation in error messages.
 * Python prefers single quotes; switches to double quotes when the string contains
 * a single quote but no double quote.
 */
export function pyRepr(s: string): string {
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + quote;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return out + quote;
}

/** Python str(bool) — "True" / "False". */
export function pyBool(b: boolean): string {
  return b ? "True" : "False";
}

/** Python sorted() of strings — code-point order (JS default is UTF-16 order; identical inside the BMP). */
export function pySortStrings(items: readonly string[]): string[] {
  const cps = (s: string) => Array.from(s).map((c) => c.codePointAt(0) ?? 0);
  return [...items].sort((a, b) => {
    const ca = cps(a);
    const cb = cps(b);
    for (let i = 0; i < Math.min(ca.length, cb.length); i += 1) {
      if (ca[i] !== cb[i]) return ca[i] - cb[i];
    }
    return ca.length - cb.length;
  });
}

/** Python tuple/list comparison for numeric-string keys: compare element-wise. */
export function cmpStrings(a: string, b: string): number {
  const ca = Array.from(a).map((c) => c.codePointAt(0) ?? 0);
  const cb = Array.from(b).map((c) => c.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(ca.length, cb.length); i += 1) {
    if (ca[i] !== cb[i]) return ca[i] < cb[i] ? -1 : 1;
  }
  if (ca.length === cb.length) return 0;
  return ca.length < cb.length ? -1 : 1;
}

/** Python dict.fromkeys(seq) — dedup preserving first-occurrence order. */
export function pyDedup<T>(items: readonly T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}
