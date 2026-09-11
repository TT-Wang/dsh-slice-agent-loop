# Keep the paid-header restatements of the composition rule

**Status: superseded in code, not by a re-run gate (recorded 2026-09-10).** The
constraint below ("do not remove these restatements without re-running that
gate") was violated: the very commit this ADR rejected is on `main`, and the
gate was never re-run.

| Claim in this repo | What the repository actually shows |
|---|---|
| `docs/legacy-loop.md` / `.zh.md`: branch `feature/header-dedup` "left unmerged as the artifact" | `git merge-base --is-ancestor ddd2503 main` → true; `git log --oneline main..feature/header-dedup` → 0 commits. The branch tip **is** `ddd2503` and it is fully contained in `main` (merge path `9df163a`). |
| "Do not remove these restatements" (below) | `ddd2503` deleted both, and that deletion is what shipped. The renderer still carries the tombstones the rejected commit left behind — `assemble.ts:71` "这里曾逐字复述,属现付文本,删" and `:98` "此处曾是第三处复述,删" (`src/slice/assemble.ts` on `main` c6de4e1; the file may since have been relocated as a non-live module). `git show ddd2503 -- <path>/assemble.ts` is the path-independent evidence. |
| The ADR commit `dc6cd24`'s own message: "Branch left unmerged." | Contradicted by the two commands above. |
| "re-running that gate" | Never happened. `find results -name '*hdrslim*'` matches only `results/20260901-header-dedup/`; the later `results/20260903-hdr/` is a `s2_taskdag_scheduler` TAPE_HDR base-mode experiment, unrelated to the s10/n1 dedup gate. |

**Mitigating fact — this is a broken evidence chain, not a live behavior
regression.** Since the 2026-09-08 native migration `assemble.ts` is no longer
on the plugin's live call graph: the published entry (`src/index.ts` →
`lib/index.js`) imports only `context` / `effort-default` / `recall` /
`recall-step` / `fold`, and its only non-test importer is the offline
zone-attribution module `miss-attribution.ts`. The live renderer is
`src/context.ts` (`HISTORY_HEADER` + `# SESSION TAPE`), which never had these
restatements. So the deleted restatements are not shipping to any
model today, and the A/B result below has not been contradicted — it simply was
never re-tested before the code that it forbade was merged.

**What this ADR still means.** The 2026-09-01 measurement stands as a finding
about the retired renderer: paid repetition damped same-turn re-read paranoia.
It is **not** evidence about the native `# SESSION TAPE` policy and must not be
cited as a live constraint. If paid-header slimming is ever revisited on the
native path, re-derive the gate there; do not reuse this verdict.

---

## Original decision (2026-09-01, retired custom loop)

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
**[2026-09-10: this constraint was not honored — see Status above.]**

**Consequences**: "one teaching site per rule" stays an aspiration, not an
invariant — a restatement may earn its per-turn cost through side effects the
rule's semantics don't predict. Any future header slimming must A/B against
the behavior gates in the experiment contract (success count, redundant
re-reads, recall usage, closeout), not just token arithmetic.
