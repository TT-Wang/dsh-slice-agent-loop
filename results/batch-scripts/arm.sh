#!/bin/bash
# 通用单格:arm.sh <ledger-dir> <scenario> <arm> <flags...>;SCEN_ROOT 可指向别的场景快照目录。
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
dir=$1; scen=$2; arm=$3; shift 3
echo "════════ CELL $scen × $arm[$*]  $(date +%H:%M:%S) ════════"
npx tsx scripts/run-scenario.mts ${SCEN_ROOT:-results/20260902-multiturn/scenarios-snapshot}/$scen --arm $arm "$@" --ledger-dir $dir 2>&1 | grep -vE "^\s+at " | tail -6
echo "CELL-DONE $scen $(date +%H:%M:%S)"
