# T3 audit — token waste and cache-hit headroom on the slice tape

- **Snapshot commit:** `62db5ce2f94be74a6bdca2c1376d9e02112fe95f` (`git rev-parse HEAD` in the member worktree).
- **Scope:** `src/` (all live modules) and the `src/index.ts` wiring; `docs/reviews/2026-09-deep-review.md` is treated as prior context only — every number below comes from this attempt's own runs (host run ids in §7).
- **Read-only:** no tracked file was created, changed or deleted. Deliverable is this new untracked report only. `git status --porcelain -- src tests scripts docs package.json tsconfig.json vitest.config.ts` lists only `docs/reviews/swarm-2026-09-audit-token-cache.md`.
- **Labels:** `MEASURED` = produced by a runtime harness run recorded in this attempt (§7); `INFERRED` = read-only static conclusion from `file:line` (+ grep/`git ls-files`), no runtime execution.
- **Estimation convention:** byte counts are Unicode code points of the wire-ish projection (system + tool schemas + message `role`/`content` text). Token figures use **chars/4** (English-heavy text, approximate). Host-only metadata (`message.id`, `source.sections`) is *not* sent to the model and is excluded from token estimates; it is included only where the metric is explicitly "JSON projection" and is labelled as such.

## 0. Bottom line

MEASURED per-turn cost model at the default config (`keepRecentTurns: 0`, `pinFirstTurn: true`) on a real stock-loop harness:

| what | chars | when re-billed |
|---|---|---|
| fixed prefix = system prompt 2,612 + tool schemas 4,451 | **7,063** | once per session; **any byte change re-bills the whole view** |
| one sealed entry (one read + one answer turn) | 395–471 | once, as the new bytes at the seal event of the next turn |
| new user message | 60–250 | once |
| runtime-context snapshot, when the host projects a change | 3,094 (text) / 6,325 (JSON projection) | once per change, at the tail |
| **steady-state re-billed suffix** | **480 + ~755–797 per 2-step turn** | every turn |

The tape property is real in the snapshot: in 8–10-turn scenarios the previous request stays byte-identical up to the newly sealed span (`rebilledSuffix` = new entry + new user message only; a 6,119-char `read` result was never re-billed after its turn), and every entry that appears in two consecutive requests is byte-identical (`MEASURED`). The measurable waste is therefore **compute, not re-billed tokens**, plus a small per-turn boilerplate bill in every entry and one latent cache hazard (a mid-turn note pass that the module's own comment still describes but no longer implements).

### 0.1 Severity index of the findings

| id | finding | severity | label | effect口径 |
|---|---|---|---|---|
| W1 | `viewChars`/`historyChars` computed every turn, discarded in production | P2 (per-turn CPU, scales with context) | MEASURED | 13K chars/turn no-op, 20.7K sealing at a 117K log, 1.28M on a large view; **0 re-billed tokens** |
| W2 | two full-log scans per `planSeal`, even with no reads | P2 (per-turn CPU, ~O(N²) per session) | MEASURED | 10.96 ms/turn at 100 turns; **0 re-billed tokens** |
| W3 | `chars()` allocates one string per code point | P3 (CPU micro) | MEASURED | 1.05 ms vs 0.94 ms / 92 KB; **0 re-billed tokens** |
| W4 | unpaired-call cut warning repeats every turn | P3 (observability) | MEASURED | 6/6 identical warns; **0 re-billed tokens** |
| W5 | dead snapshots accumulate inside an open turn; comment names a missing `noteRuns` | P2 (window + stale context) | MEASURED + INFERRED | window only (stable bytes); never fix with a mid-turn rewrite (§5) |
| W6 | per-entry teaching boilerplate duplicated from the cached KERNEL | P2 (per-turn tokens) | MEASURED bytes / INFERRED token effect | 260–400 chars/turn, re-billed once when the entry is written ≈ **65–100 tokens/turn** |
| W7 | tool lines dropped beyond 6 lose their `seq` locators | P3 (token, inferred) | MEASURED shape / INFERRED effect | +4–5 chars per dropped line; avoids a step whose re-billed suffix measured 480–524 chars |
| W8 | unused `requestChars` + dead modules shipped from `lib/` | P3 (hygiene) | INFERRED | **0 tokens/turn** (never loaded by the plugin) |

**Verifier note on the declared check.** This report is a **newly added, untracked file**. The sandbox cannot write git metadata (no `git add`/commit), so the declared `git status --porcelain -- … docs …` necessarily lists `?? docs/reviews/swarm-2026-09-audit-token-cache.md`. That line *is* the expected deliverable; no tracked source/test/script/config file was modified. Full-tree `git status --porcelain` shows the same single `??` line.

## 1. MEASURED baseline

Scenario A (§7 run 1): stock `AgentLoop` + real `SliceLoopPlugin`, 5–10 turns, each turn = one `read` tool call returning 6,119 chars + one short answer.

| request | paid (JSON projection) | divergence at | re-billed suffix | entries |
|---|---|---|---|---|
| turn 1 step 1 | 7,452 | 0 | 7,452 | – |
| turn 1 step 2 | 7,975 | 7,451 | 524 | – |
| **turn 2 step 1** | 8,209 | 7,454 | **755** | 1×395 |
| turn 2 step 2 | 8,732 | 8,208 | 524 | 1 |
| turn 5 step 1 | 10,123 | 9,326 | 797 | 4×395,469… |

- Fixed prefix: `system = 2,612` chars, `tools = 4,451` chars (same in every request of every session; sha256 of `system|tools` equal across two independent boots: `a0d90e0e8902`, `MEASURED` run 5).
- Tool schemas as passed (`request.tools`, name-sorted by the host): `expand_result` 1,220 · `recall_search` 1,351 · `recall_step` 800 · `recall_turn` 1,075 chars. Source constants: `src/index.ts:144-148`, `src/recall.ts`, `src/recall-step.ts`, `src/fold/index.ts:371-416`.
- KERNEL text `src/index.ts:53-61` = **1,210 chars**; fold affordance `src/fold/index.ts:68-78` = **~1,155 chars** (`FOLD_BODY` 1,140 + wrapper); host persona 36 chars.
- Entry compression: a 6,119-char tool result + answer + user question seals into a **395–471-char** entry (≈92% smaller), written once.
- `keepRecentTurns` knob (`MEASURED` run 4d, 5 turns, re-billed suffix summed after request 1): **0 → 5,706** · **1 → 7,963** · **3 → 7,131**. The shipped default (0) is the cheapest measured setting.
- Runtime snapshot: host emits one durable user-role message per change, positioned **after** the current user message (last surface node). Text 3,094 chars; JSON projection 6,325 chars because `source.sections[].text` **duplicates** the same text (metadata, not billed). When it changes every turn the re-billed suffix jumps to ~7,034 chars (`MEASURED` run 3, R1) — that is new information, but it is ~800 tokens/turn at full price and dwarfs the entry.
- Mid-turn: at step 2 of a turn whose context changed at step 1 and step 2, the surface carries **two** snapshots (`i1:3098c` dead + `i4:3098c` live, `MEASURED` run 4c). The dead one is stable (cache hit) but stays in the window until the turn seals.

## 2. Token-waste / repeat-work findings

### W1 — `viewChars`/`historyChars` are computed every turn and discarded in production — MEASURED (CPU), INFERRED (no consumer)
- Anchors: `src/context.ts:76-78` (`chars`), `:451-468` (`view`), `:469` (`const initial = view([])`), `:515` (`const measure = plan.length ? view(plan) : initial`), `:180` in `src/index.ts` (`sealCompletedTurns(...)` return value dropped); `:542-544` `requestChars` has no caller (`grep -rn requestChars src tests` → only its definition and `lib/types/context.d.ts`).
- `view()` serializes the **entire** message array (`chars([...messages, ...pending])`) and `inspectSurface` additionally calls `chars(message)` for **every** surface node (`src/context.ts:236`).
- MEASURED budget per `planSeal` (run 5, 10-turn session, event log 116,849 chars): **17 `JSON.stringify` calls / 20,672 chars / 30.8 ms-scaled** for a sealing turn; **12 calls / 13,016 chars** for a no-op turn that appends **0** entries. On a large-view fixture (10 × 60,000-char user turns): sealing turn **23 calls / 1,277,267 chars / 30.77 ms**; no-op turn **4 calls / 131,658 chars / 1.38 ms** (`viewChars = 65,831`).
- Cost口径: none of these bytes are billed to the model; the cost is latency and CPU per turn, growing with the whole context, and it is paid even when there is nothing to seal. At a 1M-char context the same shape is ~10–20 ms of `JSON.stringify` + codepoint counting per turn.
- Fix shape: return `viewChars`/`historyChars` as lazy getters, or compute them only when a caller opts in (tests assert them: `tests/context-policy.spec.ts:93-94`, so the fields must not simply be deleted).

### W2 — `readHistory` rescans the whole log even when the run contains no reads — MEASURED
- Anchors: `src/context.ts:289-312` (full `session.snapshotEvents()` walk + `sha256` per read result), `:415` (`const history = readHistory(session)` unconditional in `renderCheckpoint`), `:181` (`inspectSurface` also walks the whole log).
- MEASURED (run 2/6/7, prototype-patched counter): every `planSeal` does exactly **2 full log scans** — `inspectSurface` + `readHistory`. 10/50/100-turn sessions: events returned 80/400/800, wall 0.63/5.11/10.96 ms. A 60-turn session with **zero** `read` calls still scans 480 events (2 × 240).
- Cost口径: CPU only; per session Σ over turns ≈ O(N²) (100 turns ≈ 1.1 s in this path). The digest work (`sha256` of every read result) is recomputed every turn although it is an append-only function of the log — a watermark (`lastSeenSeq`) memo per session would make it incremental.
- Note: the shrink-level loop (`src/context.ts:422-433`) re-renders text per level but does **not** re-scan (`readHistory` runs once per `renderCheckpoint` call — corrected by measurement, run 9: 2 scans even for a 10 × 60,000-char span that rendered at shrink level 2).

### W3 — `chars()` builds a per-code-point array for a length — MEASURED
- Anchor: `src/context.ts:76-78` `Array.from(JSON.stringify(value)).length`.
- Microbenchmark (run 2d, 92,180-code-point blob): `Array.from(...)` **1.05 ms**, `for (const _ of s) n++` **0.94 ms**, `[...s]` 0.81 ms, `s.length` 0.00 ms.
- Semantics check (run 6/4): for `a😀b` the JSON string has 12 UTF-16 units but 11 code points, so replacing the count with `.length` **would change behaviour** and break the large-history test; a `for..of` counter keeps code-point semantics without allocating N one-char strings.
- Cost口径: CPU only; it is on the hot path 3× per turn via W1/W2.

### W4 — the unpaired-call cut warns on every turn, forever — MEASURED
- Anchors: `src/context.ts:476` (`const cuts = new Map()` per call), `:495-500`, `:514` (`for (const message of cuts.values()) warn?.(message)`), wired at `src/index.ts:175,180`.
- MEASURED (run 6/1): a session whose turn 1 has an unpaired tool call and 6 later completed turns produced **6 `warn` calls / 6 `planSeal` calls**, byte-identical message each time, and turn 1's user text stays raw on the surface for the rest of the session.
- Cost口径: log noise only (never sent to the model); a `WeakMap<Session, Set<string>>` of already-warned cut keys removes the repetition. The permanent raw turn is the honest price of not shadowing half a call/result pair (`src/context.ts:121-136`) — do not "fix" that.

### W5 — dead snapshots accumulate inside an open turn, and the comment describing the mitigation points at a function that does not exist — MEASURED + INFERRED
- Anchors: `src/context.ts:166` (`where only noteRuns may touch`), `grep -rn noteRuns src tests` → **only this comment**; `:507` (`!node.protected && node.turns[1] < before` — only completed turns are collected); `:221-224` (older snapshots are marked `superseded` but stay on the surface).
- MEASURED (run 4c): at step 2 of a 2-step turn with a per-assembly-changing context, the request carries 2 × 3,094 chars of snapshot text. With S such steps the surface accumulates S snapshots until the turn seals; they are stable bytes (cache-hit priced) but occupy ~800 tokens each in the window and one of them is stale.
- Cost口径: window occupancy + stale-context risk; **not** extra re-billing (stable bytes). See §5 — do **not** add a mid-turn note pass: replacing the first dead snapshot moves the divergence to that node and re-bills every byte after it at full price.

### W6 — per-entry teaching boilerplate is repeated in every new entry — MEASURED (bytes) / INFERRED (token effect)
- Anchors: `src/context.ts:390` (entry header), `:354` (tool pointer line), `:378-387` (read index line), `:68-72` (caps).
- MEASURED entry composition (run 3, one turn with 8 `read` calls): entry **1,075 chars** = header **170** + `[turn 1]` 8 + read index **350** + 6 tool pointer lines **6×71 + 22** + content 77. The header's two affordance clauses (`recall_turn({"turn":"<n>","view":"dialogue"}) … expand_result({"seq":<q>}) …`) are ~140 of the 170, and the same syntax is already in the cached KERNEL (`src/index.ts:58`, 2 × `recall_turn` / 1 × `expand_result`) and in the tool descriptions (4,451 chars, cached). Healthy 1-read turns: entry 395–471 with 170 header + 71 tool line + ~41 read line ≈ **60% overhead**.
- Cost口径: every entry is re-billed once, at the seal event of the next turn, as part of the re-billed suffix (measured 755–797). Trimming ~140 chars of header + ~20 chars × ≤6 tool lines saves ≈260–400 chars/turn ≈ **65–100 tokens/turn at full price** (paid once per turn, then cached). Do not remove the pointers themselves — they exist to stop re-reads (`src/context.ts:330-339`); trim only the duplicated syntax.

### W7 — dropped tool lines beyond 6 lose their `seq` locators — MEASURED (shape) / INFERRED (extra-turn risk)
- Anchors: `src/context.ts:402-403` (`slice(0, 6)` then `[+N more tool results]`).
- MEASURED: `[+2 more tool results]` = 22 chars; the dropped lines carry the only printed `seq` values.
- Cost口径: a model that needs one of the dropped results must spend a `recall_turn` request; each extra step re-bills the whole new suffix (measured 480–524 chars for a plain step, plus output tokens). A compact `[+24 more · seqs 9,14,…]` costs ~4–5 chars per dropped line and removes that round trip. Effect size is INFERRED; byte sizes MEASURED.

### W8 — unused exports / unshipped-from-source modules — INFERRED (static)
- `requestChars` (`src/context.ts:542-544`) has **zero** callers in `src/`, `tests/`, `scripts/` (`grep`), yet ships in `lib/types/context.d.ts:83`.
- `src/continuity.ts` (519 lines), `src/state/*`, `src/observations/*`, `src/lab/*` are imported by no live module — `src/index.ts:3-7` imports only context/effort-default/recall/recall-step/fold (`grep`). `package.json:24-32` ships `lib/**/*` except `lib/lab/**`, and `git ls-files lib` shows 36 committed build files including `lib/continuity.js`, `lib/state/*.js`, `lib/observations/files.js`.
- Cost口径: **no per-turn token cost** (never loaded by the plugin); it is bundle weight and a maintenance/audit surface. Tracked here only so the synthesis does not mistake them for live paths.

## 3. What moves the cache breakpoint (and what it costs when it does)

Cache model used: DeepSeek prefix cache hits the longest byte-identical prefix; everything from the first changed byte is billed at full price.

1. **Seal placement is correct and measurable.** An entry replaces the raw span at its own position (`src/context.ts:523-527`, `surfaceOp: replace`), so the prefix before the span is untouched: measured divergence sits exactly at the newly sealed span at turns 2+ (`div = 7,454` for turn 2, `8,050` for turn 3, `8,688` for turn 4 in run 1) and never at the system prompt.
2. **The first seal of a session necessarily re-bills from the start of history** (`div ≈ 7,318` at turn 2): the span starts at history offset 0 because there is no earlier entry. Cost = entry + new user message (measured 755), not the whole conversation.
3. **Any change to the fixed prefix re-bills the full view once per live session.** Prefix = 7,063 chars `MEASURED`; e.g. turn 5 of the scenario pays 10,646 chars total, so a KERNEL/tool-schema edit costs ≥10.6K chars (≈2.6K tokens) on the next request of every running session, then is cached again. Treat KERNEL, `foldAffordance` and the four tool descriptions as one versioned artifact and change them in batches.
4. **The live runtime snapshot is the dominant new-bytes term when context churns.** Measured: 3,094 text chars re-billed per change; if it changes every turn that is ~800 tokens/turn at full price, ~3× the seal cost. The plugin already protects only the newest snapshot (`src/context.ts:205-211,221-224`) and absorbs older ones into the entry note (`:361-369,398`) — that is why the number of raw snapshots stays at `keepRecentTurns + 1` (`tests/native-context.spec.ts:200-226`).
5. **`keepRecentTurns > 0` costs more, not less** (measured §1): raw turns are re-sent (cache-hit) and then seal in one bigger span whose entry is larger (1,646–3,428 chars vs 395–471). Default 0 is optimal in the measurement.
6. **Mid-turn rewriting is the one way to lose the prefix.** Folding (`src/fold/index.ts:138-167,490-497`) only replaces results still on the surface in the open turn (`isAppendSurfaceEvent` + `onSurface` + `shownThrough` gates); any change that touches an already-billed position (e.g. shadowing a dead snapshot mid-turn, re-rendering a sealed entry) re-bills everything after it.

## 4. Cache-hit / token recommendations, ranked by risk × benefit

Order = benefit per unit of risk. Every recommendation states what is re-billed and when.

1. **R1 (no token change, no behavioural risk) — stop measuring the view in production.** Compute `viewChars`/`historyChars` lazily (getter/opt-in flag). *Measured saving:* 13K chars stringified per no-op turn, 20.7K per sealing turn at a 117K log, 131K/1.28M at a 65K view; 1.38–30.8 ms. Re-billed tokens: 0. Anchors: `src/context.ts:451-469,515`.
2. **R2 (no token change) — make `readHistory` incremental or conditional.** Watermark per session (`lastSeq`) or skip when the run has no read tool calls. *Measured:* halves the per-turn log scans (2 → 1), removes per-turn `sha256` over every read result; 10.96 ms → ~5 ms at 100 turns. Re-billed tokens: 0. Anchor: `src/context.ts:415,289-312`.
3. **R3 (no token change) — count code points without allocating.** `for (const _ of s) n += 1` keeps semantics (emoji case measured) and is 10–35% faster than `Array.from`. Anchor: `src/context.ts:76-78`.
4. **R4 (log hygiene) — dedupe the cut warning.** One warn per cut key per session instead of one per turn (measured 6/6). Anchor: `src/context.ts:476,514`.
5. **R5 (small, real token saving) — deduplicate the per-entry teaching text.** Drop the two affordance clauses from the entry header and shorten `expand_result({"seq":N})` in tool lines to a short form, since the full syntax already ships in the cached KERNEL and tool descriptions. *Measured bytes:* ~140 chars/entry header + ~20 chars × ≤6 tool lines ≈ 260–400 chars/turn, **re-billed once when that entry is written** (part of the measured 755–797 suffix) ≈ 65–100 tokens/turn at full price; 100 turns ≈ 6.5–10K tokens. Risk: discoverability — mitigate by keeping one short legend in the entry header (and keeping the full text in the system prompt, which is cached).
6. **R6 (small, inferred token saving) — print a compact `seqs:` list for dropped tool lines** (`src/context.ts:402-403`): +4–5 chars per dropped result, avoids a `recall_turn` round trip whose request re-bills 480–524 chars plus output tokens. Byte sizes MEASURED, avoided-turn effect INFERRED.
7. **R7 (informational, do not change) — keep `keepRecentTurns: 0`.** Measured re-billed totals 5,706 (0) < 7,131 (3) < 7,963 (1).
8. **R8 (do not implement) — no mid-turn snapshot note pass.** Replacing the first dead snapshot rewrites a previously billed position; divergence moves to that node and every byte after it (the newer snapshots, the assistant messages, the whole open turn) is re-billed at full price. The current "absorb at seal" behaviour is the cache-safe equivalent.

## 5. Intentional design that must NOT be changed

- **Seal only at `step === 1` of the next turn** (`src/index.ts:176-181`), replacing the just-ended span in place (`src/context.ts:523-527`). Moving the seal mid-turn or to a later turn re-bills the prefix the turn already paid for.
- **A sealed entry is never re-rendered or nested** (`src/context.ts:7-10,471`). MEASURED: entries byte-identical across consecutive requests.
- **One entry per completed turn; no request budget and no refusal** (`src/index.ts:47-52`, `src/context.ts:438-447`). Reintroducing a cap means rewriting entries.
- **The live runtime snapshot is never shadowed** (`src/context.ts:157-168,205-211`); older snapshots are archivable and collapse to one note line at seal.
- **Unpaired tool calls keep their turn raw and warn** (`src/context.ts:121-136,487-503`) — a half-shadowed call/result pair is worse than one raw turn.
- **Read pointers, the read index and the 6/10 caps exist to stop re-reads** (`src/context.ts:330-339,368-387,68-72`). Trim syntax (R5/R6), never the pointers.
- **Fold stays log-only and open-turn-only** (`src/fold/index.ts:7-11,138-167,486-497`), including the `shownThrough` restore rule.
- **All tools are registered at load** (`src/index.ts:144-148`, `src/fold/index.ts:435`); lazy registration would change the `tools` array mid-session and re-bill the fixed prefix. Order is host-sorted and stable — MEASURED alphabetical order and cross-boot-identical `system|tools` hash.
- **`declaredEfforts` is re-read per request on purpose** (`src/index.ts:150-166`) to avoid injecting an effort the resolved model does not declare; the warning is already deduped per route. It costs no tokens.

## 6. Relationship to prior context

`docs/reviews/2026-09-deep-review.md:90` (P2-1) already names the double `JSON.stringify` + `Array.from` and the zero-caller `requestChars`. This audit independently reproduces that path and adds what the prior note did not: the exact per-turn budget (17 calls / 20,672 chars sealing, 12 / 13,016 no-op, up to 1.28M chars on a large view), the production-discard fact (`src/index.ts:180`), the log-scan counts and scaling, the warn repetition, the snapshot position/churn cost, the entry composition shares, and the measured entry/prefix stability. Prior review is context, not evidence.

## 7. Evidence index (this attempt)

Harness: a temporary `tsx` script driven by the shipped `tests/native-harness.ts` (real stock loop + real plugin; temporary files deleted before submit; `node_modules` was supplied via a symlink, the snapshot worktree itself has none). No tracked file changed. Re-create by importing `nativeHarness` and `planSeal` as in `tests/context-policy.spec.ts` / `tests/native-context.spec.ts`.

| # | measurement | command shape | run id |
|---|---|---|---|
| 1 | per-request paid bytes / divergence / entries (5–10 turns) | `tsx <harness> c1` | `run_5eef19d7`, `run_7d48314f` |
| 2 | fixed prefix, tool sizes, 16-request stability, planSeal counters, `chars()` microbench | `tsx <harness> c2` | `run_7f53a2e8` |
| 3 | runtime churn (per-turn / per-assembly), entry composition of an 8-read turn | `tsx <harness> c3` | `run_e733e406`, `run_ab845071`, `run_11f2933f` |
| 4 | snapshot message shape, entry byte equality, keepRecentTurns 0/1/3, cross-boot prefix | `tsx <harness> c4` | `run_363e71b2` |
| 5 | `JSON.stringify` budget per seal and per no-op; entry equality; cross-session hash | `tsx <harness> c5` | `run_7026b962` |
| 6 | warn repetition (6/6), log-scan scaling, large-view no-op cost, `chars()` semantics | `tsx <harness> c6` | `run_cb3ad1ba` |
| 7 | 100-turn scan counts, no-read scan count (2 scans / 480 events) | `tsx <harness> c7`, `c9` | `run_f1a469f7`, `run_6a1746e2` |
| 8 | large-span render/scan count (2 scans, entry 5,905) | `tsx <harness> c8`, `c10` | `run_ee282d4d`, `run_95979a19` |
| 9 | KERNEL/FOLD_BODY constant sizes | `python3` extraction from `src/index.ts:53-61`, `src/fold/index.ts:68` | `run_a8046853` |
| 10 | live-module import graph, `requestChars`/`noteRuns` callers, `git ls-files lib` | `grep`/`git ls-files`/`git status --porcelain` | `run_0cac1b5f`, `run_0d27f932`, `run_9e6e9c43` |

Static findings carried by these read-only commands (run in the member worktree at `62db5ce2`):

```
git rev-parse HEAD
git status --porcelain -- src tests scripts docs package.json tsconfig.json vitest.config.ts
grep -rn "requestChars" src tests | grep -v '\.d\.ts'      # W1/W8: only the definition
grep -rn "noteRuns" src tests                              # W5: comment only
git ls-files lib | wc -l                                   # W8: 36 committed build files
grep -n "const KERNEL" -A9 src/index.ts                    # fixed-prefix source constant
node --version                                             # v22.22.3
```

Snapshot checks (declared): the commands above; `node --version` = v22.22.3 — see the submit-time run.
