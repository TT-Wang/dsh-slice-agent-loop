# Re-read classes of the imported baseline cells (svs2, 2026-10-24)

From `svs2_report.py import-baseline` (the 2026-10-23 SLICE and STOCK cells of c1, c2, r2 and f1, metrics recomputed from the archived session logs). Classes as defined in docs/svs2-ablation-2026-10-24.md §6.2; sums over the valid cells.

| arm | task | cells | turns | first | cross-turn | same-turn | after own edit | reads | edits/writes | bash writes | FS_NOT_OBSERVED | FS_STALE_VERSION |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| STOCK | c1 | 4 | 32 | 6 | 27 | 10 | 9 | 52 | 84 | 23 | 1 | 0 |
| STOCK | c2 | 4 | 4 | 23 | 0 | 0 | 5 | 28 | 25 | 6 | 4 | 0 |
| STOCK | r2 | 4 | 28 | 6 | 4 | 0 | 3 | 13 | 27 | 6 | 2 | 0 |
| STOCK | f1 | 3 | 135 | 108 | 107 | 0 | 90 | 305 | 139 | 3 | 4 | 0 |
| SLICE | c1 | 4 | 32 | 8 | 59 | 0 | 28 | 95 | 168 | 90 | 1 | 0 |
| SLICE | c2 | 4 | 4 | 34 | 0 | 0 | 12 | 46 | 21 | 5 | 0 | 0 |
| SLICE | r2 | 4 | 28 | 8 | 8 | 0 | 3 | 19 | 21 | 15 | 0 | 0 |
| SLICE | f1 | 3 | 135 | 109 | 105 | 118 | 39 | 371 | 98 | 61 | 2 | 0 |
