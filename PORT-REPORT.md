# Slice Engine Python→TS Port — Final Report (task #8)

**Result: 44/44 golden cases byte-identical; 58/58 vitest tests green; `npm run build` clean (strict tsc); `npm run typecheck` clean.**

Vitest tail:

```
 Test Files  2 passed (2)
      Tests  58 passed (58)
   Start at  00:35:51
   Duration  305ms (transform 243ms, setup 300ms, import 312ms, tests 30ms)
```

Source: `/Users/tongtao/code/sliceagent` @ tape-graduation-w1 (read-only, untouched).
No commits made in this repo; everything is uncommitted on `port/slice-engine` for the owner to integrate.

## 1. File map

| file | lines | contents |
|---|---|---|
| `src/slice/types.ts` | 339 | enums (InstructionClass/FreshnessClass/EpistemicRole/ResourceKind/Fidelity/RepresentationLoss/PressureLevel), ResourceRef/SourceRef/reservedResourceRef, ContextBlock (incl. __post_init__ validations), ContextSelection, ElasticityController |
| `src/slice/regions.ts` | 966 | all 19 REGIONS + renderers, REGION_ORDER/_META/_ROLES, placement law (regionZone/contextBlock/assertPlacementLaw), locator alternatives, source-needs + graph-trim gates, provenance, buildContextBlocks, renderContextSelection, renderRegions, renderCurrentRequest/renderNow |
| `src/slice/tape.ts` | 514 | TapeEntry, base/patch/external/reply/reasoning/finding/knowledge/digest entries + renderers, unifiedPatch/applyUnified/composeAfter, canonicalText/findingHash/knowledgeHash, compactTape (GC + epoch fold), reconcileTapeWithDigests |
| `src/slice/state.ts` | 353 | SliceState/SliceCtx/TurnContract types + JSON normalization (mirrors gen_goldens.build_ctx exactly) |
| `src/slice/compiler.ts` | 55 | assembleSlice (the make_build_slice splice shape) + renderRegions re-export |
| `src/slice/buildSlice.ts` | 94 | SeedPlan (fixedUserChars/project/nextTighterCapacity) |
| `src/slice/index.ts` | 40 | public API |
| `src/slice/internal/difflib.ts` | 221 | CPython 3.11 difflib port: SequenceMatcher (autojunk purge included), get_grouped_opcodes, unified_diff |
| `src/slice/internal/safety.ts` | 206 | wrapUntrusted, redactText (all 10 passes) |
| `src/slice/internal/pytext.ts` | 141 | Python semantics: pylen/pyslice/pySplitlines (full boundary set)/pyStrip/pyRepr/pySortStrings/pyBool |
| `src/slice/internal/errors.ts` | 40 | ValueError/PyTypeError/ContextUnfitError with Python class names |
| `src/slice/internal/placement.ts` | 18 | zone-resolver registry (breaks the ContextBlock↔regions cycle like Python's lazy import) |
| `src/slice/internal/textUtils.ts` | 15 | normalizeWs/oneLine |
| `src/index.ts` | 4 | package entry (package.json main was lib/index.js) |
| `tests/golden/cases.json` | 547 | 44 shared fixtures (read by BOTH sides) |
| `tests/golden/gen_goldens.py` | 340 | Python generator → expected.json (npm run goldens) |
| `tests/golden/expected.json` | (gen) | authoritative outputs |
| `tests/golden/harness.ts` | ~330 | TS mirror of the generator construction |
| `tests/parity.test.ts` | 24 | 44 byte-equality assertions |
| `tests/unit.test.ts` | 179 | ported registry/elasticity/tape unit semantics |

## 2. Parity results

44/44 golden cases byte-identical, covering: empty ctx; intent family (incl. provisional + superseded-span objective); ground-truth regions; frozen memory/finding suppression (incl. cross-task scoping); full session tape (8 entry kinds); my-state regions; live tail; turn-contract (mechanical suppression + rich); source-needs sealed selection; elasticity pressure→locator degradation; mandatory unfit; assemble (basic + hints + capacity); tape render/diff (multihunk + >200-line autojunk)/compose (no-trailing-newline)/compact (fold-reanchor, GC, under-budget); 13 elasticity/placement unit cases; 3 SeedPlan projection cases. Plus 14 ported unit tests (registry snapshot, placement seams, elasticity semantics, tape round-trips).

## 3. Semantic corners and choices

- **open_files never suppresses**: its lambda unconditionally returns header+artifacts, so an "empty" ctx still renders the OPEN FILES header (the goldens capture this; production always passes "(no open files)").
- **Dict referents vs typed referents**: Python `getattr(ref, "anchor", None)` is None for a *dict*, so the sealed-anchor branch and the turn_contract locator handles are unreachable for dict referents (production uses typed objects). Ported with exactly that semantics; the anchor branch is documented dead code on the JSON ctx surface.
- **Code points, not UTF-16**: every Python len()/slice went through pylen/pyslice (emoji-safe); sorting compares code points.
- **`sorted(reverse=True)` stability**: preserved via descending comparator + JS stable sort (never reversed iteration).
- **Dict insertion order** → Map everywhere (groups, slots, world, JSON).
- **Error strings**: Python `!r` → pyRepr (single→double quote switch rule); `str(bool)` → "True"/"False"; error class names carried as `pyName` so golden error text matches `f"{type(exc).__name__}: {exc}"`.
- **sha256 input encoding**: Python `encode("utf-8","replace")` emits `?` for lone surrogates; Node emits U+FFFD. Diverges only on lone-surrogate text; fixtures avoid it.
- **splitlines**: Python's wider line-boundary set (\v \f \x1c-\x1e \x85 \u2028\u2029) ported in pySplitlines (affects base-entry line counts and diff input).
- **UNFIT pressure** is unreachable through select() (the loop exits at ≤ capacity or raises) — same as Python.
- **Active-work graph trim**: context_compiler.py is not ported (golden path never activates the graph). The engine *throws loudly* on a non-empty activeWork rather than silently skipping the trim.

## 4. Deliberately not ported

- **Tape durability**: tape_journal_append/load_session_tape/journal_registries/hydrate_session_tape (filesystem I/O, host concern); compactTape/reconcileTapeWithDigests pure logic IS ported.
- **tape_seal_update / TapeRecorder** (host tool-event integration), render_turn_digest (spine).
- **context_compiler.py** Active Work projection (not required by the render_regions golden path).
- **Loop-time reducers**: record_note/record_action/observe/action_sig/code_ops/is_done_claim/is_user_report/report_retracted/capture_user_report (not render path).
- **Seed/host producers**: render_focus/render_threads/render_requirements/reserve_keep, make_build_slice's host I/O (tools/git/repo-map/PageTable/SubdirHints/frozen locator snapshots) — the byte-stable prefix + NOW footer splice shape is in compiler.assembleSlice + SeedPlan.
- **safety write-path**: scan_for_threats/first_threat_message/is_safe_to_persist; redact preserve_length mode.
- **tool_identity.canonical_tool_args** (only record_action uses it); text_utils now_iso/format_ts/is_chitchat.
- **loop.py run_turn** (explicitly out of scope).

## 5. Deviations from the requested layout

- `RegionSpec` lives in `regions.ts` (not types.ts) — its render signature needs the SliceCtx type.
- Added `src/slice/state.ts` (ctx/state model + normalization) and `src/slice/internal/` (six helper modules the layout didn't name).
- Added `src/index.ts` — package.json `main` was `lib/index.js`, which otherwise wouldn't exist.
- `package.json`: `test` now runs vitest; `typecheck` keeps the old tsc gate (`tsconfig.test.json` covers src+tests); added `goldens` script to regenerate expected.json.
- Only new dependency: dev `vitest` (installed with --legacy-peer-deps because the @deepseek-ai/* peerDeps are unpublished).
