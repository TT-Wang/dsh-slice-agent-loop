#!/bin/bash
# v2 重载荷:state 臂 + 用修好 cwd 的 runner 重跑 slice 两臂。串行。effort low。
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
LEDGER=results/20260902-longturn-v2-r2
for scen in l1_chain_migrate l2_ledger_state; do
  for arm in state slice-noseal slice-seal; do
    echo "════════ CELL $scen × $arm  $(date +%H:%M:%S) ════════"
    extra=""
    [ "$arm" = "slice-seal" ] && extra="--seal-tokens 40000 --batch 8 --keep 4"
    npx tsx scripts/run-scenario.mts results/20260902-longturn-v2/scenarios-snapshot/$scen --arm $arm --effort low --ledger-dir $LEDGER $extra 2>&1 | grep -vE "^\s+at " | tail -8 || echo "CELL-FAILED $scen $arm"
  done
done
echo "ALL-CELLS-DONE $(date +%H:%M:%S)"
