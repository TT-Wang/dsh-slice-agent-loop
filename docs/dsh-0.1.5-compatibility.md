# DSH 0.1.5 compatibility

> Historical. The current build targets DSH 0.1.7-rc.2 / 0.1.7-rc.1 and session format V4: see [DSH 0.1.7 compatibility](dsh-0.1.7-compatibility.md). The contracts below (format 3, `tool-result` blocks, `{ kind: 'plugin', plugin }` sources) describe the 0.1.5 release line only.

The plugin targets **0.1.5-rc.2** and also supports **0.1.5-rc.1**. On 2026-09-13, npm's `next` tag resolved to rc.2 while `latest` still resolved to rc.1. Dependencies and packed checks use exact versions; the supported peer range is limited to those two verified releases.

The native tape, fold and recall policy is retained. The compatibility update changes four host contracts:

- Surface replacements emit `startSeq` / `endSeq`, retaining the original event provenance.
- Nested tool evidence is read from `tool/ptc-dispatch`, including successful reads and retrieval/backoff accounting. Nested call IDs remain opaque.
- System instructions are native `system/message` surface nodes. Slice protects every system node; only the host can normalize the active prompt or empty dormant nodes. Request verification reconstructs actual system-role messages rather than reading retired request/header fields.
- Numeric expansion locators include `formatVersion: 3`, checked against the host's exported `SESSION_FORMAT_VERSION` before lookup. Turn/step/call expansion remains supported.

## Existing sessions

The latest JSONL provider performs its own v2→v3 migration; no extra plugin row is required. It inserts system messages, renames dispatch events and remaps structural sequence references. The old v2 generation is retained when a v3 successor is published.

The host deliberately does not rewrite arbitrary message text or tool arguments. A frozen old tape can therefore still contain `expand_result({"seq":11})` even though original event 11 now has a different sequence number. Such a hint must not silently retrieve whichever event now occupies 11.

This plugin rejects bare or mismatched-version numeric locators. Obtain a current locator through `recall_turn` with `view:"dialogue"` or `recall_search`, or use `turn`/`step`/`call`. A caller must not simply add the new format version to an old number. Frozen tape text remains unchanged; automatic numeric remapping is not guessed. New locators carry the current version and refer to the migrated log.

This build does not support the old alpha.2 runtime API. Existing running profiles and directories were not switched during the upgrade.

## Verification recorded on 2026-09-13

This historical compatibility receipt predates the September 16 audit fixes. The updated verification is recorded in [the audit cross-check](reviews/2026-09-16-crosscheck.md).

Local verification passed: **250/250 tests across 31 files**, typechecks, clean peer dependencies, and **250/250** tests against exact rc.2 source `fb2c4b9e698e30edb738bca4cf0618587db7d203`. The same tarball passed both rc.2 and rc.1 CLI installations: each ran five model requests over four turns, retained the native system message and three frozen tape entries, reloaded JSONL persistence, and reported zero agent errors. SHA-256: `9bac66586cdebedaf0342c03056cce3e52fbc4fd5c2aa63195400ea20d8e3a21`. See the [machine-readable receipt](dsh-0.1.5-verification.json). Checks cover the published rc.2 dependency graph, exact release source, packed CLI installation on rc.2 and rc.1, native system-message reconstruction, PTC retrieval, JSONL resume, and migration of an actual alpha.2 mock session. No paid model evaluation or new benchmark campaign was run, and compatibility tests do not measure cost or model success rate.

CI runs typechecks, the full suite, deterministic generated-artifact checks and packed rc.2 installation on Node 22 and 24. It also runs packed rc.1 installation on Node 22.
