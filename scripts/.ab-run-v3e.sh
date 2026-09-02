#!/bin/bash
# v3.2 候选:精简标记(默认)× 有/无结构块上限 4 × l1/l2。等批次 d 结束。
while ! grep -q ALL-CELLS-DONE-D results/20260902-longturn-v3d/ab-run.log; do sleep 20; done
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
run() { local scen=$1; shift; local tag=$1; shift
  echo "════════ CELL $scen × stream[$tag]  $(date +%H:%M:%S) ════════"
  npx tsx scripts/run-scenario.mts results/20260902-longturn-v2/scenarios-snapshot/$scen --arm stream --effort low --ledger-dir results/20260902-longturn-v3e/$tag "$@" 2>&1 | grep -vE "^\s+at " | tail -6; }
for scen in l1_chain_migrate l2_ledger_state; do run $scen lean; done
for scen in l1_chain_migrate l2_ledger_state; do run $scen lean-cap4 --digest-block-cap 4; done
echo "ALL-CELLS-DONE-E $(date +%H:%M:%S)"
