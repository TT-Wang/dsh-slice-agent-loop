# Upgrade verification: 2026-09-08

> Historical alpha.2 receipt. Current released-host instructions and evidence are
> in [DSH 0.1.7 compatibility](dsh-0.1.7-compatibility.md); the
> [DSH 0.1.5 compatibility](dsh-0.1.5-compatibility.md) notes are also history.
> To check a 0.1.7 tag's source, follow
> [Before upgrading the host](dsh-0.1.7-compatibility.md#before-upgrading-the-host).
> Source-checkout verification is manual-only, not a scheduled or required CI
> gate. The `fs-ext` native build steps below apply only to this historical host.

The upgraded context plugin was checked against both the published Harness
release and the newer upstream source checkout. The plugin delegates execution
to the stock loop and uses durable surface replacements for conversational
context. Both stock session and agent-loop invariants remain enabled.

| Target | Executed evidence | Result |
| --- | --- | --- |
| Published `@deepseek-ai/dsh@0.1.3-alpha.2` | Packed plugin installed through `dsh plugin`; supported profile boot through Loader; four turns, five requests, real `recall_turn`, and JSONL close/resume | Passed, four surface replacements, zero agent errors |
| Upstream master `c389f96bf3a9b6807cb71ed6bdad5849be0df6d8` | Entire plugin suite with every Harness/vendor workspace import resolved to that checkout's source | 153 passed, zero skipped |

The verified plugin tarball was version `0.1.0`, with SHA-256
`251162b4130d211a303873fdc28107854df93632105daeb32ab780d04d04f74a`.
The verification host used Node `v22.22.3`, pnpm `11.7.0`, and macOS arm64.

The release source is commit `82a5fd61a7cf5c293cec4bdff68f455398d685e9`.
Between that commit and the verified master, upstream moved concrete inbox
storage from `dsh-agent` to the stock agent loop, changed inbox projection and
scope ownership, and added `FileSystem.readByteRange`. The upgraded plugin does
not own those changing runtime implementations.

## Repeat the packed check

Build the plugin, then pack and verify the current checkout:

```sh
pnpm run build
node scripts/validation/run-packed-smoke.mjs
```

To verify an existing tarball instead:

```sh
node scripts/validation/run-packed-smoke.mjs "$SLICE_PLUGIN_TARBALL"
```

The script creates a fresh temporary directory, installs the exact published CLI,
creates an isolated `DSH_HOME`, and uses the launcher's standard profile settings:
`nodeLinker: hoisted` and `autoInstallPeers: false`. It invokes the supported
`dsh plugin --profile slice-packed add` command, checks the composed Loader tree,
and boots that profile. It leaves the user's installed profiles unchanged.
On this historical host, only persistence's declared `fs-ext` native build
script ran, and it needed a native C++ toolchain. Since 0.1.5 the published host
ships its `flock` addon as a package dependency, so the current script builds
nothing natively. Package installation requires network access.

The fixture uses a deterministic LLM adapter. Settings, tool dispatch, recall,
the stock loop, surface derivation, invariants, and JSONL persistence use published
implementations. Every captured request is independently reconstructed from its
durable surface and header. The fixture checks unchanged runtime retention,
successful recall, history replacement, known event vocabulary, and an exact
persisted-prefix reload before continuing the session.

The printed evidence directory contains the verified artifact digest, summary,
captured requests, final events, persistence files, and each subprocess's output.
No API credentials are needed.

## Repeat the source check

Use a separate Harness checkout at the desired upstream revision. For a 0.1.7
tag, prepare it as described in
[Before upgrading the host](dsh-0.1.7-compatibility.md#before-upgrading-the-host).
The commands below are for this historical host only. They install the required
source dependency closure and build the one native persistence dependency
(`fs-ext`) that host used:

```sh
pnpm install --filter @deepseek-ai/dsh-agent-loop... \
  --filter @deepseek-ai/dsh-session-persistence-jsonl... \
  --filter @deepseek-ai/dsh-tool-fs... --ignore-scripts --frozen-lockfile
npm --prefix node_modules/.pnpm/fs-ext@2.1.1/node_modules/fs-ext run install
```

From the plugin checkout, run:

```sh
node scripts/validation/run-master-tests.mjs "$HARNESS_SOURCE_CHECKOUT"
```

The script uses the checkout's complete `tsconfig.base.json` path map and its
standard-decorator transform. Harness imports all resolve to one source graph;
it does not mix selected master packages with published Harness artifacts. It
also points tsx at that path map (added for 0.1.7's JSONL migration verifier),
so code the Harness loads in a worker thread through tsx resolves to the same
source. The
printed evidence directory records the exact upstream commit, test report, and
command output. The verified source worktree remained clean.

These checks establish execution, context, packaging, and persistence
compatibility on the tested host. They do not establish real-model completion
quality, total-token cost, or a cross-platform compatibility matrix. No real-model
benchmark or complete upstream application build was performed.
