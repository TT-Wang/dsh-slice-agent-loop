#!/bin/bash
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
for scen in l1_chain_migrate l2_ledger_state; do
  echo "════════ CELL $scen × stream  $(date +%H:%M:%S) ════════"
  npx tsx scripts/run-scenario.mts results/20260902-longturn-v2/scenarios-snapshot/$scen --arm stream --effort low --ledger-dir results/20260902-longturn-v3 2>&1 | grep -vE "^\s+at " | tail -6
done
echo "ALL-CELLS-DONE $(date +%H:%M:%S)"
