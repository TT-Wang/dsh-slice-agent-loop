#!/bin/bash
# 合并 Headroom 式内容路由后的回归:l1/l2(产品默认条件)+ s6(历史条件;唯一折过 bash 输出的多轮场景)。
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
for scen in l1_chain_migrate l2_ledger_state; do
  echo "════════ CELL $scen × slice-noseal[routing]  $(date +%H:%M:%S) ════════"
  npx tsx scripts/run-scenario.mts results/20260902-longturn-v2/scenarios-snapshot/$scen --arm slice-noseal --effort low --ledger-dir results/20260903-fold-routing 2>&1 | grep -vE "^\s+at " | tail -6
done
echo "════════ CELL s6_revert_by_reference × slice-noseal[routing,inherit,steps250,tools=full]  $(date +%H:%M:%S) ════════"
npx tsx scripts/run-scenario.mts results/20260902-multiturn/scenarios-snapshot/s6_revert_by_reference --arm slice-noseal --effort inherit --max-steps 250 --tools full --ledger-dir results/20260903-fold-routing 2>&1 | grep -vE "^\s+at " | tail -6
echo "ALL-CELLS-DONE-REG $(date +%H:%M:%S)"
