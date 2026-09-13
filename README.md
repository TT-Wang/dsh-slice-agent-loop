# dsh-slice-agent-loop

[中文](README.zh.md)

A bounded conversational-context policy for **DeepSeek Harness 0.1.3-alpha.2**. It runs alongside the stock agent loop, retaining its lifecycle, scheduler, inbox, persistence, request-series handling, and full request-reconstruction invariant.

History is an append-only tape. At the first step of a turn, every completed turn beyond `history.keepRecentTurns` (default 0, so: the turn that just ended) is sealed into **one** frozen `[slice tape v1 …]` `user/message` surface replacement **at that turn's own position**. An entry already on the surface is never re-rendered and never nested into a newer one, so a seal always lands after everything already written: each request keeps the previous request's prefix and re-bills one entry instead of the whole view. That is the point of the policy — a rewrite at the front re-bills every byte behind it. Instruction messages, current user input, multimodal user messages, turn 1's user message and the **newest** runtime-context snapshot (the one the host is appending this step, else the newest on the surface) keep their original sources and positions. Runtime snapshots the host has already superseded are absorbed by the turn they belong to when it seals — as at most a one-line note, never as a user request — and their pages stay reachable through `recall_turn`. Raw events remain in the session log; `recall_turn` and `recall_search` retrieve them after sealing, folding or resume.

## Install and compose

Install this repository with DSH's plugin installer and apply its `cordis.patch.yml` bundle. The patch only adds the plugin. **Keep `agent-loop`, `agent-loop-invariant`, and the stock session projections enabled.** The Git package includes generated `lib/` artifacts.

This package already mounts its own copy of tool-result folding: the same source as the standalone [`dsh-tool-result-fold`](https://github.com/TT-Wang/dsh-tool-result-fold) plugin, also exported here as `./fold`. **Do not install the standalone plugin into the same profile.** Both register `expand_result`, and the second registration fails at load with `tool "expand_result" is already registered`. Mount `./fold` (or the standalone plugin) on its own only when you want folding on the stock loop without the slice policy.

```yaml
- id: slice-agent-loop
  name: '@dsh-external/dsh-slice-agent-loop'
  config:
    maxRequestChars: 400000
    maxStepsPerTurn: 50
    defaultReasoningEffort: low
    history:
      keepRecentTurns: 0
      pinFirstTurn: true
      entryMaxChars: 8000
```

| Setting | Meaning |
|---|---|
| `history.keepRecentTurns` | Completed turns left raw at the tail (default 0: a turn is sealed at the first step of the next turn). Raising it trades prefix-stable bytes for verbatim recency — the kept turns are re-read in full on every request until they seal, and they seal in one span when they do. There is no threshold to cross and no size target to fall back to: sealing is unconditional, and a seal costs the entry it writes — only the degradation tiers below can cost more. |
| `history.pinFirstTurn` / `pinUserChars` / `entryMaxChars` | Keep turn 1's user message as an untouched append node (default true; its assistant/tool run is still sealable). Sealed user messages at or below `pinUserChars` (default 1,200) stay verbatim in the entry, longer ones keep head 600 / tail 300 with a `recall_turn` marker between them. `entryMaxChars` (default 8,000) is the target for one entry's text: the renderer drops tool lines first, then shrinks excerpts, and a span of many short turns may still exceed it. |
| `maxHistoryChars` | Optional extra cap on rendered history (entries plus retained raw turn text). No default. Sealing alone never rewrites an entry, so the only way to honour this cap is to rewrite them all — exceeding it forces the last-resort tier below, a full prefix break on the next request, warned through the plugin logger. Leave it unset (remove an old `120000`) unless a hard history bound matters more than the cache. |
| `maxRequestChars` | Hard bound on serialized model **messages** (default 400,000), including protected context and current input. It is a character bound, not a token estimate; system prompt/tool schemas and model capacity remain host-owned. |
| `maxStepsPerTurn` | Stop before dispatching beyond this many model steps; default 50. |
| `defaultReasoningEffort` | `off`, `low`, `high`, `max`, or `inherit`; an explicit host/model choice wins. **Capability-gated**: the default is injected only when the resolved model declares that effort. A model that declares neither it nor any effort keeps the adapter default and is warned about once per route; if the capability lookup itself fails, the request silently keeps the adapter default (`declaredEfforts` in `src/effort-default.ts` returns `undefined` on any error, and only a known capability list is warned about). |
| `digest` | Content-routing options from `src/slice/result-digest.ts`. |
| `fold` | Tool-result folding options, including `enabled`, `pinSteps`, `pinMaxChars`, `spillPreviewMinBytes`, and `backoffAfterExpansions`. |

Sealing is decided at the first step of a turn, because a mid-turn rewrite would change a prefix the turn has already paid for; a later step seals only as a last resort when its request would otherwise exceed `maxRequestChars` (mid-turn there is usually nothing new to seal, and a single turn that overflows on its own still refuses). The whole seal is planned before any replacement is appended, so a refused request leaves no half-sealed surface. Protected nodes are never sealed, and a turn whose tool calls are not all paired stays raw and cuts the sealed span (logged on the plugin's `warn` channel). Before refusing, the plugin degrades deterministically, each tier tried only when the previous one cannot fit `maxRequestChars`: seal every completed turn beyond the keep window; then seal the kept recent turns as well; then rewrite every entry without turn bodies and shadow the superseded runtime snapshots no entry covers (`recall_turn` still serves each turn). Only that last tier rewrites an entry, and therefore the prefix; it says so on `warn`. Request construction fails visibly with `SliceBudgetError` only when the protected floor plus the current input cannot fit on their own; nothing is truncated and the durable record is unchanged, but later turns fail the same way until `maxRequestChars` is raised, the protected context shrinks, or a new session starts. The plugin never quietly returns an oversized view. Current input is logged before budget refusal.

`recall_search` searches original human and assistant text, generated context (plugin-produced user-role messages such as runtime snapshots, including ones projected between turns, which belong to the turn that just ended), tool inputs and tool errors (`DEFAULT_SEARCH_KINDS` in `src/recall.ts`). Its default `scope: "auto"` also admits ordinary tool **output**, but only through bounded slots (at most `TOOL_OUTPUT_SLOTS` = 3 hits of `TOOL_SNIPPET_CHARS` = 600 characters), because tool output is the session's flood; `scope: "dialogue"` skips it, and explicit `kinds` override the scope. The recall tools' own inputs and outputs are never indexed. Every hit names its follow-up call. `recall_turn` returns a turn: `view: "full"` (default) with original records and tool metadata, or `view: "dialogue"` with each user and assistant text once and tool results as locators. `recall_step` retrieves a step. `expand_result` retrieves an exact tool result by `{seq}` (the durable log id shown in a condensed view and on each entry's tool lines) or by turn/step/call ordinal, optionally filtered by lines or a regex. Tool results with a spill locator use the locator shown in their preview.

## Migration from 0.0.1

- Remove the old override that disabled the stock loop and invariant. Apply the new additive bundle.
- Move scheduler configuration such as `maxParallelToolCalls` to the stock `agent-loop` row.
- `mode: state`, `mode: stream`, `state`, `tape`, and `inTurnSeal` are retired and fail at load. The unsafe host-file snapshots and write rollback implementation have been removed.
- The private `sliceContext.contribute` registry is retired. Use the host's system-prompt/runtime-context contributions so source identity and persistence are owned by DSH.
- Mount either the stock invariant or this package's compatibility `./invariant` export, never both. Both install the same complete reconstruction check.
- The history policy is now an append-only tape: every completed turn is sealed at its own position, instead of the oldest turns being archived when the view crosses a water mark. `history.highWaterChars`, `history.lowWaterChars`, `history.keepRecentChars` and `history.checkpointMaxChars` are retired and fail at load with a note saying where each went (`Retired history configuration <key>: …`); an unrecognised key in the section fails with `Unknown history configuration <key>; valid keys: …`. Replace a `keepRecentChars` window with `history.keepRecentTurns`, counted in turns, and rename `checkpointMaxChars` to `history.entryMaxChars`; there is no counterpart for the two water marks, because there is no pressure threshold left to cross. `maxHistoryChars` is still accepted, but it now forces the last-resort tier that rewrites every entry — remove an old `maxHistoryChars: 120000` unless that is what you want.
- Entry headers changed from `[slice checkpoint v1 …]` to `[slice tape v1 …]`, and the plugin's `warn` messages from `slice archive:` to `slice tape:`. Both headers still parse, so a session recorded by the pressure-archive build resumes and keeps its old checkpoints on the surface as ordinary sealed entries. Sessions written by the older per-turn policy keep their `# SESSION TAPE` replacements; the tape treats them as ordinary sealable history.
- Existing logs containing required custom `slice/*` events still require their original reader or an explicit migration. This release does not mutate DSH's known-event vocabulary or rewrite old session files.

File reads are recorded windows; write/edit metadata contains diff hunks. They are historical observations, not proof of a complete current file or backend identity. Exact base/pointer optimizations remain disabled until the host offers a durable observation channel with complete provider text, target identity, and version. See [recorded memory](docs/recorded-memory.md).

## Development and verification

Use Node `^22.19.0 || >=24.0.0` and pnpm 11.7.0:

```sh
pnpm install --frozen-lockfile
npm run typecheck
npm test
npm run build
```

Public alpha.2 dependencies are pinned in `pnpm-lock.yaml`; no maintainer checkout or absolute dependency path is required. CI runs the full suite against those published packages, including stock-loop invariants and real JSONL close/resume. The build removes stale generated files before emitting Git-install artifacts.

Run `npm run verify:packed` for a keyless standard-installer/Loader/JSONL smoke, or `npm run verify:master -- /path/to/deepseek-harness` against one prepared upstream source checkout. [Recorded upgrade verification](docs/upgrade-verification.md) separates published-release, source-master and packed-artifact evidence.

`verify:packed` prerequisites: pnpm 11.7.0 as pinned by `packageManager` (enable corepack; any other version fails the run unless `SLICE_PACKED_ALLOW_PNPM_MISMATCH=1` is set), npm registry access (it installs the published `@deepseek-ai/dsh` 0.1.3-alpha.2 into a fresh temporary workspace), and the build toolchain for the JSONL persistence native addon `fs-ext`, whose install script the smoke runs. Each step has a 180 s budget (`SLICE_PACKED_STEP_TIMEOUT_MS` overrides it), so a cold install needs a reasonably fast registry connection. It prints its evidence directory when it finishes.

The native regression suite covers runtime retention/update/removal, opaque instruction source ownership, multimodal input, retries and steering, request-series transitions, admission failures, unload, and resume without the plugin. A separate test checks that changing a later message causes the stock invariant to reject dispatch.

Each request's cache prefix is the previous request up to the newly appended entry: a seal lands at the tail, so it costs the entry it writes and nothing before it. The prefix breaks only at host-owned surface rewrites such as tool-result folding, at a turn cut by an unpaired tool call, and at the last-resort tier that rewrites every entry. That is a structural property, not a universal cache-hit or cost guarantee: provider caching and runtime-context churn still decide the bill, and this repository has no measurement of the tape policy's cost yet. [Earlier custom-loop measurements](docs/legacy-loop.md) are historical and were taken on a different architecture; nothing here has been re-measured under the tape policy. New model-quality/cost experiments are needed before any of those numbers is quoted for this build.
