# Native format-3 slice session fixture

`slice-v3-session.v3.jsonl` was written by the published DSH `0.1.5-rc.2` JSONL
provider with the native loop and the slice plugin at `406f513` (the last
format-3 build), using `tests/native-harness.ts` of that commit with
`history.keepRecentTurns: 0`. Format 3 is what every 0.1.5 user session on disk
looks like. The model and the `fixture_read` tool were deterministic local
fixtures; no provider calls or user session data were involved.

- Turn 1 calls `fixture_read` twice in one assistant step (results at seqs **11,
  13**), then replies.
- Turn 2 calls it once (result at seq **29**), then replies.
- Turn 3 replies without tools.
- A runtime-context section changes every turn (`RUNTIME V3_RUNTIME_<n>`), so the
  system-prompt plugin wrote three user-role snapshots (seqs 6, 25, 41); 41 is
  the live one.
- The slice tape sealed turns 1 and 2 (entries at seqs **22, 38**, source
  `{ kind: 'plugin', plugin: 'slice:history' }`); each entry absorbed its own
  superseded snapshot and cites results as `expand_result({"seq":N,"formatVersion":3})`.

Restored by DSH 0.1.7 into format 4 the sequence numbers do not move, but the
sources become `plugin:slice:history`, `runtime-context` and `system-prompt`, and
tool results become tool-role messages. The frozen entry text, including its
format-3 locators, must stay byte for byte, and those locators must be refused
with refresh guidance rather than relabelled.

Keep the file in its provider-written form. Do not rewrite its tape, normalize
its seqs, or regenerate it with the current host; that would remove the
migration case being tested.
