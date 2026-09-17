> **Status (2026-09-11, restated 2026-09-12): not on the live request path.**
> The plugin stopped calling `admitTape` with the pressure-archive policy, and
> the append-only tape that replaced it (`planSeal` in `src/context.ts`) does
> not call it either: each completed turn is sealed into one frozen
> `[slice tape v1 …]` node at its own position, instead of a per-span tape
> re-selected under a cap with omission markers. This page documents the pure
> module and its tests only.

# Request tape admission

`admitTape` in `src/lab/tape-admission.ts` selects a request view from recorded
tape entries. It does not replace `compactTape` or mutate continuity state.
The caller retains the original tape and supplies `maxTapeChars` explicitly;
this module changes no configured defaults or prompt headers.

When the tape fits, the returned `entries` is the input array itself. Its
rendered bytes and cache prefix remain identical. On overflow, the policy:

1. Removes obsolete file history preceding the newest base for each path.
2. Removes the oldest complete groups until the request tape fits. Each file's
   remaining history is indivisible. Non-file entries form groups beginning at
   digest boundaries, keeping each digest with its reply and reasoning.
3. Includes a marker with exact durable turn or step recall calls in the bound.

Retained entries keep their original object identities and rendered bytes.
`omitted` records each removed entry, its original index, reason, and source;
the result is deterministic for the same entries, cap, and provenance.

```ts
const admission = admitTape(continuity.sessionTape, {
  maxTapeChars: config.maxTapeChars,
  recallForEntry: (entry, index) => verifiedSources.get(index),
})
if (!admission.ok) {
  throw new Error(`Tape admission failed: ${admission.reason}; ${admission.requiredChars} chars needed`)
}
const requestTape = admission.entries
```

The provenance callback is an assertion by the caller: the named durable
`recall_turn` or `recall_step` page must actually contain the entry's recorded
content. A neighboring digest, an entry's `ref`, or a filesystem path alone
does not prove this. A tool result may contain only an excerpt, and reading a
file now cannot recover its historical version. Admission therefore infers no
locators. A file base needs a recall page containing that exact historical
body; if the integration does not have one, it must retain the base or fail.
Every source is validated as a positive safe-integer turn or step number.

Groups with missing provenance remain mandatory. If their size prevents a safe
view from fitting, the result is `unrecoverable-history` with the affected
indexes. If the omission marker cannot fit even after all recoverable entries
are removed, the result is `budget-too-small`. No failure returns an ostensibly
usable over-budget view. An empty tape with cap zero succeeds; a nonempty tape
cannot hide its omissions to satisfy cap zero.

The bound measures Unicode code points in `tapeRender(admission.entries)`,
including markers. It excludes the tape header, system instructions, current
request, tools, attachments, and within-turn trajectory. It is **not** a token
or whole-request bound; integrations must budget those separately. Since
changing admission changes the cache prefix, admission only edits the view
when the original tape exceeds its explicit cap.

Tests cover ten 60,000-character current bases, exact code-point boundaries,
zero caps, immutable history, missing provenance, correct turn/step locators,
and base/patch chains spanning several turns.
