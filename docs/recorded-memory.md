# Recorded memory: offline reducer

`buildContinuity(session, policy)` in `src/state/reducer.ts` is an offline / analysis
reducer, retained with historical tests. It is not called by live sealing or resume.
The current path is `planSeal` / `sealCompletedTurns` in `src/context.ts`, with
successful read observations in `src/context-reads.ts`. The offline reducer reuses
the conversation ring, turn digest, reply caps, and tape compaction from `continuity.ts`.

Only append-origin human messages enter the human conversation ring. Steering
adds to the current turn's request. Append-origin assistant and tool outcomes
contribute replies, the final unresolved tool error, and configured check
summaries. Generated replacement messages never become additional conversations.
Runtime and other plugin messages remain the stock surface policy's responsibility.

`recordedFileObservations(events)` reads existing `tool/call`, `tool/result`, and
`tool/ptc-dispatch` records (named `tool/code-dispatch` on the historical alpha.2 host). It preserves native read windows and applied diff
hunks, operation kind, call identity, root call identity, and native/nested
provenance. Read and touch counts are based on successful observed addresses once
per turn, independent of whether content was admitted to the tape. JSON reload
therefore reproduces the same counters and decisions.

These addresses are explicitly display paths or call arguments. They are not
`FsTarget` keys, cannot identify backend worlds, and do not establish that two
aliases refer to one file. The counters are historical hints only.

## Why exact file bases are disabled

Alpha.2's durable read metadata is a line window. Even a window that includes
every line loses trailing-newline identity, and individual lines may be truncated.
Write/edit metadata contains contextual diff hunks, not complete post-operation
text. Nested code dispatches persist arguments and rendered output but omit the
native tool's presentation metadata. None of these establishes an exact file base.
The reducer therefore creates no `tapeFiles`, base, or patch entries from them.
It never reads host files or assumes that the current host is the tool's backend.

Live `fs/observed` provides the correct opaque target and version; live
`tools/result.value.after` provides full write/edit output, including nested
calls. However, alpha.2's public `Session.append` cannot set the `ignorable`
envelope field, although imported events support it. Writing a custom required
event would break persistence reload under the published vocabulary. The plugin
therefore neither adds new event kinds nor mutates the global known-event set.

Restoring exact bases requires a durable host-supported observation channel that
records target identity, version, operation, complete/partial status, and actual
provider text. Until then, the public plugin rejects legacy file-anchor configuration. The
pure reducer retains its policy types for analysis, but none can enable
unverifiable exact anchors.
