# September 16 audit cross-check and fixes

The supplied deep review audited `db72621f2897274689f1a3cd5e02e6ec11fb7efd` (219 tests). This cross-check started from `023385f6ae3f7bb3f91babef2058708298590777` on PR #8, which already contained the retrieval fixes and DSH 0.1.5 migration (250 tests). The original checkout and its untracked review were preserved; all changes here are in the separate fix worktree.

The supplied report was manually synthesized from published, independently reviewed track evidence. Its swarm synthesis tasks were cancelled, and the tests track's host verdict did not persist. This follow-up does not relabel that process as a completed synthesis. The unchanged source report's SHA-256 is `15bc5189040479dc8f80dbee3a8f7025c3369c8d2cd4a6e953cc07a4aa02414a`.

## Runtime changes

Between-turn user input now belongs to the preceding ended turn in both sealing and recall. A same-log before/after probe against the prior compiled code gave `page1=false, page2=false, hits=0`; the fix gives `page1=true, page2=false, hits=[1]`. Input before the first turn remains on the surface because no recall page can serve it. Empty messages retain an explicit trace, while full recall preserves original records and whitespace.

New entries strictly obey `history.entryMaxChars` in Unicode code points. Read labels and index lines are bounded, shrink tiers can omit indexes, and a large backlog ultimately becomes a compact span with a complete full-turn recall instruction. The minimum is now **256** to fit that instruction; smaller settings fail at load with a migration explanation. This changes a former target into a hard cap for new entry text only. Previously frozen entries, protected raw messages, the aggregate tape and the active turn are not capped or rewritten.

The read-evidence index caches metadata per `Session` and processes appended log suffixes. Each read payload is hashed once; restore creates a new index and replays its prefix once. Execution coordinates prevent reused call IDs from attaching a later result to an earlier read. Unused request-size diagnostics no longer serialize the entire request, and the same unmatched-tool segment warns once per session instance.

These changes reduce excess displayed text and repeated local work. A smaller excerpt can require more recall calls. Deterministic preservation tests do not establish real-model accuracy, total token cost or provider cache savings.

## Finding-by-finding disposition

IDs below refer to the supplied report; retaining an ID does not endorse its original severity. In particular, P0-1 is a loss of access through recall, not deletion of bytes from the durable log, and its production frequency remains unmeasured.

| Finding | Disposition and evidence |
| --- | --- |
| P0-1 | Fixed shared attribution in `turn-ownership.ts`, `context.ts`, `recall.ts`; [ownership regressions](../../tests/recall-ownership.spec.ts) cover exact pages, search, empty records and pre-first-turn retention. |
| P0-2 | Fixed hard entry cap, bounded labels/indexes and complete recall fallback; [cost regressions](../../tests/context-costs.spec.ts) cover 13 turns × 10 long-path reads, 80-turn minimum-cap fallback and old-entry immutability. |
| P0-3 | Already fixed before this audit cross-check. Added an [offline actual YAML/bundle test](../../tests/gates-packed-fixture.spec.ts) to prevent a retired-key fixture from returning. Packed Loader checks remain separate. |
| P0-4 | `CONTEXT.md` was already rewritten. Added declaration-aware `check:docs`, with negative tests proving a retired symbol in comments/strings cannot satisfy an anchor. Corrected remaining stale mechanism claims in secondary docs. |
| P1-1 | `check:build` now rejects tracked, staged, new untracked and ignored generated artifacts; [gate tests](../../tests/gates.spec.ts) exercise each failure. |
| P1-2 | `tsconfig.gates.json` checks every `scripts/**/*.mjs` with `allowJs`/`checkJs`, including the archived benchmark runner's declared legacy data shape. Typechecking does not certify that historical runner against current web APIs. |
| P1-3 | `check:peers` validates resolved versions against this package's own peer promise, including unsupported prerelease failures. Both regular and compatibility CI run it in addition to pnpm's dependency checks. |
| P1-4 | Incremental read indexing; deterministic 400-turn test asserts exactly 400 hashes and suffix-only reads, including repeated calls without new events. |
| P1-5 | Empty user/assistant traces are explicit. Pinned user input is not mislabeled as empty. A recall-only fallback explicitly says details are omitted rather than pretending to list every turn. |
| P1-6 | Misleading in-turn-sealing comment was already removed. Kept host ownership of window errors; [native overflow regression](../../tests/native-overflow.spec.ts) proves the error is observable, failed-turn bytes stay raw, and later actual recall serves them. No new approximate size warning or plugin budget. |
| P1-7 | Retained intentional protection of foreign instruction/plugin messages. Native integration tests preserve their exact identity, source and position through later seals. Their producer/host owns retirement; the policy cannot assume every user-role plugin message is disposable dialogue. |
| P1-8 | Added native multi-tool success/failure dispatch, pairing, sealing and recall coverage. Removed unused error/hang/context-window paths from the older mock adapter; native provider retry/overflow tests exercise actual host failures. |
| P1-9 | Added pinned V8 coverage, measured an initial baseline, and enabled explicit global floors (85 statements / 78 branches / 86 functions / 90 lines). Includes `src/**` except `src/lab/**`; no files excluded merely for low coverage. |
| P2-1 | Diagnostic request sizing is lazy and cached; code-point counting no longer allocates a code-point array for the whole request. The compatibility helper remains available outside the normal sealing path. |
| P2-2 | Repeated warning deduplicated; unpaired-call retention deliberately preserved. An aborted call is not evidence that removing only one half preserves native message validity. |
| P2-3 | Native logger exporter captures warnings. Tests assert step-limit emission and capability-fallback emission/deduplication; existing policy callback tests remain. |
| P2-4 | CI now includes the declared Node 22.19.0 floor as well as 22.22.3 and 24.x. |
| P2-5 | Removed unused internal `PyTypeError`/`ContextUnfitError`; retained used `ValueError`. `./invariant` re-exports the stock invariant (it is not a no-op); packed smoke imports and validates its entry point without installing it twice. |
| P2-6 | `link:dsh` derives its full package list from metadata, preflights it, stages replacements, rolls back write failures and checks real paths. A disposable copy linked all 31 packages to exact rc.2 source; active dependencies were not relinked. |
| P2-7 | Documented release-age exclusions as inert unless a global/workspace age policy enables them; no new release-delay policy imposed. |
| P2-8 | Explicit decision: preserve the existing evidence archive and the 64 MiB ceiling. This fix adds no model-run archive and does not delete/rewrite historical sidecars. Any future archive migration must update consumers and checksums together. |
| P2-9 | Same `check:build` gate as P1-1; CI rebuilds and checks committed installable artifacts. No local Git hook imposed. |
| P2-10 | Long-line fixture now uses a deterministic generator with the same length/classification requirements. |
| P2-11 | Exact source verification remains manual-only and is now labeled as such. Existing newest-published-peer monitoring stays in place; no new scheduled master job. |
| P2-12 | Triage docs now distinguish desired labels from provisioned labels. Removed misleading historical links; relative links are checked. Historical counts are dated receipts rather than claims about current main. |
| P2-13 | Recorded-memory and ADR text now identifies the continuity reducer as offline; live sealing/reads point to current modules. |
| P2-14 | Historical experiment banner no longer endorses ignored budget keys or claims the tracked archive is untracked. It remains an unexecuted historical plan. |

## Verification

[Machine-readable receipt](2026-09-16-verification.json) records the following final local checks, separately from the historical audit:

- **285/285 tests across 37 files**, all four TypeScript configurations, document anchors/links and both peer checks pass.
- Coverage: **87.07% statements / 79.80% branches / 88.32% functions / 91.22% lines**, above the configured floors.
- Exact rc.2 source `fb2c4b9e698e30edb738bca4cf0618587db7d203`: **285 passed, zero skipped**.
- The same final tarball passed actual CLI/Loader installation on **0.1.5-rc.2 and 0.1.5-rc.1**. Each ran five requests over four turns, retained three frozen entries and native system context, loaded `./invariant`, reloaded JSONL and reported no agent errors. SHA-256: `492fd9e4e4ae460ccc52e43e858953ebdc284f12d0b38b2e98ea41012bf3b1a3`. Every shipped `lib/` file, manifest, README and bundle was compared byte-for-byte to the final working tree.
- Path/selector stress case, 13 turns × 10 reads: **191,431 → 1,596 code points**, under a 2,000 cap, with all short question/reply pairs and per-turn full-recall hints preserved. This is deliberately pathological input, not an estimated typical saving.
- Local 400-turn cold-seal median: **915 → 88 ms**; adding one read to the index: **78.6 → 0.178 ms**. These are three-repetition informational timings during concurrent verification, not portable performance promises. The stable gate asserts one payload hash per read.

CI rebuilds committed artifacts and runs coverage, type, peer, docs and packed checks on Node 22.19.0, 22.22.3 and 24.x. Its execution status is visible on [PR #8](https://github.com/TT-Wang/dsh-slice-agent-loop/pull/8); the local receipt does not claim a CI run that has not yet completed.

The separate Agent Swarm directory-comparison problem and preview profile were not changed or restarted as part of these slice fixes. Existing running slice profiles remain unchanged.
