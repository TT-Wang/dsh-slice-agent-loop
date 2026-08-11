# dsh-slice-agent-loop

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

The harness packages are **peer dependencies**: the host provides them, this
plugin never bundles its own copies.

```bash
npm install dsh-slice-agent-loop
```

Then swap it for the stock loop in your profile's `cordis.patch.yml`. Disabling
a row and inserting your own is the supported replacement shape — a patch's
`name` field is an assertion, not an override, so it cannot rename a row:

```yaml
- id: agent-loop
  disabled: true

- insert:
    - id: slice-loop
      name: 'dsh-slice-agent-loop'
```

`ctx.agents` holds exactly one agent factory, so the stock loop **must** be
disabled — loading both fails loudly rather than picking one by load order.

### Compaction

This loop's bounded rebuild replaces conversation compaction. If you keep the
compaction stack mounted you get both mechanisms fighting for the same job, and
`dsh-token-meter` prices the *surface* (the full log) rather than the slice
actually sent, so pressure readings will not match reality. To disable it,
remember to disable the consumer too — `dsh-command-compact` injects `compact`
and would otherwise hang forever waiting for a service that never arrives:

```yaml
- id: compact-basic
  disabled: true
- id: command-compact
  disabled: true
```

## Configuration

| key | default | meaning |
|---|--:|---|
| `maxParallelToolCalls` | `10` | Maximum in-flight parallel-safe tool bodies per step. Concurrency-unsafe tools still form barriers. |

```yaml
- insert:
    - id: slice-loop
      name: 'dsh-slice-agent-loop'
      config:
        maxParallelToolCalls: 4
```

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

`dsh-slice-agent-loop/invariant` checks that weaker property, and unlike the
stock companion it is **true** for this loop:

```yaml
- id: slice-loop-invariant
  name: 'dsh-slice-agent-loop/invariant'
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
index (path · line count · sha256 · the exact `read` call), instead of being
re-pasted in full.

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

- **Elasticity does not degrade.** The driver computes a character budget from
  the model context window and re-projects the slice against it, but the ported
  `ElasticityController` throws `ContextUnfitError` rather than dropping to
  locator fidelity — even when the overflow is small. The driver falls back to
  the unbounded projection and warns, so an unfittable slice never kills a turn;
  the bound is enforced by the tape budget, not by per-region degradation.
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

## Development

```bash
npm install
npm run link:dsh    # symlink the harness peers from your dsh checkout
npm run typecheck
npm test
```

`link:dsh` finds the harness via `$DSH_SOURCE`, then `$DSH_HOME/source/current`,
then `~/.dsh/source/current`.

**Re-run `link:dsh` after any `npm install`** — npm rewrites `node_modules` and
removes the peer symlinks, and the failure looks like the whole harness went
missing (`Cannot find module '@deepseek-ai/dsh-agent'`).

CI only runs what does not need the harness: the ported slice engine is
peer-free, and its 44 golden cases assert byte-level parity against the
upstream Python implementation. The driver, lifecycle and inbox gates need the
private harness peers, so the full suite is a pre-push gate rather than a CI
one — faking those peers would test a mock instead of the contract.

Regenerating the Python-parity goldens additionally needs a
[sliceagent](https://github.com/TT-Wang) checkout — set `$SLICEAGENT_REPO` and
run `npm run goldens`. Running the tests does not: the expectations are checked
in.

## License

BSD-3-Clause — see [LICENSE](LICENSE).
