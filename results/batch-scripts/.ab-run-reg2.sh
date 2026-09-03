#!/bin/bash
# 回归批次结束后再补两次 l1(44/45 那次是模型漏写节点 2,与折叠无关;用重复运行确认)。
while ! grep -q ALL-CELLS-DONE-REG results/20260903-fold-routing/ab-run.log; do sleep 30; done
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
for rep in r2 r3; do
  echo "════════ CELL l1_chain_migrate × slice-noseal[routing,$rep]  $(date +%H:%M:%S) ════════"
  npx tsx scripts/run-scenario.mts results/20260902-longturn-v2/scenarios-snapshot/l1_chain_migrate --arm slice-noseal --effort low --ledger-dir results/20260903-fold-routing/$rep 2>&1 | grep -vE "^\s+at " | tail -6
done
echo "ALL-CELLS-DONE-REG2 $(date +%H:%M:%S)"
