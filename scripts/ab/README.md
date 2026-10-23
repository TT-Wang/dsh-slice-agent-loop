# scripts/ab: native A/B harness (P1-10)

Drives the published DSH `headless` app, one process per turn, against packed builds of this
plugin and compares them on pre-registered gates. Four experiments use it:

- the svs2 ablation of 2026-10-24 on DSH 0.2.1-rc.2: three slice variants (A: an edit-guard-aware
  re-read rule, B: A without the slice persona, C: B plus working-set retention) against the
  2026-10-23 SLICE and STOCK cells, imported read-only:
  [docs/svs2-ablation-2026-10-24.md](../../docs/svs2-ablation-2026-10-24.md), gates
  [gates-svs2.json](gates-svs2.json), report [svs2_report.py](svs2_report.py); see
  [svs2 ablation](#svs2-ablation-2026-10-24) at the end of this file;

- the slice-vs-stock evaluation of 2026-10-23 on DSH 0.2.1-rc.2: the plugin from main against the
  host's own composition with its native context management at shipped defaults, plus a configured
  compaction variant: [docs/slice-vs-stock-2026-10-23.md](../../docs/slice-vs-stock-2026-10-23.md),
  gates [gates-svs.json](gates-svs.json), report [svs_report.py](svs_report.py); see
  [Slice vs stock](#slice-vs-stock-2026-10-23) at the end of this file for what it changes here;

- the F-only A/B of 2026-10-22 on DSH 0.2.0-rc.2, control = main `70e6e55` against F (the
  version-only tape tool locator): [docs/p110-f-native-ab.md](../../docs/p110-f-native-ab.md),
  gates [gates-f.json](gates-f.json). This file describes the harness as it is for that run.
- the three-arm A/B of 2026-09-27 on DSH 0.1.7-rc.2: [docs/p110-native-ab.md](../../docs/p110-native-ab.md),
  gates [gates.json](gates.json), harness frozen at `f70d584` (a different layout: concurrent arms,
  one home per arm, no read isolation).

## Files

| file | role |
|---|---|
| `run_ab.py` | driver: `prepare` (one template DSH_HOME per arm), `run` (cells), `isolation-probe`, `unblock`, `fingerprints` (with `--compare`), `secrets-scan` |
| `ab_metrics.py` | one metrics row per `session.v4.jsonl.zstd` (or plain `.jsonl`) |
| `ab_report.py` | pairs cells, evaluates a gates file, writes `summary.json` / `summary.md`, with each check's room |
| `gates-svs2.json`, `svs2_report.py`, `svs2_plan.py`, `svs2_checks.py`, `test_svs2.py` | svs2 ablation: arms, pairing with the imported baseline cells, seed keys, comparisons, interpretation rule, arbitration and cost ladder; the import and the report; the cost model; the same-conditions checks; their tests |
| `gates-svs.json`, `svs_report.py`, `test_svs_report.py` | slice-vs-stock: arm structure, step-cap mode, per-task reps, pre-registered comparisons and decision rules; the report that evaluates them; its tests |
| `step-cap.mjs` | the harness's own per-turn step cap row (slice-vs-stock), copied to `AB/plugins/` and inserted in every arm |
| `profile/eval-neutral.patch.yml`, `profile/stock-compact.patch.yml` | slice-vs-stock: the overlay every arm gets (native context management kept), and the configured compaction variant |
| `gates-f.json` | the F-only A/B: arm structure, G1–G6, minimum pairs, pooled multipliers, the room rule (default of `run_ab.py` and `ab_report.py`) |
| `gates.json` | the 2026-09-27 A/B, frozen |
| `prices.json` | DeepSeek v4-flash sheet, off-peak and peak; the budget uses peak |
| `profile/` | profile template: `package.json`, `pnpm-workspace.yaml`, `cordis.yml`, `eval-parity.patch.yml` (becomes the profile's `cordis.patch.yml`) |
| `mock-llm.mjs`, `eval-offline.patch.yml` | scripted offline adapter (provider `ab-mock`) for dry runs and the isolation probe |
| `tasks/<name>/` | `meta.json`, `prompts.json`, `setup.py`, `verify.py`, optional `hooks.py` |
| `test_ab_metrics.py`, `test_ab_report.py`, `test_run_ab.py` | unit tests (stdlib `unittest`) |
| `selfcheck_tasks.py` | every task's oracle passes on a correct end state and fails otherwise (in a temporary directory it removes afterwards) |

Tasks: `hello` (warmup), `r1`–`r5` (recall), `c1`, `c2` (coding). `--tasks all` means the seven
gated tasks, without `hello`. Since 2026-10-22 the r3 and r4 setups create `lib/slug.py` and
`lib/fmt.py`, the files their filler turns ask to extend.

## Requirements

- System `python3` with `zstandard` (log reading) and `pytest` (task r5).
- A frozen host: `cp -cR ~/.dsh-slicey/host-0.2.0-rc.2 $AB/host` (APFS clone). The harness only ever
  runs `$AB/host/node_modules/@deepseek-ai/dsh/lib/bin.js`, so upgrading slicey mid-batch cannot
  change the host; each batch manifest records a digest of the host tree at its start and end.
- One packed tarball per arm (`npm pack` in a worktree whose `lib/` passed `npm run check:build`).
- The worktrees under `$AB/wt/` (harness, control, F). Their `scripts/` and `docs/` are
  unreadable while a turn runs, so a turn must need nothing from them (the offline adapter is
  copied to `$AB/mock/` for that reason).

## Layout of the A/B root

```
$AB/host/                    frozen host (readable by cells)
$AB/mock/                    copy of mock-llm.mjs + a package.json whose peers admit the host (offline runs)
$AB/patches/<batch>/         steps-<N>.patch.yml, eval-offline.patch.yml (read by the host at startup)
$AB/live/c-<id>/             the one running cell: home/ (copy of its arm's template), tmp/ (its TMPDIR), w-<id>/ (workdir)
$AB/vault/                   mode 000 while a turn runs:
    homes/<arm>/             template DSH_HOMEs (the operator's key link goes here)
    artifacts/               tarballs, their arm-neutral install copies plugin-<sha12>.tgz, SHA256SUMS
    arms.json, dump-<arm>.yml, prepare-<arm>.log, fingerprints.json, spend.jsonl (the paid ledger), logs/
    results/<batch>/         index.jsonl, cells/, turns/, workdirs/<wid>.tgz, homes/c-<id>/, truth/, quarantine/, manifest-*.json
$AB/wt/<name>/{scripts,docs}  mode 000 while a turn runs (the only places in a checkout that hold task oracles)
$AB/progress.txt             one line: cells done and spend (no arm, task or answer)
```

## Isolation

DSH's sandbox (Seatbelt on macOS: `(allow default) (deny file-write*)` plus the writable roots)
confines writes only, and macOS refuses a nested `sandbox-exec` (`sandbox_apply: Operation not
permitted`), so a read-confining wrapper around the host would make its bash tool fail closed.
Every cell runs as the harness's own user, so the harness confines reads with permissions and
removes everything else a cell could read:

- **One cell at a time.** The two cells of a (task, rep) pair run back to back; the first arm
  rotates with `(rep - 1 + seed)`. No other cell's workdir, home or process exists while a turn
  runs. `--parallel-arms` is refused.
- **Blocked while a turn runs.** `$AB/vault` and the `scripts/` and `docs/` directories of every
  worktree under `$AB/wt` are `chmod 000` from just before the host starts until the turn's
  process group and every process still tied to the cell are gone (a background job the model
  started is killed). A process is the cell's when its command line or environment names
  `live/c-<id>` (its `DSH_HOME`, `TMPDIR`, `PWD` or a path argument) or its current directory lies
  in the cell (`lsof -d cwd`), so a job that dropped `DSH_HOME` and `TMPDIR` and left the turn's
  session is found too. The worktree roots stay readable: with a root at mode 000, a
  `git worktree prune` run by any other process in the main repository takes the worktree for
  missing and deletes its link, which happened once during the build. The harness reads the turn's
  stdout for the budget through a file it opened before blocking, and writes nothing into a
  blocked directory meanwhile. Turn stdout, stderr and patches are opened or read by path only
  outside that window, except the stdout the host writes through its inherited descriptor.
- **Read-only while a turn runs.** `$AB` itself, `live/`, `patches/`, `patches/<batch>/`, `mock/`,
  `wt/` and `host/` lose their write bits for the same window, so no file can be added there for a
  later cell; the running cell's own root under `live/` stays writable. Contents below the first
  level of `host/` and the worktrees' source trees are not covered by this; the host digest and the
  worktree check below are.
- **Tamper evidence.** The owner can chmod its own files, and the workspace-write sandbox allows
  writes under `/tmp`, where the A/B root lives. After each turn the harness checks that every
  blocked or read-only path still has its mode and the inode and ctime it had right after
  blocking; a chmod, chflags, rename, replacement or new entry is a breach, and the cell is invalid
  (`isolation breached …`). Between a cell's first and last turn, `git status` (untracked and
  ignored entries included, bytecode excluded) of every worktree under `$AB/wt` must not change,
  or the cell is invalid (`isolation: worktree … changed`).
- **Per cell.** A fresh copy of the arm's template home (arm-neutral name `live/c-<id>/home`,
  installed from `plugin-<sha12>.tgz`, so neither `DSH_HOME` nor the profile's `package.json`
  names the arm), a private `TMPDIR`, and the r5 truth sidecar moved into the vault before the
  first turn and back only for `verify()`. When the cell ends, its workdir, truth sidecar and tmp
  are packed into `vault/results/<batch>/workdirs/<wid>.tgz`, the home (session log included,
  key link removed) moves to `vault/results/<batch>/homes/`, and the cell root is removed.
- **Quarantine.** New top-level entries of `$AB` that the harness did not create, and new
  top-level entries of `$AB/..` and `/private/tmp` that the cell's own tool calls name (as a path,
  or for a name of 6 or more characters as a bare word, as after `cd /tmp && mkdir x`), are moved
  into `vault/results/<batch>/quarantine/<cell>/` when the cell ends, so scratch files a model
  wrote outside its root cannot reach a later cell.
- **Not covered.** Copies of this repository elsewhere on disk (the main checkout, other
  worktrees) hold the task definitions and oracles and stay readable; so do the owner's archives.
  Any access outside the workdir is flagged by path and the oracle's arrival by content (`ab_metrics`),
  as before. The cell's own session log in its home is readable too (the host writes it);
  reading it is flagged (`sessions/`, `.zstd`) and caught by content. A file written into a
  directory that already existed elsewhere under `/tmp` (for example a sibling of `$AB`) survives
  the cell, and a background process that strips its environment and also leaves the cell's
  directory is not found; both need a tool call naming a path outside the workdir, which is flagged.

`run_ab.py isolation-probe` proves the barrier on a dry run: it plants canaries in the other arm's
template home, the A/B state, a manifest, a truth file and the worktrees' `scripts/` and `docs/`, adds the other arm's real
finished session log, packed workdir, manifest, index, ledger and a task oracle, and runs one
scripted cell per arm that reads them with bash, `read`, `glob` and `grep`, lists `$AB/live` and
reads its own files, after starting three background jobs (one in its own session, one also
without `DSH_HOME` and `TMPDIR`), trying to write a file into each read-only directory, and
planting a directory in `/tmp` after a `cd`. It then runs one tamper cell per arm that chmods the
vault open and back and leaves a file in a worktree's `src/`. Exit 0 only if every protected read
was denied, no canary reached a tool result, the cell's own files were readable, `$AB/live` held
only that cell, no process tied to the cell outlived the turn, every write was refused, the `/tmp`
plant was quarantined, and every tamper made its cell invalid (both the chmod and the worktree
file). The report is `vault/results/<batch>/probe.json`.

After a crash while a turn ran, `run_ab.py unblock --ab-root $AB` restores the modes recorded in
`$AB/.blocked.json`; `run` refuses to start while that file exists.

## Host version

The F-only A/B runs on a frozen published 0.2.0-rc.2 host; the 2026-09-27 batch ran on 0.1.7-rc.2.
On 0.2.0-rc.2, verified with `--dump-config` (417 lines, identical across arms) and offline runs:
the parity overlay applies as is, 16 tools remain, a turn cut by `maxStepsPerTurn` ends with
`turn_end` kind `blocked` and exit 1, and bash reports a non-zero exit as a trailing
`[exit code: N]` marker with `isError` false (write/edit rejections are `isError` true). On any
other host:

- The root `package.json` of the checkout the harness runs from must admit that host in its
  `@deepseek-ai/dsh-*` peer ranges, even for an offline dry run. `run_ab.py` copies the
  scripted adapter to `$AB/mock/` next to a `package.json` that carries those peers, and the
  host attributes the offline adapter's path row to that manifest, not to the arm's tarball.
  If those peers reject the host, the turn's `.err` file says
  `dsh: disabling profile plugin row "ab-mock-llm"`, every turn ends with `NO_ADAPTER`, and the
  driver retries it as an infra failure. With the range `0.1.7-rc.2 || 0.2.0-rc.2` a dry run
  from this checkout (`prepare`, then `hello` and `r1`) completed on both of those published
  hosts with empty turn stderr (2026-10-13). With the range `0.2.0-rc.2 || 0.2.1-rc.2` a dry
  run (`prepare`, then `hello`, control arm of plugin 0.3.0) completed and was valid on
  0.2.0-rc.2 and 0.2.1-rc.2, again with empty turn stderr (2026-10-22). A 0.1.7-rc.2 host is
  no longer admitted from this checkout.
- 0.2.1 adds a `working_directory` tool to dsh-base. `profile/eval-parity.patch.yml` disables
  its row (`tool-working-directory`) so every arm keeps the 16 tools the checks expect;
  without that row a 0.2.1 cell is invalid with `tools_count 17 != 16`. On 0.2.0-rc.2 the row
  does not exist, and `--dump-config` prints one `patch: entry "tool-working-directory" not
  found` line.
- Regenerate `fingerprints.json` on that host and run its own control arm. The request prefix
  of the same build is 249 characters longer on 0.2.0-rc.2 than on 0.1.7-rc.2 (18311 to
  18560, from the host's `bash` tool description; system prompt and slice tool hashes are
  equal). Against the stored 0.1.7-rc.2 control figure the recorded arms would sit 524
  characters under control and fail the 700-character structural check. For plugin 0.3.0 the
  prefix is 17787 characters on 0.2.0-rc.2 and 17974 on 0.2.1-rc.2 (the host's `bash`, `edit`
  and `write` descriptions, +187), and the system prompt (3651 characters) and slice tool
  schemas hash the same on both. Do not compare cost or cache numbers across hosts.
- A session that a 0.2.1 host ran a `bash` call in cannot be reopened by 0.2.0-rc.2 (it now
  logs `job/registered`); keep each batch on one host.

## Runbook (F-only A/B)

```sh
AB=/path/to/scratch/fab                # everything below lives here, never in the repo
H=$AB/wt/harness/scripts/ab            # this directory, in the exp/p110-f-harness worktree
cd $AB                                 # not inside $AB/wt: it is unreadable while a turn runs

python3 $H/run_ab.py prepare --ab-root $AB \
  --arm control=$AB/vault/artifacts/slice-control-70e6e55.tgz --arm F=$AB/vault/artifacts/slice-F-f819bb3.tgz
#   exit 0 only if dump-config is identical across arms (the arm's own home path is normalized)

python3 $H/run_ab.py --ab-root $AB --offline --arms control,F \
  --tasks hello,r1,r2,r3,r4,r5,c1,c2 --reps 1 --batch offline --fingerprints none
python3 $H/run_ab.py fingerprints --batch-dir $AB/vault/results/offline --out $AB/vault/fingerprints.json
python3 $H/run_ab.py --ab-root $AB --offline --arms control,F \
  --tasks hello,r1,r2,r3,r4,r5,c1,c2 --reps 1 --batch offline2       # validated against the fingerprints
python3 $H/run_ab.py isolation-probe --ab-root $AB --arms control,F --target-batch offline

# operator only, after the dry run: ln -s ~/.dsh/.env $AB/vault/homes/<arm>/.env  (never cat or copy it)

python3 $H/run_ab.py --ab-root $AB --arms control,F --tasks hello --reps 2 --budget-usd 10 \
  --fingerprints none --batch warm
python3 $H/run_ab.py fingerprints --batch-dir $AB/vault/results/warm --compare $AB/vault/fingerprints.json
python3 $H/run_ab.py --ab-root $AB --arms control --tasks r1,r2,r3,r4,r5 --reps 1 --budget-usd 10 --batch pilot
python3 $H/run_ab.py --ab-root $AB --arms control,F --tasks all --reps 3 --seed 20261022 \
  --budget-usd 10 --batch p110f-<yyyymmdd>                         # add --resume to continue
python3 $H/ab_report.py $AB/vault/results/p110f-<yyyymmdd> \
  --fingerprints $AB/vault/fingerprints.json --ledger $AB/vault/spend.jsonl
# only if the report says "arbitration": the single arbitration batch, then the pooled decision
python3 $H/run_ab.py --ab-root $AB --arms control,F --tasks all --reps 3 --seed 20261023 \
  --budget-usd 10 --batch p110f-<yyyymmdd>-arb
python3 $H/ab_report.py $AB/vault/results/p110f-<yyyymmdd> $AB/vault/results/p110f-<yyyymmdd>-arb --pooled \
  --fingerprints $AB/vault/fingerprints.json --ledger $AB/vault/spend.jsonl --out $AB/vault/results/pooled
python3 $H/run_ab.py secrets-scan --ab-root $AB     # before archiving: exit 1 lists cells to hold back
```

Long batches: start them with `nohup … > $AB/vault/logs/<batch>.log 2>&1 &` and poll
`$AB/progress.txt` (the vault and the log in it are unreadable while a turn runs, for you too);
never pipe the headless `--json` stream into `head` (the EPIPE kills the turn), the driver always
writes it to a file.

## What one cell does

1. Any leftover under `$AB/live` (a crashed run) is moved into the vault. A fresh cell root
   `$AB/live/c-<id>/` with a copy of the arm's template home, `tmp/` and the workdir `w-<id>/`
   (ids are hashes of batch, task, rep, arm and attempt; their names do not reveal the arm);
   `setup(workdir)`; r5's `<workdir>.truth.json` moves into `vault/results/<batch>/truth/`.
   Attempt numbers continue after every attempt already in `index.jsonl`, so a rerun never reuses
   a workdir, turn file or ledger key.
2. Per prompt: block; `node bin.js --profile ab --patch $AB/patches/<batch>/steps-<N>.patch.yml
   [--patch …/eval-offline.patch.yml] [--session-id SID] --json -` with the prompt on stdin,
   cwd = workdir, `TMPDIR` = the cell's tmp, stdout and stderr to
   `vault/results/<batch>/turns/<cell>.a<k>.t<n>.{jsonl,err}`; after the process exits, kill the
   turn's process group and every process tied to the cell, check for tampering,
   unblock; then `hooks.after_turn(n, workdir)`.
3. `verify(workdir)` (with the truth sidecar back in place) returns `(ok, detail[, info])`; the log
   is `home/sessions/*/<SID>/session.v4.jsonl.zstd`; `ab_metrics` adds the metrics row.
4. Validity (see the doc): turn exits, log found, fingerprints, 16 tools, one turn per prompt, no
   host path in the system prompt, no compaction, tape header / tool-line form of the arm,
   structural checks (F: the request prefix equal to control's; headers 76/78 chars), no isolation
   breach, no worktree change, the r3 fold, and for r1, r2 and r4 the delivery of the exam's fact in a non-recall tool
   result of its delivery turn (meta `delivery`). An invalid cell is rerun once (`--max-attempts 2`).
5. Whatever the outcome (done, invalid, timeout, budget stop), the workdir with its truth sidecar
   and tmp is packed into `workdirs/<wid>.tgz`, the home moves into `homes/`, the cell root is
   removed, new outside entries are quarantined, and the turn stdout files are gzipped.
   `cells/*.json` never holds the oracle tokens.

A turn cut by `maxStepsPerTurn` ends with `turn_end` kind `blocked` and exit 1 (both hosts); it is
model-attributable, so the cell continues, and so do `max-tokens` and errors with a non-infra code
(CONTEXT_WINDOW_EXCEEDED, INVALID_REQUEST, UNKNOWN, …). Infra is only a provider, network,
credential or quota error code (TRANSPORT, RATE_LIMIT, SERVER, HTTP 5xx, TIMEOUT, EMPTY_RESPONSE,
MISSING_CREDENTIAL, INVALID_CREDENTIAL, AUTH, QUOTA, ACCOUNT_QUOTA, NO_ADAPTER, ABORTED), a missing
`turn_end`, the harness timeout or a budget kill.

## Budget

Each turn is priced at the peak sheet and appended to `$AB/vault/spend.jsonl`; offline runs use
`<batch>/spend.jsonl`. The charge is the larger of the `--json` stdout figure (`step_end` usage,
plus `--unpriced-step-usd` 0.05 for each `step_end` without usage and each step still open when the
process ended) and the session-log figure (every `assistant/message` and `assistant/attempt` of the
turn, plus 0.05 per record without a usage sample). The projector drops a whole step's usage when
any attempt of it had no sample, typically a transport or 429 retry, so the stdout alone would
price that step at $0. The ledger spans every batch under `$AB`, so one `--budget-usd 10` covers
warmup, pilot, batch and arbitration. No cell starts once spend + `--budget-reserve-usd` (0.75)
reaches the cap. The running turn is polled every second (`--poll-s`) and killed, and no further
turn starts, once spend + `--budget-margin-usd` (0.60) reaches it; one turn runs at a time, so the
margin covers 2 x 1 x $0.10 three times over. More than `--max-unpriced-steps` (40) unpriced
charges also stop the run. A budget-stopped cell is kept as `cells/<cell>.budget_stop.json`, not
counted, and rerun by `--resume`; the batch exits 2. `AB_MOCK_FAIL_EVERY=N` (and
`AB_MOCK_FAIL_USAGE=1`) make the mock fail every Nth request with a retryable TRANSPORT error,
without (with) a usage sample, to exercise this offline.

## Secrets

The key is never read by this code. It reaches a run only through a symlink
`$AB/vault/homes/<arm>/.env -> ~/.dsh/.env` that the operator creates after the dry run; each cell
home gets a link with the same text (`os.readlink`, never the target), removed before the home
moves into the vault. `prepare` never creates it and refuses to rebuild a home that has one;
`--offline` and `isolation-probe` refuse to run when any template home has one and strip
`*API_KEY*` / `*DEEPSEEK*` variables from the child environment. The child environment otherwise
mirrors `~/.dsh-slicey/bin/slicey-dsh`: the inherited proxy variables plus `NODE_USE_ENV_PROXY=1`
and `NODE_OPTIONS=--disable-warning=UNDICI-EHPA`, and `DSH_TELEMETRY_DISABLED=1` as the owner's
login shell sets it; every other inherited `DSH_*` variable is removed. The manifest records
variable names, never values. `kill_strays` matches the cell's `live/c-<id>` in `ps -E` output
and in `lsof -d cwd` output and keeps only pids.

The bash tool exports `DSH_HOME`, so a model could read `$DSH_HOME/.env` of its own cell home.
`ab_metrics` flags any tool call naming `.env` (not a `*.env` glob or an attribute access), `DSH_HOME`
or `~/.dsh` as a secret reference; `run_ab.py secrets-scan` lists those cells, whose logs and turn
files are held back from any archive until the owner has looked. Nothing here reads the key or
searches for it.

## Tests

```sh
python3 scripts/ab/test_ab_metrics.py        # synthetic events
AB_OFFLINE_BATCH=$AB/vault/results/offline AB_RAFT_LOGS=<raft-1.jsonl>:<raft-2.jsonl> \
  python3 scripts/ab/test_ab_metrics.py      # plus the mock logs and two real V4 sessions
python3 scripts/ab/test_ab_report.py
python3 scripts/ab/test_run_ab.py
python3 scripts/ab/selfcheck_tasks.py         # temporary directory, removed afterwards (--keep to inspect)
```

The per-turn cache split can be cross-checked with
`python3 ~/Documents/kimi/workspace/dsh-slice/scripts/cache-metrics.py <session.v4.jsonl.zstd>`.

## Slice vs stock (2026-10-23)

The evaluation of [docs/slice-vs-stock-2026-10-23.md](../../docs/slice-vs-stock-2026-10-23.md) compares the
plugin from main with the host's own context management, on DSH 0.2.1-rc.2, with the gates file
[gates-svs.json](gates-svs.json) and the report [svs_report.py](svs_report.py). What it changes in this harness:

- **Per-arm compositions.** `prepare --arm stock=none --arm slice=<tgz> --arm stock-compact=none
  --overlay profile/eval-neutral.patch.yml --arm-overlay stock-compact=profile/stock-compact.patch.yml
  --gates gates-svs.json`. The profile lists the host bundles only; `dsh plugin add` appends the plugin's
  bundle for an arm with a tarball. Every arm gets the same neutral overlay, which keeps compaction, the
  tool-result pruner and spill at their shipped settings (unlike `eval-parity.patch.yml`). `prepare` compares
  `--dump-config` row by row against the baseline arm and exits 0 only if each arm differs in exactly the rows
  its `structure[arm].dump_rows` declares (`vault/dump-compare.json`).
- **Harness step cap.** With `"step_cap": "harness"` in the gates file the per-task cap is a harness row,
  [step-cap.mjs](step-cap.mjs), copied to `AB/plugins/` and inserted in every arm by the steps patch; the slice
  plugin's own cap stays at its default (none), because the stock arms have no slice row and the host has no
  step limit. A cut turn still ends `blocked` with exit 1.
- **Per-arm validity** from the gates file's `structure`: tool count (stock 12, slice 16), slice's tools equal
  stock's plus the four recall tools (`tool_names_plus`), no tape entry in an arm without the plugin
  (`"header": null`), compaction allowed and recorded (`"compaction": "allowed"`), and r3's fold requirement only
  where `"fold": true` (gates-svs.json: false in every arm since 2026-10-23; r3's validity there is its T1 delivery,
  the same in every arm, and the fold is reported).
- **Seeded tasks.** A task with `"seeded": true` gets `AB_TASK_SEED` at setup, derived from a salt in
  `vault/task-seed-salt` plus (batch, task, rep), so every arm of a group sees identical content and no oracle value
  exists outside the workdir and the vault. With `"truth_specs": true` its exam and delivery token specs come from
  the truth sidecar it writes (`<workdir>.truth.json`). Task f1 (`svs_f1_flood_recall`, 45 turns since the pilot resize; 61 in the build stage) is the first.
- **Metrics.** `ab_metrics` adds the compaction summarizer's own calls (their usage sits on `compaction/summary`,
  not on an `assistant/message`) to the billed tokens, the cost and the budget's log figure (a failed compaction
  attempt is an unpriced record); a `compaction` section (summaries, failed attempts, prunes and pruned results,
  their turns, shadowed tokens, context-limit errors, native spills, slice folds apart from prune replacements);
  a `context` section (peak, mean, first and last-turn peak request size in provider tokens); the cache hit rate;
  per-turn peak request size; and, per exam, whether history was compacted or pruned before the exam turn.
- **Offline adapter.** The mock declares deepseek-flash's capacity (window 1,000,000, maxTokens 256,000), answers
  the summarizer's `purpose: 'compaction'` request with a short text, and with `AB_MOCK_PRESSURE_TOKENS=N` reports N
  input tokens on every usage sample, which the token meter reuses as pressure: the forced-compaction dry runs. With
  `AB_MOCK_QUOTA_FILE=<path>` every request ends in a `QUOTA` error while that file exists (the account stop below).
- **Sibling blocking.** `--block-siblings` blocks every entry next to the A/B root in its parent directory (the
  session scratchpad), symlinks excepted, while a turn runs; the list is in the manifest
  (`isolation.siblings_blocked`). A paid run refuses to start without it; a parent that is a shared temp root or a
  home directory is refused.
- **Reported only.** Per exam `partial_leak_assistant_turns` (an exam spec's `partial_leak` fragments in assistant
  text before the exam; f1 sets them in its truth sidecar); in `svs_report.py` recall sourcing, partial leaks, r3's T1
  fold, f1's missing digest tokens, cells whose cost is a lower bound (a failed compaction attempt), and N split into
  N_recall and N_coding.
- **Account stop.** An infra turn with an account-level code (`QUOTA`, which is how DeepSeek's HTTP 402 "Insufficient
  Balance" arrives, `ACCOUNT_QUOTA`, `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, `AUTH`) ends its cell as `account_stop`:
  not retried, not counted against `--max-attempts`, kept as `cells/<cell>.account_stop.json`, and the run stops with
  exit 2; `--resume` reruns the cell once the account is fixed. Before this (the pilot of 2026-10-23) such cells were
  retried, recorded `invalid` and skipped by `--resume`; rerun those without `--resume`.

Runbook (offline part; the paid part is in the record, §5):

```sh
AB=/path/to/scratch/svs; H=$AB/wt/harness/scripts/ab; G=$H/gates-svs.json
cd $AB
python3 $H/run_ab.py prepare --ab-root $AB --arm stock=none --arm slice=$AB/vault/artifacts/slice-main-<sha>.tgz \
  --arm stock-compact=none --overlay $H/profile/eval-neutral.patch.yml \
  --arm-overlay stock-compact=$H/profile/stock-compact.patch.yml --gates $G
python3 $H/run_ab.py --ab-root $AB --offline --gates $G --arms stock,slice,stock-compact \
  --tasks hello,f1,r1,r2,r3,r4,r5,c1,c2 --reps 1 --batch offline --fingerprints none --seed 20261023
python3 $H/run_ab.py fingerprints --batch-dir $AB/vault/results/offline --baseline stock --out $AB/vault/fingerprints.json
AB_MOCK_PRESSURE_TOKENS=690000 python3 $H/run_ab.py --ab-root $AB --offline --gates $G --arms stock --tasks f1 \
  --reps 1 --batch force-above --budget-usd 100000                  # above the shipped 678,464 trigger
AB_MOCK_PRESSURE_TOKENS=670000 python3 $H/run_ab.py --ab-root $AB --offline --gates $G --arms stock --tasks f1 \
  --reps 1 --batch force-below --budget-usd 100000                  # below it: no compaction, no prune
python3 $H/run_ab.py isolation-probe --ab-root $AB --gates $G --arms stock,slice,stock-compact --target-batch offline
python3 $H/svs_report.py $AB/vault/results/offline --gates $G --out $AB/vault/results/offline
```

Tests: `python3 scripts/ab/test_svs_report.py` (decision rules on synthetic cells), and the `SliceVsStock` and
`NativeContextManagement` classes in `test_run_ab.py` and `test_ab_metrics.py`.

## svs2 ablation (2026-10-24)

The ablation of [docs/svs2-ablation-2026-10-24.md](../../docs/svs2-ablation-2026-10-24.md) runs three new slice arms
(A: the re-read rule replaced by an edit-guard-aware rule; B: A without the slice persona; C: B plus working-set
retention) on c1, c2, r2 and f1 and compares them with the SLICE and STOCK cells of 2026-10-23, which are imported
read-only and never re-run. Gates [gates-svs2.json](gates-svs2.json), report [svs2_report.py](svs2_report.py), cost
model [svs2_plan.py](svs2_plan.py), checks [svs2_checks.py](svs2_checks.py), tests [test_svs2.py](test_svs2.py).
What it changes in this harness:

- **Baseline import.** `svs2_report.py import-baseline --out $AB/vault/baseline` reads the cells that gates
  `pairing.baseline_cells` names from the archive, recomputes each metrics row from the archived session log with
  this `ab_metrics.py` (f1's exam specs from the truth sidecar inside the packed workdir, read in memory), refuses if
  any stored metric or memory-exclusion flag is not reproduced, and writes the cells under their svs2 rep index.
- **Pairing and seeds.** A new cell pairs with the baseline cell of the same task and rep index; the arm side of a
  pair is the mean of the arm's valid cells there. A seeded task takes its seed key from the paired baseline cell
  (gates `pairing.seed_keys`), so with the baseline's salt (`vault/task-seed-salt`, sha256 in gates
  `pairing.salt_sha256`; a paid run refuses any other) f1's content is byte-identical to its partner's
  (`svs2_checks.py f1-content`).
- **Order.** Gates `order.rotate: "task_rep"` turns the first arm with the task's index too, so A, B and C each go
  first once in every three reps of a task and across any three tasks of a rep.
- **Guards.** A paid run may use only gates `run_arms_only` (a, b, c). `--structure-as ARM=OTHER` (offline only)
  validates a stand-in arm against another arm's structure, so the harness can be dry-run before the arms are packed.
- **Validity.** Gates structure `tool_names` (the exact 16 names) and system-prompt markers: `system_contains` and
  `system_lacks` strings that the row's `validity.system_markers` must show present or absent (A keeps the slice
  persona and drops "A recorded file read is not a current file"; B and C drop both).
- **Metrics.** `rereads`: every read classified as first, cross_turn (the first read in a turn of a file seen in an
  earlier turn), same_turn or after_own_edit, plus edits/writes, bash writes and the host's FS_NOT_OBSERVED /
  FS_STALE_VERSION refusals (the definitions of the c1 follow-up analysis; on the baseline's c1 logs: cross-turn 27
  vs 59, after own edit 9 vs 28, edits/writes 84 vs 168); `tape.kept_raw_entries` for C.
- **Layout.** The A/B root may hold its worktrees at its top level (`AB/wt-<name>`): every top-level git checkout is
  treated like `AB/wt/<name>` (blocked `scripts/` and `docs/`, `git status` checked), and with `--block-siblings`
  every other top-level entry that is not the harness's own is blocked too (manifest `isolation.ab_extras_blocked`).
- **Host.** `run_ab.py host-digest HOST…` prints the tree digest the manifests record and an mtime-free content
  digest; `--host-content-digest` records the latter in the manifest. `svs2_checks.py host` compares both with the
  baseline's. A fresh npm install of 0.2.1-rc.2 resolves newer transitive packages; the svs2 host is a clone of the
  baseline's frozen host (`cp -cRp`).
- **Same conditions.** `svs2_checks.py conditions`: the five task directories, the price sheet, the step-cap row, the
  overlays, the profile template and the offline adapter byte-identical to tree `b111e434`, and the step-cap patch
  equal to the baseline's patch files.
- **Cost ladder.** `svs2_plan.py --baseline $AB/vault/baseline [--batch …] [--ledger …]` prices the stages (warm,
  S1–S5) from priors, then from measured means, and says which stage is affordable; `--arbitrate a:c1,c2` prices an
  arbitration.

Runbook (offline part; the paid part is in the record, §4):

```sh
AB=$SCRATCHPAD/svs2; H=$AB/wt-harness/scripts/ab; G=$H/gates-svs2.json; cd $AB
python3 $H/svs2_checks.py host --host $AB/host
python3 $H/svs2_checks.py conditions
python3 $H/run_ab.py prepare --ab-root $AB --arm stock=none --arm a=<a.tgz> --arm b=<b.tgz> --arm c=<c.tgz> \
  --overlay $H/profile/eval-neutral.patch.yml --gates $G
python3 $H/run_ab.py --ab-root $AB --offline --gates $G --arms a,b,c --tasks hello --reps 1 --batch offline-fp --fingerprints none
python3 $H/run_ab.py fingerprints --batch-dir $AB/vault/results/offline-fp --out $AB/vault/fingerprints.json
python3 $H/run_ab.py --ab-root $AB --offline --gates $G --arms a,b,c --tasks c1,c2,r2,f1 --reps 4 --reps-from-gates --batch offline
python3 $H/run_ab.py isolation-probe --ab-root $AB --gates $G --arms a,b,c --target-batch offline
python3 $H/svs2_report.py import-baseline --out $AB/vault/baseline
python3 $H/svs2_report.py report $AB/vault/results/offline --baseline $AB/vault/baseline --out $AB/vault/results/offline
python3 $H/svs2_plan.py --baseline $AB/vault/baseline
```

Tests: `python3 scripts/ab/test_svs2.py`, and `AB_OFFLINE_BATCH=<dry batch> AB_GATES=scripts/ab/gates-svs2.json
python3 scripts/ab/test_ab_metrics.py` for the mock logs.
