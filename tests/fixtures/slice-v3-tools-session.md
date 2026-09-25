# Native format-3 slice session fixture with every result shape

`slice-v3-tools-session.v3.jsonl` was written by the published DSH `0.1.5-rc.2`
JSONL provider with the native loop and the slice plugin at `406f513` (the last
format-3 build), using `tests/native-harness.ts` and
`tests/fixture-code-runtime.ts` of that commit. The configuration was
`history.keepRecentTurns: 0`, `fold.pinSteps: 0` and `digest.minChars: 1500`,
and tools were presented as both direct and PTC tools. The model, the tools and
the PTC runtime were deterministic local fixtures; no provider calls or user
session data were involved.

- Turn 1 calls `read` (`a.ts`) and `echo` in one assistant step (results at seqs
  **11, 13**).
- Turn 2 calls `run_code`; its program dispatches a nested `read` of `nested.ts`
  (`tool/ptc-dispatch-start` 29, `tool/ptc-dispatch` 30, outer result **31**).
- Turn 3 calls `read` (`b.ts`) and `boom` in parallel; `boom` throws, so its
  result at seq **49** is an error result.
- Turn 4 calls `bigread`, a 402-line log (original at seq **65**). The fold
  replaced it at seq **67**; the replacement cites `[65]` and its hint reads
  `expand_result({"seq": 65, "formatVersion": 3})`. Step 2 reads `c.ts` (72).
- Turn 5 replies without tools.
- A runtime-context section changes every turn (`RUNTIME V3TICK_<n>`). The slice
  tape sealed turns 1 to 4 (entries at seqs **22, 40, 58, 81**, source
  `{ kind: 'plugin', plugin: 'slice:history' }`).

Restored by DSH 0.1.7 into format 4, the sequence numbers do not move. Each
result becomes one tool-role message (`isError` kept on seq 49), the fold
replacement keeps its frozen text, and the nested dispatch keeps its content.

Keep the file in its provider-written form. Do not rewrite it, normalize its
seqs, or regenerate it with the current host; that would remove the migration
case being tested.
