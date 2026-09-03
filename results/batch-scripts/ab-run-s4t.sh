#!/bin/bash
# s4 没有历史 default 基线,slice 两次同一项失败:补一格 transcript(同条件)定位原因。等主批次结束。
while ! grep -q ALL-CELLS-DONE-MT results/20260902-multiturn/ab-run.log; do sleep 30; done
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
echo "════════ CELL s4_multifile_refactor × transcript[inherit,steps250,tools=full]  $(date +%H:%M:%S) ════════"
npx tsx scripts/run-scenario.mts results/20260902-multiturn/scenarios-snapshot/s4_multifile_refactor --arm transcript --effort inherit --max-steps 250 --tools full --ledger-dir results/20260902-multiturn 2>&1 | grep -vE "^\s+at " | tail -6
echo "ALL-CELLS-DONE-S4T $(date +%H:%M:%S)"
