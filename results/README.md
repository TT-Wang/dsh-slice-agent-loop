# Benchmark archives (raw, per-call ledgers)

**The data is no longer in the Git tree.** Since 2026-09-27 this README is the
only tracked file under `results/`. The 809 files that were tracked here at
`ba12a5b` are the asset `dsh-slice-agent-loop-results-2026-09-04.tar.gz` of the
GitHub release
[`archive-legacy-results-2026-09-04`](https://github.com/TT-Wang/dsh-slice-agent-loop/releases/tag/archive-legacy-results-2026-09-04)
(12,393,779 bytes, SHA-256
`a35f17b7ec2979c3dd9f403fb817268d33a460305938d2fc4904e693d7924c18`; a `.sha256`
file sits next to it). They moved because every `dsh plugin add github:...`
install downloads a tarball of the whole tree, and this archive was about 95%
of it while nothing installed or tested reads it. Git history was not
rewritten.

**Pulling this change into a checkout that has the files deletes them.** Git
removes files that a commit stops tracking, whatever `.gitignore` says;
untracked files already there, such as `*.log`, stay. Right after the pull, put
them back from history (from the repository root):

```sh
git restore --source=ba12a5b --worktree -- results ':(exclude)results/README.md'
```

That writes the 808 data files exactly as they were at `ba12a5b`, the commit
the release tag points at, and leaves the index alone. The files are now
ignored, so `git status` stays clean. Any clone with full history can restore
this way instead of downloading.

To download the release asset instead, from the repository root:

```sh
gh release download archive-legacy-results-2026-09-04 -R TT-Wang/dsh-slice-agent-loop -p 'dsh-slice-agent-loop-results-2026-09-04.tar.gz*'
shasum -a 256 -c dsh-slice-agent-loop-results-2026-09-04.tar.gz.sha256
tar --exclude='results/README.md' -xzf dsh-slice-agent-loop-results-2026-09-04.tar.gz
rm dsh-slice-agent-loop-results-2026-09-04.tar.gz dsh-slice-agent-loop-results-2026-09-04.tar.gz.sha256
```

`gh` will not run until you `gh auth login` or set `GH_TOKEN`, even for a
public release. Without it, use this line in place of the `gh` line; it saves
the same two files (the quotes leave `{,.sha256}` for curl to expand):

```sh
curl -fL --remote-name-all 'https://github.com/TT-Wang/dsh-slice-agent-loop/releases/download/archive-legacy-results-2026-09-04/dsh-slice-agent-loop-results-2026-09-04.tar.gz{,.sha256}'
```

The archive's paths start with `results/`, so the offline scripts and the docs
that cite `results/...` work unchanged after extraction. The archive also holds
the older copy of this README; `--exclude` keeps it from replacing this one. If
a plain `tar -xzf` already replaced it, `git checkout -- results/README.md` puts
this one back.

`.gitignore` ignores everything under `results/` except this README, so
extracted files and new experiment output stay local. To publish a new data
set, attach an archive to a GitHub release instead of committing it;
`npm run check:size` fails CI once tracked files pass 8 MiB.

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
wc -l` → 0), because `.gitignore` ignores `*.log` globally. The logs exist
only in the maintainer's working checkout; the release archive has none
either. Corrected 2026-09-10.

Per-run metadata is thin: no archived JSON records a commit SHA
(`grep -rl '"commit"' results --include='*.json'` → 0). Directory date prefixes
are the only provenance; cross-reference `git log` for the matching commit.

| dir | what |
|---|---|
| `20260826-retention/` | retention series: s14b + n1/n2/n3 (new scenarios incl. snapshot) + h1/h2 + r1 — both arms |
| `20260827-cost1m/` | 1M-window cost experiment: x1 (pure flood) / x2 (flood+work), product-default compaction, incl. invalidated/dirty runs kept for audit (tags r4/r4b/r4c vs clean r5) |
| `20260831-reasoning-ab/` | reasoning-passback A/B (slice on/off) + the transcript strip experiment (dnorm/dstrip) |
| `sidecars/` | call-ledger sidecars (per-turn seed bytes + per-call usage) for `scripts/attribute-miss.mts`; first entries are the 20260901 n2+n3 tool-validation runs (slice arm, v4-flash) |

Scenario definitions for the n-series are in the archive under
`20260826-retention/scenarios-snapshot/`. Session-level ground truth (the
durable event logs the ledgers were summed from) lives in each runner's
`~/.dsh/sessions/` and is not committed.
