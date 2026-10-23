> Mock data from the offline dry run `offline2` (one rep): it shows the report runs end to end and the minimum-pairs path; its cost ratios come from the mock's fixed usage samples and mean nothing.

# slice-vs-stock summary

Batches: offline2. Cells: 27 (27 valid). Arms: slice, stock, stock-compact.

## Warmup (hello): step-1 cache read from rep 2 on, at least the arm's minimum

- slice: rep 1 1000
- stock: rep 1 1000
- stock-compact: rep 1 1000

## Decision (pre-registered rules, gates-svs.json)

- slice vs stock: **inconclusive** (a minimum is not met: 8 valid pairs < 19; f1: 1 pairs < 2; r1: 1 pairs < 2; r2: 1 pairs < 2; r3: 1 pairs < 2; r4: 1 pairs < 2; r5: 1 pairs < 2; c1: 1 pairs < 2; c2: 1 pairs < 2; 9 memory items < 18); quality floor holds
- arbitration: required: minimum not met: 8 valid pairs < 19; f1: 1 pairs < 2; r1: 1 pairs < 2; r2: 1 pairs < 2; r3: 1 pairs < 2; r4: 1 pairs < 2; r5: 1 pairs < 2; c1: 1 pairs < 2; c2: 1 pairs < 2; 9 memory items < 18

## slice vs stock

Pairs 8; L = 1.250, N = 1.210, G = 1.215; sum ratio 1.249, median paired ratio 1.248; dS 0; memory 0 vs 0 correct of 9 items (dM 0), bad 0 vs 0 (dB 0). Insufficient: 8 valid pairs < 19; f1: 1 pairs < 2; r1: 1 pairs < 2; r2: 1 pairs < 2; r3: 1 pairs < 2; r4: 1 pairs < 2; r5: 1 pairs < 2; c1: 1 pairs < 2; c2: 1 pairs < 2; 9 memory items < 18.

| task | pairs/min | R (sum ratio) | median paired ratio | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| f1 | 1/2 | 1.250 | 1.250 | [1.2504] | 0/0 | 0 |
| r1 | 1/2 | 1.326 | 1.326 | [1.3256] | 0/0 | 0 |
| r2 | 1/2 | 1.281 | 1.281 | [1.2806] | 0/0 | 0 |
| r3 | 1/2 | 1.196 | 1.196 | [1.1959] | 0/0 | 0 |
| r4 | 1/2 | 1.185 | 1.185 | [1.185] | 0/0 | 0 |
| r5 | 1/2 | 1.246 | 1.246 | [1.2464] | 0/0 | 0 |
| c1 | 1/2 | 1.264 | 1.264 | [1.264] | 0/0 | 0 |
| c2 | 1/2 | 1.000 | 1.000 | [1.0] | 0/0 | 0 |

| memory item | arm correct | base correct | pairs |
|---|---|---|---|
| f1:build_id | 0 | 0 | 1 |
| f1:deploy | 0 | 0 | 1 |
| f1:lint_error | 0 | 0 | 1 |
| f1:trap | 0 | 0 | 1 |
| r1:exam | 0 | 0 | 1 |
| r2:exam | 0 | 0 | 1 |
| r3:exam | 0 | 0 | 1 |
| r4:exam | 0 | 0 | 1 |
| r5:exam | 0 | 0 | 1 |

## stock-compact vs stock (inconclusive (secondary, not a decision))

Pairs 8; L = 1.015, N = 1.000, G = 1.002; sum ratio 1.010, median paired ratio 1.000; dS 0; memory 0 vs 0 correct of 9 items (dM 0), bad 0 vs 0 (dB 0). Insufficient: 8 valid pairs < 19; f1: 1 pairs < 2; r1: 1 pairs < 2; r2: 1 pairs < 2; r3: 1 pairs < 2; r4: 1 pairs < 2; r5: 1 pairs < 2; c1: 1 pairs < 2; c2: 1 pairs < 2; 9 memory items < 18.

| task | pairs/min | R (sum ratio) | median paired ratio | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| f1 | 1/2 | 1.015 | 1.015 | [1.0148] | 0/0 | 0 |
| r1 | 1/2 | 1.000 | 1.000 | [1.0] | 0/0 | 0 |
| r2 | 1/2 | 1.000 | 1.000 | [1.0] | 0/0 | 0 |
| r3 | 1/2 | 1.000 | 1.000 | [1.0] | 0/0 | 0 |
| r4 | 1/2 | 1.000 | 1.000 | [1.0] | 0/0 | 0 |
| r5 | 1/2 | 1.000 | 1.000 | [1.0] | 0/0 | 0 |
| c1 | 1/2 | 1.000 | 1.000 | [1.0] | 0/0 | 0 |
| c2 | 1/2 | 1.000 | 1.000 | [1.0] | 0/0 | 0 |

| memory item | arm correct | base correct | pairs |
|---|---|---|---|
| f1:build_id | 0 | 0 | 1 |
| f1:deploy | 0 | 0 | 1 |
| f1:lint_error | 0 | 0 | 1 |
| f1:trap | 0 | 0 | 1 |
| r1:exam | 0 | 0 | 1 |
| r2:exam | 0 | 0 | 1 |
| r3:exam | 0 | 0 | 1 |
| r4:exam | 0 | 0 | 1 |
| r5:exam | 0 | 0 | 1 |

## slice vs stock-compact (inconclusive (secondary, not a decision))

Pairs 8; L = 1.232, N = 1.210, G = 1.212; sum ratio 1.236, median paired ratio 1.239; dS 0; memory 0 vs 0 correct of 9 items (dM 0), bad 0 vs 0 (dB 0). Insufficient: 8 valid pairs < 19; f1: 1 pairs < 2; r1: 1 pairs < 2; r2: 1 pairs < 2; r3: 1 pairs < 2; r4: 1 pairs < 2; r5: 1 pairs < 2; c1: 1 pairs < 2; c2: 1 pairs < 2; 9 memory items < 18.

| task | pairs/min | R (sum ratio) | median paired ratio | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| f1 | 1/2 | 1.232 | 1.232 | [1.2322] | 0/0 | 0 |
| r1 | 1/2 | 1.326 | 1.326 | [1.3256] | 0/0 | 0 |
| r2 | 1/2 | 1.281 | 1.281 | [1.2806] | 0/0 | 0 |
| r3 | 1/2 | 1.196 | 1.196 | [1.1959] | 0/0 | 0 |
| r4 | 1/2 | 1.185 | 1.185 | [1.185] | 0/0 | 0 |
| r5 | 1/2 | 1.246 | 1.246 | [1.2464] | 0/0 | 0 |
| c1 | 1/2 | 1.264 | 1.264 | [1.264] | 0/0 | 0 |
| c2 | 1/2 | 1.000 | 1.000 | [1.0] | 0/0 | 0 |

| memory item | arm correct | base correct | pairs |
|---|---|---|---|
| f1:build_id | 0 | 0 | 1 |
| f1:deploy | 0 | 0 | 1 |
| f1:lint_error | 0 | 0 | 1 |
| f1:trap | 0 | 0 | 1 |
| r1:exam | 0 | 0 | 1 |
| r2:exam | 0 | 0 | 1 |
| r3:exam | 0 | 0 | 1 |
| r4:exam | 0 | 0 | 1 |
| r5:exam | 0 | 0 | 1 |

## Context management and cost structure (valid cells, reported only)

| arm | task | cells | pass | median $ off-peak | median requests | median peak req tokens | median mean req tokens | median last-turn peak | median cache hit | summaries (failed) | prunes | compaction turns | ctx-limit errors | spills | slice folds | req/turn | steps/turn | step-cap cuts | same-turn rereads | memory correct/total (bad) | post-compaction memory failures | median wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| slice | c1 | 1 | 0 | 0.0011 | 33 | 1109 | 1102 | 1109 | 0.907 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 4.120 | 4.120 | 0 | 5 | 0/0 (0) | 0 | 19 |
| slice | c2 | 1 | 0 | 0.0001 | 4 | 1109 | 1102 | 1109 | 0.907 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 4.000 | 4.000 | 0 | 1 | 0/0 (0) | 0 | 3 |
| slice | f1 | 1 | 0 | 0.0101 | 296 | 1109 | 1102 | 1109 | 0.908 | 0 (0) | 0 | [[]] | 0 | 0 | 96 | 4.850 | 4.850 | 0 | 56 | 0/4 (0) | 0 | 183 |
| slice | hello | 1 | 1 | 0.0001 | 2 | 1109 | 1104 | 1109 | 0.905 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 2.000 | 2.000 | 0 | 0 | 0/0 (0) | 0 | 4 |
| slice | r1 | 1 | 0 | 0.0007 | 20 | 1109 | 1103 | 1109 | 0.907 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 3.330 | 3.330 | 0 | 1 | 0/1 (0) | 0 | 17 |
| slice | r2 | 1 | 0 | 0.0009 | 27 | 1109 | 1102 | 1109 | 0.907 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 3.860 | 3.860 | 0 | 2 | 0/1 (0) | 0 | 16 |
| slice | r3 | 1 | 0 | 0.0004 | 12 | 1109 | 1102 | 1109 | 0.907 | 0 (0) | 0 | [[]] | 0 | 0 | 2 | 4.000 | 4.000 | 0 | 2 | 0/1 (0) | 0 | 10 |
| slice | r4 | 1 | 0 | 0.0006 | 19 | 1109 | 1102 | 1109 | 0.907 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 4.750 | 4.750 | 0 | 3 | 0/1 (0) | 0 | 14 |
| slice | r5 | 1 | 0 | 0.0002 | 5 | 1109 | 1104 | 1109 | 0.906 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 2.500 | 2.500 | 0 | 0 | 0/1 (0) | 0 | 7 |
| stock | c1 | 1 | 0 | 0.0009 | 26 | 1109 | 1103 | 1109 | 0.907 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 3.250 | 3.250 | 0 | 5 | 0/0 (0) | 0 | 17 |
| stock | c2 | 1 | 0 | 0.0001 | 4 | 1109 | 1102 | 1109 | 0.907 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 4.000 | 4.000 | 0 | 1 | 0/0 (0) | 0 | 3 |
| stock | f1 | 1 | 0 | 0.0081 | 236 | 1109 | 1102 | 1109 | 0.907 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 3.870 | 3.870 | 0 | 56 | 0/4 (0) | 0 | 163 |
| stock | hello | 1 | 1 | 0.0001 | 2 | 1109 | 1104 | 1109 | 0.905 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 2.000 | 2.000 | 0 | 0 | 0/0 (0) | 0 | 4 |
| stock | r1 | 1 | 0 | 0.0005 | 15 | 1109 | 1104 | 1109 | 0.906 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 2.500 | 2.500 | 0 | 1 | 0/1 (0) | 0 | 14 |
| stock | r2 | 1 | 0 | 0.0007 | 21 | 1109 | 1103 | 1109 | 0.907 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 3.000 | 3.000 | 0 | 2 | 0/1 (0) | 0 | 16 |
| stock | r3 | 1 | 0 | 0.0003 | 10 | 1109 | 1103 | 1109 | 0.907 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 3.330 | 3.330 | 0 | 2 | 0/1 (0) | 0 | 9 |
| stock | r4 | 1 | 0 | 0.0005 | 16 | 1109 | 1102 | 1109 | 0.907 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 4.000 | 4.000 | 0 | 3 | 0/1 (0) | 0 | 10 |
| stock | r5 | 1 | 0 | 0.0001 | 4 | 1109 | 1104 | 1109 | 0.905 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 2.000 | 2.000 | 0 | 0 | 0/1 (0) | 0 | 6 |
| stock-compact | c1 | 1 | 0 | 0.0009 | 26 | 1109 | 1103 | 1109 | 0.907 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 3.250 | 3.250 | 0 | 5 | 0/0 (0) | 0 | 18 |
| stock-compact | c2 | 1 | 0 | 0.0001 | 4 | 1109 | 1102 | 1109 | 0.907 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 4.000 | 4.000 | 0 | 1 | 0/0 (0) | 0 | 3 |
| stock-compact | f1 | 1 | 0 | 0.0082 | 236 | 1109 | 1102 | 1109 | 0.907 | 3 (0) | 88 | [[26, 39, 52]] | 0 | 0 | 0 | 3.870 | 3.870 | 0 | 56 | 0/4 (0) | 4 | 140 |
| stock-compact | hello | 1 | 1 | 0.0001 | 2 | 1109 | 1104 | 1109 | 0.905 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 2.000 | 2.000 | 0 | 0 | 0/0 (0) | 0 | 3 |
| stock-compact | r1 | 1 | 0 | 0.0005 | 15 | 1109 | 1104 | 1109 | 0.906 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 2.500 | 2.500 | 0 | 1 | 0/1 (0) | 0 | 19 |
| stock-compact | r2 | 1 | 0 | 0.0007 | 21 | 1109 | 1103 | 1109 | 0.907 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 3.000 | 3.000 | 0 | 2 | 0/1 (0) | 0 | 16 |
| stock-compact | r3 | 1 | 0 | 0.0003 | 10 | 1109 | 1103 | 1109 | 0.907 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 3.330 | 3.330 | 0 | 2 | 0/1 (0) | 0 | 8 |
| stock-compact | r4 | 1 | 0 | 0.0005 | 16 | 1109 | 1102 | 1109 | 0.907 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 4.000 | 4.000 | 0 | 3 | 0/1 (0) | 0 | 16 |
| stock-compact | r5 | 1 | 0 | 0.0001 | 4 | 1109 | 1104 | 1109 | 0.905 | 0 (0) | 0 | [[]] | 0 | 0 | 0 | 2.000 | 2.000 | 0 | 0 | 0/1 (0) | 0 | 5 |

Ratios are the named arm over its baseline; cost on the off-peak sheet (peak is exactly 2x every field).
