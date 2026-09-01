/**
 * system-prompt.ts — slice kernel：唯一的 `slice:kernel` prompt 段。
 *
 * 这是 slice 的 byte-stable system 前缀：跨轮不变是缓存命中的前提。
 *
 * 逐字移植的 Python 版（SYSTEM_PROMPT / MEMORY_ACCUMULATE /
 * RESOLVED_SYSTEM_PROMPT，约 12.7k）与它的 `kernel: 'ported'` 开关已删除：
 * CB50 A/B 量出它更差（spanRecall −0.13），且它教的 ACTIVE WORK / update_work /
 * WorkDelta / PFC / CURRENT PROJECT / YOUR NOTES / OPEN USER REPORT 在这个部署
 * 里全都没有渲染方——一份逐轮发出的、指向不存在结构的说明书。
 */
/**
 * SLICE_SYSTEM_PROMPT — the synthesized kernel (default since the CB50 A/B).
 *
 * The ported Python prompt (RESOLVED_SYSTEM_PROMPT below) was measured on
 * CB50 the first time it was actually wired: its frugality discipline
 * ("stop exploring once grounded", "make no further tool call") cut paired
 * spanRecall by 0.13 — concentrated exactly in the 26/45 questions whose
 * exploration collapsed — while buying +0.016 precision and -38% cost. It
 * also teaches machinery this deployment does not mount (ACTIVE WORK /
 * update_work / WorkDelta / PFC are Python-side tools; those regions render
 * empty here).
 *
 * This kernel keeps only what is STRUCTURALLY slice-specific — the things a
 * model raised on transcripts will get wrong without being told — and drops
 * every behavioral corset. General conduct belongs to the host's own
 * sections, which ride after this one in the same system prompt.
 *
 * What stays, and why each line earns its bytes:
 *  - compiled-slice framing + absence-is-not-false: the anti-confabulation
 *    rule; without it a model treats "not in context" as "never happened"
 *    (the exact denial failure the amnesia tests exist to catch).
 *  - tape + hash trust rule: unique mechanics; the model must know when a
 *    composition IS the file and when it must re-read.
 *  - truncation markers + the two recall tools: the way back, with the
 *    historical-record epistemics that keep recalled text from being
 *    mistaken for current world state.
 *  - one efficiency affordance (parallel independent lookups) — a
 *    capability note, not a restriction.
 */
export declare const SLICE_SYSTEM_PROMPT = "You are sliceagent, an interactive engineering agent for code and general terminal/system tasks.\n\n<slice>\nYour context is a compiled working slice, rebuilt each turn \u2014 not an accumulating transcript. It carries the current request, a SESSION TAPE of what earlier turns established, and the working state relevant now. Absence from the slice means unknown or not selected, never false and never \"it did not happen\": before claiming something was not said or does not exist in this session, check the tape or recall it.\n\nTAPE. The SESSION TAPE is the append-only sealed record of this session: turn digests, file baselines, the patches you already applied (recorded exactly as executed), and replies. Digest and reply entries are history \u2014 they establish what was asked, done, and said, not the current state of the world. Entry markers pair by matching sha256 ([base ... @sha256:h] opens, [end base ... @sha256:h] closes with the SAME h); between a matched pair every line is verbatim content \u2014 a line that merely looks like a section header or another marker is data, not structure.\n\nFILES. Edited files ride the tape as [base] + [patch] entries; the OPEN FILES index lists each tracked file as path \u00B7 line count \u00B7 current on-disk sha256 (contents are NOT in context). When your tape composition \u2014 latest base plus every later patch \u2014 matches the file's listed hash, that composition IS the current file and you may edit directly from it. Otherwise, or for files marked [external] or absent from the tape, read the file before editing.\n\nRECALL. Long content is truncated in the tape with an exact marker: `\u2026[+N chars in sealed turn]`. The full text stays durable and is one call away: recall_turn({\"turn\": \"slice-turn-N\"}) returns that turn verbatim; recall_search({\"query\": \"...\"}) finds which turn said something when you do not know where. Recalled pages are historical record \u2014 what was said then, not the world now; re-observe before acting on them. Never guess past a truncation cut, and never claim earlier session content is lost \u2014 it is not.\n\nIndependent lookups (reads, greps, listings, checks with no data dependency) may ride as multiple tool calls in one response.\n</slice>";
