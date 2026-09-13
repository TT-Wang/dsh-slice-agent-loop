# dsh-slice-agent-loop

[中文](README.zh.md)

A bounded conversational-context policy for **DeepSeek Harness 0.1.3-alpha.2**. It runs alongside the stock agent loop, keeping the host's lifecycle, scheduler, inbox, persistence, request-series handling and full request-reconstruction invariant. The patch is additive: it adds this plugin and nothing else.

## History model: an append-only tape

At the first step of a turn, every completed turn beyond `history.keepRecentTurns` (default 0, so: the turn that just ended) is sealed into **one** frozen `[slice tape v1 …]` `user/message` surface replacement **at that turn's own position**. An entry already on the surface is never re-rendered and never nested into a newer one, so a seal always lands after everything already written: **each request keeps the previous request's prefix and re-bills the entry it just wrote, not the view behind it.** That is the whole point of the policy — a rewrite at the front re-bills every byte behind it.

Instruction messages, current user input, multimodal user messages, turn 1's user message and the **newest** runtime-context snapshot (the one the host is appending this step, else the newest on the surface) keep their original sources and positions. Runtime snapshots the host has already superseded are absorbed by the turn they belong to when it seals — at most a one-line `[slice note · …]`, never as a user request — and their pages stay reachable through `recall_turn`. Raw events remain in the session log; `recall_turn` and `recall_search` retrieve them after sealing, folding or resume.

### Entry contents

One entry renders, in order:

- a header naming the span: `[slice tape v1 · turns N-M · K turn(s) sealed · recall_turn({"turn":"<n>","view":"dialogue"}) returns a turn's dialogue; expand_result({"seq":<q>}) returns a tool result]`;
- per sealed turn: `[turn N]`, the user message (verbatim up to `history.pinUserChars`, default 1,200; longer ones keep head 600 / tail 300 with a `recall_turn` marker between), then the reply wrapped in `[reply slice-turn-N @sha256:…] … [end reply @sha256:…]`;
- the turn's **read index** line (below);
- the turn's tool lines — `[tool turn N step S seq Q · <name> · <size> chars · expand_result({"seq":Q})]`, at most 6 per turn, each pointing at the durable log record instead of repeating the text.

`history.entryMaxChars` (default 8,000) is the **target** for one entry's text: the renderer drops tool lines first, then shrinks excerpts level by level; a span of many short turns may still exceed it. A turn whose tool calls are not all paired stays raw and cuts the sealed span rather than losing the pairing, logged on the plugin's `warn` channel.

### Read index and read fingerprints

Each sealed turn that opened files carries one line so a later turn can tell whether reading again is worth it:

```
[files read this turn: src/context.ts (544 lines, ce9f9f98, step 1), tests/read-digest.spec.ts (104 lines, 705e051d, step 4, = turn 2)]
```

- Counted tools: `read`, `read_section`, `read_file`. One entry per target (the first step wins), at most 10 per turn with a `+N more` tail; a turn that read nothing emits no line.
- The digest is the first 8 hex of `sha256` over the text the read **returned** — what the model saw, not the file on disk.
- The change mark compares that digest with the latest earlier read of the same target in this session: `= turn N` (identical bytes) or `≠ turn N` (changed). It is derived from the append-only log, so it survives sealing.
- It stays a pointer: no file content is copied into the entry. The line is a hint, not proof — the digest covers the returned window, not the whole file.

## Recall and expansion tools

`recall_turn` returns a turn: `view: "full"` (default) with original records and tool metadata, or `view: "dialogue"` with each user and assistant text once and tool results as locators. `recall_step` retrieves a step. `expand_result` retrieves an exact tool result by `{seq}` (the durable log id shown on each entry's tool lines), or by turn/step/call ordinal, optionally filtered by lines or a regex; a result with a spill locator uses the locator shown in its preview.

`recall_search` searches original human and assistant text, generated context (plugin-produced user-role messages such as runtime snapshots, including ones projected between turns, which belong to the turn that just ended), tool inputs and tool errors (`DEFAULT_SEARCH_KINDS` in `src/recall.ts`). Its default `scope: "auto"` also admits ordinary tool **output**, but only through bounded slots (at most `TOOL_OUTPUT_SLOTS` = 3 hits of `TOOL_SNIPPET_CHARS` = 600 characters), because tool output is the session's flood; `scope: "dialogue"` skips it, and explicit `kinds` override the scope. The recall tools' own inputs and outputs are never indexed. Every hit names its follow-up call.

Absence from the visible history means unknown or not selected — never false, and never "it did not happen". Recall before denying that something was said.

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
| `history.keepRecentTurns` | Completed turns left raw at the tail (default 0: a turn is sealed at the first step of the next turn). Raising it trades prefix-stable bytes for verbatim recency — the kept turns are re-read in full on every request until they seal, and they seal in one span when they do. Sealing is unconditional: there is no threshold to cross and no size target to fall back to. |
| `history.pinFirstTurn` / `pinUserChars` / `entryMaxChars` | Keep turn 1's user message as an untouched append node (default true; its assistant/tool run is still sealable). `pinUserChars` (default 1,200) is the verbatim budget for a sealed user message. `entryMaxChars` (default 8,000) is one entry's text target. |
| `maxStepsPerTurn` | Stop before dispatching beyond this many model steps; default 50. |
| `defaultReasoningEffort` | `off`, `low`, `high`, `max`, or `inherit`; an explicit host/model choice wins. **Capability-gated**: the default is injected only when the resolved model declares that effort (`declaredEfforts` in `src/effort-default.ts`); an unknown capability keeps the adapter default and warns once per route. |
| `digest` | Content-routing options from `src/slice/result-digest.ts`. |
| `fold` | Tool-result folding options: `enabled`, `pinSteps`, `pinMaxChars`, `spillPreviewMinBytes`, `backoffAfterExpansions`. |

**The request budget is gone.** The tape bounds the view by construction — one entry per completed turn, tool results folded inside the open turn — so the only hard limit is the model's context window, which is the host's to enforce. There is no plugin-side ceiling, no refusal, and no degradation tier that rewrites an entry.

- **Accepted but inert:** `maxRequestChars` and `maxHistoryChars` still parse as valid keys, but nothing reads them — the ceiling and the history cap they used to enforce no longer exist. Remove them from a migrated config; keeping them changes nothing and warns about nothing.
- **Fail at load, naming where each went:** `history.highWaterChars`, `history.lowWaterChars`, `history.keepRecentChars`, `history.checkpointMaxChars` (`Retired history configuration <key>: …` — replacements are `history.keepRecentTurns`, counted in turns, and `history.entryMaxChars`; the two water marks have no counterpart, because there is no pressure threshold left to cross), plus the retired driver keys `maxParallelToolCalls`, `inTurnSeal`, `tape`, `state` (`Retired slice configuration <key>: …`).
- `mode` accepts only `slice`; `state` and `stream` fail at load. An unrecognised key in either section fails with the valid-key list.

Entry headers are `[slice tape v1 …]`, warn messages are prefixed `slice tape:`, and the retired `[slice checkpoint v1 …]` / `# SESSION TAPE` replacements still parse: a session recorded by an older build resumes with them as ordinary sealed entries.

## Composition

Install this repository with DSH's plugin installer and apply its `cordis.patch.yml` bundle. **Keep `agent-loop`, `agent-loop-invariant`, and the stock session projections enabled.** The Git package includes generated `lib/` artifacts.

This package already mounts its own copy of tool-result folding: the same source as the standalone [`dsh-tool-result-fold`](https://github.com/TT-Wang/dsh-tool-result-fold) plugin, also exported here as `./fold`. **Do not install the standalone plugin into the same profile.** Both register `expand_result`, and the second registration fails at load with `tool "expand_result" is already registered`. Mount `./fold` (or the standalone plugin) on its own only when you want folding on the stock loop without the slice policy.

## Pairs with Agent Swarm

[Agent Swarm](https://github.com/TT-Wang/dsh-agent-swarm) (`@dsh-external/dsh-agent-swarm`) is DSH's **mission layer**: one instruction becomes a mission whose owner plans the task graph and whose members run as native sessions in their own worktrees and sandboxes, with every artifact independently reviewed and verified. This plugin is the **session layer** those workers run under, and the two are usually mounted together:

- Agent Swarm fans work out; this policy keeps each fan-out session bounded. Completed turns are sealed at the tail of an append-only tape, so a session's request keeps the previous request's prefix and re-bills only the entry it just wrote.
- The recall surface is what makes that bound safe inside a mission: `recall_turn`, `recall_search` and `expand_result` retrieve anything a seal, a fold or a resume replaced, so a worker that needs an earlier file read or tool result gets it back instead of re-reading it or guessing.
- Mount both rows in the same profile — the swarm bundle (or plugin package) plus this patch. Both are additive, neither forks Harness core, and the tool surfaces do not overlap (`swarm_*` there; `recall_turn` / `recall_search` / `recall_step` / `expand_result` here).

## Prefix behaviour

Each request's cache prefix is the previous request up to the seal just written: a seal lands at the tail, so it costs the entry it writes and nothing before it. The prefix breaks only at host-owned surface rewrites such as tool-result folding, and at a turn cut by an unpaired tool call. That is a structural property, not a universal cache-hit or cost guarantee: provider caching and runtime-context churn still decide the bill.

File reads are recorded windows; write/edit metadata contains diff hunks. They are historical observations, not proof of a complete current file or backend identity, and exact base/pointer optimizations stay disabled until the host offers a durable observation channel with complete provider text, target identity, and version. See [recorded memory](docs/recorded-memory.md).
