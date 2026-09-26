<!-- Generated from ab_report.py output (pooled, then batch alone); paths normalized. See docs/p110-native-ab.md §14. -->

# P1-10 native A/B summary: pooled batch + arbitration (decides)

Batches: p110-20260927, p110-20260927-arb (pooled, count margins x2). Cells: 126 (126 valid). Baseline: control. Time: 2026-09-26T19:58:24+00:00 to 2026-09-26T21:52:55+00:00.
Spend (peak sheet): $4.5782 over 598 turns; by batch {'warm': 0.006615, 'pilot': 0.031042, 'pilot2': 0.039334, 'pilot-r5': 0.01567, 'pilot-r5b': 0.027806, 'p110-20260927': 2.231971, 'p110-20260927-arb': 2.225812}.

## Decision (computed from the pre-registered gates)

- arm1: ship A + C (G1-G5 pass)
- arm2: add F (G1-G6 pass)

## Structure (fingerprints)

| arm | system chars | slice tool JSON | prefix chars | prefix delta | tape header | mean tool line |
|---|---|---|---|---|---|---|
| arm1 | 3651 | 5266 | 17538 | -773 | [76] | 94.4 |
| arm2 | 3651 | 5266 | 17538 | -773 | [76] | 53.3 |
| control | 4249 | 5441 | 18311 | None | [188] | 94.4 |

## Totals over valid gated cells

| arm | cells | $ off-peak | $ peak | miss | hit | out | requests | turn-first miss |
|---|---|---|---|---|---|---|---|---|
| arm1 | 42 | 0.7277 | 1.4553 | 776088 | 15052288 | 684184 | 1066 | 185117 |
| arm2 | 42 | 0.7484 | 1.4968 | 794532 | 15620096 | 703429 | 1111 | 180307 |
| control | 42 | 0.7528 | 1.5056 | 816677 | 16232320 | 696254 | 1110 | 190890 |

## Per arm and task (valid cells)

| arm | task | valid/cells | pass | recall-sourced | exam classes | median $ (off-peak) | median requests | same-turn rereads | recall errors | fv rejections | excluded from G2 (flag/leak/fs) | model-error turns | goal calls | failed attempts |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| arm1 | c1 | 6/6 | 6 | 0 | - | 0.0784 | 75.0 | 33 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| arm1 | c2 | 6/6 | 6 | 0 | - | 0.0037 | 6.0 | 4 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| arm1 | r1 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0058 | 18.5 | 4 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| arm1 | r2 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0111 | 28.0 | 8 | 0 | 0 | 6 (6/0/0) | 0 | 0 | 0 |
| arm1 | r3 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0049 | 17.0 | 6 | 0 | 0 | 1 (1/0/0) | 0 | 0 | 0 |
| arm1 | r4 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0033 | 15.0 | 1 | 0 | 0 | 2 (2/0/0) | 0 | 0 | 0 |
| arm1 | r5 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0071 | 13.5 | 17 | 0 | 0 | 2 (1/1/0) | 0 | 0 | 0 |
| arm2 | c1 | 6/6 | 6 | 0 | - | 0.0858 | 86.5 | 32 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| arm2 | c2 | 6/6 | 6 | 0 | - | 0.0043 | 8.0 | 4 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| arm2 | r1 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0057 | 19.0 | 11 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| arm2 | r2 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0136 | 28.5 | 5 | 0 | 0 | 5 (5/0/0) | 0 | 0 | 0 |
| arm2 | r3 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0051 | 14.0 | 9 | 0 | 0 | 2 (2/0/0) | 0 | 0 | 0 |
| arm2 | r4 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0035 | 15.0 | 8 | 0 | 0 | 1 (1/0/0) | 0 | 0 | 0 |
| arm2 | r5 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0063 | 13.5 | 18 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | c1 | 6/6 | 6 | 0 | - | 0.0862 | 89.0 | 31 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | c2 | 6/6 | 6 | 0 | - | 0.0041 | 6.0 | 0 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | r1 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0052 | 17.0 | 6 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | r2 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0128 | 30.0 | 6 | 0 | 0 | 3 (3/0/0) | 0 | 0 | 0 |
| control | r3 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0048 | 14.5 | 6 | 0 | 0 | 1 (1/0/0) | 0 | 0 | 0 |
| control | r4 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0038 | 16.5 | 2 | 0 | 0 | 3 (3/0/0) | 0 | 0 | 0 |
| control | r5 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0074 | 13.0 | 28 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |

## Gates

### arm1

| gate | check | arm | baseline | threshold | verdict | pairs/min |
|---|---|---|---|---|---|---|
| G1 (pass) | G1.total: pass | 42 | 42 (control) | 40 | pass | 42/17 |
| G1 (pass) | G1.per_task: pass | 42 | 42 (control) | no task with arm <= base - 4 | pass | 42/17 |
| G2 (pass) | G2a: recall-sourced correct exam answers | 16 | 16 (control) | 14 | pass | 16/10 |
| G2 (pass) | G2b: errors on recall_turn/recall_search/recall_step/expand_result, all turns | 0 | 0 (control) | 4 | pass | 16/10 |
| G2 (pass) | G2c: formatVersion rejections | 0 | 0 (control) | 2 | pass | 16/10 |
| G2 (pass) | G2d: decoy, stale, hedged, wrong or CANNOT-RECOVER exam answers | 0 | 0 (control) | 2 | pass | 16/10 |
| G3 (pass) | G3: sum of reread_same_turn_unchanged + reread_same_turn_after_edit over all 21 cells | 73 | 79 (control) | 102.75 | pass | 42/17 |
| G3 | report only | fold_then_reread 3, reread_cross_turn 108, repeat_tool_reminders 0 | fold_then_reread 3, reread_cross_turn 113, repeat_tool_reminders 0 | - | - | - |
| G4 (pass) | G4.median_ratio: median paired cost ratio arm/control | 0.9789 | paired (control) | 1.1 | pass | 42/17 |
| G4 (pass) | G4.total: sum of cost | 0.9666 | sum 0.7528 (control) | 0.828105 | pass | 42/17 |
| G4 (pass) | G4.requests: median paired request-count delta per cell | 0.0 | paired (control) | 1 | pass | 42/17 |
| G4 (pass) | G4.full_views: recall_turn view "full" calls | 1 | 3 (control) | 7 | pass | 42/17 |
| G5 (pass) | G5.closeout: completed turns ending in a text closeout | 174 | 168 (control) | 166 | pass | 42/17 |
| G5 (pass) | G5.step_limit: turns cut by maxStepsPerTurn (turn_end kind blocked) | 12 | 18 (control) | 20 | pass | 42/17 |

### arm2

| gate | check | arm | baseline | threshold | verdict | pairs/min |
|---|---|---|---|---|---|---|
| G1 (pass) | G1.total: pass | 42 | 42 (control) | 40 | pass | 42/17 |
| G1 (pass) | G1.per_task: pass | 42 | 42 (control) | no task with arm <= base - 4 | pass | 42/17 |
| G2 (pass) | G2a: recall-sourced correct exam answers | 19 | 19 (control) | 17 | pass | 19/10 |
| G2 (pass) | G2b: errors on recall_turn/recall_search/recall_step/expand_result, all turns | 0 | 0 (control) | 4 | pass | 19/10 |
| G2 (pass) | G2c: formatVersion rejections | 0 | 0 (control) | 4 | pass | 19/10 |
| G2 (pass) | G2c.recovered: every arm 2 rejection recovered in the same turn | 0 | 0 (control) | 0 | pass | 19/10 |
| G2 (pass) | G2d: decoy, stale, hedged, wrong or CANNOT-RECOVER exam answers | 0 | 0 (control) | 2 | pass | 19/10 |
| G3 (pass) | G3: sum of reread_same_turn_unchanged + reread_same_turn_after_edit over all 21 cells | 87 | 79 (control) | 102.75 | pass | 42/17 |
| G3 | report only | fold_then_reread 4, reread_cross_turn 109, repeat_tool_reminders 0 | fold_then_reread 3, reread_cross_turn 113, repeat_tool_reminders 0 | - | - | - |
| G4 (pass) | G4.median_ratio: median paired cost ratio arm/control | 0.9858 | paired (control) | 1.1 | pass | 42/17 |
| G4 (pass) | G4.total: sum of cost | 0.9941 | sum 0.7528 (control) | 0.828105 | pass | 42/17 |
| G4 (pass) | G4.requests: median paired request-count delta per cell | 1.0 | paired (control) | 1 | pass | 42/17 |
| G4 (pass) | G4.full_views: recall_turn view "full" calls | 0 | 3 (control) | 7 | pass | 42/17 |
| G5 (pass) | G5.closeout: completed turns ending in a text closeout | 170 | 168 (control) | 166 | pass | 42/17 |
| G5 (pass) | G5.step_limit: turns cut by maxStepsPerTurn (turn_end kind blocked) | 16 | 18 (control) | 20 | pass | 42/17 |
| G6 (pass) | G6.first_try: first-try success rate of expand_result on a target in an earlier turn | 1.0 | 1.0 (control) | 0.9 | pass | 42/17 |
| G6 (pass) | G6.extra_hops: recall_turn/recall_search called only to obtain a locator the tape already gave | 4 | 2 (control) | 6 | pass | 42/17 |
| G6 (pass) | G6.vs_arm1.G2c: fv_rejections | 0 | 0 (arm1) | 4 | pass | 17/10 |
| G6 (pass) | G6.vs_arm1.G2c.recovered: fv_rejections_unrecovered | 0 | 0 (arm1) | 0 | pass | 17/10 |
| G6 (pass) | G6.vs_arm1.G2d: bad_exam_answers | 0 | 0 (arm1) | 2 | pass | 17/10 |

## G2 exclusions (flagged access, leak, oracle via the file system)

- arm1 p110_r2_superseded_stamp.r1.arm1: flagged; T1 bash outside: /.git/*; T4 glob secret: .env
- arm1 p110_r2_superseded_stamp.r1.arm1: flagged; T6 bash outside: $AB/results/p110-20260927-arb/work
- arm1 p110_r2_superseded_stamp.r2.arm1: flagged; T6 bash outside: $AB/results/p110-20260927/work
- arm1 p110_r2_superseded_stamp.r2.arm1: flagged; T6 bash outside: $AB/results/p110-20260927-arb/work; T6 bash outside: $TMP(truncated)
- arm1 p110_r2_superseded_stamp.r3.arm1: flagged; T6 bash outside: / (find), outside: $AB/results/p110-20260927/work
- arm1 p110_r2_superseded_stamp.r3.arm1: flagged; T6 bash cd to $(pwd), relative path after cd to an unknown directory: .., relative path after cd to an unknown directory: ../.., relative path after cd to an unknown directory: 2>/dev/null, secret: DSH_HOME; T6 bash outside: $TMP(truncated)
- arm1 p110_r3_runbook_middle.r3.arm1: flagged; T2 bash outside: $AB/results/p110-20260927-arb, outside: $SP/impl/p110
- arm1 p110_r4_probe_compare.r1.arm1: flagged; T3 bash outside: $AB/results/p110-20260927-arb, outside: $SP/impl/p110
- arm1 p110_r4_probe_compare.r2.arm1: flagged; T3 bash outside: $SP; T3 glob outside: $SP; T3 bash outside: /private/tmp/claude-5
- arm1 p110_r5_initial_failures.r3.arm1: leak; 
- arm1 p110_r5_initial_failures.r3.arm1: flagged; T1 bash outside: /private/tmp/analyze.py; T1 bash outside: /private/tmp/diffcheck.py; T2 bash cd to $T, outside: /textkit/dates.py, outside: /textkit/hashing.py, outside: /textkit/slugs.py, outside: /textkit/tokens.py, outside: /textkit/validate.py
- arm2 p110_r2_superseded_stamp.r1.arm2: flagged; T6 bash outside: $AB/results/p110-20260927/work; T6 bash outside: $SP/
- arm2 p110_r2_superseded_stamp.r1.arm2: flagged; T6 bash outside: $AB, outside: $AB/2>/dev/null; T6 bash ou
- arm2 p110_r2_superseded_stamp.r2.arm2: flagged; T6 bash outside: $AB/results/p110-20260927/work, secret: .env
- arm2 p110_r2_superseded_stamp.r2.arm2: flagged; T6 bash outside: / (find)
- arm2 p110_r2_superseded_stamp.r3.arm2: flagged; T6 bash outside: $TMP(truncated); T6 bash outside: $AB/results/p110-20260927-arb
- arm2 p110_r3_runbook_middle.r2.arm2: flagged; T2 bash outside: $AB/results/p110-20260927/work
- arm2 p110_r3_runbook_middle.r3.arm2: flagged; T2 bash outside: $AB/results, outside: $AB/results/p110-20
- arm2 p110_r4_probe_compare.r3.arm2: flagged; T3 bash outside: $AB/results/p110-20260927/work; T3 bash outside: $SP/
- control p110_r2_superseded_stamp.r1.control: flagged; T6 bash outside: $AB/results/p110-20260927-arb/work
- control p110_r2_superseded_stamp.r2.control: flagged; T4 glob secret: .env
- control p110_r2_superseded_stamp.r3.control: flagged; T6 bash outside: $AB/results/p110-20260927-arb/work, secret: .env; T6 bash outside: $TMP(truncated), outside: $TMP(truncated)
- control p110_r3_runbook_middle.r3.control: flagged; T2 bash outside: $TMP(truncated), outside: $AB/results/p110-20260927; T2 bash outside: /node_
- control p110_r4_probe_compare.r2.control: flagged; T3 bash outside: $AB/results, outside: $AB/results/p110-20
- control p110_r4_probe_compare.r3.control: flagged; T3 bash outside: $AB/results/p110-20260927/work; T3 bash outside: $SP/
- control p110_r4_probe_compare.r3.control: flagged; T3 bash outside: $AB/results/p110-20260927-arb/work; T3 bash outside: $TMP(truncated)

## Tool calls that referenced the key location (hold these logs back from the archive)

- lh1_incremental_build.r1.arm1 (p110-20260927-arb) T2 bash: secret: .env
- lh1_incremental_build.r1.arm2 (p110-20260927) T1 bash: outside: /0, outside: /], secret: .env
- lh1_incremental_build.r1.control (p110-20260927) T1 bash: secret: .env
- lh1_incremental_build.r2.arm1 (p110-20260927) T6 bash: secret: .env
- lh1_incremental_build.r2.arm1 (p110-20260927) T6 bash: secret: .env
- lh1_incremental_build.r2.arm1 (p110-20260927) T6 bash: secret: .env
- lh1_incremental_build.r2.arm1 (p110-20260927-arb) T1 bash: secret: .env
- lh1_incremental_build.r2.arm1 (p110-20260927-arb) T6 edit: secret: .env
- lh1_incremental_build.r2.arm1 (p110-20260927-arb) T8 edit: secret: .env
- lh1_incremental_build.r3.arm1 (p110-20260927) T1 bash: secret: .env
- lh1_incremental_build.r3.control (p110-20260927) T1 bash: secret: .env
- p110_r2_superseded_stamp.r1.arm1 (p110-20260927) T4 glob: secret: .env
- p110_r2_superseded_stamp.r1.arm2 (p110-20260927-arb) T6 bash: outside: $AB, outside: $AB/2>/dev/null, outside: $AB/results/p110-20260927-arb/results, outside: $AB/results/p110-20260927-arb/work/w-4b9f463343/tools, secret: .env
- p110_r2_superseded_stamp.r2.arm2 (p110-20260927) T6 bash: outside: $AB/results/p110-20260927/work, secret: .env
- p110_r2_superseded_stamp.r2.control (p110-20260927) T4 glob: secret: .env
- p110_r2_superseded_stamp.r3.arm1 (p110-20260927-arb) T6 bash: cd to $(pwd), relative path after cd to an unknown directory: .., relative path after cd to an unknown directory: ../.., relative path after cd to an unknown directory: 2>/dev/null, secret: DSH_HOME
- p110_r2_superseded_stamp.r3.control (p110-20260927-arb) T6 bash: outside: $AB/results/p110-20260927-arb/work, secret: .env
- p110_r4_probe_compare.r2.arm1 (p110-20260927) T3 bash: outside: $AB, outside: $AB/home-arm1, secret: DSH_HOME, sensitive: /home-arm1

Counts and paired deltas only; n = 3 per task and arm detects large effects only.


---

# P1-10 native A/B summary: batch p110-20260927 alone (before arbitration)

Batches: p110-20260927. Cells: 63 (63 valid). Baseline: control. Time: 2026-09-26T19:58:24+00:00 to 2026-09-26T20:59:58+00:00.
Spend (peak sheet): $4.5782 over 598 turns; by batch {'warm': 0.006615, 'pilot': 0.031042, 'pilot2': 0.039334, 'pilot-r5': 0.01567, 'pilot-r5b': 0.027806, 'p110-20260927': 2.231971, 'p110-20260927-arb': 2.225812}.

## Decision (computed from the pre-registered gates)

- arm1: do not ship on this batch (too few valid pairs; only the single arbitration batch may add pairs)
- arm2: drop F on this batch (too few valid pairs; only the single arbitration batch may add pairs) / arbitration

## Structure (fingerprints)

| arm | system chars | slice tool JSON | prefix chars | prefix delta | tape header | mean tool line |
|---|---|---|---|---|---|---|
| arm1 | 3651 | 5266 | 17538 | -773 | [76] | 94.4 |
| arm2 | 3651 | 5266 | 17538 | -773 | [76] | 53.3 |
| control | 4249 | 5441 | 18311 | None | [188] | 94.4 |

## Totals over valid gated cells

| arm | cells | $ off-peak | $ peak | miss | hit | out | requests | turn-first miss |
|---|---|---|---|---|---|---|---|---|
| arm1 | 21 | 0.3722 | 0.7445 | 387509 | 7774336 | 352384 | 542 | 93615 |
| arm2 | 21 | 0.3776 | 0.7551 | 399228 | 7937536 | 354806 | 571 | 91734 |
| control | 21 | 0.3662 | 0.7323 | 410523 | 7834240 | 334877 | 541 | 97429 |

## Per arm and task (valid cells)

| arm | task | valid/cells | pass | recall-sourced | exam classes | median $ (off-peak) | median requests | same-turn rereads | recall errors | fv rejections | excluded from G2 (flag/leak/fs) | model-error turns | goal calls | failed attempts |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| arm1 | c1 | 3/3 | 3 | 0 | - | 0.0881 | 83 | 18 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| arm1 | c2 | 3/3 | 3 | 0 | - | 0.0039 | 5 | 4 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| arm1 | r1 | 3/3 | 3 | 3 | correct,correct,correct | 0.0057 | 19 | 1 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| arm1 | r2 | 3/3 | 3 | 3 | correct,correct,correct | 0.0109 | 27 | 2 | 0 | 0 | 3 (3/0/0) | 0 | 0 | 0 |
| arm1 | r3 | 3/3 | 3 | 3 | correct,correct,correct | 0.0048 | 18 | 3 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| arm1 | r4 | 3/3 | 3 | 3 | correct,correct,correct | 0.0035 | 16 | 1 | 0 | 0 | 1 (1/0/0) | 0 | 0 | 0 |
| arm1 | r5 | 3/3 | 3 | 3 | correct,correct,correct | 0.0074 | 13 | 12 | 0 | 0 | 1 (0/1/0) | 0 | 0 | 0 |
| arm2 | c1 | 3/3 | 3 | 0 | - | 0.0844 | 87 | 18 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| arm2 | c2 | 3/3 | 3 | 0 | - | 0.0042 | 8 | 2 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| arm2 | r1 | 3/3 | 3 | 3 | correct,correct,correct | 0.0055 | 19 | 5 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| arm2 | r2 | 3/3 | 3 | 3 | correct,correct,correct | 0.0119 | 28 | 1 | 0 | 0 | 2 (2/0/0) | 0 | 0 | 0 |
| arm2 | r3 | 3/3 | 3 | 3 | correct,correct,correct | 0.0053 | 14 | 3 | 0 | 0 | 1 (1/0/0) | 0 | 0 | 0 |
| arm2 | r4 | 3/3 | 3 | 3 | correct,correct,correct | 0.0035 | 15 | 2 | 0 | 0 | 1 (1/0/0) | 0 | 0 | 0 |
| arm2 | r5 | 3/3 | 3 | 3 | correct,correct,correct | 0.0066 | 16 | 10 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | c1 | 3/3 | 3 | 0 | - | 0.0804 | 85 | 11 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | c2 | 3/3 | 3 | 0 | - | 0.0035 | 5 | 0 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | r1 | 3/3 | 3 | 3 | correct,correct,correct | 0.0050 | 16 | 2 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | r2 | 3/3 | 3 | 3 | correct,correct,correct | 0.0131 | 31 | 4 | 0 | 0 | 1 (1/0/0) | 0 | 0 | 0 |
| control | r3 | 3/3 | 3 | 3 | correct,correct,correct | 0.0041 | 13 | 3 | 0 | 0 | 1 (1/0/0) | 0 | 0 | 0 |
| control | r4 | 3/3 | 3 | 3 | correct,correct,correct | 0.0081 | 22 | 1 | 0 | 0 | 2 (2/0/0) | 0 | 0 | 0 |
| control | r5 | 3/3 | 3 | 3 | correct,correct,correct | 0.0068 | 13 | 12 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |

## Gates

### arm1

| gate | check | arm | baseline | threshold | verdict | pairs/min |
|---|---|---|---|---|---|---|
| G1 (pass) | G1.total: pass | 21 | 21 (control) | 20 | pass | 21/17 |
| G1 (pass) | G1.per_task: pass | 21 | 21 (control) | no task with arm <= base - 2 | pass | 21/17 |
| G2 (insufficient) | G2a: recall-sourced correct exam answers |  |  (control) |  | insufficient 8 valid pairs < 10 required | 8/10 |
| G2 (insufficient) | G2b: errors on recall_turn/recall_search/recall_step/expand_result, all turns |  |  (control) |  | insufficient 8 valid pairs < 10 required | 8/10 |
| G2 (insufficient) | G2c: formatVersion rejections |  |  (control) |  | insufficient 8 valid pairs < 10 required | 8/10 |
| G2 (insufficient) | G2d: decoy, stale, hedged, wrong or CANNOT-RECOVER exam answers |  |  (control) |  | insufficient 8 valid pairs < 10 required | 8/10 |
| G3 (pass) | G3: sum of reread_same_turn_unchanged + reread_same_turn_after_edit over all 21 cells | 41 | 33 (control) | 43.25 | pass | 21/17 |
| G3 | report only | fold_then_reread 2, reread_cross_turn 52, repeat_tool_reminders 0 | fold_then_reread 1, reread_cross_turn 55, repeat_tool_reminders 0 | - | - | - |
| G4 (pass) | G4.median_ratio: median paired cost ratio arm/control | 0.9871 | paired (control) | 1.1 | pass | 21/17 |
| G4 (pass) | G4.total: sum of cost | 1.0166 | sum 0.3662 (control) | 0.402791 | pass | 21/17 |
| G4 (pass) | G4.requests: median paired request-count delta per cell | 0 | paired (control) | 1 | pass | 21/17 |
| G4 (pass) | G4.full_views: recall_turn view "full" calls | 0 | 3 (control) | 5 | pass | 21/17 |
| G5 (pass) | G5.closeout: completed turns ending in a text closeout | 86 | 85 (control) | 84 | pass | 21/17 |
| G5 (pass) | G5.step_limit: turns cut by maxStepsPerTurn (turn_end kind blocked) | 7 | 8 (control) | 9 | pass | 21/17 |

### arm2

| gate | check | arm | baseline | threshold | verdict | pairs/min |
|---|---|---|---|---|---|---|
| G1 (pass) | G1.total: pass | 21 | 21 (control) | 20 | pass | 21/17 |
| G1 (pass) | G1.per_task: pass | 21 | 21 (control) | no task with arm <= base - 2 | pass | 21/17 |
| G2 (insufficient) | G2a: recall-sourced correct exam answers |  |  (control) |  | insufficient 9 valid pairs < 10 required | 9/10 |
| G2 (insufficient) | G2b: errors on recall_turn/recall_search/recall_step/expand_result, all turns |  |  (control) |  | insufficient 9 valid pairs < 10 required | 9/10 |
| G2 (insufficient) | G2c: formatVersion rejections |  |  (control) |  | insufficient 9 valid pairs < 10 required | 9/10 |
| G2 (insufficient) | G2c.recovered: every arm 2 rejection recovered in the same turn |  |  (control) |  | insufficient 9 valid pairs < 10 required | 9/10 |
| G2 (insufficient) | G2d: decoy, stale, hedged, wrong or CANNOT-RECOVER exam answers |  |  (control) |  | insufficient 9 valid pairs < 10 required | 9/10 |
| G3 (pass) | G3: sum of reread_same_turn_unchanged + reread_same_turn_after_edit over all 21 cells | 41 | 33 (control) | 43.25 | pass | 21/17 |
| G3 | report only | fold_then_reread 2, reread_cross_turn 54, repeat_tool_reminders 0 | fold_then_reread 1, reread_cross_turn 55, repeat_tool_reminders 0 | - | - | - |
| G4 (arbitrate) | G4.median_ratio: median paired cost ratio arm/control | 1.0429 | paired (control) | 1.1 | pass | 21/17 |
| G4 (arbitrate) | G4.total: sum of cost | 1.0311 | sum 0.3662 (control) | 0.402791 | pass | 21/17 |
| G4 (arbitrate) | G4.requests: median paired request-count delta per cell | 2 | paired (control) | 1 | arbitrate (1.0 units) | 21/17 |
| G4 (arbitrate) | G4.full_views: recall_turn view "full" calls | 0 | 3 (control) | 5 | pass | 21/17 |
| G5 (pass) | G5.closeout: completed turns ending in a text closeout | 85 | 85 (control) | 84 | pass | 21/17 |
| G5 (pass) | G5.step_limit: turns cut by maxStepsPerTurn (turn_end kind blocked) | 8 | 8 (control) | 9 | pass | 21/17 |
| G6 (insufficient) | G6.first_try: first-try success rate of expand_result on a target in an earlier turn | 1.0 | 1.0 (control) | 0.9 | pass | 21/17 |
| G6 (insufficient) | G6.extra_hops: recall_turn/recall_search called only to obtain a locator the tape already gave | 3 | 2 (control) | 4 | pass | 21/17 |
| G6 (insufficient) | G6.vs_arm1.G2c: fv_rejections |  |  (arm1) |  | insufficient 8 valid pairs < 10 required | 8/10 |
| G6 (insufficient) | G6.vs_arm1.G2c.recovered: fv_rejections_unrecovered |  |  (arm1) |  | insufficient 8 valid pairs < 10 required | 8/10 |
| G6 (insufficient) | G6.vs_arm1.G2d: bad_exam_answers |  |  (arm1) |  | insufficient 8 valid pairs < 10 required | 8/10 |

## G2 exclusions (flagged access, leak, oracle via the file system)

- arm1 p110_r2_superseded_stamp.r1.arm1: flagged; T1 bash outside: /.git/*; T4 glob secret: .env
- arm1 p110_r2_superseded_stamp.r2.arm1: flagged; T6 bash outside: $AB/results/p110-20260927/work
- arm1 p110_r2_superseded_stamp.r3.arm1: flagged; T6 bash outside: / (find), outside: $AB/results/p110-20260927/work
- arm1 p110_r4_probe_compare.r2.arm1: flagged; T3 bash outside: $SP; T3 glob outside: $SP; T3 bash outside: /private/tmp/claude-5
- arm1 p110_r5_initial_failures.r3.arm1: leak; 
- arm2 p110_r2_superseded_stamp.r1.arm2: flagged; T6 bash outside: $AB/results/p110-20260927/work; T6 bash outside: $SP/
- arm2 p110_r2_superseded_stamp.r2.arm2: flagged; T6 bash outside: $AB/results/p110-20260927/work, secret: .env
- arm2 p110_r3_runbook_middle.r2.arm2: flagged; T2 bash outside: $AB/results/p110-20260927/work
- arm2 p110_r4_probe_compare.r3.arm2: flagged; T3 bash outside: $AB/results/p110-20260927/work; T3 bash outside: $SP/
- control p110_r2_superseded_stamp.r2.control: flagged; T4 glob secret: .env
- control p110_r3_runbook_middle.r3.control: flagged; T2 bash outside: $TMP(truncated), outside: $AB/results/p110-20260927; T2 bash outside: /node_
- control p110_r4_probe_compare.r2.control: flagged; T3 bash outside: $AB/results, outside: $AB/results/p110-20
- control p110_r4_probe_compare.r3.control: flagged; T3 bash outside: $AB/results/p110-20260927/work; T3 bash outside: $SP/

## Tool calls that referenced the key location (hold these logs back from the archive)

- lh1_incremental_build.r1.arm2 (p110-20260927) T1 bash: outside: /0, outside: /], secret: .env
- lh1_incremental_build.r1.control (p110-20260927) T1 bash: secret: .env
- lh1_incremental_build.r2.arm1 (p110-20260927) T6 bash: secret: .env
- lh1_incremental_build.r2.arm1 (p110-20260927) T6 bash: secret: .env
- lh1_incremental_build.r2.arm1 (p110-20260927) T6 bash: secret: .env
- lh1_incremental_build.r3.arm1 (p110-20260927) T1 bash: secret: .env
- lh1_incremental_build.r3.control (p110-20260927) T1 bash: secret: .env
- p110_r2_superseded_stamp.r1.arm1 (p110-20260927) T4 glob: secret: .env
- p110_r2_superseded_stamp.r2.arm2 (p110-20260927) T6 bash: outside: $AB/results/p110-20260927/work, secret: .env
- p110_r2_superseded_stamp.r2.control (p110-20260927) T4 glob: secret: .env
- p110_r4_probe_compare.r2.arm1 (p110-20260927) T3 bash: outside: $AB, outside: $AB/home-arm1, secret: DSH_HOME, sensitive: /home-arm1

Counts and paired deltas only; n = 3 per task and arm detects large effects only.
