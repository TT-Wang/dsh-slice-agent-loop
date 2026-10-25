# svs2 cost model and ladder after the pilot

`svs2_plan.py --baseline AB/vault/baseline --pilot AB/vault/results/pilot --ledger AB/vault/spend.jsonl` after the pilot (2026-10-24 08:13 UTC; record §13.5). The warm stage's six cells already ran as batch `warm` ($0.0052) and are priced again here, a $0.007 overstatement.

cap $10.00 at peak; stop line (cap - reserve - margin) $8.65; planning target $7.00; spent so far $0.7132
per-cell prior (peak): c1 $0.1948, c2 $0.0105, f1 $0.3143, hello $0.0012, r2 $0.0258
pre-batch projection per cell (pilot mean x safety, else prior): a:c1 $0.2334, b:c1 $0.2209, c:c1 $0.1606, c:f1 $0.2347 (4 pilot cells)

| stage | tasks | reps | cells | prior $ | pre-batch $ | estimate $ | cells to run | to run $ | affordable now |
|---|---|---|---|---|---|---|---|---|---|
| warm | hello | [1, 2] | 6 | 0.0072 | 0.0072 | 0.0072 | 6 | 0.0072 | yes |
| S1 | c1,c2,r2,f1 | [1, 2] | 24 | 3.2725 | 3.1740 | 2.8908 | 24 | 2.8908 | yes |
| S2 | c1,c2 | [3] | 6 | 0.6159 | 0.6462 | 0.5438 | 6 | 0.5438 | yes |
| S3 | f1 | [3] | 3 | 0.9428 | 0.8632 | 0.8241 | 3 | 0.8241 | yes |
| S4 | c1,c2 | [4] | 6 | 0.6159 | 0.6462 | 0.5438 | 6 | 0.5438 | yes |
| S5 | r2 | [3, 4] | 6 | 0.1550 | 0.1550 | 0.1550 | 6 | 0.1550 | yes |

full design (pre-batch projection) $5.4918 + arbitration reserve $0.9753 (8 cells) = $6.4671; arbitration at measured means $0.8197; planning ladder dropped nothing; projected end $6.4976; expected without the safety factor $4.6744 (no arbitration)

