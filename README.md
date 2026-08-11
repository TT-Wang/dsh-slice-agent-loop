# dsh-slice-agent-loop

English | [中文](README.zh.md)

A drop-in agent loop for the [DeepSeek Harness](https://github.com/dsh2026) whose
context engine is a **bounded slice** instead of a growing transcript.

The stock loop sends `session.deriveMessages()` — the whole derived history —
on every request, so the prompt grows with the session. This loop rebuilds a
bounded context each turn from a carried state (a conversation ring, an
append-only SESSION TAPE of sealed turn digests, and hash-anchored file
locators), so the prompt is sized to the **current task** rather than to
everything that came before.

Measured over a 600-turn session, the tape plateaus at ~120k characters and
grows 1.11× between turn 300 and turn 600 — the property is gated in
`tests/unit.test.ts`, not just asserted here.

```
turn 100: 76,560 chars    turn 300: 83,473    turn 600: 92,725
```

## Status

Early. The loop implements the full dsh `Agent` contract and is covered by a
mutation-verified gate suite (every fix was checked by reverting it and watching
its gate fail), but it is a young port with known gaps — read [Limitations](#limitations) before
depending on it. Version `0.0.1` tracks DSH snapshot `20260811T152241Z`.

## Install

Official bundle plugin — installed from the git source, not from npm. The build
output is committed, so a git-source install needs no build step:

```sh
dsh plugin --profile <name> add "github:dsh-external/dsh-slice-agent-loop#main"
```

From a local checkout instead: `dsh plugin --profile <name> add .`

The package ships its own `cordis.patch.yml`, so installing it into a profile is
all the wiring there is. That patch does three things, and the first two are not
optional:

```yaml
- id: agent-loop        # ctx.agents holds exactly ONE factory
  disabled: true
- id: compact-basic     # this loop's bounded rebuild replaces compaction
  disabled: true
- id: command-compact   # injects `compact`; suspends forever without it
  disabled: true
- insert:
    - id: slice-agent-loop
      name: '@dsh-external/dsh-slice-agent-loop'
```

Loading beside the stock loop fails loudly rather than picking one by load
order, so the `agent-loop` row must stay disabled.

### Compaction on the preset plane

On DSH 0810+ the live compaction stack sits inside each preset's `compaction`
isolate group, which a host-plane patch cannot reach — the rows above cover the
host plane only. Under `standard`, `code` or `cordis` the stack still runs, and
`dsh-token-meter` prices the *surface* rather than the slice actually sent
(`dsh-external/issues#564`). To run without it, author your own preset under
`$DSH_HOME/.agent-presets/` — copy `standard/agent.cordis.yml` and drop the
`compaction` group, or start from `presets/benchmark.agent.cordis.yml`, which
already has. `minimal` also mounts no compaction, but do **not** run this loop under it:
20260811 gave its persona `complete: true`, which suppresses every other
prompt section — including this loop's own `slice:kernel`. Under `minimal` the
model would get "You are a helpful software engineer assistant" and nothing
else: no sliceagent kernel, no tool guidance.

## Configuration

| key | default | meaning |
|---|--:|---|
| `maxParallelToolCalls` | `10` | Maximum in-flight parallel-safe tool bodies per step. Concurrency-unsafe tools still form barriers. Since 20260811 this also caps subagent fan-out: `tool-subagent` declares itself concurrency-safe, so several delegations in one response run through this same slot pool. |
| `maxStepsPerTurn` | `50` | Hard ceiling on continuation steps in one turn. A bound, not a stall detector — see below. |

Set it from your profile's own `cordis.patch.yml`, which applies after the
bundle layer above. The row already exists — target it **by id**:

```yaml
- id: slice-agent-loop
  config:
    maxParallelToolCalls: 4
```

Do not wrap this in `- insert:`. An insert appends a *new* entry instead of
configuring the existing one, and two loop factories is the loud failure
described above. And do not add a `name:` key unless it is exactly
`@dsh-external/dsh-slice-agent-loop` — a mismatched name is an assertion
failure that makes the loader skip the whole row silently.

## Incompatible with `@deepseek-ai/dsh-agent-loop/invariant`

That companion asserts `model-visible ⟺ logged`: the dispatched messages must
equal `session.deriveMessages()` byte for byte. **A bounded-slice loop cannot
satisfy that by construction** — sending a rebuilt slice instead of the derived
history is the entire point.

This plugin therefore **refuses to load** beside it, with an error explaining
the fix, rather than letting every turn die inside `llm/stream`. Watch out for
this: compositions commonly carry `agent-loop-invariant` as a row *separate*
from `agent-loop`, so swapping the loop row does not remove the companion.

```yaml
# remove this row when switching to the slice loop
- id: agent-loop-invariant
  disabled: true
```

### The honest replacement

Requests are still auditable. Before every dispatch the driver appends a durable
`slice/request-slice` event carrying the digest of the slice it is about to
send, so you can prove after the fact what turn N step M actually contained —
without duplicating the whole slice into the log.

`@dsh-external/dsh-slice-agent-loop/invariant` checks that weaker property, and unlike the
stock companion it is **true** for this loop:

```yaml
- id: slice-loop-invariant
  name: '@dsh-external/dsh-slice-agent-loop/invariant'
```

## Durable events

| event | payload | purpose |
|---|---|---|
| `slice/file-anchor` | `{ turn, path, body }` | Redacted post-state of one successful edit, appended at the turn seal. Agent recreation rebuilds tape file anchors from the log alone — never from an inferred disk re-read. |
| `slice/request-slice` | `{ turn, step, seedDigest, messageCount }` | Audit record for one dispatched request (see above). |
| `slice/step-budget` | `{ turn, step, budget }` | The turn hit `maxStepsPerTurn` and was ended. `turn/end` carries `reason.kind: 'step-budget'`. |

All three are plugin-owned and log-only: they never enter the model surface, so they
add nothing to the prompt.

They are also registered into the harness's session-event vocabulary at plugin
load. 20260811 closed that vocabulary: the persistence read path refuses to
interpret a log containing an unknown type — and since the write path is
deliberately unguarded, an unregistered plugin event works live and then
poisons its own resume. Reproduced end to end against a real
`PersistenceCoordinator`; the registration (and its revert on unload) is gated
in `tests/driver-contract.spec.ts`.

## File anchoring

Cross-turn file continuity is what makes the slice cheaper than a transcript:
edited files ride as `base`/`patch` tape entries plus an OPEN FILES locator
index (path · line count · sha256), instead of being re-pasted in full.

The index names files, not calls. It used to append `read_file("<path>")`,
which was wrong twice over — DSH registers its reader as `read`, and that tool
takes `{file_path}`, not a positional string — and no gate noticed, because the
model never tried it. Hardcoding `read` would rot on a host rename and runtime
discovery cannot be done without guessing (`ToolSchema` is
`{name, description, parameters}`, with no capability tag to match on), so the
call name is simply not rendered. The model can already see its own tool
schemas; it only needs to know which file to re-read. A gate in
`tests/driver-contract.spec.ts` now fails if any rendered call shape names a
tool the host does not register.

Anchoring observes the **execution plane**, not what the model sees. It listens
on `tools/result` and keys off `exec.name` — the tool that actually ran.

That distinction is what makes it work in every preset. Under **Code mode** the
tool surface collapses to a single `run_code`, and real edits become sub-calls
inside the TypeScript program. Both planes settle through the same
`scheduler.finish`, so one seam covers both and the loop needs no Code-mode
awareness at all.

The defaults cover DSH's own filesystem tools:

| tool | path key | notes |
|---|---|---|
| `write`, `edit` | `file_path` | `dsh-tool-fs` |
| `str_replace_editor` | `path` | only `create` / `str_replace` / `insert` — `view` is read-only and never anchors. As of 20260811 `standard` no longer mounts this tool; it survives in `minimal`. Keeping the name costs nothing and covers deployments that do mount it. |

If your deployment registers file tools under different names, anchoring
silently finds nothing and the moat's main body stops working. Both failure
modes — wrong names, and top-level-only observation — are gated in
`tests/driver-contract.spec.ts`; a custom tool surface needs its names added to
`EDIT_TOOL_NAMES` in `src/driver.ts`.

## Step budget

`maxStepsPerTurn` ends a turn that will not converge. It is a **bound, not a
diagnosis**: no attempt is made to judge whether the model is making progress.

A stall detector was designed and rejected. Its predicate — a continuation step
with no assistant text and no new file anchor — was replayed against a real
19-turn session: it would have cut 45 of 143 steps (31%), including 24 steps off
a turn that made 74 distinct tool calls of real work, and it raised warnings on
ordinary 5-step turns. For a reasoning model "no visible text plus tool calls"
is the normal shape of investigation, so a productive 49-step turn and a futile
20-step turn are indistinguishable on that axis — and on repetition too, both 0%.

Hitting the ceiling appends `slice/step-budget` and ends the turn with
`reason.kind: 'step-budget'`. It does **not** run the `agent/turn-stopping`
seam, whose contract is "object by steering, and continue in the same turn" —
the opposite of a hard stop. Steering that arrives at the ceiling stays in the
inbox for the next turn, the same disposition as the error path.

## Measuring this loop

This loop **prepends** to the system prompt rather than replacing it:
`driver.ts` renders `${RESOLVED_SYSTEM_PROMPT}\n\n${renderPrompt(assembly)}`,
so the ported sliceagent prefix arrives first and DSH's own registry sections
follow. Measured on a real session:

```
total system prompt        17,292 chars
  ported sliceagent prefix 12,671   (this loop)
  appended by DSH           4,621   (registry sections)
```

Most of that 4,621 is tool instruction — "Use the read tool, not shell commands
like cat" — and it **must stay**: it teaches the host's real tool names, which
is exactly what the slice deliberately stopped hardcoding into its locators.

What skews a measurement is the identity stack. That session carried **four**:

| # | text | source | switch |
|--:|---|---|---|
| 1 | `You are sliceagent, an interactive engineering agent…` | this loop | — |
| 2 | `You are an AI agent powered by the DeepSeek Harness SDK.` | prompt registry | `includeHarnessIdentity: false` on the host `system-prompt` row |
| — | *#2 and #4 in one stroke:* | host plane | `- id: system-prompt` + `config: { includeHarnessIdentity: false, persona: '' }`. Both keys — an id-targeted patch replaces the row's **whole** config, so writing one key alone silently drops the other. |
| 3 | `You are interacting with the user through the … Web GUI…` | web bundle | do not benchmark through `dsh web` |
| 4 | `You are a coding agent powered by the {{model}} model…` | preset `persona` | use the preset below |

`presets/benchmark.agent.cordis.yml` is `standard` minus the `compaction`
group, with the `persona` row replaced by an **empty** persona. Empty, not
absent: the deployment persona section is registered unconditionally from host
config, and a preset persona is only a per-scope shadow — dropping the row
would leave the deployment default in the prompt. An empty shadow wins the slot
and render drops empty sections. Every tool is kept, including plan mode — a
benchmark that quietly narrows the tool surface measures a different agent.

```sh
mkdir -p "$DSH_HOME/.agent-presets/slice-benchmark"
cp presets/benchmark.agent.cordis.yml \
   "$DSH_HOME/.agent-presets/slice-benchmark/agent.cordis.yml"
```

Preset rows are unreachable from a host-plane patch, which is why this ships as
a preset rather than as more lines in `cordis.patch.yml`.


## Memory recall

The tape truncates every sealed reply at 1,200 code points and marks the cut:
`…[+N chars in sealed turn]`. `recall_turn` is the way back — a real registered
tool, not a locator into a filesystem that does not exist here:

```
recall_turn({"turn": "slice-turn-3"})
```

It serves the **verbatim** full text — the complete user request and every
assistant step — from the durable session log: the same `user/message` /
`assistant/message` events the dsh contract already obliges the loop to append,
and the same source agent recreation rebuilds from. Zero new persistence, zero
added log bytes, recreation-safe by construction.

The tape advertises it only where something was actually cut — a digest whose
ask exceeded 600 chars or whose reply exceeded 1,200 gets one line:

```
recall: recall_turn({"turn": "slice-turn-3"}) for the verbatim record
```

An uncut turn advertises nothing; the tool's catalog description covers
discovery. This replaces the ported Python locator
(`read_file("@sliceagent/history/...")`) that pointed into the engine's virtual
context filesystem — a route nothing in DSH can serve, whose one observed
effect was a 20-step, 35-search hunt for a file that never existed.


## Limitations

- **Elasticity degrades exactly one region.** The driver computes a character
  budget from the model context window and re-projects the slice against it, and
  the ported `ElasticityController` does run its degradation loop — but of the
  three populated regions only `open_files` has anything to degrade *to*.
  `task_objective` is mandatory, so no locator alternative is emitted for it, and
  `session_tape` — by far the largest block — has no branch in `locatorRegion()`
  at all. A small overflow is absorbed by paging the OPEN FILES index down to its
  locator form (a few hundred characters); past that the controller has no
  candidate left and raises `ContextUnfitError`. The driver catches it, falls
  back to the unbounded projection and warns, so an unfittable slice never kills
  a turn; the bound is still enforced by the tape budget, not by per-region
  degradation.
- **Engine-side renderers still speak the Python dialect.** A few golden-pinned
  strings under `src/slice/` (the OPEN FILES region header, the tape GC marker)
  mention `read_file` / `@sliceagent` — spellings from the Python engine that
  nothing in DSH serves. They render only in regions this port leaves empty or
  under context pressure, and the live retrieval path is `recall_turn` (see
  [Memory recall](#memory-recall)); changing the pinned strings means
  regenerating the golden suite against the Python reference.
- **The stock invariant is incompatible** (see above).
- **`dsh-token-meter` and the compaction stack price the surface**, not the
  slice actually dispatched, so their pressure numbers do not describe this
  loop's real requests. The divergence grows with turn count and does not
  converge; reported upstream as `dsh-external/issues#564`.
- **Only three context regions are populated** — `session_tape`,
  `task_objective`, `open_files`. The ported engine has more (intent, findings,
  progress signals, world), and they render empty.
- **The task objective is pinned to the session's first message.** Topic
  switching is not ported, so a long session that changes tasks keeps the
  original objective in the highest-authority block.
- **Code mode anchors writes, but not reads.** Anchoring fires on sub-call
  writes, so cross-turn file continuity works. Reads performed inside a
  `run_code` program are a different matter: the loop only learns about files it
  saw written, so a program that reads five files and edits one carries only the
  edited one forward. Whether Code mode's "fold many steps into one program"
  and the slice's "carry file state across turns" are complementary or at odds
  has not been measured.

## Quick start

```bash
git clone https://github.com/dsh-external/dsh-slice-agent-loop.git
cd dsh-slice-agent-loop
npm install --legacy-peer-deps && npm run link:dsh
```

Clone over https unless you have an ssh key on the org. `--legacy-peer-deps` is
the one non-standard step: the nine `@deepseek-ai/*` peers are unpublished
(`publishConfig.access: restricted` since 20260811), so an unauthenticated
`npm install` stops at `E404 ... is not in this registry` — which reads
like this package is broken when it only means npm cannot fetch what the
harness supplies. `link:dsh` then symlinks them from your dsh checkout.

## Development

```bash
npm run typecheck && npm test
```

Two things the scripts cannot tell you themselves:

- **Re-run `link:dsh` after any `npm install`.** npm rewrites `node_modules` and
  drops the peer symlinks; the failure then reads as if the whole harness
  vanished (`Cannot find module '@deepseek-ai/dsh-agent'`).
- **`lib/` is committed** — rebuild before pushing, or a git-source install
  serves stale output.

The full suite is a pre-push gate rather than a CI one: the harness peers are
private, and faking them would test a mock instead of the contract. What CI can
cover, and why that is the part worth covering, is in
[`ci.yml`](.github/workflows/ci.yml).

## License

BSD-3-Clause — see [LICENSE](LICENSE).
