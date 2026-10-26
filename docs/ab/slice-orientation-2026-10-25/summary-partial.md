# slice-orientation test: D against STOCK, B and SLICE

D cells: batch, warm; imported: STOCK and SLICE (2026-10-23), B (svs2 batch).

Caveat: cross-batch: STOCK and SLICE ran on 2026-10-23, B on 2026-10-24/25, D on 2026-10-25; no concurrent control. Provider-side variance between the days is not separable from an arm effect. n = 3-4 per task.

Spend (peak sheet): $0.1305 over 9 turns; by batch {'warm': 0.002374, 'batch': 0.1281}.

## Verdict: **inconclusive: do not ship (1 valid pairs < 10; c1: 0 pairs < 2; c2: 1 pairs < 2; r2: 0 pairs < 2; f1: 0 pairs < 2; 0 memory items < 8; vs B: 1 valid pairs < 10; vs B: c1: 0 pairs < 2; vs B: c2: 1 pairs < 2; vs B: r2: 0 pairs < 2; vs B: f1: 0 pairs < 2; vs B: 0 memory items < 8)**

| condition | holds | value |
|---|---|---|
| S1 cost | False | N_code(d) - / N_code(b) 1.193 = - (<= 1.05); R_f1(d) - (<= 0.70) |
| S2 probes | True | 0 real out-of-workspace probes (max 0) |
| S3 empty turns | True | 0 (max 0) |
| S4 quality floor | True | dS 0.0, dS_t {'c1': 0, 'c2': 0.0, 'r2': 0, 'f1': 0}, dM 0, dB 0 |

## d vs stock

Pairs 1; N_code -, R_f1 -, N_code3 -; dS 0.0; memory 0 vs 0 of 0 items (dM 0), bad 0 vs 0 (dB 0). Insufficient: 1 valid pairs < 10; c1: 0 pairs < 2; c2: 1 pairs < 2; r2: 0 pairs < 2; f1: 0 pairs < 2; 0 memory items < 8.

| task | pairs | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 0 | - | - | [] | 0/0 | 0 |
| c2 | 1 | 1.063 | 1.063 | [1.0635] | 1.0/1.0 | 0.0 |
| r2 | 0 | - | - | [] | 0/0 | 0 |
| f1 | 0 | - | - | [] | 0/0 | 0 |

- dropped: c1.r1: no valid d cell
- dropped: c1.r2: no valid d cell
- dropped: c1.r3: no valid d cell
- dropped: c1.r4: no valid d cell
- dropped: c2.r2: no valid d cell
- dropped: c2.r3: no valid d cell
- dropped: c2.r4: no valid d cell
- dropped: r2.r1: no valid d cell
- dropped: r2.r2: no valid d cell
- dropped: r2.r3: no valid d cell
- dropped: r2.r4: no valid d cell
- dropped: f1.r1: no valid d cell
- dropped: f1.r2: no valid d cell
- dropped: f1.r3: no valid d cell

## d vs b

Pairs 1; N_code -, R_f1 -, N_code3 -; dS 0.0; memory 0 vs 0 of 0 items (dM 0), bad 0 vs 0 (dB 0). Insufficient: 1 valid pairs < 10; c1: 0 pairs < 2; c2: 1 pairs < 2; r2: 0 pairs < 2; f1: 0 pairs < 2; 0 memory items < 8.

| task | pairs | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 0 | - | - | [] | 0/0 | 0 |
| c2 | 1 | 0.802 | 0.802 | [0.8025] | 1.0/1.0 | 0.0 |
| r2 | 0 | - | - | [] | 0/0 | 0 |
| f1 | 0 | - | - | [] | 0/0 | 0 |

- dropped: c1.r1: no valid d cell
- dropped: c1.r2: no valid d cell
- dropped: c1.r3: no valid d cell
- dropped: c1.r4: no valid d cell
- dropped: c2.r2: no valid d cell
- dropped: c2.r3: no valid d cell
- dropped: c2.r4: no valid d cell
- dropped: r2.r1: no valid d cell
- dropped: r2.r2: no valid d cell
- dropped: r2.r3: no valid d cell
- dropped: r2.r4: no valid d cell
- dropped: f1.r1: no valid d cell
- dropped: f1.r2: no valid d cell
- dropped: f1.r3: no valid d cell

## d vs slice

Pairs 1; N_code -, R_f1 -, N_code3 -; dS 0.0; memory 0 vs 0 of 0 items (dM 0), bad 0 vs 0 (dB 0). Insufficient: 1 valid pairs < 10; c1: 0 pairs < 2; c2: 1 pairs < 2; r2: 0 pairs < 2; f1: 0 pairs < 2; 0 memory items < 8.

| task | pairs | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 0 | - | - | [] | 0/0 | 0 |
| c2 | 1 | 0.905 | 0.905 | [0.9053] | 1.0/1.0 | 0.0 |
| r2 | 0 | - | - | [] | 0/0 | 0 |
| f1 | 0 | - | - | [] | 0/0 | 0 |

- dropped: c1.r1: no valid d cell
- dropped: c1.r2: no valid d cell
- dropped: c1.r3: no valid d cell
- dropped: c1.r4: no valid d cell
- dropped: c2.r2: no valid d cell
- dropped: c2.r3: no valid d cell
- dropped: c2.r4: no valid d cell
- dropped: r2.r1: no valid d cell
- dropped: r2.r2: no valid d cell
- dropped: r2.r3: no valid d cell
- dropped: r2.r4: no valid d cell
- dropped: f1.r1: no valid d cell
- dropped: f1.r2: no valid d cell
- dropped: f1.r3: no valid d cell

## b vs stock

Pairs 15; N_code 1.193, R_f1 0.555, N_code3 1.098; dS 0.0; memory 14.0 vs 14.0 of 14 items (dM 0.0), bad 0.0 vs 0.0 (dB 0.0).

| task | pairs | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 4 | 1.385 | 1.446 | [1.881, 0.9053, 1.5208, 1.3718] | 4.0/4.0 | 0.0 |
| c2 | 4 | 1.027 | 1.020 | [1.3253, 0.9958, 0.794, 1.0443] | 4.0/4.0 | 0.0 |
| r2 | 4 | 0.931 | 1.009 | [1.2674, 0.7512, 0.6323, 1.4421] | 4.0/4.0 | 0.0 |
| f1 | 3 | 0.555 | 0.522 | [0.522, 0.6643, 0.5094] | 3.0/3.0 | 0.0 |

- dropped: r2.r2: memory exclusion
- dropped: r2.r4: memory exclusion

## b vs slice

Pairs 15; N_code 0.946, R_f1 0.909, N_code3 0.971; dS 0.0; memory 13.0 vs 13.0 of 13 items (dM 0.0), bad 0.0 vs 0.0 (dB 0.0).

| task | pairs | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 4 | 0.873 | 0.938 | [0.8887, 0.5997, 1.049, 0.9874] | 4.0/4.0 | 0.0 |
| c2 | 4 | 1.026 | 0.989 | [1.1281, 0.9871, 0.9769, 0.99] | 4.0/4.0 | 0.0 |
| r2 | 4 | 1.024 | 1.036 | [1.1437, 1.0407, 0.8986, 1.0322] | 4.0/4.0 | 0.0 |
| f1 | 3 | 0.909 | 0.924 | [0.9325, 0.8698, 0.9241] | 3.0/3.0 | 0.0 |

- dropped: r2.r2: memory exclusion
- dropped: r2.r3: memory exclusion
- dropped: r2.r4: memory exclusion

## Re-read classes (sums over valid cells)

| arm | task | cells | turns | first | cross-turn | same-turn | after own edit | reads | edits/writes | bash writes | FS_NOT_OBSERVED | FS_STALE_VERSION |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| d | c2 | 1 | 1 | 8 | 0 | 0 | 0 | 8 | 4 | 1 | 0 | 0 |
| d | hello | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| b | c1 | 4 | 32 | 8 | 54 | 0 | 14 | 76 | 128 | 71 | 0 | 0 |
| b | c2 | 4 | 4 | 33 | 0 | 0 | 0 | 33 | 20 | 6 | 0 | 0 |
| b | f1 | 3 | 135 | 107 | 98 | 21 | 26 | 252 | 88 | 60 | 7 | 0 |
| b | r2 | 4 | 28 | 9 | 8 | 0 | 2 | 19 | 21 | 17 | 0 | 0 |
| slice | c1 | 4 | 32 | 8 | 59 | 0 | 28 | 95 | 168 | 90 | 1 | 0 |
| slice | c2 | 4 | 4 | 34 | 0 | 0 | 12 | 46 | 21 | 5 | 0 | 0 |
| slice | f1 | 3 | 135 | 109 | 105 | 118 | 39 | 371 | 98 | 61 | 2 | 0 |
| slice | r2 | 4 | 28 | 8 | 8 | 0 | 3 | 19 | 21 | 15 | 0 | 0 |
| stock | c1 | 4 | 32 | 6 | 27 | 10 | 9 | 52 | 84 | 23 | 1 | 0 |
| stock | c2 | 4 | 4 | 23 | 0 | 0 | 5 | 28 | 25 | 6 | 4 | 0 |
| stock | f1 | 3 | 135 | 108 | 107 | 0 | 90 | 305 | 139 | 3 | 4 | 0 |
| stock | r2 | 4 | 28 | 6 | 4 | 0 | 3 | 13 | 27 | 6 | 2 | 0 |

## Cost structure (valid cells)

| arm | task | cells | pass | mean $ peak | req/turn | step-cap cuts (of turns) | cache hit | peak / mean req tokens | memory correct/total (bad) | median wall s |
|---|---|---|---|---|---|---|---|---|---|---|
| d | c2 | 1 | 1 | 0.0090 | 7.000 | 0 of 1 | 0.905 | 14334 / 10348 | 0/0 (0) | 24 |
| d | hello | 2 | 2 | 0.0012 | 1.000 | 0 of 2 | 0.461 | 4854.000 / 4854 | 0/0 (0) | 4 |
| b | c1 | 4 | 4 | 0.1417 | 9.560 | 4 of 32 | 0.961 | 36205.500 / 18625 | 0/0 (0) | 699 |
| b | c2 | 4 | 4 | 0.0089 | 7.500 | 0 of 4 | 0.926 | 13146.500 / 9727 | 0/0 (0) | 26 |
| b | f1 | 3 | 3 | 0.2380 | 5.000 | 0 of 135 | 0.946 | 36706 / 22425 | 12/12 (0) | 459 |
| b | r2 | 4 | 4 | 0.0200 | 3.785 | 0 of 28 | 0.951 | 15787.000 / 10252 | 4/4 (0) | 80 |
| slice | c1 | 4 | 4 | 0.1624 | 11.440 | 14 of 32 | 0.966 | 38642.500 / 20474 | 0/0 (0) | 824 |
| slice | c2 | 4 | 4 | 0.0087 | 7.000 | 0 of 4 | 0.898 | 14637.000 / 9632 | 0/0 (0) | 24 |
| slice | f1 | 3 | 3 | 0.2619 | 5.890 | 0 of 135 | 0.958 | 43301 / 24774 | 12/12 (0) | 542 |
| slice | r2 | 4 | 4 | 0.0196 | 3.860 | 0 of 28 | 0.948 | 15237.500 / 10379 | 4/4 (0) | 82 |
| stock | c1 | 4 | 4 | 0.1023 | 5.940 | 0 of 32 | 0.983 | 74338.000 / 34361 | 0/0 (0) | 341 |
| stock | c2 | 4 | 4 | 0.0087 | 8.000 | 0 of 4 | 0.908 | 11609.500 / 8279 | 0/0 (0) | 30 |
| stock | f1 | 3 | 3 | 0.4287 | 4.730 | 0 of 135 | 0.991 | 234025 / 116231 | 12/12 (0) | 426 |
| stock | r2 | 4 | 4 | 0.0215 | 3.425 | 0 of 28 | 0.960 | 20463.500 / 11744 | 4/4 (0) | 94 |

## D cells

| cell | batch | attempt | valid | pass | $ peak | requests | step-cap cuts | flagged | memory-excluded | quarantined | wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| m3_consistency_bugfix.r1.d | batch | 1 | True | True | 0.0090 | 7 | 0 | 0 | False | 0 | 24 |

## Flagged calls of D (0; real probes: 0)

None.

## Empty turns of D (0)

None.

Reference (imported cells): b: lh1_incremental_build.r3.b t2 (empty reply)

## Warmup (hello): step-1 cache read

- rep 1 (warm): 0 (min 4000 from rep 2), ok, valid True
- rep 2 (warm): 4480 (min 4000 from rep 2), ok, valid True

Ratios are the named arm over the other, on the off-peak sheet (peak is exactly 2x). The arm side of a pair is the mean of its valid cells at that rep index (one each here).
