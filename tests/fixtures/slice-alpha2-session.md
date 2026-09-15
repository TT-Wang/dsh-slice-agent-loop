# Native alpha.2 session migration fixture

`slice-alpha2-session.v2.jsonl` was written by the published DSH
`0.1.3-alpha.2` JSONL provider with the native loop and the slice plugin at
`db72621f2897274689f1a3cd5e02e6ec11fb7efd`. Alpha.2 writes session format **2**.
The model and the `fixture_read` tool were deterministic local fixtures; no
provider calls or user session data were involved.

The first turn calls the tool three times in one assistant step, returning
distinct bodies. The second turn seals the first one into the original frozen
tape. Folding was disabled to make the result identities easy to inspect.

Original result seqs are **9, 11, 13**. DSH's format-3 migration inserts an empty
system head and the initial system-prompt replacement, moving those results to
**11, 13, 15**. Envelope references are remapped; message text and tool arguments
are preserved. Therefore the old tape's `expand_result({"seq":11})` would return
the wrong result if an unqualified numeric locator were accepted after upgrade.
Turn/step/result ordinal addresses continue to identify the same original bytes.

The fixture is intentionally kept in its original provider-written form,
including the old tool descriptions and message IDs. Do not rewrite its tape,
normalize its seqs, or regenerate it with the current host; those changes would
remove the migration case being tested.
