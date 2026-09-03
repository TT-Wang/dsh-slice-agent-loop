#!/bin/bash
# 交叉验证:多轮召回型场景 n2/n3 × transcript / slice-noseal / stream(v3.1)。等批次 c 结束。
while ! grep -q ALL-CELLS-DONE-B results/20260902-longturn-v3b/ab-run.log; do sleep 20; done
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
for scen in n2_intent_ledger n3_rot_checkpoints; do
  for arm in stream slice-noseal transcript; do
    echo "════════ CELL $scen × $arm  $(date +%H:%M:%S) ════════"
    npx tsx scripts/run-scenario.mts results/20260826-retention/scenarios-snapshot/$scen --arm $arm --effort low --ledger-dir results/20260902-longturn-v3d 2>&1 | grep -vE "^\s+at " | tail -6
  done
done
echo "ALL-CELLS-DONE-D $(date +%H:%M:%S)"
