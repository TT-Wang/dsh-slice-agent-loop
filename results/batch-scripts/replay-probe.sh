#!/bin/bash
set -a; source ~/.dsh/.env; set +a
export SLICE_CALL_LEDGER_DIR="$PWD/results/sidecars"
echo "════════ REPLAY 026 × transcript (peers=rc8)  $(date +%H:%M:%S) ════════"
npx tsx scripts/run-replay.mts --case results/20260902-replay/corpus/dsh-slice-agent-loop-026-458f221 --arm transcript --effort low --peers ~/code/deepseek-harness-rc8 --ledger-dir results/20260902-replay/ledgers 2>&1 | grep -vE "^\s+at " | tail -8
echo "REPLAY-PROBE-DONE $(date +%H:%M:%S)"
