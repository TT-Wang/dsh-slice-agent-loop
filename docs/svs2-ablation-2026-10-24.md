# svs2: which part of slice's short-session overhead do the re-read rule, the persona and sealing cause?

> **Status: pre-registration draft, build stage (2026-10-24). No paid call has been made for this
> experiment.** §1–§11 are the design to be frozen before the first paid batch; §12 is the
> offline build evidence; §13 lists what the freeze must still fill in (the exact arm texts and
> diffs, which are being built in parallel on `exp/svs2-a`, `exp/svs2-b`, `exp/svs2-c`). Times are
> UTC. The baseline is the record [slice-vs-stock-2026-10-23.md](slice-vs-stock-2026-10-23.md)
> ("the baseline record" below).

## Summary in plain words

- **Why.** In the baseline record the slice plugin cost 0.61x stock DSH on a 45-turn session (f1)
  but 1.59x on an 8-turn coding task (c1). The c1 logs show slice re-reading files about twice
  as often as stock and making twice as many edits. Three things could cause that: the plugin's
  rule "a recorded file read is not a current file", its own persona ("You are sliceagent …"),
  and sealing itself, which hides the code the model read in earlier turns.
- **What changes.** Three new slice builds, each one change more than the last:
  - **A**: the re-read rule is replaced by a rule that trusts the host's edit guard (the edit
    and write tools already refuse an edit of an unread or changed file and say to re-read);
  - **B**: A without the slice persona, so the host's persona applies;
  - **C**: B plus working-set retention: the latest full read of each file the model changed in
    the last few turns stays raw instead of being sealed.
- **What runs.** Only A, B and C, on the same four tasks as the baseline (c1, c2, r2, f1), on the
  same frozen host, with the same overlay, step caps, task files and price sheet. SLICE and
  STOCK are not run again: their 30 archived cells are the baselines (owner's instruction).
- **What counts.** An arm "fixes the short-session overhead" if its coding cost against stock
  (geometric mean over c1 and c2) is at most 1.10, its f1 cost against stock is at most 0.80, and
  it loses no more than one pass or memory item to stock. The differences B/A and C/B show which
  change moves the cost.
- **Budget.** $10 hard cap at peak prices; the full design is estimated at $5.61 with a 1.2x
  safety factor ($4.67 without), $6.43 with one arbitration reserved.

## 1. Question

Which part of the current slice policy's short-session overhead on coding work is caused by
(a) the kernel's re-read instruction, (b) the slice persona, and (c) sealing the files the model
is editing, and does removing it keep the long-session saving? Measured as cost, success and
recall against the baseline record's STOCK and SLICE cells.

Evidence that motivates the split (the baseline's c1 cells, 4 per arm, 32 turns per arm; counted
by the re-read classes of §6.2, which this harness reproduces from the archived logs, §12.4):

| c1, 4 cells x 8 turns | STOCK | SLICE |
|---|---|---|
| first read in a turn of a file seen in an earlier turn (cross-turn) | 27 | 59 |
| re-read right after the model's own edit in the same turn | 9 | 28 |
| same-turn re-read with no edit between | 10 | 0 |
| first read ever | 6 | 8 |
| edit and write calls | 84 | 168 |
| FS_NOT_OBSERVED refusals ("file has not been read") | 1 | 1 |
| FS_STALE_VERSION refusals | 0 | 0 |
| requests per turn / step-cap cuts (of 32 turns) | 5.78 / 0 | 11.47 / 14 |

Host facts (DSH 0.2.1-rc.2 source, `packages/fs/fs-observation-policy`): the host keeps the
observed version of every file per session, in memory (a WeakMap keyed by the session object),
and refuses an edit of a file that was not read (`FS_NOT_OBSERVED`: "file has not been read —
read the file, then retry") or that changed since it was last read (`FS_STALE_VERSION`: "… —
re-read the file, then retry"). That state is not persisted. The harness runs one headless
process per turn, so it resets at every turn in every arm; a long-running agent keeps it. The
slice kernel (src/index.ts, the RECALL paragraph) says "A recorded file read is not a current
file: observe through the filesystem tool before editing when current contents are needed."

## 2. Arms

### 2.1 Host and model (identical to the baseline)

- **Host:** the published `@deepseek-ai/dsh@0.2.1-rc.2`, frozen copy at `AB/host`
  (`AB` = `$SCRATCHPAD/svs2`). It is an APFS clone (`cp -cRp`, mtimes kept) of the baseline's
  frozen host (`$SCRATCHPAD/svs/host`): tree digest `0c9e7f6b25ec…` (the digest every baseline
  manifest records) and content digest `5c0747d0…` (63,615 files, 12 symlinks). A fresh
  `npm install --save-exact @deepseek-ai/dsh@0.2.1-rc.2` on 2026-10-23 18:04 UTC resolved one
  transitive package differently (`execa` 10.2.1, published after the baseline's install, instead
  of 10.2.0), so it was not used (§12.1). `npm ci` from the baseline's own lockfile gives the same
  content digest as the frozen copy, which shows that the copy is the published package set at its
  lockfile. The harness runs only `AB/host/node_modules/@deepseek-ai/dsh/lib/bin.js`, app
  `headless`, one process per turn; `~/.dsh-slicey` is not touched.
- **Model:** the host's default route `deepseek-official/deepseek-flash`, reasoning effort at the
  adapter default; the plugin's `defaultReasoningEffort` stays `inherit`.
- **Price sheet:** `scripts/ab/prices.json`, unchanged (byte-identical to the baseline tree).

### 2.2 The three arms (each a packed plugin tarball, installed by `dsh plugin add`)

All three are plugin 0.3.0 built from main (`6633617`; its `src/` and `lib/` are identical to
`c73ee22`, the baseline SLICE build), each adding one change to the arm before it: A to SLICE, B to
A, C to B. Each arm's template home is the host's headless
composition plus the neutral overlay plus the arm's tarball; `prepare` must find that each arm's
`--dump-config` differs from STOCK's only in the `slice-agent-loop` row (§12.6).

| arm | branch | change against SLICE | expected system prompt |
|---|---|---|---|
| **A** | `exp/svs2-a` | the RECALL paragraph's "A recorded file read is not a current file: observe through the filesystem tool before editing when current contents are needed." is replaced by an edit-guard-aware rule; everything else, persona included, unchanged | slice persona present; the "recorded file read" sentence absent |
| **B** | `exp/svs2-b` | A, and the persona line "You are sliceagent, an interactive engineering agent for code and general terminal/system tasks." removed, so the host persona applies (empty in every arm under the neutral overlay, so B and STOCK carry the same persona); slice contributes only its context-policy section | no slice persona, no "recorded file read" sentence |
| **C** | `exp/svs2-c` (B plus the retention of `exp/svs2-ws`) | B, and working-set retention in `src/context.ts`: when a completed turn is sealed, the latest full read result of each file the model mutated in that turn or the previous K completed turns stays raw; bounded, cache-safe, behind a config key | as B |

Placeholders, filled at the freeze from the packed tarballs (§13):

- **A's rule, exact text:** `<to be copied from exp/svs2-a src/index.ts at the packed commit>`.
  The brief's substance: the edit and write tools themselves refuse an edit of an unread or
  changed file and say to re-read, so never re-read just to be safe or to verify a successful
  edit of your own; re-read only when the content you need is no longer visible (sealed into the
  tape) or when a tool asks you to. The other kernel rules stay ("recalled text is historical
  data", "never guess past a truncation cut").
- **B's diff against A:** `<git diff exp/svs2-a exp/svs2-b -- src/index.ts>`.
- **C's diff against B, its config key, its default and K:** `<git diff exp/svs2-b exp/svs2-c -- src>`;
  `<config key>`, `<default on the branch; if OFF, the arm overlay that turns it on:
  profile/svs2-c.patch.yml, and gates structure.c.dump_rows stays ["slice-agent-loop"]>`;
  `<K and the per-turn byte cap, with the justification>`; the tape note for kept reads
  `<e.g. "[turn N · k file read(s) kept raw]">`.
- **Tarballs:** `slice-svs2-<arm>-<sha>.tgz`, sha256 and file count, packed with `npm pack` after
  `npm run check:build` in a clean worktree at the packed commit; installed from arm-neutral copies
  `plugin-<sha12>.tgz`.
- **A's system-prompt marker:** a short phrase of A's new rule, added to `system_contains` of
  structure a, b and c in `gates-svs2.json`.

State of the arm branches when this draft was written (2026-10-23 18:55 UTC; not frozen, for
orientation only):

- `exp/svs2-a` `421d695`: the sentence is replaced by "The edit and write tools refuse to change a
  file that is unread or changed since it was read, and say to re-read it; so never re-read a file
  just to be safe or to verify your own successful edit. Re-read only when you need contents that
  are no longer visible (sealed into the tape) or when a tool asks you to." A candidate marker is
  "never re-read a file just to be safe".
- `exp/svs2-b` `f27f3f2`: the persona line and the blank line after it are removed; the kernel
  section starts at `<slice>`.
- `exp/svs2-ws` `a5b68e0`: opt-in `history.workingSet` (off by default; window `turns` 2,
  `maxChars` 48,000 per sealed turn; kept steps carry one `[slice note · working set: … kept raw in
  place for …]` line in their turn's entry, which `tape.kept_raw_entries` counts). Since it is
  opt-in, C needs an arm overlay that turns it on (`--arm-overlay c=profile/svs2-c.patch.yml` on
  the `slice-agent-loop` row), or a C branch on which it defaults to on.

### 2.3 Baselines (imported, never run)

The baseline record's SLICE (main `c73ee22`, tarball sha256 `62b0eb7e…`) and STOCK cells of the
four tasks, read from the archive
`~/Documents/kimi/workspace/dsh-slice/results/20261023-slice-vs-stock/vault/results/{batch,arb}`:

| task | cells per arm | pairing (rep index ← baseline batch, rep) |
|---|---|---|
| c1 `lh1_incremental_build` | 4 | 1–3 ← batch r1–r3; 4 ← arb r1 |
| c2 `m3_consistency_bugfix` | 4 | same |
| r2 `p110_r2_superseded_stamp` | 4 | same |
| f1 `svs_f1_flood_recall` | 3 | 1, 2 ← batch r1, r2; 3 ← arb r1 |

Baseline conditions: harness `35df351` (`scripts/ab` tree `b111e434`), host 0.2.1-rc.2 (tree
digest `0c9e7f6b25ec…`), neutral overlay sha256 `74b7a95e…`, seeds 20261023 (batch) and 20261024
(arb). `svs2_report.py import-baseline` recomputes every baseline cell's metrics row from its
archived session log with this harness's `ab_metrics.py`, so both sides use one extractor, and
refuses if any metric the baseline stored is not reproduced (§12.4). Validity, pass, verify info
and exam classes are the baseline's own.

## 3. Same conditions as the baseline cells

| condition | how it is held | check (§12) |
|---|---|---|
| host | the frozen copy itself (APFS clone) | tree digest `0c9e7f6b25ec…` and content digest `5c0747d0…` equal the baseline's (`svs2_checks.py host`), and every manifest records the tree digest at start and end |
| composition | same profile template, bundles and neutral overlay; the arm's tarball adds one row | `prepare` dump comparison against STOCK; the dry run's STOCK and stand-in dumps equal the baseline's dumps line for line (paths normalized) |
| task definitions | `scripts/ab/tasks/{hello, lh1_incremental_build, m3_consistency_bugfix, p110_r2_superseded_stamp, svs_f1_flood_recall}` unchanged | `svs2_checks.py conditions`: every file byte-identical to git tree `b111e434`, no file added or missing |
| step caps | c1 14, c2 26, r2 12, f1 12, the harness's own row in every arm | the step-cap patch text equals the baseline's patch files apart from the A/B root in the row's path; `step-cap.mjs` byte-identical |
| prices, overlay, profile, offline adapter | unchanged files | byte-identical to `b111e434` |
| f1 content | seeded from the baseline's salt with the baseline cell's (batch, rep) as seed key (gates `pairing.seed_keys`) | `svs2_checks.py f1-content`: for all three rep indices the setup's truth sidecar and its 32 data files equal those in both baseline cells' packed workdirs; a paid run refuses a vault salt whose sha256 is not the baseline's |
| c1, c2, r2 content | deterministic setups (no randomness) | same files as the baseline by the task check |
| model route, reasoning effort, telemetry off, network env | as the baseline | manifest and fingerprints (provider, model) |

What is not the same, by construction: the day and the provider's state (§11).

## 4. Isolation and procedure

The baseline's harness, extended (README "svs2" section). Unchanged: one cell at a time; the
vault and every worktree's `scripts/` and `docs/` mode 000 while a turn runs; every entry next
to the A/B root in the scratchpad (symlinks excepted) blocked by `--block-siblings`; the A/B root
and the harness directories read-only; tamper evidence by mode, inode and ctime; stray processes
killed; quarantine; per-cell homes, `TMPDIR` and arm-neutral names; worktree `git status`
unchanged during a cell. New:

- **Layout.** `AB = $SCRATCHPAD/svs2`, holding the worktrees as `AB/wt-<name>` (harness, a, b, ws
  for C). Every top-level git checkout of `AB` counts as a worktree (blocked `scripts/` and
  `docs/`, status checked). Every other top-level entry that is not the harness's own (other
  work's scratch: a build directory, a decompressed baseline session log, the host provenance,
  the dry-run root `dry/`) is blocked like a sibling by `--block-siblings` and listed in the
  manifest (`isolation.ab_extras_blocked`). No other process may work in the worktrees while a
  paid batch runs (a change would make the running cell invalid).
- **Order.** A, B and C are interleaved in one batch: per (task, rep) the three arms run back to
  back, the first arm `arms[(rep − 1 + seed + i) % 3]` with i the task's index in (c1, c2, r2, f1),
  so each arm goes first once in every three consecutive reps of a task and once across any three
  tasks of a rep. Cells never run concurrently.
- **Guards.** A paid run with `gates-svs2.json` refuses any arm other than a, b, c (the baselines
  are never re-run) and a vault salt other than the baseline's; `--structure-as` is offline only.
- **Manipulation checks per cell** (validity, from `gates-svs2.json` structure): 16 tools with the
  exact names (the host's 12 plus `expand_result`, `recall_search`, `recall_step`, `recall_turn`;
  verified on 0.2.1-rc.2 in the dry run, §12.6); short tape headers and long tool lines; the arm's
  system-prompt markers (A: the slice persona present, the "recorded file read" sentence absent;
  B and C: both absent; A's new-rule marker added at the freeze).

Procedure (commands from `AB`; `H=$AB/wt-harness/scripts/ab`, `G=$H/gates-svs2.json`):

1. Freeze: the arm texts and diffs into §2.2, the arms' tarballs packed, A's marker into the
   gates file, this record committed before any paid call.
2. `prepare --arm stock=none --arm a=<tgz> --arm b=<tgz> --arm c=<tgz> --overlay
   $H/profile/eval-neutral.patch.yml --gates $G` (plus `--arm-overlay c=…` if C's key is off by
   default). STOCK's home only serves the dump comparison; it never runs. Then copy the baseline's
   salt into the vault before any f1 cell runs, offline ones included (run_ab creates a new salt
   when none exists): `cp <archive>/vault/task-seed-salt $AB/vault/task-seed-salt && chmod 600
   $AB/vault/task-seed-salt`, sha256 `c5e46161…` as gates `pairing.salt_sha256`.
3. Offline: `--offline --arms a,b,c --tasks hello --reps 1 --batch offline-fp --fingerprints none`,
   then `fingerprints --batch-dir … --out $AB/vault/fingerprints.json`, then the five stages of
   the batch as batch `offline` (as §12.6, real arms, no `--structure-as`; its manifests must note
   "the vault salt is the baseline's"), and `isolation-probe --arms a,b,c --target-batch offline
   --gates $G` while no other agent works in the worktrees (the probe plants and removes canaries
   in every worktree's `scripts/` and `docs/` and a file in one worktree's `src/`).
4. Before the key is linked: `svs2_checks.py conditions`, `host --host $AB/host`, `f1-content
   --salt $AB/vault/task-seed-salt`; `import-baseline --out $AB/vault/baseline` at the frozen
   commit.
5. The operator links the key into the three template homes (`ln -s ~/.dsh/.env
   $AB/vault/homes/<arm>/.env`), never read, printed or copied.
6. Warmup `warm`: `--arms a,b,c --tasks hello --reps 2 --fingerprints none --block-siblings
   --budget-usd 10`, then `fingerprints --compare $AB/vault/fingerprints.json`; from rep 2 step 1
   must read at least 4,000 cached tokens in every arm.
7. Batch `batch`, seed 20261024, one invocation per stage of §10 in ladder order, each after
   `svs2_plan.py --baseline $AB/vault/baseline --batch $AB/vault/results/batch --ledger
   $AB/vault/spend.jsonl` says the stage is affordable:

   ```sh
   R="python3 $H/run_ab.py --ab-root $AB --gates $G --budget-usd 10 --block-siblings --arms a,b,c --batch batch --seed 20261024"
   $R --tasks c1,c2,r2,f1 --reps 2 --host-content-digest      # S1
   $R --tasks c1,c2 --reps 3 --resume                         # S2
   $R --tasks f1 --reps 3 --resume                            # S3
   $R --tasks c1,c2 --reps 4 --resume                         # S4
   $R --tasks r2 --reps 4 --resume                            # S5
   ```

   An invalid cell is rerun once (`--max-attempts 2`); an HTTP 402 / account error stops the run
   (`account_stop`, exit 2), and the record says so.
8. Report: `svs2_report.py report $AB/vault/results/batch --baseline $AB/vault/baseline --gates $G
   --ledger $AB/vault/spend.jsonl`; arbitration only as §9.
9. Archive: `secrets-scan` first; held-back cells into a `chmod 700` `held-back/`; raw data to
   `~/Documents/kimi/workspace/dsh-slice/results/20261024-svs2/`; small summaries to
   `docs/ab/svs2-2026-10-24/`.

## 5. Tasks

The baseline's own four, unchanged (files byte-identical to tree `b111e434`, §12.2):

| alias | task | turns | step cap | class | why it is here |
|---|---|---|---|---|---|
| c1 | `lh1_incremental_build` | 8 | 14 | coding | the largest overhead (SLICE 1.587x STOCK); the re-read and edit pattern of §1 |
| c2 | `m3_consistency_bugfix` | 1 | 26 | coding | one turn: the plugin's prefix and folds without sealing |
| r2 | `p110_r2_superseded_stamp` | 7 | 12 | memory (recall) | a short recall task: a change that drops the re-read rule must not cost recall |
| f1 | `svs_f1_flood_recall` | 45 | 12 | long + memory | the long-session saving (SLICE 0.611x STOCK) must survive |
| hello | `hello` | 1 | 4 | warmup | prefix cache, fingerprints |

## 6. Metrics

### 6.1 As the baseline

One row per cell from `ab_metrics.py`, unchanged for every quantity the baseline reported (the
import checks this, §12.4): billed tokens of every request, failed attempt and compaction
summarizer call on both sheets; cache hit rate; request sizes; compaction, prune, spill and fold
events; recall sourcing; exams, delivery, leaks, flagged access; requests and steps per turn,
step-cap cuts.

### 6.2 New: re-read classes and refusals (`ab_metrics.reread_classes`, row key `rereads`)

Every read of a file, in session order, gets one class, first match wins:

| class | definition |
|---|---|
| `after_own_edit` | the file was edited or written earlier in this turn |
| `same_turn` | the file was read earlier in this turn and not edited since |
| `cross_turn` | the first read in this turn of a file read or edited in an earlier turn (the brief's "start-of-turn re-read of an earlier-seen file") |
| `first` | never seen before in the session |

- A read is a `read` tool call or a bash command that is one plain read of one text file (`cat`,
  `head`, `tail`, `nl` or `sed -n`, optionally after `cd DIR &&`, no pipe, list or redirection).
  Paths are resolved against the session cwd (a bash `cd` too) and compared in their `/private`
  spelling.
- `edits_writes` counts `edit` and `write` calls, refused or not; `bash_writes` counts bash calls
  that write a file (reported apart; they do not set `after_own_edit`).
- `fs_not_observed` and `fs_stale_version` count tool results carrying the host's two refusal
  texts.
- These are the definitions of the follow-up analysis of the baseline's c1 logs, kept so that its
  figures reproduce (§12.4). Line ranges are ignored: a file read in several chunks in one turn
  counts as one `first` (or `cross_turn`) read and then `same_turn` re-reads (f1's chunked reads
  in SLICE, §12.4). The range-aware same-turn re-read counts of the baseline (`reads`) stay
  reported.

### 6.3 New: manipulation checks

`validity.system_markers` (which declared marker strings the system prompt contains; the text
stays out of the row) and `tape.kept_raw_entries` (tape entries mentioning "kept raw"; C's
retention note, reported).

## 7. Pre-registered comparisons

Unit: a (task, rep index) pair. Its baseline side is the baseline cell; its arm side is the
mean over the arm's valid cells at that rep index (one from the batch, a second only from the
arbitration). Cost on the off-peak sheet; peak is exactly twice every field, so no ratio depends
on the sheet.

Per arm X ∈ {A, B, C} and comparison arm Y, per task t: **R_t(X/Y)** = Σ X sides / Σ Y sides
over the task's valid pairs.

- **Primary, against STOCK:**
  - **N_code(X)** = geometric mean of R_c1 and R_c2;
  - **R_f1(X)**.
- **Secondary, never decisive:**
  - N_code3(X) = geometric mean of R_c1, R_c2, R_r2;
  - the same quantities against SLICE;
  - the steps: A/SLICE (the re-read rule; cross-batch), B/A (the persona; within the batch),
    C/B (working-set retention; within the batch), C/A;
  - per task the Σ ratio, the median paired ratio, min and max;
  - re-read classes per arm and task (§6.2), with SLICE and STOCK beside them;
  - requests and steps per turn, step-cap cuts, cache hit rate, peak and mean request tokens,
    folds, kept-raw entries.
- **Quality, against STOCK:**
  - dS = Σ pass(X side, the fraction of its valid cells that passed) − Σ pass(STOCK); dS_t per task;
  - over memory-eligible pairs (f1 4 items, r2 1): dM = correct items(X) − correct items(STOCK);
  - dB = bad items(X) − bad items(STOCK), where bad = wrong, decoy, stale, hedged or confabulated.
- **Quality floor Q** (an arm may not lose a pass or a memory item to STOCK beyond a margin of
  one): Q holds iff dS ≥ −1, no task with dS_t ≤ −2, dM ≥ −1 and dB ≤ +1.

Reference values of the baseline itself under these rules (SLICE against STOCK, 15 pairs, from the
import): N_code 1.2606 (R_c1 1.5871, R_c2 1.0013), R_f1 0.6109, N_code3 1.1306 (R_r2 0.9095),
dS 0, dM 0, dB 0 over 15 memory items. SLICE's interpretation under §8 is "does not fix the
short-session overhead".

Secondary, reported hypotheses (not tests): A has fewer `after_own_edit` re-reads on c1 than SLICE
(28); C has fewer `cross_turn` re-reads on c1 than B; B's c1 requests per turn are closer to
STOCK's (5.78) than A's.

## 8. Interpretation rule (per arm, pre-declared)

Applied top to bottom for each of A, B and C against STOCK; the first that matches gives the
arm's interpretation (`svs2_report.interpret`):

| # | condition | interpretation |
|---|---|---|
| 1 | a minimum of §8.1 not met, or N_code or R_f1 not computable | **inconclusive** |
| 2 | Q fails | **quality floor fails** |
| 3 | N_code ≤ 1.10 and R_f1 ≤ 0.80 | **fixes the short-session overhead** |
| 4 | N_code ≤ 1.10 and R_f1 > 0.80 | fixes the short-session overhead but loses the long-session saving |
| 5 | N_code > 1.10 and R_f1 ≤ 0.80 | does not fix the short-session overhead |
| 6 | otherwise | neither |

Which change moves the cost (reported, not a decision): a step's N_code (geometric mean of its
R_c1 and R_c2) and its R_f1 are labelled "moves the cost down" at ≤ 0.95, "up" at ≥ 1.05, else "no
measurable effect at this n". B/A and C/B are within one batch; A/SLICE is cross-batch (§11).

### 8.1 Minimum valid pairs (per arm, against STOCK; the same reported against SLICE)

Planned 15 pairs (c1 4, c2 4, r2 4, f1 3) and 16 memory items (f1 4 x 3, r2 1 x 4). Minimums:
**10 pairs, at least 2 per task, 8 memory items.** The ladder's deepest step (§10) keeps c1 3,
c2 3, r2 2, f1 2 = 10 pairs and 10 items. Below a minimum the arm's interpretation is
"inconclusive" unless the arbitration restores it.

## 9. Arbitration (at most once, pre-declared)

- **Trigger, per arm, on the batch before pooling:** a minimum not met; or the arm's
  interpretation would change if N_code or R_f1 moved by 0.05 in either direction; or Q decided
  at its margin (dS = −1 or −2, some dS_t = −1 or −2, dM = −1 or −2, dB = +1 or +2).
- **What runs:** for each triggered arm, one more cell at every rep index of the tasks behind the
  marginal quantity (N_code: c1 and c2; R_f1: f1; Q: the tasks whose dS_t or memory decides; a
  minimum: the tasks below it), batch `arb`, seed 20261025, the same seed keys (f1 content again
  equals its baseline partner's), arms of a group rotated as in the batch. The baselines cannot
  get more cells; the extra cell joins the arm side of its pair (the mean of two cells).
- **Budget condition:** ledger + the arbitration's estimate (`svs2_plan.py --arbitrate
  ARM:TASKS`, measured per-cell means) ≤ cap − reserve − margin ($8.65). If not every triggered
  (arm, quantity) fits, they are taken in this order while the condition holds: N_code before
  R_f1 before Q; arms A, B, C. The rest stay unarbitrated and are marked so.
- **Decision on the pooled cells**, same rules and thresholds, minimums unchanged, no band test,
  no second arbitration. `svs2_report.py report` prints the trigger per arm with the tasks to add.

## 10. Budget, cost model and ladder

Hard cap **$10 at peak prices** over everything (warmup, batch, arbitration), enforced by
`run_ab.py --budget-usd 10` over one ledger `AB/vault/spend.jsonl`; reserve $0.75, margin $0.60
(stop line $8.65), $0.05 per unpriced step, stop after 40 unpriced charges. Expected ≤ $6.

**Cost model** (`svs2_plan.py`, gates `budget`): a new cell's prior at peak is the baseline's
mean per cell (from the imported cells: SLICE c1 $0.1624, c2 $0.0087, r2 $0.0196, f1 $0.2619;
STOCK c1 $0.1023, c2 $0.0087, r2 $0.0215, f1 $0.4287), taken as max(SLICE, STOCK) for c1, c2, r2
and hello, and SLICE's for f1 (every new arm seals like SLICE), times a safety factor 1.2: c1
$0.1948, c2 $0.0105, r2 $0.0258, f1 $0.3143, hello $0.0012. Once an (arm, task) has a finished
cell, its measured mean replaces the prior.

**Stages and ladder** (3 arms each; the run order is the reverse of the cut order):

| stage | cells | prior (peak) | cut |
|---|---|---|---|
| warm: hello reps 1–2 | 6 | $0.0072 | never |
| S1: c1, c2, r2, f1 reps 1–2 (the floor) | 24 | $3.2725 | never |
| S2: c1, c2 rep 3 | 6 | $0.6159 | last |
| S3: f1 rep 3 | 3 | $0.9428 | third |
| S4: c1, c2 rep 4 | 6 | $0.6159 | second |
| S5: r2 reps 3–4 | 6 | $0.1550 | first |
| **full design** | **51** | **$5.6093** | |
| arbitration reserve: one arm, c1 + c2, 4 rep indices | 8 | $0.8212 | |
| **planned with the reserve** | | **$6.4305** | ≤ $7.00 planning target: nothing cut |

- Without the safety factor the full design is $4.67.
- **Rules.** Before the batch, the full design plus the reserve must project to ≤ $7.00, else
  stages are dropped from the end until it does (not needed at these priors).
- Before each stage, ledger + that stage's unrun cells at measured means + the reserve must stay
  ≤ $8.65, else that stage and every later one are skipped and the record says so.
- The budget's own kill (spend + margin ≥ cap) stays as the last line.
- **Wall time:** the baseline's median cells took 5.7 (STOCK) to 13.7 (SLICE) min on c1, 0.5 min
  on c2, 1.5 min on r2 and 7–9 min on f1; at those figures the 51 cells take about 3.5–4.5 hours,
  run in the background one stage per invocation and polled through `AB/progress.txt` (no single
  tool call longer than ten minutes).

## 11. Risks and limits

- **Cross-batch comparison (the main caveat).** Every arm-versus-STOCK and arm-versus-SLICE
  number compares cells of different sessions: the baseline cells ran on 2026-10-23 10:43–13:42 UTC, the
  new arms at least several hours later, with no concurrent STOCK or SLICE control. Provider-side
  variance (latency, cache retention, routing, model serving changes) cannot be separated from an
  arm effect. Pairing by rep index is bookkeeping for c1, c2 and r2, whose content is identical in
  every rep; only f1's pairs share seeded content. B/A, C/B and C/A are within one batch and are
  the cleanest comparisons; A/SLICE is not.
- **The baselines are fixed.** No baseline cell can be added or rerun; an invalid new cell
  cannot be paired again except by its retry; the arbitration adds arm cells only.
- **Low power.** n = 3–4 per task; the baseline's paired c1 ratios ranged 1.39–2.12. Thresholds
  are 0.05 wide or wider; only large effects are detectable.
- **Cumulative arms.** B contains A's change and C contains B's, so B/A and C/B are the marginal
  effects of the persona and of retention given the earlier changes, not their effects alone.
- **The fs-observation state resets every turn** in the headless harness (one process per turn).
  A's rule leans on the edit guard; in this harness the guard forces one read per file per turn
  whatever the arm, so a cross-turn re-read is often required here and would not be in a
  long-running agent. C keeps the read visible, but the host still demands a read in the new
  process before an edit.
- **f1 oracle values exist outside the A/B root.** Reusing the baseline's salt makes f1's content
  and oracle values those of the baseline cells, which the archive under `~/Documents` (not
  blocked) and the old A/B root `$SCRATCHPAD/svs` (blocked as a sibling) hold. A tool call outside
  the workdir is flagged and the oracle's arrival is caught by content, as for r1–r5 in the
  baseline; such a pair leaves the memory comparison.
- **A's and C's texts are not frozen yet** (§13); the marker of A's rule is added then.
- **Re-read classes ignore line ranges** and count only edit/write calls as edits (§6.2), as the
  analysis they reproduce did.
- **External validity** as the baseline record §16: one host, one model route, headless
  one-process-per-turn, hermetic composition, DeepSeek's cache pricing.

## 12. Build evidence (offline, no key)

Harness `327b0c5` on `exp/svs2-harness` (code; the docs commit follows). No key exists in any
svs2 home; the dry runs use the mock adapter.

### 12.1 Host

`svs2_checks.py host --host $SCRATCHPAD/svs2/host`: dsh 0.2.1-rc.2, tree digest
`0c9e7f6b25ec619cbfe60fc8a0df27f753f589fba9146a49b8718604776a824a` and content digest
`5c0747d0bd13e87852388ec6313dc2544d1403191c81192e36d2c95c24d998be`, both equal to the baseline's
frozen host; 63,615 files, 12 symlinks. Provenance in `$SCRATCHPAD/svs2/host-provenance/`
([host-digests.json](ab/svs2-2026-10-24/host-digests.json)):

| tree | tree digest | content digest | note |
|---|---|---|---|
| baseline frozen host (`svs/host`) | `0c9e7f6b25ec…` | `5c0747d0…` | installed 2026-10-23 07:11 UTC |
| **svs2 host (clone of it)** | `0c9e7f6b25ec…` | `5c0747d0…` | used |
| fresh `npm install --save-exact`, 2026-10-23 18:04 UTC | `931d69569151…` | `7ab79990…` | `execa` 10.2.1 instead of 10.2.0; not used |
| `npm ci` from the baseline's lockfile | `3cf1ed24b4ff…` | `5c0747d0…` | same content as the frozen host |

The fresh trees were removed after the comparison; their lockfile diff and logs are kept.

Incident during the build: the first install attempt ran `npm install` in the empty `host`
directory without a `package.json`. npm then took the scratchpad as its project root, because the
scratchpad held a `node_modules` symlink to the main checkout's `node_modules`, and removed that
symlink. The install was stopped at once, before it wrote anything else: no `package.json`,
lockfile or `node_modules` directory was created in the scratchpad. The symlink was recreated with
its original target, `/Users/tongtao/code/dsh-slice-agent-loop/node_modules`, and the target was
never touched. The install that was kept ran `npm init -y` first, as the baseline's did.

### 12.2 Same conditions

`svs2_checks.py conditions` ([conditions.json](ab/svs2-2026-10-24/conditions.json)): every file
of `tasks/{hello, lh1_incremental_build, m3_consistency_bugfix, p110_r2_superseded_stamp,
svs_f1_flood_recall}` (4, 4, 4, 5, 5 files), `prices.json`, `step-cap.mjs`, `mock-llm.mjs`,
`eval-offline.patch.yml`, `profile/eval-neutral.patch.yml` (sha256 `74b7a95e…`, the baseline
manifests' overlay sha) and the profile template are byte-identical to tree `b111e434`; the
step-cap patch for c1 14, c2 26, r2 12 and f1 12 equals the baseline's `patches/{batch,arb}`
files with the A/B root swapped. On main `6633617` the whole `scripts/ab` tree is still
`b111e434`, and `src/`, `lib/`, `package.json` and `cordis.patch.yml` equal `c73ee22`'s.

### 12.3 f1 content

`svs2_checks.py f1-content --salt <baseline salt>` ([f1-content.json](ab/svs2-2026-10-24/f1-content.json)):
the salt's sha256 equals `pairing.salt_sha256`; through `run_ab.task_seed` with the gates seed
keys (in a batch of another name) f1's setup produces, for rep indices 1, 2 and 3, the same truth
sidecar (sha256) and the same 32 data files as the packed workdirs of the paired baseline cells,
in both arms. Hashes only; the temporary directory was removed.

### 12.4 Baseline import and the re-read reproduction

`svs2_report.py import-baseline` ([baseline-import.json](ab/svs2-2026-10-24/baseline-import.json)):
30 cells (SLICE and STOCK; c1 4, c2 4, r2 4, f1 3), **every stored metric and every
memory-exclusion flag reproduced** by the new `ab_metrics.py` (0 mismatches); f1's exam specs
came from the truth sidecars inside the packed workdirs, read in memory. Re-read classes over
the valid cells ([rereads-baseline.md](ab/svs2-2026-10-24/rereads-baseline.md)):

| arm | task | cells | first | cross-turn | same-turn | after own edit | edits/writes | bash writes | FS_NOT_OBSERVED | FS_STALE_VERSION |
|---|---|---|---|---|---|---|---|---|---|---|
| STOCK | c1 | 4 | 6 | **27** | 10 | **9** | **84** | 23 | 1 | 0 |
| SLICE | c1 | 4 | 8 | **59** | 0 | **28** | **168** | 90 | 1 | 0 |
| STOCK | c2 | 4 | 23 | 0 | 0 | 5 | 25 | 6 | 4 | 0 |
| SLICE | c2 | 4 | 34 | 0 | 0 | 12 | 21 | 5 | 0 | 0 |
| STOCK | r2 | 4 | 6 | 4 | 0 | 3 | 27 | 6 | 2 | 0 |
| SLICE | r2 | 4 | 8 | 8 | 0 | 3 | 21 | 15 | 0 | 0 |
| STOCK | f1 | 3 | 108 | 107 | 0 | 90 | 139 | 3 | 4 | 0 |
| SLICE | f1 | 3 | 109 | 105 | 118 | 39 | 98 | 61 | 2 | 0 |

The c1 rows reproduce the follow-up analysis exactly (cross-turn 27 vs 59, after own edit 9 vs
28, edits/writes 84 vs 168, FS_NOT_OBSERVED 1 vs 1). One read needed the bash `cd` target
unquoted (`cd "/private/…/w-…" && cat …`) to resolve to the same file. SLICE's 118 same-turn
re-reads on f1 are its chunked reads of one excerpt (§6.2).

### 12.5 Tests

`test_svs2.py` 23/23 (rotation per task and rep; baseline seed keys and the salt guard; the
run-arms and stand-in guards; top-level worktrees and A/B-root extras; the content digest;
tool-name and marker validity; re-read classes; pairing by rep index, side means after
arbitration, the interpretation table, the quality floor and minimums, the arbitration trigger,
steps and the summary; the import's stored-metric diff; the ladder and affordability; the task
definitions against tree `b111e434`); `test_run_ab.py` 29/29, `test_ab_metrics.py` 26 (22 pass,
4 skip without data), `test_ab_report.py` 14/14, `test_svs_report.py` 10/10,
`selfcheck_tasks.py` 49/49.

### 12.6 Offline dry run (mock; the SLICE build as stand-ins for A, B and C)

The arms were not packed yet, so the dry run used the baseline's SLICE tarball
(`slice-main-c73ee22.tgz`, sha256 `62b0eb7e…`, the build of main's `src/` and `lib/`) as stand-ins
named a, b and c, each validated against the slice structure (`--structure-as a=slice` and so
on). A/B root `$SCRATCHPAD/svs2/dry` (host: an APFS clone of `svs2/host`, same digests), harness
`327b0c5` (clean), mock adapter, seed 20261024, the dry root's own salt. Summary:
[dry-run.json](ab/svs2-2026-10-24/dry-run.json), report:
[report-dry-mock.md](ab/svs2-2026-10-24/report-dry-mock.md).

- **prepare** (`--arm stock=none --arm a=… --arm b=… --arm c=…`, neutral overlay, `gates-svs2.json`):
  each stand-in differs from STOCK exactly in `slice-agent-loop`; STOCK's dump (412 lines) and a
  stand-in's (415 lines) equal the baseline's `dump-stock.yml` and `dump-slice.yml` line for line,
  paths normalized.
- **Fingerprints** (`offline-fp`, hello x 3 arms): 16 tools, the exact names of gates
  `tool_names`; system prompt `46c592c8…` (3,651 characters), recall tools `4d9ca4cc…` (5,266),
  request prefix 17,974 characters, all equal to the baseline SLICE's. The batch's fingerprints
  compare unchanged with them.
- **The batch, run as the paid runbook's stages** (S1 `--reps 2`, then S2–S5 with `--resume`),
  2026-10-23 18:32–19:16 UTC: **45 of 45 cells valid on the first attempt** (c1 4, c2 4, r2 4,
  f1 3 per arm); every turn of every cell ran (c1 8, c2 1, r2 7, f1 45); delivery of r2 T2/T4 and
  f1 T3/T5 in every cell; 44 short tape headers per f1 cell; no flagged call, leak, quarantined
  entry, stray process or worktree change; host tree digest unchanged in all five invocations;
  content digest `5c0747d0…` recorded at S1; mock spend $0.1847 (the batch's own ledger).
- **Order** (index.jsonl): per (task, rep) the three arms ran back to back, the first arm
  rotating by task and rep: rep 1 c2 a, c1 c, f1 c, r2 b; rep 2 c1 a, c2 b, f1 a, r2 c; rep 3
  c1 b, c2 c, f1 b, r2 a; rep 4 c1 c, c2 a, r2 b. Over the three reps of each task every arm went
  first once.
- **Seed keys:** within each f1 group the three arms' truth sidecars are identical, and equal to
  a setup from the mapped keys (batch r1, batch r2, arb r1) with the dry salt, not to one from the
  dry batch's own (batch, rep). With the baseline's salt the same keys give the baseline's content
  (§12.3).
- **Manipulation checks, negative control** (`dry-neg`, c2 x arms a and b, the real structure,
  no `--structure-as`): both stand-ins are invalid: a with "system prompt carries the excluded
  marker 'A recorded file read is not a current file'", b with that and "… 'You are sliceagent'".
- **Report end to end:** `svs2_report.py report` on the dry batch against the imported baseline
  pairs 15 pairs per arm and comparison, computes every quantity of §7, the interpretation of §8,
  the arbitration test and the steps. Its numbers come from the mock's fixed usage and a mock that
  solves no task, so they mean nothing.
- `AB_OFFLINE_BATCH=…/dry AB_GATES=gates-svs2.json test_ab_metrics.py`: 23 pass, 3 skip (no Raft
  logs); the mock-log check covers all 45 cells. `secrets-scan` on the dry root: none.

## 13. What the freeze must still fill in

- §2.2: A's exact rule text, B's and C's diffs, C's config key, default, K and byte cap, the tape
  note; the three tarballs (commit, sha256, files) and `check:build` output.
- `gates-svs2.json`: A's rule marker in `system_contains` of a, b and c; C's arm overlay if its key
  is off by default.
- §12: `prepare` on the real arms (dump comparison against STOCK), their offline fingerprints
  (16 tools, system-prompt shas and sizes), an offline dry run of the real arms on all four tasks
  (C's entries carry its working-set note; that its tape headers keep the short form and the 76/78
  lengths, or else the structure change C documents, is checked there),
  the isolation probe at `AB = $SCRATCHPAD/svs2` with the worktrees at the top level, and the
  import rerun at the frozen commit.
- The freeze commit records the final commands of §4 and changes only `docs/` and the gates
  file's marker; every paid manifest's `harness_commit` must be that commit or a later one with the
  same `scripts/ab` tree, not dirty.
