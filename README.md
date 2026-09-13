# dsh-slice-agent-loop

[中文](README.zh.md)

A conversational-context retention policy for **DeepSeek Harness 0.1.5-rc.2 / 0.1.5-rc.1**. It runs alongside the stock agent loop, keeping the host's lifecycle, scheduler, inbox, persistence, request-series handling and full request-reconstruction invariant. The patch is additive: it adds this plugin and nothing else.

## History model: an append-only tape

At the first step of a turn, completed turns beyond `history.keepRecentTurns` (default 0) are sealed into frozen `[slice tape v1 …]` `user/message` surface replacements at their original positions. Existing entries are never re-rendered or nested. Sealing preserves the surface prefix through the last existing entry; newly eligible older nodes are left in place rather than backfilled ahead of that prefix. Protected nodes can split a turn into several entries.

Instruction messages, current user input, multimodal user messages, turn 1's user message and the **newest** runtime-context snapshot keep their original sources and positions. Superseded snapshots can be absorbed with their turn only after the frozen prefix. A snapshot that becomes superseded later, before an existing entry, stays raw at its original position. Snapshot text is never rendered as a human request. Raw events remain in the session log and can be recalled after sealing, folding or resume.

Frozen entries preserve their bytes, but this does **not** guarantee that each request bills only one new entry: a seal can make everything after its position miss the provider cache, including retained raw turns. See [Prefix behaviour](#prefix-behaviour).

### Entry contents

One entry renders, in order:

- a header naming the span: `[slice tape v1 · turns N-M · K turn(s) sealed · recall_turn({"turn":"<n>","view":"dialogue"}) returns a turn's dialogue; expand_result({"seq":<q>,"formatVersion":3}) returns a tool result]`;
- per sealed turn: `[turn N]`, the user message (verbatim up to `history.pinUserChars`, default 1,200; longer ones keep head 600 / tail 300 with a `recall_turn` marker between), then the reply wrapped in `[reply slice-turn-N @sha256:…] … [end reply @sha256:…]`;
- the turn's **read index** line (below);
- the turn's tool lines — `[tool turn N step S seq Q · <name> · <size> chars · expand_result({"seq":Q,"formatVersion":3})]`, at most 6 per turn, each pointing at the durable log record instead of repeating the text.

`history.entryMaxChars` (default 8,000) is the **target** for one entry's text: the renderer drops tool lines first, then shrinks excerpts level by level; required locators and protected content may still exceed it. A turn whose tool calls are not all paired stays raw and cuts the sealed span rather than losing the pairing, logged on the plugin's `warn` channel.

### Read index and read fingerprints

Each sealed turn that successfully read text carries a compact index:

```
[files read this turn: src/context.ts (544 lines, ce9f9f98, step 1, seq 12 block 1, read window default, logged result)]
```

- Counted tools: `read`, `read_section`, `read_file`, including nested `tool/ptc-dispatch` calls. Failed reads never enter the successful index or comparison history; a successful retry can replace an earlier success.
- The canonical observation is the **latest successful** read per tool, path, argument window and direct/code channel in that turn. At most 10 appear, followed by `+N more` when needed.
- The digest is the first 8 hex of `sha256` over returned text. Comparisons use the same canonical observation in earlier turns and include its turn, step, seq and result block. Different windows or channels are not labelled as file changes.
- Direct reads identify the logged result. Nested reads identify the dispatch and explicitly say `code log; model visibility not implied`: text returned to code is not necessarily forwarded to the model.
- No file content is copied into the entry. These are historical returned windows, not proof of the whole file or its current state.

## Recall and expansion tools

`recall_turn` returns a turn: `view: "full"` (default) with original records and tool metadata, or `view: "dialogue"` with each user and assistant text once and tool results as locators. `recall_step` retrieves a step and hydrates spilled result text when available. If storage is unavailable, it labels the result as a preview and provides the exact expansion locator. `expand_result` retrieves an exact tool result by `{seq, formatVersion: 3}` (the durable log id shown on each entry's tool lines), or by turn/step/call ordinal, optionally filtered by lines or a regex. Multi-result events accept a 1-based `block` selector; omitted means all siblings, with each spill hydrated separately.

`recall_search` searches original human and assistant text, generated context (plugin-produced user-role messages such as runtime snapshots, including ones projected between turns, which belong to the turn that just ended), tool inputs and tool errors (`DEFAULT_SEARCH_KINDS` in `src/recall.ts`). Its default `scope: "auto"` also admits ordinary tool **output**, but only through bounded slots (at most `TOOL_OUTPUT_SLOTS` = 3 hits of `TOOL_SNIPPET_CHARS` = 600 characters), because tool output is the session's flood; `scope: "dialogue"` skips it, and explicit `kinds` override the scope. The recall tools' own inputs and output blocks are excluded without dropping ordinary siblings in the same event. Tool-input hits point to the full turn record containing arguments; result hits point to their exact event/block. Every hit names its follow-up call.

Absence from the visible history means unknown or not selected — never false, and never "it did not happen". Recall before denying that something was said.

Numeric locators are qualified with the current session format: `expand_result({"seq":42,"formatVersion":3})`. Bare or mismatched-version `seq` calls are rejected before lookup. DSH's v2→v3 migration inserts events but leaves old tape text untouched, so an old numeric hint can otherwise point at a different result. Refresh the locator with `recall_turn` dialogue / `recall_search`, or use stable `turn`/`step`/`call` coordinates. See [host compatibility and migration](docs/dsh-0.1.5-compatibility.md).

## Configuration

```yaml
- id: slice-agent-loop
  name: '@dsh-external/dsh-slice-agent-loop'
  config:
    maxStepsPerTurn: 50
    defaultReasoningEffort: low
    history:
      keepRecentTurns: 0
      pinFirstTurn: true
      pinUserChars: 1200
      entryMaxChars: 8000
```

| Setting | Meaning |
|---|---|
| `history.keepRecentTurns` | Completed turns left raw at the tail (default 0: a turn is sealed at the first step of the next turn). Raising it retains more verbatim history. Unchanged raw turns may still hit the cache; sealing an older turn can invalidate the prefix before that retained tail. Sealing is unconditional: there is no threshold to cross and no size target to fall back to. |
| `history.pinFirstTurn` / `pinUserChars` / `entryMaxChars` | Keep turn 1's user message as an untouched append node (default true; its assistant/tool run is still sealable). `pinUserChars` (default 1,200) is the verbatim budget for a sealed user message. `entryMaxChars` (default 8,000) is one entry's text target. |
| `maxStepsPerTurn` | Stop before dispatching beyond this many model steps; default 50. |
| `defaultReasoningEffort` | `off`, `low`, `high`, `max`, or `inherit`; an explicit host/model choice wins. **Capability-gated**: the default is injected only when the resolved model declares that effort (`declaredEfforts` in `src/effort-default.ts`); unknown capabilities keep the adapter default; a declared capability that omits the requested effort warns once per route. |
| `digest` | Content-routing options from `src/slice/result-digest.ts`. |
| `fold` | Tool-result folding options: `enabled`, `pinSteps`, `pinMaxChars`, `spillPreviewMinBytes`, `backoffAfterExpansions`. |

**The request budget is gone.** Entries reduce historical detail but accumulate with the conversation; neither total history nor the open turn has a hard size bound here. Configure context-window handling in the host composition. The tape alone does not prevent overflow. There is no plugin-side ceiling, no refusal, and no degradation tier that rewrites an entry.

- **Accepted but inert:** `maxRequestChars` and `maxHistoryChars` still parse as valid keys, but nothing reads them — the ceiling and the history cap they used to enforce no longer exist. Remove them from a migrated config; keeping them changes nothing and warns about nothing.
- **Fail at load, naming where each went:** `history.highWaterChars`, `history.lowWaterChars`, `history.keepRecentChars`, `history.checkpointMaxChars` (`Retired history configuration <key>: …` — replacements are `history.keepRecentTurns`, counted in turns, and `history.entryMaxChars`; the two water marks have no counterpart, because there is no pressure threshold left to cross), plus the retired driver keys `maxParallelToolCalls`, `inTurnSeal`, `tape`, `state` (`Retired slice configuration <key>: …`).
- `mode` accepts only `slice`; `state` and `stream` fail at load. An unrecognised key in either section fails with the valid-key list.

Entry headers are `[slice tape v1 …]`, warn messages are prefixed `slice tape:`, and the retired `[slice checkpoint v1 …]` / `# SESSION TAPE` replacements still parse: a session recorded by an older build resumes with them as ordinary sealed entries.

## Composition

Install this repository with DSH's plugin installer and apply its `cordis.patch.yml` bundle. **Keep `agent-loop`, `agent-loop-invariant`, and the stock session projections enabled.** The Git package includes generated `lib/` artifacts.

This package already mounts its own copy of tool-result folding: originally derived from the standalone [`dsh-tool-result-fold`](https://github.com/TT-Wang/dsh-tool-result-fold) plugin, also exported here as `./fold`. **Do not install the standalone plugin into the same profile.** Both register `expand_result`, and the second registration fails at load with `tool "expand_result" is already registered`. Mount `./fold` (or the standalone plugin) on its own only when you want folding on the stock loop without the slice policy.

## Pairs with Agent Swarm

[Agent Swarm](https://github.com/TT-Wang/dsh-agent-swarm) (`@dsh-external/dsh-agent-swarm`) is DSH's **mission layer**: one instruction becomes a mission whose owner plans the task graph and whose members run as native sessions in their own worktrees and sandboxes, with every artifact independently reviewed and verified. This plugin is the **session layer** those workers run under, and the two are usually mounted together:

- Agent Swarm fans work out; this policy reduces historical detail within each worker session while retaining frozen entries and recall locators. Total tape size still grows with the session.
- The recall surface preserves access to original records inside a mission: `recall_turn`, `recall_search` and `expand_result` retrieve anything a seal, a fold or a resume replaced, so a worker that needs an earlier file read or tool result gets it back instead of re-reading it or guessing.
- Mount both rows in the same profile — the swarm bundle (or plugin package) plus this patch. Both are additive, neither forks Harness core, and the tool surfaces do not overlap (`swarm_*` there; `recall_turn` / `recall_search` / `recall_step` / `expand_result` here).

## Prefix behaviour

The reusable prefix ends at the earliest changed serialized message. Sealing never inserts ahead of an existing tape entry, including when an old runtime snapshot becomes superseded later. That protects already-sealed bytes from this policy's own backfills. New entries, raw messages after a seal, host-owned surface changes and tool-result folding can still incur fresh input. Provider caching ultimately determines billed tokens; source-level stability is not a measured cost or accuracy guarantee.

File reads are recorded windows; write/edit metadata contains diff hunks. They are historical observations, not proof of a complete current file or backend identity, and exact base/pointer optimizations stay disabled until the host offers a durable observation channel with complete provider text, target identity, and version. See [recorded memory](docs/recorded-memory.md).

Implementation fixes and their verification scope: [2026-09-13 review fixes](docs/review-fixes-2026-09-13.md).
