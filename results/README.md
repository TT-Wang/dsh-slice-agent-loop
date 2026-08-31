# Benchmark archives (raw, per-call ledgers)

Every number in the README's "Results update — 2026-08" is recomputable from
these files. Each JSON is one arm × one scenario run (per-turn usage, verdict,
workdir); `.log` files are the driver's stdout for the same runs.

| dir | what |
|---|---|
| `20260826-retention/` | retention series: s14b + n1/n2/n3 (new scenarios incl. snapshot) + h1/h2 + r1 — both arms |
| `20260827-cost1m/` | 1M-window cost experiment: x1 (pure flood) / x2 (flood+work), product-default compaction, incl. invalidated/dirty runs kept for audit (tags r4/r4b/r4c vs clean r5) |
| `20260831-reasoning-ab/` | reasoning-passback A/B (slice on/off) + the transcript strip experiment (dnorm/dstrip) |

Scenario definitions for the n-series ship in
`20260826-retention/scenarios-snapshot/`. Session-level ground truth (the
durable event logs the ledgers were summed from) lives in each runner's
`~/.dsh/sessions/` and is not committed.
