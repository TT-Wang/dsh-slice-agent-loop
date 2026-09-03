#!/bin/bash
# v3.1 = <stream> 可供性说明 + 旁路 effort off(默认);再跑 no-rules 消融。
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
run() { local scen=$1; shift; local tag=$1; shift
  echo "════════ CELL $scen × stream[$tag]  $(date +%H:%M:%S) ════════"
  npx tsx scripts/run-scenario.mts results/20260902-longturn-v2/scenarios-snapshot/$scen --arm stream --effort low --ledger-dir results/20260902-longturn-v3b/$tag "$@" 2>&1 | grep -vE "^\s+at " | tail -6; }
for scen in l1_chain_migrate l2_ledger_state; do run $scen v3.1; done
for scen in l1_chain_migrate l2_ledger_state; do run $scen no-rules --no-rules; done
echo "ALL-CELLS-DONE-B $(date +%H:%M:%S)"
