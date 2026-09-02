#!/bin/bash
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
for scen in l1_chain_migrate l2_ledger_state; do
  echo "════════ CELL $scen × state(K=1,push=0)  $(date +%H:%M:%S) ════════"
  npx tsx scripts/run-scenario.mts results/20260902-longturn-v2/scenarios-snapshot/$scen --arm state --effort low --hot 1 --push 0 --ledger-dir results/20260902-longturn-v2-r2/state-k1 2>&1 | grep -vE "^\s+at " | tail -6
done
echo "ALL-CELLS-DONE $(date +%H:%M:%S)"
