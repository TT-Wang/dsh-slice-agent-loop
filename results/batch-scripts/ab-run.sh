#!/bin/bash
# 3 臂 × 2 场景串行(避免跨臂缓存挤占)。effort 全 low。slice-seal 阈值:12K/8/4。
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
LEDGER=results/20260902-longturn
for scen in l1_chain_migrate l2_ledger_state; do
  for arm in transcript slice-noseal slice-seal; do
    echo "════════ CELL $scen × $arm  $(date +%H:%M:%S) ════════"
    extra=""
    [ "$arm" = "slice-seal" ] && extra="--seal-tokens 12000 --batch 8 --keep 4"
    npx tsx scripts/run-scenario.mts results/20260902-longturn/scenarios-snapshot/$scen --arm $arm --effort low --ledger-dir $LEDGER $extra 2>&1 | tail -7 || echo "CELL-FAILED $scen $arm"
  done
done
echo "ALL-CELLS-DONE $(date +%H:%M:%S)"
