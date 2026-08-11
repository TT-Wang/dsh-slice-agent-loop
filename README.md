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
depending on it. Version `0.0.1` tracks DSH snapshot `20260810T155924Z`.

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
(`dsh-external/issues#564`). To run without it, either pick `minimal` (the one
preset that mounts no compaction) or author your own preset under
`$DSH_HOME/.agent-presets/` — copy `standard/agent.cordis.yml` and drop the
`compaction` group.

## Configuration

| key | default | meaning |
|---|--:|---|
| `maxParallelToolCalls` | `10` | Maximum in-flight parallel-safe tool bodies per step. Concurrency-unsafe tools still form barriers. |

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
this: `dsh scaffold` writes `agent-loop-invariant` as a row *separate* from
`agent-loop`, so swapping the loop does not remove it.

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

Both are plugin-owned and log-only: they never enter the model surface, so they
add nothing to the prompt.

## File anchoring

Cross-turn file continuity is what makes the slice cheaper than a transcript:
edited files ride as `base`/`patch` tape entries plus an OPEN FILES locator
index (path · line count · sha256 · a `read_file("<path>")` re-read pointer),
instead of being re-pasted in full.

That pointer still carries the sliceagent-native name from the Python port —
DSH registers its reader as `read` — so read the last field as *which file to
re-read*, not as a call to paste verbatim. Same for the `recall:` line on each
sealed turn digest, whose `@sliceagent/...` path names a virtual filesystem
that has no counterpart here; see [Limitations](#limitations).

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
| `str_replace_editor` | `path` | only `create` / `str_replace` / `insert` — `view` is read-only and never anchors |

If your deployment registers file tools under different names, anchoring
silently finds nothing and the moat's main body stops working. Both failure
modes — wrong names, and top-level-only observation — are gated in
`tests/driver-contract.spec.ts`; a custom tool surface needs its names added to
`EDIT_TOOL_NAMES` in `src/driver.ts`.

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
- **The retrieval affordances name a tool this harness does not have.** Every
  paging pointer the slice renders — the OPEN FILES index, the per-turn
  `recall:` locator, the memory and history index lines — is written as
  `read_file(...)`, which `dsh-tool-fs` does not register (its reader is
  `read`). Worse, the `@sliceagent/...` paths those pointers use are routes into
  the Python engine's virtual context filesystem, and the durability layer that
  serves them was deliberately not ported. Real-file pointers are recoverable —
  the path is correct, only the call name is wrong — but nothing can serve an
  `@sliceagent/` path here. Measured on a 104-turn session: 13 distinct
  `@sliceagent` paths advertised, and 0 of 135 tool calls ever reached for one.
  The channel being unused has been hiding the fact that it is unusable.
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
the one non-standard step: the nine `@deepseek-ai/*` peers are private, so a
plain `npm install` stops at `E404 ... is not in this registry` — which reads
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
