<!-- Generated from ab_report.py output (pooled, then the batch alone, then the arbitration batch alone); paths normalized. See docs/p110-f-native-ab.md §14. -->

# P1-10 F-only native A/B summary: pooled batch + arbitration (decides)

Batches: p110f-20261022, p110f-20261022-arb (pooled, count margins x2, minimum pairs x2). Cells: 84 (84 valid). Baseline: control. Time: 2026-10-22T09:42:26+00:00 to 2026-10-22T12:49:43+00:00.
Spend (peak sheet): $2.8202 over 400 turns; by batch {'warm': 0.002579, 'pilot': 0.055306, 'warm2': 0.000336, 'p110f-20261022': 1.42153, 'p110f-20261022-arb': 1.340459}.

## Decision (computed from the pre-registered gates)

- F: do not ship F (failed: G3; pass with less than 1 unit of room: G4.requests)

## Structure (fingerprints)

| arm | system chars | slice tool JSON | prefix chars | prefix delta | tape header | mean tool line |
|---|---|---|---|---|---|---|
| F | 3651 | 5266 | 17787 | 0 | [76] | 52.9 |
| control | 3651 | 5266 | 17787 | None | [76] | 94.0 |

## Totals over valid gated cells

| arm | cells | $ off-peak | $ peak | miss | hit | out | requests | turn-first miss |
|---|---|---|---|---|---|---|---|---|
| F | 42 | 0.6792 | 1.3584 | 740119 | 15238656 | 620799 | 1144 | 168300 |
| control | 42 | 0.6768 | 1.3535 | 776328 | 15188864 | 605544 | 1149 | 165863 |

## Per arm and task (valid cells)

| arm | task | valid/cells | pass | recall-sourced | exam classes | median $ (off-peak) | median requests | same-turn rereads | recall errors | fv rejections | excluded from G2 (flag/leak/fs) | model-error turns | goal calls | failed attempts |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| F | c1 | 6/6 | 6 | 0 | - | 0.0810 | 89.5 | 34 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| F | c2 | 6/6 | 6 | 0 | - | 0.0048 | 9.0 | 2 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 1 |
| F | r1 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0056 | 19.0 | 4 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| F | r2 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0103 | 30.0 | 6 | 1 | 0 | 1 (1/0/0) | 0 | 0 | 0 |
| F | r3 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0041 | 19.5 | 8 | 3 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| F | r4 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0025 | 13.0 | 2 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| F | r5 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0062 | 12.5 | 3 | 1 | 0 | 1 (1/0/0) | 0 | 0 | 0 |
| control | c1 | 6/6 | 6 | 0 | - | 0.0793 | 89.5 | 22 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | c2 | 6/6 | 6 | 0 | - | 0.0047 | 9.0 | 3 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | r1 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0052 | 20.0 | 4 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | r2 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0100 | 28.0 | 5 | 0 | 0 | 3 (3/0/0) | 0 | 0 | 0 |
| control | r3 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0039 | 16.5 | 4 | 4 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | r4 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0026 | 13.5 | 2 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | r5 | 6/6 | 6 | 6 | correct,correct,correct,correct,correct,correct | 0.0063 | 12.5 | 1 | 0 | 0 | 1 (0/1/0) | 0 | 0 | 0 |

## Gates

### F

| gate | check | arm | baseline | threshold | verdict | room (units) | pairs/min |
|---|---|---|---|---|---|---|---|
| G1 (pass) | G1.total: pass | 42 | 42 (control) | 40 | pass | 2 | 42/34 |
| G1 (pass) | G1.per_task: pass | 42 | 42 (control) | no task with arm <= base - 4 | pass | 3 | 42/34 |
| G2 (pass) | G2a: recall-sourced correct exam answers | 25 | 25 (control) | 23 | pass | 2 | 25/20 |
| G2 (pass) | G2b: errors on recall_turn/recall_search/recall_step/expand_result, all turns | 4 | 4 (control) | 8 | pass | 4 | 25/20 |
| G2 (pass) | G2c: formatVersion rejections | 0 | 0 (control) | 4 | pass | 4 | 25/20 |
| G2 (pass) | G2c.recovered: every F rejection recovered in the same turn | 0 | 0 (control) | 0 | pass | - | 25/20 |
| G2 (pass) | G2d: decoy, stale, hedged, wrong or CANNOT-RECOVER exam answers | 0 | 0 (control) | 2 | pass | 2 | 25/20 |
| G3 (fail) | G3: sum of reread_same_turn_unchanged + reread_same_turn_after_edit over all 21 pairs, a mutation counting only when its tool result is not an error | 59 | 41 (control) | 55.25 | fail (3.75 units) | -3.75 | 42/34 |
| G3 | report only | rereads_same_turn_any 72, fold_then_reread 4, reread_cross_turn 93, repeat_tool_reminders 0 | rereads_same_turn_any 43, fold_then_reread 1, reread_cross_turn 96, repeat_tool_reminders 0 | - | - | - | - |
| G4 (pass) | G4.median_ratio: median paired cost ratio F/control | 1.0174 | paired (control) | 1.1 | pass | 1.6527 | 42/34 |
| G4 (pass) | G4.total: sum of cost | 1.0036 | sum 0.6768 (control) | 0.744448 | pass | 1.9276 | 42/34 |
| G4 (pass) | G4.requests: median paired request-count delta per cell | 0.5 | paired (control) | 1 | pass | 0.5 | 42/34 |
| G4 (pass) | G4.full_views: recall_turn view "full" calls | 4 | 2 (control) | 6 | pass | 2 | 42/34 |
| G5 (pass) | G5.closeout: completed turns ending in a text closeout | 167 | 164 (control) | 162 | pass | 5 | 42/34 |
| G5 (pass) | G5.step_limit: turns cut by maxStepsPerTurn (turn_end kind blocked) | 19 | 22 (control) | 24 | pass | 5 | 42/34 |
| G6 (pass) | G6.first_try: first-try success rate of expand_result on a target in an earlier turn | 0.9118 | 0.9184 (control) | 0.8184 | pass | 3 | 42/34 |
| G6 (pass) | G6.extra_hops: recall_turn/recall_search called only to obtain a locator the tape already gave | 5 | 4 (control) | 8 | pass | 3 | 42/34 |

## G2 exclusions (flagged access, leak, oracle via the file system)

- F p110_r2_superseded_stamp.r2.F: flagged; T6 bash outside: $AB/live/c-b6adc76c68; T6 bash outside: $SP, outside: /privat
- F p110_r5_initial_failures.r1.F: flagged; T1 bash outside: /private/tmp/combined.txt; T1 read outside: /private/tmp/combined.txt
- control p110_r2_superseded_stamp.r1.control: flagged; T1 bash outside: /very/long/path/to/file.py, outside: /very/long/path/to/file.py,; T1 bash outside: /very/long/path/to/file.py, outside: /very/long/path/to/file.py,; T1 bash outside: / (head), outside: /very/long/path/to/file.py, outside: /very/long/path/to/file.py,; T7 bash outside: /very/long/path
- control p110_r2_superseded_stamp.r2.control: flagged; T6 bash outside: /private/tmp/claude-501/-Users-tongtao-code-dsh-slice-agent-loop, outside: $AB/live/c-1e1182446d
- control p110_r2_superseded_stamp.r2.control: flagged; T6 bash outside: / (find)
- control p110_r5_initial_failures.r3.control: leak; 

Counts and paired deltas only; n = 3 per task and arm detects large effects only.

# P1-10 F-only native A/B summary: batch p110f-20261022 alone (before arbitration)

Batches: p110f-20261022. Cells: 42 (42 valid). Baseline: control. Time: 2026-10-22T09:42:26+00:00 to 2026-10-22T11:08:53+00:00.
Spend (peak sheet): $1.4798 over 214 turns; by batch {'warm': 0.002579, 'pilot': 0.055306, 'warm2': 0.000336, 'p110f-20261022': 1.42153}.

## Decision (computed from the pre-registered gates)

- F: arbitration (arbitrate: G4.full_views; pass with less than 1 unit of room: G4.requests): +3 reps of all seven tasks, both arms, then decide on the pooled 6 reps

## Structure (fingerprints)

| arm | system chars | slice tool JSON | prefix chars | prefix delta | tape header | mean tool line |
|---|---|---|---|---|---|---|
| F | 3651 | 5266 | 17787 | 0 | [76] | 52.9 |
| control | 3651 | 5266 | 17787 | None | [76] | 94.0 |

## Totals over valid gated cells

| arm | cells | $ off-peak | $ peak | miss | hit | out | requests | turn-first miss |
|---|---|---|---|---|---|---|---|---|
| F | 21 | 0.3505 | 0.7010 | 380244 | 7814272 | 321456 | 575 | 84107 |
| control | 21 | 0.3353 | 0.6705 | 368426 | 7545728 | 305119 | 580 | 84192 |

## Per arm and task (valid cells)

| arm | task | valid/cells | pass | recall-sourced | exam classes | median $ (off-peak) | median requests | same-turn rereads | recall errors | fv rejections | excluded from G2 (flag/leak/fs) | model-error turns | goal calls | failed attempts |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| F | c1 | 3/3 | 3 | 0 | - | 0.0825 | 91 | 20 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| F | c2 | 3/3 | 3 | 0 | - | 0.0045 | 9 | 0 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 1 |
| F | r1 | 3/3 | 3 | 3 | correct,correct,correct | 0.0052 | 19 | 3 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| F | r2 | 3/3 | 3 | 3 | correct,correct,correct | 0.0104 | 31 | 3 | 1 | 0 | 1 (1/0/0) | 0 | 0 | 0 |
| F | r3 | 3/3 | 3 | 3 | correct,correct,correct | 0.0038 | 18 | 2 | 1 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| F | r4 | 3/3 | 3 | 3 | correct,correct,correct | 0.0029 | 13 | 0 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| F | r5 | 3/3 | 3 | 3 | correct,correct,correct | 0.0075 | 13 | 0 | 1 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | c1 | 3/3 | 3 | 0 | - | 0.0801 | 87 | 12 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | c2 | 3/3 | 3 | 0 | - | 0.0044 | 8 | 1 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | r1 | 3/3 | 3 | 3 | correct,correct,correct | 0.0050 | 20 | 4 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | r2 | 3/3 | 3 | 3 | correct,correct,correct | 0.0123 | 30 | 2 | 0 | 0 | 2 (2/0/0) | 0 | 0 | 0 |
| control | r3 | 3/3 | 3 | 3 | correct,correct,correct | 0.0040 | 18 | 1 | 2 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | r4 | 3/3 | 3 | 3 | correct,correct,correct | 0.0026 | 14 | 2 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | r5 | 3/3 | 3 | 3 | correct,correct,correct | 0.0058 | 12 | 0 | 0 | 0 | 1 (0/1/0) | 0 | 0 | 0 |

## Gates

### F

| gate | check | arm | baseline | threshold | verdict | room (units) | pairs/min |
|---|---|---|---|---|---|---|---|
| G1 (pass) | G1.total: pass | 21 | 21 (control) | 20 | pass | 1 | 21/17 |
| G1 (pass) | G1.per_task: pass | 21 | 21 (control) | no task with arm <= base - 2 | pass | 1 | 21/17 |
| G2 (pass) | G2a: recall-sourced correct exam answers | 12 | 12 (control) | 11 | pass | 1 | 12/10 |
| G2 (pass) | G2b: errors on recall_turn/recall_search/recall_step/expand_result, all turns | 2 | 2 (control) | 4 | pass | 2 | 12/10 |
| G2 (pass) | G2c: formatVersion rejections | 0 | 0 (control) | 2 | pass | 2 | 12/10 |
| G2 (pass) | G2c.recovered: every F rejection recovered in the same turn | 0 | 0 (control) | 0 | pass | - | 12/10 |
| G2 (pass) | G2d: decoy, stale, hedged, wrong or CANNOT-RECOVER exam answers | 0 | 0 (control) | 1 | pass | 1 | 12/10 |
| G3 (pass) | G3: sum of reread_same_turn_unchanged + reread_same_turn_after_edit over all 21 pairs, a mutation counting only when its tool result is not an error | 28 | 22 (control) | 29.5 | pass | 1.5 | 21/17 |
| G3 | report only | rereads_same_turn_any 34, fold_then_reread 1, reread_cross_turn 46, repeat_tool_reminders 0 | rereads_same_turn_any 23, fold_then_reread 0, reread_cross_turn 47, repeat_tool_reminders 0 | - | - | - | - |
| G4 (arbitrate) | G4.median_ratio: median paired cost ratio F/control | 1.0136 | paired (control) | 1.1 | pass | 1.728 | 21/17 |
| G4 (arbitrate) | G4.total: sum of cost | 1.0455 | sum 0.3353 (control) | 0.368776 | pass | 1.0896 | 21/17 |
| G4 (arbitrate) | G4.requests: median paired request-count delta per cell | 1 | paired (control) | 1 | pass | -0.0 | 21/17 |
| G4 (arbitrate) | G4.full_views: recall_turn view "full" calls | 3 | 0 (control) | 2 | arbitrate (1 units) | -1 | 21/17 |
| G5 (pass) | G5.closeout: completed turns ending in a text closeout | 83 | 82 (control) | 81 | pass | 2 | 21/17 |
| G5 (pass) | G5.step_limit: turns cut by maxStepsPerTurn (turn_end kind blocked) | 10 | 11 (control) | 12 | pass | 2 | 21/17 |
| G6 (pass) | G6.first_try: first-try success rate of expand_result on a target in an earlier turn | 0.9474 | 0.9355 (control) | 0.8355 | pass | 2 | 21/17 |
| G6 (pass) | G6.extra_hops: recall_turn/recall_search called only to obtain a locator the tape already gave | 4 | 4 (control) | 6 | pass | 2 | 21/17 |

## G2 exclusions (flagged access, leak, oracle via the file system)

- F p110_r2_superseded_stamp.r2.F: flagged; T6 bash outside: $AB/live/c-b6adc76c68; T6 bash outside: $SP, outside: /privat
- control p110_r2_superseded_stamp.r1.control: flagged; T1 bash outside: /very/long/path/to/file.py, outside: /very/long/path/to/file.py,; T1 bash outside: /very/long/path/to/file.py, outside: /very/long/path/to/file.py,; T1 bash outside: / (head), outside: /very/long/path/to/file.py, outside: /very/long/path/to/file.py,; T7 bash outside: /very/long/path
- control p110_r2_superseded_stamp.r2.control: flagged; T6 bash outside: /private/tmp/claude-501/-Users-tongtao-code-dsh-slice-agent-loop, outside: $AB/live/c-1e1182446d
- control p110_r5_initial_failures.r3.control: leak; 

Counts and paired deltas only; n = 3 per task and arm detects large effects only.

# P1-10 F-only native A/B summary: arbitration batch p110f-20261022-arb alone (not a decision input)

Batches: p110f-20261022-arb. Cells: 42 (42 valid). Baseline: control. Time: 2026-10-22T11:10:46+00:00 to 2026-10-22T12:49:43+00:00.
Spend (peak sheet): $2.8202 over 400 turns; by batch {'warm': 0.002579, 'pilot': 0.055306, 'warm2': 0.000336, 'p110f-20261022': 1.42153, 'p110f-20261022-arb': 1.340459}.

## Decision (computed from the pre-registered gates)

- F: do not ship F (failed: G3)

## Structure (fingerprints)

| arm | system chars | slice tool JSON | prefix chars | prefix delta | tape header | mean tool line |
|---|---|---|---|---|---|---|
| F | 3651 | 5266 | 17787 | 0 | [76] | 52.9 |
| control | 3651 | 5266 | 17787 | None | [76] | 94.0 |

## Totals over valid gated cells

| arm | cells | $ off-peak | $ peak | miss | hit | out | requests | turn-first miss |
|---|---|---|---|---|---|---|---|---|
| F | 21 | 0.3287 | 0.6574 | 359875 | 7424384 | 299343 | 569 | 84193 |
| control | 21 | 0.3415 | 0.6830 | 407902 | 7643136 | 300425 | 569 | 81671 |

## Per arm and task (valid cells)

| arm | task | valid/cells | pass | recall-sourced | exam classes | median $ (off-peak) | median requests | same-turn rereads | recall errors | fv rejections | excluded from G2 (flag/leak/fs) | model-error turns | goal calls | failed attempts |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| F | c1 | 3/3 | 3 | 0 | - | 0.0782 | 89 | 14 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| F | c2 | 3/3 | 3 | 0 | - | 0.0052 | 9 | 2 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| F | r1 | 3/3 | 3 | 3 | correct,correct,correct | 0.0058 | 20 | 1 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| F | r2 | 3/3 | 3 | 3 | correct,correct,correct | 0.0102 | 28 | 3 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| F | r3 | 3/3 | 3 | 3 | correct,correct,correct | 0.0042 | 20 | 6 | 2 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| F | r4 | 3/3 | 3 | 3 | correct,correct,correct | 0.0024 | 13 | 2 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| F | r5 | 3/3 | 3 | 3 | correct,correct,correct | 0.0050 | 12 | 3 | 0 | 0 | 1 (1/0/0) | 0 | 0 | 0 |
| control | c1 | 3/3 | 3 | 0 | - | 0.0790 | 92 | 10 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | c2 | 3/3 | 3 | 0 | - | 0.0050 | 10 | 2 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | r1 | 3/3 | 3 | 3 | correct,correct,correct | 0.0053 | 20 | 0 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | r2 | 3/3 | 3 | 3 | correct,correct,correct | 0.0095 | 26 | 3 | 0 | 0 | 1 (1/0/0) | 0 | 0 | 0 |
| control | r3 | 3/3 | 3 | 3 | correct,correct,correct | 0.0039 | 14 | 3 | 2 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | r4 | 3/3 | 3 | 3 | correct,correct,correct | 0.0026 | 12 | 0 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |
| control | r5 | 3/3 | 3 | 3 | correct,correct,correct | 0.0088 | 14 | 1 | 0 | 0 | 0 (0/0/0) | 0 | 0 | 0 |

## Gates

### F

| gate | check | arm | baseline | threshold | verdict | room (units) | pairs/min |
|---|---|---|---|---|---|---|---|
| G1 (pass) | G1.total: pass | 21 | 21 (control) | 20 | pass | 1 | 21/17 |
| G1 (pass) | G1.per_task: pass | 21 | 21 (control) | no task with arm <= base - 2 | pass | 1 | 21/17 |
| G2 (pass) | G2a: recall-sourced correct exam answers | 13 | 13 (control) | 12 | pass | 1 | 13/10 |
| G2 (pass) | G2b: errors on recall_turn/recall_search/recall_step/expand_result, all turns | 2 | 2 (control) | 4 | pass | 2 | 13/10 |
| G2 (pass) | G2c: formatVersion rejections | 0 | 0 (control) | 2 | pass | 2 | 13/10 |
| G2 (pass) | G2c.recovered: every F rejection recovered in the same turn | 0 | 0 (control) | 0 | pass | - | 13/10 |
| G2 (pass) | G2d: decoy, stale, hedged, wrong or CANNOT-RECOVER exam answers | 0 | 0 (control) | 1 | pass | 1 | 13/10 |
| G3 (fail) | G3: sum of reread_same_turn_unchanged + reread_same_turn_after_edit over all 21 pairs, a mutation counting only when its tool result is not an error | 31 | 19 (control) | 25.75 | fail (5.25 units) | -5.25 | 21/17 |
| G3 | report only | rereads_same_turn_any 38, fold_then_reread 3, reread_cross_turn 47, repeat_tool_reminders 0 | rereads_same_turn_any 20, fold_then_reread 1, reread_cross_turn 49, repeat_tool_reminders 0 | - | - | - | - |
| G4 (pass) | G4.median_ratio: median paired cost ratio F/control | 1.0211 | paired (control) | 1.1 | pass | 1.5774 | 21/17 |
| G4 (pass) | G4.total: sum of cost | 0.9625 | sum 0.3415 (control) | 0.375672 | pass | 2.7503 | 21/17 |
| G4 (pass) | G4.requests: median paired request-count delta per cell | 0 | paired (control) | 1 | pass | 1.0 | 21/17 |
| G4 (pass) | G4.full_views: recall_turn view "full" calls | 1 | 2 (control) | 4 | pass | 3 | 21/17 |
| G5 (pass) | G5.closeout: completed turns ending in a text closeout | 84 | 82 (control) | 81 | pass | 3 | 21/17 |
| G5 (pass) | G5.step_limit: turns cut by maxStepsPerTurn (turn_end kind blocked) | 9 | 11 (control) | 12 | pass | 3 | 21/17 |
| G6 (pass) | G6.first_try: first-try success rate of expand_result on a target in an earlier turn | 0.8667 | 0.8889 (control) | 0.7889 | pass | 1 | 21/17 |
| G6 (pass) | G6.extra_hops: recall_turn/recall_search called only to obtain a locator the tape already gave | 1 | 0 (control) | 2 | pass | 1 | 21/17 |

## G2 exclusions (flagged access, leak, oracle via the file system)

- F p110_r5_initial_failures.r1.F: flagged; T1 bash outside: /private/tmp/combined.txt; T1 read outside: /private/tmp/combined.txt
- control p110_r2_superseded_stamp.r2.control: flagged; T6 bash outside: / (find)

Counts and paired deltas only; n = 3 per task and arm detects large effects only.
