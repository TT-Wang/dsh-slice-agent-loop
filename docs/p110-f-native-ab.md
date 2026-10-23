# P1-10 F-only native A/B: version-only tape tool locators

> **Status: FROZEN pre-registration, 2026-10-22.** Built and dry-run offline, then the paid warmup
> and a control-only pilot ran (§13). The commit that fills §13 freezes the harness, arms, tasks,
> metrics, gates and decision rule; nothing in §1–§13 changes after it. No F cell of a gated task
> has run. §14 "Results" stays empty until the batch and the report exist.
>
> **Results and final record added 2026-10-22 (§14).** The batch triggered the single
> arbitration, and the pooled 6 reps decide: **do not ship F.** G3 fails (59 vs 41, limit
> 55.25), and G4's request check passes with only 0.5 units of room. Spend was $2.8202 at peak
> prices of the $10 cap. §1–§13 are unchanged.

## 1. Question

The 2026-09-27 A/B ([docs/p110-native-ab.md](p110-native-ab.md)) tested F only on top of A + C
(arm 2 = arm 1 + F). By the frozen rule arm 2 passed, but the owner did not ship F (§14.12 there),
because its evidence had no room:

- its median paired request delta sat exactly at the limit (+1);
- its G3 pass counted a write or edit that DSH rejected as a mutation; counting only successful
  mutations, arm 2 failed G3 (77 vs 54, limit 71.5);
- it re-read more than arm 1 under both readings (87 vs 73, 77 vs 58) and took more extra hops (4 vs 2).

A + C has since shipped (main `70e6e55`, plugin 0.2.0). This experiment asks the F question
alone, against the text that is now in production, with the instrument faults of the first run
fixed and with a decision rule that needs room.

**F** changes the tape tool line, the per-tool-result pointer in every sealed tape entry: the
line ends ` · v4` instead of repeating `expand_result({"seq":N,"formatVersion":4})`. `seq N`
stays in the line, and `expand_result`'s `formatVersion` parameter says to "use 4 from a fresh
locator". F saves about 41 characters per tool line (two-digit seq), at most 6 lines per sealed
turn, in every later request of the session. It changes only tape entries written after deploy:
the cached prefix (system prompt and tool definitions) is byte-identical, so unlike A + C it
costs no cache miss at deploy.

Hypothesis, as non-inferiority: with version-only tool-line locators the model solves the same
tasks, recalls as correctly, re-reads no more, costs no more, finishes as often and uses tape
locators as successfully as with main's text. n = 3 per task and arm detects large effects
only; a pass means no large regression was seen, not equivalence.

## 2. Arms

| arm | commit | branch | what changes |
|---|---|---|---|
| control | `70e6e55` (origin/main, plugin 0.2.0, A + C) | detached worktree | nothing |
| F | `f819bb3` | `exp/p110-f-arm` (from origin/main `70e6e55`) | F only: `147d2d4` cherry-picked |

origin/main has since moved to `96932b8` (PR #19, a heap benchmark: `scripts/bench/` and one doc),
with no change to `src/`, `lib/`, `package.json`, `cordis.patch.yml` or `scripts/ab/`; the arms and
the harness branch stay on `70e6e55`.

Both worktrees pass typecheck, 342/342 vitest, check:docs, check:size and check:build. The full
suite ran with `--testTimeout=30000` because the machine's load average was 60–80 during the
build; at the default 5 s, two long-session tests in `tests/unit.test.ts` timed out on the F
worktree under that load and passed when run alone.

| tarball | sha256 |
|---|---|
| `slice-control-70e6e55.tgz` | `3eb10a04c392403b9760c14656f88a4e7bd0daf45340522f266c07a2df8ae629` |
| `slice-F-f819bb3.tgz` | `c71385064cceb0bfa26c160af256674794eb7d2a414401f0aaaaafdde4c3e949` |

The unpacked tarballs differ in `lib/context.js` (one line, 264) and the README twins, nothing else.

### Exact text change (source level, before `${}` interpolation; `SESSION_FORMAT_VERSION` is 4)

**F. Tape tool line** (`src/context.ts`, `collectItems`)
<!-- code-anchor: src/context.ts#collectItems -->

```
- [tool turn ${turn} step ${source.data.step} seq ${source.seq} · ${name} · ${size} chars · expand_result({"seq":${source.seq},"formatVersion":${SESSION_FORMAT_VERSION}})]
+ [tool turn ${turn} step ${source.data.step} seq ${source.seq} · ${name} · ${size} chars · v${SESSION_FORMAT_VERSION}]
```

The arm's commit also rewrites the three pinned test assertions to the short form (the rendered
tool line, the resumed request's locator of the unshown result, the seq extraction in
`tape-protected`) and the README twins' description of the line. Unchanged on purpose: the tape
header (`… · recall_turn / expand_result]`, A), KERNEL and the four recall tool definitions (C),
the fold view's first line, and `recall_turn`'s own `[tool step S seq Q · …]` lines.

## 3. Composition, parity and isolation

- **Host:** the published DSH 0.2.0-rc.2, frozen as an APFS copy of
  `~/.dsh-slicey/host-0.2.0-rc.2` (`diff -rq` against the original is empty; the original is
  not touched), `headless` app, one process per turn, prompt on stdin, `--json` events to a file,
  cwd = the cell's workdir. Each batch manifest records a digest of the host tree at its start
  and end.
- **Profile:** one template DSH_HOME per arm with profile `ab` (bundles `dsh-base`,
  `dsh-headless`, the plugin, installed from an arm-neutral copy `plugin-<sha12>.tgz`) and the
  parity overlay [scripts/ab/profile/eval-parity.patch.yml](../scripts/ab/profile/eval-parity.patch.yml),
  unchanged since 2026-09-27: no compaction, command-compact, tool-result pruner, session-title
  LLM or web tool; empty persona prefix and suffix; no subagent, fork or workflow tools; no skill
  catalog; no goal tools and no goal-round driver. On 0.2.0-rc.2 that leaves the same 16 tools:
  `bash`, `edit`, `exit_plan_mode`, `expand_result`, `glob`, `grep`, `job_kill`, `job_list`,
  `job_output`, `read`, `read_image`, `recall_search`, `recall_step`, `recall_turn`,
  `todo_write`, `write`. The model is the base default `deepseek-official/deepseek-flash`,
  effort high; the plugin keeps its default `inherit`. Per task, one more overlay sets
  `slice-agent-loop.maxStepsPerTurn`, identical across arms.
- `--dump-config` is identical across the two template homes (417 lines) once each home's own
  path is normalized.
- **Environment** as `~/.dsh-slicey/bin/slicey-dsh`: inherited proxy variables,
  `NODE_USE_ENV_PROXY=1`, `NODE_OPTIONS=--disable-warning=UNDICI-EHPA`, and
  `DSH_TELEMETRY_DISABLED=1`; every other inherited `DSH_*` variable is removed
  (`DSH_PERMISSION_MODE` unset means the profile default `workspace-write`; the session log shows
  `sandbox/mode workspace-write` and `approval/policy ask`). New: `TMPDIR` is a private directory
  of the cell (§3.1). The key is a symlink `vault/homes/<arm>/.env -> ~/.dsh/.env`, created only
  after the dry run.
- **Host facts checked offline on 0.2.0-rc.2:** a turn cut by `maxStepsPerTurn` ends with
  `turn_end` kind `blocked` and exit 1, as on 0.1.7-rc.2; bash reports a non-zero exit as a
  trailing `[exit code: N]` marker with `isError` false, while a rejected write or edit
  ("file has not been read") is `isError` true.

Fingerprints measured in the offline dry run (§11); every real cell must match its arm
(`vault/fingerprints.json`, copied to `docs/ab/p110-f-2026-10-22/fingerprints.json`):

| | control | F |
|---|---|---|
| system prompt sha256 | `46c592c8…` | `46c592c8…` |
| slice tool JSON sha256 (canonical JSON of the four recall tools) | `4d9ca4cc…` | `4d9ca4cc…` |
| all-tools JSON sha256 | `3a93bbda…` | `3a93bbda…` |
| system prompt chars | 3,651 | 3,651 |
| four recall tools, canonical JSON chars | 5,266 | 5,266 |
| all 16 tools, canonical JSON chars | 14,136 | 14,136 |
| per-request prefix (system + all 16 tools) | 17,787 | 17,787 (0) |
| tape header, one-digit turns | 76 | 76 |
| mean tape tool line in the dry run | 94.0 | 52.9 (−41.1) |
| tools | 16 | 16 |

The system prompt and slice-tool shas equal those of arm 1 and arm 2 on 0.1.7-rc.2 (§3 of the
2026-09-27 record): the plugin's text does not depend on the host. The prefix is 249 characters
longer than there (17,538), all of it in the host's own tool descriptions (13,887 to 14,136).

Fingerprints come from the mock provider; as on 2026-09-27 the warmup runs with
`--fingerprints none` and `run_ab.py fingerprints --compare` decides: equal, keep; different with
equal control-vs-F deltas and slice-tool shas, replace (and record in §13); a delta or a
slice-tool sha differs, stop.

### 3.1 Isolation

The 2026-09-27 run could not keep a cell from reading what other cells left on disk: concurrent
arms' workdirs and the A/B root were readable, three cells read the batch manifest, one read a
sibling cell's finished answer, and `DSH_HOME` named the arm (§14.5, §14.7 there). DSH's sandbox
confines writes only (Seatbelt `(allow default) (deny file-write*)` plus the writable roots: the
workspace, `/tmp` and `TMPDIR`), and macOS refuses a nested `sandbox-exec` (`sandbox_apply:
Operation not permitted`, exit 71, checked on this machine), so a read-confining wrapper around
the host would make its bash tool fail closed. Every cell runs as the harness's own user, so
this run confines reads with file permissions and makes sure nothing else is there to read:

- **One cell at a time.** The two cells of a (task, rep) pair run back to back, not
  concurrently. The first arm rotates with `(rep - 1 + seed)`: with the batch seed 20261022,
  control goes first in reps 1 and 3; with the arbitration seed 20261023, F goes first in reps 1
  and 3; over 6 reps each arm goes first 3 times. No other cell's workdir, home or process exists
  while a turn runs.
- **Blocked while a turn runs.** `AB/vault` (template homes, finished cell homes with their
  session logs, results, manifests, ledger, truth files, packed workdirs, tarballs) and the
  `scripts/` and `docs/` directories of the three worktrees under `AB/wt` (the only places in a
  checkout that hold task oracles and the A/B records) are `chmod 000` from just before the host
  starts until the turn's process group and every process still tied to the cell (a background
  job the model left) are killed. A process is tied to the cell when its command line or
  environment names `live/c-<id>` (its `DSH_HOME`, `TMPDIR`, `PWD` or a path argument) or its
  current directory lies in the cell (`lsof -d cwd`). Readable under `AB` then: the host, the offline
  adapter copy (`AB/mock`, dry runs only), the per-batch patches, the worktrees' source code, and
  the running cell's own root. The worktree roots stay readable on purpose: with a root at mode
  000, a `git worktree prune` by any other process in the main repository deletes the
  worktree's link, which happened once during the build (§11).
- **Read-only while a turn runs.** `AB` itself, `AB/live`, `AB/patches`, the batch's patch
  directory, `AB/mock`, `AB/wt` and `AB/host` lose their write bits for the same window, so a cell
  cannot leave a file there for a later cell (its own root under `live/` stays writable).
- **Tamper evidence.** The owner can chmod its own files and the sandbox allows writes under
  `/tmp`, where the A/B root lives, so a deliberate chmod is possible. After every turn the
  harness checks that each blocked or read-only path still has its mode and the inode and ctime
  it had right after blocking; any change (a chmod, a rename, a new entry) is a breach and makes
  the cell invalid (§7). The worktrees' source trees stay writable, so between a cell's first and
  last turn `git status` of each worktree (untracked and ignored entries included, bytecode
  excluded) must not change, or the cell is invalid.
- **Per cell.** A fresh root `AB/live/c-<id>/` holds a copy of the arm's template home, a private
  `TMPDIR` and the workdir `w-<id>`; ids are hashes, the same length in both arms, so neither the
  path nor `DSH_HOME` nor the profile's `package.json` names the arm. r5's truth sidecar sits in
  the vault while turns run and is put back only for `verify()`. When the cell ends, the workdir,
  truth sidecar and tmp are packed into the vault, the home (session log included, key link
  removed) moves there, and the cell root is removed.
- **Quarantine.** New top-level entries of `AB` that the harness did not create, and new
  top-level entries of `AB/..` and `/private/tmp` that the cell's own tool calls name (as a path,
  or, for a name of six characters or more, as a bare word, as after `cd /tmp && mkdir x`), move
  into the vault when the cell ends, so scratch a model wrote outside its root cannot reach a later cell.
- **Not covered.** Other copies of this repository on the machine (the main checkout and other
  worktrees) hold the task definitions and oracles and stay readable, as do the owner's archives
  of the 2026-09-27 run. Reaching them means a path outside the workdir, which is flagged (§6),
  and an oracle arriving that way is caught by content (oracle via the file system). The cell's
  own session log is readable too (the host writes it); reading it is flagged (`sessions/`,
  `.zstd`). So are a file written into a directory that already existed elsewhere under `/tmp`
  (for example a sibling of `AB`), which survives the cell, and a background process that strips
  its environment and also leaves the cell's directory, which is not found; both need a tool call
  naming a path outside the workdir, which is flagged.

The barrier was proven on the dry run with `run_ab.py isolation-probe` (§11): canaries in every
protected place plus the other arm's real files, read by a scripted cell with bash, `read`,
`glob` and `grep` after it started three background jobs (one without `DSH_HOME` and `TMPDIR`),
writes into every read-only directory, a `/tmp` plant after a `cd`, and a tamper cell per arm
that chmods the vault and leaves a file in a worktree. The read-only directories, the wider stray
match, the bare-name quarantine and the worktree check were added after an offline review probe
on the first build had shown each of those channels working (§11).

## 4. Tasks

The seven gated tasks and the warmup of 2026-09-27, files under [scripts/ab/tasks](../scripts/ab/tasks),
with one fix. Five need recall and two are ordinary coding. In every recall task the fact reaches
the model only as a tool result (user and assistant text stay verbatim on the tape, tool output
does not), and the harness deletes its source between turns (`hooks.py`), so a correct exam
answer requires recall. Oracles never live in the workdir.

| alias | task | turns | step cap | exam | notes |
|---|---|---|---|---|---|
| hello | `hello` | 1 | 4 | – | warmup: "Reply with exactly: HELLO"; always passes |
| r1 | `p110_r1_fixture_fp` | 6 | 12 | T5 | fixture fingerprint printed in T1 (delivery T1); sources deleted after T2; decoys in T3/T4 floods |
| r2 | `p110_r2_superseded_stamp` | 7 | 12 | T6 | config stamp printed in T2 (stale) and T4 (current, after a REGION fix; delivery T2 and T4); sources deleted after T4 |
| r3 | `p110_r3_runbook_middle` | 3 | 12 | T3 | 420-line prose runbook read in T1 (fold required; in-turn fact in T1); `docs/` deleted after T1; T2 filler; T3 asks a second fact of the same read |
| r4 | `p110_r4_probe_compare` | 4 | 12 | T4 | two probe outputs (T1 us, T2 eu; delivery both); `tools/` deleted after T2; T3 filler; T4 combines one row of each |
| r5 | `p110_r5_initial_failures` | 2 | 60 | T2 | T1 fixes a red 400-test suite (5 bugs); T2 lists the tests that failed before any change |
| c1 | `lh1_incremental_build` | 8 | 14 | – | 8 dependent turns building `calc.py` |
| c2 | `m3_consistency_bugfix` | 1 | 26 | – | one invariant across 4 modules; a single turn, so no tape: F and control are structurally identical here |

**Fix (§14.8 and §14.10 there).** The r3 T2 and r4 T3 filler prompts ask to add a function to
`lib/slug.py` and `lib/fmt.py`, which the 2026-09-27 setups never created; models searched the
disk for them, and those searches excluded cells from G2. Since this run the setups create both
files with a docstring and one existing helper (`collapse_spaces()`, `plural()`); the prompts are
unchanged. The task self-check covers this (25/25, §11). A side effect identical in both arms:
DSH rejects an edit of a file that has not been read, so the filler now reads the file first.

Oracle-token roles (recall, leak, file-system tokens per exam), the delivery rule for r1, r2 and
r4, and the exam answer classes are as in §4 and §6 of the 2026-09-27 record.

## 5. Procedure

1. Offline dry run (done, §11): all tasks x 2 arms x 1 rep with the scripted mock, then the
   isolation probe; fingerprints from the dry run.
2. Before the key is linked, no oracle copy may sit on disk outside the vault, the worktrees or
   a running cell (§3.1); self-checks run in a temporary directory.
3. Link the key into both template homes (`ln -s ~/.dsh/.env vault/homes/<arm>/.env`, never
   read, printed or copied). Warmup and parity: `hello` x 2 reps x 2 arms, `--fingerprints none`.
   Every arm must show step-1 cacheRead >= 4000 in rep 2, 16 tools and no `/private` or `/Users`
   in the system prompt; then the fingerprint comparison of §3 decides.
4. Pilot, control only: r1–r5 x 1 rep (the five recall tasks, on a host they have not run on
   before; r3 and r4 also with the filler fix). Check oracles, delivery, leak and access flags,
   the r3 fold, wall time.
5. If control cannot pass a task at all, fix that task here; this is the only point where a task
   may change. Then fill §13 and commit: that commit freezes the pre-registration.
6. Batch: 7 tasks x 3 reps x 2 arms = 42 cells, seed 20261022 (seeded task order per rep), one cell
   at a time (§3.1). An invalid cell is rerun once; infra reruns are reported separately and never
   count as behaviour.
7. Report: `ab_report.py` pairs cells by (task, rep), evaluates
   [scripts/ab/gates-f.json](../scripts/ab/gates-f.json) and writes `summary.json` / `summary.md`
   with each check's room; the per-turn cache split is cross-checked with dsh-slice
   `cache-metrics.py`. Arbitration only as in §9.
8. Archive: `run_ab.py secrets-scan` first; cells with a tool call that referenced `.env`,
   `DSH_HOME` or `~/.dsh` have their session logs and turn files held back (into a `chmod 700`
   `held-back/`) until the owner has looked. Raw data goes to the dsh-slice workspace
   (`results/20261022-p110-f-ab/`), small summaries to `docs/ab/p110-f-2026-10-22/`.

## 6. Metrics

As in §6 of the 2026-09-27 record (`ab_metrics.py`, one row per cell), with these changes, all
decided before any paid call:

- **G3 counts only successful mutations (primary).** A mutation (`write`/`edit`, a bash redirect,
  `rm`, `mv`, `cp`, `tee`, `touch`, `sed -i`, `perl -i`) counts only when its tool result is not
  an error: for `write`/`edit`, `isError` is not true (a rejected write such as "file has not been
  read — read the file, then retry" changed nothing); for bash, `isError` is not true and the
  result ends with no `[exit code: N]` (N ≠ 0), `[killed by signal: …]`, `[timed out after …]`,
  `[stopped: …]` or `[sandbox: …]` marker. A call without a recorded result does not count. So
  the read that DSH forces after a rejected edit is a first read, not a read after the model's
  own edit. Known corner: a redirect in a bash command that then exits non-zero did write its
  file and is not counted.
- **Secondary, reported, not gated:** the 2026-09-27 definition (every mutating call counts),
  `reads_any_mutation` in the row, `rereads_same_turn_any` in the report.
- **Flag false positives removed** (§14.10 there): `find -path/-name/-regex …` arguments are
  patterns, not paths; `cd $PWD`, `cd $(pwd)` and `cd .` stay put and `cd $DSH_WORKSPACE` goes to
  the workspace; a `*.env` glob and an attribute access such as `Calculator(...).env` are no key
  reference; a heredoc counts as a write-like input only when it ends up in a file (its command
  line redirects into one or pipes into `tee`, or the script it feeds opens a file for writing or
  redirects). Every other flag rule is unchanged, and `vault/`, `/homes/` and the worktree names
  are added to the sensitive patterns.
- Reads are unchanged: every `read` call and single-file bash read counts, successful or not.

## 7. Validity

As in §7 of the 2026-09-27 record, with the arm structure from `gates-f.json`: a cell counts only
if every turn exited 0 or ended in a model-attributable way; the log was found; the system prompt
and slice tool fingerprints equal the arm's; 16 tools, one tool list and one system prompt per
session; one turn per prompt; no `/private` or `/Users` in the system prompt; zero compaction
events; tape headers short (76 or 78 chars) and tool lines in the arm's form (control long, F `v`);
**for F, the system prompt sha, slice tool sha and request prefix length equal control's**; **no
isolation breach in any turn and no worktree change during the cell** (§3.1); for r3 a fold of
the T1 read; for r1, r2 and r4 the exam's fact in a non-recall tool result of every delivery
turn. Otherwise the cell is rerun, at most 2 attempts. A pair counts only when both its cells are valid; dropped pairs are listed in the
report. Infra and model-attributable endings are classified as on 2026-09-27.

A cell counts for G1 but its pair is dropped from G2 when, up to its exam turn, a call was
flagged, or a leak token leaked, or the exam answer came via the file system (§6). A flagged call
still excludes when the access was denied: the rule is about where the model looked, and a
denied path can sit next to a readable copy elsewhere (§3.1, not covered).

## 8. Gates

Unit: 7 tasks x 3 reps = 21 paired cells (F against control); the 15 recall pairs for G2.
[scripts/ab/gates-f.json](../scripts/ab/gates-f.json) encodes these as data.

**Minimum valid pairs, stated up front:** 17 of 21 (G1, G3, G4, G5, G6) and 10 of 15 (G2) in a
batch. Pooled with the arbitration batch (6 reps) the minimums scale with the number of rep sets:
34 of 42 and 20 of 30. A check below its minimum is "insufficient".

- **G1 Task success (non-inferiority).** Σpass(F) ≥ Σpass(control) − 1, and no task with
  pass(F) ≤ pass(control) − 2.
- **G2 Recall correctness** (recall pairs).
  (a) recall-sourced correct exam answers: F ≥ control − 1;
  (b) errors on recall_turn, recall_search, recall_step and expand_result, all turns: F ≤ control + 2;
  (c) formatVersion rejections: F ≤ control + 2, and every F rejection recovered in the same turn;
  (d) decoy, stale, hedged, wrong or CANNOT-RECOVER exam answers: F ≤ control + 1.
- **G3 Same-turn repeated reads, success-only mutations (§6).** R = Σ(reread_same_turn_unchanged
  + reread_same_turn_after_edit); R(F) ≤ 1.25·R(control) + 2. The any-call R is reported.
- **G4 Cost.** Median paired cost ratio F/control ≤ 1.10; Σcost(F) ≤ 1.10·Σcost(control); median
  paired request-count delta ≤ +1 per cell; recall_turn view "full" calls ≤ control + 2.
- **G5 Finish.** Completed turns ending in a text closeout: F ≥ control − 1. Turns cut by
  maxStepsPerTurn: F ≤ control + 1.
- **G6 Locators.** First-try success rate of `expand_result` on cross-turn targets ≥ control's −
  10 percentage points; extra hops (a locator taken from recall_turn/recall_search output although
  the tape already carried it) ≤ control + 2.

Reading of the gates, pre-declared:

- Verdicts per check: **pass**; **arbitrate** when missed by exactly one unit beyond its margin
  (one count; 0.05 of a cost ratio; one request of median delta; one cross-turn target of the
  first-try rate); **fail** when missed by more; **insufficient** when below the minimum pairs
  or not evaluable at all (no pairs, no pair with a positive baseline cost, no cross-turn target
  on either side: unlike 2026-09-27, G6's first-try check may not be n/a, because the locator is
  what F changes). Gate verdict order: fail, insufficient, arbitrate, pass.
- **Room** of a check: how far the value is from its limit, in the same units: limit − value in
  counts (G1 total, G2, G3, G4 full views, G5, G6 hops; G3's limit may be fractional); for the
  per-task drop, the worst task's pass(F) − (pass(control) − 1); (1.10 − ratio)/0.05 for the cost
  ratios; (1 − median delta) for requests; for the first-try rate, F's successes minus the fewest
  that would pass. Equality checks (G2c recovered) have no room: they pass or fail.
- Exclusions are paired: an invalid or G2-excluded cell drops its (task, rep) pair from that
  comparison on both sides.

## 9. Decision rule and arbitration

- **Ship F only if every check passes with at least one unit of room** (the owner's ruling on
  2026-09-27 asked for evidence with room). Equality checks must pass.
- **Any check fails:** do not ship F. No arbitration.
- **No check fails, but at least one arbitrates, is insufficient, or passes with less than one
  unit of room:** one arbitration batch, decided in advance: +3 reps of **all seven tasks**
  (whichever check triggered it), both arms, **seed 20261023**, the same sequential pairing (the
  first arm rotating as in §3.1). Decide on the pooled 6 reps (`ab_report.py --pooled`): count
  margins doubled, minimum pairs doubled (34 and 20), the room requirement unchanged. If the
  pooled result is anything other than "every check passes with at least one unit of room", do
  not ship F. There is no second arbitration.
- Shipping F means its commit, rebased onto main, goes into a PR for the owner; F does not change
  the cached prefix, so it needs no release that changes the prefix anyway.
- Counts and paired deltas are reported, not p-values.

## 10. Budget and cost

Hard cap **$10 at peak prices** for the whole experiment (warmup, pilot, batch, arbitration),
enforced by `run_ab.py --budget-usd 10` over one ledger (`vault/spend.jsonl`) from usage tokens at
the peak sheet (miss $0.44/M, hit $0.014/M, out $1.32/M). A turn's charge is the larger of its
stdout figure and its session-log figure, with $0.05 per usage-less or open step; no cell starts
within $0.75 of the cap; the running turn is polled every second and killed within $0.60 of it
(one turn runs at a time, so the margin covers 2 x 1 x $0.10 three times over); more than 40
unpriced steps stop the run. Estimate from the 2026-09-27 batch ($2.2320 for 63 cells, about
$0.035 per cell at peak): batch 42 cells ≈ $1.50, arbitration ≈ $1.50, warmup and pilot ≈ $0.20,
so ≈ $3.2 with arbitration. Wall time is longer than in 2026-09-27 (one cell at a time): the
pilot's recall cells took 24–72 s (§13), and the isolation checks add about 1.3 s per turn
(`ps`, `lsof`, `git status`), so about 40–60 minutes per batch.

## 11. Offline dry run (build evidence, 2026-10-22)

Harness `e9d1c5d` on `exp/p110-f-harness` (clean tree), and from "Review probe and hardening" on,
`619703e`. No key existed in any home; the mock
adapter (`scripts/ab/mock-llm.mjs`, provider `ab-mock`, copied to `AB/mock/`) scripted `ls`, a
stated config correction, a run of any named `tools/` script, two reads of the first file the
prompt names, and an `expand_result` on the newest tape tool line in whichever form the arm
renders.

- **Prepare.** Two template homes from the tarballs of §2 (installed as `plugin-3eb10a04c392.tgz`
  and `plugin-c71385064cce.tgz`); `--dump-config` identical (417 lines); no skipping or disabling
  line in either dump or install log.
- **Dry run `offline`** (fingerprints not checked): 8 tasks (7 + hello) x 2 arms x 1 rep = 16
  cells, one at a time, 08:39:34–08:41:22 UTC: 64/64 turns exited 0 with empty stderr, 16/16 logs
  found, 16/16 metrics rows, 16/16 cells valid on the first attempt, one turn per prompt
  everywhere; no flagged call, leak or oracle via the file system; no isolation breach, stray
  process or quarantined entry; the host digest unchanged. Every delivery turn carried its fact
  (r1 T1, r2 T2 and T4, r4 T1 and T2); the r3 T1 read was folded in both arms; tape forms
  control short/long, F short/`v`; all 48 mock `expand_result` calls found their locator on the
  tape with formatVersion 4 (0 rejections, 0 without provenance). Same-turn re-reads 28 under
  both mutation readings (the mock never mutates). Afterwards no workdir, truth file, plain-text
  turn file or cell root remained outside the vault; r5's packed workdir holds its truth sidecar.
  $0.0167 at peak on the mock's fixed usage samples (its own ledger).
- **Fingerprints** from `offline` (above); `run_ab.py fingerprints --compare` against those of the
  earlier superseded run: no changed field, no delta mismatch.
- **Dry run `offline2`**, validated against those fingerprints: the same figures, 16/16 cells
  valid on the first attempt.
- **Isolation probe** (`run_ab.py isolation-probe --target-batch offline`), per arm:
  - read cell: 31 protected targets: canaries in the other arm's template home, the vault root,
    a manifest, a truth file and the `scripts/` and `docs/` of all three worktrees; the other
    arm's real template `package.json`, finished cell home and session log, packed workdir; the
    `offline` manifest, index and ledger; a turn stream; `arms.json`, `fingerprints.json`; the task
    oracle `p110_r4_probe_compare/meta.json` in each worktree; listings of the vault, the homes
    and the six blocked worktree directories. **31/31 denied, 0 canaries in any tool result**;
    the 18 `read`, `glob` and `grep` calls on them all returned errors (EACCES or `rg` exit 2);
    the cell's own canary and home were readable; `AB/live` listed only the probing cell;
    1 session-escaping background job killed after the turn, 0 processes with the cell's
    `DSH_HOME` left.
  - tamper cell: `chmod 755 vault`, a read, `chmod 000 vault`. The sandbox allowed the chmod (the
    A/B root is under `/tmp`); the harness reported `vault: metadata changed while blocked` and
    the cell was invalid, in both arms.
  - after the probe: every blocked path back at its mode, `AB/live` empty, no `.blocked.json`.
- **Tests:** `test_ab_metrics.py` 23 tests: 19 pass and 4 skip without data; with
  `AB_OFFLINE_BATCH` set to `offline` or `offline2`, 20 pass (the mock-log check on all 16
  cells) and the 3 Raft-log tests skip;
  `test_ab_report.py` 14/14, `test_run_ab.py` 13/13, `selfcheck_tasks.py` 25/25; on the harness
  branch typecheck, 342/342 vitest (`--testTimeout=30000`, see §2), check:docs, check:size and
  check:build pass.
- **Superseded during the build** (kept under `vault/results/`, not evidence for the gates):
  `offline-pre-mockfix` (uncommitted harness) and `offline-pre-r2fix` (`8ce3e51`), each 14/16
  valid: r2 failed its T4 delivery check because the mock neither ran a script named second in
  the prompt nor applied the REGION correction the prompt asks for first (fixed in the mock,
  `0b62a38`); `offline-pre-wtfix`, `offline2-pre-wtfix` and the probe iterations
  `isoprobe-1`..`3`, `isoprobe-pre-wtfix` (`0b62a38` and its uncommitted probe edits), which
  blocked the worktree roots. During one of those probe turns, a `git worktree prune` run by
  another process in the main repository found the three worktrees' `.git` links unreadable and
  deleted their metadata; the worktrees were re-created from the unchanged branches (no commit
  lost; the one uncommitted file was carried over and diffed), and since `e9d1c5d` only
  `scripts/` and `docs/` of each worktree are blocked.
- **Review probe and hardening (`619703e`, before the freeze).** An offline review probe on
  `ae7221a` (two scripted cells, control then F, no key) found three ways for one cell to reach the
  next: (1) a background job started with `env -u DSH_HOME -u TMPDIR` that forked and left its
  session survived the turn and listed the vault 0.4 s after it became readable again; (2) a file
  the first cell wrote into `AB/patches/<batch>/` was read by the second; (3) a directory made in
  `/tmp` after `cd /tmp` was not quarantined (the quarantine matched full paths only) and was read
  by the second cell. A file in a sibling directory of `AB` that already existed was read too, and
  a task oracle was readable through the main repository's object store
  (`git -C AB/wt/harness show HEAD:scripts/ab/tasks/…`); both are the not-covered cases of §3.1
  and are flagged. `619703e` closes (1)–(3) and adds the worktree check (§3.1).
- **Dry run `offline3`** (harness `619703e`, validated against the fingerprints), 09:29–09:32 UTC:
  16/16 cells valid on the first attempt, 64/64 turns exit 0; no flag, leak, breach, stray,
  quarantined entry or worktree change; host digest unchanged. The cells' summed wall time was
  183 s against 102 s for `offline2`: the added `ps`, `lsof` and `git status` checks.
- **Isolation probe `isoprobe-v2`** (`--target-batch offline3`), per arm: 31/31 targets denied,
  0 canaries in any tool result, own files readable, `AB/live` showed only the probing cell;
  2 background jobs killed as strays after the turn (1 in the build's probe, which had no job
  without `DSH_HOME`), 0 processes tied to the cell and 0 escapees left; 7/7 writes into the read-only directories refused; the `/tmp` plant quarantined. Tamper
  cell: the vault chmod was detected and the file left in `wt/control/src/` was detected
  (`isolation: worktree control changed during the cell`); the cell was invalid. Afterwards every
  mode was restored, `AB/live` was empty, no `.blocked.json`, all worktrees clean.
- **The review's own probe script, re-run on `619703e`** (a copy writing to its own directory,
  batch `review-probe-v2`): the write into `patches/<batch>/` was refused, the `/tmp` directory was
  quarantined, the escapee was killed after the turn (1 stray) and never reached the vault; only
  the pre-existing sibling directory of `AB` still carried its marker to the next cell (§3.1).
- **Tests on `619703e`:** `test_run_ab.py` 18/18 (new: read-only directories, bare-name
  quarantine, the stray marker and a process found by its cwd alone, the worktree state),
  `test_ab_metrics.py` 23 (19 pass, 4 skip without data), `test_ab_report.py` 14/14,
  `selfcheck_tasks.py` 25/25. `619703e` changes only `scripts/ab/run_ab.py` and its test.
- Fingerprints, tarball checksums and the probe and dry-run summaries are in
  [docs/ab/p110-f-2026-10-22/](ab/p110-f-2026-10-22/fingerprints.json) (`probe-v2.json` and the
  `offline3` entry of `dryrun.json` are the hardened harness's).

## 12. Risks and limits

- Shared provider cache: both arms send a byte-identical request prefix, so the provider's prefix
  cache is shared across arms (in the warmup, F's first request hit the 4,480 tokens control had
  just written). Every cell after the first of a batch finds the prefix cached whichever arm ran
  before it, and the per-cell context after the prefix ends the shared part (in the warmup, rep 2's
  identical prompt hit the same 4,480 tokens as rep 1, not more), so only the first request of a
  batch is affected; the first arm rotates (§3.1) in any case.

- Low power: n = 3 per task and arm (6 with arbitration); a pass is "no large regression".
- F acts only from the second turn of a session on (the first sealed entry). c2 has a single turn
  and no tape, so its pairs measure noise; hello likewise (not gated).
- Sequential pairs: the two cells of a pair no longer run at the same moment. They run back to
  back with the first arm rotating, which balances order and drift over 6 reps; provider weather
  inside a pair is not controlled as tightly as with concurrent arms.
- Isolation is by permissions, not a read sandbox: a model that deliberately chmods the vault
  can read it, but the change is detected and the cell is invalid. Copies outside the A/B root
  stay readable and are only flagged (§3.1).
- External validity: a hermetic headless composition, one process per turn, one provider and
  model; production slicey is a long-lived web app with compaction and the pruner. F's per-entry
  saving grows with session length, which the tasks do not reach.
- Host: cost and cache figures on 0.2.0-rc.2 are not comparable with the 2026-09-27 figures
  (0.1.7-rc.2), and F's effect here is measured against A + C, not against the old control.

## 13. Frozen parameters and pilot (pre-registration, committed before the batch)

- **Harness:** code at `619703e` (`scripts/ab/` tree `da99d24`; tasks tree `00bae6a`, unchanged
  since `8ce3e51`). The freeze commit that fills this section changes only this file, the text
  of `scripts/ab/README.md` and `docs/ab/p110-f-2026-10-22/`; every batch manifest records the
  commit it ran from (`harness_commit`), and
  `git diff 619703e <that commit> -- scripts/ab ':!scripts/ab/README.md'` must be empty. The
  warmup and the pilot ran on `ae7221a`, whose task, metric, validity and gate code equals
  `619703e`'s: `619703e` changes only the isolation (§3.1, §11) and adds one validity reason (a
  worktree change during the cell); all worktrees were clean after the pilot.
- **Arms:** control `70e6e55`, F `f819bb3`; tarballs and sha256 in §2 and
  `docs/ab/p110-f-2026-10-22/SHA256SUMS` (identical to `AB/vault/artifacts/SHA256SUMS`, checked
  with `shasum -c` at the freeze).
- **Host and model:** DSH 0.2.0-rc.2 (frozen copy; host tree digest `9f7289f19134…` at the start
  and end of every batch so far); provider `deepseek-official`, model `deepseek-flash`,
  `reasoningEffort` high, `maxTokens` 256000 (request headers of the warmup logs); sandbox
  `workspace-write`, approval `ask`.
- **Fingerprints:** §3, unchanged by the warmup: `run_ab.py fingerprints --compare` on `warm`
  found no changed field and no delta mismatch, so `docs/ab/p110-f-2026-10-22/fingerprints.json`
  stands (the §3 fallback was not needed). The pilot and `warm2` cells were validated against it.
- **Price sheet:** §10 and `scripts/ab/prices.json`: peak miss $0.44/M, hit $0.014/M, out
  $1.32/M (off-peak half of each); the budget prices every turn at peak.
- **Budget:** `--budget-usd 10` over the single ledger `AB/vault/spend.jsonl`, which holds the
  warmup, the pilot and the smoke run below: 28 turns, **$0.0582** at peak, no unpriced step;
  reserve $0.75, margin $0.60, $0.05 per unpriced step, stop after 40 unpriced steps.
- **Batch:** `python3 $H/run_ab.py --ab-root $AB --arms control,F --tasks all --reps 3 --seed
  20261022 --budget-usd 10 --batch p110f-20261022` (continued with `--resume` after a stop),
  `--max-attempts 2`, fingerprints `AB/vault/fingerprints.json`, gates `scripts/ab/gates-f.json`.
  Task order per rep is seeded by `20261022:<rep>`; control goes first in reps 1 and 3, F in rep 2.
- **Arbitration** (only if §9 triggers it): the same command with `--seed 20261023 --batch
  p110f-20261022-arb`, F first in reps 1 and 3; decided by `ab_report.py <batch> <arb> --pooled`.
- **Tasks:** r1 `p110_r1_fixture_fp`, r2 `p110_r2_superseded_stamp`, r3 `p110_r3_runbook_middle`,
  r4 `p110_r4_probe_compare`, r5 `p110_r5_initial_failures`, c1 `lh1_incremental_build`, c2
  `m3_consistency_bugfix`, exactly as in the tasks tree above; no task changed at the pilot.
- **Gates and decision:** §8, §9 and `scripts/ab/gates-f.json`, unchanged: the margins; minimum
  valid pairs 17 of 21 (G1, G3, G4, G5, G6) and 10 of 15 (G2) per batch, 34 of 42 and 20 of 30
  pooled; F ships only if every check passes with at least one unit of room; one arbitration
  batch (all seven tasks, +3 reps, seed 20261023), no second.
- **G2 exclusion:** as drafted in §7, a flagged call up to the exam turn drops the pair from G2
  even when the access was denied. No change was asked for before the freeze. The pilot shows its
  cost (r2 below); the r3 and r4 filler fix removed the cause of the 2026-09-27 searches in
  those two tasks.

### Warmup (paid, 09:15:19–09:15:33 UTC)

`hello` x 2 reps x 2 arms, one cell at a time, `--fingerprints none` (harness `ae7221a`): 4/4
cells valid and passed; step-1 cacheRead in rep 2: control 4,480, F 4,480 tokens (required
≥ 4,000). In rep 1, control's request was the batch's first (0 hit) and F's, seconds later, hit
4,480 (§12). 16 tools; system sha `46c592c8…`, slice-tool sha `4d9ca4cc…`, prefix 17,787 chars
in both arms; no `/private` or `/Users` in any system prompt; the fingerprint comparison found
no changed field and no delta mismatch. $0.0026 at peak.

### Pilot (control only, harness `ae7221a`, 09:16:31–09:19:54 UTC)

r1–r5 x 1 rep (the five recall tasks, on a host they had not run on, r3 and r4 with the filler
fix). All five passed and were valid on the first attempt; every exam was recall-sourced; no
leak, no oracle via the file system, no isolation breach, stray, quarantined entry or step-limit
cut; every delivery turn carried its fact (r1 T1; r2 T2 and T4; r4 T1 and T2); the r3 T1 read
was folded; tape headers 76 chars, tool lines in the long form.

| task | pass | valid | G2-eligible | exam source | recall-tool errors | cross-turn `expand_result` first try | extra hops | wall | peak $ |
|---|---|---|---|---|---|---|---|---|---|
| r1 | yes | yes | yes | `expand_result`, its locator taken from a `recall_turn` dialogue view | 0 | 1 of 1 | 1 | 40 s | 0.0103 |
| r2 | yes | yes | **no** (flag in T6, below) | `recall_step` of the T4 and T2 runs; the current value | 0 | – | 0 | 72 s | 0.0184 |
| r3 | yes | yes | yes | `expand_result` with `grep` on the T1 read's tape locator | 1 (an invalid regex `(?i)…`, fixed by the next call) | 0 of 1 (2 calls) | 0 | 24 s | 0.0058 |
| r4 | yes | yes | yes | `expand_result` x 3 on tape locators | 0 | 3 of 3 | 0 | 30 s | 0.0068 |
| r5 | yes | yes | yes | `expand_result` x 3 and `recall_step` of T1 | 0 | 3 of 3 | 0 | 32 s | 0.0141 |

- The r3 and r4 filler turns found `lib/slug.py` and `lib/fmt.py` in place; neither cell made a
  call outside its workdir (0 flags), where 2026-09-27 models had searched the disk for them.
- r2's exclusion: in the exam turn, after recalling the value with `recall_step`, the model ran
  `find .. -maxdepth 4 -name 'service.env' -o -maxdepth 4 -name 'stamp.py'`, looking for the
  sources deleted after T4. `..` is the cell root (its home and tmp), so the call is flagged
  ("outside"); it found nothing. By §7 such a pair drops from G2. The behaviour is the model's
  and the same in both arms, and control passes r2, so the task stays as it is (§5 step 5).
- r3's recall error is an `expand_result` regex the tool rejects (inline `(?i)` flag); the next
  call without it succeeded. It counts in G2b and as a failed first try in G6 for whichever arm
  does it.
- **Changes made at the pilot:** none to tasks, prompts, metrics or gates. The harness change
  `619703e` came from the offline review (§11), not from the pilot. It was followed by a paid
  smoke run `warm2` (`hello` x 1 x 2 arms on `619703e`, validated against the fingerprints,
  09:34:01–09:34:10 UTC): 2/2 valid, step-1 cacheRead 4,480 in both arms, $0.0003.

Spend so far: **$0.0582** at peak (warmup $0.0026, pilot $0.0553, smoke $0.0003), no unpriced
step. The pilot's recall cells cost $0.006–0.018 ($0.011 mean); at the 2026-09-27 mean of $0.035
per cell (c1 and c2 included) the 42-cell batch costs about $1.5 and an arbitration as much, well
inside the cap. Per-cell records, without oracle tokens or answer text:
[docs/ab/p110-f-2026-10-22/pilot.json](ab/p110-f-2026-10-22/pilot.json).

## 14. Results

Final record, 2026-10-22. Two independent verifiers checked the report before this section was
written. Each used its own log extractor and gate evaluator and shared no code with
`ab_metrics.py` or `ab_report.py`. One also re-ran the c1 and c2 oracles on fresh extractions of
the packed workdirs and read 16 transcripts. Every gate value and verdict reproduced. §14.5 lists
where they differed and how each point was resolved.

**Decision: do not ship F.** The pooled G3 fails, and the pooled G4 request check passes with
only 0.5 units of room. Either result alone blocks shipping under §9.

### 14.1 Runs, infra and spend

Harness `8491106` (the freeze commit). Both manifests record it as `harness_commit`, and
`git diff 619703e 8491106 -- scripts/ab ':!scripts/ab/README.md'` is empty. Arms, host, model
and fingerprints are as in §13.

| batch | window (UTC, 2026-10-22) | cells | valid on attempt 1 | infra reruns | pass | summed cell wall | spend at peak |
|---|---|---|---|---|---|---|---|
| `p110f-20261022` (the §13 command, seed 20261022) | 09:42:26–11:08:55 | 42 | 42 | 0 | 42 | 86.0 min | $1.4215 |
| `p110f-20261022-arb` (arbitration, seed 20261023, §14.2) | 11:10:46–12:49:48 | 42 | 42 | 0 | 42 | 98.3 min | $1.3405 |

- **Infra.** Neither batch had an infra failure, invalid cell or rerun. There were no
  model-error turns, harness timeouts, budget stops, compactions or goal calls. Of 372 paid
  turns, 331 completed with exit 0 and 41 ended `blocked` with exit 1. All 41 were c1 turns cut
  at the 14-step cap. One provider attempt failed with a transport error and no usage sample
  (`m3_consistency_bugfix.r1.F`, turn 1, step 1). It was retried inside the turn, and the turn
  completed. The ledger charged it $0.05 as an unpriced step. It counts toward the budget only;
  G4 is priced from usage tokens.
- **Parity.** All 84 cells matched their arm on these checks:
  - system prompt sha `46c592c8…` and one 16-tool JSON sha in every cell;
  - a request prefix of 17,787 chars in both arms;
  - tape headers of 76 chars;
  - tool lines in the arm's form: 572 short lines and no long ones in F, 555 long lines and no
    short ones in control (a verifier's count).

  Every F home carries the `· v${SESSION_FORMAT_VERSION}]` build of `lib/context.js`, and every
  control home the long form. `--dump-config` is identical once each home's own path is
  normalized. The r3 T1 read was folded in every cell, and every delivery turn carried its fact.
- **Isolation (§3.1).** Cells ran strictly one at a time, with no overlap. The first arm rotated
  as frozen: control first in reps 1 and 3 of the batch, F first in reps 1 and 3 of the
  arbitration. There were 0 isolation breaches, 0 strays and 0 worktree changes, and every cell
  was valid. 15 entries in the batch and 18 in the arbitration were quarantined: scratch scripts
  that the models of c1 cells, one c2 cell and one r5 cell wrote straight into `/private/tmp`
  instead of their `TMPDIR`. Each moved into the vault when its cell ended. The host tree
  digest was `9f7289f19134…` at the start and end of both batches.
- **Spend.** **$2.8202 at peak prices of the $10 cap**, over 400 ledger turns: warmup $0.0026,
  pilot $0.0553, smoke $0.0003, batch $1.4215 and arbitration $1.3405. The batch figure is the
  token-priced $1.3715 plus the one $0.05 unpriced charge, and the arbitration figure equals its
  token-priced cost. After the arbitration, the key links in both template homes were removed
  with `unlink`; the target was never read. §9 allows no second arbitration, so no paid run is
  left under this pre-registration.
- **Elsewhere during the run.** origin/main moved from `96932b8` to `b985abb` at 10:00:49 UTC,
  during the batch. That merge was PR #20, "Support DSH 0.2.1-rc.2 beside 0.2.0-rc.2 (plugin
  0.3.0)". The arms, the harness and the frozen host copy are pinned, so the move has no effect
  on this experiment. The statement in §2 that origin/main "has since moved to `96932b8`" is out
  of date (§2 stays as frozen).

### 14.2 Batch alone, and the arbitration it triggered

Batch alone (21 pairs; 12 G2 pairs, minimum 10):

| check | F | control | limit | verdict | room |
|---|---|---|---|---|---|
| G1 cells passed | 21 | 21 | ≥ 20 | pass | 1 |
| G1 worst task | 3 vs 3 everywhere | | fails at −2 | pass | 1 |
| G2a recall-sourced correct | 12 | 12 | ≥ 11 | pass | 1 |
| G2b recall-tool errors | 2 | 2 | ≤ 4 | pass | 2 |
| G2c formatVersion rejections, unrecovered | 0, 0 | 0 | ≤ 2, = 0 | pass | 2 |
| G2d bad exam answers | 0 | 0 | ≤ 1 | pass | 1 |
| G3 same-turn re-reads (success-only) | 28 | 22 | ≤ 29.5 | pass | 1.5 |
| G4 median paired cost ratio | 1.0136 | | ≤ 1.10 | pass | 1.73 |
| G4 Σcost ratio | 1.0455 | | ≤ 1.10 | pass | 1.09 |
| G4 median paired Δrequests | **+1** | | ≤ +1 | **pass, no room** | **0** |
| G4 recall_turn "full" views | **3** | 0 | ≤ 2 | **arbitrate** | **−1** |
| G5 text closeouts | 83 | 82 | ≥ 81 | pass | 2 |
| G5 step-cap cuts | 10 | 11 | ≤ 12 | pass | 2 |
| G6 first-try success | 18/19 = 0.947 | 29/31 = 0.935 | ≥ 0.836 | pass | 2 |
| G6 extra hops | 4 | 4 | ≤ 6 | pass | 2 |

No check failed. G4.full_views missed by exactly one unit, and G4.requests passed with no room,
so §9 required the one arbitration batch. It ran as frozen:

- all seven tasks, 3 more reps, both arms;
- seed 20261023, F first in reps 1 and 3;
- the same command, harness and host.

The arbitration batch alone is not a decision input. On its own it fails G3: 31 vs 19 against a
limit of 25.75. Its other checks pass with at least one unit of room: G4.requests median 0,
full views 1 vs 2, G6 first try 13/15 vs 16/18.

### 14.3 Pooled gates (decide)

The pooled report is `ab_report.py p110f-20261022 p110f-20261022-arb --pooled`. Count margins
are doubled, the minimum pairs are 34 and 20, and the room rule is unchanged. There are 42 of
42 pairs (minimum 34) and 25 of 30 G2 pairs (minimum 20).

| check | F | control | limit | verdict | room |
|---|---|---|---|---|---|
| G1 cells passed | 42 | 42 | ≥ 40 | pass | 2 |
| G1 worst task | 6 vs 6 everywhere | | fails at −4 | pass | 3 |
| G2a recall-sourced correct answers | 25 | 25 | ≥ 23 | pass | 2 |
| G2b recall-tool errors, all turns | 4 | 4 | ≤ 8 | pass | 4 |
| G2c formatVersion rejections | 0 | 0 | ≤ 4 | pass | 4 |
| G2c every F rejection recovered | none to recover | | equality | pass | – |
| G2d decoy, stale, hedged, wrong, CANNOT-RECOVER | 0 | 0 | ≤ 2 | pass | 2 |
| **G3 same-turn re-reads, success-only mutations** | **59** | **41** | **≤ 1.25·41 + 4 = 55.25** | **fail** | **−3.75** |
| G4 median paired cost ratio | 1.0174 | | ≤ 1.10 | pass | 1.65 |
| G4 Σcost ratio ($0.6792 vs $0.6768 off-peak) | 1.0036 | | ≤ 1.10 | pass | 1.93 |
| **G4 median paired Δrequests** | **+0.5** | | **≤ +1** | **pass with less than 1 unit of room** | **0.5** |
| G4 recall_turn "full" views | 4 | 2 | ≤ 6 | pass | 2 |
| G5 text closeouts | 167 | 164 | ≥ 162 | pass | 5 |
| G5 step-cap cuts | 19 | 22 | ≤ 24 | pass | 5 |
| G6 first-try success, cross-turn `expand_result` | 31/34 = 0.912 | 45/49 = 0.918 | ≥ 0.818 | pass | 3 |
| G6 extra hops | 5 | 4 | ≤ 8 | pass | 3 |

- **G3 in detail.** 54 of F's 59 re-reads and 40 of control's 41 came after the model's own
  successful edit in the same turn; the rest were unchanged-file re-reads (5 vs 1). By task,
  control vs F: c1 22 vs 34, c2 3 vs 2, r1 4 vs 4, r2 5 vs 6, r3 4 vs 8, r4 2 vs 2 and r5 1 vs 3.
  Over the 42 pairs, F re-read more in 14, less in 10 and the same in 18. The secondary
  every-mutation count (§6), reported and not gated, is 72 vs 43.
- **G4 requests.** F sent 1,144 requests against control's 1,149. The 42 sorted paired deltas
  have 0 and +1 in 21st and 22nd place, so the median is +0.5: 17 deltas are negative, 4 are
  zero, and 13 are above +1. The batch alone had +1 and the arbitration alone 0.
- **Also measured, not gated.** Over both batches F used 740,119 miss, 15,238,656 hit and 620,799
  output tokens, against 776,328, 15,188,864 and 605,544 for control. Turn-first-step miss was
  168,300 vs 165,863. Same-file re-reads in a later turn were 93 vs 96, and fold-then-reread 4
  vs 1.
- **Cache cross-check.** dsh-slice `cache-metrics.py` gives the same values as `ab_metrics` in
  all 84 cells for session miss, hit, output, requests, turn-first-step miss, per-turn step-1
  cacheRead and `expand_result` count.

### 14.4 Decision (§9, by the pre-registered rule)

**Do not ship F.** §9 ships F only if every pooled check passes with at least one unit of room.
Two checks do not:

- **G3 fails** by 3.75 units: 59 against a limit of 55.25. Under §9, a failed check means do not
  ship.
- **G4.requests passes with 0.5 units of room**, less than the one unit §9 requires. There is no
  second arbitration, so this alone also means do not ship.

The rule was applied as frozen: the instrument at `619703e`/`8491106`, the success-only G3 of
§6, the pooled minimums and margins of §9, and the median of `ab_report.py`. No ship branch was
prepared. F stays on `exp/p110-f-arm` (`f819bb3`, one commit on `70e6e55`) and on
`exp/p110-ab-arm2` (`147d2d4`). main keeps the long tool-line locator.

### 14.5 Independent verification: discrepancies and resolutions

1. **Which `expand_result` calls are G6 targets** (verifier A).
   - *The issue.* In batch `r5.r1.F`, turn 2, the model called `expand_result` with seq 22. It
     took that number from the tape's reply marker `slice-turn-1-step-2-seq-22`. The tool
     rejected the call: seq 22 is an assistant message, not a tool result. The harness leaves
     the call out of the cross-turn targets, because no tool result in an earlier turn has that
     seq.
   - *Effect.* Counting it as a failed first try gives F 18/20 = 0.900 in the batch (room 1, not
     2) and 31/35 = 0.886 pooled (room 2, not 3). The verdict is unchanged.
   - *Resolution.* The frozen definition decides: a target is a tool result in an earlier turn.
     The call does count in G2b (an error on a recall tool) and in G6 extra hops: the model then
     called `recall_turn` to find seq 18, which the tape already carried.
2. **One G2 exclusion rests on a flag false positive** (both verifiers). Batch `r2.r1.control`
   is excluded because the literal string `/very/long/path/to/file.py` inside a Python heredoc
   or `-c` string was read as an outside path. Nothing outside the workdir was accessed.
   Reversing that exclusion gives 13 batch G2 pairs and 26 pooled ones. Every G2 verdict and
   room is unchanged. The frozen flagger decides.
3. **The r2 searches were wider than the batch report said** (verifier B). The report said
   "`find`/`ls ..` reaching the cell root or scratchpad". In fact:
   - batch `r2.r2.F` ran `find` over the whole session scratchpad;
   - batch `r2.r2.control` ran `find` over the parent directory of every session of this project
     under `/private/tmp/claude-501`;
   - arbitration `r2.r2.control` ran `find /`. It went to the background after 60 s, and the
     model killed it without reading its output.

   All three searched by file name, for the sources deleted after T4, and found nothing. All
   three pairs are excluded from G2 as §7 requires.
4. **The leak exclusion of batch `r5.r3.control`** (verifier B). The leaked function id appears in
   the model's own fix script, a bash Python heredoc that edits `textkit/dates.py`. The leak
   exemption covers only `write` and `edit` calls on `textkit/`, so the frozen rule excludes the
   pair. The exam answer came from recall.
5. **Pass verdicts.** Verifier A took `verify.py`'s pass and exam class as given and checked the
   60 recall answer files against the oracle without running any code: 60 of 60 agree. Verifier
   B re-ran the c1 and c2 oracles on fresh extractions of the packed workdirs (24 of 24 pass) and
   checked the 60 recall answers itself (60 of 60 correct). In every recall exam, the first
   exam-turn result carrying an oracle token came from a recall tool.
6. **G3 depends on how bash reads are classified** (verifier A). Its extractor reproduces the
   harness exactly under the frozen narrow reading (§14.6 gives the others). Both readings it
   tried change the G3 verdict. Neither changes the decision, because G4.requests has 0.5 units
   of room under all of them.
7. **The even-n median** (verifier A). With 42 pairs the median is the mean of the 21st and 22nd
   deltas, +0.5. A lower-median convention would give 0 and one unit of room. `ab_report.py`
   used the usual median, frozen with the harness, so this is a note on convention, not an
   error.
8. **No other differences.** Both verifiers' per-cell values equal the harness's in all 84 cells
   for: validity, requests, tokens, off-peak cost, closeouts, step-cap cuts, full views, G3 under
   both mutation readings, recall-tool errors, formatVersion rejections, extra hops,
   recall-sourced exams, leaks and oracle via the file system. The ledger total also agrees.

### 14.6 What the decision depends on (sensitivity, not part of the rule)

| reading | pooled G3 (F vs control, limit) | pooled G4.requests | outcome |
|---|---|---|---|
| as frozen (decides) | 59 vs 41 [≤ 55.25]: **fail**, −3.75 | +0.5, room 0.5 | do not ship |
| every mutation counts (the 2026-09-27 definition, reported) | 72 vs 43 [≤ 57.75]: fail, −14.25 | +0.5 | do not ship |
| every read segment of a compound bash command counts (verifier A) | 108 vs 98 [≤ 126.5]: pass | +0.5 | do not ship (G4.requests) |
| an after-edit re-read counts only if the file was already read earlier in the turn (verifier A) | 46 vs 33 [≤ 45.25]: 0.75 over | +0.5 | do not ship |
| lower median for an even number of pairs | 59 vs 41: fail | 0, room 1 | do not ship (G3) |
| c1 left out (not a rule; descriptive) | 25 vs 19 [≤ 27.75] | – | – |

The decision holds under every single reading here. F would pass every check with at least one
unit of room only under two readings combined: the broad bash-read reading and the lower median.
Neither was pre-registered.

### 14.7 What this shows, and what it does not

- **Correctness at the ceiling.** All 84 cells passed. All 60 recall exams were answered
  correctly from a recall-tool result, excluded cells included. Neither arm had a formatVersion
  rejection, so the version-only locator did not lead the model to send a wrong `formatVersion`.
  Recall-tool errors in the G2 pairs were 4 vs 4. Three of F's were invalid `(?i)` regexes in
  r3, as were all four of control's. The fourth was the reply-marker seq (§14.5, item 1). One
  more F error sits in an excluded r2 pair. G1 and G2 rule out a large regression in
  correctness, not a small one.
- **The re-read excess is concentrated.** c1 gives 34 vs 22. 33 of F's 34 c1 counts and all 22
  of control's are re-reads after a successful edit in the same turn. The transcripts the
  verifiers read show partial-window `read`s of `calc.py`. The six c1 pair deltas are +4, +4, 0,
  −1, −2 and +7, so three pairs carry the excess. Outside c1, F re-read
  less in the batch (8 vs 10) and more in the arbitration (17 vs 9, of which r3 is 6 vs 3).
  Nothing found links F's shorter tool line to the model re-reading its own edit. With n = 6 per
  task the effect is noisy, and the rule does not require a mechanism.
- **The same direction twice.** On 2026-09-27, arm 2 (A + C + F) also re-read more than arm 1
  (A + C): 87 vs 73, and 77 vs 58 success-only. Its request check also sat at the limit (+1).
  This run, against main, repeats both: G3 59 vs 41, and G4.requests +1 in the batch and +0.5
  pooled. Neither run alone is strong evidence of harm, but two independent runs point the same
  way.
- **Cost.** F saves 41.1 characters per tape tool line (52.9 vs 94.0) and leaves the cached prefix
  unchanged. At this n, behaviour noise hides the saving: the summed cost ratio is 1.0036, the
  median paired ratio 1.0174, and F's output tokens are 2.5% higher. G4's cost checks show only
  that behaviour did not raise the cost by 10%.
- **Locators.** First-try success was 0.912 vs 0.918, and extra hops were 5 vs 4. F's one locator
  confusion, taking the reply marker's seq for a tool seq, is the kind of slip a shorter tool
  line could invite, because both lines carry a bare `seq N`. It happened once. The model
  recovered in the same turn and answered correctly.
- **Isolation.** The §3.1 barrier held: no cell read another cell's workdir, home, the vault or the
  other arm's files, and every `/tmp` scratch file a cell used was created earlier in that cell.
  It is still detect-and-flag beyond the A/B root. While both batches ran, the scratchpad of
  this session held other copies of the task definitions and oracles. They were left by
  concurrent work on DSH 0.2.1 support, under `dsh021/…/scripts/ab/tasks/` and a copy of
  `docs/p110-native-ab.md`. The main checkout and other worktrees held copies too. Three r2 cells
  searched those trees by file name and found nothing; a search by content would have found an
  oracle. Those cells were flagged and dropped from G2, so the decision is not affected (§14.8).
- **External validity.** As in §12: a hermetic headless composition, one provider and model, and
  seven synthetic tasks. F's per-entry saving grows with session length, which these tasks do not
  reach; the re-read behaviour at that length was not tested.

### 14.8 G2 exclusions

Five of the 30 recall pairs were dropped from G2: three in the batch and two in the arbitration.
They came from six excluded cells:

| batch | pair | excluded cell(s) | reason |
|---|---|---|---|
| batch | r2 rep 1 | control | flag false positive: `/very/long/path/to/file.py` inside a heredoc (§14.5, item 2) |
| batch | r2 rep 2 | F and control | exam turn: `find` over the session scratchpad (F), and over every session directory of the project (control) |
| batch | r5 rep 3 | control | leak: the function id in the model's own heredoc fix script (§14.5, item 4) |
| arbitration | r2 rep 2 | control | exam turn: `find /`, killed before any output was read |
| arbitration | r5 rep 1 | F | T1: wrote and read `/private/tmp/combined.txt`, its own scratch file outside `TMPDIR` |

No exam answer came through the file system: oracle via the file system is 0 in all 60 recall
cells. The r3 and r4 filler fix worked. No r3 or r4 cell was excluded, and on 2026-09-27 those
fillers had caused several exclusions.

### 14.9 Secrets and held-back data

`run_ab.py secrets-scan` lists two cells, both offline isolation-probe cells of `isoprobe-v2`.
Their probe script names `DSH_HOME` by design (§11). No paid cell is listed, and the summaries
under `docs/ab/` contain no oracle token (21 checked).

Two offline review-probe batches have no cell records, so the scan does not see them:
`review-probe-v2` and `review-2026-10-22/review-probe`. Their escapee job runs
`env -u DSH_HOME -u TMPDIR`, so their tool inputs name `DSH_HOME` too. A plain-text search of
every turn stream under the vault found no other tool input naming `DSH_HOME` or `~/.dsh`.

Following §5 step 8, these files are held back:

- the session logs and turn files of the two flagged `isoprobe-v2` cells;
- the session logs and turn files of both cells of each review-probe batch;
- the review probe's own output files.

They are in the archive's owner-only `held-back/` directory (chmod 700), which `HELD-BACK.md`
lists. None of these cells could reach a model key. They ran on the mock provider, and the
offline and probe commands refuse to start while a template home holds a key link. No key link
and no other symbolic link remains under the A/B root outside the worktrees and the host copy.

### 14.10 For a next native A/B

- Before linking the key, remove every copy of the task oracles reachable from a cell,
  including copies other work leaves in the same scratchpad. Better still, generate oracles at
  setup time only.
- G3: decide in advance whether a partial-window read of a file just edited counts as a re-read,
  how compound bash commands are classified, and which median an even number of pairs uses.
- c1 dominates G3 and has the highest variance. A rerun of F needs either more c1 reps or a
  pre-declared per-task treatment of c1.
- If F is tried again, first find out why after-edit re-reads rise. One step would be a variant
  where the tool line keeps an explicit `expand_result` hint but drops the JSON.
- Stop flagging path-like literals inside heredoc bodies and `-c` strings.
- Tell the model where its `TMPDIR` is. Models wrote scratch into `/private/tmp` directly in
  c1, c2 and r5; the quarantine caught it.

### 14.11 Files

- [summary.md](ab/p110-f-2026-10-22/summary.md) and
  [summary.json](ab/p110-f-2026-10-22/summary.json) hold the harness's three reports: the pooled
  report, which decides, the batch alone and the arbitration batch alone. They also hold the
  cache cross-check and the secrets scan. Paths are normalized, and there are no oracle tokens.
  The reports are the frozen instrument's output and are not edited for §14.5.
- [pairs.json](ab/p110-f-2026-10-22/pairs.json) holds per-pair re-reads (success-only and
  every-mutation), requests and costs, with the paired deltas.
- The owner's experiment archive is `results/20261022-p110-f-ab/` in the dsh-slice workspace. It
  holds the raw cells, turn files, session logs, packed workdirs, ledger, reports and logs, and
  the build-stage dry runs and probes. `verification/` holds both verifiers' scripts and per-cell
  rows. The held-back probe logs are in `held-back/` (chmod 700). The frozen host copy, the
  worktrees and the verifiers' decompressed log copies are left out; `README.md` there lists the
  exclusions.
- Branches, all local and not pushed: `exp/p110-f-harness` (this record), `exp/p110-f-arm`
  (`f819bb3`), and control as the detached worktree at `70e6e55`. `exp/p110-f-harness` branches
  from `70e6e55` and is 11 commits behind origin/main `b985abb`. PR #20 also edited
  `scripts/ab/README.md`, so merging this branch will conflict there.
