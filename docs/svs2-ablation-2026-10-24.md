# svs2: which part of slice's short-session overhead do the re-read rule, the persona and sealing cause?

> **Status: pre-registration draft, assembled (2026-10-24). No paid call has been made for this
> experiment.** §1–§11 are the design to be frozen before the first paid batch; the arm texts and
> diffs of §2.2 are final and the three tarballs are packed; §12 is the offline build evidence,
> including the real arms' homes, fingerprints and dry run (§12.7–§12.10); §13 lists what the
> freeze must still do. Times are UTC. The baseline is the record
> [slice-vs-stock-2026-10-23.md](slice-vs-stock-2026-10-23.md) ("the baseline record" below).

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
A, C to B. Each arm's template home is the host's headless composition plus the neutral overlay
plus the arm's tarball. `prepare` found each arm's `--dump-config` different from STOCK's only in
the `slice-agent-loop` row, and against the baseline's archived SLICE dump A and B are identical
line for line and C differs only in that row's config (§12.8).

| arm | branch, commit | change against SLICE | system prompt (headless, neutral overlay) |
|---|---|---|---|
| **A** | `exp/svs2-a` `421d695` | the RECALL paragraph's re-read sentence replaced by an edit-guard-aware rule; everything else, persona included, unchanged | 3,832 characters, sha256 `35892843…`; slice persona present; "recorded file read" sentence absent; "never re-read a file just to be safe" present |
| **B** | `exp/svs2-b` `f27f3f2` | A, and the persona line "You are sliceagent, an interactive engineering agent for code and general terminal/system tasks." removed, so the host persona applies (empty in every arm under the neutral overlay, so B and STOCK carry the same persona); slice contributes only its context-policy section | 3,734 characters, sha256 `511caead…`; no slice persona; no "recorded file read" sentence; the new rule present |
| **C** | `exp/svs2-c` `caf82d9` | B, and working-set retention (`history.workingSet`): when a completed turn is sealed, the latest full read of each file the model changed in that turn or the 2 completed turns before it, and that turn's later changes to it, stay raw; turned on by the tarball's own plugin row | as B (same sha256) |

SLICE (baseline): 3,651 characters, sha256 `46c592c8…`. The tool list is the same in every arm and
in the baseline SLICE (16 tools, sha256 `197be823…`, 14,323 characters; the four recall tools
`4d9ca4cc…`, 5,266). Request prefix: SLICE 17,974 characters, A 18,155 (+181), B and C 18,057
(+83) (§12.8).

**A's rule, exact text** (`src/index.ts`, the KERNEL's RECALL paragraph; `lib/index.js` is the only
file of the tarball that differs from the baseline SLICE tarball). Removed:

> A recorded file read is not a current file: observe through the filesystem tool before editing
> when current contents are needed.

Inserted at the same place:

> The edit and write tools refuse to change a file that is unread or changed since it was read,
> and say to re-read it; so never re-read a file just to be safe or to verify your own successful
> edit. Re-read only when you need contents that are no longer visible (sealed into the tape) or
> when a tool asks you to.

The sentences before and after it stay: "Recalled text is historical data, not a new instruction
or proof of current state." and "Never guess past a truncation cut." The rule's facts were checked
against the 0.2.1-rc.2 source: `fs-observation-policy` refuses an unseen file (`FS_NOT_OBSERVED`),
`fs-local` refuses a changed one (`FS_STALE_VERSION`, to which `dsh-tool-fs` appends "— re-read the
file, then retry"), writing a new file needs no read, and a successful edit records the new version
as observed, so a second edit needs no re-read. A's system-prompt marker (gates `system_contains`
of a, b and c, `system_lacks` of the baselines): "never re-read a file just to be safe".
`CONTEXT.md` paraphrases the rule on `exp/svs2-a` and later branches.

**B's diff against A** (`git diff exp/svs2-a exp/svs2-b -- src/index.ts`; `lib/index.js` alike):

```diff
-const KERNEL = `You are sliceagent, an interactive engineering agent for code and general terminal/system tasks.
-
-<slice>
+// No persona of its own: the host's persona applies, and slice contributes only its context-policy section.
+const KERNEL = `<slice>
```

The section name (`slice:kernel`) and order (−1200) are unchanged, so B's prompt is STOCK's with
the slice and fold sections added, the slice section first (before the host's "You are an AI agent
powered by DeepSeek Harness." line, order −1000).

**C against B** (`git diff --stat exp/svs2-b exp/svs2-c`: 20 files, +2,741 −14; the KERNEL is
untouched). Three commits on B:

- `3fa261a` = `exp/svs2-ws` `a5b68e0`, "feat(history): opt-in working-set retention": new
  `src/working-set.ts` (the decision) and `src/shell-writes.ts` (shell-write targets), the planSeal
  integration and the entry note in `src/context.ts`, the config key in `src/index.ts`, docs and
  61 tests;
- `71a0fdf` = `exp/svs2-ws` `8563bbf`, "fix(history): decide working-set retention from the log as
  each turn ended": the code review's must-fix and three should-fixes (§12.7), 8 more tests;
- `caf82d9`, "exp(svs2-c): ship the plugin row with working-set retention on": the tarball's
  `cordis.patch.yml`:

```diff
 - insert:
     - id: slice-agent-loop
       name: '@dsh-external/dsh-slice-agent-loop'
+      config:
+        history:
+          workingSet: {}
```

What C does, as built:

- **Config key and default.** `history.workingSet` with `turns` (K, default 2) and `maxChars`
  (default 48,000); off when the key is absent (the code default, as on `exp/svs2-ws`); `{}` turns
  it on with the defaults; bad keys and values are refused at load. C turns it on in its own
  packaged row, so no arm overlay is needed (gates `structure.c.dump_rows` stays
  `["slice-agent-loop"]` against STOCK; `dump_rows_vs_slice` is `["slice-agent-loop"]`).
- **What stays raw.** When turn N seals, for each file in the working set: the step with the
  file's latest full view in turn N (a DSH `read` from line 1 to the end-of-file footer, not
  condensed in the turn, or a `write`) and every later step of turn N that changed it (`edit`,
  `write`, a recognised shell write, a `run_code`-dispatched edit). A turn that changes a file
  without viewing it again extends the file's raw view while that view and every change since are
  raw. Files only read, earlier views superseded in the same turn, window reads, failed edits and
  every other step seal as before.
- **Working set and K.** A file is in the working set if the model changed it in turn N or in the
  K = 2 turns before it: the set survives one or two turns that only test or review the file, the
  usual pause in work on a file, without keeping reads of files the model stopped changing.
- **Bounds.** The unit kept is a whole step (the assistant message and every result answering it),
  so calls stay paired. A step whose other results outweigh its working-set content by more than
  4,000 characters is not kept (a notes file read beside a 13K flood log). Each file is kept all or
  nothing, files changed in more turns of the window first, then the most recently touched, within
  `maxChars` = 48,000 characters per sealed turn of visible text, reasoning, call arguments and
  results (about 14K tokens at the ~3.4 characters per input token of the 2026-10-23 logs,
  reasoning included, which is billed when replayed; a full read of a ~500-line source file plus a
  turn's edits to it). A kept view is never retired, so only the per-turn cap bounds a whole
  session: in this harness, where every turn must read the file again before editing it (§11), each
  coding turn keeps one more view.
- **Tape note.** A kept step is protected like a human message: it cuts the turn's entry instead of
  entering it, and the turn's first entry carries one line `[slice note · working set: step(s) 4, 5
  of this turn kept raw in place for calc.py]` (the existing `[slice note · …]` form; it names the
  steps and the files, which the brief's example "[turn N · k file read(s) kept raw]" does not);
  compact capped entries drop it. `tape.kept_raw_entries` counts the entries that carry it. Tape
  headers keep the short form and the 76/78 lengths (§12.9).
- **Cache safety.** The decision for a turn reads the log as it stood when that turn ended (views
  and sizes from the original results or from an in-place view another producer made within the
  turn); the surface is consulted only for which steps are still there. So every later seal and a
  resumed process decide the same: kept nodes are never sealed later, sealed nodes are never
  brought back, and the prefix through the last entry stays frozen. Recall (`recall_turn`,
  `expand_result`) serves kept and sealed results alike.

**Tarballs** (`npm pack --ignore-scripts` after `npm run check:build` passed in a clean worktree at
the commit; `AB/vault/artifacts/`, `SHA256SUMS` beside them; installed from the arm-neutral copies
`plugin-<sha12>.tgz`; [arms.json](ab/svs2-2026-10-24/arms.json)):

| arm | tarball | sha256 | files | differs from the baseline SLICE tarball in |
|---|---|---|---|---|
| A | `slice-svs2-a-421d695.tgz` | `dd23e957be30076ffbc4a7d8e759048803de340d29d42600db80a895c82b720d` | 35 | `lib/index.js` |
| B | `slice-svs2-b-f27f3f2.tgz` | `896ee6988f1bd3b5013c523e31cdc47c9ecb4a867e3ed7cff9a5252850d8bb97` | 35 | `lib/index.js` |
| C | `slice-svs2-c-caf82d9.tgz` | `22b10cbcdf39359540df1e3cc2ca0775771216a0c42c4c4ad908bad277c30fa5` | 39 | B's, plus `lib/context.js`, `lib/working-set.js`, `lib/shell-writes.js`, their types, `cordis.patch.yml`, `README.md`, `README.zh.md` |

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
| composition | same profile template, bundles and neutral overlay; the arm's tarball adds one row | `prepare` dump comparison against STOCK; `svs2_checks.py dumps`: A's and B's dumps equal the baseline's `dump-slice.yml` line for line, C's differs only in the slice row's config, the STOCK home's equals `dump-stock.yml` (paths normalized; §12.8) |
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
  verified on 0.2.1-rc.2 in the dry runs, §12.6, §12.9); short tape headers and long tool lines;
  the arm's system-prompt markers (A, B and C: "never re-read a file just to be safe" present, "A
  recorded file read is not a current file" absent; A: the slice persona present; B and C: absent).

Procedure (commands from `AB`; `H=$AB/wt-harness/scripts/ab`, `G=$H/gates-svs2.json`):

1. Freeze: the arm texts and diffs into §2.2, the arms' tarballs packed, A's marker into the
   gates file, this record committed before any paid call.
2. `prepare --arm stock=none --arm a=$AB/vault/artifacts/slice-svs2-a-421d695.tgz --arm
   b=$AB/vault/artifacts/slice-svs2-b-f27f3f2.tgz --arm c=$AB/vault/artifacts/slice-svs2-c-caf82d9.tgz
   --overlay $H/profile/eval-neutral.patch.yml --gates $G` (no arm overlay: C's tarball turns its
   key on), then `svs2_checks.py dumps --ab $AB` (each dump against the baseline's archived dumps).
   STOCK's home only serves the dump comparisons; it never runs. Then copy the baseline's
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
- **C keeps more than it saves here.** A kept view is never retired, and in this harness the edit
  guard forces a fresh read before every edit in every turn, so C keeps one more full view of the
  file being edited per coding turn (the builder's replay of the baseline's c1 logs: 47K–243K kept
  characters over 8 turns). C therefore mainly saves reads done for understanding, not the reads
  the guard forces; its c1 cost may sit above B's. The cost prior (§10, max of SLICE and STOCK) is
  kept.
- **The offline mock never edits** a file in c1, c2 or f1 (`mock-llm.mjs` reads and lists), so the
  plain dry run exercises C's retention only on r2's corrected config file; the editing variant of
  §12.10 shows it on c1.
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

`test_svs2.py` 23/23 at `327b0c5`, 26/26 at `fcca7c4` (the arm markers, the dumps check and the
offline adapter choice added; §12.8) (rotation per task and rep; baseline seed keys and the salt guard; the
run-arms and stand-in guards; top-level worktrees and A/B-root extras; the content digest;
tool-name and marker validity; re-read classes; pairing by rep index, side means after
arbitration, the interpretation table, the quality floor and minimums, the arbitration trigger,
steps and the summary; the import's stored-metric diff; the ladder and affordability; the task
definitions against tree `b111e434`); `test_run_ab.py` 29/29, `test_ab_metrics.py` 26 (22 pass,
4 skip without data), `test_ab_report.py` 14/14, `test_svs_report.py` 10/10,
`selfcheck_tasks.py` 49/49.

### 12.6 Offline dry run (mock; the SLICE build as stand-ins for A, B and C; before the arms existed)

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

### 12.7 Arm builds, the code review of C, and its fix

- **A and B** (`exp/svs2-a` `421d695`, `exp/svs2-b` `f27f3f2`): typecheck, vitest 342/342 (38
  files), `check:docs`, `check:size`, `check:build` pass on both. No test pins the KERNEL text.
- **Working-set retention, first build** (`exp/svs2-ws` `a5b68e0`): 403 tests (342 + 61). The
  review did not approve it: one must-fix, four should-fixes.
- **Must-fix, confirmed** with the reviewer's native probe (it failed on `a5b68e0` in one process
  and with one process per turn plus JSONL resume): a step-capped turn whose last step held the
  latest full read of a non-code working-set file was kept raw by the seal at the next turn's
  first step; the fold then condensed that result (no request had shown it, and the fold runs
  after the seal); at the following seal the read no longer counted as a view, and the step was
  sealed, rewriting nodes the previous requests carried (the request diverged at index 3, after the
  last entry at 2, so the old stable-prefix check passed). Fixed in `8563bbf`: the decision reads
  the log as each turn ended (views and every size from the original results or from in-turn
  replacements; a replacement after the turn ended changes nothing; a turn without `turn/end` is
  over once a later turn starts). The probe passes in both modes (the last request pair now
  extends the previous one exactly).
- **Should-fixes:** (1) a huge `turns` stalled every seal (planSeal 3 s at 1e8): the window now
  starts at the session's first turn with file events, so the loop is bounded by the session;
  values are not capped (the loop is cheap at any value; a test runs `Number.MAX_SAFE_INTEGER`).
  (2) No session-wide bound: confirmed as a property of the design, documented in `README.md`,
  `README.zh.md`, `CONTEXT.md`, the module comment and §2.2/§11; no session cap was added, the arm
  runs as designed. (3) Three surviving mutants (dropping `!step.intact`, the cap's `continue` as
  `break`, reasoning not counted): a test for each; all three, and two mutants of the fix
  (ignoring the turn-end check, taking sizes from the surface), now fail a test. A native helper
  checks that every node a request carried raw beside its turn's entries is on every later
  request, run on all native working-set tests. (4) `sys.stdout.write(` counted as a file write:
  `.write(` on `sys.stdout`/`sys.stderr` (and `.buffer`) and `process.stdout`/`stderr` no longer
  counts. No finding was rejected.
- **After the fix** (`exp/svs2-ws` `8563bbf`): 411 tests (342 + 69) in 41 files, typecheck,
  `check:docs`, `check:size`, `check:peers`, `check:build` pass.
- **C** (`exp/svs2-c` = B + `3fa261a`, `71a0fdf` cherry-picked without conflict, + `caf82d9`): the
  rebuilt `lib/` equals the cherry-picked one; 411/411, typecheck, `check:docs`, `check:size`,
  `check:peers`, `check:build` pass. Not run on any branch: `verify:packed` (needs a network
  install); the dry runs below install the packed tarballs into the frozen host instead.

### 12.8 The real arms: tarballs, homes, dumps, fingerprints

- **Tarballs** as §2.2; A's and B's contain the same 35 files as the baseline SLICE tarball
  `slice-main-c73ee22.tgz`, and differ from it only in `lib/index.js`.
- **prepare** (`--arm stock=none --arm a=… --arm b=… --arm c=…`, neutral overlay sha256
  `74b7a95e…`, `gates-svs2.json` as committed in `6936ba4`), 2026-10-23 20:08 UTC: each arm's dump
  differs from STOCK's (412 lines) exactly in `slice-agent-loop`
  ([arms.json](ab/svs2-2026-10-24/arms.json)).
- **Dumps against the baseline** (`svs2_checks.py dumps`,
  [dump-compare-baseline.json](ab/svs2-2026-10-24/dump-compare-baseline.json)): A's and B's
  dumps (415 lines) equal the archived `dump-slice.yml` line for line, paths normalized; C's (418
  lines) differs only in the `slice-agent-loop` row, by the three lines `config:`, `history:`,
  `workingSet: {}`; the STOCK home's equals `dump-stock.yml`. So the new arms differ from the
  baseline SLICE arm only in the plugin tarball and, for C, its packaged config.
- **Fingerprints** (`offline-fp`, hello x a, b, c, all valid,
  [fingerprints.json](ab/svs2-2026-10-24/fingerprints.json)): as §2.2. Every cell's system-prompt
  markers as declared.
- **Salt:** the baseline's `task-seed-salt` copied into `AB/vault` (mode 600, sha256 `c5e46161…`
  equal to gates `pairing.salt_sha256`) before any f1 cell ran.
- **Baseline import rerun** at `fcca7c4`: 30 cells, 0 mismatches; the only change against the
  `327b0c5` import is the third marker in each row's `validity.system_markers` (false in every
  baseline cell) ([baseline-import.json](ab/svs2-2026-10-24/baseline-import.json)).

### 12.9 Offline dry run of the real arms (mock)

Batch `offline`, A/B root `AB` itself, harness `6936ba4` (clean), the real arms (no
`--structure-as`), seed 20261024, the baseline's salt, the five stages of §4 step 7 as five
invocations, 2026-10-23 20:15–20:45 UTC; without `--block-siblings` (offline; the scratchpad holds
other work). Summary: [offline-real-arms.json](ab/svs2-2026-10-24/offline-real-arms.json),
report: [report-offline-mock.md](ab/svs2-2026-10-24/report-offline-mock.md).

- **45 of 45 cells valid on the first attempt** (c1 4, c2 4, r2 4, f1 3 per arm): every turn exited
  0 (c1 8, c2 1, r2 7, f1 45 per cell), every session log found, a metrics row per cell; the
  manipulation checks of §4 held in every cell (16 tools, short headers, long tool lines, markers).
- Delivery of r2 T2/T4 and f1 T3/T5 in every cell; no flagged call, leak, quarantined entry, stray
  process or worktree change; `secrets-scan` none; host tree digest unchanged in all five
  invocations, content digest `5c0747d0…` recorded at S1; every manifest that ran f1 notes "the
  vault salt is the baseline's".
- **f1 content:** in each f1 group the three arms' truth sidecars are identical and equal to the
  paired baseline cells' (`a4da8880…`, `0af3b1ea…`, `340786f4…`, as §12.3).
- **Order:** as §12.6 (the first arm per (task, rep): rep 1 c2 a, c1 c, f1 c, r2 b; rep 2 c1 a,
  c2 b, f1 a, r2 c; rep 3 c1 b, c2 c, f1 b, r2 a; rep 4 c1 c, c2 a, r2 b).
- **Tape:** A and B 28 entries on c1, 132 on f1, 24 on r2; C the same on c1 and f1 (the mock never
  edits there) and 28 on r2, where each cell's T4 corrects `config/service.env` by a shell write
  and reads it: C keeps that read raw, 1 kept-raw entry per r2 cell. Header lengths 76 (78 on f1's
  two-digit turns) in every arm.
- **Prefix check on the real logs** (the surface each model request carried, taken just before
  each appended assistant message, 904 requests per arm): no node carried raw beside its turn's
  entries ever left a later request, and consecutive requests always first differ after the
  earlier one's last entry ([ws-demo.json](ab/svs2-2026-10-24/ws-demo.json),
  `prefix_check_offline_batch`).
- The report runs end to end on the real arms against the imported baseline; the mock solves no
  task, so its numbers (every arm "quality floor fails") mean nothing.

### 12.10 C's retention on c1 (editing mock)

Batch `offline-edit-all`: c1 rep 1 x a, b, c with `AB_MOCK_ADAPTER=mock-llm-edit.mjs`, harness
`fcca7c4`, 2026-10-23 20:48–20:50 UTC: before each turn's closing text the mock reads `calc.py` and
appends a comment to one of its lines with `edit` (8 edits per cell, no refusal). All three cells
valid. ([ws-demo.json](ab/svs2-2026-10-24/ws-demo.json).)

| | A | B | C |
|---|---|---|---|
| tape entries (kept-raw entries) | 7 (0) | 7 (0) | 14 (7) |
| sealed turns whose `read calc.py` and `edit calc.py` steps are still raw at the end | none | none | turns 1–7, both steps each (28 nodes) |
| surface characters at step 1 of turn 2 / 5 / 8 (system prompt included) | 6,838 / 10,913 / 16,319 | 6,740 / 10,815 / 16,221 | 8,527 / 18,137 / 29,578 |

C's entry for turn 1 carries `[slice note · working set: step(s) 4, 5 of this turn kept raw in
place for calc.py]`, and so on for turns 2–7; each turn's entry is cut in two around the kept
steps, headers short. The prefix check holds in all three cells (49 requests each; C carries 28
nodes raw beside entries, none ever leaves a later request). The growth from turn to turn is the
session-wide property of §2.2: the mock re-reads before every edit, as the edit guard makes every
arm do in this harness.

## 13. What the freeze must still do

Done at assembly (§2.2, §12.7–§12.10): the arm texts and diffs, C's key, default, K, cap and tape
note; the three tarballs; A's marker in the gates file; `prepare` on the real arms with both dump
comparisons; their fingerprints; the offline dry run of the real arms on all four tasks and C's
retention on c1; the import rerun.

Still to do before the first paid call:

- The isolation probe at `AB = $SCRATCHPAD/svs2` with the worktrees at the top level
  (`isolation-probe --arms a,b,c --target-batch offline --gates $G`), while no other agent works
  in the worktrees (`wt-a`, `wt-b`, `wt-c`, `wt-ws`, `wt-harness`, `review-ws`).
- The freeze commit: this record's status line, the final commands of §4, and nothing under
  `scripts/ab`, so every paid manifest's `harness_commit` is the freeze commit or a later one with
  the same `scripts/ab` tree as `fcca7c4`, not dirty. If `scripts/ab` changes, rerun the import
  and the offline fingerprints at the new commit.
- The operator links the key into the three template homes (§4 step 5).
