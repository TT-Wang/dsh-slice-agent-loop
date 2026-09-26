# P1-10 native A/B: one teaching site per recall rule

> **Status: DRAFT pre-registration (2026-09-27, build stage).** The harness, arms,
> tasks, metrics and gates below are built and dry-run offline. No paid model call
> has been made. The draft becomes the pre-registration when §13 "Frozen
> parameters" is filled after the pilot and committed before the batch; the pilot
> may still change a task (§5), nothing else. §14 "Results" stays empty until the
> batch and the report exist.

## 1. Question

The plugin teaches the recall tools in two places: the cached prefix (KERNEL in the
system prompt, the fold affordance, the four recall tool definitions) and every
sealed tape entry (the header legend and one `expand_result` locator per tool
line). The P1-10 record found the same rule taught two to four times in the prefix,
a 142-char legend rewritten into every entry, and a 47-char locator repeated on
every tool line. Removing the repeats saves a few percent of cacheRead in long
sessions, but ADR-0001 measured a behaviour cost the last time paid restatements
were removed (same-turn re-reads 10/10 to 25/15), and ADR-0002 notes that the
current native text has never had a baseline.

Hypothesis, as non-inferiority: with each recall rule taught once (arm 1), and
additionally with version-only tool-line locators (arm 2), the model solves the
same tasks, recalls as correctly, re-reads no more, and costs no more than with
today's text (control). n = 3 per task and arm detects large effects only; a pass
means no large regression was seen, not equivalence.

## 2. Arms

| arm | commit | branch | what changes |
|---|---|---|---|
| control | `95d40ce` (origin/main; `src/` and `lib/` byte-identical to `ba12a5b`) | detached | nothing |
| arm 1 | `4fe4389` | `exp/p110-ab-arm1` (from `95d40ce`) | A + C below |
| arm 2 | `147d2d4` | `exp/p110-ab-arm2` (from arm 1) | A + C + F |

Each arm is `npm pack`ed from its own worktree after `npm run check:build`; all three
pass typecheck and 342/342 tests.

| tarball | sha256 |
|---|---|
| `slice-control-95d40ce.tgz` | `0cbf5fc52d65387858d424f8b6931976341aac0bd7f43a543d553f1f6973bc44` |
| `slice-arm1-4fe4389.tgz` | `944ec7e803d26a9a0ed620155944756fc5255c6d85a010f5289e7a87c881f5e2` |
| `slice-arm2-147d2d4.tgz` | `e26d49a82411bc00519ffbf0e67e5c97b63ab6ec96c67df6ae11b780de22f6b2` |

The tarballs differ only in `lib/` and the README twins.

### Exact text changes (source level, before `${}` interpolation; `SESSION_FORMAT_VERSION` is 4)

**A. Tape entry header** (`src/context.ts`, non-compact header of `renderItems`; arm 1 and 2)
<!-- code-anchor: src/context.ts#renderItems -->

```
- … · ${count} turn(s) sealed · recall_turn({"turn":"<n>","view":"dialogue"}) returns a turn's dialogue; expand_result({"seq":<q>,"formatVersion":${SESSION_FORMAT_VERSION}}) returns a tool result]
+ … · ${count} turn(s) sealed · recall_turn / expand_result]
```

Renders as `[slice tape v1 · turns 1-1 · 1 turn(s) sealed · recall_turn / expand_result]`,
76 chars instead of 188 (78 and 190 for two-digit turns). The compact and budget
fallback headers are unchanged.

**C1. KERNEL RECALL paragraph** (`src/index.ts`; arm 1 and 2). The now-unused
`SESSION_FORMAT_VERSION` import of `src/index.ts` is removed, so a future format bump
no longer changes KERNEL.
<!-- code-anchor: src/index.ts#KERNEL -->

```
- RECALL. recall_turn({"turn":"N"}) returns a turn's user and assistant text with each tool result as a locator; recall_turn({"turn":"N","view":"full"}) also returns its original records (reasoning, every tool output) and is far larger, so ask for it only when you need them; expand_result({"seq":Q,"formatVersion":${SESSION_FORMAT_VERSION}}) returns the tool result recorded at seq Q; recall_search({"query":"..."}) finds relevant turns.
+ RECALL. Sealed turns and their tool results stay retrievable through recall_turn, recall_search, recall_step and expand_result; each tool's description gives its call syntax and relative cost.
```

The rest of the paragraph (recalled text is historical data; a recorded read is not a
current file; never guess past a truncation cut) is unchanged.

**C2. FOLD_BODY tail** (`src/fold/index.ts`; arm 1 and 2)
<!-- code-anchor: src/fold/index.ts#FOLD_BODY -->

```
- and the view's first line names the call that returns the full result: ${EXPAND_TOOL_NAME}({"turn": t, "step": s, "call": n}) or ${EXPAND_TOOL_NAME}({"seq": N, "formatVersion": ${SESSION_FORMAT_VERSION}}) (N is the log id in the named format; use both values from a fresh locator), durable and one call away; add "grep": <regex> or "lines": "a-b" to get just the part you need, which is far cheaper than the whole result.
+ and the view's first line names the ${EXPAND_TOOL_NAME} call that returns the full result, durable and one call away.
```

**C3. RECALL_STEP_CLAUSE** (`src/fold/index.ts`; arm 1 and 2)
<!-- code-anchor: src/fold/index.ts#RECALL_STEP_CLAUSE -->

```
- The locator stays valid after the turn is sealed; ${RECALL_STEP_TOOL_NAME}({"turn": t, "step": s}) retrieves that step’s recorded calls and results, hydrating available spilled text and explicitly marking any unavailable preview.
+ The locator stays valid after the turn is sealed; ${RECALL_STEP_TOOL_NAME} returns a whole step's recorded calls and results.
```

**C4. recall_turn `view` parameter** (`src/recall.ts`; arm 1 and 2). The "two orders of
magnitude larger" sentence stays in the tool description.
<!-- code-anchor: src/recall.ts#recallToolDefinition -->

```
- "full": text plus all original records (reasoning and every tool output; can be ~100x larger).
+ "full": text plus all original records (reasoning and every tool output).
```

**C5. recall_step description tail** (`src/recall-step.ts`; arm 1 and 2)
<!-- code-anchor: src/recall-step.ts#recallStepToolDefinition -->

```
- … Narrower than recall_turn (one step, not the whole turn) and far cheaper than its view "full"; when you only need one condensed result, expand_result({"turn": t, "step": s, "call": n}) is cheaper still.
+ … Narrower than recall_turn: one step, not the whole turn.
```

**F. Tape tool line** (`src/context.ts`, `collectItems`; arm 2 only)
<!-- code-anchor: src/context.ts#collectItems -->

```
- [tool turn ${turn} step ${step} seq ${source.seq} · ${name} · ${size} chars · expand_result({"seq":${source.seq},"formatVersion":${SESSION_FORMAT_VERSION}})]
+ [tool turn ${turn} step ${step} seq ${source.seq} · ${name} · ${size} chars · v${SESSION_FORMAT_VERSION}]
```

`seq N` stays in the line and `expand_result`'s `formatVersion` parameter still says
"use 4 from a fresh locator".

Unchanged on purpose: the `recall_search` and `expand_result` definitions (they remain
the syntax sites; their own duplicates are candidates for a later change). The seven
pinned test assertions were rewritten to keep their intent (the prefix still names
`expand_result` and `recall_step`, both tools are in `request.tools`, the grep/lines
advice is asserted on `expand_result`'s own description, the resumed request still
carries the locator of the unshown result), not deleted.

## 3. Composition and parity

- Host: the published DSH 0.1.7-rc.2, frozen as an APFS copy of `~/.dsh-slicey/host`
  (the original is not touched), `headless` app, one process per turn, prompt on
  stdin, `--json` events to a file, cwd = the cell's workdir.
- One DSH_HOME per arm with profile `ab` (bundles `dsh-base`, `dsh-headless`, the
  plugin) and the parity overlay [scripts/ab/profile/eval-parity.patch.yml](../scripts/ab/profile/eval-parity.patch.yml):
  no compaction, command-compact, tool-result pruner, session-title LLM or web tool;
  empty persona prefix and suffix (the headless defaults put `{{model}}` and
  `{{cwd}}` into the system prompt); no subagent, fork or workflow tools (child
  sessions would carry usage outside the parent log); no skill catalog. The model is
  the base default `deepseek-official/deepseek-flash`, effort high; the plugin keeps
  its default `inherit`.
- Per task, one more overlay sets `slice-agent-loop.maxStepsPerTurn`, identical across
  arms.
- `--dump-config` is identical across the three homes (408 lines) once each home's own
  path in the provenance comments is normalized; the plugin package is the only
  difference, and it does not appear in the dump.
- Environment as `~/.dsh-slicey/bin/slicey-dsh`: inherited proxy variables,
  `NODE_USE_ENV_PROXY=1`, `NODE_OPTIONS=--disable-warning=UNDICI-EHPA`. The key is a
  symlink `home-<arm>/.env -> ~/.dsh/.env`, created only after the dry run.

Fingerprints measured in the offline dry run (§11); every real cell must match its arm
(`$AB/fingerprints.json`, copied to `docs/ab/p110-2026-09-27/fingerprints.json`):

| | control | arm 1 | arm 2 |
|---|---|---|---|
| system prompt sha256 | `ba80ae83…` | `1b608b9c…` | `1b608b9c…` |
| slice tool JSON sha256 (canonical JSON of the four recall tools) | `6699b32a…` | `4d9ca4cc…` | `4d9ca4cc…` |
| system prompt chars | 4,779 | 4,181 | 4,181 |
| four recall tools, canonical JSON chars | 5,441 | 5,266 | 5,266 |
| per-request prefix (system + all 19 tools) | 20,575 | 19,802 (−773) | 19,802 (−773) |
| tape header, one-digit turns | 188 | 76 | 76 |
| mean tape tool line in the dry run | 94.4 | 94.4 | 53.3 (−41.1) |
| tools | 19 | 19 | 19 |

The control slice-tool fingerprint equals the one in the two real Raft sessions of the
P1-10 record, which ran the `ba12a5b` build.

## 4. Tasks

Seven gated tasks plus a warmup; files under [scripts/ab/tasks](../scripts/ab/tasks).
Five need recall and two are ordinary coding. In every recall task the fact reaches the
model only as a tool result (user and assistant text stay verbatim on the tape, tool
output does not), and the harness deletes its source between turns (`hooks.py`), so a
correct exam answer requires recall. Oracles never live in the workdir.

| alias | task | turns | step cap | exam | source |
|---|---|---|---|---|---|
| hello | `hello` | 1 | 4 | – | warmup: "Reply with exactly: HELLO"; always passes |
| r1 | `p110_r1_fixture_fp` | 6 | 12 | T5 | dsh-slice `r2b_tool_only`: prompts P1, P2, P6, P10, P11, P12 verbatim; the hook deletes `tools/check_fixtures.py` and `fixtures/` after T2 (replaces r2b's deletion turn). Oracle: `FX-8b69ed6e`; decoys `FX-3c1a9f04`, `FX-8b69ed7a`, `FX-e2d40b91` in the T3/T4 floods. |
| r2 | `p110_r2_superseded_stamp` | 7 | 12 | T6 | dsh-slice `r2d_superseded_fact`: prompts P1, P2, P4, P6, P10, P13, P14; the hook deletes `config/` and `tools/stamp.py` after T4. Current `CFG-8d2e0fac` (T4), stale `CFG-81d29c44` (T2), decoys in the floods; two locators from different turns. |
| r3 | `p110_r3_runbook_middle` | 3 | 12 | T3 | new. A seeded 420-line, 28 KB prose runbook (above the fold's 6000-char threshold, no line structured, code-like or log-like to the digest). T1: read it with the read tool, write the night-shift escalation extension (`64471`, line 180; decoy `64417` in the kept head) to `answers/ext.txt`: in-turn fold recovery, the direct probe of C2. The hook deletes `docs/` after T1; T2 filler (`slugify`); T3: the backup datacenter (`Brackenfold`, line 300; decoy `Aldergate` on the kept last line): cross-turn recall of the T1 read. A cell is valid only if the T1 read was folded. |
| r4 | `p110_r4_probe_compare` | 4 | 12 | T4 | new. `tools/probe.py --region us` (T1) and `--region eu` (T2) print a run id and an 8-endpoint p50/p95 table derived from sha256; never restated; the hook deletes `tools/` after T2; T3 filler (`pct`); T4 writes `shipping,690,291` (highest us p95, then eu). Swapped regions are detected. |
| r5 | `p110_r5_initial_failures` | 2 | 60 | T2 | dsh-tool-result-fold `f3_test_suite_fix`: T1 fixes a red 400-test suite with 5 planted bugs (turn timeout 40 min); T2 lists the tests that failed before any change, only recoverable from T1 tool output. The truth file moved from `<workdir>/.truth/` to `<workdir>.truth.json`. |
| c1 | `lh1_incremental_build` | 8 | 14 | – | sliceagent h2h, copied as is: 8 dependent turns building `calc.py`; cross-turn and post-edit re-reads of the model's own file. |
| c2 | `m3_consistency_bugfix` | 1 | 26 | – | sliceagent h2h, copied as is: one invariant across 4 modules; same-turn re-read and verification behaviour. |

Oracle tokens (for recall sourcing and leak checks): r1 `8b69ed6e`; r2 `8d2e0fac`;
r3 `Brackenfold` (exam) and `64471` (T1, in-turn); r4 the two run ids
`PRB-us-7537d2a4`, `PRB-eu-559cd122` and the two `shipping` table rows; r5 the ten
failing test names. `scripts/ab/selfcheck_tasks.py` shows each oracle failing on the
untouched workdir, passing on a correct end state and naming decoy, stale, swapped and
CANNOT-RECOVER answers (22/22 checks).

## 5. Procedure

1. Offline dry run (done, §11): all tasks x 3 arms x 1 rep with the scripted mock.
2. Link the key; warmup and parity: `hello` x 2 reps x 3 arms, arms concurrent. Every
   arm must show step-1 cacheRead ≥ 4000 in rep 2, 19 tools, matching fingerprints and
   no `/private` or `/Users` in the system prompt.
3. Pilot, control only: r1, r3, r4 x 1 rep. Check oracles, leak and access flags, the
   r3 fold, wall time. If control cannot pass a task at all, fix that task here; this
   is the only point where a task may change. Then fill §13 and commit.
4. Batch: 7 tasks x 3 reps x 3 arms = 63 cells, seed 20260927 (seeded task order per
   rep), the three arms of a (task, rep) pair run concurrently. An invalid cell is
   rerun once; infra reruns are reported separately and never count as behaviour.
5. Report: `ab_report.py` pairs cells by (task, rep), evaluates [gates.json](../scripts/ab/gates.json)
   and writes `summary.json` / `summary.md`; the per-turn cache split is cross-checked
   with dsh-slice `cache-metrics.py`. Arbitration only as in §9.

## 6. Metrics

All from the session log (`ab_metrics.py`), one row per cell.

- **Usage.** Over every `assistant/message`: miss = `inputTokens`, hit =
  `cacheReadTokens`, out = `outputTokens` (the three add up to `totalTokens`; checked
  on the two real sessions); requests; step-1 miss per turn. Cost = miss·Pm + hit·Ph +
  out·Po on both sheets of [scripts/ab/prices.json](../scripts/ab/prices.json). Peak is
  exactly twice off-peak for every field, so ratios do not depend on the sheet.
- **Same-turn repeated reads.** Read-like calls are `read` (line range
  [offset, offset+limit−1], defaults 1 and 2000) and single-file bash reads (`cat`,
  `head`, `tail`, `nl`, `sed -n`, `less`, `more`, optionally after `cd DIR &&`),
  which cover the whole file. Paths are normalized against the session cwd. Mutations
  are `write`/`edit` and bash redirects, `rm`, `mv`, `cp`, `tee`, `touch`, `sed -i`,
  `perl -i` (a directory mutation covers the files below it). Per turn:
  `reread_same_turn_unchanged` = a read of P overlapping a range already read in the
  turn with no mutation of P in between; `reread_same_turn_after_edit` = the first read
  of P after the model's own mutation of P in the turn. Reported only:
  `reread_cross_turn`, `fold_then_reread` (an unchanged re-read after a fold replaced
  an earlier read of P in the turn), repeat-tool reminders, folds.
- **Recall.** Calls, errors and same-turn recoveries per recall tool; formatVersion
  rejections (`expand_result` errors containing "requires formatVersion") and whether a
  later successful call in the turn reached the same target; `expand_result` shapes
  (`seq+fv4`, `seq+fv_other`, `seq`, `turn/step/call`, malformed) and partial
  (`grep`/`lines`) vs full; `recall_turn` views and returned chars.
- **Locator provenance** of each `expand_result`, first match wins: an earlier
  recall_turn/recall_search/recall_step result in the same turn naming the seq; a fold
  view header in the same turn; a tape entry written earlier (both tool-line forms);
  none. Cross-turn = the target result belongs to an earlier turn. First-try success =
  the first call of a turn on a cross-turn target succeeded. Extra hop = the locator
  came from recall_turn/recall_search output although the tape already carried it.
- **Finish.** `turn_end` kinds; closeout = a completed turn whose last assistant message
  has text and no tool call; step-cap cuts = `turn_end` kind `blocked` (exit 1 on
  0.1.7-rc.2).
- **Exams.** Recall-sourced = an oracle token appears in the result of a recall tool
  call within the exam turn; recall-sourced correct = that and `verify` passes. Exam
  answer class from `verify`: correct, decoy, stale, hedged, wrong (including swapped
  regions and a partial failing list), cannot_recover, missing. Leak = an oracle token
  in assistant text or tool input before the exam turn. Flagged access = a bash command
  or path touching `sessions/`, `.zstd`, `.truth`, `session.v4`, a `home-<arm>` or the
  harness.

`ab_metrics.py` reproduces the P1-10 record's counts on the two real V4 sessions
(360/408 requests, 73/95 turns, 72/94 entries, recall_search 8 / recall_turn 1 /
recall_step 1 in raft-1; 14 `expand_result`, all `{seq, formatVersion 4}`, 4 cross-turn
from the tape and 10 from fold views, in raft-2) and the scouting prototype's counts on
its 14 mock logs; `scripts/ab/test_ab_metrics.py` pins both.

## 7. Validity

A cell counts only if: every turn exited 0 or ended with a model-attributable
`turn_end` (the step cap), never a timeout, TRANSPORT, RATE_LIMIT, MISSING_CREDENTIAL
or budget kill; the log was found; the system prompt and slice tool fingerprints equal
the arm's; 19 tools, one tool list and one system prompt for the session; no `/private`
or `/Users` in the system prompt; zero compaction events; tape headers and tool lines
in the arm's form; for arm 1 and arm 2 the per-request prefix at least 700 chars
smaller than control and every tape header 76 or 78 chars; for r3 a fold of the T1
read. Otherwise the cell is rerun, at most 2 attempts. A pair counts only when both its
cells are valid; dropped pairs are listed in the report. A cell with flagged access or a
leak counts for G1 but its pair is dropped from G2.

## 8. Gates

Unit: 7 tasks x 3 reps = 21 paired cells per arm against control; the 15 recall cells
for G2. [scripts/ab/gates.json](../scripts/ab/gates.json) encodes these as data.

- **G1 Task success (non-inferiority).** Σpass(arm) ≥ Σpass(control) − 1 over 21 cells,
  and no task with pass(arm) ≤ pass(control) − 2.
- **G2 Recall correctness** (15 recall cells).
  (a) recall-sourced correct exam answers: arm ≥ control − 1;
  (b) errors on recall_turn, recall_search, recall_step and expand_result, all turns:
  arm ≤ control + 2;
  (c) formatVersion rejections: arm 1 ≤ control + 1; arm 2 ≤ control + 2 and every
  arm 2 rejection recovered in the same turn;
  (d) decoy, stale, hedged, wrong or CANNOT-RECOVER exam answers: arm ≤ control + 1.
- **G3 Same-turn repeated reads.** R = Σ(reread_same_turn_unchanged +
  reread_same_turn_after_edit) over 21 cells; R(arm) ≤ 1.25·R(control) + 2. The
  ADR-0001 failure (+50% to +150%) would be caught. fold_then_reread is reported, not
  gated.
- **G4 Cost.** Median paired cost ratio arm/control ≤ 1.10 and Σcost(arm) ≤
  1.10·Σcost(control); median paired request-count delta ≤ +1 per cell; recall_turn
  view "full" calls ≤ control + 2. Structural conditions are cell validity (§7). The
  expected saving (1–4% of cacheRead) is below what n = 3 resolves: G4 guards against
  behaviour-driven cost increases, and the saving is argued structurally (§3 and the
  P1-10 record).
- **G5 Finish.** Completed turns ending in a text closeout: arm ≥ control − 1. Turns cut
  by maxStepsPerTurn: arm ≤ control + 1.
- **G6 Arm 2 only (locators).** First-try success rate of `expand_result` on cross-turn
  targets ≥ control − 10 percentage points; extra hops ≤ control + 2; G2(c) and G2(d)
  also hold with arm 1 as the baseline.

Pre-declared reading of the gates, where the plan left it implicit:

- Verdicts per check: pass; **arbitrate** when missed by exactly one unit beyond its
  margin (one count; 0.05 of a cost ratio; one request of median delta; one
  cross-turn target of the first-try rate); **fail** when missed by more. A gate
  arbitrates when a check arbitrates and none fails.
- G6 first-try is not evaluable (reported, not blocking) when either side has no
  cross-turn target.
- Exclusions are paired: an invalid or G2-excluded cell drops its (task, rep) pair from
  that comparison on both sides.

## 9. Decision rule and arbitration

- Arm 1 passes G1–G5: ship A + C as one PR. Per the P1-10 record, ride on the next
  release that already changes the prefix, unless the owner accepts one full cache miss
  per session active at deploy (measured 8.7K–59K tokens).
- Arm 2 passes G1–G6: add F to the same PR; otherwise drop F.
- Any gate failed (missed by more than one unit): do not ship that arm. For arm 1 the
  next step would be a split A/B (header only vs prefix only), outside this batch.
- Any gate at "arbitrate": once, +3 reps of the tasks driving the miss, all arms, same
  concurrent pairing; decide on the pooled 6 reps with count margins doubled
  (`ab_report.py --pooled`).
- Counts and paired deltas are reported, not p-values.

## 10. Budget and cost

Hard cap $10 for the whole experiment (warmup, pilot, batch, arbitration), enforced by
`run_ab.py` from usage tokens at the **peak** sheet (miss $0.44/M, hit $0.014/M, out
$1.32/M; the v4-flash sheet in [dsh-plugin-opportunities.md](dsh-plugin-opportunities.md);
that `deepseek-flash` bills on it is an assumption, token counts are authoritative).
One ledger (`$AB/spend.jsonl`) spans every batch. No cell starts within $0.25 of the cap;
running turns are killed, and no turn starts, within $0.15 of it (a step's usage is only
visible when the step ends). Estimate from the plan: about $0.30 per arm-rep at peak,
about $2.7 for the batch, $0.5–1 for warmup, pilot and a possible arbitration.

## 11. Offline dry run (build evidence, 2026-09-27)

Harness commit `5b629af`. No key existed in any home; the mock adapter
(`scripts/ab/mock-llm.mjs`, provider `ab-mock`) scripted bash, two reads of the file the
prompt names, and an `expand_result` on the newest tape tool line, parsing whichever
form the arm renders.

- 8 tasks (7 + hello) x 3 arms x 1 rep = 24 cells, arms concurrent, 61 s: 96/96 turns
  exited 0, 24/24 logs found, 24/24 metrics rows, 24/24 cells valid on the first
  attempt and again when re-validated against the fingerprints computed from them
  (identical to an earlier development run).
- Tape forms per arm as expected (control long/long, arm 1 short/long, arm 2 short/v);
  every mock `expand_result` found its locator on the tape with formatVersion 4 in all
  three arms; the r3 T1 read was folded in every arm.
- Guards, on the same commit: a budget stop inside two concurrent cells (ledger
  $0.00247 under a $0.0025 cap, exit 2) and `--resume` rerunning exactly those cells; a
  mid-turn kill (turn killed after 3 steps, ledger $0.000202 under a $0.00025 cap, exit
  2); a doctored fingerprint file makes cells invalid after 2 attempts; `--offline`
  refuses to start when a home has a `.env`; a turn cut by the step cap ends with
  `blocked` and exit 1.
- `scripts/ab/test_ab_metrics.py` 10/10 (with the 24 mock logs and the two real
  sessions), `scripts/ab/test_ab_report.py` 6/6, `scripts/ab/selfcheck_tasks.py` 22/22.
- Fingerprints and the tarball checksums are in
  [docs/ab/p110-2026-09-27/](ab/p110-2026-09-27/fingerprints.json).

## 12. Risks and limits

- Low power: n = 3 per task and arm; a pass is "no large regression".
- Arm 1 bundles six text changes; a failure cannot be attributed to one of them.
- Arm 2 makes the model combine `seq N` from the line with formatVersion 4 from the
  parameter text; the parameter's "fresh locator" wording may cause extra recall_turn
  hops. G6 measures this.
- External validity: a hermetic headless composition (no subagents, workflows, skills,
  web, host compaction or pruner), one process per turn. Production slicey is a
  long-lived web app with compaction and the 8192-char pruner. Both arms share the
  differences.
- Leaks and shortcuts are flagged, not prevented; flagged pairs leave G2.
- The workdirs of the concurrent arms are siblings; reading another arm's workdir is not
  flagged unless it goes through a flagged path.
- Provider weather (latency, rate limits, cache eviction, peak hours) is controlled by
  running the arms of a pair concurrently and interleaving reps; timestamps are kept.

## 13. Frozen parameters (fill after the pilot, commit before the batch)

- Harness commit: _TBD_
- Arm tarballs: §2 (sha256 above; `SHA256SUMS` next to them)
- Fingerprints: §3, `docs/ab/p110-2026-09-27/fingerprints.json`
- Price sheet: §10; seed: 20260927; reps: 3; `--parallel-arms`; `--budget-usd 10`
- Pilot outcome and any task change: _TBD_

## 14. Results

_Empty until the batch and the report exist._
