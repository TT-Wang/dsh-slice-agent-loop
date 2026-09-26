# P1-10 native A/B: one teaching site per recall rule

> **Status: PRE-REGISTRATION, frozen 2026-09-27 before the batch.** The harness, arms,
> tasks, metrics and gates below were built and dry-run offline, revised before any paid
> call (§15), then checked by a paid warmup and a control-only pilot. The pilot changed
> the delivery prompts of r1, r2 and r4 and the T1 prompt of r5, added the delivery
> validity rule and the r5 write-leak exception, and fixed one access-flag false
> positive; §13 records the pilot, every change and the frozen parameters. Nothing
> below changes after this commit. §14 "Results" stays empty until the batch and the
> report exist.
>
> **Results added 2026-09-27 (§14).** The batch and the single arbitration batch ran as
> pre-registered. Pooled over 6 reps, every gate passes for both arms (arm 1 G1–G5, arm 2
> G1–G6), so the pre-registered decision is to ship A + C and add F. Sections 1–13 and
> 15 are unchanged since the pre-registration commit `f70d584`.

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
| control | `95d40ce` (origin/main when the arms were built; `src/` and `lib/` byte-identical to `ba12a5b`; origin/main has since moved to `8241118`, a docs-only merge) | detached | nothing |
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
  sessions would carry usage outside the parent log); no skill catalog; no goal tools and
  no goal-round driver (a `create_goal` call would let the driver start extra turns inside
  the same process, so session turn numbers would stop matching prompt indices). 16 tools
  remain. The model is
  the base default `deepseek-official/deepseek-flash`, effort high; the plugin keeps
  its default `inherit`.
- Per task, one more overlay sets `slice-agent-loop.maxStepsPerTurn`, identical across
  arms.
- `--dump-config` is identical across the three homes (414 lines) once each home's own
  path in the provenance comments is normalized; the plugin package is the only
  difference, and it does not appear in the dump.
- Environment as `~/.dsh-slicey/bin/slicey-dsh`: inherited proxy variables,
  `NODE_USE_ENV_PROXY=1`, `NODE_OPTIONS=--disable-warning=UNDICI-EHPA`, and
  `DSH_TELEMETRY_DISABLED=1` as the owner's login shell sets it. Every other inherited
  `DSH_*` variable is removed from the child (`DSH_PERMISSION_MODE` unset means the
  profile default `workspace-write`); each batch manifest records the variable names,
  never values. The key is a symlink `home-<arm>/.env -> ~/.dsh/.env`, created only after
  the dry run.

Fingerprints measured in the offline dry run (§11); every real cell must match its arm
(`$AB/fingerprints.json`, copied to `docs/ab/p110-2026-09-27/fingerprints.json`):

| | control | arm 1 | arm 2 |
|---|---|---|---|
| system prompt sha256 | `f323bf5f…` | `46c592c8…` | `46c592c8…` |
| slice tool JSON sha256 (canonical JSON of the four recall tools) | `6699b32a…` | `4d9ca4cc…` | `4d9ca4cc…` |
| system prompt chars | 4,249 | 3,651 (−598) | 3,651 (−598) |
| four recall tools, canonical JSON chars | 5,441 | 5,266 (−175) | 5,266 (−175) |
| per-request prefix (system + all 16 tools) | 18,311 | 17,538 (−773) | 17,538 (−773) |
| tape header, one-digit turns | 188 | 76 | 76 |
| mean tape tool line in the dry run | 94.4 | 94.4 | 53.3 (−41.1) |
| tools | 16 | 16 | 16 |

The control slice-tool fingerprint equals the one in the two real Raft sessions of the
P1-10 record, which ran the `ba12a5b` build. Disabling the goal tools removed 530 chars
from every arm's system prompt (the goal tool's system section) and three tools; the
control-vs-arm deltas are the ones of the first dry run (`5b629af`: system −598, slice
tools −175, prefix −773), checked with `run_ab.py fingerprints --compare`.

Fingerprints come from the mock provider. The system prompt and tool list are composed by
the host and the plugin, not by the provider, but that is checked, not assumed: the
warmup batch runs with `--fingerprints none` and its fingerprints are compared with these
(§5 step 3). Pre-declared fallback: if they differ while the control-vs-arm deltas and the
slice-tool shas are unchanged, the warmup fingerprints replace these for the pilot and the
batch (and the docs copy); if a delta or a slice-tool sha differs, the batch does not
start.

## 4. Tasks

Seven gated tasks plus a warmup; files under [scripts/ab/tasks](../scripts/ab/tasks).
Five need recall and two are ordinary coding. In every recall task the fact reaches the
model only as a tool result (user and assistant text stay verbatim on the tape, tool
output does not), and the harness deletes its source between turns (`hooks.py`), so a
correct exam answer requires recall. Oracles never live in the workdir.

| alias | task | turns | step cap | exam | source |
|---|---|---|---|---|---|
| hello | `hello` | 1 | 4 | – | warmup: "Reply with exactly: HELLO"; always passes |
| r1 | `p110_r1_fixture_fp` | 6 | 12 | T5 | dsh-slice `r2b_tool_only`: prompts P1, P2, P6, P10, P11, P12 verbatim, except that P1 asks to run the script as is, without redirection or a pipe (pilot, §13); the hook deletes `tools/check_fixtures.py` and `fixtures/` after T2 (replaces r2b's deletion turn). Oracle: `FX-8b69ed6e`; decoys `FX-3c1a9f04`, `FX-8b69ed7a`, `FX-e2d40b91` in the T3/T4 floods. |
| r2 | `p110_r2_superseded_stamp` | 7 | 12 | T6 | dsh-slice `r2d_superseded_fact`: prompts P1, P2, P4, P6, P10, P13, P14, with P2 and P6 (T2, T4) asking to run the script as is, without redirection or a pipe (pilot, §13); the hook deletes `config/` and `tools/stamp.py` after T4. Current `CFG-8d2e0fac` (T4), stale `CFG-81d29c44` (T2), decoys in the floods; two locators from different turns. |
| r3 | `p110_r3_runbook_middle` | 3 | 12 | T3 | new. A seeded 420-line, 28 KB prose runbook (above the fold's 6000-char threshold, no line structured, code-like or log-like to the digest). T1: read it with the read tool, write the night-shift escalation extension (`64471`, line 180; decoy `64417` in the kept head) to `answers/ext.txt`: in-turn fold recovery, the direct probe of C2. The hook deletes `docs/` after T1; T2 filler (`slugify`); T3: the backup datacenter (`Brackenfold`, line 300; decoy `Aldergate` on the kept last line): cross-turn recall of the T1 read. A cell is valid only if the T1 read was folded. |
| r4 | `p110_r4_probe_compare` | 4 | 12 | T4 | new. `tools/probe.py --region us` (T1) and `--region eu` (T2), each run "exactly as written (no redirection, no pipe)" (pilot, §13), print a run id and an 8-endpoint p50/p95 table derived from sha256; never restated; the hook deletes `tools/` after T2; T3 filler (`pct`); T4 writes `shipping,690,291` (highest us p95, then eu). Swapped regions are detected; one leading CSV header line whose value fields are not numbers is ignored. |
| r5 | `p110_r5_initial_failures` | 2 | 60 | T2 | dsh-tool-result-fold `f3_test_suite_fix`: T1 fixes a red 400-test suite with 5 planted bugs (turn timeout 40 min) and replies "just DONE and the final pass count, without summarizing the fixes" (pilot, §13); T2 lists the tests that failed before any change, only recoverable from T1 tool output. The truth file moved from `<workdir>/.truth/` to `<workdir>.truth.json`. |
| c1 | `lh1_incremental_build` | 8 | 14 | – | sliceagent h2h, copied as is: 8 dependent turns building `calc.py`; cross-turn and post-edit re-reads of the model's own file. |
| c2 | `m3_consistency_bugfix` | 1 | 26 | – | sliceagent h2h, copied as is: one invariant across 4 modules; same-turn re-read and verification behaviour. |

Oracle tokens have three roles per exam (`exams` in each `meta.json`):

- **Recall tokens**: a recall result in the exam turn that names one sources the answer. r1
  `8b69ed6e`; r2 `8d2e0fac`; r3 `Brackenfold` (`64471` is the in-turn token of T1); r4 the
  two run ids `PRB-us-7537d2a4`, `PRB-eu-559cd122` and the two `shipping` table rows; r5
  the ten failing test names.
- **Leak tokens**: enough to answer (default: the recall tokens). r4: the `shipping`
  values (`shipping … 690`, `shipping … 291`); the run ids do not answer the question. r5:
  the five buggy function ids (`dates_f5`, `hashing_f7`, `slugs_f0`, `tokens_f3`,
  `validate_f2`); with them and the `tests/` tree the failing list follows
  (`test_<id>_0`, `test_<id>_1`).
- **File-system tokens**: evidence that a non-recall tool result carried the oracle
  (default: the recall tokens). r4: anything the probe printed. r5: a `FAILED` marker for
  one of the ten tests, or the truth file's `"failing"` key; the test names themselves are
  in the workspace's `tests/`, so they are not evidence.

**Delivery** (r1, r2, r4; `delivery` in `meta.json`): the turns that print the exam's fact
(r1 T1; r2 T2 and T4; r4 T1 and T2) must show it in a non-recall tool result. A run whose
output went to `/dev/null` leaves the exam unanswerable by construction, which the pilot
met twice (§13); such a cell is invalid (§7), not a failure.

`scripts/ab/selfcheck_tasks.py` shows each oracle failing on the untouched workdir,
passing on a correct end state (also with an r4 header line) and naming decoy, stale,
swapped and CANNOT-RECOVER answers (23/23 checks). It works in a temporary directory and
removes every workdir it made, because each one is an oracle copy on disk.

## 5. Procedure

1. Offline dry run (done, §11): all tasks x 3 arms x 1 rep with the scripted mock.
2. Before the key is linked, no oracle copy may sit on disk outside a running cell: the
   model's reads are not confined (§12). Every cell packs its workdir and truth sidecar
   into `results/<batch>/workdirs/<wid>.tgz` and removes them when it ends for any reason
   (finished, invalid, timed out, budget-stopped or retried), gzips its turn stdout, and
   keeps oracle tokens out of `cells/*.json`; self-checks run in a temporary directory.
   The development leftovers of the build stage (self-check workdirs, development and guard
   batches, the scout's workdirs) were packed into a compressed attic outside the AB root
   and removed on 2026-09-27.
3. Link the key; warmup and parity: `hello` x 2 reps x 3 arms, arms concurrent,
   `--fingerprints none`. Every arm must show step-1 cacheRead ≥ 4000 in rep 2, 16 tools
   and no `/private` or `/Users` in the system prompt. Then
   `run_ab.py fingerprints --batch-dir $AB/results/warm --compare $AB/fingerprints.json`
   decides as pre-declared in §3: equal, keep; different with equal deltas and slice-tool
   shas, replace; a delta or slice-tool sha differs, stop.
4. Pilot, control only: r1, r3, r4 x 1 rep. Check oracles, leak and access flags, the
   r3 fold, wall time. If control cannot pass a task at all, fix that task here; this
   is the only point where a task may change. Then fill §13 and commit.
5. Batch: 7 tasks x 3 reps x 3 arms = 63 cells, seed 20260927 (seeded task order per
   rep), the three arms of a (task, rep) pair run concurrently. An invalid cell is
   rerun once; infra reruns are reported separately and never count as behaviour.
6. Report: `ab_report.py` pairs cells by (task, rep), evaluates [gates.json](../scripts/ab/gates.json)
   and writes `summary.json` / `summary.md`; the per-turn cache split is cross-checked
   with dsh-slice `cache-metrics.py`. Arbitration only as in §9.
7. Archive: `run_ab.py secrets-scan --ab-root $AB` first. It lists every cell with a tool
   call that referenced `.env`, `DSH_HOME` or `~/.dsh` (the bash tool exports `DSH_HOME`,
   and the sandbox does not confine reads, so `$DSH_HOME/.env` is readable). Those cells'
   session logs and turn files are held back from the experiment archive until the owner
   has looked. Nothing ever reads the key or searches for it.

## 6. Metrics

All from the session log (`ab_metrics.py`), one row per cell.

- **Usage.** Over every `assistant/message` and every failed `assistant/attempt` (a
  retried attempt's billed tokens live only in its stream): miss = `inputTokens`, hit =
  `cacheReadTokens`, out = `outputTokens` (the three add up to `totalTokens`; checked
  on the two real sessions); step-1 miss per turn. Requests = committed messages only, so
  provider retries stay out of G4's request count; failed attempts and records without a
  usage sample are reported. Cost = miss·Pm + hit·Ph + out·Po on both sheets of
  [scripts/ab/prices.json](../scripts/ab/prices.json). Peak is exactly twice off-peak for
  every field, so ratios do not depend on the sheet.
- **Same-turn repeated reads.** Read-like calls are `read` (line range
  [offset, offset+limit−1], defaults 1 and 2000) and single-file bash reads with their
  line ranges: `cat`, `nl`, `less`, `more` the whole file; `head` lines 1..N (default
  10); `sed -n` with numeric `p` ranges (`'a,bp'`, `'Np'`, `'a,$p'`, several joined by
  `;`); `tail -n +N` lines N..end. Any other `tail`, a regex print (`sed -n '/re/p'`) or
  `head -c` is a range of unknown position that never overlaps another read, so paging
  through disjoint ranges or `head` then `tail` is not a re-read. A first downstream
  `| head`, `| sed -n` or `| tail` narrows a whole-file read. Paths are resolved against
  a leading `cd DIR &&`, the bash tool's own `workdir` parameter (which its description
  asks the model to use instead of `cd`) and the session cwd. Mutations
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
- **Exams.** Recall-sourced = a recall token (§4) appears in the result of a recall tool
  call within the exam turn; recall-sourced correct = that and `verify` passes. Exam
  answer class from `verify`: a passing `verify` is always correct; otherwise decoy,
  stale, hedged, wrong (including swapped regions and a partial failing list),
  cannot_recover, missing, read from the task's own class or, for r1/r2, from the verdict
  part of the detail only (their detail ends with the model's `how.md` text after
  ` | how:`, which never decides the class).
- **Leak.** A leak token (§4) in assistant text before the exam turn (the tape keeps it
  verbatim), or in a tool input before the exam turn that writes it to a file: `write`
  or `edit` content, or a bash `echo`/`printf`/`cat` into a file, `tee` or a heredoc.
  Other tool inputs never reach the tape (a tool line carries name, size and locator), so
  running a failing test by name is not a leak. r5 excepts write and edit calls on files
  under `textkit/` (`leak_write.skip_paths`): the required fix edits the buggy function and
  so names it, while the edited file holds every function id anyway; a notes file or any
  other write naming a fixed function still counts.
- **Delivery.** For each delivery turn (§4), whether a non-recall tool result of that turn
  names the exam's fact; reported per cell without the token.
- **Oracle via the file system.** In the exam turn, in log order: a non-recall tool
  result (bash, read, grep, glob, …) names a file-system token (§4) before any recall
  result did and before the model itself wrote it (in assistant text or a tool input,
  e.g. its own answer file read back).
- **Flagged access.** Every path argument (`file_path`, `path`, a glob pattern's fixed
  prefix), every path-like word of a bash command (following `cd`), and the bash
  `workdir` parameter is resolved against the cell's workdir (`/tmp` and `/private/tmp`
  are the same place). A call is flagged when a path leaves the workdir (`..` escapes and
  absolute paths alike; `/usr`, `/bin`, `/sbin`, `/System`, `/Library`, `/opt/homebrew`,
  `/etc` and `/dev/null` are exempt, `/tmp` and `/var` are not), on `~`, `$HOME` or
  `$TMPDIR`, on `/` given to `find`, `ls`, `grep`, `du`, `cat` and similar walkers, on
  `mdfind` or `locate` as the command word of a pipeline stage (not as text: a heredoc
  comment "# locate …" is no search), and wherever it names `sessions/`, `.zstd`, `.truth`,
  `session.v4`, a `home-<arm>` or the harness. A call naming `.env`, `DSH_HOME` or
  `~/.dsh` is flagged as a secret reference (§5 step 7). The sed, awk and grep pattern
  argument is not a path.

`ab_metrics.py` reproduces the P1-10 record's counts on the two real V4 sessions
(360/408 requests, 73/95 turns, 72/94 entries, recall_search 8 / recall_turn 1 /
recall_step 1 in raft-1; 14 `expand_result`, all `{seq, formatVersion 4}`, 4 cross-turn
from the tape and 10 from fold views, in raft-2) and the scouting prototype's counts on
its 14 mock logs; `scripts/ab/test_ab_metrics.py` pins both.

## 7. Validity

A cell counts only if: every turn exited 0 or ended in a model-attributable way; the
log was found; the system prompt and slice tool fingerprints equal the arm's; 16 tools,
one tool list and one system prompt for the session; one turn per prompt (user prompts =
turn ends = prompts, no goal-round message); no `/private` or `/Users` in the system
prompt; zero compaction events; tape headers and tool lines in the arm's form; for arm 1
and arm 2 the per-request prefix at least 700 chars smaller than control and every tape
header 76 or 78 chars; for r3 a fold of the T1 read; for r1, r2 and r4 the exam's fact in
a non-recall tool result of every delivery turn (§4). Otherwise the cell is rerun, at most
2 attempts. A pair counts only when both its cells are valid; dropped pairs are listed in
the report.

Infra, which invalidates the cell: a `turn_end` error whose code is TRANSPORT, RATE_LIMIT,
SERVER, HTTP 5xx, TIMEOUT, EMPTY_RESPONSE, MISSING_CREDENTIAL, INVALID_CREDENTIAL, AUTH,
QUOTA, ACCOUNT_QUOTA, NO_ADAPTER or ABORTED, or whose stderr shows a network failure; a
turn without `turn_end` (the process died); the harness's turn timeout; a budget kill.
Model-attributable, which ends the turn and lets the cell continue (a failure for G1 and
G5, never an infra rerun): the step cap (`blocked`), `max-tokens`, and an error with any
other code (CONTEXT_WINDOW_EXCEEDED, INVALID_REQUEST, UNKNOWN, …). The report lists these
turns per arm.

A cell counts for G1 but its pair is dropped from G2 when, up to its exam turn, a call was
flagged, or a leak token leaked, or the exam answer came via the file system (§6).

## 8. Gates

Unit: 7 tasks x 3 reps = 21 paired cells per arm against control; the 15 recall cells
for G2. [scripts/ab/gates.json](../scripts/ab/gates.json) encodes these as data.
Minimum valid pairs per check: 17 of 21 (G1, G3, G4, G5, G6 except the arm-1 baseline
checks) and 10 of 15 (G2 and the G6 checks against arm 1).

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
- **insufficient** when a check has fewer valid pairs than its minimum, or cannot be
  evaluated at all (no pairs, no pair with a positive baseline cost, a missing
  baseline arm). Only G6 first-try may be **n/a** (reported, not blocking), when either
  side has no cross-turn target. Verdict order within a gate: fail, insufficient,
  arbitrate, pass. Without this rule a G2 whose every pair was excluded passed vacuously.
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
- Any gate "insufficient" (and none failed): that arm does not ship on this batch. The
  single arbitration batch above may add +3 reps of the tasks whose pairs were dropped;
  if the pooled result is still insufficient, the arm does not ship.
- Counts and paired deltas are reported, not p-values.

## 10. Budget and cost

Hard cap $10 for the whole experiment (warmup, pilot, batch, arbitration), enforced by
`run_ab.py` from usage tokens at the **peak** sheet (miss $0.44/M, hit $0.014/M, out
$1.32/M; the v4-flash sheet in [dsh-plugin-opportunities.md](dsh-plugin-opportunities.md);
that `deepseek-flash` bills on it is an assumption, token counts are authoritative).
One ledger (`$AB/spend.jsonl`) spans every batch.

A turn's charge is the larger of two figures. From its `--json` stdout: the usage of every
`step_end`, plus $0.05 for every `step_end` without usage (the 0.1.7-rc.2 projector drops
a whole step's usage when any attempt of it reported no sample, typically a transport or
429 retry, so that step, successful attempt included, would otherwise cost $0) and for a
step still open when the process ended (killed or crashed mid-request). From its session
log: the usage of every `assistant/message` and `assistant/attempt` of the turn, plus
$0.05 for every such record without a sample. $0.05 is about a 100K-token all-miss
request with 8K output at peak.

No cell starts within $0.75 of the cap. Running turns are polled every second, each
counting its priced steps plus $0.05 for its open step, and killed, with no further turn
started, within $0.60 of it. Invariant: a step's usage is known only when it ends, so
between two polls each concurrent turn can finish at most one step beyond what was
counted; the margin must be at least 2 x concurrent turns x worst-case step cost (3 x 2 x
$0.10, where a 150K-token all-miss request with 30K output at peak is about $0.11). The
run also stops cleanly once more than 40 unpriced steps have been charged (a retry
storm). Estimate from the plan: about $0.30 per arm-rep at peak, about $2.7 for the
batch, $0.5–1 for warmup, pilot and a possible arbitration.

## 11. Offline dry run (build evidence, 2026-09-27)

Harness commit `5d3b067` (the fixes of §15; the first dry run on `5b629af` is superseded).
No key existed in any home; the mock adapter (`scripts/ab/mock-llm.mjs`, provider
`ab-mock`) scripted bash, two reads of the file the prompt names, and an `expand_result`
on the newest tape tool line, parsing whichever form the arm renders. The homes were
rebuilt with the revised parity overlay; `--dump-config` is identical across arms (414
lines).

- 8 tasks (7 + hello) x 3 arms x 1 rep = 24 cells, arms concurrent, about 40 s: 96/96
  turns exited 0, 24/24 logs found, 24/24 metrics rows, 24/24 cells valid on the first
  attempt; one turn per prompt everywhere; no flagged call, leak or oracle-via-fs in any
  cell. A second run validated against the fingerprints computed from the first gave the
  same result (24/24 valid).
- Tape forms per arm as expected (control long/long, arm 1 short/long, arm 2 short/v);
  every mock `expand_result` found its locator on the tape with formatVersion 4 in all
  three arms; the r3 T1 read was folded in every arm.
- After each cell its workdir (and r5's truth sidecar) was packed into
  `workdirs/<wid>.tgz` and removed, and its turn stdout gzipped: no workdir, plain turn
  file or oracle token in `results/` afterwards.
- Fingerprints: §3; `run_ab.py fingerprints --compare` against the `5b629af` run shows
  the expected changes (16 tools, system prompt −530 chars in every arm) and identical
  control-vs-arm deltas.
- Guards, on the same commit:
  - failure injection without usage (`AB_MOCK_FAIL_EVERY=3`): 14 steps without usage were
    charged, each turn's session-log figure was at least its stdout figure, and the
    metrics billed the committed message of every such step (r3: miss 1,027 against 409
    in the stdout usage) with 6 failed attempts per cell; with usage
    (`AB_MOCK_FAIL_USAGE=1`) the stdout and metrics figures agree (7,627 miss, 6,600 of
    them from failed attempts);
  - a retry storm (`AB_MOCK_FAIL_EVERY=2`, limit 3) stopped the batch cleanly (exit 2);
  - budget kills mid-turn with three concurrent arms: ledger $0.002961 under a $0.003
    cap, then `--resume` at $0.006: $0.005718, then at $0.010: $0.008793 with the cells
    done; attempt numbers 1, 2, 3 per cell, no repeated (cell, attempt, turn) ledger key,
    no workdir left;
  - a doctored fingerprint file makes a cell invalid after 2 attempts.
- `scripts/ab/test_ab_metrics.py` 18/18 (with the 24 mock logs and the two real
  sessions), `scripts/ab/test_ab_report.py` 10/10, `scripts/ab/test_run_ab.py` 5/5,
  `scripts/ab/selfcheck_tasks.py` 23/23; typecheck, 342/342 vitest, check:docs,
  check:size and check:build pass on the harness branch.
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
- Leaks and shortcuts are detected, not prevented: the sandbox confines writes only, so
  the model can read anywhere on disk, including a concurrent arm's workdir (a sibling
  that may still hold the task's sources) and the harness. Access outside the workdir is
  flagged by path and the oracle's arrival by content (§6); a path built at run time
  inside a script and read without printing an oracle token would slip past both.
- r5 can still leave G2: any T1 text that names the fixed functions is a leak by §6, since
  the failing list follows from them. The first r5 pilot's closeout did; after the pilot
  change (§13) the re-pilot's did not. With r5 out of every pair, G2 would rest on at
  most 12 of 15 pairs against its minimum of 10.
- Provider weather (latency, rate limits, cache eviction, peak hours) is controlled by
  running the arms of a pair concurrently and interleaving reps; timestamps are kept.

## 13. Frozen parameters and pilot (pre-registration, committed before the batch)

- **Harness:** commit `58363c5` (`scripts/ab/` tree `c3a2abe`, tasks tree `0a38b29`). The
  pre-registration commit that adds this section changes only this file and
  `docs/ab/p110-2026-09-27/pilot.json`; every batch manifest records the commit it ran from
  (`harness_commit`), and `git diff 58363c5 <that commit> -- scripts` must be empty.
- **Arms:** control `95d40ce`, arm 1 `4fe4389`, arm 2 `147d2d4`; tarballs and sha256 in §2
  and `docs/ab/p110-2026-09-27/SHA256SUMS` (identical to `$AB/artifacts/SHA256SUMS`).
- **Host and model:** DSH 0.1.7-rc.2 (frozen copy); provider `deepseek-official`, model
  `deepseek-flash`, reasoning effort high (request headers of the warmup logs).
- **Fingerprints:** §3, unchanged by the warmup: `run_ab.py fingerprints --compare` found
  no changed field and no delta mismatch, so `docs/ab/p110-2026-09-27/fingerprints.json`
  stands (the §3 fallback was not needed).
- **Price sheet:** §10 and `scripts/ab/prices.json`: peak miss $0.44/M, hit $0.014/M, out
  $1.32/M (off-peak half of each); the budget prices every turn at peak.
- **Budget:** `--budget-usd 10` over the single ledger `$AB/spend.jsonl`, which already
  holds the warmup and the pilots ($0.1205 at peak); reserve $0.75, margin $0.60, $0.05
  per unpriced step, stop after 40 unpriced steps.
- **Batch:** `run_ab.py --ab-root $AB --arms control,arm1,arm2 --tasks all --reps 3 --seed
  20260927 --parallel-arms --budget-usd 10 --batch p110-20260927` (continued with
  `--resume`), `--max-attempts 2`, fingerprints `$AB/fingerprints.json`.
- **Tasks:** r1 `p110_r1_fixture_fp`, r2 `p110_r2_superseded_stamp`, r3
  `p110_r3_runbook_middle`, r4 `p110_r4_probe_compare`, r5 `p110_r5_initial_failures`, c1
  `lh1_incremental_build`, c2 `m3_consistency_bugfix`, exactly as in the tasks tree above.
- **Gates:** §8 and `scripts/ab/gates.json`; margins, minimum pairs (17 of 21, 10 of 15)
  and arbitration units are unchanged by the pilot.

### Warmup (paid, 2026-09-27)

`hello` x 2 reps x 3 arms, arms concurrent, `--fingerprints none` (harness `8d88eb7`): 6/6
cells valid; step-1 cacheRead in rep 2: control 4,608, arm 1 4,352, arm 2 4,352 tokens
(required ≥ 4,000); 16 tools; no `/private` or `/Users` in any system prompt; fingerprints
equal to the offline ones in every arm. $0.0066 at peak.

### Pilot (control only)

**Pilot 1** (harness `8d88eb7`; r1, r3, r4, 1 rep).

- r3 passed and was valid. The T1 read was folded (426 lines, 14 kept); the model found
  the extension with the grep tool and a read at offset 176 (one `fold_then_reread`), and
  answered T3 from `expand_result` with `grep` on the tape locator of the T1 read. 23 s.
- r1 and r4 failed by construction. Told that only the exit status mattered, the model ran
  the script as `python3 … > /dev/null 2>&1; echo exit=$?` in the delivery turn (r1 T1; r4
  T1, not T2), so the fact never reached a tool result. The exam turns then used the
  recall path correctly (`expand_result` on the tape locators of both T1 results,
  `recall_step`, `recall_turn` full) and honestly answered CANNOT-RECOVER. No flag, no
  leak.

**Changes made at the pilot** (the only ones; no arm had run a gated task):

1. Delivery prompts: r1 T1, r2 T2 and T4, r4 T1 and T2 ask to run the script as is,
   without redirection or a pipe. r2 shares r1's wording, so it was changed and piloted
   as well.
2. Delivery validity (§4, §7): each delivery turn must show the fact in a non-recall tool
   result, otherwise the cell is invalid and rerun. Re-scored under this rule, pilot 1's
   r1 and r4 cells are invalid, not failures.
3. r5 T1 asks for "just DONE and the final pass count, without summarizing the fixes".
   The first r5 pilot passed and sourced its answer through `expand_result`, but its T1
   closeout listed the five fixed functions, a leak by §6. That would have dropped r5
   from G2 in nearly every pair, leaving G2 at most 12 of 15 pairs against its minimum of
   10.
4. r5 write leaks except write/edit calls on `textkit/` (§6). The same pilot's bug-fix
   edits named the fixed functions, which carries no shortcut.
5. Metric fix: `mdfind` and `locate` are flagged as a command word only (§6). The r5
   re-pilot had been flagged for a Python heredoc comment "# locate def fn block".

**Pilot 2** (harness `fe8bb76`; r1, r2, r4) and the **r5 pilots** (`fe8bb76` and
`5e25c0d`), re-scored under the frozen harness `58363c5`:

| task | pass | valid | G2-eligible | exam source | wall |
|---|---|---|---|---|---|
| r1 | yes | yes | yes | `expand_result` on the T1 tape locator (after `recall_turn` dialogue) | 31 s |
| r2 | yes | yes | yes | `expand_result` x 3 on tape locators; stale value not used | 56 s |
| r3 (pilot 1) | yes | yes | yes | `expand_result` with `grep` on the T1 read | 23 s |
| r4 | yes | yes | yes | `expand_result` on both probe results, first try | 25 s |
| r5, first | yes | yes | no (T1 closeout named the functions) | `expand_result` | 34 s |
| r5, after change 3 | yes | yes | yes | `expand_result` and `recall_step` of T1, then a re-run of the pre-fix code rebuilt in `.repro/` inside the workdir | 43 s |

No flag, leak or oracle-via-fs remains in any of these cells, and no recall-tool error or
formatVersion rejection occurred.

Floor and ceiling: control passed each piloted task, but every exam went through the
recall path (recall-sourced), so the recall metrics of G2 and G6 carry signal at a pass
ceiling, and G1 is non-inferiority, which needs no headroom above control. c1 and c2 were
not piloted (copied as is from the h2h suite; their oracles are covered by the self-check).

Spend so far: **$0.1205** at peak prices (warmup $0.0066, pilot 1 $0.0310, pilot 2
$0.0393, r5 pilots $0.0157 and $0.0278), no unpriced step. From the pilot cells
($0.007–0.028 each) a batch arm-rep costs about $0.15 at peak with c1 and c2 estimated, so
the 63-cell batch should cost about $1.5–2.5, well inside the cap. Per-cell records,
without oracle tokens or answer text: `docs/ab/p110-2026-09-27/pilot.json`.

## 14. Results

**Runs** (harness `f70d584`; `git diff 58363c5 f70d584 -- scripts` is empty; arms, host,
model and fingerprints as in §13):

| batch | window (UTC, 2026-09-26) | cells | valid on attempt 1 | pass | spend at peak |
|---|---|---|---|---|---|
| `p110-20260927` (the §13 command) | 19:58–21:00 | 63 | 63 | 63 | $2.2320 |
| `p110-20260927-arb` (arbitration, below) | 21:02–21:53 | 63 | 63 | 63 | $2.2258 |

Neither batch had an infra failure, rerun, model-error turn, timeout, budget stop, unpriced
step, failed provider attempt, compaction or goal call. Every cell matched its arm's
fingerprints, tape forms and structural sizes. The whole experiment (warmup, pilots, batch
and arbitration) cost **$4.5783 at peak prices** of the $10 cap, over 598 ledger turns.

**Batch alone** (21 pairs per arm; 15 recall pairs for G2):

| gate | arm 1 | arm 2 |
|---|---|---|
| G1 | pass: 21 vs 21 | pass: 21 vs 21 |
| G2 | **insufficient**: 8 valid G2 pairs (minimum 10) | **insufficient**: 9 valid G2 pairs |
| G3 | pass: 41 vs 33 (limit 43.25) | pass: 41 vs 33 |
| G4 | pass: median ratio 0.987, sum ratio 1.017, median Δrequests 0, full views 0 vs 3 | **arbitrate**: median Δrequests +2 against the limit +1 (one unit); median ratio 1.043, sum ratio 1.031, full views 0 vs 3 all pass |
| G5 | pass: closeouts 86 vs 85, step-cap cuts 7 vs 8 | pass: 85 vs 85, 8 vs 8 |
| G6 | – | **insufficient**: the checks against arm 1 have 8 pairs; first-try 1.0 vs 1.0 and extra hops 3 vs 2 pass |

**Arbitration (§9).** Trigger: arm 2 G4.requests missed by exactly one unit, and no check
failed in either arm. G2 in both arms and arm 2's G6 checks against arm 1 were
insufficient. The arbitration took "the tasks driving the miss" as the union of two sets:
the tasks with positive paired request deltas for arm 2 (r1, r3, r5, c1, c2) and the
tasks whose G2 pairs were dropped (r2, r3, r4, r5). Together these are all seven tasks. So the
single arbitration batch ran all 7 tasks x 3 reps x 3 arms, with the same command, the
same seed (the pre-registration fixes no other) and the same concurrent pairing. The
decision uses the pooled 6 reps (`ab_report.py --pooled`, count margins x2). As
`gates.json` specifies, the minimum pair counts stay at 17 and 10.

**Pooled result (decides):**

| gate | arm 1 vs control | arm 2 vs control |
|---|---|---|
| G1 | pass: 42 vs 42 | pass: 42 vs 42 |
| G2 (pairs) | pass (16): recall-sourced correct 16 vs 16; recall errors 0 vs 0; formatVersion rejections 0 vs 0; decoy/stale/hedged/wrong/CANNOT-RECOVER 0 vs 0 | pass (19): 19 vs 19; 0 vs 0; 0 vs 0 (none to recover); 0 vs 0 |
| G3 | pass: 73 vs 79 (limit 102.75) | pass: 87 vs 79 |
| G4 | pass: median ratio 0.979, sum ratio 0.967, median Δrequests 0, full views 1 vs 3 | pass: 0.986, 0.994, **+1 (at the limit)**, 0 vs 3 |
| G5 | pass: closeouts 174 vs 168, step-cap cuts 12 vs 18 | pass: 170 vs 168, 16 vs 18 |
| G6 | – | pass: first-try 1.0 vs 1.0; extra hops 4 vs 2 (limit 6); vs arm 1 (17 pairs): rejections 0 vs 0, bad answers 0 vs 0 |

**Decision (§9):** arm 1 passes G1–G5, so ship A + C as one PR. It rides on the next
release that already changes the prefix, unless the owner accepts one full cache miss per
session active at deploy. Arm 2 passes G1–G6, so add F to the same PR.

What this shows, and what it does not:

- **Ceiling.** Every one of the 126 cells passed. Every recall exam, 30 per arm, was answered
  correctly from a recall tool result, and no arm had a recall-tool error or a
  formatVersion rejection. That includes the cells excluded from G2 (§6), so the
  exclusions do not hide a G2 difference. G1 and G2 therefore rule out a large regression
  at the ceiling, not a small one (n = 6 per task and arm).
- **Arm 2 requests.** Arm 2's median paired request delta is exactly at its limit (+1 per
  cell) after being +2 in the batch and −1 in the arbitration batch alone. Its same-turn
  re-reads are 87 vs 79 (+10%, limit +30%). Arm 1 shows neither (0; 73 vs 79).
- **Cost.** The prefix is 773 chars shorter in both arms. The median turn-1 step-1
  cacheRead is 4,480 tokens in each arm against 4,736 in control. Pooled cost at the
  off-peak sheet is arm 1 $0.7277, arm 2 $0.7484 and control $0.7528. As §8 expected, the
  structural saving is below what behaviour noise resolves at this n.
- **Cache split cross-check.** dsh-slice `cache-metrics.py --json` runs on the V4 logs.
  In all 126 cells its session miss, hit, output, request count, turn-first-step miss,
  per-turn step-1 cacheRead and `expand_result` count equal the `ab_metrics` figures.
  Failed-attempt usage, which `ab_metrics` also bills, was 0 everywhere.

**G2 exclusions (reported, not gated).** 26 of the 90 recall cells (30 per arm, both
batches) were excluded: arm 1 11, arm 2 8, control 7. One arm 1 r5 cell was excluded for a write leak;
it wrote the fixed function ids into a file outside `textkit/` in T1. All the other
exclusions were flagged accesses:

- In 19 cells the model listed or read the concurrent arms' workdirs under `work/`. In 11
  it listed the A/B root, `results/` or the scratchpad, and in 2 it ran `find /`.
- Most of these happened in r2's exam turn (T6), usually after the turn's first recall
  call. The rest were in the filler turns of r3 (T2) and r4 (T3). Those turns ask the
  model to add a function to `lib/slug.py` and `lib/fmt.py`, which the setup never
  creates, so the model searched the disk for them (and, in one r3 cell, for the
  deleted runbook).
- 2 exclusions rest only on false positives of the rules: a `find -not -path '*/.git/*'`
  pattern, and `glob **/*.env` inside the workdir, where the task's own
  `config/service.env` lives.
- No exam answer came through the file system (oracle-via-fs 0).
- In one excluded cell (r4 rep 2, arm 1, batch) the model also read the batch manifest,
  which names the arms.

Post hoc and not gated: in r2's exam turn, the model went outside its workdir in 2 of 6
control cells, 5 of 6 arm 1 cells and 5 of 6 arm 2 cells, and every one of those cells
still answered from recall. At n = 6 this is the only arm-dependent pattern in the data.
It is worth watching after release, as a sign that the shorter teaching text makes the
model double-check deleted sources on disk.

**Secrets.** `run_ab.py secrets-scan` lists 18 calls in 14 cells: 9 in the batch and 5 in
the arbitration. The inputs of those calls were of three kinds:

- `Calculator(...).env` in c1 test code (7 cells);
- `glob **/*.env` and `find -name '*.env'` looking for r2's own `service.env`;
- `ls -la "$DSH_HOME"` and `find home-arm1` listings (r2 and r4).

None of them reads a file's content under the home. Following §5 step 7, the session logs
and turn files of these 14 cells are held back from the archive until the owner has looked.
A separate scan found 14 bash calls that ran `env`, all as `env | grep ^DSH`. Their results
contain only the names `DSH_HOME`, `DSH_PROFILE`, `DSH_PROFILE_DIR`, `DSH_SESSION_ID`,
`DSH_SHELL`, `DSH_WORKSPACE` and `PWD`. The scan checked names only and never printed values.

**For a next native A/B:**

- Give filler turns a target file that exists.
- Keep each arm's workdirs and the harness state out of the model's reach: separate
  roots per arm, a manifest outside the tree, or a read-confining sandbox.
- Stop flagging `find -path` patterns and `*.env` globs inside the workdir.

**Files.** [summary.md](ab/p110-2026-09-27/summary.md) and
[summary.json](ab/p110-2026-09-27/summary.json) hold two reports. The first is the pooled
report, which decides. The second is the batch alone, which triggered the arbitration.
Paths in both are normalized. The raw cells, turn files, session logs and ledger are in
the owner's experiment archive, `results/20260927-p110-ab/` in the dsh-slice workspace,
minus the held-back logs.

## 15. Revisions before any paid call (2026-09-27)

A review of the build found these faults; all were fixed and re-tested offline before the
key was linked. None changes an arm, a prompt or a gate margin.

1. **Access flags.** The pattern `/p110ab/` matched every absolute path inside the cell's
   own workdir, while `find /`, `../` escapes and the grep tool on `..` went unflagged.
   Paths are now resolved against the workdir, and the oracle's arrival through a
   non-recall result is checked by content (§6).
2. **Vacuous gates.** A check with no valid pairs returned n/a, which counted as a pass:
   with every recall pair excluded, G2 passed and the report said "ship". Such checks are
   now "insufficient", with minimum pair counts, and block the decision (§8, §9).
3. **Budget undercount.** The ledger priced only `step_end` usage, which the projector
   drops for a whole step after any usage-less attempt, the retry-storm case the cap
   guards. Such steps and open steps are now charged $0.05 each, each turn is reconciled
   with its session log, and a retry storm stops the run (§10). Metrics bill failed
   attempts too. The mock can inject failed attempts with or without usage.
4. **Oracle copies on disk.** Self-check workdirs, development and guard batches and the
   scout's workdirs held task sources and correct answers where a `find /` would reach
   them, and a stopped or retried attempt left its workdir behind. They were packed away,
   and every cell now removes its workdir when it ends (§5 step 2).
5. **Leak rule.** Any oracle token in any earlier tool input counted as a leak, so r5's
   test names typed into `pytest` would have dropped most r5 cells, while the real r5
   shortcut (function ids in T1's text) went unseen. Tokens now have roles, and only
   write-like tool inputs count (§4, §6).
6. **Re-read metric.** The bash `workdir` parameter was ignored, and `sed -n`, `head` and
   `tail` counted as whole-file reads, so paging inflated G3. Line ranges are now parsed
   (§6).
7. **Goal rounds.** With the goal tools enabled, a `create_goal` call could start extra
   turns inside one process and shift every turn-addressed metric. The tools are disabled
   in the parity overlay (16 tools) and one turn per prompt is a validity check (§3, §7).
8. **Infra rule.** Every exit ≠ 0 with an error `turn_end` was infra, so a context
   overflow or a rejected request would have been rerun and dropped instead of counted.
   Only provider, network, credential and quota codes are infra now (§7).
9. **Budget margin and resume.** The cap holds only if the margin covers what concurrent
   turns spend between polls; that invariant is now stated and the defaults follow it
   (§10). `--resume` restarted attempt numbers at 1, reusing workdirs, turn files and
   ledger keys; attempt numbers now continue.
10. **Answer classes.** The r1/r2 class was read from the whole verify detail, including
    the model's own `how.md` text, even when the cell passed; an r4 CSV header line made a
    right answer "hedged". A passing verify is now always correct, only the verdict part is
    read, and one header line is ignored (§4, §6).
11. **Secrets and fingerprints.** `$DSH_HOME/.env` is readable from bash; references to
    it are flagged and their logs held back from the archive (§5 step 7). The fallback for
    provider-dependent fingerprints is pre-declared (§3), and the manifest records the
    `DSH_*` variable names.
