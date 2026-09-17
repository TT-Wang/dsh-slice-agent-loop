# context/tape audit (rebuild) — seal kernel, prefix byte stability, per-seal cost

- **Task:** `task_2773adb4-d623-465e-9898-42e458490dc3`「审计 context/tape 封存内核与 cache 前缀稳定性（重建）」, snapshot commit `62db5ce2f94be74a6bdca2c1376d9e02112fe95f` (workspace `git rev-parse HEAD` = that commit).
- **Why a rebuild:** the previous records for this dimension were produced by an unreachable member and a capture-only replacement, so this report re-derives every measurement with this attempt's own read-only runs (§8). `docs/reviews/2026-09-deep-review.md` was not used as evidence.
- **Method:** a temporary probe harness in this worktree (deleted before submit) driving (a) the real stock `AgentLoop` + `SliceLoopPlugin` through `tests/native-harness.ts` for request-level billing and (b) synthetic in-memory `Session` logs for the seal internals. `node_modules` was supplied by a symlink to the source checkout (the mission worktree has none); no tracked file was touched.
- **Cost口径:** "paid" = code-point count of the JSON projection `system + tools + messages` of one dispatched request (host-only metadata like `message.id` is not sent to the model, so absolute paid counts overstate wire bytes slightly; the prefix/divergence analysis is unaffected). Cache model: the host re-bills from the first changed byte; a hit is cheaper than a miss. Token estimates use chars/4, marked as such.
- **Labels:** `MEASURED` = this attempt's recorded tool run; `INFERRED` = read-only static conclusion from `file:line`.
- **Zero source changes / deliverable note:** the only new path is this report. The declared check `git status --porcelain -- src tests scripts docs package.json tsconfig.json vitest.config.ts` therefore lists exactly `?? docs/reviews/swarm-2026-09-audit-context-tape.md` (workers cannot write git metadata, so an untracked deliverable is the expected state, not a tracked-file modification).

## Findings

| id | finding | severity | label |
|---|---|---|---|
| F1 | prefix stability holds: a seal re-bills only the new entry + that turn's new tail; entries are byte-identical across requests | P1 (core property, confirmed) | MEASURED |
| F2 | `history.entryMaxChars` is a target, not a bound; below the floor every value yields the same entry; above the natural size it changes nothing | P2 (misleading knob) | MEASURED |
| F3 | `keepRecentTurns > 0` costs more re-billed bytes than the default 0 and produces bigger merged entries | P2 (config guidance) | MEASURED |
| F4 | an unpaired tool call keeps its turn raw forever and re-emits an identical warning on every seal | P2/P3 (permanent raw span + log noise) | MEASURED |
| F5 | foreign plugin appends, image user messages and the first-turn pin are never sealed: they stay in every request | P2 (view growth) | MEASURED |
| F6 | every seal rescans the whole log twice and re-hashes every historical read result; cost grows with read-result count | P2 (per-seal CPU) | MEASURED |
| F7 | `recall_search` does not index tool-result text under default kinds; sealed tool text is reachable only via `expand_result`/`recall_turn` full | P3 (reachability nuance) | MEASURED + INFERRED |
| F8 | `src/slice/admission.ts` is imported only by its own test — dead relative to the live plugin | P3 (hygiene) | INFERRED |

### F1 — the seal re-bills only the new entry plus the turn's new tail (confirmed)

Anchor: seal trigger `src/index.ts:167-182` (`if (step === 1) sealCompletedTurns(...)` at `:180`); in-place span replacement `src/context.ts:523-527`; frozen entries `src/context.ts:471`.

MEASURED (probe run `run_bbf95faa`, 6-turn real loop, 5,891-char `read` result each turn, `keepRecentTurns: 0`):

```
req#1 paid=7422 divAt=0 rebilled=7422 entries=0
req#2 paid=7933 divAt=7421 rebilled=512 entries=0
req#3 paid=8179 divAt=7424 rebilled=755 entries=1 entryChars=[395]
req#4 paid=8690 divAt=8178 rebilled=512 entries=1 entryChars=[395]
req#5 paid=8817 divAt=8020 rebilled=797 entries=2 entryChars=[395,469]
...
req#12 paid=11242 divAt=10730 rebilled=512 entries=5
P1 entries byte-identical across consecutive requests = true
P1 sum of re-billed suffixes after req#1 = 7015
```

- A sealing request re-bills the new entry (395–469 chars) plus the new user/tail bytes: 755–797 chars at the seal step, 512 at the in-turn step. The 5,891-char tool result is never re-billed after its turn.
- The prefix before the newly sealed span is untouched: `divAt` for a seal step sits exactly at that span (7,424 / 8,020 / 8,658), and at later turns inside the still-growing entry region.
- The session's first seal necessarily diverges at the start of history (`divAt ≈ 7,421` = end of the fixed prefix): the span starts at history offset 0 because no earlier entry exists. Cost is that one entry, not the conversation.
- SUPPORT: the 7 tape/context spec files re-run green (7 files / 68 tests, run `run_bfee6e39`).

Impact/fix: none — this is the property the module exists to protect. Expected token/cache effect of leaving it alone: steady state ≈ (entry + new tail) at full price per turn, everything older at hit price.

### F2 — `entryMaxChars` is a target, not a bound

Anchor: `src/context.ts:409-433` — the doc comment says "`maxChars` is a target: the smallest level is returned as is when even it does not fit" (`:410-412`), the shrink levels (`:422-427`) and the loop that returns the last rendered text (`:428-433`).

MEASURED (run `run_bbf95faa`, 6 turns × 4 reads × 10,000-char results, `pinFirstTurn: false`):

```
entryMaxChars=400   appends=1 entryChars=[3242] fits=false viewChars=3439
entryMaxChars=1000  appends=1 entryChars=[3242] fits=false viewChars=3439
entryMaxChars=8000  appends=1 entryChars=[7900] fits=true  viewChars=8169
entryMaxChars=100000 appends=1 entryChars=[7900] fits=true viewChars=8169
small span: entry(4000)===entry(8000) = true | chars 2020
```

- Below the floor, 400 and 1,000 produce the **same** entry (3,242 chars) — the smallest shrink level is dominated by per-turn skeleton (header 170, tool pointer lines, read index, reply wrappers), so the knob cannot shrink the entry below that floor.
- Above the natural size, 8,000 and 100,000 produce identical output: the setting only matters inside the shrink band.
- A small span under both 4,000 and 8,000 is byte-identical (`true`), so changing the knob does not perturb prefixes when entries already fit.
- The per-entry caps that create the floor are design: `TOOL_LINES_PER_TURN = 6` (`src/context.ts:68`, used `:402-403`), `READ_INDEX_PER_TURN = 10` (`:72`, used `:379`), reply caps 2,000/1,400/500 (`src/slice/tape.ts:229-235` via `src/context.ts:399`).

Impact: operators may believe the knob bounds a sealed entry; it does not. Fix (minimal): keep the behavior, fix the documentation/config comment to state the floor ("a span of many short turns may exceed it" is already there at `src/context.ts:44-45`, but the floor is not). Expected token/cache effect: no change to bytes; prevents a mistaken "bound" assumption when tuning. If a hard bound were ever wanted, the only honest lever is dropping the read/tool pointer lines, which trades recall for bytes — not recommended (see §7).

### F3 — `keepRecentTurns > 0` re-bills more than the default

Anchor: `src/context.ts:474` (`sealBefore = lastTurn - keepRecentTurns + 1`) and `:507` (only nodes with `turns[1] < before` join a run).

MEASURED (run `run_bbf95faa`, real loop, 5 turns, re-billed suffix summed after request 1):

```
keep=0 rebilled=[0,512,680,512,653,512,653,512,653,512] totalAfterFirst=5199 entriesAtEnd=4
keep=1 rebilled=[0,512,306,512,1496,512,1469,512,1469,512] totalAfterFirst=7300 entriesAtEnd=3
keep=3 rebilled=[0,512,306,512,306,512,306,512,3128,512] totalAfterFirst=6606 entriesAtEnd=1
```

- With `keepRecentTurns > 0` the raw turns ride along (hit-priced) and then seal together into one bigger entry: merged entries 1,469–1,496 (keep=1) and 3,128 (keep=3) vs 653–680 (keep=0). The measured full-price total is 40–71% higher.
- The default 0 is the cheapest measured setting and the one the docs describe.

Impact/fix: keep `keepRecentTurns: 0` (documented default, `src/index.ts:35-37`). Expected token/cache effect: revert to ~5.2K chars of re-billed suffix over 5 turns instead of 6.6–7.3K; no correctness change.

### F4 — unpaired tool call: permanent raw turn + repeated identical warning

Anchor: `src/context.ts:121-136` (`unpairedCalls`), `:487-503` (`flush` cuts the span), `:514` (`warn` per cut), wired at `src/index.ts:175,180`.

MEASURED (run `run_bbf95faa`, turn 1 has a `tool/call` with no result, then 5 completed turns):

```
unpaired: planSeal calls=5 warn calls = 5 | identical = true
unpaired: dangling Q still in view = true | later turns sealed = 5
```

- The warning is rebuilt from a per-call `cuts` map (`src/context.ts:476`) and therefore repeats, byte-identically, on every later seal while the cut persists (5/5).
- The dangling turn's nodes stay raw on the surface forever (its user text is still in the view), while later turns still seal normally. That raw span is a one-time full-price cost that is then re-read at hit price every request — the honest price of not shadowing half a call/result pair.

Impact: log noise per turn; one permanently pinned raw turn. Minimal fix: remember warned cut keys per session (e.g. `WeakMap<Session, Set<string>>`) — do **not** seal the unpaired turn. Expected token/cache effect: warning only (never sent to the model); no byte change.

### F5 — nodes the plugin never seals are pinned in every request

Anchor: `src/context.ts:231-235` (`own` requires `surfaceOp:'append'`, `source.kind === 'user'` and **all-text** content; anything else is `guarded`), `:234` (`pinFirstTurn`), `:218` (`seq > completedThrough || turns[0] < 1`), `:223` (superseded snapshots are archivable).

MEASURED (run `run_95469e8c`, turn 1 = Q1, foreign plugin append, image user message, two runtime snapshots; turn 2 completes the seal):

```
surface = 1:user/message(user#2b0d95[text]) 2:user/message(plugin:foreign-plugin#140732[text]) 3:user/message(user#b90b24[text+image]) 12:user/message(plugin:slice:history#20698a[text]) 5:user/message(plugin:@deepseek-ai/dsh-system-prompt#387052[text]) 13:user/message(plugin:slice:history#ef20f8[text])
view contains: Q1 = true | FOREIGN = true | IMAGE_USER_TEXT = true | SNAP_A = false | SNAP_B = true
image message id preserved in derived view = true | derived content of that message = ["text","image"]
```

- **Foreign plugin append** (a plugin that is not the history projector): raw on the surface and in every derived view; never sealed.
- **Image user message**: raw, both `text` and `image` blocks preserved (`src/context.ts:232` rejects non-text content) — so multimodal turns are pinned, and the pin is what keeps the image available to later requests.
- **First-turn user message**: pinned by `pinFirstTurn: true` (`src/index.ts:36`).
- **Superseded runtime snapshot**: absorbed — `SNAP_A` is gone from the view and the entry carries the note (`[slice note · runtime-context snapshot superseded by a later one; … recall_turn({"turn":"1"})]`, `src/context.ts:361-369,398`); only the newest snapshot (`SNAP_B`) stays raw.

Impact: every pinned node is a stable prefix byte (hit price) but occupies the window for the session's lifetime; a foreign plugin that emits a notice per turn grows the view linearly and the seal kernel cannot reclaim it. Minimal fix: none in the seal rules (widening `own` risks shadowing content with no recall page); the fix belongs to each producer (replace its own notice instead of appending). Expected token/cache effect: none for existing sessions; documents where unbounded growth can come from.

### F6 — per-seal whole-log rescan and read-digest recompute

Anchor: `src/context.ts:181` (`inspectSurface` walks `session.snapshotEvents()`), `:289-312` (`readHistory` walks the whole log and `createHash('sha256')` per read result), `:415` (`readHistory` called unconditionally in `renderCheckpoint`), `:236` (`chars(message)` per surface node).

MEASURED (run `run_bbf95faa`, one turn with N reads of 2,000 chars, then a second turn; counters via a Proxy on the session):

```
reads=0   logEvents=8   snapshotEventsCalls=2 eventsScanned=16   eventAt=8   wallMs=0.17  entryChars=347
reads=50  logEvents=158 snapshotEventsCalls=2 eventsScanned=316  eventAt=208 wallMs=6.56  entryChars=1287
reads=100 logEvents=308 snapshotEventsCalls=2 eventsScanned=616  eventAt=408 wallMs=9.82  entryChars=1287
reads=200 logEvents=608 snapshotEventsCalls=2 eventsScanned=1216 eventAt=808 wallMs=22.53 entryChars=1289
```

- Every seal scans the whole log twice (`inspectSurface` + `readHistory`), even when the sealed run contains no reads, and `eventAt` is called once per event.
- Wall time grows with the number of historical read results (0.17 → 6.56 → 9.82 → 22.53 ms for 0/50/100/200), i.e. with cumulative read count across the session, not just the sealed span: the sha256 of every historical read result is recomputed each time.
- The entry itself stays bounded (≈1,288 chars for 50/100/200 reads) thanks to the 6 tool-line / 10 read-ref caps — the cost is CPU, not tokens.
- Cross-reference (own T3 evidence `evidence_7ab608d8`, not re-measured here): the same path also computes `viewChars`/`historyChars` that the production wiring discards (`src/index.ts:180` drops the return; `requestChars` has no caller).

Impact: latency per seal, ~O(session reads) work repeated every turn. Minimal fix: persist read digests at append time or advance a per-session `lastSeq` watermark in `readHistory`; skip `readHistory` when the run has no read tool calls. Expected token/cache effect: none (CPU only); removes one of the two full scans and the repeated hashing.

### F7 — sealed tool text is reachable, but not through default `recall_search`

Anchor: `src/recall.ts:195-200` (`renderSealedTurn`), `:299-301` (full view `## Original records`), `:381-387` (`searchSessionEvents`), `:74` (`DEFAULT_SEARCH_KINDS = ['user','assistant','context','tool_input','tool_error']` — no `tool_output`); recall-family output is excluded from folding at `src/slice/result-digest.ts:280-281`.

MEASURED (run `run_c85e140e`; turn 1 = user + one `read` result + two snapshots, turn 2 seals):

```
result seq = 4 | entries = 2 chars = 432,362
dialogue chars = 651 | dialogue has expand_result locator = true | dialogue has user/assistant = true true
dialogue has raw result text = false (expected false: locator only)
full view has raw result text = true | full has snapshots = true true
search USER_SENTINEL_1 = t1:user
search SNAP_X = t1:context
search RESULT_T1_R1_SENTINEL = (none)
```

- After sealing, the turn is still served: `recall_turn({"turn":1,"view":"dialogue"})` returns the user/assistant text and the `expand_result({"seq":4})` locator; the full view returns the raw tool text and both superseded snapshots. The entry's note locator resolves.
- Tool-result *text* is not found by `recall_search` with default kinds (measured `(none)`); the reason is INFERRED from `:74` (`tool_output` is not a default kind). The working path is `expand_result`/`recall_turn` full, which is what the entry header and KERNEL teach.
- The scan cost model means the reachable text lives in the append-only log, not in the entry: sealing never destroys it.

Impact: a model that tries `recall_search` for tool output gets nothing and may conclude the content is gone. Minimal fix: add `tool_output` to the default search kinds or state the scope in the recall tool description (counter-consideration: recall family output is deliberately not indexed, `src/recall.ts:53-55`, so scope the change to non-recall tool output). Expected token/cache effect: search hits cost nothing extra per request; it can save one `expand_result` step (each of which re-bills the new tail, measured 512+ chars).

### F8 — `src/slice/admission.ts` is dead relative to the live plugin

Anchor: `src/slice/admission.ts:6` imports `TapeEntry`/`tapeChars`; the only importer is `tests/tape-admission.spec.ts:2` (`grep -rn "admission" src tests` shows no live import; `src/index.ts:3-7` imports context/effort-default/recall/recall-step/fold only).

Impact: no token cost (never loaded); bundle/maintenance weight, and the test suite keeps it alive. Label INFERRED. Minimal fix: move it under `lab/` or delete with its test if the file-tape path is really retired (its siblings in `src/slice/internal/` are used by `tape.ts`, which `context.ts` uses).

## 有意设计、不要改（intentional design, do not change)

1. **Seal only at the first step of the next turn** (`src/index.ts:176-181`) and replace the just-ended span in place (`src/context.ts:523-527`). Sealing mid-turn or later re-bills bytes the turn already paid for.
2. **A sealed entry is never re-rendered, nested or rewritten** (`src/context.ts:7-10,471`) — measured byte-identical across requests (F1).
3. **No request budget and no refusal** (`src/index.ts:47-52`, `src/context.ts:436-447`): a cap means rewriting entries.
4. **Current input, instruction and plugin messages, multimodal user content and the first-turn pin are protected** (`src/context.ts:231-235,234`). Widening `own` would shadow nodes that have no recall page.
5. **The live runtime snapshot is never shadowed** (`src/context.ts:205-211,221-224`); older snapshots collapse into one note line at seal (`:361-369,398`).
6. **An unpaired tool call keeps its turn raw and warns** (`src/context.ts:121-136,487-503`): shadowing half a call/result pair is worse than one raw turn (F4).
7. **The size caps are deliberate**: `TOOL_LINES_PER_TURN=6`, `READ_INDEX_PER_TURN=10`, `USER_HEAD/TAIL=600/300`, reply caps 2,000/1,400/500 (`src/context.ts:66-72`, `src/slice/tape.ts:229-235`). They are what keeps entries bounded regardless of result count (F2/F6) — trim syntax at most, never the pointers.
8. **Read fingerprints are 8 hex chars on purpose** (`src/context.ts:73-74`): a hint, not proof.
9. **Warn goes to `ctx.logger.warn`** (`src/index.ts:175`), never into the request.

## Evidence index and checks

| what | command | run id |
|---|---|---|
| probe (F1–F6, reachability) | `tsx <temp probe>`; real loop via `tests/native-harness.ts` + synthetic `Session`s | `run_bbf95faa` |
| pinned-node surface dump | `tsx <temp probe 2>` | `run_95469e8c` |
| reachability with a sealed read | `tsx <temp probe 3>` | `run_c85e140e` |
| 7 tape/context spec files re-run | `vitest run` with a temp config outside `node_modules` | `run_bfee6e39` (7 files / 68 tests passed) |
| dead-module and cap constants | `grep -rn "admission" src tests`, `sed -n '66,74p;229,250p'`, `grep -n REPLY_*` | `run_d9aa9862`, `run_0478a288` |
| workspace/snapshot check | `git rev-parse HEAD`, `git status --porcelain`, `node --version` | `run_21e8ffc5`, submit-time run |

Declared checks: `git status --porcelain -- src tests scripts docs package.json tsconfig.json vitest.config.ts` → only `?? docs/reviews/swarm-2026-09-audit-context-tape.md` (expected untracked deliverable; git metadata is not writable from the sandbox); `node --version` → v22.22.3. No tracked source/test/script/config file was modified; the temporary probes and the `node_modules` symlink were removed before submission.
