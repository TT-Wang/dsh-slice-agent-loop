#!/bin/bash
# 公平对照:两臂同代码、同 runner、同条件(effort inherit=high、250 步、完整工具栈)。臂:transcript
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
for scen in n1_verbatim_restore n2_intent_ledger n3_rot_checkpoints s1_longhorizon_debug s2_taskdag_scheduler s3_intervalset_algebra s4_multifile_refactor s5_standing_constraints s6_revert_by_reference s13_compact_amnesia s14b_recall_ladder l1_chain_migrate l2_ledger_state s10_compactloss; do
  echo "════════ CELL $scen × transcript  $(date +%H:%M:%S) ════════"
  npx tsx scripts/run-scenario.mts results/20260903-fair/scenarios-snapshot/$scen --arm transcript --effort inherit --max-steps 250 --tools full --ledger-dir results/20260903-fair/transcript 2>&1 | grep -vE "^\s+at " | tail -6
done
echo "ALL-CELLS-DONE-FAIR-transcript $(date +%H:%M:%S)"
