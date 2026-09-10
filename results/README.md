# Benchmark archives (raw, per-call ledgers)

> **Architecture status.** Everything here was measured on the **retired
> custom loop**, before the 2026-09-08 native DSH alpha.2 migration. These
> ledgers do not establish the current policy's quality or cost.

The "Results update" sections these ledgers back live in
[`docs/legacy-loop.md`](../docs/legacy-loop.md) (2026-08-24 → 31, 2026-09-01,
2026-09-03) — they were moved out of the root README during the native
migration, and the root README no longer carries such a section. **Corrected
2026-09-10**: this file previously pointed at "the README's 'Results update —
2026-08'".

Each JSON is one arm × one scenario run (per-turn usage, verdict, workdir), and
the JSON ledgers *are* recomputable — e.g. pricing the `totals` of
`20260901-header-dedup/*.json` at that experiment's off-peak sheet
(`input × $0.22/M + cacheRead × $0.007/M + output × $0.66/M`) reproduces all six
`price_usd` entries in its `SCOREBOARD.json` exactly: ctl 0.1827 / 0.1667,
slim 0.1704 / 0.1660, n1 ctl 0.0221 / n1 slim 0.0203. Verified 2026-09-10.

**No driver stdout is committed.** This file previously claimed "`.log` files
are the driver's stdout for the same runs"; there are zero tracked `.log` files
(`git ls-files results | grep -c '\.log$'` → 0, `find results -name '*.log' |
wc -l` → 0), because `.gitignore:19` ignores `*.log` globally. The logs exist
only in the maintainer's working checkout. Corrected 2026-09-10.

Per-run metadata is thin: no archived JSON records a commit SHA
(`grep -rl '"commit"' results --include='*.json'` → 0). Directory date prefixes
are the only provenance; cross-reference `git log` for the matching commit.

| dir | what |
|---|---|
| `20260826-retention/` | retention series: s14b + n1/n2/n3 (new scenarios incl. snapshot) + h1/h2 + r1 — both arms |
| `20260827-cost1m/` | 1M-window cost experiment: x1 (pure flood) / x2 (flood+work), product-default compaction, incl. invalidated/dirty runs kept for audit (tags r4/r4b/r4c vs clean r5) |
| `20260831-reasoning-ab/` | reasoning-passback A/B (slice on/off) + the transcript strip experiment (dnorm/dstrip) |
| `sidecars/` | call-ledger sidecars (per-turn seed bytes + per-call usage) for `scripts/attribute-miss.mts`; first entries are the 20260901 n2+n3 tool-validation runs (slice arm, v4-flash) |

Scenario definitions for the n-series ship in
`20260826-retention/scenarios-snapshot/`. Session-level ground truth (the
durable event logs the ledgers were summed from) lives in each runner's
`~/.dsh/sessions/` and is not committed.
