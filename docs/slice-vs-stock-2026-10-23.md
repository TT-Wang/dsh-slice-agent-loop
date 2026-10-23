# Slice vs stock DSH: is the current slice context policy worth using?

> **Status: complete, 2026-10-23. Verdict (pooled, pre-registered rules): inconclusive: a
> long-session saving (L 0.611) bought with short-session overhead (N 1.167 > 1.10), at equal
> quality.** Spend $5.7403 at peak prices of the $10 cap. §13 holds the results, §14 the two
> independent verifications and how their findings were resolved, §15–§17 the fairness caveats,
> external validity and what would change the conclusion.
> §1–§12 are the frozen pre-registration (freeze commit `35df351`), unchanged since; no batch cell
> had run when it was made. Pilot part 1 (§12.3) stopped at the account balance (HTTP 402, 09:12
> UTC); the owner topped the account up, the pre-spend review's should-fix findings were fixed
> before more spend (§10.12), and pilot part 2 ran r5 in STOCK and SLICE and the resized f1 in
> STOCK-COMPACT (§12.6). Under the pilot rules f1 is 32 excerpts (45 turns) and STOCK-COMPACT runs
> f1 only (§12.4, §12.7).

## Summary in plain words

- **Question.** The slice plugin seals each finished turn into a short, frozen entry and gives the
  model tools to look up earlier details. Does turning it on make DeepSeek Harness (DSH) cheaper
  or better than leaving DSH's own context management at its shipped defaults?
- **What ran.** Eight tasks on the published DSH 0.2.1-rc.2 with its default model,
  deepseek-flash:
  - f1, one long session: 45 turns, 32 large log files read in full, then a quiz on facts from
    the first turns;
  - r1–r5, five short sessions (2–7 turns): a fact is shown once, its source is deleted, and the
    fact is asked for later;
  - c1 (8 turns) and c2 (1 turn), two ordinary coding tasks.

  Every task ran 3 or 4 times in each arm, in pairs on identical inputs: 62 runs in all. A
  configured variant ran 2 more. All 64 runs were valid on the first try; total spend was $5.74
  of the $10 cap.
- **Quality was the same.** Every slice and stock run passed its checker (31 of 31 pairs), and
  both arms recalled every early fact correctly (31 of 31).
- **Long session: slice was much cheaper.** On f1 slice cost 39 % less ($0.26 against $0.43 per
  session). Its requests peaked at about 43K tokens; stock's grew to about 234K.
- **Short sessions: slice cost more.** Over the seven short tasks slice cost 17 % more (each task
  weighted equally). On the 8-turn coding task it cost 59 % more, because it made about twice as
  many model requests.
- **Stock's own compaction never started.** At its shipped settings it starts near 678K tokens,
  which no affordable session reached, so stock was simply a growing transcript.
  - A configured variant started stock's compaction at 57K tokens. It cost 14 % less than plain
    stock on f1 but failed f1 in both runs: its pruning cut log excerpts before the model had
    copied what it needed.
  - Its memory of the early facts survived compaction.
- **Verdict, by the rule written before the runs: inconclusive.** The rule calls slice "worth it"
  only if it saves at least 20 % on the long session and costs at most 10 % more on the short
  ones. The first condition held (39 % saved) and the second did not (17 % more). Whether slice
  pays off therefore depends on the mix of work. In this run one f1-like session saved about as
  much as 2.8 c1-like coding sessions cost extra.
- **Cautions.**
  - The long-session saving comes from sending fewer cached tokens, so it depends on DeepSeek's
    price for a cached token: cheap, but not free. If cached tokens were free, slice would cost
    more on f1 as well (§16).
  - The longest session here was 45 turns. Real always-on agents run far longer, and stock's
    compaction would eventually start for them. That regime was not tested (§16).
  - Slice's extra cost on short work is measured. Its cause is not: the evidence points to more
    output and more re-reading, but no ablation separates the possible causes (§15).

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
| 2026-09-09 pressure-archive policy | stock vs slice | −12 % cost; superseded three days later by the append-only tape |
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
evaluation can afford stays below that: f1, the longest task, reaches about 232K tokens in STOCK
after the pilot resize (45 turns; projected from the pilot's measured 6,886 tokens per excerpt
read, §12.3; the 61-turn version would have reached about 343K). No compaction, prune or spill
fired in the pilot's STOCK cells. At these lengths STOCK is a raw, growing transcript, which is what a DSH user on the
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
output cap (the window and output cap of the 128K-class model the host's own catalog-discovery tests use):

- trigger floor(min(0.8 x 131,072, 131,072 − 8,192 − 65,536)) = **57,344 tokens**;
- retained tail floor(0.16 x (131,072 − 8,192)) = **19,660 tokens**.

On the 1M route this is `thresholdRatio` 0.057344 (1,000,000 x 0.057344 = 57,344 exactly in
float arithmetic) and `retainTokens` 19,660, set globally (not as a `modelPolicies` entry) so the
offline mock route resolves the same budgets. Headroom, summary cap, retries, overflow recovery
and the pruner stay at their defaults. In the live slicey session the largest request was 85K
tokens, so a 57K trigger is within the range real sessions reach.

An expected property of this variant, not corrected: once the 57,344-token trigger qualifies, the
shipped pruner replaces every tool result over 8,192 characters, the excerpt just read included,
before the model's next request. An excerpt of about 12,100 characters keeps its first 4,096 and
last 1,024 characters (0–34 % and 91.5–100 % of the file), and its `AUDIT-TOKEN` line sits at
40–60 %, so in a turn where the trigger fires the token is pruned before the model has written it
to `digest.md`. Expect re-reads and digest misses in STOCK-COMPACT's f1; the report lists f1's
missing digest tokens and same-turn re-reads per arm next to the pruned turns (§5). The primary
STOCK arm never reaches its trigger (§2.3), so this does not touch the decision.

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
2. Before the key is linked: the r1–r5 oracles have readable copies next to the A/B root, in the
   same session scratchpad: three task trees under `dsh021/` (`raft-cutover/slice-src`,
   `understand-packaging-deploy/compat-sim`, `…/slice-export`) and the F-only A/B root `fab/`, whose
   vault (session logs, truth files) is no longer blocked. They are not this run's files, so they
   are not deleted here: every entry next to the A/B root in the scratchpad (directories and files,
   never a symlink such as `node_modules`) is mode 000 while a turn runs, with the same tamper check
   as the vault. Pilot part 1 passed one `--block <dir>` per sibling directory by hand (31); since
   the pre-freeze fixes (§10.12) `run_ab.py --block-siblings` enumerates them at the start of each
   invocation, records them in the manifest (`isolation.siblings_blocked`), and a paid run refuses
   to start without the flag.
   `AB/scratch` and `AB/build` hold no oracle; they are moved into the vault (`vault/prekey/`,
   blocked while a turn runs) before the key is linked. The self-checks run in a temporary
   directory only.
3. Operator links the key into the three template homes (`ln -s ~/.dsh/.env
   vault/homes/<arm>/.env`, never read, printed or copied).
4. Warmup: `hello` x 2 reps x 3 arms, `--fingerprints none`, then `run_ab.py fingerprints
   --compare` against the offline fingerprints (equal deltas and slice-tool shas keep or replace
   them, as in the F-only run). From rep 2 on, step 1 must read at least 4,000 cached tokens in
   SLICE and 2,000 in STOCK and STOCK-COMPACT (their prefix is 10,192 characters, about 2,500
   tokens).
5. Pilot (§12), batch name `pilot`, seed 20261023 (its f1 content differs from the batch's,
   since the task seed derives from the batch name; pilot cells are never pooled with the batch):
   r1–r5 and f1 x 1 in STOCK and SLICE (one invocation), then f1 x 1 in STOCK-COMPACT unless the
   ladder of §12.2 would drop STOCK-COMPACT's f1 anyway on the costs measured so far. Checks:
   oracles, delivery, flags, compaction behaviour on the real model (none expected in STOCK and
   SLICE below 678,464 tokens; firing and detected in STOCK-COMPACT), tokens per read turn,
   cost per cell and wall time against §9; then the re-estimate of §12.2. Part 1 ran on
   2026-10-23 08:51–09:13 UTC and was stopped by the account balance (§12.3); part 2 ran 10:24–10:34 UTC (§12.6).
6. Batch (§12): as planned, `--arms stock,slice,stock-compact --tasks f1,r1,r2,r3,r4,r5,c1,c2
   --reps 3 --reps-from-gates` (per-task reps from `gates-svs.json`: f1 2, the others 3), seed
   20261023, `--budget-usd 10`. An invalid cell is rerun once. With the ladder step of §12.4
   (STOCK-COMPACT runs f1 only) the batch is two invocations into the same batch directory, f1
   first: `--arms stock,slice,stock-compact --tasks f1 --reps 2`, then `--arms stock,slice --tasks
   r1,r2,r3,r4,r5,c1,c2 --reps 3`; the freeze (§12.1) records the final commands.
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
| **f1** | `svs_f1_flood_recall` (new) | 45 (61 before the pilot resize, §12.4) | 12 | long + memory | context growth over 32 full reads of large log excerpts; four early facts quizzed 35+ turns later |
| r1 | `p110_r1_fixture_fp` | 6 | 12 | memory | fingerprint printed once in T1; script and fixtures deleted after T2; same-format decoys; exam T5 |
| r2 | `p110_r2_superseded_stamp` | 7 | 12 | memory | stamp A (T2, stale) and stamp B (T4, current); sources deleted after T4; exam T6 must pick B |
| r3 | `p110_r3_runbook_middle` | 3 | 12 | memory | 28 KB runbook read in T1 (SLICE folds it); validity in every arm: the T1 read carries the exam's fact (delivery); SLICE's fold is a reported manipulation check (§10.12); `docs/` deleted; exam T3 asks a second fact of the same read |
| r4 | `p110_r4_probe_compare` | 4 | 12 | memory | two probe outputs (T1, T2); `tools/` deleted; exam T4 needs one row of each |
| r5 | `p110_r5_initial_failures` | 2 | 60 | memory + coding | T1 fixes a red 400-test suite (5 bugs); T2 lists the tests that failed before any change |
| c1 | `lh1_incremental_build` | 8 | 14 | coding | 8 dependent turns building `calc.py` |
| c2 | `m3_consistency_bugfix` | 1 | 26 | coding | one invariant across 4 modules, single turn: pure overhead of the plugin's prefix and folds |

### 4.1 f1 in detail

Adapted from sliceagent's `s10_compactloss` (76 turns, one-shot build id, ephemeral lint error,
64 full reads of 9 KB random-letter blobs, three quizzes) and `s13_compact_amnesia` (deployment
parameters stated by the user, a placement rule, a never-given fact as a trap). The layout below is
the resized one of §12.4 (32 excerpts, 45 turns); the build-stage version had a third block of 16
reads (T41–T56) and the quizzes at T57–T61, and is what the pilot's f1 cells ran:

| turn | prompt | fact |
|---|---|---|
| T1 | the user states host 10.7.4.23, port 6311, token env `ORCHID_DEPLOY_KEY`, `retry_backoff_ms` 350, and the rule "deployment config only under `ops/`"; not to be written down; create `ops/.gitkeep`, reply with the host's last number | user-stated |
| T2 | read README and `core.py`, add `VERSION` | |
| T3 | run `python3 tools/inspect_build.py` once, as written; note the build id; do not write it down or repeat it; add `BUILD_CHECKED` (script and seed deleted after T3, delivery check T3) | tool output only |
| T4 | add `checksum` | |
| T5 | run `python3 tools/lint_frames.py`, fix the one finding, remember the exact message, do not write or quote it (linter deleted after T5, delivery check T5) | tool output only |
| T6 | add `clamp` | |
| T7–T22, T24–T39 | 32 turns: read `data/blob_NN.log` in full, append its `AUDIT-TOKEN` to `digest.md` | substrate |
| T23, T40 | add `window`, `median` | |
| T41 | Quiz A: the build id (exam, recall-sourced tokens) | |
| T42 | Quiz B: the exact lint message (exam) | |
| T43 | the four parameters as TOML, "where we agreed" (under `ops/`) | |
| T44 | the staging database "I told you about" (never given: `NOT-PROVIDED`) | |
| T45 | one line on how the facts came back; `SESSION_COMPLETE` | |

The excerpts are realistic service logs (timestamps, services, routes, statuses, request ids,
warnings and errors), about 12,100–12,300 characters and about 95 lines each (389K characters in
all for the self-check seed; 584K for the 48 excerpts of the build-stage version),
with the `AUDIT-TOKEN` line between 40 % and 60 % of the file. Six of them carry a deploy event with
another `bx-…` build id and three a CI lint finding in the same format as the real one (decoys);
neither real value occurs in any excerpt. All values are generated from the group's seed.

Oracle (`verify.py`): pass = substrate (seven names in `core.py`, `frames.py` fixed, all 32 tokens
in `digest.md`, both sources gone) and all four memory items correct. Items: `build_id` and
`lint_error` (correct, wrong, decoy, hedged, cannot_recover, missing); `deploy` (correct only with
all four values in a TOML file under `ops/`; misplaced; wrong); `trap` (correct = NOT-PROVIDED;
confabulated). Honest markers count with any case and separators ("Cannot recover", "CANNOT_RECOVER",
"Not provided"); the lint answer is correct when exactly one line names a lint code or the message
and that line contains the exact message (quotes, spaces and a trailing period normalized, so a
`frames.py: ` prefix or a code fence does not change it); a second candidate line hedges (pre-freeze
fix, §10.12). The self-check covers each class (`selfcheck_tasks.py`, 49/49, §10.12).

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
  whether history was compacted or pruned before the exam turn (post-compaction failures). Reported
  only, never an exclusion: a **partial leak** (f1: the id's `bx-` and first four hex digits, the
  lint code or the sentinel name in assistant text before the quiz, e.g. a T5 reply naming the
  binding it removed), shown next to recall sourcing.
- **Reported flags:** a cell with a failed compaction attempt has a cost that is a lower bound (the
  attempt is billed, its usage is never logged; the budget charges $0.05 for it); r3's T1 fold in
  SLICE (manipulation check); f1's missing digest tokens per arm.
- Requests and steps per turn, step-cap cuts, closeouts, wall time, same-turn re-reads under the
  success-only mutation rule of the F-only A/B (reported only).
- **Memory items:** f1 four per cell (verify's `memory_classes`); r1–r5 one per cell (the exam
  class). Bad = wrong, decoy, stale, hedged or confabulated; CANNOT-RECOVER and missing are honest
  misses (not correct, not bad).

## 6. Pre-registered comparisons (SLICE against STOCK)

Unit: a (task, rep) pair whose two cells are both valid. Planned: 2 f1 pairs + 7 x 3 = 23 pairs; 23
memory items (f1 4 x 2, r1–r5 1 x 3 each).

- **P1 cost.** Per task R_t = Σcost(SLICE) / Σcost(STOCK) over the task's valid pairs.
  **L** = R_f1 (the long session); **N** = geometric mean of R_t over the seven short sessions, five
  short recall sessions (r1–r5) and two coding sessions (c1, c2), each task weighing the same, so
  c1's dollars do not swamp the others; G = geometric mean over all eight, the Σ ratio over all
  pairs (dollar-weighted) and the median paired ratio are reported. Secondary, never decisive:
  N_recall (r1–r5 alone) and N_coding (c1, c2 alone).
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

Rules, applied top to bottom; the first that matches decides (`gates-svs.json` lists them in the
same order since §10.12; `svs_report.verdict` always did):

| # | condition | verdict |
|---|---|---|
| 1 | a minimum not met | **inconclusive** |
| 2 | Q fails | **not worth it** |
| 3 | L ≤ 0.80 and N ≤ 1.10 | **worth it** |
| 4 | slice better, L ≤ 1.00 and N ≤ 1.10 | **worth it** |
| 5 | L ≥ 0.95 and N ≥ 1.00 | **not worth it** (no saving where the policy should save, none elsewhere) |
| 6 | N ≥ 1.25 and L > 0.80 | **not worth it** (large overhead on the short sessions without a large long-session saving) |
| 7 | otherwise | **inconclusive**; the case L ≤ 0.80 with N > 1.10 is reported as "a long-session saving bought with short-session overhead" |

Reading: a 20 % saving on the long session (f1) with no more than 10 % overhead on the short
sessions (five recall, two coding), at no loss of quality, is "worth it". No meaningful long-session saving with no saving
elsewhere, or any quality loss beyond one unit, is "not worth it". STOCK-COMPACT and every other
quantity of §5 are reported and never change the verdict. The verdict says what was observed on
these eight tasks, one model and one host, at n = 2–3 per task; it is not a claim of equivalence.

## 8. Arbitration (at most once, pre-declared)

Triggered on the batch, before pooling, if a minimum is not met, or the verdict would change when L
or N moved by 0.05 in either direction, or Q is decided at its margin (dS = −1 or −2, some dS_t =
−1 or −2, dM = −1 or −2, dB = +1 or +2), or "slice better" is at its margin where it matters: Q
holds, rule 3 does not decide, L ≤ 1.00 and N ≤ 1.10, and max(dS, dM) is +1 or +2 (added before
the freeze, §10.12: without it a lucky +2 would decide rule 4 with no arbitration, while +1 gives
"inconclusive"). Then one arbitration batch: +1 rep of every task, SLICE and
STOCK only, seed 20261024, only if ledger spend plus its estimate ($1.3, §9) stays below the cap
minus the reserve; otherwise the batch verdict stands, marked unarbitrated. The decision is then
taken on the pooled batches with the same rules and thresholds, minimums unchanged, without the
band test; there is no second arbitration. `svs_report.py` prints whether arbitration is required.

## 9. Budget and cost estimate

Hard cap **$10 at peak prices** over everything (warmup, pilot, batch, arbitration), enforced by
`run_ab.py --budget-usd 10` over one ledger `AB/vault/spend.jsonl`; reserve $0.75, margin
$0.60, $0.05 per unpriced step or failed compaction attempt, stop after 40 unpriced charges. The
running turn is polled every second; a compaction summarizer call is visible to the poll only at
the turn's end (its usage is not in the `--json` stream), which the $0.60 margin covers: a typical
summary call (about 57K mostly cached input, a few thousand output tokens) costs about $0.01 at peak,
the worst case (the 65,536-token summary cap) about $0.09.

**The figures below are the build-stage estimate, kept for the record; the pilot measured f1 at
1.4x (SLICE) and about 2x (STOCK, projected) these figures, and the re-estimates of §12.4 and
§12.7 (after part 2, the frozen one) replace them.**

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
| pilot (r1–r5, f1 x 1 STOCK and SLICE; f1 x 1 STOCK-COMPACT) | $1.30 (declared before the pilot; the build stage's $0.54 was a smaller pilot) |
| batch: f1 2 reps x 3 arms + short 3 reps x 3 arms | $2.40 + $2.29 = $4.69 |
| arbitration, if triggered: +1 rep, SLICE and STOCK | $1.22 |
| **total** | **$6.00 without arbitration, $7.22 with** (with the build stage's pilot: $5.24 and $6.46) |

The total with arbitration exceeds the $7.00 planning target by $0.22 on these estimates; the
re-estimate of §12.2 decides on the pilot's measured costs, not on these figures.

Wall time: the F-only batch took 86 minutes for 42 cells; with 63 short-task cells and six f1 cells
of 61 turns (about 10–15 minutes each on the real model), the batch takes about 3.5–4 hours, run in
the background in several invocations (`--resume`), none of them longer than the operator's
session allows.

Uncertainty: f1's tokens per excerpt are estimated, not measured (±50 % moves the batch by about
±$1.2); c1 in the stock arms is assumed, not measured. The pilot measures both before the freeze
(§12.2). Measured (§12.3): an excerpt read adds 6,886 tokens to STOCK's request (12.1K characters
of log plus read framing and the digest step, about 1.8 characters per token: hex request ids
tokenize densely), with 5 requests per read
turn in STOCK and 5–7 in SLICE; c1 was not piloted and stays assumed.

## 10. Build evidence (offline, no key)

Harness `9d506ca` on `exp/slice-vs-stock` (the `offline` batch ran on its uncommitted tree, whose
metrics, validity and task code equal `9d506ca`'s; the commit added the tests, the report, the
README and `--reps-from-gates`). No key existed in any home; the mock adapter
(`scripts/ab/mock-llm.mjs`, provider `ab-mock`) scripted `ls`, a stated correction, a run of any
named `tools/` script, two reads of the first file the prompt names, and an `expand_result` on the
newest tape tool line (SLICE only). Summaries of everything below, with paths normalized and no
oracle values: [docs/ab/slice-vs-stock-2026-10-23/](ab/slice-vs-stock-2026-10-23/).

### 10.1 Prepare

- Frozen host `AB/host`: 0.2.1-rc.2, host tree digest `0c9e7f6b25ec…`, unchanged at the start and
  end of every batch below.
- Three template homes; `prepare` exit 0: SLICE differs from STOCK only in `slice-agent-loop`,
  STOCK-COMPACT only in `compaction-basic` (`dump-compare.json`). Dumps 412 / 415 / 417 lines
  (`dump-stock.yml`, `dump-slice.yml`, `dump-stock-compact.yml`). Against the bare headless
  composition (98 rows, 382 lines) the neutral overlay changes exactly the 13 rows of §2.4 and
  nothing else (row-level diff of the two dumps).
- Plugin install log: one pnpm peer-dependency warning (`Issues with peer dependencies found`), as
  with every recorded install (`autoInstallPeers: false`); the plugin row loads (16 tools, tape
  entries in every multi-turn SLICE cell).

### 10.2 Fingerprints (from `offline`, baseline STOCK)

| | STOCK | SLICE | STOCK-COMPACT |
|---|---|---|---|
| system prompt sha256 | `3f484053…` | `46c592c8…` | `3f484053…` |
| system prompt chars | 1,134 | 3,651 (+2,517: the plugin's kernel and fold sections) | 1,134 |
| tools | 12 | 16 (STOCK's plus the four recall tools) | 12 |
| all-tools JSON sha256 / chars | `acdb4d06…` / 9,058 | `197be823…` / 14,323 | `acdb4d06…` / 9,058 |
| recall tools JSON sha256 / chars | – | `4d9ca4cc…` / 5,266 | – |
| per-request prefix (system + tools) | 10,192 | 17,974 (+7,782) | 10,192 |
| tape header / tool line | – | short 76/78 chars / long, 94.9 chars mean | – |

SLICE's system prompt and recall-tool shas equal those of the F-only control on 0.2.0-rc.2
(`46c592c8…`, `4d9ca4cc…`), and its prefix equals the 17,974 characters recorded for plugin 0.3.0
on 0.2.1-rc.2 (scripts/ab/README.md): the plugin's prompt and tool text equal 70e6e55's.

### 10.3 Dry run `offline` (every task on every arm)

9 tasks (8 + hello) x 3 arms x 1 rep = 27 cells, one at a time, 07:39:01–07:54:43 UTC: 279/279
turns exited 0 with empty stderr, 27/27 logs found and metrics rows written, **27/27 cells valid on
the first attempt**, one turn per prompt everywhere; tools 12 / 16 / 12; no tape entry in any
STOCK or STOCK-COMPACT cell; every delivery turn carried its fact (r1 T1; r2 T2, T4; r4 T1, T2;
f1 T3, T5 in all three arms); r3's T1 read folded in SLICE; no flagged call, leak, breach,
quarantined entry or worktree change; host digest unchanged; $0.0744 on the mock's fixed usage
(its own ledger).

f1 per arm (61 turns each):

| | STOCK | SLICE | STOCK-COMPACT |
|---|---|---|---|
| requests | 236 | 296 (+60 `expand_result` steps) | 236 |
| compaction summaries (turns) | 0 | 0 | **3 (T26, T39, T52)**, 0 failed; 3 summarizer calls priced |
| prunes | 0 | 0 | **88**, at 15 turns from T14; a summary followed at only 3 of them (elsewhere pruning alone brought pressure under the trigger) |
| slice folds | 0 | 96 | 0 |
| exams with history compacted before them | 0 of 2 | 0 of 2 | 2 of 2 |
| wall | 202 s | 183 s | 180 s |

The mock's usage samples are smaller than the heuristic estimate, so the token meter used the
4-characters-per-token estimate: STOCK's f1 stayed under its 678,464-token trigger, STOCK-COMPACT's
crossed 57,344 repeatedly. This shows the configured trigger firing and every compaction and prune
event detected and attributed to its turn; the token figures themselves are the mock's.

### 10.4 Stock's shipped trigger, forced (`force-above`, `force-below`)

The shipped STOCK composition, f1, with the mock reporting a fixed input-token count on every
usage sample (`AB_MOCK_PRESSURE_TOKENS`), which the token meter reuses as pressure:

| batch | reported pressure | prunes (first turn) | summaries | failed attempts | valid |
|---|---|---|---|---|---|
| `force-below` | 670,007 (< 678,464) | 0 | 0 | 0 | yes, 61/61 turns exit 0 |
| `force-above` | 690,007 (> 678,464) | 96 (from T7, the first excerpt read) | 12 (T51–T56) | 34 | yes, 61/61 turns exit 0 |

So the shipped trigger sits between 670,007 and 690,007 tokens, as computed (678,464), and the
harness detects and times it. Under forced pressure the pruner acts at once (every excerpt read is
over 8,192 characters); summaries start only at T51, once the history outside the retained
119,040-token tail is large enough to condense. The 34 failed attempts are the host rejecting a
summary that was not smaller than its source ("summary is not smaller than the shadowed content")
while the forced pressure stays above the trigger; each is charged $0.05 as an unpriced record,
since its call is billed but not logged. Real pressure falls after a summary, so this repetition is
an artifact of forcing.

### 10.5 Step cap

A cap of 2 (`ab-step-cap`, harness mode) on a turn that wants three steps: turn_end kind `blocked`,
exit 1, in STOCK and in SLICE.

### 10.6 Isolation probe (`isoprobe`, target batch `offline`)

Per arm: 28 protected targets (canaries in the other arms' template homes, the vault root, a
manifest, a truth file and the `scripts/` and `docs/` of both worktrees; the other arms' real
finished cell homes, session logs and packed workdirs; the `offline` manifest, index and ledger; a
turn stream; `arms.json`, `fingerprints.json`; a task oracle in each worktree; listings): **28/28
denied, 0 canaries in any tool result**, the cell's own files readable, `AB/live` showing only the
probing cell, 2 background jobs killed as strays, 0 processes left and 0 escapees, **8/8 writes
into the read-only directories refused** (`plugins/` included), the `/tmp` plant quarantined. Tamper
cells: the vault chmod and the file left in a worktree's `src/` were detected and the cell was
invalid, in all three arms. Afterwards every mode was restored, `AB/live` empty, no
`.blocked.json`, both worktrees clean.

### 10.7 Dry run `offline2` (validated against the fingerprints)

Harness `9d506ca` (clean tree), 08:06:13–08:18:53 UTC, every cell validated against the
fingerprints of §10.2 (`vault/fingerprints.json`), run with `--reps 1 --reps-from-gates`: **27/27
cells valid on the first attempt**, 279/279 turns exit 0 with empty stderr, the same structure as
`offline` in every cell (f1: STOCK-COMPACT summaries at T26, T39 and T52 with 88 prunes, SLICE 96
folds, STOCK none); no flag, leak, breach, stray, quarantined entry or worktree change; host digest
unchanged; summed cell wall 742 s (920 s for `offline`). `svs_report.py` runs end to end on it and,
as it must on one rep, reports every minimum unmet, the verdict "inconclusive" and the arbitration
trigger ([report-offline2-mock.md](ab/slice-vs-stock-2026-10-23/report-offline2-mock.md); its cost
ratios come from the mock's fixed usage samples and mean nothing).

`run_ab.py secrets-scan` lists the three isolation-probe read cells (their script names `DSH_HOME`
by design) and no other cell; their logs and turn files go to `held-back/` at archive time.

### 10.8 Tests

On `9d506ca`: `test_run_ab.py` 23/23 (5 new: the row-level dump comparison, both step-cap patch
modes, exam specs from the truth sidecar, the salted per-group seed, per-arm validity);
`test_ab_metrics.py` 25 (2 new: compaction, prune and summarizer usage, compacted-before-exam):
21 pass and 4 skip without data, 22 pass and 3 skip with `AB_OFFLINE_BATCH=offline` and
`AB_GATES=gates-svs.json` (the mock-log check over all 27 cells, now per-arm tool counts and
summarizer usage); `test_ab_report.py` 14/14; `test_svs_report.py` 7/7 (each verdict route, the
arbitration band, memory exclusion and minimums, the honest-miss rule, pooled without band);
`selfcheck_tasks.py` 40/40 (15 new for f1: every memory class, the substrate checks, seeding);
typecheck, `check:docs` and `check:size` (3.02 MiB, 281 files) pass.

### 10.9 Not evidence

`smoke1` (hello and r1, three arms, before the f1 task existed in the run) and a scratch
plugin-add probe (`AB/scratch/plugadd`: the bare STOCK and SLICE dumps of §10.1, moved with
`AB/build` into `vault/prekey/` before the key was linked) are kept; they are build checks, not
part of any comparison. The same holds for the offline checks after the pilot (§10.10, §10.11).

### 10.10 Account stop (harness change after pilot part 1)

The pilot showed that the driver treated the provider's HTTP 402 "Insufficient Balance" (error code
`QUOTA`) like any infra failure: each cell was retried once, charged $0.05 per refused attempt as an
unpriced record (the refused requests are not billed), recorded as `invalid` (which `--resume`
skips) and the run went on to the next cell. In a 69-cell batch an exhausted balance would have
marked up to 20 cells invalid before the 40-charge stop. Now an infra turn whose code is
account-level (`QUOTA`, `ACCOUNT_QUOTA`, `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, `AUTH`) ends
its cell as `account_stop`: no retry, the attempt does not count against `--max-attempts`, the cell
is kept as `cells/<cell>.account_stop.json` (skipped by the report and the fingerprints), no
further cell starts, the run exits 2, and `--resume` reruns the cell. Transient codes (`TRANSPORT`,
`RATE_LIMIT`, `SERVER`, …) are retried as before. Measurement, validity and pricing are
unchanged.

Checked offline (`acct-offline`, mock with `AB_MOCK_QUOTA_FILE`, which makes every request end in a
`QUOTA` error while the named file exists): with the file present the first cell (r1, SLICE) ended
`account_stop` after turn 1, no other cell started, exit 2, "STOPPED (account)"; with the file
removed, `--resume` reran it as attempt 2 and completed the other three cells, exit 0. It ran on the
uncommitted tree whose harness code is `13ce512`. Unit tests:
`test_run_ab.py` 26/26 (3 new in `AccountStop`).

### 10.11 Resized f1, offline (`offline3-f1`)

f1 at 32 excerpts (§12.4) in all three arms with the mock, validated against the fingerprints:
3/3 cells valid on the first attempt, 45/45 turns each, delivery of T3 and T5 in every arm, exams
at T41 and T42; STOCK-COMPACT 2 summaries and 63 prunes, STOCK none, SLICE 64 folds; 104–108 s per
cell; run on the uncommitted tree whose code is `a300726`. `selfcheck_tasks.py` 40/40 on the resized task (32 tokens, every memory class, seeding,
decoys present, oracle absent from the excerpts).

### 10.12 Pre-freeze fixes (after pilot part 1, before pilot part 2)

Harness `74e0475`. The pre-spend review (12 should-fix findings, no must-fix) was answered before
any further paid call; every change applies to every arm alike:

| finding | change |
|---|---|
| f1 grading marks honest or exact answers as bad ("Not provided" → confabulated; "CANNOT RECOVER" with a space → wrong; the exact lint message with a `frames.py: ` prefix → wrong) | `verify.py`: markers with any case or separators; the lint answer correct when exactly one candidate line (a lint code or the message) contains the exact message, quotes, spaces and a trailing period normalized; a second candidate hedges (§4.1) |
| r3's validity asymmetric: SLICE's cell needed a fold of its T1 read, STOCK's had no T1 condition | r3 `meta.json` `delivery` T1 (the read carries the exam's fact) in every arm; `gates-svs.json` `fold: false` in every arm, the fold reported as a manipulation check (the P1-10 gates keep it required) |
| pilot rule (b) selects tasks on an outcome | replaced by a defect-only rule (§12.2 (b)); it had not fired under the old text |
| `gates-svs.json` rule order differs from §7 | "a minimum not met" is now rule 1 there too |
| the arbitration margin misses the "slice better" threshold | trigger added (§8; `svs_report.arbitration_needed`) |
| sibling blocking is a manual step | `run_ab.py --block-siblings`, required for a paid run (§3 step 2) |
| N described as "ordinary sessions" while five of its seven tasks are recall tasks | wording (§6, §7); N_recall and N_coding reported, never decisive |
| STOCK-COMPACT's pruner hides f1's audit token in trigger turns | stated as an expected property (§2.5); digest misses and re-reads reported per arm |
| a failed compaction attempt is billed but not logged | the report flags such cells' cost as a lower bound (§5) |
| a partial restatement of an f1 answer escapes the leak check | a reported, non-excluding partial-leak flag (§5) |
| SLICE never ran a multi-turn task on the real model before the batch; STOCK's caches warmed alone | answered by pilot part 1, which ran r1–r4 in both arms and f1 in SLICE (§12.3) |
| the 32-excerpt f1 was not built | built and checked offline before the pilot's decision was applied (§10.11) |

Checks, offline, no key linked during them:

- Tests: `test_run_ab.py` 29/29 (3 new in `BlockSiblings`: symlinks and the A/B root left out and
  modes restored; shared temp roots and the home directory refused; a paid run without the flag
  refused; the per-arm validity test now covers r3's delivery in both arms and the F-only gates'
  fold requirement); `test_ab_metrics.py` 26 (22 pass, 4 skip; 23 pass with
  `AB_OFFLINE_BATCH=…/offline2 AB_GATES=gates-svs.json`; 1 new, the partial leak);
  `test_svs_report.py` 10/10 (3 new: the "slice better" margin with and without rule 3 deciding,
  rule 1 before rule 2, the N split); `test_ab_report.py` 14/14; `selfcheck_tasks.py` 49/49 (9 new
  f1 grading cases); typecheck, `check:docs` and `check:size` (3.29 MiB, 305 files) pass.
- Re-evaluation of the finished cells of `pilot`, `offline2` and `offline3-f1` under the new code
  (metrics, specs and validity recomputed from the session logs; f1 regraded on the packed
  workdirs): every r3 cell delivers its fact at T1 in every arm (SLICE folded in all, STOCK and
  STOCK-COMPACT in none), no validity verdict changed except the 61-turn f1 cells, which no longer
  match the 45-turn task, as expected; the pilot's SLICE f1 keeps 4/4 items correct; no partial
  leak in any cell.
- Dry run `offline4-prefreeze` (`hello`, r3, f1 x 3 arms, mock, fingerprints checked,
  `--block-siblings`): 9/9 cells valid on the first attempt; 33 siblings blocked (part 1's 31
  directories, `svs-tools/` and the file `issue20-comment.md`; the `node_modules` symlink left out) and their modes restored; r3
  delivered at T1 in all arms, folded in SLICE only; f1 delivered at T3 and T5 in all arms,
  STOCK-COMPACT 2 summaries and 63 prunes; host unchanged.

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
- **f1 is resized by the pilot rule** (§12.4): 32 excerpts, 45 turns, STOCK's request peaking at
  about 232K tokens instead of about 343K. The long-session saving the policy can show is
  correspondingly smaller than at 61 turns; L ≤ 0.80 is still the bar.
- **SLICE re-reads every excerpt once through `expand_result`.** SLICE folds a large read inside
  its turn; f1's prompt demands that the whole excerpt pass before the model's eyes, so in the pilot
  the model expanded the fold in 48 of 48 read turns (50 `expand_result` calls in all), about one
  extra step and 1.5K extra missed tokens per read turn. A prompt that did not demand full reads
  might let SLICE skip that step; this is a property of the task, reported, not corrected.
- **STOCK's f1 quiz turns never ran on the real model.** The pilot's STOCK f1 stopped at T23 (the
  account balance); the batch's first STOCK f1 cell is the first real run of the quizzes over a
  long raw transcript. The oracle and turns are identical across arms and SLICE passed all four
  items in the pilot.

- **Known limitations kept after the review (§10.12).** STOCK's f1 cost per cell is still a
  projection ($0.511 at 45 turns), and its quiz turns have never run on the real model; c1 and
  c2 in STOCK are assumed at 1.2x SLICE's (§12.7). The grading fixes and the partial-leak flag were
  made after the pilot's SLICE f1 answers had been seen (all four correct under the old and the new
  grader) and before any STOCK f1 quiz ran; STOCK-COMPACT's pilot answers grade the same under both.
  Partial leaks are reported and never exclude. The r1–r5 oracle values also sit outside the
  scratchpad (repository copies, and the orchestrator's task-output directory next to it, which
  holds the review's text quoting r3's tokens); those are not blocked, and a read there is a
  flagged access that makes the pair memory-ineligible. `--block-siblings` lists the siblings at
  the start of each invocation; an entry created later is not blocked until the next one.

## 12. Frozen parameters and pilot

### 12.1 Parameters (frozen)

Recorded in the freeze commit, after pilot part 2 and before any batch cell;
[freeze.json](ab/slice-vs-stock-2026-10-23/freeze.json) holds the same in machine-readable form.

| parameter | frozen value |
|---|---|
| harness code | `scripts/ab` as committed in `74e0475` (tree `b111e434d10e`); the freeze commit changes only `docs/`. Every batch manifest's `harness_commit` must be the freeze commit or a later commit with the same `scripts/ab` tree, without `+dirty` |
| host | `@deepseek-ai/dsh@0.2.1-rc.2` in `AB/host`, host tree digest `0c9e7f6b25ec619cbfe60fc8a0df27f753f589fba9146a49b8718604776a824a` (unchanged through warm, pilot, warm2, pilot2) |
| model route | host default, `deepseek-official/deepseek-flash`, reasoning effort at the adapter default |
| slice tarball | `slice-main-c73ee22.tgz` (main `c73ee22`, plugin 0.3.0), sha256 `62b0eb7efc3d0d7011422da0388b5e5c0b78da48413e4c70f1ed15d43c32c322` ([SHA256SUMS](ab/slice-vs-stock-2026-10-23/SHA256SUMS)); installed copy `plugin-62b0eb7efc3d.tgz`, same hash |
| compositions | §2.2; dumps 412 / 415 / 417 lines, `dump-compare.json`; overlay `eval-neutral.patch.yml`, STOCK-COMPACT `stock-compact.patch.yml` (`thresholdRatio 0.057344`, `retainTokens 19660`) |
| fingerprints | `AB/vault/fingerprints.json` (sha256 `bd770eeb…`; the committed copy differs only in normalized paths): system prompt `3f484053…` / `46c592c8…`, tools 12 / 16, prefix 10,192 / 17,974 characters |
| price sheets | `scripts/ab/prices.json`: off-peak miss $0.22, hit $0.007, output $0.66 per million tokens; peak $0.44, $0.014, $1.32; the budget prices at peak |
| budget | `--budget-usd 10` over `AB/vault/spend.jsonl` (all stages), reserve $0.75, margin $0.60, $0.05 per unpriced charge, stop after 40 |
| seeds | batch 20261023 (batch name `batch`; f1's content derives from the vault salt plus batch, task and rep), arbitration 20261024 (batch name `arb`) |
| tasks and reps | f1 (`svs_f1_flood_recall`, 32 excerpts, 45 turns, exams T41 and T42) 2 reps; r1, r2, r3, r4, r5, c1, c2 3 reps each (`gates-svs.json` `unit.reps`) |
| arms | SLICE and STOCK on every task; STOCK-COMPACT on f1 only (§12.7) |
| comparisons | §6: L = R_f1, N = geometric mean of R_t over r1–r5, c1, c2; dS, dS_t; dM, dB over memory-eligible pairs; secondary G, Σ ratio, median paired ratio, N_recall, N_coding, STOCK-COMPACT against STOCK and SLICE |
| minimum valid pairs | 19 of 23 overall, 2 per task (f1 2 of 2), 18 memory items of 23 |
| decision | §7 rules 1–7, quality floor Q and "slice better" as stated there; `gates-svs.json` `decision` |
| arbitration | §8, at most once, +1 rep of every task in SLICE and STOCK, only if ledger spend + its estimate ($1.3, §8; $1.28 in §12.7) stays below the cap minus the reserve ($9.25) |
| validity | `gates-svs.json` `validity` (§10.12: r3 by delivery in every arm; fold reported) |

Commands (from `AB`; `H=$AB/wt/harness/scripts/ab`, `G=$H/gates-svs.json`; key linked in the three
template homes; an invalid cell is rerun once by `--max-attempts 2`):

```sh
# batch, invocation 1: f1 first, three arms
python3 $H/run_ab.py --ab-root $AB --gates $G --budget-usd 10 --block-siblings \
  --arms stock,slice,stock-compact --tasks f1 --reps 2 --batch batch --seed 20261023
# batch, invocation 2: the seven short tasks, SLICE and STOCK
python3 $H/run_ab.py --ab-root $AB --gates $G --budget-usd 10 --block-siblings \
  --arms stock,slice --tasks r1,r2,r3,r4,r5,c1,c2 --reps 3 --batch batch --seed 20261023
# after a budget, account or crash stop: the same command plus --resume
# report and the arbitration test
python3 $H/svs_report.py $AB/vault/results/batch --gates $G --ledger $AB/vault/spend.jsonl \
  --fingerprints $AB/vault/fingerprints.json
# only if the report says "arbitration: required" and the budget condition of §8 holds
python3 $H/run_ab.py --ab-root $AB --gates $G --budget-usd 10 --block-siblings \
  --arms stock,slice --tasks f1,r1,r2,r3,r4,r5,c1,c2 --reps 1 --batch arb --seed 20261024
python3 $H/svs_report.py $AB/vault/results/batch $AB/vault/results/arb --pooled --gates $G \
  --ledger $AB/vault/spend.jsonl --fingerprints $AB/vault/fingerprints.json --out $AB/vault/results/arb
```

Run order inside an invocation: the (task, rep) groups shuffled per rep with the seed, the arms of a
group back to back, the first arm rotating with (rep − 1 + seed): f1 rep 1 SLICE, STOCK-COMPACT,
STOCK; rep 2 STOCK-COMPACT, STOCK, SLICE; short tasks SLICE first in reps 1 and 3, STOCK first in
rep 2; arbitration STOCK first.

### 12.2 Pilot rules (the only allowed changes)

Declared before any paid call; applied after the pilot and before the freeze.

**(a) f1 resize.** If the pilot's STOCK f1 cell costs more than $0.70 at peak (1.5x its estimate)
or STOCK's request size grows by more than 7,000 tokens per excerpt-read turn (mean over T7–T56),
f1 is resized before the freeze: the number of excerpts drops from 48 to 32 (45 turns, still at
least 40), with the quiz and exam turns renumbered; nothing else changes.

**(b) Task defects only** (replaced before the freeze, §10.12; the build-stage text selected
tasks on an outcome, "a task that cannot pass at all on STOCK"). A task is fixed or dropped only for
a defect found in the logs or the code that holds in every arm by construction: a setup or oracle
error, a fact the task makes undeliverable, a prompt the harness cannot run as written, or an
infra failure; never for a model's failure to pass in any arm. Only then do the minimums scale with
the planned pairs.

**(c) Re-estimate and cost ladder.** After the pilot the projected total is P = ledger spend so
far + batch estimate + arbitration estimate (§8, SLICE and STOCK, +1 rep), all at peak, with:
f1 and r1–r5 per arm at the pilot's measured cost per cell (STOCK-COMPACT's r1–r5 at STOCK's; its
f1 at STOCK's f1 x 1.0 if it was not piloted); c1 and c2 in SLICE at §9's figures ($0.159,
$0.009) and in the stock arms at those x max(1.2, the pilot's ΣSTOCK/ΣSLICE over r1–r5). If
P > $7.00, the steps below apply in order, P is recomputed after each, and the first that brings P
to $7.00 or less is the last applied:

1. STOCK-COMPACT runs f1 only (its seven short-task cells are dropped; it is secondary, §2.5);
2. (a)'s f1 resize, if not already applied;
3. STOCK-COMPACT is dropped;
4. the arbitration batch drops f1 (short tasks only; the pooled f1 minimum stays 2 pairs).

If P is still above $8.65 (cap − reserve − margin), no batch runs and the record says so. The
primary design (SLICE and STOCK, f1 2 reps, the seven short tasks 3 reps, 23 pairs, the minimums
of §6) is never reduced by (c).

### 12.3 Pilot part 1 (2026-10-23, 08:49–09:13 UTC, peak hours)

The key was linked at 08:49 UTC into the three template homes (`ln -s ~/.dsh/.env`, never read).
Harness `d3da709` (the pilot plan and the ladder above, declared before any paid call; code as
`9d506ca`). Every paid run passed `--block` for each sibling directory of the A/B root in the
scratchpad (31 directories, never the `node_modules` symlink); `AB/scratch` and `AB/build` had
been moved into `vault/prekey/`. Summary data: [pilot.json](ab/slice-vs-stock-2026-10-23/pilot.json).

**Warmup** (`warm`, `hello` x 2 reps x 3 arms, seed 20261023, `--fingerprints none`): 6/6 valid,
$0.0038. From rep 2, step 1 read 4,480 cached tokens in SLICE (minimum 4,000) and 2,688 in STOCK
and in STOCK-COMPACT (minimum 2,000). `fingerprints --compare` against the offline fingerprints:
nothing changed, no delta mismatch (system prompt `3f484053…` / `46c592c8…`, 12 / 16 tools, prefix
10,192 / 17,974 characters): the empty persona keeps the prefix independent of the route. In
provider tokens the request prefix is 2,992 (STOCK) and 4,826 (SLICE, +1,834).

**Pilot** (`pilot`, seed 20261023, `--arms stock,slice --tasks r1,r2,r3,r4,r5,f1 --reps 1`; f1 at
its build-stage size, 61 turns). Costs at peak:

| task | arm | outcome | cost | requests | peak / mean request (tokens) | cache hit | wall |
|---|---|---|---|---|---|---|---|
| r1 | SLICE | pass (recall: `expand_result`) | $0.0103 | 18 | 11,352 / 8,467 | 94.2 % | 47 s |
| r1 | STOCK | pass | $0.0092 | 20 | 11,668 / 7,908 | 94.5 % | 45 s |
| r2 | SLICE | pass (recall: `expand_result` x 2) | $0.0234 | 30 | 14,601 / 10,183 | 95.2 % | 89 s |
| r2 | STOCK | pass | $0.0286 | 28 | 25,009 / 14,252 | 97.1 % | 103 s |
| r3 | SLICE | pass (recall: `recall_step`; T1 read folded) | $0.0080 | 14 | 12,570 / 7,064 | 89.8 % | 29 s |
| r3 | STOCK | pass | $0.0090 | 15 | 12,677 / 10,194 | 94.0 % | 32 s |
| r4 | SLICE | pass (recall: `expand_result` x 2) | $0.0050 | 13 | 6,874 / 5,810 | 95.1 % | 27 s |
| r4 | STOCK | pass | $0.0063 | 13 | 7,079 / 4,827 | 94.9 % | 33 s |
| f1 (61) | SLICE | pass, 4 of 4 memory items correct (build id and lint message recall-sourced) | $0.4191 | 308 | 69,136 / 35,402 | 96.0 % | 700 s |
| f1 (61) | STOCK | refused at T23 (see below); T1–T22 completed | $0.1431 (T1–T22) | 104 | 119,214 at T22 | 98.0 % | 209 s |
| r5 | SLICE, STOCK | refused at T1 in both attempts | – | – | – | – | – |

Every completed cell was valid on its first attempt: delivery of every delivery turn, r3's fold
in SLICE, no flagged call, leak or oracle via the file system, and no compaction, prune, native
spill or context-limit error in any cell. STOCK answered every exam from its raw history.

f1 in detail. STOCK's request grew by **6,886 tokens per excerpt read** (9,035 at T6, 119,214 at
T22, each read turn +6,500 to +7,150), with exactly 5 requests in every read turn; the cost of a
read turn rose from $0.0050 (T7) to $0.0120 (T22), $0.00048 more per read. SLICE's request stayed
bounded: 15,239 at T7, 28,329 at T22, 64,586 at T56 (about 1,030 more per read turn: one tape entry
per sealed turn), 69,136 at its peak (T58). SLICE needed 5–7 requests per read turn: it folds each
excerpt read inside its turn, and the model then called `expand_result` on the fold in 48 of 48 read
turns (§11); per read turn SLICE missed about 8,400 tokens (STOCK 6,900) and wrote about 1,000
output tokens (STOCK 560). Projected over the full 61 turns, STOCK's f1 would have cost **$0.935**
(linear fit of the 16 measured read turns; the coding and quiz turns at 5 requests over the full
context, about 343K tokens at T57), against SLICE's measured $0.419.

**The account balance.** From 09:12:59 UTC every request was refused with HTTP 402 "Insufficient
Balance" (code `QUOTA`): STOCK f1 at T23 (after one billed request), its retry at T1, and r5 in
both arms, both attempts, at T1. The driver retried and moved on (fixed afterwards, §10.10). The
ledger holds **$0.9663** at peak for warmup and pilot, of which $0.30 are six $0.05 unpriced
charges for refused requests that were not billed (priced usage $0.666); the ledger is not edited.
No paid call can run until the owner tops up the account.

### 12.4 Decisions under §12.2, taken on part 1

**(a) fires: f1 is resized to 32 excerpts (45 turns).** STOCK's f1 cell did not finish, so its
cost is established by projection from its 22 measured turns, not by a completed cell: $0.935
> $0.70. The projection stays above $0.70 unless the model's requests per turn fell from the
observed 5 to about 3.2 or fewer for all 39 remaining turns (32 of them reads; a read turn needs at
least 3: the read, the append and the reply). The token condition does not fire (6,886
< 7,000). The ladder of (c) leads to the same resize on its own: with 61-turn f1, P is $9.70, and $8.89
after step 1. The resized task is §4.1 (prompts T41–T56 of the build-stage version removed, the
quizzes renumbered T41–T45, `N_BLOBS` 32, exams T41 and T42); nothing else in f1 changed (offline
checks §10.11).

**(b)** No task failed in STOCK: r1–r4 passed in both arms. r5 has not run in either arm on this
host (part 2), and STOCK's f1 quiz turns have not run on the real model (§11). The rule was later
replaced by the defect-only text of §12.2 (§10.12); under either text nothing is fixed or dropped.

**(c) Provisional, to be recomputed after part 2.** Inputs at peak: spend $0.966; f1 per cell at
45 turns: STOCK $0.511 (the projection above at 32 reads; peak request about 232K tokens), SLICE
$0.275 (the pilot's measured costs of T1–T6, its first 32 read turns, T23, T40 and the five quiz
turns), STOCK-COMPACT at STOCK's $0.511 (not piloted, as the rule says); short tasks per rep: SLICE
$0.228 (r1–r4 measured, $0.047; r5, c1, c2 at §9's $0.013, $0.159, $0.009), STOCK and STOCK-COMPACT
$0.270 (r1–r4 measured, $0.053; r5, c1, c2 at x 1.2, since the pilot's ΣSTOCK/ΣSLICE over r1–r4 is
1.135).

| ladder | batch | arbitration | P |
|---|---|---|---|
| full design, f1 resized by (a) | $4.897 | $1.284 | $7.147 |
| step 1: STOCK-COMPACT runs f1 only | $4.087 | $1.284 | **$6.337** |

So, on part 1, step 1 applies: STOCK-COMPACT runs f1 only (2 cells); SLICE and STOCK keep the
primary design (f1 2 reps, the seven short tasks 3 reps, 23 pairs). With part 2 run and
STOCK-COMPACT's f1 measured at about the modelled $0.44, P is about $6.7 after step 1; if its
measured f1 cost exceeds about $0.55, step 3 (STOCK-COMPACT dropped) applies too.

### 12.5 What remained before the freeze (as planned after part 1)

The owner tops up the account; the review's should-fix findings are fixed (§10.12); pilot part 2
(batch `pilot2`): r5 in STOCK and SLICE, then the resized f1 in STOCK-COMPACT; (c) recomputed; the
freeze commit fills §12.1. All done (§12.6, §12.7).

### 12.6 Pilot part 2 (2026-10-23, 10:24–10:34 UTC, peak hours)

Harness `74e0475` (the fixes of §10.12), every paid run with `--block-siblings` (33 entries); the
key linked again into the three template homes after the offline checks. Summary data:
[pilot2.json](ab/slice-vs-stock-2026-10-23/pilot2.json) (scanned for oracle values: none).

**Warmup** (`warm2`, `hello` x 1 rep x 3 arms, validated against the fingerprints): the account
works; 3/3 valid, $0.0006. Step 1 read 4,480 cached tokens in SLICE and 2,688 in STOCK and
STOCK-COMPACT, the same as part 1's rep 2 (minimums 4,000 and 2,000): the provider still held each
arm's prefix, and the fingerprints are unchanged.

**Pilot part 2** (`pilot2`, seed 20261023):

| task | arm | outcome | cost (peak) | requests | peak / mean request (tokens) | cache hit | wall |
|---|---|---|---|---|---|---|---|
| r5 | SLICE | pass (failing list exact; recall `expand_result`; 1 fold) | $0.0101 | 11 | 15,567 / 9,266 | 87.4 % | 30 s |
| r5 | STOCK | pass (failing list exact, from raw history) | $0.0137 | 11 | 23,048 / 15,163 | 88.8 % | 30 s |
| f1 (45) | STOCK-COMPACT | **fail on substrate**: 6 of 32 digest entries wrong; all 4 memory items correct | $0.3380 | 216 | 59,307 / 41,885 | 95.4 % | 471 s |

Every cell valid on its first attempt, no flagged access, leak, partial leak or oracle via the file
system. In r5 neither arm compacted or pruned.

STOCK-COMPACT's f1 on the real model: the request grew by about 6,400 tokens per excerpt read
(14,179 at T7, 59,139 at T14; STOCK's part-1 cell, on other seeded content, 6,886); native context
management first acted at T14 (the 57,344-token trigger): 31 of the 32 excerpt results pruned, in
13 turns (8 at once at T14, then T18, T20–T22, T26–T28, T31, T33, T36–T38), and 4 summaries (T22,
T28, T34, T38; 4 summarizer calls priced, 0 failed attempts, 47,698 shadowed tokens); after T14 the
request stayed between 39K and 59K tokens; 5 requests in every read turn, as in STOCK; no
context-limit error. The 6 wrong digest entries are the excerpts read at T22, T26, T28, T33, T36
and T38, each an 8-character value that is no excerpt's audit token: exactly the turns in which
the pruner replaced the excerpt just read at the very next step, so the model never saw its middle
(§2.5). In the other 7 pruned turns the prune came one step later, after the model had seen the
whole excerpt once, and the entry is right. The four memory
items, all asked after the summaries (`compacted_before` true at both exams), were answered
correctly; the model's note says it remembered them. Graded the same by the build-stage grader
(`f8d47f3`).

### 12.7 Decisions on part 2 and the recomputed ladder

**(a)** Applied in part 1 (f1 at 32 excerpts, 45 turns); nothing new.

**(b)** No task defect: r5 passed in both arms; STOCK-COMPACT's digest misses are the configured
variant's expected pruning (§2.5), not a defect of f1, and STOCK-COMPACT never decides. Nothing is
fixed or dropped.

**(c)** Inputs at peak: ledger $1.3287 (warm $0.0038, pilot $0.9624, warm2 $0.0006, pilot2
$0.3618; $0.30 of it the six unbilled refusals of part 1); r1–r5 measured, ΣSTOCK $0.0667 and
ΣSLICE $0.0569 (ratio 1.174, so c1 and c2 in STOCK at 1.2x: $0.191 and $0.011); short tasks per
rep SLICE $0.2249, STOCK $0.2683; f1 per cell STOCK $0.511 (part 1's projection, §12.4), SLICE
$0.275 (§12.4), STOCK-COMPACT $0.338 (measured).

| ladder | batch | arbitration | P |
|---|---|---|---|
| full design (f1 resized by (a)) | $4.533 | $1.279 | $7.140 |
| **step 1: STOCK-COMPACT runs f1 only** | **$3.728** | **$1.279** | **$6.335** |
| step 3: STOCK-COMPACT dropped (not applied) | $3.052 | $1.279 | $5.660 |

P exceeds $7.00 only for the full design, so step 1 is the last step applied: STOCK-COMPACT runs f1
only (2 cells) and is kept, since its measured f1 ($0.338) is below the $0.55 at which step 3 would
apply. SLICE and STOCK keep the primary design. Expected total with arbitration $6.34, without
$5.06; the cap stays $10 at peak. The largest single uncertainty is STOCK's f1, still a projection:
at $0.65 per cell instead of $0.511, P would be about $6.75.

## 13. Results

Written after the batch and the arbitration; §1–§12 are unchanged. Every number below comes from
the frozen instrument (`svs_report.py` at the freeze tree) unless it is marked *reported only,
not pre-registered*. After the two independent verifications (§14), five statements in §13.5,
§13.6 and §13.8 were corrected and one in §13.7 was qualified (§14.2). The tables of §13.3 and
§13.4 were extended from the committed per-cell rows (`cells.json`) with both price sheets and
per-task context rows. No pre-registered number changed.

### 13.1 Runs

| batch | command (§12.1) | time (UTC, 2026-10-23, peak hours) | cells | valid on attempt 1 | spend (peak) |
|---|---|---|---|---|---|
| `batch`, invocation 1 | f1, `stock,slice,stock-compact`, 2 reps, seed 20261023 | 10:43–11:30 | 6 | 6 | $2.0429 |
| `batch`, invocation 2 | r1–r5, c1, c2, `stock,slice`, 3 reps, seed 20261023 | 11:30–13:00 | 42 | 42 | $1.2658 |
| `arb` (§8) | all eight tasks, `stock,slice`, 1 rep, seed 20261024 | 13:01–13:42 | 16 | 16 | $1.1029 |

- Every manifest: harness `35df351` (the freeze commit, `scripts/ab` tree `b111e434`, not dirty),
  host tree digest `0c9e7f6b25ec…` at start and end (unchanged), 33 siblings blocked, every cell
  checked against the frozen fingerprints.
- **Infra reruns: none.** All 64 cells were valid on their first attempt; no cell needed the
  second attempt `--max-attempts 2` allows. One turn (r2 rep 1 STOCK, T7) had one failed provider
  request that the host retried inside the turn; the budget charged it $0.05 as unpriced (the 7th
  unpriced charge of 40 allowed). The cell's metric cost ($0.0156 at peak) is its priced tokens;
  the failed request's usage was never logged.
- **Spend:** ledger total **$5.7403** at peak prices of the $10 cap (warm $0.0038, pilot $0.9624,
  warm2 $0.0006, pilot2 $0.3618, batch $3.3087, arb $1.1029); $0.30 of it are the six unbilled
  refusals of pilot part 1 and $0.05 the unpriced attempt above. Projected at the freeze (§12.7):
  $6.34 with arbitration.
- **Arbitration** was required by the batch report ("verdict moves to 'worth it' at L 0.645, N
  1.091": N within 0.05 of the 1.10 threshold) and allowed by §8 ($4.6374 spent + $1.3 estimate <
  $9.25). It ran once, as pre-declared; there is no second one.

### 13.2 Decision (pooled batch + arb, §7)

| quantity | batch alone | pooled (decides) |
|---|---|---|
| valid pairs (min 19; 2 per task) | 23 | 31 |
| memory items (min 18) | 22 | 31 |
| **L** = R_f1 | 0.645 | **0.611** |
| **N** = geo-mean R over r1–r5, c1, c2 | 1.141 | **1.167** |
| N_recall (r1–r5) / N_coding (c1, c2), secondary | 1.091 / 1.276 | 1.131 / 1.261 |
| G (all eight) / Σ ratio (dollar-weighted) / median paired ratio, secondary | 1.063 / 0.935 / 1.108 | 1.076 / 0.875 / 1.152 |
| dS (passes SLICE − STOCK); any dS_t | 0; all 0 | **0**; all 0 |
| dM (correct items) / dB (bad items) | 0 / 0 | **0 / 0** |
| quality floor Q / "slice better" | holds / no | holds / no |
| verdict | inconclusive, arbitration required | **inconclusive** |

**Verdict: inconclusive** (rule 7, the case the record names "a long-session saving bought with
short-session overhead"): every minimum is met, Q holds, L ≤ 0.80 but N > 1.10, so rule 3 does
not decide; "slice better" does not hold (dS 0, dM 0), so rule 4 does not; L < 0.95, so rule 5
does not; N < 1.25, so rule 6 does not. The arbitration moved both quantities away from the
thresholds (L 0.645 → 0.611, N 1.141 → 1.167). The arbitration batch alone (8 pairs, below every
minimum, descriptive) gave L 0.551 and N 1.234.

### 13.3 Per task (pooled; cost at peak per cell, mean over the task's pairs)

| task | pairs | SLICE $ | STOCK $ | R_t (Σ ratio) | paired ratios (batch r1–r3, arb) | pass SLICE / STOCK | memory correct SLICE / STOCK |
|---|---|---|---|---|---|---|---|
| f1 (45 turns) | 3 | 0.2619 | 0.4287 | **0.611** | 0.560, 0.764, 0.551 | 3 / 3 | 12 / 12 |
| r1 | 4 | 0.0094 | 0.0121 | 0.777 | 0.635, 0.618, 1.432, 0.759 | 4 / 4 | 4 / 4 |
| r2 | 4 | 0.0196 | 0.0215 | 0.909 | 1.108, 0.722, 0.704, 1.397 | 4 / 4 | 3 / 3 (1 pair excluded) |
| r3 | 4 | 0.0091 | 0.0070 | 1.292 | 0.864, 1.023, 1.805, 1.565 | 4 / 4 | 4 / 4 |
| r4 | 4 | 0.0058 | 0.0042 | 1.363 | 1.673, 1.272, 1.152, 1.400 | 4 / 4 | 4 / 4 |
| r5 | 4 | 0.0155 | 0.0104 | 1.488 | 1.476, 2.052, 1.107, 1.279 | 4 / 4 | 4 / 4 |
| c1 | 4 | 0.1624 | 0.1023 | **1.587** | 2.117, 1.510, 1.450, 1.389 | 4 / 4 | – |
| c2 | 4 | 0.0087 | 0.0087 | 1.001 | 1.175, 1.009, 0.813, 1.055 | 4 / 4 | – |
| all pairs | 31 | Σ $1.7073 | Σ $1.9513 | 0.875 | | 31 / 31 | 31 / 31 |

All 62 SLICE and STOCK cells passed their oracle (STOCK-COMPACT's two f1 cells failed, §13.5). On the
memory tasks both arms answered every eligible item correctly; no item was wrong, a decoy, stale,
hedged or confabulated in either arm. SLICE took every exam answer from its tape or a recall tool
(recall-sourced 6/6 f1 exams and 4/4 per r-task); STOCK answered from its raw history. One pair
is memory-ineligible: r2 batch rep 3, where SLICE, at the exam turn T6, ran `find ..` for the
deleted `stamp.py` and `service.env` outside its workdir (2 flagged calls; it then answered
correctly); the pair still counts for P1 and P2. SLICE's f1 cells show two exams with a partial
leak before them (reported only, never an exclusion), STOCK-COMPACT's one. r3's T1 read was
folded in SLICE in 4 of 4 cells (manipulation check).

**Both price sheets.** The off-peak and peak sheets are exactly proportional: peak is twice
off-peak in every field (§2.1). Every ratio is therefore the same on both. Priced from the logged
tokens, R_t agrees to every digit. The frozen report computes its ratios from off-peak cell costs
rounded to 6 decimals, so its fourth decimal can differ by 1 (§14.2). Mean cost per cell over
the task's pairs, both sheets:

| task | SLICE $ peak | STOCK $ peak | SLICE $ off-peak | STOCK $ off-peak | R_t (both sheets, from tokens) |
|---|---|---|---|---|---|
| f1 | 0.2619 | 0.4287 | 0.1310 | 0.2143 | 0.6109 |
| r1 | 0.0094 | 0.0121 | 0.0047 | 0.0061 | 0.7774 |
| r2 | 0.0196 | 0.0215 | 0.0098 | 0.0108 | 0.9095 |
| r3 | 0.0091 | 0.0070 | 0.0045 | 0.0035 | 1.2925 |
| r4 | 0.0058 | 0.0042 | 0.0029 | 0.0021 | 1.3624 |
| r5 | 0.0155 | 0.0104 | 0.0077 | 0.0052 | 1.4885 |
| c1 | 0.1624 | 0.1023 | 0.0812 | 0.0512 | 1.5871 |
| c2 | 0.0087 | 0.0087 | 0.0044 | 0.0044 | 1.0013 |
| all 31 pairs (Σ) | 1.7073 | 1.9513 | 0.8537 | 0.9757 | 0.8750 |

L 0.6109 and N 1.1668 on both sheets. A sheet with a different hit-to-miss price ratio is a
different question; §16 covers it.

### 13.4 Context size, cache and native context management

Medians over valid cells (pooled); request size is provider-reported prompt tokens; summaries
and prunes are summed over the cells. STOCK-COMPACT is the configured variant (§2.5, §13.5).

| task | arm | cells | requests | requests per turn | peak request | mean request | cache hit | summaries / prunes (cells with any) | step-cap cuts (turns) | wall s |
|---|---|---|---|---|---|---|---|---|---|---|
| f1 | SLICE | 3 | 265 | 5.89 | 43,301 | 24,774 | 95.8 % | 0 / 0 (0) | 0 of 135 | 542 |
| f1 | STOCK | 3 | 213 | 4.73 | 234,025 | 116,231 | 99.1 % | 0 / 0 (0) | 0 of 135 | 427 |
| f1 | STOCK-COMPACT | 2 | 214 | 4.76 | 58,931 | 42,162 | 95.3 % | 9 / 64 (2) | 0 of 90 | 436 |
| r1 | SLICE | 4 | 17.5 | 2.92 | 12,438 | 8,671 | 93.6 % | 0 / 0 (0) | 0 of 24 | 42 |
| r1 | STOCK | 4 | 18.5 | 3.08 | 14,007 | 8,265 | 95.0 % | 0 / 0 (0) | 0 of 24 | 62 |
| r2 | SLICE | 4 | 27 | 3.86 | 15,238 | 10,379 | 94.8 % | 0 / 0 (0) | 0 of 28 | 82 |
| r2 | STOCK | 4 | 24 | 3.43 | 20,464 | 11,744 | 96.0 % | 0 / 0 (0) | 0 of 28 | 94 |
| r3 | SLICE | 4 | 16.5 | 5.50 | 10,859 | 7,165 | 91.4 % | 0 / 0 (0) | 0 of 12 | 34 |
| r3 | STOCK | 4 | 11.5 | 3.83 | 11,423 | 9,532 | 92.2 % | 0 / 0 (0) | 0 of 12 | 25 |
| r4 | SLICE | 4 | 14 | 3.50 | 7,100 | 5,921 | 95.4 % | 0 / 0 (0) | 0 of 16 | 33 |
| r4 | STOCK | 4 | 12.5 | 3.12 | 6,024 | 4,371 | 94.7 % | 0 / 0 (0) | 0 of 16 | 29 |
| r5 | SLICE | 4 | 13 | 6.50 | 18,679 | 11,259 | 87.2 % | 0 / 0 (0) | 0 of 8 | 46 |
| r5 | STOCK | 4 | 10 | 5.00 | 17,437 | 12,511 | 90.5 % | 0 / 0 (0) | 0 of 8 | 29 |
| c1 | SLICE | 4 | 91.5 | 11.44 | 38,643 | 20,474 | 96.6 % | 0 / 0 (0) | 14 of 32 | 824 |
| c1 | STOCK | 4 | 47.5 | 5.94 | 74,338 | 34,361 | 98.3 % | 0 / 0 (0) | 0 of 32 | 341 |
| c2 | SLICE | 4 | 7 | 7.00 | 14,637 | 9,632 | 89.8 % | 0 / 0 (0) | 0 of 4 | 24 |
| c2 | STOCK | 4 | 8 | 8.00 | 11,610 | 8,279 | 90.8 % | 0 / 0 (0) | 0 of 4 | 30 |

- **No native context management fired in any of the 62 SLICE and STOCK cells**:
  0 compaction summaries, 0 failed compaction attempts, 0 prunes, 0 native spills, 0
  context-limit errors. STOCK's largest request in the whole run was 235,449 tokens (f1), far
  below the shipped 678,464-token trigger (§2.3). So STOCK was a raw, growing transcript
  throughout and had no post-compaction failure to count.
- f1: STOCK's request grows linearly with each excerpt read and reaches about 234K tokens at
  the quizzes; SLICE's stays bounded (peak about 43K, one sealed tape entry per turn), as in the
  pilot. SLICE pays for the boundedness with a lower cache hit rate (95.8 % vs 99.1 %) and more
  requests (5.9 vs 4.7 per turn), and still costs 39 % less.
- SLICE folded 40 large tool results in f1 (3 cells), 6 in c1, 7 in r5, 4 in r3, 1 in c2.

### 13.5 STOCK-COMPACT (configured variant, secondary, never decisive)

| | rep 1 | rep 2 |
|---|---|---|
| cost (peak) | $0.3646 | $0.3384 |
| outcome | fail (substrate): 10 of 32 digest entries wrong | fail (substrate): 6 of 32 wrong |
| memory items | 4 of 4 correct | 4 of 4 correct |
| first native action | prunes from T14 | prunes from T14 |
| pruned results / summaries (turns) | 32 / 5 (T20, T26, T31, T36, T44) | 32 / 4 (T22, T28, T34, T37) |
| failed attempts / context-limit errors | 0 / 0 | 0 / 0 |
| tokens shadowed by summaries (`compaction/summary`) | 59,504 | 48,310 |
| tokens shadowed by prunes (`compaction/prune`), reported only | 102,481 | 102,520 |
| summarizer calls' cost (included in the cell cost) | $0.0122 | $0.0127 |
| peak / mean request tokens | 58,426 / 42,322 | 59,435 / 42,003 |

The two shadowed-token rows are the host's own counts per event type. They are not additive:
a summary can cover results that were pruned earlier. The batch-stage version of this table
showed only the summary count, labelled "shadowed tokens" (§14.2).

Both exams ran after compaction in both cells (`compacted_before` true) and all memory items were
right: post-compaction memory failures 0. The substrate failures are the pruning property
pre-declared in §2.5 (an excerpt replaced by its head and tail before its token was copied), as in
pilot part 2. Both verifiers confirmed that each of the 16 wrong digest entries belongs to an
excerpt the pruner replaced before the model's next request. The model rarely went back to the
file: in rep 1 every turn with a prune has exactly one read call (14 turns), and in rep 2 one
such turn re-read the excerpt (3 read calls). Against STOCK on f1: R 0.863 (paired 0.773,
0.988), passes 0 vs 2. SLICE against STOCK-COMPACT on f1: R 0.748 (paired 0.725, 0.773), passes
2 vs 0.

### 13.6 Where SLICE's short-session overhead comes from (reported only, not pre-registered)

Tool calls counted from the turn streams of the pooled cells; this is description, not a test.

- **Cost by token class** (mean per cell over the task's pairs, peak sheet, from `cells.json`):

  | task | SLICE uncached in / cached in / output | STOCK uncached in / cached in / output | difference (SLICE − STOCK) |
  |---|---|---|---|
  | f1 | $0.1224 / $0.0855 / $0.0540 | $0.1002 / $0.3017 / $0.0268 | +$0.0222 / −$0.2162 / +$0.0272 |
  | r1 | $0.0045 / $0.0020 / $0.0030 | $0.0035 / $0.0020 / $0.0065 | +$0.0010 / $0.0000 / −$0.0035 |
  | r2 | $0.0064 / $0.0037 / $0.0095 | $0.0049 / $0.0040 / $0.0127 | +$0.0015 / −$0.0003 / −$0.0032 |
  | r3 | $0.0043 / $0.0015 / $0.0032 | $0.0037 / $0.0015 / $0.0018 | +$0.0006 / $0.0000 / +$0.0014 |
  | r4 | $0.0017 / $0.0011 / $0.0030 | $0.0013 / $0.0007 / $0.0022 | +$0.0004 / +$0.0004 / +$0.0008 |
  | r5 | $0.0085 / $0.0018 / $0.0051 | $0.0052 / $0.0016 / $0.0036 | +$0.0033 / +$0.0002 / +$0.0015 |
  | c1 | $0.0292 / $0.0254 / $0.1077 | $0.0112 / $0.0220 / $0.0691 | +$0.0180 / +$0.0034 / +$0.0386 |
  | c2 | $0.0032 / $0.0009 / $0.0047 | $0.0026 / $0.0008 / $0.0053 | +$0.0006 / +$0.0001 / −$0.0006 |

  Output includes reasoning tokens. On f1, SLICE sends 0.28x STOCK's cached input tokens, 1.22x
  its uncached input tokens and 2.02x its output tokens. The whole saving is in cached input.
  On the short tasks the difference is almost entirely uncached input and output, that is, what
  the model did. The prompt size barely matters there.
- **c1 (R 1.587, the largest overhead):** SLICE made 437 tool calls in 32 turns, STOCK 205
  (edit 161 vs 79, bash 157 vs 68, read 94 vs 52). `expand_result` was called twice and no
  recall tool at all. STOCK's turns varied by cell:
  - batch rep 1 STOCK read `calc.py` and patched it through bash, with no edit call and at most
    5 steps a turn;
  - the other three STOCK cells used the edit tool 22–31 times each, with up to 8–13 steps in a
    turn.

  A typical SLICE turn re-reads the file, makes several edits and runs several ad-hoc test and
  fuzz scripts. 14 of its 32 turns ended at the 14-step cap, 3–4 in every cell and all in
  T5–T8; no STOCK turn did. SLICE's requests were smaller (mean 20.5K vs 34.4K tokens) but there
  were twice as many. Its output cost was 1.56x STOCK's and its uncached input cost 2.6x. Two
  plausible causes are not separated here:
  - the sealed tape hides the code the model wrote in earlier turns, while STOCK still sees it
    verbatim;
  - the plugin's system text replaces the host persona ("You are sliceagent, …") and tells the
    model that "a recorded file read is not a current file".

  Both arms passed every c1 cell.
- **r3–r5 (R 1.29–1.49):** these sessions are 2–4 turns long and cost about a cent each.
  SLICE's longer prefix (about 1,830 more tokens in the first request: median 4.9K against
  3.1K) is served from cache at $0.014/M. That is about $0.00003 per request, so it explains
  little:
  - in r3 and r5, cached input accounts for $0.0002 or less of the difference;
  - in r4 it accounts for $0.0004 of $0.0016.

  The rest is uncached input and output. In r5, for example, SLICE sent 19.3K uncached tokens
  against STOCK's 11.8K, from its `expand_result` and `recall_step` re-reads. r1 and r2 (R 0.78,
  0.91) went the other way, mostly because STOCK wrote more output; cached input was about equal.
- **f1 reading behaviour varied in SLICE without changing its cost.** In batch rep 1 the model
  read 24 of 32 excerpts in two or more partial reads, each under the fold threshold (8 folds,
  10 `expand_result` calls); in rep 2 all 32 (0 folds, 3 calls); in the arbitration cell it read
  every excerpt whole and expanded every fold (32 folds, 32 calls), as in the pilot. The three
  cells cost $0.2641, $0.2615 and $0.2601.
- *Post-hoc arithmetic, not a rule:* at the measured per-session costs (peak), one 45-turn f1
  session saves $0.167 against STOCK, and one c1 session costs $0.060 more, the others under
  $0.006 either way; the dollar-weighted ratio over all 31 pairs is 0.875.

### 13.7 What this answers

On this host (DSH 0.2.1-rc.2, deepseek-flash, headless, hermetic composition) and these eight
tasks, the current slice policy, against stock DSH at its shipped defaults:

- **is equal on quality:** 31 of 31 passes in both arms; every eligible early fact recalled
  correctly in both (31 of 31 items, 0 bad);
- **is much cheaper and much smaller on the long session:** f1 costs 0.61x and its requests
  peak at about 43K tokens instead of 234K;
- **costs more on short sessions:** 1.17x geometric mean over the seven short tasks, 1.59x on
  the multi-turn coding task c1;
- **was compared with a stock arm whose compaction never fired:** stock's shipped trigger never
  came within reach (largest request 235K of 678K), so the comparison is against a raw transcript.
  With a 57K trigger (STOCK-COMPACT, a configured variant), native compaction cut f1's cost to
  0.86x of STOCK but its pruner dropped content the task needed (0 of 2 passes), where SLICE
  passed both. That failure is in-turn pruning on a task built to expose it: each excerpt is just
  over the 8,192-character prune threshold and its token sits in the pruned middle (§2.5). It
  is not evidence that native summaries lose early facts; every memory item survived 4–5
  summaries.

By the pre-registered rule this is **inconclusive**: the saving on the long session is large, but
the short sessions cost more than the 10 % the rule allows. Whether slice is worth using therefore
depends on the workload mix: long sessions with large tool outputs favour it; short or
coding-heavy sessions favour stock. n is 3–4 per task (f1 3), one model, one host.

### 13.8 Files

- [pooled-summary.md](ab/slice-vs-stock-2026-10-23/pooled-summary.md) /
  [.json](ab/slice-vs-stock-2026-10-23/pooled-summary.json): the pooled report, which decides;
  [batch-summary.md](ab/slice-vs-stock-2026-10-23/batch-summary.md) / [.json](ab/slice-vs-stock-2026-10-23/batch-summary.json):
  the batch alone (with the arbitration test);
  [arb-summary.md](ab/slice-vs-stock-2026-10-23/arb-summary.md) / [.json](ab/slice-vs-stock-2026-10-23/arb-summary.json):
  the arbitration batch alone (descriptive). The frozen instrument's output, paths normalized
  (`AB` = the A/B root), not edited.
- [cells.json](ab/slice-vs-stock-2026-10-23/cells.json): one row per batch and arbitration cell
  (cost on both sheets, tokens, requests, context sizes, compaction events, folds, step-cap cuts
  per turn, memory classes, flags).
- [sensitivity.json](ab/slice-vs-stock-2026-10-23/sensitivity.json): the analyses of §13.6 and
  §16, which are reported only and not pre-registered. It holds the token-class costs, the
  cache-hit price series, the bootstrap and the leave-one-pair-out figures. They are computed
  from `cells.json` and `prices.json` by `operator-tools/sensitivity.py` in the archive.
- The summaries and `cells.json` contain no oracle value. The operator's scan
  (`operator-tools/oraclescan.py` in the archive) checked every file in
  `docs/ab/slice-vs-stock-2026-10-23/` and this record against the truth sidecars of all 64
  cells and the r1–r5 task tokens: 195 strings in all. The batch-stage text said 193; a re-run on
  the final files gives 195, which is the figure of record (§14.2). The scan found the expected
  values in raw turn streams as a positive control.
  - Every file under `docs/ab/` has 0 hits.
  - This record matches 3 strings, all present since the frozen pre-registration (`35df351`).
    Two are f1's T1 user-stated deployment values quoted in §4.1. They are the prompt's own
    text, also in the committed `scripts/ab/tasks/svs_f1_flood_recall/prompts.json`, and the
    user hands them to the model in T1. The third is a common English word that also occurs in a
    truth sidecar.
  - None is a seeded oracle value, and none is a value a cell could read during a turn: the
    record's `docs/` is mode 000 while a turn runs.
- `run_ab.py secrets-scan`: 3 cells listed, all from the offline mock isolation probe
  (`isoprobe`, whose probe names `DSH_HOME` by design); no paid cell. A plain search of every tool
  input in every turn stream found no other reference to `DSH_HOME`, `~/.dsh` or a `.env` file
  (only `self.env` attributes and the r2 task's `service.env`). The key links were removed from
  the three template homes after the arbitration.
- Raw data: `~/Documents/kimi/workspace/dsh-slice/results/20261023-slice-vs-stock/`. Its
  `README.md` lists the contents and exclusions. The three probe cells are in `held-back/`
  (chmod 700). The verifiers' tools and outputs are in `verify/`, without their decompressed
  logs and unpacked workdirs, which duplicate the archived raw data. `record/` holds this record
  at its final commit.

## 14. Verification

### 14.1 What the two verifiers checked

Two verifiers worked independently, read-only and without model calls, after §13 was committed
(`544b257`). Each one:

- decompressed all 64 session logs;
- wrote its own parser, without importing `ab_metrics.py`, `ab_report.py` or `svs_report.py`;
- priced the usage of every `assistant/message`, `assistant/attempt` and `compaction/summary`
  event on both sheets;
- re-ran every task's `verify.py` in a fresh `python -I` on all 64 packed workdirs;
- recomputed every pre-registered quantity of §6–§8 and cross-checked every row of `cells.json`.

Both agree with the report on every pre-registered comparison:

- L 0.6109, N 1.1668, N_recall 1.1313, N_coding 1.2606, G 1.0762, Σ ratio 0.8750 and median
  paired ratio 1.1521, pooled;
- the batch-alone and arbitration-alone figures;
- dS 0 and every dS_t 0; dM 0 and dB 0 over 31 items; the one exclusion;
- the verdicts, the arbitration test and its budget condition;
- the ledger: $5.7403 over 795 turns, 7 unpriced charges.

Oracle verdicts were identical in 64 of 64 cells, with the same pass, detail and info. In
`cells.json`, 0 rows mismatched on cost (both sheets), tokens, requests, cache hit, request
sizes, summaries, prunes, context-limit errors, spills, folds, turns or step-cap cuts.

Further checks by one verifier or the other:

- **Exams.** Every SLICE exam turn got its answer through a recall-tool result in that turn,
  23 of 23 cells. SLICE's sealed tape never contained an exam token before its exam.
- **Leaks and access.** No assistant-text leak, no write leak and no oracle via the file system
  in any cell. An access scan flags only the excluded pair.
- **Arms.** The three dumps differ only in their declared rows. The shipped trigger formula was
  checked in the upstream `config.ts` and in the installed host lib. Both copies of the slice
  tarball match sha `62b0eb7e…` and are byte-identical to `git archive c73ee22`, as are the
  installed plugin files.
  - Every SLICE cell has 16 tools, system-prompt sha `46c592c8` and one tape entry per sealed
    turn (44 in each f1 cell).
  - Every STOCK and STOCK-COMPACT cell has 12 tools and sha `3f484053`.
- **Isolation.** Every absolute path in every tool call of all 64 logs was scanned. The only
  accesses outside a cell root were SLICE's c1 scratch scripts in `/tmp`, which were
  quarantined. The two `find ..` calls (r2 batch rep 3 SLICE, the excluded pair, and c2 batch
  rep 1 STOCK, which has no memory item) listed only their own cell root and returned no oracle
  value.
- **Secrets and keys.** 0 secret-pattern matches in paid cells; no `.env` link left in the
  template homes.
- **Cost accounting.** All 9 compaction-summary usages are priced. The recall tools are local
  and the plugin makes no model calls, so recall output is billed through the following
  requests.
- **Order and content.** f1's truth and log hashes are identical across the arms of each group
  and differ between groups. The run order matches the rotation of §3.
- **Transcripts.** One verifier read the transcripts of 18 cells: all 8 f1 cells, the excluded
  cell (r2 batch rep 3 SLICE), the cell with the failed provider request (r2 batch rep 1
  STOCK), and one pair each from c1, c2, r3 and r5.

Taken from the harness's records and not re-derived from raw data: isolation and tamper
evidence (modes, inodes, ctime, sibling blocking), stray processes, quarantine, wall times and
the warm and pilot stages. These records are internally consistent: 0 breaches, 0 strays,
unchanged worktrees, and an unchanged host digest across all three manifests.

Scratch outputs, outside the repository: `AB/verify-0/{tools,out}` and
`AB/verify-1/{tools,recomputed.json,reverify.json}`. Their decompressed logs, unpacked workdirs
and rendered transcripts hold oracle values. They are not committed, and they are not archived
beyond the raw data they duplicate.

### 14.2 Discrepancies and how they were resolved

| # | finding (verifier) | resolution |
|---|---|---|
| 1 | Fourth-decimal differences (both): the JSON gives pooled N 1.1669 against a recomputed 1.1668, batch N_coding 1.2765 against 1.2766, and arb-only N 1.2339 against 1.2338. Pooled r2 and r4 differ in the third decimal of the rounded display. | `svs_report.py` computes ratios from off-peak cell costs rounded to 6 decimals; applying the same rounding reproduces every reported value. The effect is immaterial: at most 0.0004 on any R_t, and no threshold is within 0.03. The frozen report's figures stand. §13.3 adds the token-priced values. |
| 2 | Oracle-scan string count (both): §13.8 said 193, the batch-stage text said 195. Both gave 0 hits on the summaries. | Re-run on the final files: 195 strings, 0 hits under `docs/ab/`. §13.8 is corrected and now also discloses this record's 3 matches: two task-design strings quoted since the freeze and one common word. |
| 3 | §13.6 said a typical STOCK c1 turn reads `calc.py` once and patches it in one bash call in 3–5 steps (both). Only batch rep 1 STOCK did that; the other three used the edit tool 22–31 times, with up to 8–13 steps a turn. | Confirmed from the per-cell tool counts; §13.6 is reworded with the per-cell figures. The tool-call totals were right. |
| 4 | §13.6 said SLICE's longer prefix is a large share of the r3–r5 overhead (one verifier). The prefix is served from cache at about $0.00003 per request; the overhead is output and uncached input. | Confirmed. The token-class table in §13.6 shows that cached input accounts for at most $0.0004 of the difference on any r-task or on c2, and for $0.0034 of c1's $0.0601. The same table also contradicted the batch-stage reason given for r1 and r2 ("STOCK re-sends the raw probe outputs"): cached input is equal there, and STOCK's extra cost is output. Both statements are corrected. |
| 5 | STOCK-COMPACT's "shadowed tokens" (59,504 and 48,310) counted only summaries; the pruner shadowed about 102.5K more per cell (one verifier). | Confirmed from the raw `compaction/prune` events: 102,481 and 102,520. §13.5 now shows both rows, labelled, and notes that they are not additive. |
| 6 | Ledger and metric differ for r2 batch rep 1 STOCK ($0.0656 against $0.0156) (one verifier). | Already explained in §13.1: $0.05 is charged for the failed provider attempt, which has no logged usage. The ledger also charges compaction-summary usage from the log, as §5 and §9 declare. No change. |
| 7 | Price sensitivity of L. One verifier gave L at hit/miss 1/10, 1/4 and 1/1. The other gave L for a halved and a doubled hit price, plus "1.22 on uncached tokens alone". | Recomputed in §16. The 1.22 is SLICE's ratio of uncached input tokens on f1, not a cost ratio. With free cache hits, the cost ratio over uncached input and output is 1.39. One verifier said the verdict holds "under every sheet tried". That is true for the sheets they tried; §16 adds that it changes when the hit price falls below about 0.28x the sheet's. |

No discrepancy touches a pre-registered quantity, the quality floor or the verdict.

## 15. Fairness caveats

- **N weighs every short task equally, by pre-registration.** The r3, r4 and r5 sessions cost
  about a cent each, and their per-session differences are under $0.006. They count as much in N
  as c1 does. Weighted by dollars, slice costs 0.875x stock over all 31 pairs, against N 1.167.
  The rule chose equal weighting so that c1's dollars would not swamp the other tasks. A
  dollar-weighted rule would read the same data differently.
- **SLICE differs from STOCK in its system text as well as its context policy.**
  - The plugin replaces the persona ("You are sliceagent") and adds its kernel and fold section:
    3,651 against 1,134 system characters, and 16 against 12 tools.
  - The kernel says that a recorded file read is not a current file. SLICE's c1 cells re-read
    `README.md` and `calc.py` in almost every turn.
  - This is a fair test of the plugin as shipped, which is the arm the design rules defined. It
    does not separate the sealing policy from the prompt. The short-session overhead may be
    partly a prompt effect.
- **The harness step cap bound only SLICE.** In c1, 14 of SLICE's 32 turns were cut, all in
  T5–T8; no STOCK turn was cut, and STOCK's largest turn took 13 steps.
  - SLICE passed every c1 cell anyway. Its c1 cost (R 1.587) is a lower bound, and lifting the
    cap could only raise N.
  - That cannot move the verdict to "not worth it": rule 6 needs L > 0.80 and rule 5 needs
    L ≥ 0.95, and L is 0.611.
- **f1's design cuts both ways.**
  - Against SLICE: the prompts demand full reads and forbid grep, so every large read is folded
    and either expanded or read in chunks.
  - For SLICE: carrying 32 large reads forever is where sealing helps most.
  - L rests on this one synthetic task, at n = 3, with paired ratios of 0.55–0.76. STOCK varied
    too: batch rep 2 STOCK read the excerpt and `digest.md` in one step, for 3 requests per read
    turn instead of 5, and cost $0.342 against $0.472.
- **The recall tasks give stock's raw history its natural advantage on short sessions**,
  because the source is deleted and STOCK still holds the raw tool output. That is the trade the
  policy makes (§4). Both arms recalled everything.
- **Run order was balanced overall.** SLICE ran first in 2 of the 4 pooled short-task pairs, and
  f1's order rotates. In the arbitration STOCK ran first for every task. Each cell's runtime
  context carries its own cwd, so reuse of the cache across cells is limited to the system text,
  the tools and the T1 prompt. No order effect was found.
- **STOCK-COMPACT ran at a configured 57K trigger on a task whose structure defeats the pruner**
  (§2.5, §13.5). Its 0 of 2 passes describe in-turn pruning on this task. They are not a verdict
  on native compaction.
- **SLICE's f1 reading strategy varied between cells**: chunked reads under the fold threshold in
  the batch cells, whole reads with fold and expand in the arbitration cell. This is the policy
  behaving as designed, not a harness effect. The cost was flat ($0.260–0.264).
- **The leak check of §5 scans visible assistant text only.** In both arms the model's reasoning
  named exam tokens at their delivery turns (for example f1 T3 and T5, r1 T3, r2 T4, r5 T1).
  That is where the fact arrives, and it is not an exclusion under the rules. SLICE's tape never
  carried those tokens before the exam.

## 16. External validity

- **Session length.** The longest session was 45 turns, and STOCK's largest request was 235,449
  tokens. The short tasks ran 1–8 turns. Real long-running agents go much further: the live
  slicey-dsh session reached 179 turns, and the Raft-connected agent runs without stopping.
  - STOCK adds about 6.9K tokens per excerpt read on f1, so it would reach its shipped 678,464
    trigger after roughly 64 more such turns.
  - Beyond that point stock compacts. A summary call replaces the oldest span, and the cache
    breaks from the first replaced token.
  - This run did not test that regime at the default settings. Its only evidence on compaction
    is STOCK-COMPACT: 2 cells at 57K, on one task. The data do not predict whether slice's
    long-session advantage grows or shrinks there.
- **Price structure.** The whole long-session saving is in cached input (§13.6). On f1, SLICE
  sends 0.28x STOCK's cached tokens but 1.22x its uncached input and 2.02x its output, so L
  depends on the price of a cache hit relative to a miss. The two sheets of §2.1 are
  proportional, so they cannot test this. Re-priced from the logged tokens, with miss and output
  prices fixed (`sensitivity.json`):

  | cache-hit price | hit/miss | L | N | verdict under §7 |
  |---|---|---|---|---|
  | free | 0 | 1.390 | 1.179 | not worth it (rule 5) |
  | 0.28x the sheet | 1/113 | 0.950 | 1.175 | boundary of rule 5 |
  | 0.48x the sheet | 1/65 | 0.800 | 1.172 | boundary of rule 3's L condition |
  | 0.5x the sheet | 1/63 | 0.789 | 1.172 | inconclusive (rule 7) |
  | **the sheet (DeepSeek v4-flash)** | **1/31** | **0.611** | **1.167** | **inconclusive (rule 7)** |
  | 2x the sheet | 1/16 | 0.476 | 1.159 | inconclusive (rule 7) |
  | 1/10 of miss | 1/10 | 0.414 | 1.152 | inconclusive (rule 7) |
  | 1/4 of miss | 1/4 | 0.340 | 1.136 | inconclusive (rule 7) |
  | no cache discount | 1/1 | 0.298 | 1.118 | inconclusive (rule 7) |

  - The verdict is the same for any cache-hit price from about 0.28x the sheet's upward.
  - With cheaper cache hits, slice's extra output and uncached input outweigh its smaller cached
    input. Below about 0.23x the sheet, slice costs more on f1 too.
  - The "39 % cheaper" figure is specific to DeepSeek's cache pricing. `prices.json` itself
    records as an assumption that deepseek-flash bills on the v4-flash sheet.
- **One model and one host.** The model was deepseek-flash at the adapter's default reasoning
  effort, and the host was DSH 0.2.1-rc.2.
  - Each turn ran as its own headless process, in a hermetic composition: no web, subagents,
    skills or goals, an empty host persona and telemetry off.
  - c1's extra fuzzing and re-reading in SLICE is model behaviour, and another model may react
    differently to the tape and the kernel text.
  - The interactive TUI and other routes were not tested.
- **Synthetic tasks.** f1's excerpts are generated log text, and its prompts forbid grep and
  demand full reads, which a capable agent would usually avoid. The recall tasks plant one fact
  and delete its source. Real sessions mix reads, test output and edits in proportions this
  suite does not represent.
- **Power.** n is 3 for f1 and 4 for each short task. In a bootstrap over pairs within each task
  (20,000 resamples):
  - N has a 95 % interval of 1.07–1.28, P(N ≤ 1.10) ≈ 0.09 and P(N ≥ 1.25) ≈ 0.07;
  - L has a 95 % interval of 0.55–0.76, and every resample has L ≤ 0.80;
  - leaving out any one pair moves N within 1.14–1.19;
  - N without c1 is 1.109.

  The long-session saving is well supported. That N exceeds 1.10 is only moderately supported.

## 17. What would change the conclusion

The arbitration is spent (§8), so no further run can change this record's verdict. A new
question needs its own pre-registration. On these rules and this data:

- **"Worth it" (rule 3) needs N ≤ 1.10 with L ≤ 0.80**, which means cutting the short-session
  geometric mean by 5.7 %.
  - With the other six tasks unchanged, c1's ratio alone would have to fall from 1.59 to 1.05.
    c1 at parity gives N 1.092, and r3–r5 at parity give N 1.017.
  - The natural next experiment is an ablation that separates the two candidate causes of the
    c1 overhead: the tape hiding earlier code, and the kernel text. It would run SLICE with the
    host's persona and without the "recorded read" instruction, against SLICE as shipped and
    STOCK.
- **"Not worth it" needs rule 5 (L ≥ 0.95 and N ≥ 1.00) or rule 6 (N ≥ 1.25 and L > 0.80).**
  Neither is near at DeepSeek's prices.
  - Rule 5 would hold if cache hits cost under about 0.28x the sheet's price (§16).
  - It would also hold for a long-session workload in which SLICE's extra output and uncached
    input outweighed its cached-input saving.
  - Lifting the step cap would raise N, but it cannot reach either rule while L is 0.61.
- **The workload mix (outside the rule).** At this run's per-session costs, one f1-like session
  saves $0.167 against stock, and one c1-like session costs $0.060 more. Ignoring the sub-cent
  sessions, a workload with more than about 2.8 c1-like sessions per f1-like session is cheaper
  without slice. Measuring the
  mix of the owner's real sessions would turn "inconclusive" into a decision for that workload:
  turn counts, tool-output sizes, and how often a session gets past 100K tokens.
- **Untested regimes** could move L in either direction:
  - sessions long enough to reach stock's 678K trigger;
  - another model or host version;
  - another provider's cache pricing;
  - interactive use.

  More reps would narrow N's interval, which straddles 1.10.
