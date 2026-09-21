# Context policy defaults — 2026-09-21

Slice now leaves termination and reasoning budgets to the stock loop unless explicitly configured. Its automatic interventions concern context retention and folding.

## Behavior changes

1. `maxStepsPerTurn` has no default cap. An explicit positive safe integer still rejects the next step beyond that limit; invalid explicit values fail at load. The exported `DEFAULT_MAX_STEPS_PER_TURN = 50` constant was removed.
2. `defaultReasoningEffort` defaults to `inherit`. Explicit request/model/profile choices remain authoritative. An explicit plugin default such as `low` still uses the existing model-capability check and unsupported-effort fallback.
3. `fold.pinSteps` defaults to `0`. Position protection remains available explicitly, with the existing `pinMaxChars` setting. Size/content rules still protect small results, recognized source code, error results and retrieval output. Already-sent result bytes and frozen tape entries remain unchanged.
4. Expansion backoff is scoped to a tool and resource: the exact `file_path`/`path`, or complete arguments with recursively sorted object keys if no path exists. This is a policy grouping, not a filesystem identity or freshness guarantee; paths are not resolved or normalized. Only distinct folded result blocks retrieved in full advance backoff. Partial queries and repeated retrieval through either locator form do not. The existing configurable threshold of 2 and minimum 50% full-recovery ratio remain; they were not retuned. Pre-step folding and spill previews use the same scope.
5. `maxRequestChars` and `maxHistoryChars` now fail at load with migration guidance. They previously passed validation without enforcing a bound. Remove them and configure context-window handling in the host.

The telemetry field `FOLD_STATS.expanded` continues to count successful expansion calls against folded results, including partial and repeated calls. It is not the backoff counter. `backedOff` now contains JSON-encoded scope keys rather than bare tool names; internal decision counts use distinct blocks. No new durable session event type is introduced: resume reconstructs decisions from recognized fold replacements and successful retrieval records.

## Verification scope

Deterministic tests exercise the real stock loop, native invariants, durable JSONL resume, nested code-tool dispatch, and spill storage. A default-configured turn runs 51 tool steps and then completes on its 52nd model response; the explicit-cap regression still stops at exactly its configured limit. An adapter offering both `high` and `low` retains its `high` default, including through the packed plugin's persistence reload.

The folding regressions check distinct full recoveries, repeated and partial expansion, selected sibling blocks, locator aliases, resource separation, replay and spill behavior. Existing source/error/recall protections remain covered.

No paid model evaluation was added. These checks establish policy and integration behavior, not measured reductions in billed cost or unchanged task accuracy. In particular, inheriting a host's higher reasoning budget can increase output cost, and removing the implicit step cap permits longer turns. Existing user runtime profiles were not switched.

## Validation results

On Node 22.22.3 / pnpm 11.7.0, against the declared published DSH 0.1.5-rc.2 dependencies:

- Full suite: 37 files, 307 tests passed. Coverage: statements 86.69%, branches 79.62%, functions 87.57%, lines 91.10%; all configured gates passed.
- Source/test/script/gate TypeScript checks passed.
- Peer ranges, documentation anchors/links, and tracked repository size checks passed.
- The same packed artifact passed DSH 0.1.5-rc.1 and 0.1.5-rc.2 installation, native dispatch, recall, JSONL reload, inherited effort and frozen-entry checks. Local packed-check artifact SHA-256: `ecbba82480692432d48984b6f2d944e4bd75e09f33ae83842dd40463a506a172`.
- Latest local DSH source probe: 307/307 passed, zero skipped, on 0.1.6-alpha.2 commit `ddefc45fbc7f8e46dd73185e68295696d1297887`. The initial probe failed 9 PTC cases because the host renamed `codeRuntime` to `ptcRuntime`; a shared test-only runtime fixture now serves both interfaces without loading the installed legacy runtime implementation. This is source-level integration evidence, not an expanded package peer range or a packed 0.1.6 installation claim.
