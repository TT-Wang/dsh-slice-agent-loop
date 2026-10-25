# svs2 ablation summary

New batches: arb; baseline: imported cells (baseline). New cells 3 (3 valid). Arms: c.

Caveat: cross-batch: the baseline cells ran on 2026-10-23, the new arms on another day, with no concurrent STOCK or SLICE control; provider-side variance between the days (latency, cache retention, routing) is not separable from an arm effect. B/A, C/B and C/A are within one batch.
Spend (peak sheet): $6.2448 over 847 turns; by batch {'warm': 0.005244, 'pilot': 0.707954, 'batch': 4.637828, 'arb': 0.893731}.

## Interpretation per arm (pre-registered rules, gates-svs2.json)

| arm | interpretation | N_code (c1, c2) | R_f1 | N_code3 (+r2) | dS | dM | dB | quality floor | arbitration |
|---|---|---|---|---|---|---|---|---|---|
| c | **inconclusive** (a minimum is not met: 3 valid pairs < 10; c1: 0 pairs < 2; c2: 0 pairs < 2; r2: 0 pairs < 2) | - | 0.695 | - | 0.0 | 0.0 | 0.0 | holds | required: minimum not met: 3 valid pairs < 10; c1: 0 pairs < 2; c2: 0 pairs < 2; r2: 0 pairs < 2 |

## c vs stock

Pairs 3 (arm cells per pair [1]); N_code -, R_f1 0.695, N_code3 -; sum ratio 0.695, median paired ratio 0.689; dS 0.0; memory 8.0 vs 8.0 of 8 items (dM 0.0), bad 0.0 vs 0.0 (dB 0.0). Insufficient: 3 valid pairs < 10; c1: 0 pairs < 2; c2: 0 pairs < 2; r2: 0 pairs < 2.

| task | pairs/min | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 0/2 | - | - | [] | 0/0 | 0 |
| c2 | 0/2 | - | - | [] | 0/0 | 0 |
| r2 | 0/2 | - | - | [] | 0/0 | 0 |
| f1 | 3/2 | 0.695 | 0.689 | [0.5292, 0.9316, 0.6889] | 3.0/3.0 | 0.0 |

- dropped: c1.r1: no valid c cell
- dropped: c1.r2: no valid c cell
- dropped: c1.r3: no valid c cell
- dropped: c1.r4: no valid c cell
- dropped: c2.r1: no valid c cell
- dropped: c2.r2: no valid c cell
- dropped: c2.r3: no valid c cell
- dropped: c2.r4: no valid c cell
- dropped: r2.r1: no valid c cell
- dropped: r2.r2: no valid c cell
- dropped: r2.r3: no valid c cell
- dropped: r2.r4: no valid c cell
- dropped: f1.r3: memory exclusion

## c vs slice

Pairs 3 (arm cells per pair [1]); N_code -, R_f1 1.137, N_code3 -; sum ratio 1.137, median paired ratio 1.220; dS 0.0; memory 8.0 vs 8.0 of 8 items (dM 0.0), bad 0.0 vs 0.0 (dB 0.0). Insufficient: 3 valid pairs < 10; c1: 0 pairs < 2; c2: 0 pairs < 2; r2: 0 pairs < 2.

| task | pairs/min | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 0/2 | - | - | [] | 0/0 | 0 |
| c2 | 0/2 | - | - | [] | 0/0 | 0 |
| r2 | 0/2 | - | - | [] | 0/0 | 0 |
| f1 | 3/2 | 1.137 | 1.220 | [0.9454, 1.2198, 1.2498] | 3.0/3.0 | 0.0 |

- dropped: c1.r1: no valid c cell
- dropped: c1.r2: no valid c cell
- dropped: c1.r3: no valid c cell
- dropped: c1.r4: no valid c cell
- dropped: c2.r1: no valid c cell
- dropped: c2.r2: no valid c cell
- dropped: c2.r3: no valid c cell
- dropped: c2.r4: no valid c cell
- dropped: r2.r1: no valid c cell
- dropped: r2.r2: no valid c cell
- dropped: r2.r3: no valid c cell
- dropped: r2.r4: no valid c cell
- dropped: f1.r3: memory exclusion

## Re-read classes (sums over valid cells; reported)

| arm | task | cells | turns | first | cross-turn | same-turn | after own edit | reads | edits/writes | bash writes | FS_NOT_OBSERVED | FS_STALE_VERSION |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| c | f1 | 3 | 135 | 108 | 95 | 0 | 85 | 288 | 149 | 7 | 16 | 0 |
| slice | c1 | 4 | 32 | 8 | 59 | 0 | 28 | 95 | 168 | 90 | 1 | 0 |
| slice | c2 | 4 | 4 | 34 | 0 | 0 | 12 | 46 | 21 | 5 | 0 | 0 |
| slice | f1 | 3 | 135 | 109 | 105 | 118 | 39 | 371 | 98 | 61 | 2 | 0 |
| slice | r2 | 4 | 28 | 8 | 8 | 0 | 3 | 19 | 21 | 15 | 0 | 0 |
| stock | c1 | 4 | 32 | 6 | 27 | 10 | 9 | 52 | 84 | 23 | 1 | 0 |
| stock | c2 | 4 | 4 | 23 | 0 | 0 | 5 | 28 | 25 | 6 | 4 | 0 |
| stock | f1 | 3 | 135 | 108 | 107 | 0 | 90 | 305 | 139 | 3 | 4 | 0 |
| stock | r2 | 4 | 28 | 6 | 4 | 0 | 3 | 13 | 27 | 6 | 2 | 0 |

## Cost structure and context (valid cells; reported)

| arm | task | cells | pass | mean $ peak | median requests | req/turn | steps/turn | step-cap cuts (of turns) | cache hit | peak req tokens | mean req tokens | folds | kept-raw entries | memory correct/total (bad) | median wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| c | f1 | 3 | 3 | 0.2979 | 251 | 5.580 | 5.580 | 0 of 135 | 0.965 | 59830 | 34184 | 96 | 129 | 12/12 (0) | 542 |
| slice | c1 | 4 | 4 | 0.1624 | 91.500 | 11.440 | 11.440 | 14 of 32 | 0.966 | 38642.500 | 20474 | 6 | 0 | 0/0 (0) | 824 |
| slice | c2 | 4 | 4 | 0.0087 | 7.000 | 7.000 | 7.000 | 0 of 4 | 0.898 | 14637.000 | 9632 | 1 | 0 | 0/0 (0) | 24 |
| slice | f1 | 3 | 3 | 0.2619 | 265 | 5.890 | 5.890 | 0 of 135 | 0.958 | 43301 | 24774 | 40 | 0 | 12/12 (0) | 542 |
| slice | r2 | 4 | 4 | 0.0196 | 27.000 | 3.860 | 3.860 | 0 of 28 | 0.948 | 15237.500 | 10379 | 0 | 0 | 4/4 (0) | 82 |
| stock | c1 | 4 | 4 | 0.1023 | 47.500 | 5.940 | 5.940 | 0 of 32 | 0.983 | 74338.000 | 34361 | 0 | 0 | 0/0 (0) | 341 |
| stock | c2 | 4 | 4 | 0.0087 | 8.000 | 8.000 | 8.000 | 0 of 4 | 0.908 | 11609.500 | 8279 | 0 | 0 | 0/0 (0) | 30 |
| stock | f1 | 3 | 3 | 0.4287 | 213 | 4.730 | 4.730 | 0 of 135 | 0.991 | 234025 | 116231 | 0 | 0 | 12/12 (0) | 426 |
| stock | r2 | 4 | 4 | 0.0215 | 24.000 | 3.425 | 3.425 | 0 of 28 | 0.960 | 20463.500 | 11744 | 0 | 0 | 4/4 (0) | 94 |

Ratios are the named arm over the other; cost on the off-peak sheet (peak is exactly 2x every field). The arm side of a pair is the mean of its valid cells at that rep index.
