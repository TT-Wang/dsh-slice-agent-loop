# Preserve dialogue by default

Date: 2026-09-21. Extends [ADR-0002](0002-native-surface-context.md); the native loop and positional replacement architecture remain unchanged.

## Decision

Slice preserves each original human user message still present on the host surface, verbatim and at its existing node. Sealing does not copy user text into a tape entry. Every visible assistant text message in a newly sealed span is retained in source order and in full by default, including whitespace and text preceding tool calls. Messages carry turn, step and seq identity in their reply wrappers.

`history.entryMaxChars` becomes opt-in. Omission means no entry-character budget and no assistant-text excerpt cap. An explicit value must be a safe integer of at least 256; only that choice enables the existing shrink tiers and final recall-marker fallback. The setting bounds new entry text, including assistant text and indexes; it never shortens original user nodes or bounds the whole request.

`history.pinFirstTurn` and `history.pinUserChars` are retired. Either key fails at load with migration guidance. There is no replacement user-text clipping setting: the protection now applies to every original human user node, rather than just the first turn. `history.keepRecentTurns` still controls which completed assistant/tool spans remain raw at the tail.

<!-- code-anchor: src/context.ts#inspectSurface -->
<!-- code-anchor: src/context.ts#collectItems -->
<!-- code-anchor: src/context.ts#renderCheckpoint -->
<!-- code-anchor: src/index.ts#resolveHistory -->

## Why

The former defaults coupled history retention to three reductions unrelated to whether the text mattered: user text above 1,200 characters became a head/tail excerpt, only the last assistant text in a sealed span survived, and that reply was separately clipped at 2,000 characters. The default 8,000-character entry budget could shrink those excerpts further. Raising or removing one profile value did not disable the other reductions.

Recall preserved access to original records, but availability through a tool is not the same as having instructions, qualifications or intermediate conclusions in the current request. The defaults therefore required additional retrieval without demonstrating that the missing text was unnecessary. The new policy removes these automatic dialogue reductions. It does not claim that keeping more dialogue has already improved task accuracy or reduced billed cost.

## Boundaries retained

- Reasoning and tool-result bodies remain in the durable source log and are accessible through recall. Content-based tool folding and resource-scoped expansion backoff are unchanged.
- Navigation metadata still shows at most six tool locators per turn and ten read observations within a 2,000-code-point index line, with bounded labels. The remaining observations and exact labels are available from the original records. These are display limits, not a dialogue budget.
- Tool-call pairing, source ownership, version-qualified numeric locators, current-turn protection and preservation of the frozen prefix remain required for correctness. An unpaired segment stays raw.
- Existing frozen entries stay byte-identical, including entries written by older versions. Upgrading does not restore their clipped content automatically; recall still reaches the original records. Slice also does not resurrect messages already hidden by another plugin's replacement or host compaction. The guarantees above apply to content present on the surface when this policy seals it.
- Entries and raw user messages accumulate. Complete dialogue can occupy more context and cost more input tokens. The host composition owns context-window handling; no plugin-side total-request bound or provider-cache guarantee is introduced.

## Migration

Remove `history.pinFirstTurn` and `history.pinUserChars` from the profile. Remove `history.entryMaxChars` to adopt full assistant-text retention for future seals; retain a valid explicit cap only if bounded entry text and recall-based recovery are desired. A minimal history section is:

```yaml
history:
  keepRecentTurns: 0
```

No existing running profile is switched by this code change. Updating an installed plugin still requires migrating its explicit retired settings before loading it.

## Validation

On Node 22.22.3 / pnpm 11.7.0, the full suite passed **322 tests across 37 files** against the declared DSH 0.1.5-rc.2 dependencies. Coverage gates passed: statements 86.72%, branches 79.53%, functions 87.46%, lines 91.08%. Build, source/test/script/gate type checks, peer checks and repository-size checks passed.

Deterministic regressions cover long later user nodes, all assistant text in order, whitespace and Unicode, optional-cap behavior, unchanged frozen entries and request reconstruction after durable resume. Independent review found no actionable issue; its focused run passed 82 tests, and its separate multi-block/whitespace/Unicode probe preserved the visible text.

The packed artifact passed native dispatch, inherited reasoning effort, recall and JSONL resume on **DSH 0.1.5-rc.1 and 0.1.5-rc.2**. Each fixture exercised four turns and five model requests, preserving the long later user node, intermediate and final assistant texts, and the previously frozen prefix. The checked tarball SHA-256 was `378a77c2df4ff07603bf8357bc2658af9f094cccbf206b2456bfcbc28d23350c`; this identifies that local validation artifact, not every subsequent pack with documentation changes.

The same 322 tests passed, with none skipped, against the available **DSH 0.1.6-alpha.2 source** checkout at `ddefc45fbc7f8e46dd73185e68295696d1297887`. This is source integration evidence; it does not extend the declared peer range or establish packed installation support for 0.1.6. No paid model evaluation was added, so real-task accuracy, provider cache behavior and total billed cost remain unmeasured for this change.
