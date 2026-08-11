/**
 * Python string semantics helpers. JS strings are UTF-16; Python str is a sequence
 * of code points. Every place the engine does len(s) / s[a:b] / s.splitlines() in
 * Python must go through these to stay byte-faithful on non-BMP input.
 */
/** Python len(str): code points, not UTF-16 units. */
export declare function pylen(s: string): number;
/** Python s[i:j] (code-point indices; negative indices like Python). */
export declare function pyslice(s: string, start?: number, end?: number): string;
/** Python s[i] — single code point at index i. */
export declare function pychar(s: string, i: number): string;
export declare function pySplitlines(s: string, keepends?: boolean): string[];
export declare function pyStrip(s: string): string;
/** Python str.strip(chars) — strips any char in `chars` from both ends. */
export declare function pyStripChars(s: string, chars: string): string;
/** Python str.split() with no args: split on whitespace runs, drop empties. */
export declare function pySplitWS(s: string): string[];
/**
 * Python repr() of a str — used by every f"{x!r}" interpolation in error messages.
 * Python prefers single quotes; switches to double quotes when the string contains
 * a single quote but no double quote.
 */
export declare function pyRepr(s: string): string;
/** Python str(bool) — "True" / "False". */
export declare function pyBool(b: boolean): string;
/** Python sorted() of strings — code-point order (JS default is UTF-16 order; identical inside the BMP). */
export declare function pySortStrings(items: readonly string[]): string[];
/** Python tuple/list comparison for numeric-string keys: compare element-wise. */
export declare function cmpStrings(a: string, b: string): number;
/** Python dict.fromkeys(seq) — dedup preserving first-occurrence order. */
export declare function pyDedup<T>(items: readonly T[], key: (t: T) => string): T[];
