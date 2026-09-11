# dsh-slice-agent-loop

[中文](README.zh.md)

A bounded conversational-context policy for **DeepSeek Harness 0.1.3-alpha.2**. It runs alongside the stock agent loop, retaining its lifecycle, scheduler, inbox, persistence, request-series handling, and full request-reconstruction invariant.

History stays raw. Below `history.highWaterChars` the plugin appends nothing, so every model request is a byte-identical append extension of the previous one, exactly as on the stock loop. When the request view grows past that mark, one archive event at the first step of the next turn replaces the oldest completed turns with a single frozen `[slice checkpoint v1 …]` `user/message` surface replacement and brings the view back under `history.lowWaterChars`. Instruction messages, current user input, multimodal user messages, turn 1's user message and the **newest** runtime-context snapshot (the one the host is appending this step, else the newest on the surface) keep their original sources and positions. Runtime snapshots the host has already superseded stay on the surface like the stock loop's until a pressure event; the archive then absorbs them into the checkpoint (as at most a one-line note, never as a user request), and their pages stay reachable through `recall_turn`. Raw events remain in the session log; `recall_turn` and `recall_search` retrieve them after archiving, folding or resume.

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
      highWaterChars: 300000
      lowWaterChars: 150000
      keepRecentChars: 60000
```

| Setting | Meaning |
|---|---|
| `history.highWaterChars` / `lowWaterChars` | History stays raw and append-only until the serialized view exceeds `highWaterChars` (default 300,000); then the oldest completed turns are archived into frozen `[slice checkpoint v1 …]` messages until it is under `lowWaterChars` (default 150,000). Consecutive archives are at least `highWaterChars - lowWaterChars` of new history apart. |
| `history.keepRecentChars` | The newest complete turns whose raw records reach this many chars (default 60,000, at least one turn) stay raw; they are archived only as a degradation step when the request would otherwise exceed `maxRequestChars`. |
| `history.pinFirstTurn` / `pinUserChars` / `checkpointMaxChars` | Keep turn 1's user message raw (default true); archived user messages at or below `pinUserChars` (default 1,200) stay verbatim in the checkpoint; `checkpointMaxChars` (default 8,000) is the target size of one checkpoint. |
| `maxHistoryChars` | Optional extra soft cap on rendered history (checkpoints plus retained raw turns). No default; the water marks alone drive archiving. Remove an old `120000` value unless you want archives below `highWaterChars`. |
| `maxRequestChars` | Hard bound on serialized model **messages** (default 400,000), including protected context and current input. It is a character bound, not a token estimate; system prompt/tool schemas and model capacity remain host-owned. |
| `maxStepsPerTurn` | Stop before dispatching beyond this many model steps; default 50. |
| `defaultReasoningEffort` | `off`, `low`, `high`, `max`, or `inherit`; an explicit host/model choice wins. **Capability-gated**: the default is injected only when the resolved model declares that effort. A model that declares neither it nor any effort keeps the adapter default and is warned about once per route; if the capability lookup itself fails, the request silently keeps the adapter default (`declaredEfforts` in `src/effort-default.ts` returns `undefined` on any error, and only a known capability list is warned about). |
| `digest` | Content-routing options from `src/slice/result-digest.ts`. |
| `fold` | Tool-result folding options, including `enabled`, `pinSteps`, `pinMaxChars`, `spillPreviewMinBytes`, and `backoffAfterExpansions`. |

Archiving is decided at the first step of a turn, because a mid-turn rewrite would change a prefix the turn has already paid for; a later step archives only as a last resort when its request would otherwise exceed `maxRequestChars`. The whole archive is planned before any replacement is appended, so a refused request leaves no half-archived surface. Protected nodes are never archived, and a turn whose tool calls are not all paired stays raw and cuts the archived run (logged on the plugin's `warn` channel). Before refusing, the plugin degrades deterministically, each tier tried only when the previous one cannot fit `maxRequestChars`: archive to the water marks; then archive the recent tail too; then archive every completed turn with checkpoint bodies omitted (`recall_turn` still serves each turn). Degradation is logged on `warn`. Request construction fails visibly with `SliceBudgetError` only when the protected floor plus the current input cannot fit on their own; nothing is truncated and the durable record is unchanged, but later turns fail the same way until `maxRequestChars` is raised, the protected context shrinks, or a new session starts. The plugin never quietly returns an oversized view. Current input is logged before budget refusal.

`recall_search` searches original human and assistant text, generated context (plugin-produced user-role messages such as runtime snapshots, including ones projected between turns, which belong to the turn that just ended), tool inputs and tool errors (`DEFAULT_SEARCH_KINDS` in `src/recall.ts`). Its default `scope: "auto"` also admits ordinary tool **output**, but only through bounded slots (at most `TOOL_OUTPUT_SLOTS` = 3 hits of `TOOL_SNIPPET_CHARS` = 600 characters), because tool output is the session's flood; `scope: "dialogue"` skips it, and explicit `kinds` override the scope. The recall tools' own inputs and outputs are never indexed. Every hit names its follow-up call. `recall_turn` returns a turn: `view: "full"` (default) with original records and tool metadata, or `view: "dialogue"` with each user and assistant text once and tool results as locators. `recall_step` retrieves a step. `expand_result` retrieves an exact tool result by `{seq}` (the durable log id shown in a condensed view and in checkpoints) or by turn/step/call ordinal, optionally filtered by lines or a regex. Tool results with a spill locator use the locator shown in their preview.

## Migration from 0.0.1

- Remove the old override that disabled the stock loop and invariant. Apply the new additive bundle.
- Move scheduler configuration such as `maxParallelToolCalls` to the stock `agent-loop` row.
- `mode: state`, `mode: stream`, `state`, `tape`, and `inTurnSeal` are retired and fail at load. The unsafe host-file snapshots and write rollback implementation have been removed.
- The private `sliceContext.contribute` registry is retired. Use the host's system-prompt/runtime-context contributions so source identity and persistence are owned by DSH.
- Mount either the stock invariant or this package's compatibility `./invariant` export, never both. Both install the same complete reconstruction check.
- The history policy changed from per-turn span replacement to pressure-triggered archiving. `maxHistoryChars` no longer has a default and is only an optional extra soft cap; remove an old `maxHistoryChars: 120000` unless you want archives below `history.highWaterChars`. Sessions written by the per-turn policy keep their old `# SESSION TAPE` replacements on the surface; the archive treats them as ordinary archivable history.
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

Below `highWaterChars` the cache prefix of each request is the whole previous request; it breaks only at an archive event (at the first replaced node) and at host-owned surface rewrites such as tool-result folding. That is a structural property, not a universal cache-hit or cost guarantee: provider caching, runtime-context churn and archive frequency still decide the bill. [Earlier custom-loop measurements](docs/legacy-loop.md) are historical. This migration changes the policy and needs new model-quality/cost experiments before those numbers can be reused.
