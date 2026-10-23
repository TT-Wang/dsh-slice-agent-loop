# slice-vs-stock summary

Batches: batch, arb (pooled). Cells: 64 (64 valid). Arms: slice, stock, stock-compact.
Spend (peak sheet): $5.7403 over 795 turns; by batch {'warm': 0.003822, 'pilot': 0.962443, 'warm2': 0.000571, 'pilot2': 0.361849, 'batch': 3.308736, 'arb': 1.10288}.

## Decision (pre-registered rules, gates-svs.json)

- slice vs stock: **inconclusive** (long-session saving (L 0.611) bought with short-session overhead (N 1.167 > 1.10)); quality floor holds

## slice vs stock

Pairs 31; L = 0.611, N = 1.167 (secondary: N_recall 1.131, N_coding 1.261), G = 1.076; sum ratio 0.875, median paired ratio 1.152; dS 0; memory 31 vs 31 correct of 31 items (dM 0), bad 0 vs 0 (dB 0).

| task | pairs/min | R (sum ratio) | median paired ratio | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| f1 | 3/2 | 0.611 | 0.560 | [0.5513, 0.5598, 0.7637] | 3/3 | 0 |
| r1 | 4/2 | 0.777 | 0.697 | [0.7589, 0.6352, 0.6182, 1.4316] | 4/4 | 0 |
| r2 | 4/2 | 0.909 | 0.915 | [1.397, 1.1082, 0.7218, 0.7036] | 4/4 | 0 |
| r3 | 4/2 | 1.292 | 1.294 | [1.5652, 0.864, 1.0228, 1.8047] | 4/4 | 0 |
| r4 | 4/2 | 1.363 | 1.336 | [1.4001, 1.673, 1.2724, 1.1522] | 4/4 | 0 |
| r5 | 4/2 | 1.488 | 1.377 | [1.2792, 1.4755, 2.0516, 1.1072] | 4/4 | 0 |
| c1 | 4/2 | 1.587 | 1.480 | [1.3893, 2.1165, 1.5097, 1.4498] | 4/4 | 0 |
| c2 | 4/2 | 1.001 | 1.032 | [1.0548, 1.1747, 1.0089, 0.8128] | 4/4 | 0 |

| memory item | arm correct | base correct | pairs |
|---|---|---|---|
| f1:build_id | 3 | 3 | 3 |
| f1:deploy | 3 | 3 | 3 |
| f1:lint_error | 3 | 3 | 3 |
| f1:trap | 3 | 3 | 3 |
| r1:exam | 4 | 4 | 4 |
| r2:exam | 3 | 3 | 3 |
| r3:exam | 4 | 4 | 4 |
| r4:exam | 4 | 4 | 4 |
| r5:exam | 4 | 4 | 4 |

- dropped: r2.r3 (batch): memory exclusion (flagged access, leak or oracle via the file system)

## stock-compact vs stock (inconclusive (secondary, not a decision))

Pairs 2; L = 0.863, N = - (secondary: N_recall -, N_coding -), G = -; sum ratio 0.863, median paired ratio 0.880; dS -2; memory 8 vs 8 correct of 8 items (dM 0), bad 0 vs 0 (dB 0). Insufficient: 2 valid pairs < 19; r1: 0 pairs < 2; r2: 0 pairs < 2; r3: 0 pairs < 2; r4: 0 pairs < 2; r5: 0 pairs < 2; c1: 0 pairs < 2; c2: 0 pairs < 2; 8 memory items < 18.

| task | pairs/min | R (sum ratio) | median paired ratio | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| f1 | 2/2 | 0.863 | 0.880 | [0.7726, 0.9883] | 0/2 | -2 |
| r1 | 0/2 | - | - | [] | 0/0 | 0 |
| r2 | 0/2 | - | - | [] | 0/0 | 0 |
| r3 | 0/2 | - | - | [] | 0/0 | 0 |
| r4 | 0/2 | - | - | [] | 0/0 | 0 |
| r5 | 0/2 | - | - | [] | 0/0 | 0 |
| c1 | 0/2 | - | - | [] | 0/0 | 0 |
| c2 | 0/2 | - | - | [] | 0/0 | 0 |

| memory item | arm correct | base correct | pairs |
|---|---|---|---|
| f1:build_id | 2 | 2 | 2 |
| f1:deploy | 2 | 2 | 2 |
| f1:lint_error | 2 | 2 | 2 |
| f1:trap | 2 | 2 | 2 |

- dropped: c1.r1 (arb): missing cell
- dropped: c2.r1 (arb): missing cell
- dropped: f1.r1 (arb): missing cell
- dropped: r1.r1 (arb): missing cell
- dropped: r2.r1 (arb): missing cell
- dropped: r3.r1 (arb): missing cell
- dropped: r4.r1 (arb): missing cell
- dropped: r5.r1 (arb): missing cell
- dropped: c1.r1 (batch): missing cell
- dropped: c1.r2 (batch): missing cell
- dropped: c1.r3 (batch): missing cell
- dropped: c2.r1 (batch): missing cell
- dropped: c2.r2 (batch): missing cell
- dropped: c2.r3 (batch): missing cell
- dropped: r1.r1 (batch): missing cell
- dropped: r1.r2 (batch): missing cell
- dropped: r1.r3 (batch): missing cell
- dropped: r2.r1 (batch): missing cell
- dropped: r2.r2 (batch): missing cell
- dropped: r2.r3 (batch): missing cell
- dropped: r3.r1 (batch): missing cell
- dropped: r3.r2 (batch): missing cell
- dropped: r3.r3 (batch): missing cell
- dropped: r4.r1 (batch): missing cell
- dropped: r4.r2 (batch): missing cell
- dropped: r4.r3 (batch): missing cell
- dropped: r5.r1 (batch): missing cell
- dropped: r5.r2 (batch): missing cell
- dropped: r5.r3 (batch): missing cell

## slice vs stock-compact (inconclusive (secondary, not a decision))

Pairs 2; L = 0.748, N = - (secondary: N_recall -, N_coding -), G = -; sum ratio 0.748, median paired ratio 0.749; dS 2; memory 8 vs 8 correct of 8 items (dM 0), bad 0 vs 0 (dB 0). Insufficient: 2 valid pairs < 19; r1: 0 pairs < 2; r2: 0 pairs < 2; r3: 0 pairs < 2; r4: 0 pairs < 2; r5: 0 pairs < 2; c1: 0 pairs < 2; c2: 0 pairs < 2; 8 memory items < 18.

| task | pairs/min | R (sum ratio) | median paired ratio | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| f1 | 2/2 | 0.748 | 0.749 | [0.7245, 0.7728] | 2/0 | 2 |
| r1 | 0/2 | - | - | [] | 0/0 | 0 |
| r2 | 0/2 | - | - | [] | 0/0 | 0 |
| r3 | 0/2 | - | - | [] | 0/0 | 0 |
| r4 | 0/2 | - | - | [] | 0/0 | 0 |
| r5 | 0/2 | - | - | [] | 0/0 | 0 |
| c1 | 0/2 | - | - | [] | 0/0 | 0 |
| c2 | 0/2 | - | - | [] | 0/0 | 0 |

| memory item | arm correct | base correct | pairs |
|---|---|---|---|
| f1:build_id | 2 | 2 | 2 |
| f1:deploy | 2 | 2 | 2 |
| f1:lint_error | 2 | 2 | 2 |
| f1:trap | 2 | 2 | 2 |

- dropped: c1.r1 (arb): missing cell
- dropped: c2.r1 (arb): missing cell
- dropped: f1.r1 (arb): missing cell
- dropped: r1.r1 (arb): missing cell
- dropped: r2.r1 (arb): missing cell
- dropped: r3.r1 (arb): missing cell
- dropped: r4.r1 (arb): missing cell
- dropped: r5.r1 (arb): missing cell
- dropped: c1.r1 (batch): missing cell
- dropped: c1.r2 (batch): missing cell
- dropped: c1.r3 (batch): missing cell
- dropped: c2.r1 (batch): missing cell
- dropped: c2.r2 (batch): missing cell
- dropped: c2.r3 (batch): missing cell
- dropped: r1.r1 (batch): missing cell
- dropped: r1.r2 (batch): missing cell
- dropped: r1.r3 (batch): missing cell
- dropped: r2.r1 (batch): missing cell
- dropped: r2.r2 (batch): missing cell
- dropped: r2.r3 (batch): missing cell
- dropped: r3.r1 (batch): missing cell
- dropped: r3.r2 (batch): missing cell
- dropped: r3.r3 (batch): missing cell
- dropped: r4.r1 (batch): missing cell
- dropped: r4.r2 (batch): missing cell
- dropped: r4.r3 (batch): missing cell
- dropped: r5.r1 (batch): missing cell
- dropped: r5.r2 (batch): missing cell
- dropped: r5.r3 (batch): missing cell

## Context management and cost structure (valid cells, reported only)

| arm | task | cells | pass | median $ off-peak | median requests | median peak req tokens | median mean req tokens | median last-turn peak | median cache hit | summaries (failed) | prunes | compaction turns | ctx-limit errors | spills | slice folds | req/turn | steps/turn | step-cap cuts | same-turn rereads | memory correct/total (bad) | post-compaction memory failures | median wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| slice | c1 | 4 | 4 | 0.0820 | 91.500 | 38642.500 | 20474 | 35953.500 | 0.966 | 0 (0) | 0 | [[], [], [], []] | 0 | 0 | 6 | 11.440 | 11.440 | 14 | 24 | 0/0 (0) | 0 | 824 |
| slice | c2 | 4 | 4 | 0.0043 | 7.000 | 14637.000 | 9632 | 14637.000 | 0.898 | 0 (0) | 0 | [[], [], [], []] | 0 | 0 | 1 | 7.000 | 7.000 | 0 | 12 | 0/0 (0) | 0 | 24 |
| slice | f1 | 3 | 3 | 0.1308 | 265 | 43301 | 24774 | 40789 | 0.958 | 0 (0) | 0 | [[], [], []] | 0 | 0 | 40 | 5.890 | 5.890 | 0 | 44 | 12/12 (0) | 0 | 542 |
| slice | r1 | 4 | 4 | 0.0048 | 17.500 | 12438.000 | 8671 | 10778.000 | 0.936 | 0 (0) | 0 | [[], [], [], []] | 0 | 0 | 0 | 2.915 | 2.915 | 0 | 0 | 4/4 (0) | 0 | 42 |
| slice | r2 | 4 | 4 | 0.0097 | 27.000 | 15237.500 | 10379 | 13814.000 | 0.948 | 0 (0) | 0 | [[], [], [], []] | 0 | 0 | 0 | 3.860 | 3.860 | 0 | 3 | 4/4 (0) | 0 | 82 |
| slice | r3 | 4 | 4 | 0.0045 | 16.500 | 10858.500 | 7165 | 10858.500 | 0.914 | 0 (0) | 0 | [[], [], [], []] | 0 | 0 | 4 | 5.500 | 5.500 | 0 | 3 | 4/4 (0) | 0 | 34 |
| slice | r4 | 4 | 4 | 0.0029 | 14.000 | 7100.000 | 5921 | 7100.000 | 0.954 | 0 (0) | 0 | [[], [], [], []] | 0 | 0 | 0 | 3.500 | 3.500 | 0 | 2 | 4/4 (0) | 0 | 33 |
| slice | r5 | 4 | 4 | 0.0074 | 13.000 | 18678.500 | 11259 | 13538.000 | 0.872 | 0 (0) | 0 | [[], [], [], []] | 0 | 0 | 7 | 6.500 | 6.500 | 0 | 0 | 4/4 (0) | 0 | 46 |
| stock | c1 | 4 | 4 | 0.0529 | 47.500 | 74338.000 | 34361 | 74338.000 | 0.983 | 0 (0) | 0 | [[], [], [], []] | 0 | 0 | 0 | 5.940 | 5.940 | 0 | 12 | 0/0 (0) | 0 | 341 |
| stock | c2 | 4 | 4 | 0.0042 | 8.000 | 11609.500 | 8279 | 11609.500 | 0.908 | 0 (0) | 0 | [[], [], [], []] | 0 | 0 | 0 | 8.000 | 8.000 | 0 | 1 | 0/0 (0) | 0 | 30 |
| stock | f1 | 3 | 3 | 0.2359 | 213 | 234025 | 116231 | 234025 | 0.991 | 0 (0) | 0 | [[], [], []] | 0 | 0 | 0 | 4.730 | 4.730 | 0 | 86 | 12/12 (0) | 0 | 426 |
| stock | r1 | 4 | 4 | 0.0064 | 18.500 | 14006.500 | 8264 | 14006.500 | 0.950 | 0 (0) | 0 | [[], [], [], []] | 0 | 0 | 0 | 3.085 | 3.085 | 0 | 2 | 4/4 (0) | 0 | 62 |
| stock | r2 | 4 | 4 | 0.0103 | 24.000 | 20463.500 | 11744 | 20463.500 | 0.960 | 0 (0) | 0 | [[], [], [], []] | 0 | 0 | 0 | 3.425 | 3.425 | 0 | 1 | 4/4 (0) | 0 | 94 |
| stock | r3 | 4 | 4 | 0.0034 | 11.500 | 11422.500 | 9532 | 11422.500 | 0.922 | 0 (0) | 0 | [[], [], [], []] | 0 | 0 | 0 | 3.830 | 3.830 | 0 | 4 | 4/4 (0) | 0 | 25 |
| stock | r4 | 4 | 4 | 0.0022 | 12.500 | 6024.000 | 4371 | 6024.000 | 0.947 | 0 (0) | 0 | [[], [], [], []] | 0 | 0 | 0 | 3.125 | 3.125 | 0 | 4 | 4/4 (0) | 0 | 29 |
| stock | r5 | 4 | 4 | 0.0055 | 10.000 | 17436.500 | 12511 | 17436.500 | 0.905 | 0 (0) | 0 | [[], [], [], []] | 0 | 0 | 0 | 5.000 | 5.000 | 0 | 1 | 4/4 (0) | 0 | 29 |
| stock-compact | f1 | 2 | 0 | 0.1757 | 214.000 | 58930.500 | 42162 | 48979.000 | 0.953 | 9 (0) | 64 | [[20, 26, 31, 36, 44], [22, 28, 34, 37]] | 0 | 0 | 0 | 4.755 | 4.755 | 0 | 79 | 8/8 (0) | 0 | 436 |

## Recall sourcing, partial leaks and manipulation checks (valid cells, reported only)

| arm | task | exams recall-sourced | exams with a partial leak before them | r3 T1 fold | f1 digest tokens missing | cells whose cost is a lower bound (failed compactions) |
|---|---|---|---|---|---|---|
| slice | c1 | 0/0 | 0 | - | - | 0 |
| slice | c2 | 0/0 | 0 | - | - | 0 |
| slice | f1 | 6/6 | 2 | - | 0 | 0 |
| slice | r1 | 4/4 | 0 | - | - | 0 |
| slice | r2 | 4/4 | 0 | - | - | 0 |
| slice | r3 | 4/4 | 0 | 4/4 | - | 0 |
| slice | r4 | 4/4 | 0 | - | - | 0 |
| slice | r5 | 4/4 | 0 | - | - | 0 |
| stock | c1 | 0/0 | 0 | - | - | 0 |
| stock | c2 | 0/0 | 0 | - | - | 0 |
| stock | f1 | 0/6 | 0 | - | 0 | 0 |
| stock | r1 | 0/4 | 0 | - | - | 0 |
| stock | r2 | 0/4 | 0 | - | - | 0 |
| stock | r3 | 0/4 | 0 | 0/4 | - | 0 |
| stock | r4 | 0/4 | 0 | - | - | 0 |
| stock | r5 | 0/4 | 0 | - | - | 0 |
| stock-compact | f1 | 0/4 | 1 | - | 16 | 0 |

Ratios are the named arm over its baseline; cost on the off-peak sheet (peak is exactly 2x every field). A cell with a failed compaction attempt has a cost that is a lower bound (the attempt is billed, its usage is not logged).
