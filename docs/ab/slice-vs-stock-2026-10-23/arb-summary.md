# slice-vs-stock summary

Batches: arb. Cells: 16 (16 valid). Arms: slice, stock.
Spend (peak sheet): $5.7403 over 795 turns; by batch {'warm': 0.003822, 'pilot': 0.962443, 'warm2': 0.000571, 'pilot2': 0.361849, 'batch': 3.308736, 'arb': 1.10288}.

## Decision (pre-registered rules, gates-svs.json)

- slice vs stock: **inconclusive** (a minimum is not met: 8 valid pairs < 19; f1: 1 pairs < 2; r1: 1 pairs < 2; r2: 1 pairs < 2; r3: 1 pairs < 2; r4: 1 pairs < 2; r5: 1 pairs < 2; c1: 1 pairs < 2; c2: 1 pairs < 2; 9 memory items < 18); quality floor holds
- arbitration: required: minimum not met: 8 valid pairs < 19; f1: 1 pairs < 2; r1: 1 pairs < 2; r2: 1 pairs < 2; r3: 1 pairs < 2; r4: 1 pairs < 2; r5: 1 pairs < 2; c1: 1 pairs < 2; c2: 1 pairs < 2; 9 memory items < 18

## slice vs stock

Pairs 8; L = 0.551, N = 1.234 (secondary: N_recall 1.243, N_coding 1.211), G = 1.116; sum ratio 0.749, median paired ratio 1.334; dS 0; memory 9 vs 9 correct of 9 items (dM 0), bad 0 vs 0 (dB 0). Insufficient: 8 valid pairs < 19; f1: 1 pairs < 2; r1: 1 pairs < 2; r2: 1 pairs < 2; r3: 1 pairs < 2; r4: 1 pairs < 2; r5: 1 pairs < 2; c1: 1 pairs < 2; c2: 1 pairs < 2; 9 memory items < 18.

| task | pairs/min | R (sum ratio) | median paired ratio | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| f1 | 1/2 | 0.551 | 0.551 | [0.5513] | 1/1 | 0 |
| r1 | 1/2 | 0.759 | 0.759 | [0.7589] | 1/1 | 0 |
| r2 | 1/2 | 1.397 | 1.397 | [1.397] | 1/1 | 0 |
| r3 | 1/2 | 1.565 | 1.565 | [1.5652] | 1/1 | 0 |
| r4 | 1/2 | 1.400 | 1.400 | [1.4001] | 1/1 | 0 |
| r5 | 1/2 | 1.279 | 1.279 | [1.2792] | 1/1 | 0 |
| c1 | 1/2 | 1.389 | 1.389 | [1.3893] | 1/1 | 0 |
| c2 | 1/2 | 1.055 | 1.055 | [1.0548] | 1/1 | 0 |

| memory item | arm correct | base correct | pairs |
|---|---|---|---|
| f1:build_id | 1 | 1 | 1 |
| f1:deploy | 1 | 1 | 1 |
| f1:lint_error | 1 | 1 | 1 |
| f1:trap | 1 | 1 | 1 |
| r1:exam | 1 | 1 | 1 |
| r2:exam | 1 | 1 | 1 |
| r3:exam | 1 | 1 | 1 |
| r4:exam | 1 | 1 | 1 |
| r5:exam | 1 | 1 | 1 |

## Context management and cost structure (valid cells, reported only)

| arm | task | cells | pass | median $ off-peak | median requests | median peak req tokens | median mean req tokens | median last-turn peak | median cache hit | summaries (failed) | prunes | compaction turns | ctx-limit errors | spills | slice folds | req/turn | steps/turn | step-cap cuts | same-turn rereads | memory correct/total (bad) | post-compaction memory failures | median wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| slice | c1 | 1 | 1 | 0.0723 | 91 | 36192 | 19311 | 36192 | 0.966 | 0 (0) | 0 | [[]] | 0 | 0 | 1 | 11.380 | 11.380 | 4 | 4 | 0/0 (0) | 0 | 616 |
| slice | c2 | 1 | 1 | 0.0043 | 8 | 14292 | 9012 | 14292 | 0.904 | 0 (0) | 0 | [[]] | 0 | 0 | 1 | 8.000 | 8.000 | 0 | 0 | 0/0 (0) | 0 | 22 |
| slice | f1 | 1 | 1 | 0.1300 | 240 | 43509 | 24774 | 40789 | 0.951 | 0 (0) | 0 | [[]] | 0 | 0 | 32 | 5.330 | 5.330 | 0 | 35 | 4/4 (0) | 0 | 636 |
| slice | r1 | 1 | 1 | 0.0041 | 17 | 10735 | 8381 | 10668 | 0.943 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 2.830 | 2.830 | 0 | 0 | 1/1 (0) | 0 | 39 |
| slice | r2 | 1 | 1 | 0.0110 | 27 | 15286 | 10325 | 13496 | 0.948 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 3.860 | 3.860 | 0 | 0 | 1/1 (0) | 0 | 84 |
| slice | r3 | 1 | 1 | 0.0060 | 17 | 12776 | 8791 | 12776 | 0.901 | 0 (0) | 0 | [[]] | 0 | 0 | 1 | 5.670 | 5.670 | 0 | 0 | 1/1 (0) | 0 | 35 |
| slice | r4 | 1 | 1 | 0.0032 | 15 | 7590 | 6148 | 7590 | 0.956 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 3.750 | 3.750 | 0 | 2 | 1/1 (0) | 0 | 33 |
| slice | r5 | 1 | 1 | 0.0051 | 10 | 17160 | 9866 | 7141 | 0.869 | 0 (0) | 0 | [[]] | 0 | 0 | 2 | 5.000 | 5.000 | 0 | 0 | 1/1 (0) | 0 | 29 |
| stock | c1 | 1 | 1 | 0.0521 | 48 | 72878 | 31611 | 72878 | 0.983 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 6.000 | 6.000 | 0 | 3 | 0/0 (0) | 0 | 292 |
| stock | c2 | 1 | 1 | 0.0041 | 8 | 12235 | 8439 | 12235 | 0.904 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 8.000 | 8.000 | 0 | 0 | 0/0 (0) | 0 | 22 |
| stock | f1 | 1 | 1 | 0.2359 | 213 | 234025 | 116961 | 234025 | 0.991 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 4.730 | 4.730 | 0 | 37 | 4/4 (0) | 0 | 426 |
| stock | r1 | 1 | 1 | 0.0053 | 20 | 12406 | 7592 | 12406 | 0.946 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 3.330 | 3.330 | 0 | 0 | 1/1 (0) | 0 | 52 |
| stock | r2 | 1 | 1 | 0.0079 | 22 | 16785 | 9711 | 16785 | 0.954 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 3.140 | 3.140 | 0 | 0 | 1/1 (0) | 0 | 69 |
| stock | r3 | 1 | 1 | 0.0038 | 13 | 11860 | 9798 | 11860 | 0.931 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 4.330 | 4.330 | 0 | 1 | 1/1 (0) | 0 | 28 |
| stock | r4 | 1 | 1 | 0.0023 | 12 | 6269 | 4412 | 6269 | 0.945 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 3.000 | 3.000 | 0 | 1 | 1/1 (0) | 0 | 27 |
| stock | r5 | 1 | 1 | 0.0040 | 10 | 12982 | 9569 | 12982 | 0.906 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 5.000 | 5.000 | 0 | 0 | 1/1 (0) | 0 | 28 |

## Recall sourcing, partial leaks and manipulation checks (valid cells, reported only)

| arm | task | exams recall-sourced | exams with a partial leak before them | r3 T1 fold | f1 digest tokens missing | cells whose cost is a lower bound (failed compactions) |
|---|---|---|---|---|---|---|
| slice | c1 | 0/0 | 0 | - | - | 0 |
| slice | c2 | 0/0 | 0 | - | - | 0 |
| slice | f1 | 2/2 | 0 | - | 0 | 0 |
| slice | r1 | 1/1 | 0 | - | - | 0 |
| slice | r2 | 1/1 | 0 | - | - | 0 |
| slice | r3 | 1/1 | 0 | 1/1 | - | 0 |
| slice | r4 | 1/1 | 0 | - | - | 0 |
| slice | r5 | 1/1 | 0 | - | - | 0 |
| stock | c1 | 0/0 | 0 | - | - | 0 |
| stock | c2 | 0/0 | 0 | - | - | 0 |
| stock | f1 | 0/2 | 0 | - | 0 | 0 |
| stock | r1 | 0/1 | 0 | - | - | 0 |
| stock | r2 | 0/1 | 0 | - | - | 0 |
| stock | r3 | 0/1 | 0 | 0/1 | - | 0 |
| stock | r4 | 0/1 | 0 | - | - | 0 |
| stock | r5 | 0/1 | 0 | - | - | 0 |

Ratios are the named arm over its baseline; cost on the off-peak sheet (peak is exactly 2x every field). A cell with a failed compaction attempt has a cost that is a lower bound (the attempt is billed, its usage is not logged).
