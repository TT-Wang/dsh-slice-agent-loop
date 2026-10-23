# Slice vs stock DSH: is the current slice context policy worth using?

> **Status: DRAFT pre-registration, 2026-10-23 (design and build stage).** No paid call has run and
> no model key is linked anywhere under the A/B root. The harness, arms, tasks, metrics, comparisons
> and decision rule below are built and dry-run offline (§10). The paid warmup and the pilot (§12)
> come next; the pilot may resize f1 (§12.2) and nothing else. The commit that fills §12 freezes
> §1–§12. §13 "Results" stays empty until the batch and its report exist.

## 1. Question

Is the CURRENT slice context policy worth using compared with stock DeepSeek Harness (DSH) doing
its own native context management? Measured on cost, task success, recall of early facts and
context size, over sessions of ordinary and long length.

The current policy (main `c73ee22`, plugin 0.3.0, peers `0.2.0-rc.2 || 0.2.1-rc.2`): every
completed turn is sealed once into a frozen `[slice tape v1 …]` entry (append-only, so the
provider's prefix cache keeps working); human user messages always stay verbatim; large tool
results are folded inside their turn, with an `expand_result` locator; four recall tools
(`recall_turn`, `recall_search`, `recall_step`, `expand_result`) reach sealed history.

Why now: no earlier evidence is about this policy against this host.

| evidence | what it compared | why it does not answer the question |
|---|---|---|
| Aug 2026 custom loop (dsh-slice eval report) | a replacement loop vs the default transcript loop | a different loop, retired; coding +8–66 % cost, long/memory −4–38 %, s10 flood 76 turns: stock 217K-token context vs slice ~27K |
| 2026-09-08 first native policy | stock vs slice, 6 tasks x 2 | history re-paid every turn (+54 % median cost); fixed by append-only sealing on 2026-09-12 |
| 2026-09-09 pressure-archive policy | stock vs slice | superseded by the append-only tape three days later (−12 %) |
| P1-10 A/Bs (2026-09-27, 2026-10-22) | slice vs slice text variants | parity overlay disabled compaction and the pruner: no stock arm |
| live slicey-dsh on 0.2.0-rc.2 | one long real session | 179 turns, 97–98 % cache hit, max request 85K tokens; no counterfactual |
| synthetic 800-turn benchmark | request chars | slice 2.18M chars vs stock 25.6M, stock with no compaction; no model, no cost |

The current append-only tape has never been compared with stock on cost and success with the real
model.

This is an evaluation, not a ship gate: §7 pre-declares what result counts as "worth it", "not
worth it" or "inconclusive".

## 2. Arms

### 2.1 Host and model

- **Host:** the published `@deepseek-ai/dsh@0.2.1-rc.2` (npm `latest` on 2026-10-23), installed
  with `npm install --save-exact @deepseek-ai/dsh@0.2.1-rc.2` into an empty `AB/host` (615
  packages); the harness only runs `AB/host/node_modules/@deepseek-ai/dsh/lib/bin.js`, app
  `headless`, one process per turn. `~/.dsh-slicey` is not touched. Each batch manifest records a
  digest of the host tree at its start and end.
- **Model:** the host's default route, `deepseek-official/deepseek-flash`, reasoning effort at the
  adapter default (high); the plugin's `defaultReasoningEffort` stays `inherit`.
- **Price sheet:** `scripts/ab/prices.json` (DeepSeek v4-flash): off-peak miss $0.22/M, hit
  $0.007/M, output $0.66/M; peak exactly twice each. Ratios do not depend on the sheet; the budget
  prices every turn at PEAK.

### 2.2 Compositions

All three arms are profile `ab` with bundles `@deepseek-ai/dsh-base` and
`@deepseek-ai/dsh-headless` (the host's headless composition) and the same neutral overlay
([scripts/ab/profile/eval-neutral.patch.yml](../scripts/ab/profile/eval-neutral.patch.yml)).

| arm | composition | `--dump-config` |
|---|---|---|
| **STOCK** | host headless composition + neutral overlay; every native context feature at its shipped default | 412 lines (baseline) |
| **SLICE** | STOCK + `dsh plugin add <slice tarball packed from main c73ee22>` | 415 lines: STOCK plus exactly one row, `slice-agent-loop` (`@dsh-external/dsh-slice-agent-loop`) |
| **STOCK-COMPACT** (configured variant, §2.5) | STOCK + [stock-compact.patch.yml](../scripts/ab/profile/stock-compact.patch.yml) | 417 lines: STOCK with exactly one row changed, `compaction-basic` (`thresholdRatio 0.057344`, `retainTokens 19660`) |

`run_ab.py prepare` compares the dumps row by row against STOCK and exits 0 only if each arm
differs in exactly its declared rows (`vault/dump-compare.json`): SLICE only in
`slice-agent-loop`, STOCK-COMPACT only in `compaction-basic`. The plugin's own bundle patch
(`cordis.patch.yml` of the package) inserts that one row and changes nothing else: compaction,
the pruner and spill stay mounted in SLICE too, at the same settings as in STOCK.

Slice tarball: `slice-main-c73ee22.tgz`, 35 files, sha256
`62b0eb7efc3d0d7011422da0388b5e5c0b78da48413e4c70f1ed15d43c32c322`, packed with `npm pack` in
a detached worktree at `c73ee22` after `npm run check:build` ("Generated lib/ matches committed
artifacts"); installed from an arm-neutral copy `plugin-62b0eb7efc3d.tgz`. The profile's
`package.json` lists the host bundles only; `dsh plugin add` appends the plugin bundle (checked:
it does, giving `[dsh-base, dsh-headless, dsh-slice-agent-loop]`).

### 2.3 Stock's native context management at its shipped defaults

Read from STOCK's `--dump-config` and from the upstream source of the release
(`deepseek-harness` at `687f282e86`, "release(dsh): 0.2.1-rc.2"):

| feature (row) | shipped settings | what triggers it | effect on the model's context |
|---|---|---|---|
| automatic compaction (`compaction-basic`, `@deepseek-ai/dsh-compaction-basic`) | no config in the composition, so the package defaults: `thresholdRatio` 0.8, `headroomTokens` 65,536, `retainRatio` 0.16, summary `maxTokens` = headroom (65,536), `compactionRetries` 1, `maxOverflowRetries` 1, `auto` true (`src/config.ts`: `DEFAULT_THRESHOLD_RATIO`, `DEFAULT_RETAIN_RATIO`, `headroomTokens ?? 65_536`) | at `agent/pre-step`, before each request, when measured pressure ≥ `floor(min(W x thresholdRatio, W − O − headroom))` (`resolveCompactSpec`). For deepseek-flash W = 1,000,000 (`llm-deepseek` `DEFAULT_CONTEXT_WINDOW`, catalog entry `deepseek-flash`) and O = the routed `maxTokens` 256,000 (`DEFAULT_MAX_TOKENS`; the P1-10 request headers show 256000): **trigger 678,464 tokens**; retained tail floor(0.16 x 744,000) = **119,040 tokens**. Also on a provider-confirmed `CONTEXT_WINDOW_EXCEEDED`: one maximal head reduction, then one retry | the oldest balanced span is replaced by one `<compacted-summary>` user message written by an extra model call (its usage is logged on `compaction/summary`); the recent tail stays verbatim; the cache breaks from the first replaced token |
| `/compact` (`command-compact`) | mounted | a human command only; never fires in a headless run | – |
| tool-result pruner (`tool-result-pruner`) | `thresholdChars` 8,192, `headChars` 4,096, `tailChars` 1,024 (set in dsh-base) | only when a compaction trigger qualifies (pressure or overflow), before the range is chosen; model-free | every tool result over 8,192 code points keeps its first 4,096 and last 1,024 with a `[... tool result middle pruned ...]` marker; logged as `compaction/prune` + a `tool/result` replacement |
| spill (`spill-local`, `spill-policy`) | `maxInlineTokens` 12,500 | at tool execution, always, for results over 12,500 estimated tokens; `read` results pass through | head/tail preview plus `(Omitted N bytes. Full formatted result stored at: …)` |
| `read` limits (`tool-fs`) | `readLimit` 2,000 lines, `readMaxBytes` 51,200, `readMaxLineLength` 2,000 | every read | caps one read call; f1's excerpts (about 12,100 chars) are read whole |
| measurement (`token-meter`) | no settings | – | pressure = the latest provider usage when it matches the measured envelope and is not lower than the meter's own estimate, else the 4-characters-per-token heuristic over the whole envelope |
| `image-offload`, `session-checkpoint-policy`, `repeat-tool-reminder` (3, 5, 8), `timeout-policy`, bash `timeoutMs` 60,000 | as shipped | – | not context management of text history (the reminder adds a short notice after repeated calls) |

**Consequence:** stock's shipped compaction (and with it the pruner, which runs only under a
compaction trigger) cannot fire before a request reaches 678,464 tokens. Every session this
evaluation can afford stays below that: f1, the longest task, reaches an estimated 250K tokens in
STOCK (§9). At these lengths STOCK is a raw, growing transcript, which is what a DSH user on the
default route gets. That is the primary comparison. The forced dry run (§10.4) shows that the
trigger works at the computed value and that the harness detects it.

### 2.4 What the neutral overlay removes, and the harness step cap

The overlay is identical in every arm. It keeps compaction-basic, command-compact, the pruner,
spill, image-offload, the token meter and the reminder exactly as shipped. Against the bare
headless composition (382 lines, no overlay; SLICE's bare dump is the same plus the plugin row)
it disables 12 rows and empties the persona:

| row(s) | why the harness needs it |
|---|---|
| `session-title-llm` | an extra model call per session, outside the cell's step accounting |
| `tool-web` | network tools whose results change between runs |
| `system-prompt` persona: `personaPrefix ''`, `personaSuffix ''` (headless sets "You are a coding agent powered by the {{model}} model.") | names the route, which differs between the offline mock and the paid route; empty, as in every recorded batch. No `{{cwd}}` anywhere: the system prompt contains no `/private` or `/Users` (checked per cell) |
| `tool-subagent`, `tool-subagent-fork`, `tool-subagent-control`, `tool-subagent-list-agents`, `tool-workflow` | child sessions would carry model work and usage outside the cell's log (the base composition has no schedule tool) |
| `skill-filesystem`, `tool-skill` | the user-home skill catalog can change mid-batch |
| `tool-goal`, `goal-round-driver` | a goal would let the driver start extra turns inside one headless process; turn numbers must equal prompt indices |
| `tool-working-directory` (new in 0.2.1) | a persistent session `cd` would move the base every path argument is resolved against (re-reads, access flags) |

Telemetry is off through `DSH_TELEMETRY_DISABLED=1` in the child environment (a launch-time
patch; config cannot disable that row). Tools left: STOCK and STOCK-COMPACT 12 (`bash`, `edit`,
`exit_plan_mode`, `glob`, `grep`, `job_kill`, `job_list`, `job_output`, `read`, `read_image`,
`todo_write`, `write`); SLICE 16 (the same plus the four recall tools).

**Step cap.** The host has no per-turn step limit, and the plugin's own `maxStepsPerTurn` exists
only in SLICE. The harness therefore mounts its own row, `ab-step-cap`
([scripts/ab/step-cap.mjs](../scripts/ab/step-cap.mjs)), in every arm through the per-task steps
patch; the plugin's cap stays at its default (none). It rejects step N+1 at `agent/pre-step`
exactly as the plugin's cap does, so a cut turn ends `blocked` with exit 1 (checked offline in
STOCK and SLICE with a cap of 2). Caps per task are those of the recorded batches (c1 14, c2 26,
r1–r4 12, r5 60) and s10's 12 for f1. This is the one deviation from pure defaults that is not about
determinism: it bounds the cost of a runaway turn and keeps c1 comparable with the earlier records.

### 2.5 STOCK-COMPACT (a configured variant, secondary)

Because stock's shipped trigger is out of reach (§2.3), one more arm shows what native compaction
does when it does fire. It is a configured variant, labeled as such everywhere, and never enters
the decision (§7). Its overlay moves only the trigger and the retained tail to the values the host's
own formula and defaults give a 128K-class route: a 131,072-token window with an 8,192-token
output cap (the shape of the 131,072 / 8,192 catalog entry in the host's discovery tests):

- trigger floor(min(0.8 x 131,072, 131,072 − 8,192 − 65,536)) = **57,344 tokens**;
- retained tail floor(0.16 x (131,072 − 8,192)) = **19,660 tokens**.

On the 1M route this is `thresholdRatio` 0.057344 (1,000,000 x 0.057344 = 57,344 exactly in
float arithmetic) and `retainTokens` 19,660, set globally (not as a `modelPolicies` entry) so the
offline mock route resolves the same budgets. Headroom, summary cap, retries, overflow recovery
and the pruner stay at their defaults. In the live slicey session the largest request was 85K
tokens, so a 57K trigger is within the range real sessions reach.

## 3. Isolation and procedure

The harness of the F-only A/B, extended (§3.1 of [p110-f-native-ab.md](p110-f-native-ab.md)
describes the barrier in full): one cell at a time; per (task, rep) group the arms run back to
back, the first arm rotating with `(rep − 1 + seed)` (with three arms each arm goes first once in
three reps); `AB/vault` and the `scripts/` and `docs/` of every worktree under `AB/wt` are mode
000 while a turn runs; `AB`, `live/`, `patches/`, `mock/`, `plugins/`, `wt/` and `host/` are
read-only then; tamper evidence by mode, inode and ctime; per-cell homes, `TMPDIR` and workdirs
with arm-neutral names; stray processes killed before unblocking; new outside entries
quarantined; worktree `git status` unchanged during a cell. New in this run:

- `AB/plugins/` holds the step-cap row (read-only while a turn runs).
- f1's content and oracle values are generated at setup from `AB_TASK_SEED`, derived from a salt
  that lives only in the vault (`vault/task-seed-salt`, mode 600) plus (batch, task, rep): both
  arms of a group get identical files, and the oracle exists only in the workdir, the truth
  sidecar (in the vault while turns run) and the cell's own session log. No copy of f1's oracle
  exists anywhere a cell can read, unlike r1–r5's, whose values sit in readable copies of this
  repository (flagged by path and caught by content, as before).

Procedure:

1. Offline dry run of every task on every arm with the mock, forced-compaction runs, fingerprints,
   isolation probe (§10). Done.
2. Before the key is linked: remove every reachable copy of the r1–r5 oracles that is not part of a
   checkout (`AB/scratch`, `AB/build` and earlier scratch trees in the same scratchpad,
   `dsh021/…/scripts/ab/tasks`, `fab/…`); run the self-checks in a temporary directory only.
3. Operator links the key into the three template homes (`ln -s ~/.dsh/.env
   vault/homes/<arm>/.env`, never read, printed or copied).
4. Warmup: `hello` x 2 reps x 3 arms, `--fingerprints none`, then `run_ab.py fingerprints
   --compare` against the offline fingerprints (equal deltas and slice-tool shas keep or replace
   them, as in the F-only run). From rep 2 on, step 1 must read at least 4,000 cached tokens in
   SLICE and 2,000 in STOCK and STOCK-COMPACT (their prefix is 10,192 characters, about 2,500
   tokens).
5. Pilot (§12): f1 x 1 in STOCK-COMPACT, and r1–r5 and c2 x 1 in STOCK. Checks: oracles,
   delivery, flags, compaction firing and detected on the real model, per-blob tokens and f1's
   cost against §9.
6. Batch (§12): `--arms stock,slice,stock-compact --tasks f1,r1,r2,r3,r4,r5,c1,c2 --reps 3
   --reps-from-gates` (per-task reps from `gates-svs.json`: f1 2, the others 3), seed 20261023,
   `--budget-usd 10`. An invalid cell is rerun once.
7. Report: `svs_report.py <batch> --gates scripts/ab/gates-svs.json`; arbitration only as in §8.
8. Archive: `secrets-scan` first; held-back cells into a `chmod 700` `held-back/`; raw data to
   `~/Documents/kimi/workspace/dsh-slice/results/20261023-slice-vs-stock/`, small summaries to
   `docs/ab/slice-vs-stock-2026-10-23/`.

## 4. Tasks

Eight gated tasks plus the warmup. Five reuse the P1-10 recall tasks, two its coding tasks
(unchanged, files under [scripts/ab/tasks](../scripts/ab/tasks)), and one is new. In r1–r5 the
exam's fact reaches the model only in a tool result and the harness deletes its source before the
exam: STOCK keeps the raw tool result in its history, SLICE must get it back from its tape or a
recall tool. That is the trade the policy makes, so it is a fair test of both.

| alias | task | turns | step cap | class | what it tests |
|---|---|---|---|---|---|
| hello | `hello` | 1 | 4 | warmup | prefix cache, parity |
| **f1** | `svs_f1_flood_recall` (new) | 61 | 12 | long + memory | context growth over 48 full reads of large log excerpts; four early facts quizzed 50+ turns later |
| r1 | `p110_r1_fixture_fp` | 6 | 12 | memory | fingerprint printed once in T1; script and fixtures deleted after T2; same-format decoys; exam T5 |
| r2 | `p110_r2_superseded_stamp` | 7 | 12 | memory | stamp A (T2, stale) and stamp B (T4, current); sources deleted after T4; exam T6 must pick B |
| r3 | `p110_r3_runbook_middle` | 3 | 12 | memory | 28 KB runbook read in T1 (SLICE folds it; validity requires that fold in SLICE only); `docs/` deleted; exam T3 asks a second fact of the same read |
| r4 | `p110_r4_probe_compare` | 4 | 12 | memory | two probe outputs (T1, T2); `tools/` deleted; exam T4 needs one row of each |
| r5 | `p110_r5_initial_failures` | 2 | 60 | memory + coding | T1 fixes a red 400-test suite (5 bugs); T2 lists the tests that failed before any change |
| c1 | `lh1_incremental_build` | 8 | 14 | coding | 8 dependent turns building `calc.py` |
| c2 | `m3_consistency_bugfix` | 1 | 26 | coding | one invariant across 4 modules, single turn: pure overhead of the plugin's prefix and folds |

### 4.1 f1 in detail

Adapted from sliceagent's `s10_compactloss` (76 turns, one-shot build id, ephemeral lint error,
64 full reads of 9 KB random-letter blobs, three quizzes) and `s13_compact_amnesia` (deployment
parameters stated by the user, a placement rule, a never-given fact as a trap):

| turn | prompt | fact |
|---|---|---|
| T1 | the user states host 10.7.4.23, port 6311, token env `ORCHID_DEPLOY_KEY`, `retry_backoff_ms` 350, and the rule "deployment config only under `ops/`"; not to be written down; create `ops/.gitkeep`, reply with the host's last number | user-stated |
| T2 | read README and `core.py`, add `VERSION` | |
| T3 | run `python3 tools/inspect_build.py` once, as written; note the build id; do not write it down or repeat it; add `BUILD_CHECKED` (script and seed deleted after T3, delivery check T3) | tool output only |
| T4 | add `checksum` | |
| T5 | run `python3 tools/lint_frames.py`, fix the one finding, remember the exact message, do not write or quote it (linter deleted after T5, delivery check T5) | tool output only |
| T6 | add `clamp` | |
| T7–T22, T24–T39, T41–T56 | 48 turns: read `data/blob_NN.log` in full, append its `AUDIT-TOKEN` to `digest.md` | substrate |
| T23, T40 | add `window`, `median` | |
| T57 | Quiz A: the build id (exam, recall-sourced tokens) | |
| T58 | Quiz B: the exact lint message (exam) | |
| T59 | the four parameters as TOML, "where we agreed" (under `ops/`) | |
| T60 | the staging database "I told you about" (never given: `NOT-PROVIDED`) | |
| T61 | one line on how the facts came back; `SESSION_COMPLETE` | |

The excerpts are realistic service logs (timestamps, services, routes, statuses, request ids,
warnings and errors), 12,094–12,315 characters and about 95 lines each, 584K characters in all,
with the `AUDIT-TOKEN` line between 40 % and 60 % of the file. Six of them carry a deploy event with
another `bx-…` build id and three a CI lint finding in the same format as the real one (decoys);
neither real value occurs in any excerpt. All values are generated from the group's seed.

Oracle (`verify.py`): pass = substrate (seven names in `core.py`, `frames.py` fixed, all 48 tokens
in `digest.md`, both sources gone) and all four memory items correct. Items: `build_id` and
`lint_error` (correct, wrong, decoy, hedged, cannot_recover, missing); `deploy` (correct only with
all four values in a TOML file under `ops/`; misplaced; wrong); `trap` (correct = NOT-PROVIDED;
confabulated). The self-check covers each class (`selfcheck_tasks.py`, 40/40, §10).

## 5. Metrics

One row per cell from `ab_metrics.py`, as in the P1-10 records, plus:

- **Cost:** billed tokens of every committed request, every failed attempt and **every compaction
  summarizer call** (its usage sits on `compaction/summary`, not on an `assistant/message`; a
  failed compaction attempt is an unpriced record). Both sheets.
- **Cache hit rate:** hit / (miss + hit + cache write) over all billed input.
- **Context size:** per committed request, provider-reported prompt tokens (miss + hit + cache
  write); peak, mean, first, peak of the last turn; per-turn peak.
- **Native context management:** compaction summaries, failed attempts, prunes and pruned
  results with their turns, shadowed tokens, context-limit errors (`CONTEXT_WINDOW_EXCEEDED`
  anywhere outside message text), native spills; SLICE's folds counted apart from prune
  replacements.
- **Per exam:** recall sourcing (SLICE), leak and oracle via the file system (all arms), and
  whether history was compacted or pruned before the exam turn (post-compaction failures).
- Requests and steps per turn, step-cap cuts, closeouts, wall time, same-turn re-reads under the
  success-only mutation rule of the F-only A/B (reported only).
- **Memory items:** f1 four per cell (verify's `memory_classes`); r1–r5 one per cell (the exam
  class). Bad = wrong, decoy, stale, hedged or confabulated; CANNOT-RECOVER and missing are honest
  misses (not correct, not bad).

## 6. Pre-registered comparisons (SLICE against STOCK)

Unit: a (task, rep) pair whose two cells are both valid. Planned: 2 f1 pairs + 7 x 3 = 23 pairs; 23
memory items (f1 4 x 2, r1–r5 1 x 3 each).

- **P1 cost.** Per task R_t = Σcost(SLICE) / Σcost(STOCK) over the task's valid pairs.
  **L** = R_f1 (the long session); **N** = geometric mean of R_t over the seven short tasks (each
  task weighs the same, so c1's dollars do not swamp the others); G = geometric mean over all eight,
  the Σ ratio over all pairs (dollar-weighted) and the median paired ratio are reported.
- **P2 success.** dS = Σpass(SLICE) − Σpass(STOCK); dS_t per task.
- **P3 memory.** Over memory-eligible pairs: dM = correct items(SLICE) − correct items(STOCK);
  dB = bad items(SLICE) − bad items(STOCK). A pair is memory-ineligible when either cell had a
  flagged access up to its last exam turn, a leak of an answer-sufficient token before the exam,
  or an exam answer through the file system (the G2 exclusion of the P1-10 runs); it still counts
  for P1 and P2.

Minimum valid pairs: 19 of 23 overall; at least 2 per task (f1 2 of 2); at least 18 memory items.
Below a minimum the verdict is "inconclusive" unless the arbitration (§8) restores it.

## 7. Decision rule (ADR-style, pre-declared)

Quality floor **Q** holds iff dS ≥ −1, no task with dS_t ≤ −2, dM ≥ −1 and dB ≤ +1. "Slice
better" means dS ≥ +2 or dM ≥ +2 (with Q holding).

Rules, applied top to bottom; the first that matches decides:

| # | condition | verdict |
|---|---|---|
| 1 | a minimum not met | **inconclusive** |
| 2 | Q fails | **not worth it** |
| 3 | L ≤ 0.80 and N ≤ 1.10 | **worth it** |
| 4 | slice better, L ≤ 1.00 and N ≤ 1.10 | **worth it** |
| 5 | L ≥ 0.95 and N ≥ 1.00 | **not worth it** (no saving where the policy should save, none elsewhere) |
| 6 | N ≥ 1.25 and L > 0.80 | **not worth it** (large overhead on ordinary sessions without a large long-session saving) |
| 7 | otherwise | **inconclusive**; the case L ≤ 0.80 with N > 1.10 is reported as "a long-session saving bought with short-session overhead" |

Reading: a 20 % saving on the 61-turn session with no more than 10 % overhead on ordinary
sessions, at no loss of quality, is "worth it". No meaningful long-session saving with no saving
elsewhere, or any quality loss beyond one unit, is "not worth it". STOCK-COMPACT and every other
quantity of §5 are reported and never change the verdict. The verdict says what was observed on
these eight tasks, one model and one host, at n = 2–3 per task; it is not a claim of equivalence.

## 8. Arbitration (at most once, pre-declared)

Triggered on the batch, before pooling, if a minimum is not met, or the verdict would change when L
or N moved by 0.05 in either direction, or Q is decided at its margin (dS = −1 or −2, some dS_t =
−1 or −2, dM = −1 or −2, dB = +1 or +2). Then one arbitration batch: +1 rep of every task, SLICE and
STOCK only, seed 20261024, only if ledger spend plus its estimate ($1.3, §9) stays below the cap
minus the reserve; otherwise the batch verdict stands, marked unarbitrated. The decision is then
taken on the pooled batches with the same rules and thresholds, minimums unchanged, without the
band test; there is no second arbitration. `svs_report.py` prints whether arbitration is required.

## 9. Budget and cost estimate

Hard cap **$10 at peak prices** over everything (warmup, pilot, batch, arbitration), enforced by
`run_ab.py --budget-usd 10` over one ledger `AB/vault/spend.jsonl`; reserve $0.75, margin
$0.60, $0.05 per unpriced step or failed compaction attempt, stop after 40 unpriced charges. The
running turn is polled every second; a compaction summarizer call is visible to the poll only at
the turn's end (its usage is not in the `--json` stream), which the $0.60 margin covers (one
summary call: about 57K mostly cached input plus a few thousand output tokens, about $0.01 at peak).

Estimate (peak). Short tasks from the F-only A/B's medians for the slice control on 0.2.0-rc.2 (c1
$0.159, c2 $0.009, r1 $0.010, r2 $0.020, r3 $0.008, r4 $0.005, r5 $0.013: $0.224 per rep), with
STOCK and STOCK-COMPACT assumed 1.2x that. f1 from a token model: about 4,900 tokens added per
read turn (12.1K characters of log at about 2.8 characters per token, plus read framing and the
digest step), 3 requests per turn, 400 output tokens per request:

| item | STOCK | SLICE | STOCK-COMPACT | per rep |
|---|---|---|---|---|
| f1 | $0.48 (18M hit, 0.30M miss, 73K out; peak request about 250K tokens) | $0.19–0.31 (bounded context; the upper figure if the model expands every fold) | $0.47 (7–8 compactions, each re-missing about 22K tokens plus a summary call) | about $1.20 |
| seven short tasks | $0.27 | $0.22 | $0.27 | $0.76 |

| stage | estimate |
|---|---|
| warmup (hello x 2 x 3) | $0.01 |
| pilot (f1 x 1 STOCK-COMPACT; r1–r5, c2 x 1 STOCK) | $0.54 |
| batch: f1 2 reps x 3 arms + short 3 reps x 3 arms | $2.40 + $2.29 = $4.69 |
| arbitration, if triggered: +1 rep, SLICE and STOCK | $1.22 |
| **total** | **$5.24 without arbitration, $6.46 with** |

Uncertainty: f1's tokens per excerpt are estimated, not measured (±50 % moves the batch by about
±$1.2); c1 in the stock arms is assumed, not measured. The pilot measures both before the freeze
(§12.2).

## 10. Build evidence (offline, no key)

In progress on this commit; filled by the next commit of this branch.

## 11. Risks and limits

- **Stock's shipped compaction is out of reach.** The primary comparison is SLICE against a raw
  transcript that never compacts; it says nothing about sessions near 678K tokens. STOCK-COMPACT
  is the only evidence on compaction, at a configured trigger, and is secondary.
- **Cache across arms.** STOCK and STOCK-COMPACT send byte-identical prefixes and, before their
  first compaction, identical early requests apart from the workdir name; SLICE's prefix differs
  (3,651 vs 1,134 system characters, 16 vs 12 tools). A cell that runs right after another arm's
  cell can hit that arm's cached prefix. The first arm rotates (each arm first once per three reps),
  which balances the order effect over a task's reps but not inside a pair.
- **Low power.** n = 2 for f1 and 3 for the others; ratios move by ±10–20 % between reps of one
  arm in the F-only records. The decision uses thresholds 0.05 wide or wider and a band test for
  arbitration; it detects large effects only.
- **Task mix.** Seven short tasks and one long one; N weighs every short task equally and L is a
  single task. A different workload mix would weigh them differently; the per-task ratios are in
  the report.
- **f1's excerpts are synthetic** (realistic log text, but generated); real sessions mix reads,
  test output and edits, and a capable agent often avoids reading large files in full, which f1's
  prompts forbid.
- **The step cap** is a harness row in every arm (§2.4), not a host default.
- **Recall tasks favor neither arm by construction:** STOCK holds the raw tool output; SLICE must
  recall it. A wrong answer in STOCK is a reading failure in a long context; in SLICE it can also be
  a recall failure.
- **Oracle copies.** r1–r5's values sit in readable copies of this repository (the main checkout,
  other worktrees, other scratch trees); f1's do not. Access outside the workdir is flagged and
  makes the pair memory-ineligible.
- **External validity:** one host version, one model route, headless one-process-per-turn,
  hermetic composition (no web, subagents, skills or goals).

## 12. Frozen parameters and pilot (to be filled before the batch)

### 12.1 Parameters

To be recorded at the freeze: harness commit, host tree digest, fingerprints (§10), price sheet,
budget, commands with seeds.

### 12.2 Pilot rule (the only allowed change)

If the pilot's f1 cell costs more than $0.70 at peak (1.5x its estimate) or its tokens per read
turn exceed 7,000, f1 is resized before the freeze to keep the expected total at or below $7: the
number of excerpts drops from 48 to 32 (45 turns, still at least 40), with the quiz and exam turns
renumbered; nothing else changes. If a task cannot pass at all on STOCK in the pilot, it is fixed
here or dropped, and the minimums scale with the planned pairs.

## 13. Results

Empty until the batch and its report exist.
