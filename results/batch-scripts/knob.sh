#!/bin/bash
# 单格跑批:knob.sh <ledger-dir> <scenario> <extra flags...>;slice 臂,历史条件(effort inherit / 250 步 / 全工具)。
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
dir=$1; scen=$2; shift 2
echo "════════ CELL $scen × slice[$*]  $(date +%H:%M:%S) ════════"
npx tsx scripts/run-scenario.mts ${SCEN_ROOT:-results/20260902-multiturn/scenarios-snapshot}/$scen --arm slice-noseal --effort inherit --max-steps 250 --tools full "$@" --ledger-dir $dir 2>&1 | grep -vE "^\s+at " | tail -6
echo "CELL-DONE $scen $(date +%H:%M:%S)"
