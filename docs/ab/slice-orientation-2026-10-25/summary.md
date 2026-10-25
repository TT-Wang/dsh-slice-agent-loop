# slice-orientation test: D against STOCK, B and SLICE

D cells: batch, warm, warm2; imported: STOCK and SLICE (2026-10-23), B (svs2 batch).

Caveat: cross-batch: STOCK and SLICE ran on 2026-10-23, B on 2026-10-24/25, D on 2026-10-25; no concurrent control. Provider-side variance between the days is not separable from an arm effect. n = 3-4 per task.

Spend (peak sheet): $1.6375 over 208 turns; by batch {'warm': 0.002374, 'batch': 1.634878, 'warm2': 0.000233}.

## Verdict: **do not ship (S1_cost failed)**

| condition | status | value |
|---|---|---|
| S1 cost | fail | N_code(d) 1.312 / N_code(b) 1.193 = 1.100 (<= 1.05); R_f1(d) 0.583 (<= 0.70). |
| S2 probes | pass | 0 real out-of-workspace probes (max 0), over 19 attempts of 18 D cells (1 account/budget stops included). |
| S3 empty turns | pass | 0 (max 0), over 19 attempts of 18 D cells (1 account/budget stops included). |
| S4 quality floor | pass | dS 0.0, dS_t {'c1': 0.0, 'c2': 0.0, 'r2': 0.0, 'f1': 0.0}, dM 0.0, dB 0.0 (floor: dS >= -1, no dS_t <= -2, dM >= -1, dB <= +1). |

## d vs stock

Pairs 15; N_code 1.312, R_f1 0.583, N_code3 1.128; dS 0.0; memory 11.0 vs 11.0 of 11 items (dM 0.0), bad 0.0 vs 0.0 (dB 0.0).

| task | pairs | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 4 | 1.605 | 1.601 | [2.0987, 1.824, 1.2085, 1.3771] | 4.0/4.0 | 0.0 |
| c2 | 4 | 1.072 | 1.064 | [1.0635, 1.0652, 1.1139, 1.0337] | 4.0/4.0 | 0.0 |
| r2 | 4 | 0.833 | 0.872 | [1.1028, 0.705, 0.6902, 1.0392] | 4.0/4.0 | 0.0 |
| f1 | 3 | 0.583 | 0.635 | [0.6346, 0.6792, 0.4623] | 3.0/3.0 | 0.0 |

- dropped: r2.r2: memory exclusion
- dropped: f1.r3: memory exclusion

## d vs b

Pairs 15; N_code 1.100, R_f1 1.050, N_code3 1.027; dS 0.0; memory 10.0 vs 10.0 of 10 items (dM 0.0), bad 0.0 vs 0.0 (dB 0.0).

| task | pairs | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 4 | 1.159 | 1.060 | [1.1158, 2.0148, 0.7946, 1.0039] | 4.0/4.0 | 0.0 |
| c2 | 4 | 1.044 | 1.030 | [0.8025, 1.0696, 1.4029, 0.9899] | 4.0/4.0 | 0.0 |
| r2 | 4 | 0.895 | 0.904 | [0.8701, 0.9386, 1.0916, 0.7207] | 4.0/4.0 | 0.0 |
| f1 | 3 | 1.050 | 1.022 | [1.2158, 1.0224, 0.9075] | 3.0/3.0 | 0.0 |

- dropped: r2.r2: memory exclusion
- dropped: r2.r4: memory exclusion
- dropped: f1.r3: memory exclusion

## d vs slice

Pairs 15; N_code 1.040, R_f1 0.955, N_code3 0.997; dS 0.0; memory 10.0 vs 10.0 of 10 items (dM 0.0), bad 0.0 vs 0.0 (dB 0.0).

| task | pairs | R | median paired | paired ratios | pass arm/base | dS_t |
|---|---|---|---|---|---|---|
| c1 | 4 | 1.011 | 0.991 | [0.9916, 1.2082, 0.8335, 0.9912] | 4.0/4.0 | 0.0 |
| c2 | 4 | 1.071 | 1.018 | [0.9053, 1.0558, 1.3706, 0.9801] | 4.0/4.0 | 0.0 |
| r2 | 4 | 0.916 | 0.979 | [0.9951, 0.9768, 0.981, 0.7439] | 4.0/4.0 | 0.0 |
| f1 | 3 | 0.955 | 0.889 | [1.1338, 0.8893, 0.8386] | 3.0/3.0 | 0.0 |

- dropped: r2.r2: memory exclusion
- dropped: r2.r3: memory exclusion
- dropped: f1.r3: memory exclusion

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
| d | c1 | 4 | 32 | 8 | 57 | 0 | 23 | 88 | 173 | 73 | 4 | 0 |
| d | c2 | 4 | 4 | 33 | 0 | 0 | 0 | 33 | 17 | 7 | 0 | 0 |
| d | f1 | 3 | 135 | 108 | 103 | 82 | 55 | 348 | 125 | 36 | 8 | 0 |
| d | hello | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| d | r2 | 4 | 28 | 8 | 8 | 0 | 2 | 18 | 22 | 14 | 0 | 0 |
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
| d | c1 | 4 | 4 | 0.1642 | 9.620 | 9 of 32 | 0.956 | 45553.500 / 20525 | 0/0 (0) | 525 |
| d | c2 | 4 | 4 | 0.0093 | 7.500 | 0 of 4 | 0.917 | 14010.000 / 10105 | 0/0 (0) | 24 |
| d | f1 | 3 | 3 | 0.2500 | 4.980 | 0 of 135 | 0.943 | 36115 / 21263 | 12/12 (0) | 500 |
| d | hello | 3 | 3 | 0.0009 | 1.000 | 0 of 3 | 0.923 | 4855 / 4855 | 0/0 (0) | 4 |
| d | r2 | 4 | 4 | 0.0179 | 3.570 | 0 of 28 | 0.943 | 14308.000 / 9554 | 4/4 (0) | 71 |
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
| lh1_incremental_build.r1.d | batch | 2 | True | True | 0.1751 | 73 | 2 | 5 | False | 0 | 506 |
| lh1_incremental_build.r2.d | batch | 1 | True | True | 0.2082 | 93 | 4 | 12 | False | 2 | 916 |
| lh1_incremental_build.r3.d | batch | 1 | True | True | 0.1299 | 70 | 0 | 8 | False | 0 | 502 |
| lh1_incremental_build.r4.d | batch | 1 | True | True | 0.1434 | 81 | 3 | 4 | False | 0 | 544 |
| m3_consistency_bugfix.r1.d | batch | 1 | True | True | 0.0090 | 7 | 0 | 0 | False | 0 | 24 |
| m3_consistency_bugfix.r2.d | batch | 1 | True | True | 0.0082 | 6 | 0 | 0 | False | 0 | 23 |
| m3_consistency_bugfix.r3.d | batch | 1 | True | True | 0.0116 | 8 | 0 | 0 | False | 0 | 33 |
| m3_consistency_bugfix.r4.d | batch | 1 | True | True | 0.0085 | 8 | 0 | 0 | False | 0 | 24 |
| p110_r2_superseded_stamp.r1.d | batch | 1 | True | True | 0.0172 | 25 | 0 | 0 | False | 0 | 68 |
| p110_r2_superseded_stamp.r2.d | batch | 1 | True | True | 0.0179 | 25 | 0 | 1 | True | 0 | 73 |
| p110_r2_superseded_stamp.r3.d | batch | 1 | True | True | 0.0202 | 27 | 0 | 0 | False | 0 | 81 |
| p110_r2_superseded_stamp.r4.d | batch | 1 | True | True | 0.0164 | 22 | 0 | 0 | False | 0 | 69 |
| svs_f1_flood_recall.r1.d | batch | 1 | True | True | 0.2995 | 282 | 0 | 0 | False | 0 | 623 |
| svs_f1_flood_recall.r2.d | batch | 1 | True | True | 0.2326 | 224 | 0 | 0 | False | 0 | 500 |
| svs_f1_flood_recall.r3.d | batch | 1 | True | True | 0.2181 | 217 | 0 | 1 | True | 0 | 474 |

## Every D attempt (19 started, of 18 cells; the scope of S2 and S3)

| batch | cell | attempt | status | valid | pass | $ peak | session log | flagged calls | empty turns |
|---|---|---|---|---|---|---|---|---|---|
| batch | m3_consistency_bugfix.r1.d | 1 | done | True | True | 0.0090 | yes | 0 | 0 |
| batch | lh1_incremental_build.r1.d | 1 | account_stop | False | None | 0.1191 | yes | 4 | 0 |
| batch | lh1_incremental_build.r1.d | 2 | done | True | True | 0.1751 | yes | 5 | 0 |
| batch | svs_f1_flood_recall.r1.d | 1 | done | True | True | 0.2995 | yes | 0 | 0 |
| batch | p110_r2_superseded_stamp.r1.d | 1 | done | True | True | 0.0172 | yes | 0 | 0 |
| batch | lh1_incremental_build.r2.d | 1 | done | True | True | 0.2082 | yes | 12 | 0 |
| batch | m3_consistency_bugfix.r2.d | 1 | done | True | True | 0.0082 | yes | 0 | 0 |
| batch | svs_f1_flood_recall.r2.d | 1 | done | True | True | 0.2326 | yes | 0 | 0 |
| batch | p110_r2_superseded_stamp.r2.d | 1 | done | True | True | 0.0179 | yes | 1 | 0 |
| batch | lh1_incremental_build.r3.d | 1 | done | True | True | 0.1299 | yes | 8 | 0 |
| batch | p110_r2_superseded_stamp.r3.d | 1 | done | True | True | 0.0202 | yes | 0 | 0 |
| batch | m3_consistency_bugfix.r3.d | 1 | done | True | True | 0.0116 | yes | 0 | 0 |
| batch | svs_f1_flood_recall.r3.d | 1 | done | True | True | 0.2181 | yes | 1 | 0 |
| batch | lh1_incremental_build.r4.d | 1 | done | True | True | 0.1434 | yes | 4 | 0 |
| batch | p110_r2_superseded_stamp.r4.d | 1 | done | True | True | 0.0164 | yes | 0 | 0 |
| batch | m3_consistency_bugfix.r4.d | 1 | done | True | True | 0.0085 | yes | 0 | 0 |
| warm | hello.r1.d | 1 | done | True | True | 0.0021 | yes | 0 | 0 |
| warm | hello.r2.d | 1 | done | True | True | 0.0002 | yes | 0 | 0 |
| warm2 | hello.r1.d | 1 | done | True | True | 0.0002 | yes | 0 | 0 |

## Flagged calls of D, every attempt (35; real probes: 0)

| cell | attempt (status) | turn.step | tool | automatic class | final | why | command |
|---|---|---|---|---|---|---|---|
| lh1_incremental_build.r1.d (batch) | a1 (account_stop) | 4.5 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'PY' import random from calc import evaluate, Calculator, CalcError random.seed(7) BIN = ["+", "-", "*", "/", "//", "%", "**"] def gen(depth): if depth <= 0 or random.random() < 0.3: lit = random.choice(["0", …` |
| lh1_incremental_build.r1.d (batch) | a1 (account_stop) | 5.3 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'PY' import random, math from calc import evaluate, Calculator, CalcError random.seed(1234) BIN = ["+", "-", "*", "/", "//", "%"] def gen(depth, pow_left): if depth <= 0 or random.random() < 0.3: lit = random …` |
| lh1_incremental_build.r1.d (batch) | a1 (account_stop) | 6.10 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'PY' import random from calc import Calculator, evaluate, CalcError random.seed(20240607) names = ["x", "y", "z", "n1", "_t"] ops = ["+", "-", "*", "/", "//", "%", "**"] def atom(env): r = random.random() if  …` |
| lh1_incremental_build.r1.d (batch) | a1 (account_stop) | 6.11 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'PY' import random from calc import Calculator, evaluate, CalcError random.seed(20240607) names = ["x", "y", "z", "n1", "_t"] ops = ["+", "-", "*", "/", "//", "%", "**"] def atom(env): r = random.random() if  …` |
| lh1_incremental_build.r1.d (batch) | a2 (done) | 5.3 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text) | `cd "$SCRATCHPAD/orient/ab/live/c-9fee48e2a9/w-d5ee9bb632" && python3 - <<'PY' import itertools, math from calc import e …` |
| lh1_incremental_build.r1.d (batch) | a2 (done) | 6.13 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'PY' import math, random from calc import Calculator, CalcError, evaluate random.seed(12345) names = ['x', 'y', '_z9', 'alpha_2'] env = {'x': 3, 'y': -2, '_z9': 1.5, 'alpha_2': 4} def gen(depth=0): if depth > …` |
| lh1_incremental_build.r1.d (batch) | a2 (done) | 6.14 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'PY' import random from calc import CalcError, evaluate random.seed(12345) names = ['x', 'y', '_z9', 'alpha_2'] env = {'x': 3, 'y': -2, '_z9': 1.5, 'alpha_2': 4} def gen(depth=0): if depth > 3 or random.rando …` |
| lh1_incremental_build.r1.d (batch) | a2 (done) | 7.7 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'PY' import math, random from calc import evaluate, CalcError random.seed(1234) def num(): r = random.random() if r < 0.5: return str(random.randint(0, 9)) if r < 0.75: return "{}.{}".format(random.randint(0, …` |
| lh1_incremental_build.r1.d (batch) | a2 (done) | 7.8 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'PY' import math, random from calc import evaluate, CalcError random.seed(1234) INT_EXP = ["0", "1", "2", "3", "-1", "-2"] def num(): r = random.random() if r < 0.5: return str(random.randint(0, 9)) if r < 0. …` |
| lh1_incremental_build.r2.d (batch) | a1 (done) | 2.6 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'PY' import random from calc import Calculator, CalcError, evaluate # --- unbalanced parentheses: CalcError whose message names the problem ---- bad_parens = [ "(1 + 2", "1 + 2)", "(", ")", "()", "2 * (3 + 4" …` |
| lh1_incremental_build.r2.d (batch) | a1 (done) | 2.9 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text) | `rm -rf -- "$(pwd)/__pycache__" && ls -la` |
| lh1_incremental_build.r2.d (batch) | a1 (done) | 3.11 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'EOF' import random from calc import evaluate, CalcError random.seed(20251025) def num(): if random.random() < 0.25: return f"{random.randint(1, 9)}.{random.randint(0, 9)}" return str(random.randint(1, 9)) de …` |
| lh1_incremental_build.r2.d (batch) | a1 (done) | 3.12 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'EOF' import random from calc import evaluate, CalcError random.seed(20251025) def num(): if random.random() < 0.25: return f"{random.randint(1, 9)}.{random.randint(0, 9)}" return str(random.randint(1, 9)) de …` |
| lh1_incremental_build.r2.d (batch) | a1 (done) | 4.5 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'PY' import random from calc import evaluate, CalcError random.seed(1234) def number(): if random.random() < 0.75: return str(random.randint(0, 9)) return random.choice(["0.5", "1.5", "2.25", "3.75", ".5", "6 …` |
| lh1_incremental_build.r2.d (batch) | a1 (done) | 5.5 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'PY' import itertools, math, calc signs = ["", "+", "-", "--", "-+", "+-", "++"] def pyval(expr): try: v = eval(expr, {"__builtins__": {}}, {}) except Exception as e: return ("ERR", type(e).__name__) if isins …` |
| lh1_incremental_build.r2.d (batch) | a1 (done) | 5.10 | bash | F3 | F3 | F3: scratch file in /tmp | `cat > /tmp/fuzz_diag.py <<'PY' import ast, faulthandler, math, random, sys, calc class TooBig(Exception): pass class PyErr(Exception): pass MAX_BITS = 3000 def check_num(v): if isinstance(v, complex): raise PyErr("comple …` |
| lh1_incremental_build.r2.d (batch) | a1 (done) | 5.11 | bash | F3 | F3 | F3: scratch file in /tmp | `PYTHONPATH=. python3 /tmp/fuzz_diag.py` |
| lh1_incremental_build.r2.d (batch) | a1 (done) | 5.12 | bash | F3 | F3 | F3: scratch file in /tmp | `cat > /tmp/fuzz_full.py <<'PY' import ast, math, random, time, calc class TooBig(Exception): pass class PyErr(Exception): pass MAX_BITS = 3000 def check_num(v): if isinstance(v, complex): raise PyErr("complex") if isinst …` |
| lh1_incremental_build.r2.d (batch) | a1 (done) | 6.12 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'PY' import random, math from calc import Calculator, evaluate, CalcError random.seed(20251025) NAMES = ["x", "y", "z", "n1", "_tmp"] def gen(depth, budget): if depth <= 0 or random.random() < 0.35: if random …` |
| lh1_incremental_build.r2.d (batch) | a1 (done) | 7.6 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `cd "$PWD" && python3 - <<'PY' import math, random from calc import evaluate, CalcError random.seed(1234) def num(): if random.random() < 0.5: return str(random.randint(0, 9)) return f"{random.randint(0,9)}.{random.randin …` |
| lh1_incremental_build.r2.d (batch) | a1 (done) | 8.11 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'PY' import math, random import calc from calc import Calculator, evaluate, CalcError # state test with the *same* calculator instance c = Calculator() assert c.eval("x = 6") is None assert c.eval("y = 7") is …` |
| p110_r2_superseded_stamp.r2.d (batch) | a1 (done) | 1.6 | bash | candidate | F4 (hand check: the flag 'outside: / (head)' comes from the Python line `head = (n - 1) // 2` inside the quoted heredoc <<'PY' (floor division; the shell splitter reads `head ... //` as head of /). Replacing that line removes the flag; every path the call uses is relative (sys.path '.', lib/textkit.py)) | candidate: whole-disk walk; hint '..': only inside a quoted heredoc or single-quoted string | `python3 - <<'PY' import sys, random, string sys.path.insert(0, ".") from lib.textkit import truncate_middle, ELLIPSIS for n in range(1, 15): for L in range(0, 25): s = "".join(random.choice(string.ascii_letters) for _ in …` |
| lh1_incremental_build.r3.d (batch) | a1 (done) | 5.4 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'PY' import math, random from calc import evaluate, Calculator, CalcError # Focused sign/power matrix. cases = { "2 ** 3 ** 2": 512, "-2 ** 2": -4, "2 ** -1": 0.5, "-2 ** -2": -0.25, "2 ** 3 ** -2": 2 ** (3 * …` |
| lh1_incremental_build.r3.d (batch) | a1 (done) | 5.7 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'PY' import math, random from calc import evaluate, CalcError atoms = ["1", "2", "3", "4", "0.5", "1.5", "2.0"] ops = ["+", "-", "*", "/", "//", "%", "**"] def gen(depth=0): if depth >= 3 or random.random() < …` |
| lh1_incremental_build.r3.d (batch) | a1 (done) | 7.8 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'EOF' import math, random from calc import CalcError, evaluate random.seed(1234) NAMESPACE = {"abs": abs, "sqrt": math.sqrt, "pow": pow, "min": min, "max": max} def num(): return random.choice([str(random.ran …` |
| lh1_incremental_build.r3.d (batch) | a1 (done) | 7.10 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `timeout 120 python3 - <<'EOF' import math, random from calc import CalcError, evaluate, Calculator random.seed(1234) NAMESPACE = {"abs": abs, "sqrt": math.sqrt, "pow": pow, "min": min, "max": max} def num(): return rando …` |
| lh1_incremental_build.r3.d (batch) | a1 (done) | 7.11 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'EOF' import math, random from calc import CalcError, evaluate, Calculator random.seed(1234) NAMESPACE = {"abs": abs, "sqrt": math.sqrt, "pow": pow, "min": min, "max": max} def num(): return random.choice([st …` |
| lh1_incremental_build.r3.d (batch) | a1 (done) | 8.8 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text) | `python3 -u - <<'PY' import calc failures = [] def expect(label, got, want): if got != want or type(got) is not type(want): failures.append((label, got, want)) def expect_err(label, fn, *needles): try: v = fn() except cal …` |
| lh1_incremental_build.r3.d (batch) | a1 (done) | 8.9 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 -u - <<'PY' import calc, math, random random.seed(99) def num(): return random.choice(["0", "1", "2", "3", "5", "7", "10", "2.5", "0.5", "3.0"]) def gen(depth=0): if depth >= 4 or random.random() < 0.3: return nu …` |
| lh1_incremental_build.r3.d (batch) | a1 (done) | 8.10 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 -u - <<'PY' import calc, math, random random.seed(99) def num(): return random.choice(["0", "1", "2", "3", "5", "7", "10", "2.5", "0.5", "3.0"]) def gen(depth=0): if depth >= 4 or random.random() < 0.3: return nu …` |
| svs_f1_flood_recall.r3.d (batch) | a1 (done) | 6.4 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text) | `rm -rf "${PWD:?}/__pycache__" && ls -la` |
| lh1_incremental_build.r4.d (batch) | a1 (done) | 6.14 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'EOF' import random, math import calc from calc import Calculator, CalcError, evaluate random.seed(1234) NAMES = ["x", "y", "z", "n1", "_t"] ENV = {"x": 3, "y": -2, "z": 0.5, "n1": 7, "_t": 2} NUMS = ["0", "1 …` |
| lh1_incremental_build.r4.d (batch) | a1 (done) | 7.8 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'PY' import math, random, sys from calc import evaluate, CalcError random.seed(20240607) env = {"a": 1, "b": 2, "c": 3, "r": 5} pyenv = dict(env) lenv = {"abs": abs, "sqrt": math.sqrt, "pow": pow, "min": min, …` |
| lh1_incremental_build.r4.d (batch) | a1 (done) | 7.9 | bash | F1 | F1 | F1: no such top-level path (operator or unexpanded text); F1: no such top-level path (operator or unexpanded text) | `python3 - <<'PY' import math, random, sys from calc import evaluate, CalcError random.seed(20240607) env = {"a": 1, "b": 2, "c": 3, "r": 5} lenv = {"abs": abs, "sqrt": math.sqrt, "pow": pow, "min": min, "max": max} NUMS  …` |
| lh1_incremental_build.r4.d (batch) | a1 (done) | 8.3 | bash | candidate | F4 (hand check: the flagged parent directory comes from the string literal ".." in a list of calculator inputs passed to calc.evaluate inside the quoted heredoc <<'PY' (as the STOCK c1 arb rep 1 test string); removing that literal removes the flag; the call opens no path) | candidate: a real path outside the workdir; hint '..': only inside a quoted heredoc or single-quoted string | `python3 - <<'PY' import calc, sys cases = [ "1"*5000, # huge int literal "9"*4400 + " + 1", "2 ** 100000", # huge int result "sqrt(-(2 ** 20000))", # huge int in error message "-(2 ** 20000) * 1", # fine "2 ** 0.5 ** 100 …` |

## Empty turns of D, every attempt (0)

None.

Reference (imported cells): b: lh1_incremental_build.r3.b t2 (empty reply)

## Invalid and stopped D attempts (not counted as cells)

- lh1_incremental_build.r1.d (batch, attempt 1, account_stop), infra True: turn 6: account-level provider error QUOTA: the run stops; --resume reruns this cell

## Warmup (hello): step-1 cache read

- rep 1 (warm): 0 (min 4000 from rep 2), ok, valid True
- rep 1 (warm2): 4480 (min 4000 from rep 2), ok, valid True
- rep 2 (warm): 4480 (min 4000 from rep 2), ok, valid True

Ratios are the named arm over the other, on the off-peak sheet (peak is exactly 2x). The arm side of a pair is the mean of its valid cells at that rep index (one each here).
