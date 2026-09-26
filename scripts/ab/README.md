# scripts/ab: native A/B harness (P1-10)

Drives the published DSH 0.1.7-rc.2 `headless` app, one process per turn, against several
packed builds of this plugin and compares them on pre-registered gates. The experiment it was
built for, with hypothesis, arms, tasks, metrics and gates, is
[docs/p110-native-ab.md](../../docs/p110-native-ab.md). This file says how to run it.

## Files

| file | role |
|---|---|
| `run_ab.py` | driver: `prepare` (one DSH_HOME per arm), `run` (cells), `fingerprints` |
| `ab_metrics.py` | one metrics row per `session.v4.jsonl.zstd` (or plain `.jsonl`) |
| `ab_report.py` | pairs cells, evaluates `gates.json`, writes `summary.json` / `summary.md` |
| `gates.json` | G1–G6 as data; the doc is the normative text |
| `prices.json` | DeepSeek v4-flash sheet, off-peak and peak; the budget uses peak |
| `profile/` | profile template: `package.json`, `pnpm-workspace.yaml`, `cordis.yml`, `eval-parity.patch.yml` (becomes the profile's `cordis.patch.yml`) |
| `mock-llm.mjs`, `eval-offline.patch.yml` | scripted offline adapter (provider `ab-mock`) for dry runs |
| `tasks/<name>/` | `meta.json`, `prompts.json`, `setup.py`, `verify.py`, optional `hooks.py` |
| `test_ab_metrics.py`, `test_ab_report.py` | unit tests (stdlib `unittest`) |
| `selfcheck_tasks.py` | every task's oracle passes on a correct end state and fails otherwise |

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

python3 $H/run_ab.py --ab-root $AB --arms control,arm1,arm2 --tasks hello --reps 2 --parallel-arms --budget-usd 10 --batch warm
python3 $H/run_ab.py --ab-root $AB --arms control --tasks r1,r3,r4 --reps 1 --budget-usd 10 --batch pilot
python3 $H/run_ab.py --ab-root $AB --arms control,arm1,arm2 --tasks all --reps 3 --seed 20260927 \
  --parallel-arms --budget-usd 10 --batch p110-<yyyymmdd>          # add --resume to continue
python3 $H/ab_report.py $AB/results/p110-<yyyymmdd> --gates $H/gates.json \
  --fingerprints $AB/fingerprints.json --ledger $AB/spend.jsonl
```

Long batches: start them with `nohup … &> $AB/<batch>.log &` and poll; never pipe the
headless `--json` stream into `head` (the EPIPE kills the turn), the driver always writes it
to a file.

## What one cell does

1. A fresh workdir `$AB/results/<batch>/work/w-<hash>` whose name does not reveal the arm;
   `setup(root)`. Oracle data stays outside the workdir (r5 writes `<workdir>.truth.json`).
2. Per prompt: `node bin.js --profile ab --patch steps-<N>.patch.yml [--patch eval-offline…]
   [--session-id SID] --json -` with the prompt on stdin and cwd = workdir, stdout and stderr
   to `turns/<cell>.a<k>.t<n>.{jsonl,err}`; then `hooks.after_turn(n, root)`.
3. `verify(root)` returns `(ok, detail[, info])`; the log is located at
   `$AB/home-<arm>/sessions/*/<SID>/session.v4.jsonl.zstd`; `ab_metrics` adds the metrics row.
4. Validity (see the doc): turn exits, log found, fingerprints, 19 tools, no host path in the
   system prompt, no compaction, tape header / tool-line form of the arm, structural prefix and
   header sizes, the r3 fold. An invalid cell is rerun once (`--max-attempts 2`).

A turn cut by `maxStepsPerTurn` ends with `turn_end` kind `blocked` and exit 1 on 0.1.7-rc.2;
it is model-attributable, so the cell continues. Timeouts, TRANSPORT, RATE_LIMIT,
MISSING_CREDENTIAL and a missing `turn_end` are infra.

## Budget

Each turn's usage (the `step_end` events of its `--json` stdout) is priced at the peak sheet
and appended to `$AB/spend.jsonl`; offline runs use `<batch>/spend.jsonl`. The ledger spans
every batch under `$AB`, so one `--budget-usd 10` covers warmup, pilot, batch and arbitration.
No cell starts once spend + `--budget-reserve-usd` (0.25) reaches the cap. Running turns are
polled every 2 s and killed, and no further turn starts, once spend + `--budget-margin-usd`
(0.15, about three concurrent steps at peak) reaches it. A budget-stopped cell is kept as
`cells/<cell>.budget_stop.json`, not counted, and rerun by `--resume`; the batch exits 2.

## Secrets

The key is never read by this code. It reaches a run only through a symlink
`$AB/home-<arm>/.env -> ~/.dsh/.env` that the operator creates after the dry run. `prepare`
never creates it and refuses to rebuild a home that has one; `--offline` refuses to run when
any home has one and strips `*API_KEY*` / `*DEEPSEEK*` variables from the child environment.
The child environment otherwise mirrors `~/.dsh-slicey/bin/slicey-dsh`: the inherited proxy
variables plus `NODE_USE_ENV_PROXY=1` and `NODE_OPTIONS=--disable-warning=UNDICI-EHPA`.

## Tests

```sh
python3 scripts/ab/test_ab_metrics.py        # synthetic events
AB_OFFLINE_BATCH=$AB/results/offline AB_RAFT_LOGS=<raft-1.jsonl>:<raft-2.jsonl> \
  python3 scripts/ab/test_ab_metrics.py      # plus the mock logs and two real V4 sessions
python3 scripts/ab/test_ab_report.py
python3 scripts/ab/selfcheck_tasks.py
```

The per-turn cache split can be cross-checked with
`python3 ~/Documents/kimi/workspace/dsh-slice/scripts/cache-metrics.py <session.v4.jsonl.zstd>`.
