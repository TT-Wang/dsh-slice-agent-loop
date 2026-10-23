# slice-vs-stock summary

Batches: batch. Cells: 48 (48 valid). Arms: slice, stock, stock-compact.
Spend (peak sheet): $4.6374 over 643 turns; by batch {'warm': 0.003822, 'pilot': 0.962443, 'warm2': 0.000571, 'pilot2': 0.361849, 'batch': 3.308736}.

## Decision (pre-registered rules, gates-svs.json)

- slice vs stock: **inconclusive** (long-session saving (L 0.645) bought with short-session overhead (N 1.141 > 1.10)); quality floor holds
- arbitration: required: verdict moves to 'worth it' at L 0.645, N 1.091

## slice vs stock

Pairs 23; L = 0.645, N = 1.141 (secondary: N_recall 1.091, N_coding 1.276), G = 1.063; sum ratio 0.935, median paired ratio 1.108; dS 0; memory 22 vs 22 correct of 22 items (dM 0), bad 0 vs 0 (dB 0).

| task | pairs/min | R (sum ratio) | median paired ratio | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| f1 | 2/2 | 0.645 | 0.662 | [0.5598, 0.7637] | 2/2 | 0 |
| r1 | 3/2 | 0.783 | 0.635 | [0.6352, 0.6182, 1.4316] | 3/3 | 0 |
| r2 | 3/2 | 0.800 | 0.722 | [1.1082, 0.7218, 0.7036] | 3/3 | 0 |
| r3 | 3/2 | 1.190 | 1.023 | [0.864, 1.0228, 1.8047] | 3/3 | 0 |
| r4 | 3/2 | 1.349 | 1.272 | [1.673, 1.2724, 1.1522] | 3/3 | 0 |
| r5 | 3/2 | 1.538 | 1.476 | [1.4755, 2.0516, 1.1072] | 3/3 | 0 |
| c1 | 3/2 | 1.655 | 1.510 | [2.1165, 1.5097, 1.4498] | 3/3 | 0 |
| c2 | 3/2 | 0.985 | 1.009 | [1.1747, 1.0089, 0.8128] | 3/3 | 0 |

| memory item | arm correct | base correct | pairs |
|---|---|---|---|
| f1:build_id | 2 | 2 | 2 |
| f1:deploy | 2 | 2 | 2 |
| f1:lint_error | 2 | 2 | 2 |
| f1:trap | 2 | 2 | 2 |
| r1:exam | 3 | 3 | 3 |
| r2:exam | 2 | 2 | 2 |
| r3:exam | 3 | 3 | 3 |
| r4:exam | 3 | 3 | 3 |
| r5:exam | 3 | 3 | 3 |

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
| slice | c1 | 3 | 3 | 0.0861 | 92 | 39330 | 20570 | 35715 | 0.965 | 0 (0) | 0 | [[], [], []] | 0 | 0 | 5 | 11.500 | 11.500 | 10 | 20 | 0/0 (0) | 0 | 891 |
| slice | c2 | 3 | 3 | 0.0042 | 6 | 14982 | 9886 | 14982 | 0.894 | 0 (0) | 0 | [[], [], []] | 0 | 0 | 0 | 6.000 | 6.000 | 0 | 12 | 0/0 (0) | 0 | 26 |
| slice | f1 | 2 | 2 | 0.1314 | 271.500 | 41658.000 | 24338 | 39633.000 | 0.959 | 0 (0) | 0 | [[], []] | 0 | 0 | 8 | 6.035 | 6.035 | 0 | 9 | 8/8 (0) | 0 | 532 |
| slice | r1 | 3 | 3 | 0.0048 | 18 | 13661 | 8952 | 10782 | 0.933 | 0 (0) | 0 | [[], [], []] | 0 | 0 | 0 | 3.000 | 3.000 | 0 | 0 | 3/3 (0) | 0 | 43 |
| slice | r2 | 3 | 3 | 0.0092 | 27 | 15189 | 10432 | 14027 | 0.948 | 0 (0) | 0 | [[], [], []] | 0 | 0 | 0 | 3.860 | 3.860 | 0 | 3 | 3/3 (0) | 0 | 80 |
| slice | r3 | 3 | 3 | 0.0036 | 16 | 8941 | 6722 | 8941 | 0.921 | 0 (0) | 0 | [[], [], []] | 0 | 0 | 3 | 5.330 | 5.330 | 0 | 3 | 3/3 (0) | 0 | 33 |
| slice | r4 | 3 | 3 | 0.0027 | 14 | 7050 | 5921 | 7050 | 0.953 | 0 (0) | 0 | [[], [], []] | 0 | 0 | 0 | 3.500 | 3.500 | 0 | 0 | 3/3 (0) | 0 | 33 |
| slice | r5 | 3 | 3 | 0.0086 | 13 | 20197 | 12652 | 14060 | 0.873 | 0 (0) | 0 | [[], [], []] | 0 | 0 | 5 | 6.500 | 6.500 | 0 | 0 | 3/3 (0) | 0 | 54 |
| stock | c1 | 3 | 3 | 0.0538 | 47 | 75798 | 37110 | 75798 | 0.982 | 0 (0) | 0 | [[], [], []] | 0 | 0 | 0 | 5.880 | 5.880 | 0 | 9 | 0/0 (0) | 0 | 378 |
| stock | c2 | 3 | 3 | 0.0043 | 8 | 10984 | 8119 | 10984 | 0.912 | 0 (0) | 0 | [[], [], []] | 0 | 0 | 0 | 8.000 | 8.000 | 0 | 1 | 0/0 (0) | 0 | 32 |
| stock | f1 | 2 | 2 | 0.2036 | 178.000 | 232061.500 | 112899 | 232061.500 | 0.988 | 0 (0) | 0 | [[], []] | 0 | 0 | 0 | 3.955 | 3.955 | 0 | 49 | 8/8 (0) | 0 | 418 |
| stock | r1 | 3 | 3 | 0.0075 | 18 | 15607 | 8937 | 15607 | 0.953 | 0 (0) | 0 | [[], [], []] | 0 | 0 | 0 | 3.000 | 3.000 | 0 | 2 | 3/3 (0) | 0 | 72 |
| stock | r2 | 3 | 3 | 0.0127 | 26 | 23688 | 13119 | 23688 | 0.966 | 0 (0) | 0 | [[], [], []] | 0 | 0 | 0 | 3.710 | 3.710 | 0 | 1 | 3/3 (0) | 0 | 110 |
| stock | r3 | 3 | 3 | 0.0030 | 10 | 10985 | 9267 | 10985 | 0.914 | 0 (0) | 0 | [[], [], []] | 0 | 0 | 0 | 3.330 | 3.330 | 0 | 3 | 3/3 (0) | 0 | 21 |
| stock | r4 | 3 | 3 | 0.0021 | 13 | 5787 | 4330 | 5787 | 0.950 | 0 (0) | 0 | [[], [], []] | 0 | 0 | 0 | 3.250 | 3.250 | 0 | 3 | 3/3 (0) | 0 | 31 |
| stock | r5 | 3 | 3 | 0.0056 | 10 | 17707 | 12592 | 17707 | 0.904 | 0 (0) | 0 | [[], [], []] | 0 | 0 | 0 | 5.000 | 5.000 | 0 | 1 | 3/3 (0) | 0 | 29 |
| stock-compact | f1 | 2 | 0 | 0.1757 | 214.000 | 58930.500 | 42162 | 48979.000 | 0.953 | 9 (0) | 64 | [[20, 26, 31, 36, 44], [22, 28, 34, 37]] | 0 | 0 | 0 | 4.755 | 4.755 | 0 | 79 | 8/8 (0) | 0 | 436 |

## Recall sourcing, partial leaks and manipulation checks (valid cells, reported only)

| arm | task | exams recall-sourced | exams with a partial leak before them | r3 T1 fold | f1 digest tokens missing | cells whose cost is a lower bound (failed compactions) |
|---|---|---|---|---|---|---|
| slice | c1 | 0/0 | 0 | - | - | 0 |
| slice | c2 | 0/0 | 0 | - | - | 0 |
| slice | f1 | 4/4 | 2 | - | 0 | 0 |
| slice | r1 | 3/3 | 0 | - | - | 0 |
| slice | r2 | 3/3 | 0 | - | - | 0 |
| slice | r3 | 3/3 | 0 | 3/3 | - | 0 |
| slice | r4 | 3/3 | 0 | - | - | 0 |
| slice | r5 | 3/3 | 0 | - | - | 0 |
| stock | c1 | 0/0 | 0 | - | - | 0 |
| stock | c2 | 0/0 | 0 | - | - | 0 |
| stock | f1 | 0/4 | 0 | - | 0 | 0 |
| stock | r1 | 0/3 | 0 | - | - | 0 |
| stock | r2 | 0/3 | 0 | - | - | 0 |
| stock | r3 | 0/3 | 0 | 0/3 | - | 0 |
| stock | r4 | 0/3 | 0 | - | - | 0 |
| stock | r5 | 0/3 | 0 | - | - | 0 |
| stock-compact | f1 | 0/4 | 1 | - | 16 | 0 |

Ratios are the named arm over its baseline; cost on the off-peak sheet (peak is exactly 2x every field). A cell with a failed compaction attempt has a cost that is a lower bound (the attempt is billed, its usage is not logged).
