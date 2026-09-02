#!/bin/bash
# v3.2 候选:结构块上限 4 × l1/l2。等批次 d 结束。
while ! grep -q ALL-CELLS-DONE-D results/20260902-longturn-v3d/ab-run.log; do sleep 20; done
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
for scen in l1_chain_migrate l2_ledger_state; do
  echo "════════ CELL $scen × stream[cap4]  $(date +%H:%M:%S) ════════"
  npx tsx scripts/run-scenario.mts results/20260902-longturn-v2/scenarios-snapshot/$scen --arm stream --effort low --digest-block-cap 4 --ledger-dir results/20260902-longturn-v3e 2>&1 | grep -vE "^\s+at " | tail -6
done
echo "ALL-CELLS-DONE-E $(date +%H:%M:%S)"
