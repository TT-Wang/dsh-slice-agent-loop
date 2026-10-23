# svs2 cost model and ladder (before any paid call)

`svs2_plan.py --baseline AB/vault/baseline` at the build stage (priors from the imported baseline cells, nothing measured, nothing spent).

cap $10.00 at peak; stop line (cap - reserve - margin) $8.65; planning target $7.00; spent so far $0.0000
per-cell prior (peak): c1 $0.1948, c2 $0.0105, f1 $0.3143, hello $0.0012, r2 $0.0258

| stage | tasks | reps | cells | prior $ | estimate $ | cells to run | to run $ | affordable now |
|---|---|---|---|---|---|---|---|---|
| warm | hello | [1, 2] | 6 | 0.0072 | 0.0072 | 6 | 0.0072 | yes |
| S1 | c1,c2,r2,f1 | [1, 2] | 24 | 3.2725 | 3.2725 | 24 | 3.2725 | yes |
| S2 | c1,c2 | [3] | 6 | 0.6159 | 0.6159 | 6 | 0.6159 | yes |
| S3 | f1 | [3] | 3 | 0.9428 | 0.9428 | 3 | 0.9428 | yes |
| S4 | c1,c2 | [4] | 6 | 0.6159 | 0.6159 | 6 | 0.6159 | yes |
| S5 | r2 | [3, 4] | 6 | 0.1550 | 0.1550 | 6 | 0.1550 | yes |

full design $5.6093 + arbitration reserve $0.8212 (8 cells) = $6.4305; planning ladder dropped nothing; projected end $6.4305; expected without the safety factor $4.6744 (no arbitration)

