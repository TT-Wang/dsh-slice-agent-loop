#!/bin/bash
# v3.2 复验多轮场景:n2/n3 × stream(惰性提取 + 精简标记)。等批次 e 结束。
while ! grep -q ALL-CELLS-DONE-E results/20260902-longturn-v3e/ab-run.log; do sleep 20; done
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
for scen in n2_intent_ledger n3_rot_checkpoints; do
  echo "════════ CELL $scen × stream[v3.2]  $(date +%H:%M:%S) ════════"
  npx tsx scripts/run-scenario.mts results/20260826-retention/scenarios-snapshot/$scen --arm stream --effort low --ledger-dir results/20260902-longturn-v3f 2>&1 | grep -vE "^\s+at " | tail -6
done
echo "ALL-CELLS-DONE-F $(date +%H:%M:%S)"
