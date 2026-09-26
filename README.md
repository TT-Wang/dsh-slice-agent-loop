# dsh-slice-agent-loop

[中文](README.zh.md)

A conversational-context retention policy for **DeepSeek Harness 0.1.7-rc.2 / 0.1.7-rc.1** (session format V4). It runs alongside the stock agent loop, keeping the host's lifecycle, scheduler, inbox, persistence, request-series handling and full request-reconstruction invariant. The patch is additive: it adds this plugin and nothing else.

## History model: an append-only tape

At the first step of a turn, eligible assistant/tool spans from completed turns beyond `history.keepRecentTurns` (default 0) are sealed into frozen `[slice tape v1 …]` `user/message` surface replacements at their original positions, with source kind `plugin:slice:history`. Existing entries are never re-rendered or nested. Sealing preserves the surface prefix through the last existing entry; newly eligible older nodes are left in place rather than backfilled ahead of that prefix. Protected nodes can split a turn into several entries.

Every original human user message still present on the host surface stays verbatim at its original node, in every turn. User text is not copied into the tape. The system prompt (surface node 0, replaced in place only by the host) and every other `system/message` / `developer/message` node are never sealed or cited. Instruction messages, multimodal input and the **newest** runtime-context snapshot (source kind `runtime-context`) also keep their original sources and positions. Superseded snapshots can be absorbed with their turn only after the frozen prefix. A snapshot that becomes superseded later, before an existing entry, stays raw at its original position. Snapshot text is never rendered as a human request. Raw events remain in the session log and can be recalled after sealing, folding or resume.

Frozen entries preserve their bytes, but this does **not** guarantee that each request bills only one new entry: a seal can make everything after its position miss the provider cache, including retained raw turns. See [Prefix behaviour](#prefix-behaviour).

### Entry contents

One entry renders, in order:

- a header naming the span: `[slice tape v1 · turns N-M · K turn(s) sealed · recall_turn({"turn":"<n>","view":"dialogue"}) returns a turn's dialogue; expand_result({"seq":<q>,"formatVersion":4}) returns a tool result]`;
- per sealed turn: `[turn N]`, then every visible assistant text message in that span, in source order, each with a reply wrapper and its source locator; by default the entire text is preserved, including whitespace and messages preceding a tool call;
- the turn's **read index** line (below);
- the turn's tool lines — `[tool turn N step S seq Q · <name> · <size> chars · expand_result({"seq":Q,"formatVersion":4})]`, at most 6 per turn, each pointing at the durable log record instead of repeating the text.

**There is no default entry or assistant-text cap.** Reasoning and tool-result bodies remain in the original log and are accessed through recall; navigation metadata still has display limits. User messages stay outside the entry and cannot be shortened by its renderer.

`history.entryMaxChars` is an **opt-in hard code-point cap on newly sealed entry text**. An explicit value must be a positive safe integer of at least 256. With that setting, the renderer can drop tool lines, shorten assistant text and indexes, and ultimately emit a compact span marker with a complete `recall_turn` instruction. Omit the setting to preserve assistant text in full. This cap never changes original user nodes or old frozen entries and is not a total request bound. An unpaired tool call keeps its segment raw; the plugin warns once per retained segment during that session instance.

### Read index and read fingerprints

Each sealed turn that successfully read text carries a compact index:

```
[files read this turn: src/context.ts (544 lines, ce9f9f98, step 1, seq 12 block 1, read window default, logged result)]
```

- Counted tools: `read`, `read_section`, `read_file`, including nested `tool/ptc-dispatch` calls. Failed reads never enter the successful index or comparison history; a successful retry can replace an earlier success.
- The canonical observation is the **latest successful** read per tool, path, argument window and direct/code channel in that turn. The navigation line shows at most 10 observations within 2,000 code points, with bounded labels; omitted observations are counted with a full-turn recall hint. These display limits do not truncate the underlying read records.
- The digest is the first 8 hex of `sha256` over returned text. Comparisons use the same canonical observation in earlier turns and include its turn, step, seq and result block (always `block 1` in session format V4, where each result event carries one tool-role message). Different windows or channels are not labelled as file changes.
- Direct reads identify the logged result. Nested reads identify the dispatch and explicitly say `code log; model visibility not implied`: text returned to code is not necessarily forwarded to the model.
- No file content is copied into the entry. These are historical returned windows, not proof of the whole file or its current state.

## Recall and expansion tools

`recall_turn` returns a turn: `view: "dialogue"` (default) with each user and assistant text once and tool results as locators, or `view: "full"` which also appends every original record (reasoning, tool metadata, every tool output) and on a working turn is two orders of magnitude larger, so ask for it only when the tool inputs or the raw reasoning are needed. `recall_step` retrieves a step and hydrates spilled result text when available. If storage is unavailable, it labels the result as a preview and provides the exact expansion locator. `expand_result` retrieves an exact tool result by `{seq, formatVersion: 4}` (the durable log id shown on each entry's tool lines), or by turn/step/call ordinal, optionally filtered by lines or a regex. In session format V4 every tool result is its own tool-role message, so parallel calls in one step produce separate result events with their own seqs; the optional `block` argument accepts only `1`. Each spilled text part is hydrated separately.

`recall_search` searches original human and assistant text, generated context (user-role messages the human did not write, such as runtime snapshots, labelled `[context]` in hits; `recall_turn` pages label them by source kind, e.g. `[runtime-context]`; one projected between turns belongs to the turn that just ended), tool inputs and tool errors (`DEFAULT_SEARCH_KINDS` in `src/recall.ts`). Its default `scope: "auto"` also admits ordinary tool **output**, but only through bounded slots (at most `TOOL_OUTPUT_SLOTS` = 3 hits of `TOOL_SNIPPET_CHARS` = 600 characters), because tool output is the session's flood; `scope: "dialogue"` skips it, and explicit `kinds` override the scope. The recall tools' own inputs and results are excluded without dropping ordinary results of the same step. Tool-input hits point to the full turn record containing arguments; result hits point to their exact result event. Every hit names its follow-up call.

Absence from the visible history means unknown or not selected — never false, and never "it did not happen". Recall before denying that something was said.

Numeric locators are qualified with the current session format (`SESSION_FORMAT_VERSION`, now 4): `expand_result({"seq":42,"formatVersion":4})`. Bare or mismatched-version `seq` calls, including the `formatVersion:3` hints frozen in tapes written by 0.1.5 builds, are rejected before lookup. DSH restores older sessions as V4 without rewriting old tape text, and a migration that inserts events renumbers later seqs, so an old numeric hint could otherwise point at a different result. Refresh the locator with `recall_turn` dialogue / `recall_search`, or use stable `turn`/`step`/`call` coordinates. See [DSH 0.1.7 compatibility and V3 session resume](docs/dsh-0.1.7-compatibility.md); the [0.1.5 notes](docs/dsh-0.1.5-compatibility.md) are kept as history.

## Configuration

```yaml
- id: slice-agent-loop
  name: '@dsh-external/dsh-slice-agent-loop'
  config:
    defaultReasoningEffort: inherit
    fold:
      pinSteps: 0
    history:
      keepRecentTurns: 0
```

| Setting | Meaning |
|---|---|
| `history.keepRecentTurns` | Completed turns whose eligible assistant/tool spans stay raw at the tail (default 0: seal at the first step of the next turn). All original human user messages stay raw regardless of this value. Raising it retains more original assistant/tool structure; unchanged raw turns may still hit the cache, but sealing an older turn can invalidate the prefix before that tail. There is no pressure threshold or fallback size target. |
| `history.entryMaxChars` | Optional cap on each new entry, in Unicode code points; omitted by default. Explicit values must be safe integers of at least 256. Enabling it permits assistant-text/index reduction with recall markers. It cannot shorten original user nodes and does not cap the whole tape. |
| `maxStepsPerTurn` | Optional positive step cap. Omit it to let the stock loop control termination; set it explicitly to stop before dispatching beyond that many model steps. |
| `defaultReasoningEffort` | `off`, `low`, `high`, `max`, or `inherit` (default). By default, the host/model chooses the reasoning budget; an explicit request choice always wins. **Capability-gated**: the default is injected only when the resolved model declares that effort (`declaredEfforts` in `src/effort-default.ts`); unknown capabilities keep the adapter default; a declared capability that omits the requested effort warns once per route. |
| `digest` | Content-routing options from `src/slice/result-digest.ts`. |
| `fold` | Tool-result folding options: `enabled`, `pinSteps`, `pinMaxChars`, `spillPreviewMinBytes`, `backoffAfterExpansions`. |
| `fold.pinSteps` / `pinMaxChars` | Position-based protection is opt-in (`pinSteps: 0` by default). If enabled, results smaller than `pinMaxChars` (default 8,000) in those first steps remain raw. Content-based protections apply at every step. |
| `fold.backoffAfterExpansions` | Default 2 distinct folded result blocks fully retrieved, with a full-retrieval rate of at least 50%, stops future folding for that tool/resource for the session. Resource identity is the exact `file_path`/`path`, or, without a path, the complete arguments with object keys sorted. Partial `grep`/`lines` queries and repeated retrievals of the same block do not advance backoff; other resources remain eligible. The spill path uses the same rule. |

### Upgrading an existing profile

Updating the plugin does not remove explicit values from your profile. To adopt the current defaults:

1. Remove `maxStepsPerTurn: 50` (or another existing cap) to let the stock loop control termination. Keep a positive integer only if you want an explicit step limit; `0` and `null` are invalid.
2. Remove `defaultReasoningEffort: low` or change it to `inherit` to use the host/model choice. Explicit request-level choices still take precedence.
3. Remove `fold.pinSteps: 2` or set it to `0` to apply content-based folding from the first step. Recognized source code, error results and recalled originals retain their existing protections. Resource-scoped backoff applies automatically.
4. Remove `history.pinFirstTurn` and `history.pinUserChars`; both are retired and now prevent loading with migration guidance. Every original human user node is preserved, so neither a first-turn switch nor a user-excerpt budget applies.
5. Remove `history.entryMaxChars: 8000` (or another explicit cap) to preserve all assistant text in future entries. Retain a valid value only if you deliberately want bounded entry text and recall-based recovery.
6. Remove `maxRequestChars` and `maxHistoryChars`; these retired keys now prevent the plugin from loading.

Keep any supported override you intentionally want. Existing frozen tape entries are not rewritten: previously clipped content is still available through recall, but upgrading does not automatically restore it to the surface. The new preservation rules apply to future seals and the text then present on the host surface; they do not resurrect content already hidden by host compaction or another plugin.

**The request budget is gone.** Entries replace tool-result/reasoning bodies with recallable records while keeping visible dialogue by default, and accumulate with the conversation; neither total history nor the open turn has a hard size bound here. Configure context-window handling in the host composition. Preserving longer dialogue can increase context use and input cost; the tape alone does not prevent overflow. The plugin does not reject requests based on their character count or shrink the tape by rewriting existing entries.

- **Retired user-retention keys now fail at load:** remove `history.pinFirstTurn` and `history.pinUserChars`. All original human user messages stay in place; there is no replacement user-text budget.
- **Retired budget keys now fail at load:** remove `maxRequestChars` and `maxHistoryChars`. They previously parsed without enforcing a limit; accepting them silently suggested protection that did not exist. Configure context-window handling in the host.
- **Fail at load, naming where each went:** `history.highWaterChars`, `history.lowWaterChars`, `history.keepRecentChars`, `history.checkpointMaxChars` (`Retired history configuration <key>: …` — replacements are `history.keepRecentTurns`, counted in turns, and `history.entryMaxChars`; the two water marks have no counterpart, because there is no pressure threshold left to cross), plus the retired driver keys `maxParallelToolCalls`, `inTurnSeal`, `tape`, `state` (`Retired slice configuration <key>: …`).
- `mode` accepts only `slice`; `state` and `stream` fail at load. An unrecognised key in either section fails with the valid-key list.

Entry headers are `[slice tape v1 …]`, warn messages are prefixed `slice tape:`, and the retired `[slice checkpoint v1 …]` / `# SESSION TAPE` replacements still parse: a session recorded by an older build resumes with them as ordinary sealed entries. Entries from a format-3 session come back from the host's V3→V4 restore with source kind `plugin:slice:history` and unchanged text, and remain frozen.

## Composition

Install from GitHub into a DSH profile:

```sh
dsh plugin --profile <name> add github:TT-Wang/dsh-slice-agent-loop
```

`dsh plugin` runs pnpm in the profile directory. pnpm downloads a tarball of the default branch's current commit, without Git history, and DSH selects the `cordis.patch.yml` bundle that `package.json` declares. A Git install runs no build, so the Git package includes generated `lib/` artifacts. **Keep `agent-loop`, `agent-loop-invariant`, and the stock session projections enabled.** A profile without live reload applies the change at its next start.

This package already mounts its own copy of tool-result folding: originally derived from the standalone [`dsh-tool-result-fold`](https://github.com/TT-Wang/dsh-tool-result-fold) plugin, also exported here as `./fold`. **Do not install the standalone plugin into the same profile.** Both register `expand_result`, and the second registration fails at load with `tool "expand_result" is already registered`. Mount `./fold` (or the standalone plugin) on its own only when you want folding on the stock loop without the slice policy.

## Pairs with Agent Swarm

[Agent Swarm](https://github.com/TT-Wang/dsh-agent-swarm) (`@dsh-external/dsh-agent-swarm`) is DSH's **mission layer**: one instruction becomes a mission whose owner plans the task graph and whose members run as native sessions in their own worktrees and sandboxes, with every artifact independently reviewed and verified. This plugin is the **session layer** those workers run under, and the two are usually mounted together:

- Agent Swarm fans work out; this policy replaces historical tool/reasoning bodies with recall locators within each worker session while retaining frozen entries and recall locators. Total tape size still grows with the session.
- The recall surface preserves access to original records inside a mission: `recall_turn`, `recall_search` and `expand_result` retrieve anything a seal, a fold or a resume replaced, so a worker that needs an earlier file read or tool result gets it back instead of re-reading it or guessing.
- Mount both rows in the same profile — the swarm bundle (or plugin package) plus this patch. Both are additive, neither forks Harness core, and the tool surfaces do not overlap (`swarm_*` there; `recall_turn` / `recall_search` / `recall_step` / `expand_result` here).

## Prefix behaviour

The reusable prefix ends at the earliest changed serialized message. Sealing never inserts ahead of an existing tape entry, including when an old runtime snapshot becomes superseded later. That protects already-sealed bytes from this policy's own backfills. New entries, raw messages after a seal, host-owned surface changes and tool-result folding can still incur fresh input. Provider caching ultimately determines billed tokens; source-level stability is not a measured cost or accuracy guarantee.

File reads are recorded windows; write/edit metadata contains diff hunks. They are historical observations, not proof of a complete current file or backend identity, and exact base/pointer optimizations stay disabled until the host offers a durable observation channel with complete provider text, target identity, and version. See [recorded memory](docs/recorded-memory.md).

Implementation fixes and their verification scope: [2026-09-13 review fixes](docs/review-fixes-2026-09-13.md).

## Verification and compatibility

The current change passed **342 tests across 38 files**, coverage gates, type checks and packed installation/recall/resume on DSH **0.1.7-rc.1 and 0.1.7-rc.2**. The peer range is `0.1.7-rc.1 || 0.1.7-rc.2`; 0.1.5 hosts, including npm `latest` 0.1.5-rc.3 on 2026-09-25, are not supported by this build. Format-3 sessions from 0.1.5 builds resume through the host's V3→V4 restore; two provider-written 0.1.5 session fixtures cover that path, including parallel, failed, PTC-nested and folded results. CI covers Node 22.19.0, 22.22.3 and 24.x. No new paid model evaluation was added; cost savings and task accuracy must not be inferred from content-preservation tests. Host changes, migration behaviour and the recorded evidence are in [DSH 0.1.7 compatibility](docs/dsh-0.1.7-compatibility.md).

See [preserve dialogue by default](docs/adr/0003-preserve-dialogue-defaults.md) for the current history decision and migration, and [2026-09-21 context policy defaults](docs/context-policy-defaults-2026-09-21.md) for the earlier loop/folding changes and their recorded validation results.
