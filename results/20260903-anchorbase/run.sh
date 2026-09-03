#!/bin/bash
# 锚定只存完整 base(+ readBases + 索引结论 + 指针):s2、s3,slice 臂,历史条件。
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
for scen in s2_taskdag_scheduler s3_intervalset_algebra; do
  echo "════════ CELL $scen × slice[anchor=base]  $(date +%H:%M:%S) ════════"
  npx tsx scripts/run-scenario.mts results/20260902-multiturn/scenarios-snapshot/$scen --arm slice-noseal --effort inherit --max-steps 250 --tools full --anchor base --ledger-dir results/20260903-anchorbase 2>&1 | grep -vE "^\s+at " | tail -6
done
echo "ALL-CELLS-DONE-AB $(date +%H:%M:%S)"
