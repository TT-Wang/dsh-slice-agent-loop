# DSH 0.2.0 compatibility

The plugin targets **0.2.0-rc.2** and also supports **0.1.7-rc.2**. On 2026-10-13, npm's `latest` and `next` tags for `@deepseek-ai/dsh` both resolved to 0.2.0-rc.2 (published 2026-09-29). The `alpha` tag resolved to 0.2.1-alpha.2, which this build does not support. Development dependencies pin 0.2.0-rc.2 exactly, and the peer range is the exact list `0.1.7-rc.2 || 0.2.0-rc.2`. 0.1.7-rc.2 stays in the range so that a deployment can roll its host back without repacking the plugin. 0.1.7-rc.1 is no longer admitted; the last build that admits it is main at `8e3b7a3` (plugin version 0.1.0).

This build is plugin version **0.2.0**. The host bump needed no plugin source change: `src/` is untouched and the rebuilt `lib/` is byte-identical to the 0.1.0 build. The version moved because `dsh plugin add` does not reinstall a tarball whose name and version are already installed (see [Deploying this build](#deploying-this-build)). Session format is still V4. The V4 contracts, V3 session resume and the rules for old numeric locators are in the [0.1.7 notes](dsh-0.1.7-compatibility.md) and apply unchanged.

## What changed for a plugin between 0.1.7-rc.2 and 0.2.0-rc.2

This section was read from the upstream tags `dsh-v0.1.7-rc.2` (`477b4f4`) and `dsh-v0.2.0-rc.2` (`639ed01`), 448 commits apart, on 2026-10-13.

Nothing changed in the contracts slice uses. `SESSION_FORMAT_VERSION` is 4 at both tags, and no session event type was added or removed. The hooks and services the plugin relies on (`agent/pre-step`, `agent/request`, `tools/result`, `tools/post-execute`, tool registration, system-prompt sections, the spill store, model-info lookup) kept their names, payloads and timing. Surface replacement, message source kinds, the system prompt as node 0, tool-set notices, the runtime-context snapshot, JSONL persistence and its migrations, the spill policy and its notice text, and the PTC dispatch events are the same. The whole suite passes unchanged against both sources (see [Verification recorded on 2026-10-13](#verification-recorded-on-2026-10-13)).

The rest of this section lists what is different.

### Peer admission

The admission rule did not change, but the host version it compares against did. At profile load the host checks every `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peer range of a bundle against its own version, using `semver.satisfies` with `includePrerelease`. A bundle with any unsatisfied range is skipped. The host does not stop: it starts, serves its UI, exits 0 from `--dump-config`, and runs the stock loop without the plugin. The only signal is one stderr line per skipped bundle. This is the line a 0.2.0-rc.2 host prints for the 0.1.0 build (shortened):

```text
dsh: skipping profile bundle "@dsh-external/dsh-slice-agent-loop": Error: Plugin @dsh-external/dsh-slice-agent-loop@0.1.0 is incompatible with dsh 0.2.0-rc.2: peerDependencies {"@deepseek-ai/dsh-agent-loop":"0.1.7-rc.1 || 0.1.7-rc.2", ...}. Running it may cause crashes or data loss. ...
```

The rule works in both directions: a 0.1.7-rc.2 host skips a build whose ranges list only 0.2.0 versions.

The range is an exact list, not a caret range, for two reasons. Under the host's rule `^0.2.0-rc.2` also admits 0.2.1-alpha.2, which has plugin-facing changes (see [The next host line: 0.2.1](#the-next-host-line-021)). And `scripts/check-peer-ranges.mjs` uses plain semver without `includePrerelease`, so a comparator range that the host accepts can still fail `check:peers`. The cost of an exact list is that 0.2.0-rc.1, any later release candidate and 0.2.0 final are skipped until the list is extended.

### Request prefix

The host's `bash` tool description gained two sentences (check the resolved path before a delete or move; guard variables with `${VAR:?}`), 249 characters in total. It is the only model-visible change in the standard preset: no tool was added, removed or reordered, and the system prompt is unchanged. The first request of every resumed session after the host switch therefore carries a new tools header and misses the provider cache once in full. Later requests cache as before. Tool names are unchanged, so the loop logs a `request/header` with reason `resume` and appends no tool-registry `developer/message`, and no sealed entry is split.

Measured with the offline A/B harness (dsh-base, dsh-headless and this build, scripted model) on both published hosts: the request prefix of the same build is 18311 characters on 0.1.7-rc.2 and 18560 on 0.2.0-rc.2, and the system prompt (4249 characters) and the slice tool schemas hash the same on both. Cost and cache figures recorded on 0.1.7-rc.2, including the [P1-10 A/B](p110-native-ab.md), are not comparable with runs on 0.2.0-rc.2; [scripts/ab/README.md](../scripts/ab/README.md) says what the harness needs on another host.

### Failed steps answer their tool calls

When a step fails after its assistant message is committed, the 0.2.0-rc.2 loop appends an error `tool/result` for every tool call of that step that has no result yet, before it writes `step/end`. The error code is `TOOL_OUTCOME_UNKNOWN` when the `tool/call` event was recorded and `TOOL_NOT_STARTED` when it was not. On 0.1.7-rc.2 those calls stayed unanswered in the log; that host wrote the same kind of result only when it resumed an interrupted session. For slice this means:

- A failed turn has paired calls and results, so it seals like any other turn. On 0.1.7-rc.2 an unanswered call keeps its turn raw and logs a warning. That check (`unpairedCalls` in `src/context.ts`) stays, because 0.1.7-rc.2 is still supported and existing logs keep their unanswered calls.
- A `tool/result` can now exist without a preceding `tool/call` event. Sealing pairs a result with the tool-call block of the assistant message, not with a `tool/call` event, and the fold skips error results.

No code changed for this. No test in this repository drives a step failure on the real loop, so the two points above come from reading both sides.

### Optional: timed questions and the `user-question-reply` source kind

`@deepseek-ai/dsh-tool-ask-user` gained a row option `mode: 'legacy' | 'timed'`. The default is `legacy`, whose behaviour is unchanged, and no shipped preset sets `timed`. In timed mode a question can return a pending result, and the human's late answer arrives as a user-role message with the new source kind `user-question-reply`. It is the one new message source kind between the tags, and it stays inside format 4.

If a profile turns timed mode on, slice treats the reply like any user-role message it did not write: it stays verbatim at its node. Recall does not count it as a human request, because only source kind `user` is one: `recall_turn` serves it under generated context as `[user-question-reply]`, and `recall_search` finds it as `context`, which the default search kinds include. This was read from the code, not tested.

### Host composition

None of these needs a plugin change.

- **Telemetry.** dsh-base gains an `otel` row (`@deepseek-ai/dsh-otel`) that session telemetry uses. The default collector moved from `harness-telemetry.deepseeksvc.com` to `https://dsh-otel-collector.deepseeksvc.com/v1/logs`, requests are bounded by size, and the default mode is still `FEEDBACK_ONLY`. An egress allow-list needs the new host name. Tape entries and fold replacements are ordinary session events to this reader, as they already are to the session-log upload that rides on official DeepSeek requests (on by default at both tags; 0.2.0-rc.2 reads its `enabled` setting per request).
- **Schedule.** The `time-context`, `schedule` and `ui-schedule` rows, present but disabled in the 0.1.7-rc.2 web composition, moved to the optional bundle `@deepseek-ai/dsh-experimental-schedule-bundle`, which is off unless installed. If it is ever installed beside slice, its time readings and reminders are user-role messages slice did not write, so they stay raw at their nodes for the life of the session.
- **Native dependency.** The published 0.2.0-rc.2 packages pin `koffi` to exactly 3.1.1. Regenerating this repository's lockfile moved it from 3.2.1 to 3.1.1 and changed nothing else outside the 46 `@deepseek-ai/dsh-*` packages.

## Before upgrading the host

Before bumping the pinned packages to a new host tag, run the whole plugin suite against that tag's source. This finds host contract changes while the upgrade is still a decision: the 0.1.5-rc.1 source failed 97 tests on 2026-09-13 (positional replacements moved to `startSeq`/`endSeq`), the 0.1.6-alpha.2 source failed 9 PTC tests on 2026-09-21 (`codeRuntime` became `ptcRuntime`), and the 0.2.0-rc.2 source passed all 342 on 2026-10-13, which is why this bump carries no source change. The step is manual; no CI job runs it. The weekly Peer compatibility workflow (`.github/workflows/compat.yml`) installs npm's `next` tag for the `@deepseek-ai/dsh*` packages and fails once `next` falls outside the declared peer range, which is the usual signal that a new tag needs this check. It fired for this release: the scheduled runs of 2026-10-05 and 2026-10-12 failed at `check:peers`.

The steps are for macOS and Linux. They need git, pnpm 11.7.0, a supported Node installation that ships its headers in `<node prefix>/include/node` (the native build stops and names that path when they are missing), and a C compiler for the host's native addon: `cc`, or `musl-gcc` on musl Linux. Clone the target tag and prepare it:

```sh
TAG=dsh-v0.2.0-rc.2
HARNESS_SOURCE_CHECKOUT="$HOME/src/deepseek-harness-$TAG"
git clone --depth 1 --branch "$TAG" https://github.com/deepseek-ai/deepseek-harness.git "$HARNESS_SOURCE_CHECKOUT"
cd "$HARNESS_SOURCE_CHECKOUT"
pnpm install --filter @deepseek-ai/dsh-agent-loop... \
  --filter @deepseek-ai/dsh-session-persistence-jsonl... \
  --filter @deepseek-ai/dsh-tool-fs... --ignore-scripts --frozen-lockfile
pnpm run build:native-system
```

Then run the suite from the plugin checkout, after its own `pnpm install --frozen-lockfile`:

```sh
npm run verify:master -- "$HARNESS_SOURCE_CHECKOUT"
```

- `--ignore-scripts` skips upstream's install hooks. No `fs-ext` build is needed: the 0.1.7 and 0.2.0 lockfiles have no `fs-ext`, and file locking comes from the host's own `flock` addon.
- `build:native-system` compiles that addon into `native/system/packages/<platform>-<arch>/bin/`: `system.node` on macOS, and `glibc/system.node` or `musl/system.node` on Linux. Upstream's own `pnpm test` runs the same step first. JSONL persistence loads the addon for its file lock on macOS and Linux. Without it, 7 tests failed on the 0.1.7-rc.2 source (2026-09-27): 4 in `tests/host-format-upgrade.spec.ts` name the missing `system.node`, while 3 in `tests/native-context.spec.ts` and `tests/tape-protected.spec.ts` report only `SessionPersistenceNotFoundError` on resume. On any other OS the step exits 0 without building anything, and this procedure has not been tried there. Only macOS arm64 has been run; the Linux paths and compilers come from upstream's `native/system/scripts/build.ts`.
- No upstream `lib/` build is needed. `scripts/validation/run-master-tests.mjs` resolves every Harness import through the checkout's `tsconfig.base.json` path map and points tsx at the same file (`TSX_TSCONFIG_PATH`). Since 0.1.7 the JSONL provider verifies a migrated generation in a worker thread that it loads through tsx, outside Vite's aliases. Before the script set that variable, a fresh 0.1.7-rc.2 checkout failed the 4 restore tests in `tests/host-format-upgrade.spec.ts`, which asked for unbuilt `lib/` files. Building upstream `lib/` also works (a full install plus `pnpm run build:lib:host` took 167 s on 2026-09-27), but then the worker runs built code rather than the checked-out source.
- The script prints the host commit, test counts and an evidence directory, and exits non-zero on any failure. Explain every failure before bumping the pins: fix the plugin, or record the host difference in the compatibility notes, as the 0.1.7 notes did for the [rc.1 tool-set notice](dsh-0.1.7-compatibility.md#v4-host-behaviour-worth-knowing).

A passing source run is necessary, not sufficient. It does not typecheck against the published type declarations and does not install anything, so the bump itself must also touch, in one change: the `@deepseek-ai/dsh-*` peer ranges and devDependencies in `package.json`, `pnpm-lock.yaml`, the host allowlist in `scripts/validation/run-packed-smoke.mjs`, the second host in `.github/workflows/ci.yml`, and `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` when the new release is under a day old. Bump the plugin version too, for the reason given under [Deploying this build](#deploying-this-build).

## Verification recorded on 2026-10-13

Machine: Node 22.22.3, pnpm 11.7.0, macOS arm64. Plugin: version 0.2.0, the change that adds this file.

| Check | Host | Result |
| --- | --- | --- |
| Source suite, `npm run verify:master` | `dsh-v0.2.0-rc.2`, commit `639ed01`: a worktree of a local upstream clone, filtered install and `build:native-system` as above | **342/342 across 38 files**, zero skipped |
| Source suite, `npm run verify:master` | `dsh-v0.1.7-rc.2`, commit `477b4f4`: fresh shallow clone from GitHub, prepared with the steps above | **342/342 across 38 files**, zero skipped |
| `pnpm install --frozen-lockfile`, `pnpm peers check`, `check:peers`, typechecks (source, tests, scripts, gates) | published 0.2.0-rc.2 packages | all passed |
| `npm run test:coverage` | published 0.2.0-rc.2 packages | **342/342 across 38 files**; coverage 86.63 % statements, 79.89 % branches, 87.12 % functions, 90.95 % lines (floors 85/78/86/90) |
| `npm run check:build` | published 0.2.0-rc.2 packages | rebuilt `lib/` matches the committed artifacts |
| Packed install, `npm run verify:packed` | published 0.2.0-rc.2 CLI | passed |
| Packed install, `SLICE_PACKED_DSH_VERSION=0.1.7-rc.2 npm run verify:packed` | published 0.1.7-rc.2 CLI | passed |

Both packed runs installed the same tarball (`dsh-external-dsh-slice-agent-loop-0.2.0.tgz`, SHA-256 `a70692b517b8af35c7316d5262057309700c311e582326657d26bc53f7edcf80` for that run) with `dsh plugin add`. Each made five model requests over four turns, reported session format 4, and kept the system prompt as a single `system/message` at node 0. Each also carried one live snapshot with source `runtime-context`, wrote three frozen tape entries with source `plugin:slice:history`, reloaded JSONL persistence, and reported zero agent errors. The digest identifies that run's build only; a rebuild that changes `lib/`, `package.json` or a README changes it, and CI repeats the packed check on every change.

No release-age exemption applied. 0.2.0-rc.2 was two weeks old, `minimumReleaseAgeExclude` is empty, and both packed runs reported zero exemptions carried, zero added for the host's wider closure and zero appended by pnpm.

The full local suite was repeated several times against the published packages. One coverage run had a single 5-second timeout in `tests/unit.test.ts` ("plateaus instead of growing linearly with turn count"); every other run passed 342/342, and so did every source run. That test exercises in-repo code only and takes under a second alone; the machine's load average was about 20 at the time.

Wall time for the 0.1.7-rc.2 clone with a warm pnpm store: clone 14 s, filtered install 14 s (849 packages, all reused from the store, none downloaded), native build 4 s, `verify:master` 7 to 9 s. `verify:master` against the 0.2.0-rc.2 checkout took 10 s. Each source run was repeated with the same result. Neither upstream checkout had tracked or untracked changes afterwards.

Not covered by this record: CI on Linux and on Node 22.19.0 and 24.x has not run this change yet, no model was called, and no deployed profile was started. These checks do not measure cost or model success rate.

## Deploying this build

- **Install under a new name and version.** `dsh plugin add` of a tarball whose name and version are already installed in the profile does nothing useful: it exits 0, pnpm prints `Already up to date`, the lockfile takes the new integrity hash, and `node_modules` keeps the old build. This was reproduced on 2026-10-13 with the profile's `nodeLinker: hoisted` layout, on both host versions, by overwriting a tarball in place. This build is 0.2.0, so `npm pack` names it `dsh-external-dsh-slice-agent-loop-0.2.0.tgz`. Do not overwrite the 0.1.0 tarball; keep it for a rollback.
- **Swap plugins and host in one stopped window.** Stop the host, install the new plugin build into the profile, switch the host, then start. Do not run `plugin add` or `plugin remove` against a live host: it watches the profile's `package.json` and applies a changed bundle list to the running process (read from the host's code, not reproduced). If the profile carries other plugins with exact peer ranges, install all of them in the same window, so the host never starts with one admitted and another skipped. Run `plugin add` with the binary of the host that will run the profile and with `DSH_HOME` set to the deployment's home; without it the command works on the default home.
- **Check the install, not the exit code.** The profile's `node_modules/@dsh-external/dsh-slice-agent-loop/package.json` must show version 0.2.0 and the new peer range, and `dsh --profile <name> --dump-config` must print nothing on stderr and list the `slice-agent-loop` row. After the start, the host's stderr log must have no `skipping profile bundle` and no `disabling profile plugin` line. A supervisor that only restarts on exit will not notice a skipped plugin.
- **What a skipped plugin does to an existing slice session.** The session keeps working and recovers, but the detour stays in its log. In a rehearsal on 2026-10-13 (scripted model, published hosts), a 0.2.0-rc.2 host with the 0.1.0 build ran a turn on a session slice had written. The host replaced the system prompt in place with a prompt that has no slice section. The request header went from 16 tools to 12, and the loop appended a tool-registry `developer/message` listing the four removed slice tools, a permanent surface node. The model followed a tape entry's `expand_result` hint and got `unknown tool`. This build's tarball was then installed over the 0.1.0 build with `dsh plugin add` from the 0.2.0-rc.2 CLI, and on its next turn the same session recovered: slice sealed the turn the stock loop had run, the system prompt was replaced back, and a tool-addition `developer/message` was appended. The two tool-registry messages and the extra prefix resets stay in the log.
- **Rollback.** Session data is safe in both directions: both hosts read and write `session.v4.jsonl.zstd`. In a second rehearsal on 2026-10-13 (scripted model, published hosts), this build's tarball was installed once, with the 0.1.7-rc.2 CLI, and one session ran turns 1 and 2 on 0.1.7-rc.2, 3 and 4 on 0.2.0-rc.2, 5 on 0.1.7-rc.2 and 6 on 0.2.0-rc.2, each with empty stderr. Each of the five resumes logged one `request/header` with reason `resume` and 16 tools. The log has no tool-registry message and a single `system/message`, and each host sealed turns the other had run. Because this build admits both hosts, rolling the host back needs no plugin change. A build whose range lists only 0.2.0 versions would be skipped by the old host in the same silent way.
- **Do not paper over a stale install with `dsh plugin allow-version`.** The skip line suggests it, but the exemption is keyed on the plugin's name and version and keeps the peer check off for every later build with that version.

## The next host line: 0.2.1

0.2.1 is on npm's `alpha` tag (0.2.1-alpha.2, published 2026-10-09). It is not a target of this build, the exact peer list keeps it out, and the weekly workflow does not probe `alpha`. What is known from the upstream tags and upgrade guides, read on 2026-10-13 and not tested:

- **Runtime invariant plugins are removed.** At `dsh-v0.2.1-alpha.2`, `@deepseek-ai/dsh-invariants` and the `./invariant` subpaths of `@deepseek-ai/dsh-session` and `@deepseek-ai/dsh-agent-loop` are gone, and npm has no 0.2.1 version of `@deepseek-ai/dsh-invariants`. Upstream's guide says a row that names a removed module fails to load. This repository uses all three: `@deepseek-ai/dsh-invariants` is a devDependency, `tests/native-harness.ts`, `tests/fold-plugin.spec.ts` and `scripts/validation/packed-profile.patch.yml` mount invariant rows, the package's own `./invariant` export re-exports `@deepseek-ai/dsh-agent-loop/invariant`, and the README tells users to keep `agent-loop-invariant` enabled.
- **Session and prompt contracts move.** The same tag adds a `working-directory/change` event type and changes session, system-prompt and tools sources. Upstream's guides for that line remove the `{{cwd}}` prompt variable in favour of a working-directory service, and retire the optional schedule bundle by declaring the clock reading and four `schedule_*` tools in the standard preset, which is another request-prefix change. `SESSION_FORMAT_VERSION` is still 4 at `dsh-v0.2.1-alpha.2`.
- **Synchronous log reads are deprecated.** `Session.eventAt()`, `Session.snapshotEvents()` and `Session.ownEvents()` have been marked `@deprecated` ("new calls are prohibited") since 0.1.7. They still work in 0.2.0-rc.2. Sealing, folding and every recall tool are built on them.

Treat that bump as a port: run [Before upgrading the host](#before-upgrading-the-host) against the 0.2.1 tag first.
