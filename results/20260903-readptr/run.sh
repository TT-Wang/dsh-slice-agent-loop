#!/bin/bash
# 读取即锚定(readBases)实验:多轮编码 s1/s2/s3 + 小文件多轮 n2,slice 臂,历史条件。对照 = 今天早些时候无 readBases 的同条件运行。
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
for scen in s2_taskdag_scheduler s3_intervalset_algebra s1_longhorizon_debug n2_intent_ledger; do
  dir=$([ ${scen:0:1} = n ] && echo results/20260826-retention/scenarios-snapshot || echo results/20260902-multiturn/scenarios-snapshot)
  echo "════════ CELL $scen × slice[readBases+pointer]  $(date +%H:%M:%S) ════════"
  npx tsx scripts/run-scenario.mts $dir/$scen --arm slice-noseal --effort inherit --max-steps 250 --tools full --ledger-dir results/20260903-readptr 2>&1 | grep -vE "^\s+at " | tail -6
done
echo "ALL-CELLS-DONE-RP $(date +%H:%M:%S)"
