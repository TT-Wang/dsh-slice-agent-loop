# svs2: which part of slice's short-session overhead do the re-read rule, the persona and sealing cause?

> **Status: complete (2026-10-25).** The pre-registration (§1–§15) was frozen on 2026-10-24 after
> the pilot and before any batch cell, and is unchanged. §16 is the batch as run, §17 its result
> before pooling and the arbitration it triggered, §18 the pooled result that decides, §19 the
> caveats, §20 the archive. The ledger holds $6.2448 at peak of the $10 cap. Times are UTC. The
> baseline is the record [slice-vs-stock-2026-10-23.md](slice-vs-stock-2026-10-23.md) ("the
> baseline record" below).

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
- **Pilot (one cell each, cross-batch, indicative only).** On c1 all three arms passed: C cost
  $0.134, B $0.184 and A $0.195 at peak, against the baseline means of STOCK $0.102 and SLICE
  $0.162. A and B re-read and edited about as often as SLICE; C needed fewer steps, but in a new
  process the host still refused 8 edits until it read the file again. On f1, C cost $0.196
  (SLICE $0.262, STOCK $0.429) but **failed the task**: in 20 of the 32 read turns it wrote an
  invented audit token without reading the log, imitating the kept-raw `digest.md` steps of
  earlier turns (§13.4). The declared rules change no arm or task for an outcome, so C runs as
  built and the quality floor will judge it; nothing was cut from the design.
- **Budget.** $10 hard cap at peak prices; the full design is estimated at $5.61 with a 1.2x
  safety factor ($4.67 without), $6.43 with one arbitration reserved.
- **Result (§18; the full design ran: 45 batch cells, all valid, plus 3 arbitration cells).**
  Costs are against the baseline's STOCK cells unless named; "coding" is the geometric mean over
  c1 and c2 (the pre-registered N_code).
  - **A (new re-read rule) does not fix the overhead:** coding 1.25x STOCK (c1 1.66x), f1 0.65x.
    It costs what SLICE costs (coding 0.99x SLICE, f1 1.06x). It cut re-reads right after its own
    edit on c1 by a third (19 against SLICE's 28) but not re-reads at the start of a turn (55
    against 59), and it edited as often (160 against 168).
  - **B (A without the persona) does not fix it either:** coding 1.19x (c1 1.39x), f1 0.56x, the
    cheapest f1 of all. Against A: coding 0.95x, f1 0.86x.
  - **C (B plus keeping the edited files raw) meets the pre-registered bar:** coding 1.02x (c1
    1.10x, c2 0.95x), f1 0.65x, quality floor held. Against B it cut coding cost to 0.86x: on c1
    6.4 requests per turn (STOCK 5.8, SLICE 11.5), half B's start-of-turn re-reads (27, STOCK's
    count) and STOCK's output volume. On f1 it cost more than B (1.18x).
  - **But C invents values on f1.** In 1 of its 6 counted f1 cells it wrote 3 of the 32 audit
    tokens without having seen them, and it failed that cell; the pilot cell (not counted) did the
    same in 20 of 32 turns. A, B and the six baseline cells never did. The quality floor allows one
    lost pass, so C's result stands under the rules: the batch put it at the margin (one lost
    pass), the pre-registered arbitration ran three more C f1 cells, all passed, and the pooled
    result decides. The cause is C's design: a kept step whose reasoning starts with a value the
    model learnt in a step that was sealed (§13.4, §18.5).
  - **Caveats (§19):** every arm-to-baseline ratio is cross-batch (another day, no concurrent
    STOCK or SLICE control); the host machine hibernated for 20 hours in the middle of the batch,
    so its last 13 cells and the arbitration ran a day later than the first 32; n is 3–4 per task.
  - **Spend:** $6.2448 at peak (batch $4.6378, arbitration $0.8937, warmup and pilot $0.7132).

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
   `svs2_plan.py --baseline $AB/vault/baseline --batch $AB/vault/results/batch --pilot
   $AB/vault/results/pilot --ledger $AB/vault/spend.jsonl` says the stage is affordable:

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
- **Kept steps can be imitated (seen in the pilot, §13.4).** A step kept raw while the step before
  it is sealed shows reasoning that seems to need no source; in C's f1 pilot cell the model then
  skipped the source and invented the value in 20 of 32 turns. The quality floor carries this risk
  for C; nothing in the design changes for it.
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

### 12.11 Isolation probe and the planner's pilot option

- **Harness `c7acfa8`** ("the planner takes pilot cells as measurements only"): `svs2_plan.py
  --pilot DIR` reads a pilot batch's cells as measurements that never count as done cells of a
  stage, and projects the full design before the batch at the pilot mean x 1.2 (the prior's safety
  factor) for every arm and task with pilot cells, at the prior elsewhere (§13.1 (c)); without
  `--pilot` nothing changes. `test_svs2.py` 27/27 (one new test), `test_run_ab.py` 29/29,
  `test_ab_metrics.py` 26 (22 pass, 4 skip), `test_ab_report.py` 14/14, `test_svs_report.py`
  10/10, `selfcheck_tasks.py` 49/49, `svs2_checks.py conditions` ok, `check:docs`, `check:size`.
  `scripts/ab` tree `143ff86a`, final from this commit on.
- **Rerun at `c7acfa8`, as §14 required for a `scripts/ab` change:** `import-baseline`: 30 cells, 0
  mismatches, every row equal to the `fcca7c4` import apart from the recording commit; offline
  fingerprints (`offline-fp2`, hello x a, b, c, all valid): `fingerprints --compare
  vault/fingerprints.json` changed nothing, no delta mismatch (the vault file stays the
  `offline-fp` one).
- **Isolation probe** (`isolation-probe --arms a,b,c --target-batch offline --gates $G`,
  2026-10-24 07:25–07:26 UTC, `AB = $SCRATCHPAD/svs2`, while no other agent worked in the
  worktrees; [isolation-probe.json](ab/svs2-2026-10-24/isolation-probe.json)): **ok in every
  arm.** Read mode: 48 targets per arm (the other arms' template homes, the vault and its listing,
  the target batch's manifest, ledger, truth file, a finished cell's home, session log, packed
  workdir and turn stream, and `scripts/` and `docs/` of all six top-level worktrees, `review-ws`
  included, with their listings and the task oracles in them), all denied, no canary leaked; the
  write into each of the 7 read-only harness directories denied; the cell's own files readable;
  `live/` shows only the running cell; the background jobs killed (2 strays per cell), none left,
  the one that dropped `DSH_HOME` and `TMPDIR` too; the `/tmp` plant quarantined. Tamper mode: the
  vault's `chmod` from inside a turn detected as a breach, and the file left in a worktree's
  `src/` (`review-ws`) caught by `git status`; each tamper cell invalid, as it must be. Every
  worktree's `git status` afterwards equals its state before the probe.

## 13. Pilot

### 13.1 Pilot plan (declared before any paid call)

Committed with this record before the key was linked. The pilot uses the real model at the
conditions of §3 and the procedure of §4; its cells are never paired with a baseline cell nor
pooled with the batch or the arbitration: they enter the cost projection (c) and this record only.

1. **Key.** The operator links the key into the three template homes A, B and C (`ln -s
   ~/.dsh/.env $AB/vault/homes/<arm>/.env`; the STOCK home never runs and gets no link).
2. **Warmup** (`warm`): `$R --tasks hello --reps 2 --fingerprints none` with `R` as §4 step 7 (so
   `--arms a,b,c --block-siblings --budget-usd 10 --seed 20261024`), then `run_ab.py fingerprints
   --batch-dir $AB/vault/results/warm --compare $AB/vault/fingerprints.json`. Pass: 6 of 6 cells
   valid; in every arm the rep-2 cell's first request reads at least 4,000 cached tokens (gates
   `warm_min_cache_read`, the row's `usage.first_request_hits[0]`); the compare reports no
   changed field (system prompt sha, tool sha, tool count, prefix characters) and no delta
   mismatch. Otherwise no pilot cell runs and the record says why.
3. **Pilot** (`pilot`, seed 20261024), two invocations, one cell at a time as always:
   - `$R --tasks c1 --reps 1 --batch pilot` (A, B and C; order by the rotation of §4: C, A, B);
   - `python3 $H/run_ab.py --ab-root $AB --gates $G --budget-usd 10 --block-siblings --arms c
     --tasks f1 --reps 1 --batch pilot --seed 20261024 --resume` (C only: the one arm whose
     long-session behaviour can change by construction; f1 rep 1 takes the seed key (batch, 1), so
     its content is that of the baseline's batch r1 cells and of the batch's f1 rep 1).
   An invalid cell is rerun once (`--max-attempts 2`); an HTTP 402 / account error stops the
   pilot (`account_stop`) and the record says so.
4. **Reported per pilot cell:** validity and its reasons; pass and verify info (c1's oracle);
   delivery (f1 T3 and T5); f1's four memory items; cost at peak; requests and steps per turn,
   step-cap cuts; peak and mean request tokens; cache hit rate; wall time; the re-read classes of
   §6.2; for C, the kept-raw entries and the prefix check of §12.9 on its real logs (no node a
   request carried raw beside its turn's entries leaves a later request; consecutive requests
   first differ after the earlier one's last entry).
5. **Stop rules.** (a) A manipulation check of §4 failing in a pilot cell (tools, markers, tape
   forms), or C's prefix check failing on a real log, is a build defect of that arm: no batch runs;
   the record says so, and only a new build, piloted again, could replace the arm. (b) **Tasks are
   never changed**: they must stay byte-identical to tree `b111e434`, as the baseline cells ran
   them. A defect that the pilot shows in every arm by construction is recorded; if it makes the
   cells of every arm invalid, no batch runs and the record says so. Outcomes (pass, cost, recall)
   never change a task, an arm or a threshold.
6. **(c) Re-estimate and ladder.** `svs2_plan.py --baseline $AB/vault/baseline --pilot
   $AB/vault/results/pilot --ledger $AB/vault/spend.jsonl` projects each new cell at its pilot
   mean x 1.2 where the pilot measured that arm and task (A, B, C on c1; C on f1), at the prior of
   §10 elsewhere (A's and B's f1 at SLICE's f1 x 1.2, c2 and r2 at max(SLICE, STOCK) x 1.2, hello
   from the warmup). The pre-declared reductions of §10 then apply unchanged: the full design plus
   the arbitration reserve at this projection must be at most $7.00, else stages are cut from the
   end (S5, then S4, S3, S2; S1 never), and before each stage the ledger (warmup and pilot
   included) plus the stage's unrun cells plus the reserve must stay at most $8.65, else that
   stage and every later one are skipped. The reps per task per arm that remain are frozen in §14
   with the rest.
7. **Wall time** is reported per cell and projected for the batch (one stage per background
   invocation, polled through `AB/progress.txt`; no tool call longer than ten minutes).

### 13.2 Warmup

The key was linked at 07:28:57 UTC into the template homes of A, B and C (`ln -s ~/.dsh/.env`,
never read; the STOCK home has none). Batch `warm`, 07:29–07:30 UTC, harness `ca1f5d6` (the
pilot-plan commit; `scripts/ab` tree `143ff86a`), `--block-siblings` (35 scratchpad entries and
5 A/B-root extras blocked while a turn ran), host tree digest unchanged
([pilot.json](ab/svs2-2026-10-24/pilot.json)):

- 6 of 6 cells valid, every system-prompt marker as declared.
- The rep-2 cell's first request read **4,480 cached tokens in every arm** (minimum 4,000). In rep
  1, A and B read none (the first use of their prefixes) and C read 4,480: B and C have the same
  system prompt and tools, so C's first request reused B's.
- `fingerprints --compare $AB/vault/fingerprints.json`: changed nothing, no delta mismatch.
- $0.0052.

### 13.3 Pilot cells

Batch `pilot`, seed 20261024, 07:30–08:13 UTC (peak hours), the two invocations of §13.1 step 3.
Every cell was valid on its first attempt: 16 tools with the exact names, markers as declared,
short tape headers, no secret reference, leak, oracle read through the file system, worktree
change or stray process; host tree digest unchanged. The flagged calls (A 20, B 11, C 7 on c1,
none on f1) are the false positives the baseline's c1 cells also have (SLICE 16–23, STOCK 0–3):
Python's `//` operator read as a path and scratch files in `/tmp`.

| cell | outcome | cost at peak | requests (per turn) | step-cap cuts | peak / mean request tokens | cache hit | output tokens | wall |
|---|---|---|---|---|---|---|---|---|
| c1 C (ran first) | pass | $0.1338 | 58 (7.25) | 0 | 67,759 / 32,622 | 96.0 % | 57,163 | 404 s |
| c1 A | pass | $0.1945 | 94 (11.75) | 2 | 50,895 / 23,864 | 96.3 % | 97,026 | 838 s |
| c1 B | pass | $0.1841 | 86 (10.75) | 3 | 42,788 / 22,364 | 96.1 % | 94,928 | 655 s |
| f1 C | **fail**: 20 of 32 digest tokens wrong; memory 4 of 4 correct; delivery T3, T5 | $0.1956 | 209 (4.64) | 0 | 56,327 / 29,113 | 97.4 % | 33,566 | 603 s |

The baseline beside it (imported cells; c1 4 per arm, f1 3): c1 SLICE $0.1624 (rep 1 $0.1766,
range $0.1447–0.1766), 11.47 requests per turn, 14 step-cap cuts in 32 turns, median wall 824 s;
STOCK $0.1023 (rep 1 $0.0834), 5.78 requests per turn, no cut, 341 s. f1 SLICE $0.2619, STOCK
$0.4287; all six passed with every digest token right. Output tokens (reasoning included) are 56–73
% of every c1 cell's cost in every arm, baseline included: A and B wrote as much as SLICE (SLICE
72K–91K per cell, STOCK 46K–55K), C 57K.

Re-read classes on c1 (§6.2; one cell per new arm, the baseline per cell):

| c1 | first | cross-turn | same-turn | after own edit | edits/writes | bash writes | FS_NOT_OBSERVED |
|---|---|---|---|---|---|---|---|
| A | 2 | 14 | 0 | 2 | 44 | 28 | 0 |
| B | 2 | 13 | 1 | 7 | 52 | 18 | 3 |
| C | 2 | 6 | 0 | 3 | 43 | 15 | 8 |
| SLICE, per cell (4 cells) | 2 | 14.75 | 0 | 7 | 42 | 22.5 | 0.25 |
| STOCK, per cell (4 cells) | 1.5 | 6.75 | 2.5 | 2.25 | 21 | 5.75 | 0.25 |

Indicative only (one cell against a baseline mean, different day): c1 cost against STOCK's mean
A 1.90, B 1.80, C 1.31; against SLICE's mean A 1.20, B 1.13, C 0.82. f1 C against STOCK's rep 1
0.41, against SLICE's rep 1 0.74, on a task it did not do (§13.4). None of these figures enters a
comparison of §7: pilot cells are never paired or pooled.

### 13.4 C's retention, observed

- **c1:** 7 kept-raw entries (`calc.py` in every sealed turn), cross-turn re-reads 6 against A's 14
  and B's 13, no step-cap cut. Each turn runs in a new process, so the host's edit guard is empty:
  8 times the model edited `calc.py` from the kept view without reading it, was refused
  (`FS_NOT_OBSERVED`), read it and edited again.
- **Cache safety on the real host:** the prefix check of §12.9 found no problem in any pilot cell:
  C's c1 cell carried 57 nodes raw beside entries over 58 requests and its f1 cell 142 over 209,
  and none left a later request; A and B carried none.
- **f1 failed by confabulation.** Every read turn asks the model to read one log excerpt in full
  and append its audit token to `digest.md`. In C the working set holds `digest.md`, changed in
  every turn, so each sealed read turn keeps raw the step that reads and edits `digest.md`. That
  step's reasoning begins with the token ("Token: … Append to digest.md. Read digest.md first."),
  learnt in the step before it, the excerpt read and its `expand_result`, which was sealed into
  the turn's entry. From T11 on, C began 20 of the 32 read turns (T11, T17, T18, T21, T22, T24 and
  every read turn from T26 to T39) with that pattern without reading the excerpt: its first
  step's reasoning names a token, a line number and decoys that it never saw, then it reads and
  edits `digest.md`. Every line it wrote in those turns carries a wrong token; the 12 excerpts it
  did read it read in full (read and `expand_result`) and recorded correctly. The quizzes were
  unaffected: 4 of 4 memory items correct (the lint message recall-sourced through `recall_step`).
  No baseline f1 cell, SLICE or STOCK, missed a token. Part of C's low f1 cost is the 20 excerpt
  reads that did not happen.
- This is a property of C's design (a kept step whose reasoning depends on a sealed step before
  it), shown by one cell. It is not a defect of the task: the baseline's six f1 cells did not show
  it, and A and B seal every step of a turn, so they cannot keep such a step.

### 13.5 Decisions under §13.1

- **Stop rule (a): not met.** Every manipulation check held in every pilot cell, and C's prefix
  check held on both of its real logs.
- **(b): nothing changed.** No defect present in every arm by construction appeared. C's f1
  failure is an outcome of one arm, which by the declared rule changes no task, arm or threshold:
  C runs as built. The quality floor of §7 decides what the failure costs C (two or three failed
  f1 cells of C give dS_f1 ≤ −2, and Q fails).
- **(c) Re-estimate** ([plan-after-pilot.md](ab/svs2-2026-10-24/plan-after-pilot.md)): projection
  per cell A c1 $0.2334, B c1 $0.2209, C c1 $0.1606, C f1 $0.2347 (pilot x 1.2), the priors
  elsewhere; full design $5.4918 + arbitration reserve $0.9753 (the worst arm, A, on c1 and c2 at 4
  rep indices) = **$6.4671 ≤ $7.00: nothing is cut.** With C's f1 at its prior ($0.3143,
  if C reads every excerpt in the batch) it would be $6.7059, still within. Before S1: ledger
  $0.7132 + every stage at measured means and priors ($4.9647) + the reserve at measured means
  ($0.8197) = $6.50 ≤ $8.65: every stage affordable.
- **Reps per task per arm: c1 4, c2 4, r2 4, f1 3** (51 cells), the full design.
- **Wall time:** c1 cells 6.7–14.0 min (mean 10.5), f1 10.0 min, so the batch takes about 4 hours:
  S1 about 2.2 h (6 c1 cells, 6 f1, 12 short), S2 about 35 min, S3 about 30 min, S4 about 35 min,
  S5 about 10 min.
- **Spend so far: $0.7132 at peak** (warm $0.0052, pilot $0.7080; no unpriced charge). Expected
  end: about $5.7 without an arbitration and $6.5 with the reserved one, under the $10 cap.

## 14. Frozen parameters

Recorded in the freeze commit, the commit on `exp/svs2-harness` that adds this section (parent
`ca1f5d6`), after the pilot and before any batch cell.

| parameter | value |
|---|---|
| harness | `exp/svs2-harness`, the freeze commit or a later docs-only commit; `scripts/ab` tree `143ff86a0fd6ccfa894c7e9211c1694c3c5379ba` (code as `c7acfa8`), not dirty; `scripts/ab/tasks` tree `a03fb857…`; the five task directories (hello, c1, c2, r2, f1) have the same git tree ids as in `b111e434` |
| harness files (sha256) | `gates-svs2.json` `9cd5dc0301bf…`, `run_ab.py` `b4f79a8607b7…`, `ab_metrics.py` `5e256e3e73ab…`, `svs2_report.py` `1a5fed102b24…`, `svs2_plan.py` `051af5e40693…`, `svs2_checks.py` `48a982f91f70…` |
| arms | A `exp/svs2-a` `421d695`, B `exp/svs2-b` `f27f3f2`, C `exp/svs2-c` `caf82d9`; tarballs as §2.2, `vault/artifacts/SHA256SUMS` sha256 `a73d168c81fb…`: A `dd23e957be30076ffbc4a7d8e759048803de340d29d42600db80a895c82b720d`, B `896ee6988f1bd3b5013c523e31cdc47c9ecb4a867e3ed7cff9a5252850d8bb97`, C `22b10cbcdf39359540df1e3cc2ca0775771216a0c42c4c4ad908bad277c30fa5`; homes from `prepare` (`vault/arms.json` sha256 `78e80da59909…`) |
| host | `@deepseek-ai/dsh@0.2.1-rc.2` at `AB/host`, tree digest `0c9e7f6b25ec619cbfe60fc8a0df27f753f589fba9146a49b8718604776a824a`, content digest `5c0747d0bd13e87852388ec6313dc2544d1403191c81192e36d2c95c24d998be`, both the baseline's; unchanged through warm and pilot |
| model | `deepseek-official/deepseek-flash` (the host's default route), reasoning effort at the adapter default |
| price sheet | `prices.json` sha256 `d6311a3038b8…` (byte-identical to `b111e434`): off-peak miss $0.22, hit $0.007, output $0.66 per million tokens, peak twice that; the budget prices at peak |
| composition | neutral overlay `profile/eval-neutral.patch.yml` sha256 `74b7a95e…`; step caps c1 14, c2 26, r2 12, f1 12 by the harness row `step-cap.mjs` (sha256 `a8acb6377…`) |
| fingerprints | `vault/fingerprints.json` sha256 `b9c1c78b10fb…` (batch `offline-fp`, reproduced by `offline-fp2` at `c7acfa8` and by the warmup) |
| baseline | 30 imported cells, `vault/baseline/import.json` sha256 `0e20ff73135a…`, 0 mismatches; pairing as §2.3 |
| seeds | batch `batch` 20261024, arbitration `arb` 20261025; f1 content from the baseline's salt (sha256 `c5e46161…`) with the seed keys of gates `pairing.seed_keys` |
| reps per task per arm | c1 4, c2 4, r2 4, f1 3 (51 cells in stages S1–S5, §4 step 7); after the pilot nothing is cut (§13.5) |
| comparisons | §7: N_code (geometric mean of R_c1 and R_c2, arm / STOCK) and R_f1 primary; N_code3, the same against SLICE, the steps B/A, C/B, C/A, A/SLICE, re-read classes and the rest secondary; the quality floor Q |
| interpretation | §8, top to bottom per arm; "fixes the short-session overhead" iff N_code ≤ 1.10 and R_f1 ≤ 0.80 with Q held; steps "move the cost" at ≤ 0.95 or ≥ 1.05 |
| minimum valid pairs | §8.1: 10 pairs per arm, at least 2 per task, 8 memory items |
| arbitration | §9: at most once, batch `arb`, seed 20261025, only if triggered and affordable ($8.65 condition) |
| budget | $10 cap at peak over one ledger `vault/spend.jsonl`, reserve $0.75, margin $0.60, stop line $8.65, planning target $7.00 |
| pilot | batch `pilot` (4 cells) and `warm` (6): measurements only, never paired or pooled |

## 15. What the batch must do

- Run the five stages of §4 step 7 as five background invocations (`R` with `--block-siblings`,
  `--budget-usd 10`, seed 20261024), each only after `svs2_plan.py --baseline $AB/vault/baseline
  --batch $AB/vault/results/batch --pilot $AB/vault/results/pilot --ledger $AB/vault/spend.jsonl`
  says the stage is affordable; poll `AB/progress.txt`; no tool call over ten minutes.
- While a batch runs no other agent works in the worktrees (`wt-a`, `wt-b`, `wt-c`, `wt-ws`,
  `wt-harness`, `review-ws`) or in `AB/probe`; the STOCK home keeps no key link.
- An HTTP 402 / account error stops the run (`account_stop`); report it and stop.
- Then `svs2_report.py report`, the arbitration only as §9, `secrets-scan`, the archive to
  `~/Documents/kimi/workspace/dsh-slice/results/20261024-svs2/` (held-back cells in a `chmod 700`
  `held-back/`), and the results into this record.
- If `scripts/ab` changes, rerun the import and the offline fingerprints at the new commit (with
  the key links removed first: `--offline` refuses a home with one), and say so here.

## 16. The batch, as run

Batch `batch`, seed 20261024, harness `a7e9698` (the freeze commit; `scripts/ab` tree `143ff86a`,
not dirty), the five stages of §4 step 7 in order, one invocation each, one cell at a time,
`--block-siblings`, `--budget-usd 10`, `--max-attempts 2` (the default). Before each stage
`svs2_plan.py` said it was affordable: S1 and S2 by the printed plan, S3, S4, S5 and the
arbitration by its `--json` output ([plan-before-stages.json](ab/svs2-2026-10-24/plan-before-stages.json)).
Every manifest records harness `a7e9698`, the host tree digest `0c9e7f6b25ec…` at start and end
(unchanged), the vault salt as the baseline's and the fingerprint check against
`vault/fingerprints.json`. S1 and the arbitration also recorded the content digest `5c0747d0…`.

| stage | window (UTC) | cells | ledger after |
|---|---|---|---|
| S1: c1, c2, r2, f1 reps 1–2 | 10-24 08:25–10:12 | 24 | $3.2229 |
| S2: c1, c2 rep 3 | 10-24 10:12–10:54 | 6 | $3.7290 |
| S3: f1 rep 3 | 10-24 10:54–11:16; the host asleep until 10-25 07:01; then to 07:12 | 3 | $4.8060 |
| S4: c1, c2 rep 4 | 10-25 07:12–07:47 | 6 | $5.2453 |
| S5: r2 reps 3–4 | 10-25 07:47–07:55 | 6 | $5.3510 |

- **45 of 45 cells valid**: 44 on their first attempt, one on its pre-declared second attempt
  (below). Every manipulation check held in every cell: 16 tools with the exact names, the
  declared system-prompt markers, short tape headers. No cell had a secret reference, a leak, an
  oracle read through the file system, a worktree change or a stray process.
- **One failed cell**: C, f1 rep 1 (3 of 32 digest tokens wrong, §18.5). Every other cell passed.
- **Arm order**, rotated per (task, rep) as §4: for example c1 rep 1 ran C, A, B; c2 rep 1 A, B,
  C; r2 rep 1 B, C, A; f1 rep 1 C, A, B. The per-cell table in run order is
  [batch-cells.json](ab/svs2-2026-10-24/batch-cells.json).
- **Flagged calls and quarantine.** In c1 the flagged calls (A 12–17 per cell, B 2–14, C 0–12)
  are the false positives the baseline's c1 cells also have: Python's `//` operator read as a
  path. A (4 cells) and B (1) wrote scratch scripts to `/private/tmp`, which the harness moved to
  quarantine, as in the baseline. Three cells are flagged and so leave the memory comparison
  under the rule (gates `g2`): B r2 reps 2 and 4 (`cd ..; ls; find ..`, looking for `stamp.py`
  and `service.env` above the workdir but inside the cell root) and C's arbitration f1 rep 3 (a
  `read` of the workdir's own `digest.md` under a mistyped absolute path). Their pass and cost
  still count.

### 16.1 The infra rerun: the host machine hibernated mid-cell

The third f1 rep-3 cell (A) started at 10-24 11:09:27. At 11:16:30 the laptop running the
harness went to sleep at 1 % battery (`pmset` log: "Entering Sleep state due to 'Low Power
Sleep' … Using Batt (Charge:1%)") and hibernated until 10-25 07:01:28 ("Wake from Hibernate …
Using AC"). Turn 40 of the cell was in flight. On waking, the harness's wall-clock turn timeout
(900 s for f1) fired, killed the turn and ended the attempt: invalid, infra, "completed 40/45
turns", "turn 40: exit 0 (None, None, timeout)". Its cost, $0.2881 at peak, includes the $0.05
unpriced-step charge for the killed turn, whose usage never reached the log. The harness then ran
the pre-declared second attempt at once (07:01:40–07:12:09), which was valid and passed. This is
the one infra retry the rules allow (§4 step 7). Nothing was done by hand, and no outcome was
looked at before it.

During the 20 hours the vault and the blocked siblings stayed at mode 000. The tamper checks
after the turn found every blocked path unchanged, and the host digest was unchanged at S3's end.

### 16.2 An isolation deviation, checked

At 07:12:40 UTC on 10-25, 26 s after S4's invocation had listed the scratchpad entries to block,
the operator made a scratch directory in the scratchpad (`svs2view`) holding copies of five
harness files (`svs2_report.py`, `svs2_plan.py`, `ab_metrics.py`, `README.md`,
`gates-svs2.json`), to read the report code while the vault and the worktrees were blocked. It
held no task file, oracle, truth file or result until S4 had ended. Because S4 listed the
siblings before it existed, it stayed readable during S4's six cells (c1 and c2 rep 4). S5 and
the arbitration blocked it (their manifests list it; a copy of `run_ab.py` made at 07:03 was
blocked from S4 on). Check: no decompressed session log of the six S4 cells mentions
`svs2view`, `run_ab_view`, `gates-svs2` or any worktree path, and their flagged calls are only
the `//` false positives (c1 r4 B: 2, C: 1, A: 17; c2: none). The deviation therefore reached no
cell, and the cells stay valid. Scratch of this kind belongs outside the scratchpad while a batch
runs.

## 17. The batch alone, and the arbitration it triggered

`svs2_report.py report $AB/vault/results/batch --baseline $AB/vault/baseline --gates $G --ledger
$AB/vault/spend.jsonl` ([summary-batch.md](ab/svs2-2026-10-24/summary-batch.md), json beside it;
sha256 of the summary.json `ca4b4b93…`, kept unchanged in `vault/results/batch/`):

| arm | interpretation on the batch | N_code | R_f1 | dS | dM | dB | arbitration (§9) |
|---|---|---|---|---|---|---|---|
| A | does not fix the short-session overhead | 1.253 | 0.649 | 0 | 0 | 0 | not required |
| B | does not fix the short-session overhead | 1.193 | 0.555 | 0 | 0 | 0 | not required |
| C | fixes the short-session overhead | 1.023 | 0.613 | −1 (f1 −1) | 0 | 0 | **required**: quality floor at its margin |

A and B: no quantity is within 0.05 of a threshold that would change the interpretation, the
quality floor is not at its margin and every minimum is met. C: its one failed f1 cell puts
dS = −1 and dS_f1 = −1, both the floor's margin, so §9 triggers. The tasks to add are those whose
dS_t decides: f1.

**Arbitration** (batch `arb`, seed 20261025, C only, f1 at rep indices 1–3 with the same seed
keys, so each cell's content again equals its baseline partner's and C's batch cell's). Budget
condition: ledger $5.3510 + the estimate at measured means $0.7376 = $6.0886 ≤ $8.65. Run 10-25
07:58–08:25. All three cells were valid on their first attempt and passed with 32 of 32 tokens
and 4 of 4 memory items ($0.2497, $0.3190 and $0.3250 at peak, $0.8937 in all, above the
estimate). Arbitration alone (descriptive, below the minimums):
[summary-arb-only.md](ab/svs2-2026-10-24/summary-arb-only.md).

## 18. Result (pooled batch + arbitration; this decides)

`svs2_report.py report $AB/vault/results/batch $AB/vault/results/arb --pooled …`
([summary-pooled.md](ab/svs2-2026-10-24/summary-pooled.md), json beside it). A and B have no
arbitration cells, so their pooled numbers are their batch numbers; C's f1 sides average two
cells. 15 pairs per arm, every task at its planned count (c1 4, c2 4, r2 4, f1 3).

### 18.1 Interpretation (§8, against STOCK)

| arm | interpretation | N_code (R_c1, R_c2) | R_f1 | N_code3 (R_r2) | dS | dM (items) | dB | quality floor |
|---|---|---|---|---|---|---|---|---|
| **A** | **does not fix the short-session overhead** | 1.253 (1.662, 0.945) | 0.649 | 1.049 (0.735) | 0 | 0 (16) | 0 | holds |
| **B** | **does not fix the short-session overhead** | 1.193 (1.385, 1.027) | 0.555 | 1.098 (0.931) | 0 | 0 (14) | 0 | holds |
| **C** | **fixes the short-session overhead** | 1.023 (1.099, 0.953) | 0.654 | 0.953 (0.826) | −0.5 (f1 −0.5) | 0 (16) | 0 | holds |

For reference, the baseline's own SLICE under the same rules: N_code 1.261 (1.587, 1.001), R_f1
0.611, "does not fix the short-session overhead".

Paired ratios against STOCK (rep 1–4; f1 rep 1–3):

| arm | c1 | c2 | r2 | f1 |
|---|---|---|---|---|
| A | 1.99, 1.69, 1.47, 1.57 | 1.07, 1.04, 0.70, 1.03 | 0.92, 0.67, 0.63, 0.84 | 0.56, 0.86, 0.59 |
| B | 1.88, 0.91, 1.52, 1.37 | 1.33, 1.00, 0.79, 1.04 | 1.27, 0.75, 0.63, 1.44 | 0.52, 0.66, 0.51 |
| C | 1.06, 0.81, 1.49, 1.05 | 1.20, 0.91, 0.85, 0.87 | 1.38, 0.67, 0.48, 1.17 | 0.53, 0.85, 0.63 |

### 18.2 Against SLICE, and which change moves the cost

| comparison | kind | R_c1 | R_c2 | N_code | R_r2 | R_f1 | label (N_code; R_f1) |
|---|---|---|---|---|---|---|---|
| A / SLICE (the re-read rule) | cross-batch | 1.047 | 0.944 | 0.994 | 0.808 | 1.062 | no measurable effect; up |
| B / A (the persona) | within the batch | 0.833 | 1.087 | 0.952 | 1.267 | 0.856 | no measurable effect (0.952 > 0.95); down |
| C / B (working-set retention) | within the batch | 0.794 | 0.928 | 0.858 | 0.888 | 1.177 | down; up |
| C / A | within the batch | 0.661 | 1.008 | 0.817 | 1.124 | 1.007 | down; no measurable effect |
| B / SLICE | cross-batch | 0.873 | 1.026 | 0.946 | 1.024 | 0.909 | (secondary) |
| C / SLICE | cross-batch | 0.693 | 0.952 | 0.812 | 0.909 | 1.070 | (secondary) |

Before pooling C/B's R_f1 was 1.103 and C/A's 0.944 (C's arbitration cells cost more than its
batch cells: $0.298 against $0.263 on average).

### 18.3 Re-read classes (§6.2; sums over valid cells)

c1, 4 cells x 8 turns per arm:

| c1 | first | cross-turn | same-turn | after own edit | edits/writes | bash writes | FS_NOT_OBSERVED | FS_STALE_VERSION |
|---|---|---|---|---|---|---|---|---|
| A | 8 | 55 | 0 | 19 | 160 | 100 | 0 | 0 |
| B | 8 | 54 | 0 | 14 | 128 | 71 | 0 | 0 |
| C | 8 | 27 | 1 | 8 | 156 | 45 | 22 | 0 |
| SLICE (baseline) | 8 | 59 | 0 | 28 | 168 | 90 | 1 | 0 |
| STOCK (baseline) | 6 | 27 | 10 | 9 | 84 | 23 | 1 | 0 |

f1, 3 cells x 45 turns (C: 6 cells, batch and arbitration):

| f1 | first | cross-turn | same-turn | after own edit | edits/writes | bash writes | FS_NOT_OBSERVED |
|---|---|---|---|---|---|---|---|
| A | 110 | 101 | 84 | 5 | 93 | 57 | 0 |
| B | 107 | 98 | 21 | 26 | 88 | 60 | 7 |
| C (6 cells) | 216 | 200 | 0 | 130 | 293 | 16 | 22 |
| SLICE | 109 | 105 | 118 | 39 | 98 | 61 | 2 |
| STOCK | 108 | 107 | 0 | 90 | 139 | 3 | 4 |

c2 (one turn) has no cross-turn reads; its after-own-edit re-reads are A 0, B 0, C 1, SLICE 12,
STOCK 5. r2: cross-turn A 6, B 8, C 4, SLICE 8, STOCK 4. Full table in the pooled summary.

Secondary hypotheses of §7 (reported, not tests):

- A has fewer after-own-edit re-reads on c1 than SLICE: **yes**, 19 against 28. A's cross-turn
  re-reads (55 against 59) and edits (160 against 168) barely moved.
- C has fewer cross-turn re-reads on c1 than B: **yes**, 27 against 54, STOCK's count. C still
  hit `FS_NOT_OBSERVED` 22 times on c1: it edited from the kept view in a new process, which the
  host refuses until the file is read (§11).
- B's c1 requests per turn are closer to STOCK's than A's: **yes**, 9.19 against 11.09 (STOCK
  5.78), but far from STOCK's.

### 18.4 Cost structure (valid cells; means per cell; request tokens as cell medians)

| arm | task | cells | pass | mean $ peak | requests / turn | step-cap cuts | output tokens per cell | peak / mean request tokens | cache hit | kept-raw entries | median wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | c1 | 4 | 4 | 0.1701 | 11.09 | 10 of 32 | 88,156 | 44,383 / 21,028 | 0.966 | 0 | 698 |
| B | c1 | 4 | 4 | 0.1417 | 9.19 | 4 of 32 | 75,445 | 36,206 / 18,625 | 0.961 | 0 | 699 |
| C | c1 | 4 | 4 | 0.1124 | 6.38 | 1 of 32 | 52,204 | 62,821 / 29,575 | 0.967 | 28 | 306 |
| SLICE | c1 | 4 | 4 | 0.1624 | 11.47 | 14 of 32 | 81,598 | 38,643 / 20,474 | 0.966 | 0 | 824 |
| STOCK | c1 | 4 | 4 | 0.1023 | 5.78 | 0 of 32 | 52,366 | 74,338 / 34,361 | 0.983 | 0 | 341 |
| A | f1 | 3 | 3 | 0.2782 | 5.40 | 0 of 135 | 46,069 | 48,809 / 27,049 | 0.955 | 0 | 546 |
| B | f1 | 3 | 3 | 0.2380 | 5.01 | 0 of 135 | 37,052 | 36,706 / 22,425 | 0.946 | 0 | 459 |
| C | f1 | 6 | 5 | 0.2803 | 5.26 | 0 of 270 | 36,068 | 58,630 / 31,749 | 0.962 | 255 | 477 |
| SLICE | f1 | 3 | 3 | 0.2619 | 5.80 | 0 of 135 | 40,898 | 43,301 / 24,774 | 0.958 | 0 | 542 |
| STOCK | f1 | 3 | 3 | 0.4287 | 4.21 | 0 of 135 | 20,276 | 234,025 / 116,231 | 0.991 | 0 | 426 |
| A / B / C | c2 | 4 each | 4 each | 0.0082 / 0.0089 / 0.0083 | 6.50 / 8.00 / 6.75 | 0 | 3,648 / 3,983 / 3,728 | 13,604 / 13,147 / 12,847 peak | 0.90–0.93 | 0 | 23–26 |
| SLICE / STOCK | c2 | 4 each | 4 each | 0.0087 / 0.0087 | 7.00 / 7.50 | 0 | 3,560 / 4,023 | 14,637 / 11,610 peak | 0.90 / 0.91 | 0 | 24 / 30 |
| A / B / C | r2 | 4 each | 4 each | 0.0158 / 0.0200 / 0.0178 | 3.50 / 3.75 / 3.46 | 0 | 5,363 / 8,033 / 5,992 | 13,940 / 15,787 / 16,145 peak | 0.95 | 0 / 0 / 12 | 66 / 80 / 70 |
| SLICE / STOCK | r2 | 4 each | 4 each | 0.0196 / 0.0215 | 3.86 / 3.46 | 0 | 7,181 / 9,600 | 15,238 / 20,464 peak | 0.95 / 0.96 | 0 | 82 / 94 |

Memory items (f1 4 per cell, r2 1): every valid cell of every arm got every item right; no item
was wrong, a decoy, stale, hedged or confabulated. Output tokens (reasoning included) are where
the c1 cost differs: A and B wrote as much as SLICE, C as little as STOCK.

**C's cache safety on the real host** (the prefix check of §12.9, `probe/tools/ws_prefix.py`,
[ws-prefix-batch.json](ab/svs2-2026-10-24/ws-prefix-batch.json)): in C's 15 batch cells 728 nodes
were carried raw beside their turn's entries over 1,014 requests, and in its 3 arbitration cells
369 over 735. None left a later request, and no request's surface differed from the one before
it before the earlier request's last entry. A and B carried none and had no problem either.

### 18.5 C's f1 failure: values written without being seen

[f1-digest-trace.json](ab/svs2-2026-10-24/f1-digest-trace.json) (`probe/tools/f1_digest_trace.py`,
counts only):

- **C batch rep 1 (failed):** it read all 32 excerpts, but in turns 33, 35 and 37 the `read`
  came back condensed (head plus an `expand_result` offer) and it did not expand. Its next
  reasoning step names a token at once ("Token for blob_26: … Append."), the pattern of the
  kept-raw `digest.md` steps (§13.4). It appended that token, and its final text then said the
  whole excerpt had passed before its eyes "via `expand_result`", which it had not called. All
  three tokens are wrong. In turn 32 the same pattern occurred, but the model caught itself: it
  called `expand_result` with a grep, found the real token and corrected its line.
- **C's other 5 f1 cells** (batch reps 2 and 3, arbitration reps 1–3): 32 of 32 tokens right.
- **A and B (6 cells), SLICE and STOCK (6 baseline cells):** 32 of 32 in every cell. A's rep-3
  cell also skipped `expand_result` in 24 read turns and still recorded every token correctly,
  so skipping the expansion does not by itself cause the failure; writing a token that was never
  seen does.
- **Pilot (not counted, §13):** C wrote invented tokens in 20 of 32 turns, without reading the
  excerpt at all.

So C invented values in 2 of its 7 f1 runs (1 of the 6 counted), and no other arm or baseline
cell did in 15. Under the pre-registered floor (a margin of one pass) this costs C −0.5 pass
after pooling, and its interpretation stands. The floor was built to tolerate noise, not a
mechanism. The mechanism is C's: a kept step whose reasoning begins with a value that the model
learnt in an earlier step, now sealed, makes the model write values it has not seen.

## 19. Caveats

- **Cross-batch.** Every ratio against STOCK or SLICE compares cells of different days: the
  baseline ran on 2026-10-23 10:43–13:42 UTC, the new arms on 2026-10-24 08:25–11:16 and
  2026-10-25 07:01–08:25, with no concurrent STOCK or SLICE control. Provider-side variance
  (latency, cache retention, routing, serving changes) cannot be told apart from an arm effect.
  Pairing by rep index is bookkeeping for c1, c2 and r2 (identical content in every rep); only
  f1's pairs share seeded content. B/A, C/B and C/A are within one batch and are the cleanest
  comparisons. A/SLICE (0.99 on coding) is the one that says whether the new re-read rule alone
  changed anything, and it is cross-batch.
- **The batch spans two days.** The host machine hibernated from 10-24 11:16 to 10-25 07:01
  (§16.1). Reps 1–3 of c1 and c2, reps 1–2 of r2 and f1, and f1 rep 3 of B and C ran on 10-24;
  f1 rep 3 of A, reps 4 of c1 and c2, reps 3–4 of r2 and the arbitration ran on 10-25. Every
  (task, rep) group but one ran its three arms within one hour on one day. The exception is f1
  rep 3, whose A cell ran 20 hours after its B and C cells.
- **Low power.** n = 3–4 per task; paired c1 ratios against STOCK range 0.81–1.99. C's N_code
  (1.023) is 0.077 below the 1.10 bar, and its R_c1 alone (1.099) sits at the bar. An effect of
  B/A's size (0.95) is below what this design can tell from noise.
- **C's headless refusals.** In this harness every turn is a new process, so the host's edit
  guard demands a fresh read of a kept file before every edit (22 refusals on c1, 22 on f1). A
  long-running agent keeps the guard's state and would skip those reads; how much that would
  save is not measured here.
- **C's quality risk (§18.5)** is real at this n and is not what the floor's margin is for.
  Before C could be used, a design change would be needed, and then a new run. Candidates: keep
  only result nodes raw, not the reasoning of a kept step, or never keep a step whose reasoning
  depends on a sealed step.
- **External validity** as in the baseline record §16: one host, one model route, headless one
  process per turn, a hermetic composition, DeepSeek's cache pricing.

## 20. Archive and files

- **Raw data:** `~/Documents/kimi/workspace/dsh-slice/results/20261024-svs2/`, a copy of the A/B
  root `$SCRATCHPAD/svs2` taken after the arbitration, without `host/` (the frozen host, digest in
  every manifest), the worktrees (their commits are on the `exp/svs2-*` branches), `dry/` (the
  offline dry-run root of §12.6, mostly a host copy), the empty `live/`, every `storages/`
  directory (session projection caches) and the probe's extracted f1 workdirs (copies of packed
  workdirs). `run_ab.py secrets-scan` lists 3 cells, all of the offline isolation probe
  (`isoprobe`, mock provider, no key linked), whose probe script names `DSH_HOME` by design. Their
  session logs and turn files are in `held-back/` (chmod 700); see `HELD-BACK.md` there. No paid
  cell is listed. The template homes' key links were removed after the arbitration (10-25 08:27),
  before the copy.
- **Summaries in this repo:** [docs/ab/svs2-2026-10-24/](ab/svs2-2026-10-24/):
  `summary-batch.{md,json}` (§17), `summary-pooled.{md,json}` (§18, decides),
  `summary-arb-only.md`, `batch-cells.json` (every cell in run order), `plan-before-stages.json`,
  `ws-prefix-batch.json`, `f1-digest-trace.json`. A scan of every file in that directory and of
  this record against the f1 truth values of all twelve f1 cells (140 values: tokens, build ids,
  decoys, lint errors) found none.
- **Spend at peak** (one ledger, `vault/spend.jsonl`, 847 turns): warmup $0.0052, pilot $0.7080,
  batch $4.6378 (of which the infra attempt of §16.1 $0.2881), arbitration $0.8937; **total
  $6.2448** of the $10 cap. One unpriced turn, charged $0.05: the killed turn of §16.1. The
  expectation was ≤ $6; the planning target with the arbitration was $7.00.
