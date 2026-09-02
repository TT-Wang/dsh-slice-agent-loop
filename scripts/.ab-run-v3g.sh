#!/bin/bash
# 最终配置(v3.2:精简标记 + 结构块上限 4 + 提取第 3 步 + 契约第 8 步起)重复 2 次 × l1/l2,取均值。等批次 f 结束。
while ! grep -q ALL-CELLS-DONE-F results/20260902-longturn-v3f/ab-run.log; do sleep 20; done
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
for rep in r1 r2; do for scen in l1_chain_migrate l2_ledger_state; do
  echo "════════ CELL $scen × stream[final-$rep]  $(date +%H:%M:%S) ════════"
  npx tsx scripts/run-scenario.mts results/20260902-longturn-v2/scenarios-snapshot/$scen --arm stream --effort low --digest-block-cap 4 --ledger-dir results/20260902-longturn-v3g/$rep 2>&1 | grep -vE "^\s+at " | tail -6
done; done
echo "ALL-CELLS-DONE-G $(date +%H:%M:%S)"
