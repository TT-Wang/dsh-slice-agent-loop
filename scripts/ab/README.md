# scripts/ab: native A/B harness (P1-10)

Drives the published DSH 0.1.7-rc.2 `headless` app, one process per turn, against several
packed builds of this plugin and compares them on pre-registered gates. The experiment it was
built for, with hypothesis, arms, tasks, metrics and gates, is
[docs/p110-native-ab.md](../../docs/p110-native-ab.md). This file says how to run it.

## Files

| file | role |
|---|---|
| `run_ab.py` | driver: `prepare` (one DSH_HOME per arm), `run` (cells), `fingerprints` (with `--compare`), `secrets-scan` |
| `ab_metrics.py` | one metrics row per `session.v4.jsonl.zstd` (or plain `.jsonl`) |
| `ab_report.py` | pairs cells, evaluates `gates.json`, writes `summary.json` / `summary.md` |
| `gates.json` | G1–G6 as data; the doc is the normative text |
| `prices.json` | DeepSeek v4-flash sheet, off-peak and peak; the budget uses peak |
| `profile/` | profile template: `package.json`, `pnpm-workspace.yaml`, `cordis.yml`, `eval-parity.patch.yml` (becomes the profile's `cordis.patch.yml`) |
| `mock-llm.mjs`, `eval-offline.patch.yml` | scripted offline adapter (provider `ab-mock`) for dry runs |
| `tasks/<name>/` | `meta.json`, `prompts.json`, `setup.py`, `verify.py`, optional `hooks.py` |
| `test_ab_metrics.py`, `test_ab_report.py`, `test_run_ab.py` | unit tests (stdlib `unittest`) |
| `selfcheck_tasks.py` | every task's oracle passes on a correct end state and fails otherwise (in a temporary directory it removes afterwards) |

Tasks: `hello` (warmup), `r1`–`r5` (recall), `c1`, `c2` (coding). `--tasks all` means the seven
gated tasks, without `hello`.

## Requirements

- System `python3` with `zstandard` (log reading) and `pytest` (task r5).
- A frozen host: `cp -cR ~/.dsh-slicey/host $AB/host` (APFS clone). The harness only ever runs
  `$AB/host/node_modules/@deepseek-ai/dsh/lib/bin.js`, so upgrading slicey mid-batch cannot
  change the host.
- One packed tarball per arm (`npm pack` in a worktree whose `lib/` passed `npm run check:build`).

## Runbook

```sh
AB=/path/to/scratch/p110ab            # everything below lives here, never in the repo
H=scripts/ab                          # this directory, in the exp/p110-ab-harness worktree

python3 $H/run_ab.py prepare --ab-root $AB \
  --arm control=$AB/artifacts/slice-control-<sha>.tgz \
  --arm arm1=$AB/artifacts/slice-arm1-<sha>.tgz --arm arm2=$AB/artifacts/slice-arm2-<sha>.tgz
#   exit 0 only if dump-config is identical across arms (the arm's own home path is normalized)

python3 $H/run_ab.py --ab-root $AB --offline --arms control,arm1,arm2 \
  --tasks hello,r1,r2,r3,r4,r5,c1,c2 --reps 1 --parallel-arms --batch offline
python3 $H/run_ab.py fingerprints --batch-dir $AB/results/offline --out $AB/fingerprints.json

# operator only, after the dry run: ln -s ~/.dsh/.env $AB/home-<arm>/.env  (never cat or copy it)

python3 $H/run_ab.py --ab-root $AB --arms control,arm1,arm2 --tasks hello --reps 2 --parallel-arms --budget-usd 10 \
  --fingerprints none --batch warm
python3 $H/run_ab.py fingerprints --batch-dir $AB/results/warm --compare $AB/fingerprints.json
#   exit 0: the deltas match; if fingerprints changed, rerun with --out $AB/fingerprints.json (doc §3 fallback)
python3 $H/run_ab.py --ab-root $AB --arms control --tasks r1,r3,r4 --reps 1 --budget-usd 10 --batch pilot
python3 $H/run_ab.py --ab-root $AB --arms control,arm1,arm2 --tasks all --reps 3 --seed 20260927 \
  --parallel-arms --budget-usd 10 --batch p110-<yyyymmdd>          # add --resume to continue
python3 $H/ab_report.py $AB/results/p110-<yyyymmdd> --gates $H/gates.json \
  --fingerprints $AB/fingerprints.json --ledger $AB/spend.jsonl
python3 $H/run_ab.py secrets-scan --ab-root $AB     # before archiving: exit 1 lists cells to hold back
```

Long batches: start them with `nohup … &> $AB/<batch>.log &` and poll; never pipe the
headless `--json` stream into `head` (the EPIPE kills the turn), the driver always writes it
to a file.

## What one cell does

1. A fresh workdir `$AB/results/<batch>/work/w-<hash>` whose name does not reveal the arm;
   `setup(root)`. Oracle data stays outside the workdir (r5 writes `<workdir>.truth.json`).
   Attempt numbers continue after every attempt already in `index.jsonl`, so a rerun never
   reuses a workdir, turn file or ledger key.
2. Per prompt: `node bin.js --profile ab --patch steps-<N>.patch.yml [--patch eval-offline…]
   [--session-id SID] --json -` with the prompt on stdin and cwd = workdir, stdout and stderr
   to `turns/<cell>.a<k>.t<n>.{jsonl,err}`; then `hooks.after_turn(n, root)`.
3. `verify(root)` returns `(ok, detail[, info])`; the log is located at
   `$AB/home-<arm>/sessions/*/<SID>/session.v4.jsonl.zstd`; `ab_metrics` adds the metrics row.
4. Validity (see the doc): turn exits, log found, fingerprints, 16 tools, one turn per prompt,
   no host path in the system prompt, no compaction, tape header / tool-line form of the arm,
   structural prefix and header sizes, the r3 fold. An invalid cell is rerun once
   (`--max-attempts 2`).
5. Whatever the outcome (done, invalid, timeout, budget stop), the workdir and its truth
   sidecar are packed into `workdirs/<wid>.tgz` and removed, and the turn stdout files are
   gzipped: no task source, answer or plain-text tool output stays on disk for a later cell's
   model to find (reads are not confined by the sandbox). `cells/*.json` never holds the
   oracle tokens.

A turn cut by `maxStepsPerTurn` ends with `turn_end` kind `blocked` and exit 1 on 0.1.7-rc.2;
it is model-attributable, so the cell continues, and so do `max-tokens` and errors with a
non-infra code (CONTEXT_WINDOW_EXCEEDED, INVALID_REQUEST, UNKNOWN, …). Infra is only a
provider, network, credential or quota error code (TRANSPORT, RATE_LIMIT, SERVER, HTTP 5xx,
TIMEOUT, EMPTY_RESPONSE, MISSING_CREDENTIAL, INVALID_CREDENTIAL, AUTH, QUOTA, ACCOUNT_QUOTA,
NO_ADAPTER, ABORTED), a missing `turn_end`, the harness timeout or a budget kill.

## Budget

Each turn is priced at the peak sheet and appended to `$AB/spend.jsonl`; offline runs use
`<batch>/spend.jsonl`. The charge is the larger of the `--json` stdout figure (`step_end`
usage, plus `--unpriced-step-usd` 0.05 for each `step_end` without usage and each step still
open when the process ended) and the session-log figure (every `assistant/message` and
`assistant/attempt` of the turn, plus 0.05 per record without a usage sample). The 0.1.7-rc.2
projector drops a whole step's usage when any attempt of it had no sample, typically a
transport or 429 retry, so the stdout alone would price that step at $0. The ledger spans
every batch under `$AB`, so one `--budget-usd 10` covers warmup, pilot, batch and arbitration.
No cell starts once spend + `--budget-reserve-usd` (0.75) reaches the cap. Running turns are
polled every second (`--poll-s`) and killed, and no further turn starts, once spend +
`--budget-margin-usd` (0.60) reaches it. The margin must cover 2 x concurrent turns x the
worst-case step (a step's usage is only visible when it ends): 3 x 2 x $0.10. More than
`--max-unpriced-steps` (40) unpriced charges also stop the run. A budget-stopped cell is kept
as `cells/<cell>.budget_stop.json`, not counted, and rerun by `--resume`; the batch exits 2.
`AB_MOCK_FAIL_EVERY=N` (and `AB_MOCK_FAIL_USAGE=1`) make the mock fail every Nth request with
a retryable TRANSPORT error, without (with) a usage sample, to exercise this offline.

## Secrets

The key is never read by this code. It reaches a run only through a symlink
`$AB/home-<arm>/.env -> ~/.dsh/.env` that the operator creates after the dry run. `prepare`
never creates it and refuses to rebuild a home that has one; `--offline` refuses to run when
any home has one and strips `*API_KEY*` / `*DEEPSEEK*` variables from the child environment.
The child environment otherwise mirrors `~/.dsh-slicey/bin/slicey-dsh`: the inherited proxy
variables plus `NODE_USE_ENV_PROXY=1` and `NODE_OPTIONS=--disable-warning=UNDICI-EHPA`, and
`DSH_TELEMETRY_DISABLED=1` as the owner's login shell sets it; every other inherited `DSH_*`
variable is removed. The manifest records variable names, never values.

The bash tool exports `DSH_HOME`, and the sandbox confines writes only, so a model could read
`$DSH_HOME/.env`. `ab_metrics` flags any tool call naming `.env`, `DSH_HOME` or `~/.dsh` as a
secret reference; `run_ab.py secrets-scan` lists those cells, whose logs and turn files are
held back from any archive until the owner has looked. Nothing here reads the key or searches
for it.

## Tests

```sh
python3 scripts/ab/test_ab_metrics.py        # synthetic events
AB_OFFLINE_BATCH=$AB/results/offline AB_RAFT_LOGS=<raft-1.jsonl>:<raft-2.jsonl> \
  python3 scripts/ab/test_ab_metrics.py      # plus the mock logs and two real V4 sessions
python3 scripts/ab/test_ab_report.py
python3 scripts/ab/test_run_ab.py
python3 scripts/ab/selfcheck_tasks.py         # temporary directory, removed afterwards (--keep to inspect)
```

The per-turn cache split can be cross-checked with
`python3 ~/Documents/kimi/workspace/dsh-slice/scripts/cache-metrics.py <session.v4.jsonl.zstd>`.
