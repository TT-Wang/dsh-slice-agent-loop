# dsh-slice-agent-loop

[中文](README.zh.md)

A bounded conversational-context policy for **DeepSeek Harness 0.1.3-alpha.2**. It runs alongside the stock agent loop, retaining its lifecycle, scheduler, inbox, persistence, request-series handling, and full request-reconstruction invariant.

Completed conversational spans become durable `user/message` surface replacements. Instruction messages, current user input, multimodal user messages, and the **live** runtime snapshot keep their original sources and positions. A runtime snapshot the host has already superseded is the one exception: it is dropped from the request view and replaced by a marker naming its `recall_turn` page, because leaving one dead snapshot per turn on the surface drives every span budget to zero. Raw events remain in the session log; `recall_turn` and `recall_search` retrieve them after folding, omission or resume.

## Install and compose

Install this repository with DSH's plugin installer and apply its `cordis.patch.yml` bundle. The patch only adds the plugin. **Keep `agent-loop`, `agent-loop-invariant`, and the stock session projections enabled.** The Git package includes generated `lib/` artifacts.

```yaml
- id: slice-agent-loop
  name: '@dsh-external/dsh-slice-agent-loop'
  config:
    maxHistoryChars: 120000
    maxRequestChars: 400000
    maxStepsPerTurn: 50
    defaultReasoningEffort: low
```

| Setting | Meaning |
|---|---|
| `maxHistoryChars` | Hard bound on the combined rendered conversational history, including headers and recall markers. |
| `maxRequestChars` | Hard bound on serialized model **messages**, including protected context and current input. It is a character bound, not a token estimate; system prompt/tool schemas and model capacity remain host-owned. |
| `maxStepsPerTurn` | Stop before dispatching beyond this many model steps; default 50. |
| `defaultReasoningEffort` | `off`, `low`, `high`, `max`, or `inherit`; an explicit host/model choice wins. **Capability-gated**: the default is injected only when the resolved model declares that effort. A model that declares neither it nor any effort keeps the adapter default and is warned about once per route; if the capability lookup itself fails, the request silently keeps the adapter default (`declaredEfforts` in `src/effort-default.ts` returns `undefined` on any error, and only a known capability list is warned about). |
| `digest` | Content-routing options from `src/slice/result-digest.ts`. |
| `fold` | Tool-result folding options, including `enabled`, `pinSteps`, `pinMaxChars`, `spillPreviewMinBytes`, and `backoffAfterExpansions`. |

Before refusing, the plugin degrades deterministically. A history span that cannot fit its share of `maxHistoryChars` is replaced by one bounded omit-all marker carrying the `recall_turn` locators for every turn it covers — per span, so a span that still fits is not destroyed by an older one that does not; this is logged on the plugin's `warn` channel. If the assembled request then exceeds `maxRequestChars`, history budget is given back and the spans are re-planned from the same originals, up to six passes, rather than refusing identically on every later turn of the session. Only when even the bounded markers do not fit, or when the protected floor alone exceeds the message budget, does request construction fail visibly. The plugin never quietly returns an oversized view. Current input is logged before budget refusal. Historical spans are planned before any replacement is appended.

`recall_search` searches original human and assistant text, tool inputs and tool errors; ordinary tool **output** is excluded by default as flood — pass `kinds: ["tool_output"]` to search it deliberately (`DEFAULT_SEARCH_KINDS` in `src/recall.ts`). `recall_turn` returns a turn, including original records and tool metadata; `recall_step` retrieves a step; `expand_result` retrieves an exact result ordinal, optionally filtered by lines or a regex. Tool results with a spill locator use the locator shown in their preview.

## Migration from 0.0.1

- Remove the old override that disabled the stock loop and invariant. Apply the new additive bundle.
- Move scheduler configuration such as `maxParallelToolCalls` to the stock `agent-loop` row.
- `mode: state`, `mode: stream`, `state`, `tape`, and `inTurnSeal` are retired and fail at load. The unsafe host-file snapshots and write rollback implementation have been removed.
- The private `sliceContext.contribute` registry is retired. Use the host's system-prompt/runtime-context contributions so source identity and persistence are owned by DSH.
- Mount either the stock invariant or this package's compatibility `./invariant` export, never both. Both install the same complete reconstruction check.
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

The native regression suite covers runtime retention/update/removal, opaque instruction source ownership, multimodal input, retries and steering, request-series transitions, admission failures, unload, and resume without the plugin. A separate test checks that changing a later message causes the stock invariant to reject dispatch.

The cache prefix and per-turn paid text depend on which spans change; there is no universal cache-hit or cost guarantee. [Earlier custom-loop measurements](docs/legacy-loop.md) are historical. This migration changes the policy and needs new model-quality/cost experiments before those numbers can be reused.
