#!/bin/bash
# 配置 D(readBases + 索引结论 + 指针 + anchor=base)其余场景回归:等两条实验线结束再跑。
while ! grep -q ALL-CELLS-DONE-AB results/20260903-anchorbase/ab-run.log 2>/dev/null || ! grep -q ALL-CELLS-DONE-RP results/20260903-readptr/ab-run.log 2>/dev/null; do sleep 30; done
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
MT=results/20260902-multiturn/scenarios-snapshot; RT=results/20260826-retention/scenarios-snapshot; L=results/20260902-longturn-v2/scenarios-snapshot
for scen in s1_longhorizon_debug s4_multifile_refactor s5_standing_constraints s6_revert_by_reference s13_compact_amnesia s14b_recall_ladder n1_verbatim_restore n2_intent_ledger n3_rot_checkpoints s10_compactloss; do
  dir=$([ ${scen:0:1} = n ] && echo $RT || echo $MT)
  echo "════════ CELL $scen × slice[D]  $(date +%H:%M:%S) ════════"
  npx tsx scripts/run-scenario.mts $dir/$scen --arm slice-noseal --effort inherit --max-steps 250 --tools full --anchor base --ledger-dir results/20260903-anchorbase 2>&1 | grep -vE "^\s+at " | tail -6
done
for scen in l1_chain_migrate l2_ledger_state; do
  echo "════════ CELL $scen × slice[D,low,fs]  $(date +%H:%M:%S) ════════"
  npx tsx scripts/run-scenario.mts $L/$scen --arm slice-noseal --effort low --anchor base --ledger-dir results/20260903-anchorbase 2>&1 | grep -vE "^\s+at " | tail -6
done
echo "ALL-CELLS-DONE-AB2 $(date +%H:%M:%S)"
