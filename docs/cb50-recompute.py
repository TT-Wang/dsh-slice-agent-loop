#!/usr/bin/env python3
"""Recompute both published CB50 aggregates from the committed per-question table.

The two CB50 aggregates in this repo describe ONE run under two conventions:

  docs/eval-report.md 5    timeouts dropped per arm  (default n=44, slice n=49)
  docs/cb50-detail.md      timeouts score 0, n=50 both arms

This script parses the 50-row table in docs/cb50-detail.md and prints both, so
the gap can be checked to be entirely the convention and nothing else. It is
the only reproduction path left for CB50: the drivers (scripts/dsh-h2h.mjs,
scripts/cb50-dsh.mjs) never existed in this repository and the raw per-question
JSON only ever lived in /tmp. See the run-method note in docs/eval-report.md 6.

Usage:  python3 docs/cb50-recompute.py [path/to/cb50-detail.md]

Expected output on the committed table:
  timeouts       default 6 (rows 5 7 15 37 38 50)   slice 1 (row 2)
  drop  fileR    0.678 -> 0.761  (+12.4%)   published 0.677 -> 0.761  (+12.4%)
  drop  spanR    0.684 -> 0.752  ( +9.9%)   published 0.684 -> 0.752  ( +9.9%)
  zero  fileR    0.596 -> 0.746  (+25.2%)   published 0.596 -> 0.746  (+25.2%)
  zero  spanR    0.602 -> 0.737  (+22.4%)   published 0.602 -> 0.737  (+22.5%)
Recall matches to the published third decimal (default fileR 0.678 vs 0.677 and
spanR delta 22.4 vs 22.5 are rounding: the table stores per-question scores to
two decimals). Price totals recompute to $0.7770 / $1.0950 against published
$0.7746 / $1.0957 for the same reason -- per-row prices are rounded to $0.001.
"""
import re
import statistics
import sys
from pathlib import Path

path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("cb50-detail.md")
rows = []
for line in path.read_text(encoding="utf-8").splitlines():
    if not re.match(r"^\|\s*\d+\s*\|", line):
        continue
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    if len(cells) < 12:
        continue
    rows.append({"n": int(cells[0]), "fileR": (cells[2], cells[3]),
                 "spanR": (cells[4], cells[5]), "price": (cells[10], cells[11])})
if len(rows) != 50:
    sys.exit(f"expected 50 question rows in {path}, parsed {len(rows)}")

ARMS = ("default", "slice-ts")


def col(metric, i):
    return [r[metric][i] for r in rows]


def agg(vals, mode):
    """mode 'zero': TO scores 0, n stays 50. mode 'drop': TO rows leave the denominator."""
    nums = [0.0 if v == "TO" else float(v) for v in vals] if mode == "zero" \
        else [float(v) for v in vals if v != "TO"]
    return sum(nums) / len(nums), len(nums)


print(f"source: {path}  rows: {len(rows)}\n")
for i, name in enumerate(ARMS):
    to = [r["n"] for r in rows if r["fileR"][i] == "TO"]
    print(f"  timeouts  {name:9s} {len(to)}  (rows {' '.join(map(str, to))})")
print()
for mode, label in (("drop", "timeouts dropped per arm -> docs/eval-report.md 5"),
                    ("zero", "timeouts score 0, n=50   -> docs/cb50-detail.md")):
    print(f"== {label} ==")
    for metric in ("fileR", "spanR"):
        (d, nd), (s, ns) = agg(col(metric, 0), mode), agg(col(metric, 1), mode)
        print(f"  {metric}  default {d:.3f} (n={nd})  slice {s:.3f} (n={ns})  delta {100 * (s - d) / d:+.1f}%")
    print()
print("== price (convention-independent: a TO row is unpriced on both arms) ==")
for i, name in enumerate(ARMS):
    paid = [float(v) for v in col("price", i) if v != "TO"]
    print(f"  {name:9s} total ${sum(paid):.4f} over {len(paid)} priced rows, median ${statistics.median(paid):.4f}")
