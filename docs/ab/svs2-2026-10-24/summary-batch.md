# svs2 ablation summary

New batches: batch; baseline: imported cells (baseline). New cells 45 (45 valid). Arms: a, b, c.

Caveat: cross-batch: the baseline cells ran on 2026-10-23, the new arms on another day, with no concurrent STOCK or SLICE control; provider-side variance between the days (latency, cache retention, routing) is not separable from an arm effect. B/A, C/B and C/A are within one batch.
Spend (peak sheet): $5.3510 over 712 turns; by batch {'warm': 0.005244, 'pilot': 0.707954, 'batch': 4.637828}.

## Interpretation per arm (pre-registered rules, gates-svs2.json)

| arm | interpretation | N_code (c1, c2) | R_f1 | N_code3 (+r2) | dS | dM | dB | quality floor | arbitration |
|---|---|---|---|---|---|---|---|---|---|
| a | **does not fix the short-session overhead** (N_code 1.253 > 1.10 (R_f1 0.649 <= 0.80)) | 1.253 | 0.649 | 1.049 | 0.0 | 0.0 | 0.0 | holds | not required |
| b | **does not fix the short-session overhead** (N_code 1.193 > 1.10 (R_f1 0.555 <= 0.80)) | 1.193 | 0.555 | 1.098 | 0.0 | 0.0 | 0.0 | holds | not required |
| c | **fixes the short-session overhead** (N_code 1.023 <= 1.10 and R_f1 0.613 <= 0.80) | 1.023 | 0.613 | 0.953 | -1.0 | 0.0 | 0.0 | holds | required: quality floor at its margin (dS -1.0, dS_t {'c1': 0.0, 'c2': 0.0, 'r2': 0.0, 'f1': -1.0}, dM 0.0, dB 0.0) |

## Steps between arms (which change moves the cost; reported)

| step | kind | N_code | | R_f1 | | pairs |
|---|---|---|---|---|---|---|
| a/slice | cross-batch (baseline of 2026-10-23) | 0.994 | no measurable effect at this n | 1.062 | moves the cost up | 15 |
| b/a | within the batch | 0.952 | no measurable effect at this n | 0.856 | moves the cost down | 15 |
| c/b | within the batch | 0.858 | moves the cost down | 1.103 | moves the cost up | 15 |
| c/a | within the batch | 0.817 | moves the cost down | 0.944 | moves the cost down | 15 |

## a vs stock

Pairs 15 (arm cells per pair [1]); N_code 1.253, R_f1 0.649, N_code3 1.049; sum ratio 0.887, median paired ratio 0.920; dS 0.0; memory 16.0 vs 16.0 of 16 items (dM 0.0), bad 0.0 vs 0.0 (dB 0.0).

| task | pairs/min | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 4/2 | 1.662 | 1.627 | [1.994, 1.6852, 1.4721, 1.568] | 4.0/4.0 | 0.0 |
| c2 | 4/2 | 0.945 | 1.035 | [1.0715, 1.0394, 0.7044, 1.0315] | 4.0/4.0 | 0.0 |
| r2 | 4/2 | 0.735 | 0.756 | [0.9196, 0.6736, 0.6339, 0.8388] | 4.0/4.0 | 0.0 |
| f1 | 3/2 | 0.649 | 0.591 | [0.5565, 0.8569, 0.5907] | 3.0/3.0 | 0.0 |

## a vs slice

Pairs 15 (arm cells per pair [1]); N_code 0.994, R_f1 1.062, N_code3 0.928; sum ratio 1.041, median paired ratio 0.978; dS 0.0; memory 15.0 vs 15.0 of 15 items (dM 0.0), bad 0.0 vs 0.0 (dB 0.0).

| task | pairs/min | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 4/2 | 1.047 | 1.066 | [0.9421, 1.1163, 1.0154, 1.1286] | 4.0/4.0 | 0.0 |
| c2 | 4/2 | 0.944 | 0.945 | [0.9121, 1.0302, 0.8667, 0.978] | 4.0/4.0 | 0.0 |
| r2 | 4/2 | 0.808 | 0.865 | [0.8298, 0.9333, 0.9009, 0.6004] | 4.0/4.0 | 0.0 |
| f1 | 3/2 | 1.062 | 1.072 | [0.9942, 1.122, 1.0716] | 3.0/3.0 | 0.0 |

- dropped: r2.r3: memory exclusion

## b vs stock

Pairs 15 (arm cells per pair [1]); N_code 1.193, R_f1 0.555, N_code3 1.098; sum ratio 0.769, median paired ratio 0.996; dS 0.0; memory 14.0 vs 14.0 of 14 items (dM 0.0), bad 0.0 vs 0.0 (dB 0.0).

| task | pairs/min | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 4/2 | 1.385 | 1.446 | [1.881, 0.9053, 1.5208, 1.3718] | 4.0/4.0 | 0.0 |
| c2 | 4/2 | 1.027 | 1.020 | [1.3253, 0.9958, 0.794, 1.0443] | 4.0/4.0 | 0.0 |
| r2 | 4/2 | 0.931 | 1.009 | [1.2674, 0.7512, 0.6323, 1.4421] | 4.0/4.0 | 0.0 |
| f1 | 3/2 | 0.555 | 0.522 | [0.522, 0.6643, 0.5094] | 3.0/3.0 | 0.0 |

- dropped: r2.r2: memory exclusion
- dropped: r2.r4: memory exclusion

## b vs slice

Pairs 15 (arm cells per pair [1]); N_code 0.946, R_f1 0.909, N_code3 0.971; sum ratio 0.902, median paired ratio 0.987; dS 0.0; memory 13.0 vs 13.0 of 13 items (dM 0.0), bad 0.0 vs 0.0 (dB 0.0).

| task | pairs/min | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 4/2 | 0.873 | 0.938 | [0.8887, 0.5997, 1.049, 0.9874] | 4.0/4.0 | 0.0 |
| c2 | 4/2 | 1.026 | 0.989 | [1.1281, 0.9871, 0.9769, 0.99] | 4.0/4.0 | 0.0 |
| r2 | 4/2 | 1.024 | 1.036 | [1.1437, 1.0407, 0.8986, 1.0322] | 4.0/4.0 | 0.0 |
| f1 | 3/2 | 0.909 | 0.924 | [0.9325, 0.8698, 0.9241] | 3.0/3.0 | 0.0 |

- dropped: r2.r2: memory exclusion
- dropped: r2.r3: memory exclusion
- dropped: r2.r4: memory exclusion

## c vs stock

Pairs 15 (arm cells per pair [1]); N_code 1.023, R_f1 0.613, N_code3 0.953; sum ratio 0.739, median paired ratio 0.869; dS -1.0; memory 16.0 vs 16.0 of 16 items (dM 0.0), bad 0.0 vs 0.0 (dB 0.0).

| task | pairs/min | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 4/2 | 1.099 | 1.055 | [1.0614, 0.8082, 1.4856, 1.0487] | 4.0/4.0 | 0.0 |
| c2 | 4/2 | 0.953 | 0.891 | [1.1973, 0.914, 0.8482, 0.8685] | 4.0/4.0 | 0.0 |
| r2 | 4/2 | 0.826 | 0.921 | [1.3755, 0.6741, 0.4818, 1.1678] | 4.0/4.0 | 0.0 |
| f1 | 3/2 | 0.613 | 0.572 | [0.5361, 0.7739, 0.5722] | 2.0/3.0 | -1.0 |

## c vs slice

Pairs 15 (arm cells per pair [1]); N_code 0.812, R_f1 1.003, N_code3 0.843; sum ratio 0.867, median paired ratio 0.934; dS -1.0; memory 15.0 vs 15.0 of 15 items (dM 0.0), bad 0.0 vs 0.0 (dB 0.0).

| task | pairs/min | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 4/2 | 0.693 | 0.645 | [0.5015, 0.5354, 1.0247, 0.7548] | 4.0/4.0 | 0.0 |
| c2 | 4/2 | 0.952 | 0.963 | [1.0192, 0.906, 1.0436, 0.8234] | 4.0/4.0 | 0.0 |
| r2 | 4/2 | 0.909 | 0.885 | [1.2412, 0.9339, 0.6847, 0.8359] | 4.0/4.0 | 0.0 |
| f1 | 3/2 | 1.003 | 1.013 | [0.9578, 1.0132, 1.038] | 2.0/3.0 | -1.0 |

- dropped: r2.r3: memory exclusion

## Re-read classes (sums over valid cells; reported)

| arm | task | cells | turns | first | cross-turn | same-turn | after own edit | reads | edits/writes | bash writes | FS_NOT_OBSERVED | FS_STALE_VERSION |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| a | c1 | 4 | 32 | 8 | 55 | 0 | 19 | 82 | 160 | 100 | 0 | 0 |
| a | c2 | 4 | 4 | 34 | 0 | 0 | 0 | 34 | 20 | 6 | 0 | 0 |
| a | f1 | 3 | 135 | 110 | 101 | 84 | 5 | 300 | 93 | 57 | 0 | 0 |
| a | r2 | 4 | 28 | 8 | 6 | 0 | 0 | 14 | 20 | 8 | 0 | 0 |
| b | c1 | 4 | 32 | 8 | 54 | 0 | 14 | 76 | 128 | 71 | 0 | 0 |
| b | c2 | 4 | 4 | 33 | 0 | 0 | 0 | 33 | 20 | 6 | 0 | 0 |
| b | f1 | 3 | 135 | 107 | 98 | 21 | 26 | 252 | 88 | 60 | 7 | 0 |
| b | r2 | 4 | 28 | 9 | 8 | 0 | 2 | 19 | 21 | 17 | 0 | 0 |
| c | c1 | 4 | 32 | 8 | 27 | 1 | 8 | 44 | 156 | 45 | 22 | 0 |
| c | c2 | 4 | 4 | 32 | 0 | 0 | 1 | 33 | 20 | 7 | 0 | 0 |
| c | f1 | 3 | 135 | 108 | 105 | 0 | 45 | 258 | 144 | 9 | 6 | 0 |
| c | r2 | 4 | 28 | 6 | 4 | 0 | 4 | 14 | 24 | 8 | 2 | 0 |
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
| a | c1 | 4 | 4 | 0.1701 | 89.000 | 11.120 | 11.120 | 10 of 32 | 0.966 | 44383.000 | 21028 | 5 | 0 | 0/0 (0) | 698 |
| a | c2 | 4 | 4 | 0.0082 | 6.500 | 6.500 | 6.500 | 0 of 4 | 0.900 | 13604.000 | 9493 | 0 | 0 | 0/0 (0) | 24 |
| a | f1 | 3 | 3 | 0.2782 | 250 | 5.560 | 5.560 | 0 of 135 | 0.955 | 48809 | 27049 | 77 | 0 | 12/12 (0) | 546 |
| a | r2 | 4 | 4 | 0.0158 | 24.500 | 3.500 | 3.500 | 0 of 28 | 0.945 | 13939.500 | 9643 | 0 | 0 | 4/4 (0) | 66 |
| b | c1 | 4 | 4 | 0.1417 | 76.500 | 9.560 | 9.560 | 4 of 32 | 0.961 | 36205.500 | 18625 | 4 | 0 | 0/0 (0) | 699 |
| b | c2 | 4 | 4 | 0.0089 | 7.500 | 7.500 | 7.500 | 0 of 4 | 0.926 | 13146.500 | 9727 | 3 | 0 | 0/0 (0) | 26 |
| b | f1 | 3 | 3 | 0.2380 | 225 | 5.000 | 5.000 | 0 of 135 | 0.946 | 36706 | 22425 | 96 | 0 | 12/12 (0) | 459 |
| b | r2 | 4 | 4 | 0.0200 | 26.500 | 3.785 | 3.785 | 0 of 28 | 0.951 | 15787.000 | 10252 | 0 | 0 | 4/4 (0) | 80 |
| c | c1 | 4 | 4 | 0.1124 | 42.500 | 5.315 | 5.315 | 1 of 32 | 0.967 | 62821.000 | 29575 | 2 | 28 | 0/0 (0) | 306 |
| c | c2 | 4 | 4 | 0.0083 | 6.500 | 6.500 | 6.500 | 0 of 4 | 0.910 | 12847.000 | 9887 | 0 | 0 | 0/0 (0) | 23 |
| c | f1 | 3 | 2 | 0.2626 | 224 | 4.980 | 4.980 | 0 of 135 | 0.961 | 57429 | 31429 | 96 | 126 | 12/12 (0) | 429 |
| c | r2 | 4 | 4 | 0.0178 | 23.000 | 3.285 | 3.285 | 0 of 28 | 0.947 | 16145.000 | 11123 | 0 | 12 | 4/4 (0) | 70 |
| slice | c1 | 4 | 4 | 0.1624 | 91.500 | 11.440 | 11.440 | 14 of 32 | 0.966 | 38642.500 | 20474 | 6 | 0 | 0/0 (0) | 824 |
| slice | c2 | 4 | 4 | 0.0087 | 7.000 | 7.000 | 7.000 | 0 of 4 | 0.898 | 14637.000 | 9632 | 1 | 0 | 0/0 (0) | 24 |
| slice | f1 | 3 | 3 | 0.2619 | 265 | 5.890 | 5.890 | 0 of 135 | 0.958 | 43301 | 24774 | 40 | 0 | 12/12 (0) | 542 |
| slice | r2 | 4 | 4 | 0.0196 | 27.000 | 3.860 | 3.860 | 0 of 28 | 0.948 | 15237.500 | 10379 | 0 | 0 | 4/4 (0) | 82 |
| stock | c1 | 4 | 4 | 0.1023 | 47.500 | 5.940 | 5.940 | 0 of 32 | 0.983 | 74338.000 | 34361 | 0 | 0 | 0/0 (0) | 341 |
| stock | c2 | 4 | 4 | 0.0087 | 8.000 | 8.000 | 8.000 | 0 of 4 | 0.908 | 11609.500 | 8279 | 0 | 0 | 0/0 (0) | 30 |
| stock | f1 | 3 | 3 | 0.4287 | 213 | 4.730 | 4.730 | 0 of 135 | 0.991 | 234025 | 116231 | 0 | 0 | 12/12 (0) | 426 |
| stock | r2 | 4 | 4 | 0.0215 | 24.000 | 3.425 | 3.425 | 0 of 28 | 0.960 | 20463.500 | 11744 | 0 | 0 | 4/4 (0) | 94 |

Ratios are the named arm over the other; cost on the off-peak sheet (peak is exactly 2x every field). The arm side of a pair is the mean of its valid cells at that rep index.
