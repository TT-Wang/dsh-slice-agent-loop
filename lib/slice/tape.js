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
export function _h(text) {
    // Python: hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:12].
    // Node's utf8 encode replaces lone surrogates with U+FFFD where Python's
    // "replace" handler emits '?' — a divergence only for lone-surrogate input.
    return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}
const FILE_KINDS = new Set(["base", "patch", "external"]);
export class TapeEntry {
    kind;
    rendered;
    path;
    payload;
    noNl;
    postHash;
    ref;
    refEnd;
    task;
    constructor(init) {
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
    toRecord() {
        const d = { kind: this.kind, rendered: this.rendered };
        if (this.path)
            d.path = this.path;
        if (this.payload)
            d.payload = this.payload;
        if (this.postHash)
            d.post_hash = this.postHash;
        if (this.ref)
            d.ref = this.ref;
        if (this.refEnd)
            d.ref_end = this.refEnd;
        if (this.task)
            d.task = this.task;
        if (this.noNl)
            d.no_nl = true;
        return d;
    }
    static fromRecord(d) {
        const s = (v) => (v === null || v === undefined ? "" : String(v));
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
function _norm(body) {
    return !body || body.endsWith("\n") ? body : body + "\n";
}
function _nlNote(body) {
    return body && !body.endsWith("\n") ? " · no trailing newline" : "";
}
export function renderTapeBase(path, body) {
    const lines = pySplitlines(body);
    return (`[base ${path} @sha256:${_h(body)} · ${lines.length} lines${_nlNote(body)}]\n` +
        _norm(body) +
        `[end base ${path}]\n`);
}
export function baseEntry(path, body) {
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
export function unifiedPatch(path, before, after) {
    void path; // the entry header names the path once; labels stay constant a/b
    return unifiedDiff(pySplitlines(_norm(before), true), pySplitlines(_norm(after), true), { fromfile: "a", tofile: "b", n: 1 });
}
export function renderTapePatch(path, diff, postHash, opts = {}) {
    const note = opts.noNl ? " · no trailing newline" : "";
    return `[patch ${path} -> @sha256:${postHash}${note}]\n${diff}\n`;
}
export function patchEntry(path, before, after) {
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
export function applyUnified(before, diffText) {
    const src = pySplitlines(_norm(before), true);
    const out = [];
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
            let oldStart;
            try {
                oldStart = Number.parseInt(ln.split("-", 2)[1].split(",")[0].split(" ")[0], 10);
                if (Number.isNaN(oldStart))
                    throw new Error("nan");
            }
            catch (exc) {
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
                }
                else if (h.startsWith("-")) {
                    if (pos >= src.length || src[pos] !== h.slice(1)) {
                        throw new ValueError(`delete mismatch at line ${pos + 1}`);
                    }
                    pos += 1;
                }
                else if (h.startsWith("+")) {
                    out.push(h.slice(1));
                }
                else if (h.trim() === "") {
                    // trailing separator inside rendered block
                }
                else {
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
export function composeAfter(entry, before) {
    if (entry.kind === "base")
        return entry.payload;
    let after = applyUnified(before, entry.payload);
    if (entry.noNl && after.endsWith("\n"))
        after = after.slice(0, -1);
    return after;
}
export function renderTapeExternal(path, newHash, reason) {
    return (`[external ${path} -> @sha256:${newHash} — ${reason}; the entry below re-anchors ` +
        "to the current on-disk truth]\n");
}
export function externalEntry(path, newHash, reason) {
    return new TapeEntry({ kind: "external", rendered: renderTapeExternal(path, newHash, reason), path, postHash: newHash });
}
export const REPLY_CAP_CHARS = 1200;
export function renderTapeReply(artifactId, text) {
    let body = pyStrip(String(text ?? ""));
    const chars = Array.from(body);
    if (chars.length > REPLY_CAP_CHARS) {
        body = chars.slice(0, REPLY_CAP_CHARS).join("") + ` …[+${chars.length - REPLY_CAP_CHARS} chars in sealed turn]`;
    }
    return body ? `[reply ${artifactId}]\n${body}\n[end reply]\n` : "";
}
export function replyEntry(artifactId, text) {
    const rendered = renderTapeReply(artifactId, text);
    return rendered ? new TapeEntry({ kind: "reply", rendered, ref: String(artifactId) }) : null;
}
export const REASONING_CAP_CHARS = 4000;
export function reasoningEntry(artifactId, text) {
    let body = pyStrip(String(text ?? ""));
    if (!body)
        return null;
    if (Array.from(body).length > REASONING_CAP_CHARS) {
        body = "…" + Array.from(body).slice(-REASONING_CAP_CHARS).join("");
    }
    const rendered = `[reasoning ${artifactId} — your own prior thinking, for continuity; ` +
        `not user-visible]\n${body}\n[end reasoning]\n`;
    return new TapeEntry({ kind: "reasoning", rendered, ref: String(artifactId) });
}
// ── P8: findings + knowledge ride the tape ───────────────────────────────────
/** THE identity of a finding/knowledge payload: redacted, stripped. */
export function canonicalText(text) {
    return pyStrip(redactText(String(text ?? "")));
}
export function findingHash(line) {
    return _h(canonicalText(line));
}
export function knowledgeHash(text) {
    return _h(canonicalText(text));
}
export function findingEntry(line, opts = {}) {
    const task = opts.task ?? "";
    const body = canonicalText(line);
    if (!body)
        return null;
    const h = _h(body);
    const label = `[finding @${h}` + (task ? ` · task ${task}]` : "]");
    return new TapeEntry({ kind: "finding", rendered: `${label}\n${body}\n`, postHash: h, task: String(task) });
}
export function knowledgeEntry(text, opts = {}) {
    const task = opts.task ?? "";
    const body = canonicalText(text);
    if (!body)
        return null;
    const label = "[knowledge — cross-session candidates recalled for" +
        (task ? ` task ${task}` : " the current task") +
        "; leads, not current-world proof]";
    return new TapeEntry({
        kind: "knowledge",
        postHash: _h(body),
        task: String(task),
        rendered: `${label}\n${body}\n[end knowledge]\n`,
    });
}
export function digestEntry(renderedDigest, artifactId = "") {
    return new TapeEntry({ kind: "digest", rendered: renderedDigest, ref: String(artifactId) });
}
export function tapeRender(tape) {
    return tape.map((e) => e.rendered).join("");
}
export function tapeChars(tape) {
    return tape.reduce((acc, e) => acc + Array.from(e.rendered).length, 0);
}
// ── Generational compaction ──────────────────────────────────────────────────
export const TAPE_BUDGET_CHARS = 120_000;
const FOLD_TARGET = 0.7;
/** Mutates `tape` in place (like the Python list), exactly as compact_tape does. */
export function compactTape(tape, files, opts = {}) {
    const budget = opts.budget ?? TAPE_BUDGET_CHARS;
    const info = { gc_removed: 0, epoch_folds: 0 };
    if (tapeChars(tape) <= budget)
        return info;
    // pass 1: GC dead file history
    const latestBase = new Map();
    tape.forEach((e, i) => {
        if (e.kind === "base")
            latestBase.set(e.path, i);
    });
    const dead = new Set();
    tape.forEach((e, i) => {
        if (FILE_KINDS.has(e.kind) && latestBase.has(e.path) && i < latestBase.get(e.path)) {
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
        const anchorCost = (path) => {
            const content = files[path]?.content ?? "";
            return Array.from(content).length + 2 * Array.from(path).length + 80;
        };
        const affected = new Set();
        let removed = 0;
        let anchorsCost = 0;
        let extra = 0;
        const postCutByPath = new Map();
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
                postCutByPath.set(e.path, postCutByPath.get(e.path) - eLen);
                if (!affected.has(e.path)) {
                    affected.add(e.path);
                    anchorsCost += anchorCost(e.path);
                    extra += postCutByPath.get(e.path);
                }
                else {
                    extra -= eLen;
                }
            }
            const net = removed + extra - anchorsCost - 200;
            if (net > bestNet) {
                bestCut = cut;
                bestNet = net;
            }
            if (total - net <= target)
                break;
        }
        if (bestNet <= 0)
            return info;
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
            rendered: `[epoch compacted: ${first}..${last} — ${foldedHistory} history entries ` +
                "removed; re-anchored files follow as fresh bases; the full sealed record " +
                'remains readable via read_file("@sliceagent/history/index.md")]\n',
        });
        const keepTail = tape.slice(cut).filter((e) => !(FILE_KINDS.has(e.kind) && affectedPaths.includes(e.path)));
        tape.length = 0;
        tape.push(marker, ...anchors, ...keepTail);
        info.epoch_folds += 1;
    }
    return info;
}
// ── Hydration-time digest reconciliation (pure; journal I/O not ported) ──────
export function reconcileTapeWithDigests(tape, digestPairs, opts = {}) {
    const lastReply = opts.lastReply ?? null;
    const refs = new Set(tape.filter((e) => e.kind === "digest" && e.ref).map((e) => e.ref));
    const hasEpoch = tape.some((e) => e.kind === "epoch");
    let added = 0;
    const seen = [];
    digestPairs.forEach(([aid], i) => {
        if (refs.has(aid))
            seen.push(i);
    });
    let epochEnd = "";
    for (const e of tape) {
        if (e.kind === "epoch" && e.refEnd)
            epochEnd = e.refEnd;
    }
    if (hasEpoch) {
        let start;
        if (seen.length > 0) {
            start = seen[seen.length - 1] + 1;
        }
        else if (epochEnd) {
            const idx = [];
            digestPairs.forEach(([aid], i) => {
                if (aid === epochEnd)
                    idx.push(i);
            });
            start = idx.length > 0 ? idx[idx.length - 1] + 1 : digestPairs.length;
        }
        else {
            start = digestPairs.length;
        }
        for (const [aid, digest] of digestPairs.slice(start)) {
            if (!refs.has(aid)) {
                tape.push(digestEntry(digest, aid));
                added += 1;
            }
        }
    }
    else if (seen.length === 0) {
        const fresh = digestPairs.filter(([aid]) => !refs.has(aid)).map(([aid, d]) => digestEntry(d, aid));
        tape.unshift(...fresh);
        added += fresh.length;
    }
    else {
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
export function entryFromOp(op) {
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
