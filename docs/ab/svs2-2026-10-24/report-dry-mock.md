> Offline dry run of the svs2 harness (mock adapter, provider ab-mock): the SLICE build (slice-main-c73ee22.tgz) as stand-ins for arms a, b and c, validated against the slice structure (--structure-as), against the imported baseline cells. The mock solves no task and reports fixed usage, so every ratio, pass count and interpretation below is meaningless; this file only shows that the report runs end to end on 45 cells. Paths normalized.

# svs2 ablation summary

New batches: dry; baseline: imported cells (baseline). New cells 45 (45 valid). Arms: a, b, c.

Caveat: cross-batch: the baseline cells ran on 2026-10-23, the new arms on another day, with no concurrent STOCK or SLICE control; provider-side variance between the days (latency, cache retention, routing) is not separable from an arm effect. B/A, C/B and C/A are within one batch.
Spend (peak sheet): $0.1847 over 597 turns; by batch {'dry': 0.18468}.

## Interpretation per arm (pre-registered rules, gates-svs2.json)

| arm | interpretation | N_code (c1, c2) | R_f1 | N_code3 (+r2) | dS | dM | dB | quality floor | arbitration |
|---|---|---|---|---|---|---|---|---|---|
| a | **quality floor fails** (the arm loses more than one pass or memory item to STOCK, or gains more than one bad answer) | 0.026 | 0.034 | 0.039 | -15.0 | -16.0 | 0.0 | FAILS | not required |
| b | **quality floor fails** (the arm loses more than one pass or memory item to STOCK, or gains more than one bad answer) | 0.026 | 0.034 | 0.039 | -15.0 | -16.0 | 0.0 | FAILS | not required |
| c | **quality floor fails** (the arm loses more than one pass or memory item to STOCK, or gains more than one bad answer) | 0.026 | 0.034 | 0.039 | -15.0 | -16.0 | 0.0 | FAILS | not required |

## Steps between arms (which change moves the cost; reported)

| step | kind | N_code | | R_f1 | | pairs |
|---|---|---|---|---|---|---|
| a/slice | cross-batch (baseline of 2026-10-23) | 0.021 | moves the cost down | 0.056 | moves the cost down | 15 |
| b/a | within the batch | 1.000 | no measurable effect at this n | 1.000 | no measurable effect at this n | 15 |
| c/b | within the batch | 1.000 | no measurable effect at this n | 1.000 | no measurable effect at this n | 15 |
| c/a | within the batch | 1.000 | no measurable effect at this n | 1.000 | no measurable effect at this n | 15 |

## a vs stock

Pairs 15 (arm cells per pair [1]); N_code 0.026, R_f1 0.034, N_code3 0.039; sum ratio 0.034, median paired ratio 0.032; dS -15.0; memory 0.0 vs 16.0 of 16 items (dM -16.0), bad 0.0 vs 0.0 (dB 0.0).

| task | pairs/min | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 4/2 | 0.022 | 0.021 | [0.027, 0.0197, 0.0209, 0.0216] | 0.0/4.0 | -4.0 |
| c2 | 4/2 | 0.031 | 0.033 | [0.032, 0.0354, 0.026, 0.0333] | 0.0/4.0 | -4.0 |
| r2 | 4/2 | 0.086 | 0.095 | [0.1182, 0.0724, 0.063, 0.1166] | 0.0/4.0 | -4.0 |
| f1 | 3/2 | 0.034 | 0.031 | [0.0312, 0.0429, 0.0312] | 0.0/3.0 | -3.0 |

## a vs slice

Pairs 15 (arm cells per pair [1]); N_code 0.021, R_f1 0.056, N_code3 0.034; sum ratio 0.040, median paired ratio 0.035; dS -15.0; memory 0.0 vs 15.0 of 15 items (dM -15.0), bad 0.0 vs 0.0 (dB 0.0).

| task | pairs/min | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 4/2 | 0.014 | 0.014 | [0.0127, 0.0131, 0.0144, 0.0156] | 0.0/4.0 | -4.0 |
| c2 | 4/2 | 0.031 | 0.032 | [0.0272, 0.0351, 0.032, 0.0315] | 0.0/4.0 | -4.0 |
| r2 | 4/2 | 0.094 | 0.095 | [0.1067, 0.1004, 0.0895, 0.0835] | 0.0/4.0 | -4.0 |
| f1 | 3/2 | 0.056 | 0.056 | [0.0557, 0.0562, 0.0565] | 0.0/3.0 | -3.0 |

- dropped: r2.r3: memory exclusion

## b vs stock

Pairs 15 (arm cells per pair [1]); N_code 0.026, R_f1 0.034, N_code3 0.039; sum ratio 0.034, median paired ratio 0.032; dS -15.0; memory 0.0 vs 16.0 of 16 items (dM -16.0), bad 0.0 vs 0.0 (dB 0.0).

| task | pairs/min | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 4/2 | 0.022 | 0.021 | [0.027, 0.0197, 0.0209, 0.0216] | 0.0/4.0 | -4.0 |
| c2 | 4/2 | 0.031 | 0.033 | [0.032, 0.0354, 0.026, 0.0333] | 0.0/4.0 | -4.0 |
| r2 | 4/2 | 0.086 | 0.095 | [0.1182, 0.0724, 0.063, 0.1166] | 0.0/4.0 | -4.0 |
| f1 | 3/2 | 0.034 | 0.031 | [0.0312, 0.0429, 0.0312] | 0.0/3.0 | -3.0 |

## b vs slice

Pairs 15 (arm cells per pair [1]); N_code 0.021, R_f1 0.056, N_code3 0.034; sum ratio 0.040, median paired ratio 0.035; dS -15.0; memory 0.0 vs 15.0 of 15 items (dM -15.0), bad 0.0 vs 0.0 (dB 0.0).

| task | pairs/min | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 4/2 | 0.014 | 0.014 | [0.0127, 0.0131, 0.0144, 0.0156] | 0.0/4.0 | -4.0 |
| c2 | 4/2 | 0.031 | 0.032 | [0.0272, 0.0351, 0.032, 0.0315] | 0.0/4.0 | -4.0 |
| r2 | 4/2 | 0.094 | 0.095 | [0.1067, 0.1004, 0.0895, 0.0835] | 0.0/4.0 | -4.0 |
| f1 | 3/2 | 0.056 | 0.056 | [0.0557, 0.0562, 0.0565] | 0.0/3.0 | -3.0 |

- dropped: r2.r3: memory exclusion

## c vs stock

Pairs 15 (arm cells per pair [1]); N_code 0.026, R_f1 0.034, N_code3 0.039; sum ratio 0.034, median paired ratio 0.032; dS -15.0; memory 0.0 vs 16.0 of 16 items (dM -16.0), bad 0.0 vs 0.0 (dB 0.0).

| task | pairs/min | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 4/2 | 0.022 | 0.021 | [0.027, 0.0197, 0.0209, 0.0216] | 0.0/4.0 | -4.0 |
| c2 | 4/2 | 0.031 | 0.033 | [0.032, 0.0354, 0.026, 0.0333] | 0.0/4.0 | -4.0 |
| r2 | 4/2 | 0.086 | 0.095 | [0.1182, 0.0724, 0.063, 0.1166] | 0.0/4.0 | -4.0 |
| f1 | 3/2 | 0.034 | 0.031 | [0.0312, 0.0429, 0.0312] | 0.0/3.0 | -3.0 |

## c vs slice

Pairs 15 (arm cells per pair [1]); N_code 0.021, R_f1 0.056, N_code3 0.034; sum ratio 0.040, median paired ratio 0.035; dS -15.0; memory 0.0 vs 15.0 of 15 items (dM -15.0), bad 0.0 vs 0.0 (dB 0.0).

| task | pairs/min | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 4/2 | 0.014 | 0.014 | [0.0127, 0.0131, 0.0144, 0.0156] | 0.0/4.0 | -4.0 |
| c2 | 4/2 | 0.031 | 0.032 | [0.0272, 0.0351, 0.032, 0.0315] | 0.0/4.0 | -4.0 |
| r2 | 4/2 | 0.094 | 0.095 | [0.1067, 0.1004, 0.0895, 0.0835] | 0.0/4.0 | -4.0 |
| f1 | 3/2 | 0.056 | 0.056 | [0.0557, 0.0562, 0.0565] | 0.0/3.0 | -3.0 |

- dropped: r2.r3: memory exclusion

## Re-read classes (sums over valid cells; reported)

| arm | task | cells | turns | first | cross-turn | same-turn | after own edit | reads | edits/writes | bash writes | FS_NOT_OBSERVED | FS_STALE_VERSION |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| a | c1 | 4 | 32 | 8 | 12 | 20 | 0 | 40 | 0 | 0 | 0 | 0 |
| a | c2 | 4 | 4 | 4 | 0 | 4 | 0 | 8 | 0 | 0 | 0 | 0 |
| a | f1 | 3 | 135 | 108 | 12 | 120 | 0 | 240 | 0 | 0 | 0 | 0 |
| a | r2 | 4 | 28 | 8 | 0 | 8 | 0 | 16 | 0 | 0 | 0 | 0 |
| b | c1 | 4 | 32 | 8 | 12 | 20 | 0 | 40 | 0 | 0 | 0 | 0 |
| b | c2 | 4 | 4 | 4 | 0 | 4 | 0 | 8 | 0 | 0 | 0 | 0 |
| b | f1 | 3 | 135 | 108 | 12 | 120 | 0 | 240 | 0 | 0 | 0 | 0 |
| b | r2 | 4 | 28 | 8 | 0 | 8 | 0 | 16 | 0 | 0 | 0 | 0 |
| c | c1 | 4 | 32 | 8 | 12 | 20 | 0 | 40 | 0 | 0 | 0 | 0 |
| c | c2 | 4 | 4 | 4 | 0 | 4 | 0 | 8 | 0 | 0 | 0 | 0 |
| c | f1 | 3 | 135 | 108 | 12 | 120 | 0 | 240 | 0 | 0 | 0 | 0 |
| c | r2 | 4 | 28 | 8 | 0 | 8 | 0 | 16 | 0 | 0 | 0 | 0 |
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
| a | c1 | 4 | 0 | 0.0023 | 33.000 | 4.120 | 4.120 | 0 of 32 | 0.907 | 1109.000 | 1102 | 0 | 0 | 0/0 (0) | 28 |
| a | c2 | 4 | 0 | 0.0003 | 4.000 | 4.000 | 4.000 | 0 of 4 | 0.907 | 1109.000 | 1102 | 0 | 0 | 0/0 (0) | 3 |
| a | f1 | 3 | 0 | 0.0147 | 216 | 4.800 | 4.800 | 0 of 135 | 0.907 | 1109 | 1102 | 192 | 0 | 0/12 (0) | 150 |
| a | r2 | 4 | 0 | 0.0018 | 27.000 | 3.860 | 3.860 | 0 of 28 | 0.907 | 1109.000 | 1102 | 0 | 0 | 0/4 (0) | 30 |
| b | c1 | 4 | 0 | 0.0023 | 33.000 | 4.120 | 4.120 | 0 of 32 | 0.907 | 1109.000 | 1102 | 0 | 0 | 0/0 (0) | 30 |
| b | c2 | 4 | 0 | 0.0003 | 4.000 | 4.000 | 4.000 | 0 of 4 | 0.907 | 1109.000 | 1102 | 0 | 0 | 0/0 (0) | 4 |
| b | f1 | 3 | 0 | 0.0147 | 216 | 4.800 | 4.800 | 0 of 135 | 0.907 | 1109 | 1102 | 192 | 0 | 0/12 (0) | 142 |
| b | r2 | 4 | 0 | 0.0018 | 27.000 | 3.860 | 3.860 | 0 of 28 | 0.907 | 1109.000 | 1102 | 0 | 0 | 0/4 (0) | 23 |
| c | c1 | 4 | 0 | 0.0023 | 33.000 | 4.120 | 4.120 | 0 of 32 | 0.907 | 1109.000 | 1102 | 0 | 0 | 0/0 (0) | 29 |
| c | c2 | 4 | 0 | 0.0003 | 4.000 | 4.000 | 4.000 | 0 of 4 | 0.907 | 1109.000 | 1102 | 0 | 0 | 0/0 (0) | 4 |
| c | f1 | 3 | 0 | 0.0147 | 216 | 4.800 | 4.800 | 0 of 135 | 0.907 | 1109 | 1102 | 192 | 0 | 0/12 (0) | 177 |
| c | r2 | 4 | 0 | 0.0018 | 27.000 | 3.860 | 3.860 | 0 of 28 | 0.907 | 1109.000 | 1102 | 0 | 0 | 0/4 (0) | 23 |
| slice | c1 | 4 | 4 | 0.1624 | 91.500 | 11.440 | 11.440 | 14 of 32 | 0.966 | 38642.500 | 20474 | 6 | 0 | 0/0 (0) | 824 |
| slice | c2 | 4 | 4 | 0.0087 | 7.000 | 7.000 | 7.000 | 0 of 4 | 0.898 | 14637.000 | 9632 | 1 | 0 | 0/0 (0) | 24 |
| slice | f1 | 3 | 3 | 0.2619 | 265 | 5.890 | 5.890 | 0 of 135 | 0.958 | 43301 | 24774 | 40 | 0 | 12/12 (0) | 542 |
| slice | r2 | 4 | 4 | 0.0196 | 27.000 | 3.860 | 3.860 | 0 of 28 | 0.948 | 15237.500 | 10379 | 0 | 0 | 4/4 (0) | 82 |
| stock | c1 | 4 | 4 | 0.1023 | 47.500 | 5.940 | 5.940 | 0 of 32 | 0.983 | 74338.000 | 34361 | 0 | 0 | 0/0 (0) | 341 |
| stock | c2 | 4 | 4 | 0.0087 | 8.000 | 8.000 | 8.000 | 0 of 4 | 0.908 | 11609.500 | 8279 | 0 | 0 | 0/0 (0) | 30 |
| stock | f1 | 3 | 3 | 0.4287 | 213 | 4.730 | 4.730 | 0 of 135 | 0.991 | 234025 | 116231 | 0 | 0 | 12/12 (0) | 426 |
| stock | r2 | 4 | 4 | 0.0215 | 24.000 | 3.425 | 3.425 | 0 of 28 | 0.960 | 20463.500 | 11744 | 0 | 0 | 4/4 (0) | 94 |

Ratios are the named arm over the other; cost on the off-peak sheet (peak is exactly 2x every field). The arm side of a pair is the mean of its valid cells at that rep index.
