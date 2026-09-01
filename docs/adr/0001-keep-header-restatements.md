# Keep the paid-header restatements of the composition rule

The composition rule (tape composition == OPEN FILES hash ⇒ edit directly,
otherwise read) is deliberately stated three times per turn — kernel FILES
paragraph (cached), FILES_HDR, and the NOW footer (both per-turn paid text,
~80 tok/turn combined). Deduplicating the two paid restatements looks like an
obvious cleanup; a 2026-09-01 A/B (s10 76-turn + n1, two runs per arm,
`results/20260901-header-dedup/`) measured it and rejected it: cross-turn
composition trust survives on the kernel alone, but same-turn post-edit
verification re-reads inflate from a stable 10/10 (control) to 25/15 (dedup).
The repetition's real job is damping re-read paranoia, not teaching the rule.
Do not remove these restatements without re-running that gate.

**Consequences**: "one teaching site per rule" stays an aspiration, not an
invariant — a restatement may earn its per-turn cost through side effects the
rule's semantics don't predict. Any future header slimming must A/B against
the behavior gates in the experiment contract (success count, redundant
re-reads, recall usage, closeout), not just token arithmetic.
