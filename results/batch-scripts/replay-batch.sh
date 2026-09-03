#!/bin/bash
# 回放:026 补 slice-noseal/state;051 三臂。peers 统一 rc8(老 API 时代)。串行。
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
C=results/20260902-replay/corpus; L=results/20260902-replay/ledgers; P=~/code/deepseek-harness-rc8
run() { echo "════════ REPLAY $1 × $2  $(date +%H:%M:%S) ════════"; npx tsx scripts/run-replay.mts --case $C/$1 --arm $2 --effort low --peers $P --ledger-dir $L 2>&1 | grep -vE "^\s+at " | tail -6; }
run dsh-slice-agent-loop-026-458f221 slice-noseal
run dsh-slice-agent-loop-026-458f221 state
run dsh-assembler-051-17cad5d transcript
run dsh-assembler-051-17cad5d slice-noseal
run dsh-assembler-051-17cad5d state
echo "REPLAY-BATCH-DONE $(date +%H:%M:%S)"
