#!/bin/bash
# 只跑 slice(默认含轮内折叠)一臂:s 系列挂完整工具栈;l1/l2 与既有各臂同栈(仅 fs)。
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
SNAP=results/20260902-multiturn/scenarios-snapshot
for scen in s1_longhorizon_debug s2_taskdag_scheduler s3_intervalset_algebra s4_multifile_refactor s5_standing_constraints s6_revert_by_reference s13_compact_amnesia s14b_recall_ladder s10_compactloss; do
  echo "════════ CELL $scen × slice-noseal[fold,tools=full]  $(date +%H:%M:%S) ════════"
  npx tsx scripts/run-scenario.mts $SNAP/$scen --arm slice-noseal --effort low --tools full --ledger-dir results/20260902-multiturn 2>&1 | grep -vE "^\s+at " | tail -6
done
for scen in l1_chain_migrate l2_ledger_state; do
  echo "════════ CELL $scen × slice-noseal[fold]  $(date +%H:%M:%S) ════════"
  npx tsx scripts/run-scenario.mts results/20260902-longturn-v2/scenarios-snapshot/$scen --arm slice-noseal --effort low --ledger-dir results/20260902-multiturn 2>&1 | grep -vE "^\s+at " | tail -6
done
echo "ALL-CELLS-DONE-MT $(date +%H:%M:%S)"
