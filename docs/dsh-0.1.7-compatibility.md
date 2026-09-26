# DSH 0.1.7 compatibility

The plugin targets **0.1.7-rc.2** and also supports **0.1.7-rc.1**. On 2026-09-25, npm's `next` tag for `@deepseek-ai/dsh` resolved to 0.1.7-rc.2 while `latest` still resolved to **0.1.5-rc.3**. Development dependencies pin rc.2 exactly, and the peer range is limited to `0.1.7-rc.1 || 0.1.7-rc.2`. This build does not support any 0.1.5 host, including 0.1.5-rc.3. Keep a 0.1.5 profile on the previous plugin build (main at `406f513`); see the [0.1.5 notes](dsh-0.1.5-compatibility.md) for that release line.

The tape, fold and recall policy is unchanged; the V4 host differences that change what the model sees are listed under [V4 host behaviour worth knowing](#v4-host-behaviour-worth-knowing). The compatibility update covers these host contracts:

- **Session format V4.** `@deepseek-ai/dsh-session` exports `SESSION_FORMAT_VERSION = 4`. Numeric expansion locators carry that value: `expand_result({"seq":Q,"formatVersion":4})`. The plugin imports the constant; no version number is hard-coded.
- **Tool results are tool-role messages.** A `tool/result` event's `data.message` is `{ role: 'tool', toolCallId, content, isError?, source: { kind: 'tool', callId } }`, one message per call. The V3 `tool-result` content-block wrapper is gone. Sealed tool lines, the read index, folding, `recall_turn`, `recall_step`, `recall_search` and `expand_result` read results in this format, including those produced by several parallel calls in one step and results from PTC programs.
- **Message sources name their producer.** V3's shared `{ kind: 'plugin', plugin: X }` wrapper is gone. Slice writes tape entries with source `{ kind: 'plugin:slice:history' }` (`HISTORY_SOURCE` in `src/context.ts`) and recognises runtime snapshots by kind `runtime-context` (`RUNTIME_CONTEXT_SOURCE`). `recall_turn` pages label generated context by that kind, for example `[runtime-context]`; `recall_search` hits label all generated context `[context]`, as before. The plugin extends `MessageSourceMap` in `@deepseek-ai/dsh-llm` with its own kind.
- **The system prompt is surface node 0.** It is a `system/message` event that the host replaces in place, and the host rejects any other replacement covering node 0. Slice protects every `system/message` and `developer/message` node. It never seals these nodes or cites them in `sourceEventSeqs`, and it counts node 0 when it computes the frozen prefix. Loop-built requests carry the prompt only as message 0, not in `request.system`.
- **PTC vocabulary.** `dsh-code-runtime` is now `dsh-ptc-runtime` (`PtcRuntime`, `ctx.ptcRuntime`). The nested-dispatch events that the read index uses keep their `tool/ptc-dispatch*` names.
- **Test-harness changes only.** `SettingsProvider` was removed, and the spill policy now counts `maxInlineTokens` (roughly 4 characters per token) in place of `maxInlineBytes`. The test harness and fold fixtures were updated. Plugin configuration is unchanged.

## V4 host behaviour worth knowing

- **On rc.2, a tool-set change splits its turn into two entries.** When the tool set changes between requests, the 0.1.7-rc.2 loop appends a `developer/message` (source `tool-registry`, content `tool-addition` / `tool-removal`) inside the next turn, after that turn's user message, runtime snapshot and request header. The node is protected, and a protected node ends a sealed run, so once the turn seals, its superseded snapshot and its replies land in two entries that both carry the header `turns N-N · 1 turn(s) sealed`. Pointers and recall are unaffected; the model sees the same turn header twice. `tests/native-context.spec.ts` covers this. 0.1.7-rc.1 does not emit this node: its `dsh-llm` already defines the `tool-addition` / `tool-removal` content, but its agent loop never appends the message (rc.2 added that in `packages/core/agent-loop/src/agent.ts`). On rc.1 the turn therefore seals as one entry, and that test is the one failure when the suite runs against rc.1 source (see [source-checkout verification](#source-checkout-verification-on-2026-09-27)).
- **Native spill notices can count images, and they preview the whole result.** 0.1.7's spill-policy bounds results by `maxInlineTokens` and keeps whole images: its retained copy is `[head, image…, "[...]" + tail + notice]`, and the notice may read `(Omitted N bytes. Omitted M images. Full formatted result stored at: …)`. The stored file holds the complete formatted content, with each image as a descriptor line. When the last text part of a result carries that notice, `expand_result` and `recall_step` return the stored file once for the whole result instead of hydrating each part, so the retained head is not repeated. A fold spill preview still covers only its own part.
- **Fold state crosses a V3 resume.** A fold replacement written by a 0.1.5 build keeps its frozen `"formatVersion": 3` hint. On replay the folder rebuilds the view with the version the replacement names, so that fold still counts and retrieving it by `turn`/`step`/`call` still drives expansion backoff. Retrievals made with an old-format numeric `seq` are not recounted, because they can no longer be resolved safely.

## Resuming a V3 session

The 0.1.7 JSONL provider restores format-3 sessions through its format catalog as V4. It does not rewrite the stored V3 generation, and a V4 successor is published on the next write. No plugin row or migration command is required. The host's [V3-to-V4 migration](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.7-rc.1/packages/session/session-format-v3-to-v4) does the following:

- converts each tool result into a tool-role message. It requires exactly one result block per event; otherwise the host refuses the session.
- renames message sources. `{ kind: 'plugin', plugin: 'slice:history' }` becomes `plugin:slice:history`. `@deepseek-ai/dsh-system-prompt` becomes `runtime-context` on a user-role message and `system-prompt` on a system-role message.
- leaves sequence numbers unchanged unless it must insert an `interrupted` turn end. In that case later events are renumbered and structural references (`sourceEventSeqs`, replacement `startSeq`/`endSeq`) are remapped.

Tape entries restored from V3 are therefore recognised by their migrated source kind and by their `[slice tape v1 · turns ` / `[slice checkpoint v1 · turns ` text prefix. They stay frozen, and sealing on a resumed session does not backfill ahead of the last one. Only the newest runtime snapshot is protected. The committed fixture `tests/fixtures/slice-v3-session.v3.jsonl` was written by the unmodified 0.1.5 build on DSH 0.1.5-rc.2, and `tests/host-format-upgrade.spec.ts` checks the following:

- after restore, the source kinds are renamed, results become tool-role messages and seqs are unchanged. Frozen entry text, including its `formatVersion:3` locators, is kept byte for byte.
- on the restored session, sealing protects the newest snapshot and cites only the new turn's nodes. It absorbs a snapshot only when a newer one exists.
- after a resume on the 0.1.7 native loop, only the newly completed turn is sealed. The restored entries keep their bytes and order in every request, and no system node or live snapshot is cited.

A second format-3 fixture, `tests/fixtures/slice-v3-tools-session.v3.jsonl` (see its `.md`), covers the other result shapes: two parallel calls, a PTC program with a nested `read` dispatch, a failed call (`isError`), and a result the fold replaced. Its tests check that each result becomes one tool-role message, that the fold replacement and the nested dispatch survive, that `expand_result`, `recall_step`, `recall_search` and `recall_turn` return the original bytes, and that a resumed folder counts the V3 fold and backs off after it is retrieved.

The existing alpha.2 (format 2) fixture is restored through V3 into V4. Its tests check the renamed source, byte-identical entry text, the restored `full` recall view, the `session.v4.jsonl` successor written on the next write, and refusal of `seq` locators labelled format 2 or 3.

## Old numeric locators

The host deliberately does not rewrite message text or tool arguments, so a restored tape still says `expand_result({"seq":22,"formatVersion":3})`. In the recorded fixture those seqs still point at the same results. However, a session whose migration inserted events would have shifted numbers, and the plugin cannot tell the two cases apart from the text.

`expand_result` therefore refuses a numeric `seq` whose `formatVersion` is missing, older (2 or 3) or otherwise different from `SESSION_FORMAT_VERSION`. The refusal happens before lookup, and the error explains how to refresh the locator: take a fresh locator from `recall_turn` with `view:"dialogue"` or from `recall_search`, or use the stable `{"turn":N,"step":M,"call":K}` address. Do not relabel an old number with the new version. Frozen text keeps its old locators; new entries and recall pages print format-4 locators for the restored log.

`expand_result` still accepts a `block` argument. Each V4 result is a single block, so only `block: 1` is valid; any other value reports that the result has one block.

## Before upgrading the host

Before bumping the pinned packages to a new host tag, run the whole plugin suite against that tag's source. This finds host contract changes while the upgrade is still a decision: the 0.1.5-rc.1 source failed 97 tests on 2026-09-13 (positional replacements moved to `startSeq`/`endSeq`), and the 0.1.6-alpha.2 source failed 9 PTC tests on 2026-09-21 (`codeRuntime` became `ptcRuntime`). The step is manual; no CI job runs it. The weekly Peer compatibility workflow (`.github/workflows/compat.yml`) installs npm's `next` tag for the `@deepseek-ai/dsh*` packages and fails once `next` falls outside the declared peer range, which is the usual signal that a new tag needs this check.

The steps need git, pnpm 11.7.0, a supported Node, and a C compiler (`cc`) for the host's native addon. Clone the target tag and prepare it:

```sh
TAG=dsh-v0.1.7-rc.2
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

- `--ignore-scripts` skips upstream's install hooks. No `fs-ext` build is needed: the 0.1.7 lockfile has no `fs-ext`, and file locking comes from the host's own `flock` addon.
- `build:native-system` compiles that addon into `native/system/packages/<platform>-<arch>/bin/system.node`; upstream's own `pnpm test` runs the same step first. JSONL persistence loads it. Without it 7 tests fail: 4 in `tests/host-format-upgrade.spec.ts` name the missing `system.node`, while 3 in `tests/native-context.spec.ts` and `tests/tape-protected.spec.ts` report only `SessionPersistenceNotFoundError` on resume.
- No upstream `lib/` build is needed. `scripts/validation/run-master-tests.mjs` resolves every Harness import through the checkout's `tsconfig.base.json` path map and points tsx at the same file (`TSX_TSCONFIG_PATH`). The 0.1.7 JSONL provider verifies a migrated generation in a worker thread that it loads through tsx, outside Vite's aliases. Before the script set that variable, a fresh checkout failed the 4 restore tests in `tests/host-format-upgrade.spec.ts`, which asked for unbuilt `lib/` files. Building upstream `lib/` also works (a full install plus `pnpm run build:lib:host` took 167 s on the machine below), but then the worker runs built code rather than the checked-out source.
- The script prints the host commit, test counts and an evidence directory, and exits non-zero on any failure. Explain every failure before bumping the pins: fix the plugin, or record the host difference in the compatibility notes, as with the rc.1 tool-set notice above.

## Verification recorded on 2026-09-25

Local verification on Node 22.22.3 / pnpm 11.7.0, macOS arm64, against DSH 0.1.7-rc.2 development dependencies passed **342/342 tests across 38 files** and all typechecks (source, tests, scripts, gates). `pnpm install --frozen-lockfile` and `pnpm peers check` passed.

The packed check installed the same tarball into the published rc.2 and rc.1 CLIs (SHA-256 `0aa86f4fd9d05a401e896ba4ba785bda6e831a0326bd3dc06eb9e7821c64d37a` for that run). Each run made five model requests over four turns, reported session format 4, and kept the system prompt as a single `system/message` at node 0. Each run also carried one live snapshot with source `runtime-context`, wrote three frozen tape entries with source `plugin:slice:history`, reloaded JSONL persistence, and reported zero agent errors. The digest identifies that run's build only; a rebuild that changes `lib/` changes it, and CI repeats the packed check on every change.

The pinned hosts are younger than pnpm's `minimumReleaseAge`. The repository's `pnpm-workspace.yaml` exempts exactly the 46 `@deepseek-ai` 0.1.7-rc.2 packages in the lockfile. Installing the published CLI also brings in their transitive closure. For that install, `scripts/validation/run-packed-smoke.mjs` exempts only exact `@deepseek-ai/*` versions that pnpm reports as too young, and fails on any other immature package. It records those versions in its evidence directory (227 for rc.2, 0 for rc.1 in the run above).

CI runs the doc check, typechecks, the full suite with coverage, generated-artifact checks and the packed rc.2 installation on Node 22.19.0, 22.22.3 and 24.x, plus the packed rc.1 installation on Node 22.22.3. No paid model evaluation or benchmark was run. These compatibility tests do not measure cost or model success rate.

## Source-checkout verification on 2026-09-27

The 2026-09-25 record above has no source-level run; this one follows [Before upgrading the host](#before-upgrading-the-host) for both supported tags. Plugin: main `ba12a5b` plus the `TSX_TSCONFIG_PATH` change to `scripts/validation/run-master-tests.mjs`. Machine: Node 22.22.3, pnpm 11.7.0, macOS arm64.

| Host source | Result |
| --- | --- |
| `dsh-v0.1.7-rc.2`, commit `477b4f4`, fresh shallow clone | **342/342 across 38 files**, zero skipped |
| `dsh-v0.1.7-rc.1`, commit `46a7f68`, fresh shallow clone | 341/342. The failure is the `tests/native-context.spec.ts` case "keeps host developer/message tool-set notices on the surface and out of every entry when the tool set changes": rc.1 appends no tool-registry `developer/message` (see [V4 host behaviour worth knowing](#v4-host-behaviour-worth-knowing)). A pre-built local rc.1 checkout at the same commit gave the same result. |

Wall time for rc.2 with a warm pnpm store: clone 6.4 s (183 MB, 37 MB of it `.git`), filtered install 7–8 s (849 packages, all reused from the store, none downloaded), native build 2–3 s, `verify:master` 6–7 s. A cold store has to download those 849 packages; that time was not measured. Before the script change, the same fresh rc.2 checkout passed 335/342 without the native build and 338/342 with it. Neither upstream checkout had tracked or untracked changes afterwards; only ignored build output was added.
