/**
 * tape.py port — the session tape: typed frozen entries, deterministic renderers,
 * true-diff patches, base+patch composition, and generational compaction.
 * Durability (JSONL journal, hydrate/replay) is host I/O and is deliberately not
 * ported; the pure reconciliation/compaction logic is.
 */
import { createHash } from "node:crypto";
import { unifiedDiff } from "./internal/difflib.js";
import { ValueError } from "./internal/errors.js";
import { redactText } from "./internal/safety.js";
import { pyRepr, pySortStrings, pySplitlines, pyStrip } from "./internal/pytext.js";

export function _h(text: string): string {
  // Python: hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:12].
  // Node's utf8 encode replaces lone surrogates with U+FFFD where Python's
  // "replace" handler emits '?' — a divergence only for lone-surrogate input.
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

const FILE_KINDS = new Set(["base", "patch", "external"]);

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

export class TapeEntry {
  readonly kind: string;
  readonly rendered: string;
  readonly path: string;
  readonly payload: string;
  readonly noNl: boolean;
  readonly postHash: string;
  readonly ref: string;
  readonly refEnd: string;
  readonly task: string;

  constructor(init: TapeEntryInit) {
    this.kind = init.kind;
    this.rendered = init.rendered;
    this.path = init.path ?? "";
    this.payload = init.payload ?? "";
    this.noNl = init.noNl ?? false;
    this.postHash = init.postHash ?? "";
    this.ref = init.ref ?? "";
    this.refEnd = init.refEnd ?? "";
    this.task = init.task ?? "";
  }

  toRecord(): Record<string, unknown> {
    const d: Record<string, unknown> = { kind: this.kind, rendered: this.rendered };
    if (this.path) d.path = this.path;
    if (this.payload) d.payload = this.payload;
    if (this.postHash) d.post_hash = this.postHash;
    if (this.ref) d.ref = this.ref;
    if (this.refEnd) d.ref_end = this.refEnd;
    if (this.task) d.task = this.task;
    if (this.noNl) d.no_nl = true;
    return d;
  }

  static fromRecord(d: Record<string, unknown>): TapeEntry {
    const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
    return new TapeEntry({
      kind: s(d.kind),
      rendered: s(d.rendered),
      path: s(d.path),
      payload: s(d.payload),
      noNl: Boolean(d.no_nl),
      postHash: s(d.post_hash),
      ref: s(d.ref),
      refEnd: s(d.ref_end),
      task: s(d.task),
    });
  }
}

/** Trailing-newline-normalized view used for diffing/rendering; exact bytes stay in payload. */
function _norm(body: string): string {
  return !body || body.endsWith("\n") ? body : body + "\n";
}

function _nlNote(body: string): string {
  return body && !body.endsWith("\n") ? " · no trailing newline" : "";
}

export function renderTapeBase(path: string, body: string): string {
  const lines = pySplitlines(body);
  // 防伪定界:end 标记带与 start 相同的内容 hash。文件内容想伪造闭合标记,
  // 就得把自身 hash 写进决定该 hash 的字节里——不动点,实际不可构造。
  // 配对规则由 kernel 教:配对之内,一切顶格的"结构样"行都是内容。
  const h = _h(body);
  return (
    `[base ${path} @sha256:${h} · ${lines.length} lines${_nlNote(body)}]\n` +
    _norm(body) +
    `[end base ${path} @sha256:${h}]\n`
  );
}

export function baseEntry(path: string, body: string): TapeEntry {
  return new TapeEntry({
    kind: "base",
    rendered: renderTapeBase(path, body),
    path,
    payload: body,
    noNl: body ? !body.endsWith("\n") : false,
    postHash: _h(body),
  });
}

/** The TRUE delta of a host-applied edit: unified diff over newline-normalized views (n=1). */
export function unifiedPatch(path: string, before: string, after: string): string {
  void path; // the entry header names the path once; labels stay constant a/b
  return unifiedDiff(
    pySplitlines(_norm(before), true),
    pySplitlines(_norm(after), true),
    { fromfile: "a", tofile: "b", n: 1 },
  );
}

export function renderTapePatch(path: string, diff: string, postHash: string, opts: { noNl?: boolean } = {}): string {
  const note = opts.noNl ? " · no trailing newline" : "";
  return `[patch ${path} -> @sha256:${postHash}${note}]\n${diff}\n`;
}

export function patchEntry(path: string, before: string, after: string): TapeEntry {
  const diff = unifiedPatch(path, before, after);
  const noNl = after ? !after.endsWith("\n") : false;
  return new TapeEntry({
    kind: "patch",
    rendered: renderTapePatch(path, diff, _h(after), { noNl }),
    path,
    payload: diff,
    noNl,
    postHash: _h(after),
  });
}

/** Apply one of OUR deterministic unified diffs (n=1, a/b labels) to `before`'s normalized view. */
export function applyUnified(before: string, diffText: string): string {
  const src = pySplitlines(_norm(before), true);
  const out: string[] = [];
  let pos = 0;
  const lines = pySplitlines(diffText, true);
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.startsWith("---") || ln.startsWith("+++")) {
      i += 1;
      continue;
    }
    if (ln.startsWith("@@")) {
      let oldStart: number;
      try {
        oldStart = Number.parseInt(ln.split("-", 2)[1].split(",")[0].split(" ")[0], 10);
        if (Number.isNaN(oldStart)) throw new Error("nan");
      } catch (exc) {
        throw new ValueError(`bad hunk header: ${pyRepr(ln)}`);
      }
      // `-0,0` means "insert before line 1" (difflib emits it when the source
      // side of the hunk is empty). Naively subtracting 1 yields -1, and a
      // NEGATIVE index silently corrupts instead of failing: `slice(pos, -1)`
      // drops the last line and the insertion lands mid-file. Clamp to 0.
      //
      // Reachable: this repo's own `unifiedPatch` emits `@@ -0,0 +1 @@` for the
      // empty-source case (harmless there, since `slice(0, -1)` of "" is ""),
      // so the header shape is in-band — only the empty-header/non-empty-source
      // COMBINATION needs an external patch. Clamping makes both correct.
      const hunkPos = Math.max(0, oldStart - 1);
      out.push(...src.slice(pos, hunkPos));
      pos = hunkPos;
      i += 1;
      while (i < lines.length && !lines[i].startsWith("@@")) {
        const h = lines[i];
        if (h.startsWith(" ")) {
          if (pos >= src.length || src[pos] !== h.slice(1)) {
            throw new ValueError(`context mismatch at line ${pos + 1}`);
          }
          out.push(src[pos]);
          pos += 1;
        } else if (h.startsWith("-")) {
          if (pos >= src.length || src[pos] !== h.slice(1)) {
            throw new ValueError(`delete mismatch at line ${pos + 1}`);
          }
          pos += 1;
        } else if (h.startsWith("+")) {
          out.push(h.slice(1));
        } else if (h.trim() === "") {
          // trailing separator inside rendered block
        } else {
          throw new ValueError(`bad hunk line: ${pyRepr(h)}`);
        }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  out.push(...src.slice(pos));
  return out.join("");
}

/** Post-state exact bytes for a base/patch entry (journal replay). */
export function composeAfter(entry: TapeEntry, before: string): string {
  if (entry.kind === "base") return entry.payload;
  let after = applyUnified(before, entry.payload);
  if (entry.noNl && after.endsWith("\n")) after = after.slice(0, -1);
  return after;
}

export function renderTapeExternal(path: string, newHash: string, reason: string): string {
  return (
    `[external ${path} -> @sha256:${newHash} — ${reason}; the entry below re-anchors ` +
    "to the current on-disk truth]\n"
  );
}

export function externalEntry(path: string, newHash: string, reason: string): TapeEntry {
  return new TapeEntry({ kind: "external", rendered: renderTapeExternal(path, newHash, reason), path, postHash: newHash });
}

export const REPLY_CAP_CHARS = 2000;
/** 与 ask 同理:长答复的结论/判定常在结尾,头+尾同预算严格多信息。 */
export const REPLY_HEAD_CHARS = 1400;
export const REPLY_TAIL_CHARS = 500;

export interface ReplyCaps { cap: number; head: number; tail: number }
export const DEFAULT_REPLY_CAPS: ReplyCaps = { cap: REPLY_CAP_CHARS, head: REPLY_HEAD_CHARS, tail: REPLY_TAIL_CHARS };

export function renderTapeReply(artifactId: string, text: string, caps: ReplyCaps = DEFAULT_REPLY_CAPS): string {
  let body = pyStrip(String(text ?? ""));
  const chars = Array.from(body);
  if (chars.length > caps.cap) {
    body = chars.slice(0, caps.head).join("")
      + ` …[+${chars.length - caps.head - caps.tail} chars in sealed turn]… `
      + chars.slice(-caps.tail).join("");
  }
  if (!body) return "";
  const h = _h(body);
  return `[reply ${artifactId} @sha256:${h}]\n${body}\n[end reply @sha256:${h}]\n`;
}

export function replyEntry(artifactId: string, text: string, caps: ReplyCaps = DEFAULT_REPLY_CAPS): TapeEntry | null {
  const rendered = renderTapeReply(artifactId, text, caps);
  return rendered ? new TapeEntry({ kind: "reply", rendered, ref: String(artifactId) }) : null;
}

export const REASONING_CAP_CHARS = 4000;

export function reasoningEntry(artifactId: string, text: string): TapeEntry | null {
  // 20260827 实验:推理链**原样全字节**上带,不截断(用户指令)。动机:量化出的
  // 推理税(slice 每轮重造思考 2-5×)的机制解释是"跨轮不回带旧推理→逐轮重推导";
  // default 靠 transcript 以缓存价回放全部旧推理。本实验给 slice 同等的记忆,
  // tape 只追加所以旧推理走缓存命中价。REASONING_CAP_CHARS 保留导出(index.ts
  // 兼容),不再参与渲染。超预算由 compactTape 的既有折叠机制兜底。
  const body = pyStrip(String(text ?? ""));
  if (!body) return null;
  const rendered =
    `[reasoning ${artifactId} — your own prior thinking, for continuity; ` +
    `not user-visible @sha256:${_h(body)}]\n${body}\n[end reasoning @sha256:${_h(body)}]\n`;
  return new TapeEntry({ kind: "reasoning", rendered, ref: String(artifactId) });
}

// ── P8: findings + knowledge ride the tape ───────────────────────────────────

/** THE identity of a finding/knowledge payload: redacted, stripped. */
export function canonicalText(text: string): string {
  return pyStrip(redactText(String(text ?? "")));
}

export function findingHash(line: string): string {
  return _h(canonicalText(line));
}

export function knowledgeHash(text: string): string {
  return _h(canonicalText(text));
}

export function findingEntry(line: string, opts: { task?: string } = {}): TapeEntry | null {
  const task = opts.task ?? "";
  const body = canonicalText(line);
  if (!body) return null;
  const h = _h(body);
  const label = `[finding @${h}` + (task ? ` · task ${task}]` : "]");
  return new TapeEntry({ kind: "finding", rendered: `${label}\n${body}\n`, postHash: h, task: String(task) });
}

export function knowledgeEntry(text: string, opts: { task?: string } = {}): TapeEntry | null {
  const task = opts.task ?? "";
  const body = canonicalText(text);
  if (!body) return null;
  const label =
    "[knowledge — cross-session candidates recalled for" +
    (task ? ` task ${task}` : " the current task") +
    "; leads, not current-world proof]";
  return new TapeEntry({
    kind: "knowledge",
    postHash: _h(body),
    task: String(task),
    rendered: `${label}\n${body}\n[end knowledge]\n`,
  });
}

export function digestEntry(renderedDigest: string, artifactId = ""): TapeEntry {
  return new TapeEntry({ kind: "digest", rendered: renderedDigest, ref: String(artifactId) });
}

export function tapeRender(tape: readonly TapeEntry[]): string {
  return tape.map((e) => e.rendered).join("");
}

export function tapeChars(tape: readonly TapeEntry[]): number {
  return tape.reduce((acc, e) => acc + Array.from(e.rendered).length, 0);
}

// ── Generational compaction ──────────────────────────────────────────────────

export const TAPE_BUDGET_CHARS = 120_000;
const FOLD_TARGET = 0.7;

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
export function compactTape(
  tape: TapeEntry[],
  files: Record<string, TapeFileState>,
  opts: { budget?: number } = {},
): CompactInfo {
  const budget = opts.budget ?? TAPE_BUDGET_CHARS;
  const info: CompactInfo = { gc_removed: 0, epoch_folds: 0 };
  if (tapeChars(tape) <= budget) return info;
  // pass 1: GC dead file history
  const latestBase = new Map<string, number>();
  tape.forEach((e, i) => {
    if (e.kind === "base") latestBase.set(e.path, i);
  });
  const dead = new Set<number>();
  tape.forEach((e, i) => {
    if (FILE_KINDS.has(e.kind) && latestBase.has(e.path) && i < (latestBase.get(e.path) as number)) {
      dead.add(i);
    }
  });
  if (dead.size > 0) {
    info.gc_removed = dead.size;
    const kept = tape.filter((_e, i) => !dead.has(i));
    tape.length = 0;
    tape.push(...kept);
  }
  // pass 2: ONE fold sized by NET effect
  const total = tapeChars(tape);
  if (total > budget && tape.length > 8) {
    const target = Math.floor(budget * FOLD_TARGET);
    const anchorCost = (path: string): number => {
      const content = files[path]?.content ?? "";
      return Array.from(content).length + 2 * Array.from(path).length + 80;
    };
    const affected = new Set<string>();
    let removed = 0;
    let anchorsCost = 0;
    let extra = 0;
    const postCutByPath = new Map<string, number>();
    for (const e of tape) {
      if (FILE_KINDS.has(e.kind) && e.path) {
        postCutByPath.set(e.path, (postCutByPath.get(e.path) ?? 0) + Array.from(e.rendered).length);
      }
    }
    let bestCut = 0;
    let bestNet = 0;
    for (let cut = 1; cut < tape.length - 3; cut += 1) {
      const e = tape[cut - 1];
      const eLen = Array.from(e.rendered).length;
      removed += eLen;
      if (FILE_KINDS.has(e.kind) && e.path) {
        postCutByPath.set(e.path, (postCutByPath.get(e.path) as number) - eLen);
        if (!affected.has(e.path)) {
          affected.add(e.path);
          anchorsCost += anchorCost(e.path);
          extra += postCutByPath.get(e.path) as number;
        } else {
          extra -= eLen;
        }
      }
      const net = removed + extra - anchorsCost - 200;
      if (net > bestNet) {
        bestCut = cut;
        bestNet = net;
      }
      if (total - net <= target) break;
    }
    if (bestNet <= 0) return info;
    const cut = bestCut;
    const span = tape.slice(0, cut);
    const affectedPaths = pySortStrings([
      ...new Set(span.filter((e) => FILE_KINDS.has(e.kind) && e.path).map((e) => e.path)),
    ]);
    const anchors = affectedPaths.filter((p) => p in files).map((p) => baseEntry(p, files[p].content));
    const foldedHistory = span.filter((e) => !(FILE_KINDS.has(e.kind) && affectedPaths.includes(e.path))).length;
    const refs = span.filter((e) => e.kind === "digest" && e.ref).map((e) => e.ref);
    let first = refs.length > 0 ? refs[0] : "start";
    if (span.length > 0 && span[0].kind === "epoch" && span[0].ref) {
      first = span[0].ref;
    }
    const last = refs.length > 0 ? refs[refs.length - 1] : "…";
    const marker = new TapeEntry({
      kind: "epoch",
      ref: first,
      refEnd: refs.length > 0 ? last : first,
      // 指向真工具，不是 @sliceagent/ 命名空间——那个路径 DSH 里没有任何东西
      // 服务它（docs/modification-spec.md 记着它造成的 20 步搜索螺旋）。这条
      // 之前保留 Python 拼写是因为 golden 套件逐字节钉住它；套件已随旧 schema
      // 退役，约束消失。折叠掉的轮次按 turn id 仍可逐字取回。
      rendered:
        `[epoch compacted: ${first}..${last} — ${foldedHistory} history entries ` +
        "removed; re-anchored files follow as fresh bases. Any folded turn is still " +
        'readable verbatim: recall_turn({"turn": "<id>"}), or recall_search({"query": "..."}) ' +
        "when you do not know which turn]\n",
    });
    const keepTail = tape.slice(cut).filter((e) => !(FILE_KINDS.has(e.kind) && affectedPaths.includes(e.path)));
    tape.length = 0;
    tape.push(marker, ...anchors, ...keepTail);
    info.epoch_folds += 1;
  }
  return info;
}

// ── Hydration-time digest reconciliation (pure; journal I/O not ported) ──────

export function reconcileTapeWithDigests(
  tape: TapeEntry[],
  digestPairs: readonly (readonly [string, string])[],
  opts: { lastReply?: readonly [string, string] | null } = {},
): number {
  const lastReply = opts.lastReply ?? null;
  const refs = new Set(tape.filter((e) => e.kind === "digest" && e.ref).map((e) => e.ref));
  const hasEpoch = tape.some((e) => e.kind === "epoch");
  let added = 0;
  const seen: number[] = [];
  digestPairs.forEach(([aid], i) => {
    if (refs.has(aid)) seen.push(i);
  });
  let epochEnd = "";
  for (const e of tape) {
    if (e.kind === "epoch" && e.refEnd) epochEnd = e.refEnd;
  }
  if (hasEpoch) {
    let start: number;
    if (seen.length > 0) {
      start = seen[seen.length - 1] + 1;
    } else if (epochEnd) {
      const idx: number[] = [];
      digestPairs.forEach(([aid], i) => {
        if (aid === epochEnd) idx.push(i);
      });
      start = idx.length > 0 ? idx[idx.length - 1] + 1 : digestPairs.length;
    } else {
      start = digestPairs.length;
    }
    for (const [aid, digest] of digestPairs.slice(start)) {
      if (!refs.has(aid)) {
        tape.push(digestEntry(digest, aid));
        added += 1;
      }
    }
  } else if (seen.length === 0) {
    const fresh = digestPairs.filter(([aid]) => !refs.has(aid)).map(([aid, d]) => digestEntry(d, aid));
    tape.unshift(...fresh);
    added += fresh.length;
  } else {
    const first = seen[0];
    const last = seen[seen.length - 1];
    const prepend = digestPairs.slice(0, first).filter(([aid]) => !refs.has(aid)).map(([aid, d]) => digestEntry(d, aid));
    tape.unshift(...prepend);
    added += prepend.length;
    for (const [aid, digest] of digestPairs.slice(last + 1)) {
      if (!refs.has(aid)) {
        tape.push(digestEntry(digest, aid));
        added += 1;
      }
    }
  }
  if (lastReply) {
    const [aid, text] = lastReply;
    const hasReply = tape.some((e) => e.kind === "reply" && e.ref === String(aid));
    if (!hasReply && pyStrip(String(text ?? ""))) {
      const rep = replyEntry(String(aid), String(text));
      if (rep !== null) {
        tape.push(rep);
        added += 1;
      }
    }
  }
  return added;
}

// ── Fixture-side entry construction (mirrors gen_goldens.build_entry) ────────

export type TapeEntryOp =
  | { op: "digest"; rendered: string; ref?: string }
  | { op: "base"; path: string; body: string }
  | { op: "patch"; path: string; before: string; after: string }
  | { op: "external"; path: string; new_hash: string; reason: string }
  | { op: "reply"; artifact_id: string; text: string }
  | { op: "reasoning"; artifact_id: string; text: string }
  | { op: "finding"; line: string; task?: string }
  | { op: "knowledge"; text: string; task?: string }
  | { op: "epoch"; rendered: string; ref?: string; ref_end?: string };

export function entryFromOp(op: TapeEntryOp): TapeEntry | null {
  switch (op.op) {
    case "digest":
      return digestEntry(op.rendered, op.ref ?? "");
    case "base":
      return baseEntry(op.path, op.body);
    case "patch":
      return patchEntry(op.path, op.before, op.after);
    case "external":
      return externalEntry(op.path, op.new_hash, op.reason);
    case "reply":
      return replyEntry(op.artifact_id, op.text);
    case "reasoning":
      return reasoningEntry(op.artifact_id, op.text);
    case "finding":
      return findingEntry(op.line, { task: op.task ?? "" });
    case "knowledge":
      return knowledgeEntry(op.text, { task: op.task ?? "" });
    case "epoch":
      return new TapeEntry({ kind: "epoch", rendered: op.rendered, ref: op.ref ?? "", refEnd: op.ref_end ?? "" });
  }
}
