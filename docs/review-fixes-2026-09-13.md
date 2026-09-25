# Review fixes, 2026-09-13

This report records the alpha.2 verification at `2b55782`. The subsequent [DSH 0.1.5 compatibility update](dsh-0.1.5-compatibility.md) and then the [DSH 0.1.7 update](dsh-0.1.7-compatibility.md) supersede its host compatibility boundary (under session format V4 each result event carries one tool-role message, so the multi-block sibling cases below no longer arise); its original test receipts remain historical evidence.

This patch fixes the ten findings reviewed at `db72621f2897274689f1a3cd5e02e6ec11fb7efd`. It retains the current per-turn tape policy, default reasoning effort, and shipped alpha.2 host target. It does not switch existing profiles or run paid model evaluations.

| Finding | Result | Regression coverage |
|---|---|---|
| 1. Nested expansion folded again | Successful retrieval content forwarded through `run_code` survives both slice folding and native spill middleware. Successful direct and nested expansions contribute to backoff; failed/discarded retrieval does not grant unrelated output an exemption. | `fold-code-dispatch.spec.ts`, `fold-plugin.spec.ts` |
| 2. Packed smoke uses retired history keys | Fixture loads shipped defaults and checks actual sealed content, frozen entry identity, native request reconstruction and JSONL resume. | `scripts/validation/packed-runner.mjs` |
| 3. Late runtime update rewrites the tape prefix | All surface nodes through the last existing tape entry stay frozen. Older snapshots that later become superseded remain at their original positions; snapshot-only entries are not resealed. | `runtime-snapshot-archive.spec.ts` |
| 4. Failed reads appear successful | Errors do not enter the successful file index or comparison history. Successful retries are represented. | `read-provenance.spec.ts` |
| 5. Fingerprint compares a different observation | The visible index and prior history use the same last successful observation per tool, path, window and channel, with exact step/seq/result-block references. | `read-digest.spec.ts`, `read-provenance.spec.ts` |
| 6. Native code reads disappear | Nested dispatch reads are linked to their outer execution and indexed as code-visible evidence, without claiming model visibility. Reused IDs do not cross-contaminate turns. | `read-provenance.spec.ts` |
| 7. Tool-input hit opens a page without arguments | Search points tool-input hits to the full original-record view. | `recall-regressions.spec.ts` |
| 8. Recall sibling hides ordinary results | Search filters and classifies each result block independently; locators select an exact 1-based sibling. Expansion without a block selector retains all-sibling behavior. | `recall-regressions.spec.ts` |
| 9. Step recall calls a spill preview verbatim | The tool hydrates available spills. Unavailable storage and log-only rendering explicitly label previews and provide exact expansion locators. Each sibling and inner text part hydrates separately, preserving adjacent text and available evidence when another spill is missing. | `recall-regressions.spec.ts` |
| 10. Failed attempt loses exposure watermark | A durable `assistant/attempt` also marks preceding results as potentially sent, so resume with stricter policy does not retroactively fold them. | `fold-resume.spec.ts` |

Independent review checked the context and fold/recall changes. It also identified execution-ID reuse as an edge case; provenance and expansion accounting now distinguish executions instead of relying on the model's call ID alone.

## Verification

Final local checks: **244/244 tests across 30 files**, TypeScript checks, clean generated build, and **244/244** against the alpha.2 source checkout. Packed installation passed on Node 22.22.3 / pnpm 11.7.0: five model requests across four turns, three retained frozen tape entries, JSONL reload, and zero agent errors. Artifact SHA-256: `3bde9deef742274e4029d28c0096d7b7ee0a040ffd656fc41ee0df942f110e4a`. See the [machine-readable receipt](review-fixes-2026-09-13.json). Tests use deterministic model responses with real DSH session, loop, projection, persistence, dispatch and spill components where the contract matters. These checks establish mechanics and retrieval correctness; they do not establish a model success-rate or billing improvement.

## Compatibility boundary

The supported target is published DSH `0.1.3-alpha.2`. The existing source checkout at `c389f96bf3a9b6807cb71ed6bdad5849be0df6d8` also passes the plugin suite.

An additional diagnostic run against local DSH `0.1.5-rc.1` source at `183f08e9c6dde7e36cd2318eaee70b0da08fb35e` failed (138 passed / 97 failed at the time of that run). That host now requires replacement operations with `startSeq` / `endSeq`; this plugin and its alpha.2 fixtures use `start` / `end`. This is not a passing compatibility result or a host migration. The patch must not be installed into that newer host as though the contracts were interchangeable.

The tape has no aggregate history ceiling: entries accumulate, and host context-window handling must be configured separately. The documentation no longer claims total boundedness or that every request bills only its new entry.
