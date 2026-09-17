# T10 verification — independent review of the improvement-plan artifact

- **Task:** `task_draft_start_6dc29acf-0a7a-41fc-b229-ee6f1cd9bf19_T10_verify_plan` (attempt `attempt_e4be60bc-d766-4f3b-9a50-fa465f3f09a1`), `reviewOf` = `task_draft_start_6dc29acf-0a7a-41fc-b229-ee6f1cd9bf19_T9_synthesis_plan`.
- **Reviewed artifact (read from the commit):** `41e8a2adeb574b151609c5bec9d31f341a66c368`, file `docs/reviews/swarm-2026-09-improvement-plan.md` (154 lines), base snapshot `62db5ce2f94be74a6bdca2c1376d9e02112fe95f`. In my checkout `git diff --stat 62db5ce2 41e8a2ad -- src tests scripts` is empty, so every `src`/`tests`/`scripts` anchor below was checked against the snapshot itself.
- **Method:** read the roadmap from its artifact commit, then re-derived the anchors and numbers with this attempt's own read-only commands (§6). Nothing below repeats the roadmap's prose as evidence.
- **Zero source changes / deliverable note:** the only new path is this report. The declared check `git status --porcelain -- src tests scripts docs package.json tsconfig.json vitest.config.ts` therefore lists exactly `?? docs/reviews/swarm-2026-09-verify-plan.md` (workers cannot write git metadata, so an untracked deliverable is expected, not a tracked-file modification).

## Verdict: ACCEPT, with 4 mandatory corrections

All P0/P1 premises reproduce on the snapshot; the four dimensions are present; both cross-audit adjudications are correct; no verification-refuted item is carried as a live fix. The corrections are anchor/wording/quantity errors that do not change any decision, but they must be fixed before the roadmap is cited downstream.

## 1. Spot-check table (30 anchors, more than the required 20)

| # | roadmap anchor / claim | snapshot check (this attempt) | verdict |
|---|---|---|---|
| 1 | `src/index.ts:180` seal only at `step === 1` | line is exactly `if (step === 1) sealCompletedTurns(...)` | matches |
| 2 | `src/context.ts:471` entries frozen (`sealedEntry`) | `ours(node.event) && !node.superseded` | matches |
| 3 | `src/context.ts:523-527` in-place span replace | `applySeal` appends with `surfaceOp: { op:'replace', start, end }` + `sourceEventSeqs` | matches |
| 4 | `src/context.ts:411,431` `entryMaxChars` is a target | `:411` comment "a target …", `:431` `if (Array.from(text).length <= maxChars) return text` | matches |
| 5 | `src/context.ts:378-387` `readIndexLine` has no byte cap | slices by `READ_INDEX_PER_TURN` (10) only | matches |
| 6 | `src/context.ts:76-78` `chars()` uses `Array.from(JSON.stringify(...))` | exact | matches |
| 7 | `src/context.ts:515` `measure = view(plan)` | exact; `index.ts:180` drops the return (T3-W1) | matches |
| 8 | `src/context.ts:542` `requestChars` | exported, no caller in `src/`/`tests/` | matches |
| 9 | `src/context.ts:289-312,415` whole-log rescan per seal | `readHistory` walks `snapshotEvents()`; `renderCheckpoint` calls it unconditionally | matches |
| 10 | `src/context.ts:277` sha256 per read digest | `createHash('sha256')…` | matches |
| 11 | `src/index.ts:167,180` seal runs in the synchronous `agent/pre-step` | exact | matches |
| 12 | `src/context.ts:232` `own` predicate (append + user + all-text) | exact | matches |
| 13 | `src/context.ts:221-238` live snapshot protected, superseded archivable | exact block | matches |
| 14 | `src/context.ts:507` run condition `!protected && turns[1] < before && !sealedEntry` | exact | matches |
| 15 | `src/context.ts:476,514` per-call `cuts` map + warn | exact | matches |
| 16 | `src/context.ts:327` `if (!node.message) continue` (§1 P1-5, §2 P1-7) | **line 327 is `else if (event.type === 'assistant/message')`**; the statement is at **`:325`** | **anchor wrong (off by 2)** |
| 17 | `src/context.ts:395` `if (item.reply) lines.push(...)` (§1 P1-5) | the reply push is at **`:399`**; `:394-395` is the users `forEach` | **anchor wrong (off by 4)** |
| 18 | `src/context.ts:390` 170-char entry header | template present; my T5-rebuild probe measured the rendered header at exactly 170 code points | matches |
| 19 | `src/recall.ts:200` default `view:'full'` + `:581` scope default `auto` | `opts?.view ?? 'full'`; `a.scope === 'dialogue' ? 'dialogue' : 'auto'` | matches |
| 20 | `src/recall.ts:556-560` schema says `"auto" (default)` | exact, incl. "dialogue kinds plus bounded raw tool output" | matches |
| 21 | `src/recall.ts:138-141` `ownerOf` returns null with no open turn and non-plugin source | exact | matches |
| 22 | §5.13 default `recall_search` can serve `tool_output` | `resolveSearchKinds` (`:360-363`) adds `tool_output` when `scope==='auto'`; the tool passes `scope` (`:583-586`). Probe: module default `(none)`, `scope:'auto'` → `tool_output@t1` | matches (adjudication correct) |
| 23 | `src/fold/index.ts:68` `FOLD_BODY` "every structured line" | exact | matches |
| 24 | `src/fold/index.ts:138-167` fold is open-turn only | `fold()` iterates `cursor..session.seq` and folds only surface-append results | matches |
| 25 | `src/observations/files.ts:97,99-100` `content[0]` + `block.toolCallId` | exact (`surfaceOp === 'append'`, `content[0]`, `block.toolCallId`) | matches |
| 26 | `src/slice/result-digest.ts:31-33,189-208` structured-block cap + key novelty | exact | matches |
| 27 | `README.md:83` retired `[slice checkpoint v1 …]`/`# SESSION TAPE` still parse | the sentence is at **`README.md:75`** | **anchor wrong (off by 8)** |
| 28 | `CONTEXT.md:3,5-8,13,16-17,26-30` describe the retired pressure-archive law | all seven sampled lines describe high/low water, `planArchive`/`applyArchive`/`archiveUnderPressure`, `maxRequestChars`, `SliceBudgetError`; file is 7,491 bytes; `grep -rc 'planArchive\|applyArchive\|archiveUnderPressure\|SliceBudgetError' src lib` = 0 hits | matches |
| 29 | `scripts/validation/packed-profile.patch.yml:48-51` retired keys; `packed-runner.mjs:64-66` asserts `[slice checkpoint v1`; `CHECKPOINT_PREFIX` has no emitter; `ci.yml:38-39` | fixture sets `highWaterChars/lowWaterChars/keepRecentChars`; runner asserts the legacy prefix; `grep -rn CHECKPOINT_PREFIX src lib scripts tests` has no non-declaration hit; `tests/config-keys.spec.ts:57-58` proves the load-time throw "Retired history configuration highWaterChars" | matches |
| 30 | `package.json:24-29,36,97-99`; `tsconfig.json:21-23`; `tsconfig.scripts.json:11-15`; `ci.yml:20-21,33-43`; `compat.yml:31,36-37,47-50` | files/exports/engines/scripts exact; `.mjs` count = 7 and `tsconfig.scripts.json` includes only `.mts/.ts`; build program has 0 `src/lab` files, test program has 7; CI matrix `['22.22.3','24.x']`, `git diff --exit-code -- lib`, `verify:packed`, `check:size`; compat has no peer-range assertion | matches |
| 31 | `tests/context-policy.spec.ts:406-418` existing cap test uses short read paths | the test asserts `<= 3_000` with `toolTurn(..., 'x'.repeat(200))` and `arguments '{}'` → no read-index line, so the read path is indeed untested | matches |
| 32 | `tests/mock-adapter.ts:15,32` helpers unused | `errorResponse`/`multiToolCallResponse` appear only at their definitions | matches |
| 33 | `tests/result-digest-longline.spec.ts:7` `Math.random` seed | exact | matches |
| 34 | `pnpm-workspace.yaml:5` `minimumReleaseAgeExclude` without `minimumReleaseAge` | exact | matches |
| 35 | `plan/SEAMS.md:12-14` banner names the retired law as current | lines 12-14 are the `planArchive`/`archiveUnderPressure` parenthetical | matches |
| 36 | T8-corrected HH-9 (`P2-4`): 12/25 unreachable, 38,363 B, `internal/*` reachable | my own import-graph walk of `lib/` (non-lab, 18 `.js`, 213,763 B total) gives 6 unreachable `.js` = 38,606 B; excluding `lib/invariant.js` (a published `./invariant` export) = **38,363 B = 17.9%** — byte-identical to the roadmap. `src/slice/internal/*` is imported by `src/slice/tape.ts:8-11`, which `src/context.ts:28` imports → reachable | matches |
| 37 | Baseline "27 files / 219 tests" | my full run with the repo's include set (`tests/**/*.{spec,test}.ts`) → **27 files / 219 tests passed**. (First attempt with `*.spec.ts` only gave 26/201; `tests/unit.test.ts` is the omitted file — the roadmap's number is the correct one.) | matches |
| 38 | `results/` 57.43 of 58.90 MiB (97.5%) | `node scripts/check-repo-size.mjs` → tracked 58.93 MiB / 983 files, `results/` 57.43 MiB; exact split: results 97.5%, non-results 1.50 MiB | matches (total drifted +0.03 MiB since T9) |
| 39 | `P2-8` "打包载荷 ≈14.9 MiB，不是 58.9 MiB" | non-`results/` tracked bytes = **1.50 MiB**, not 14.9 | **quantity wrong (~10×)** |

## 2. Mandatory corrections

1. **`src/context.ts:327` → `:325`** (§1 P1-5 row and §2 P1-7 row): the line cited for `if (!node.message) continue` is the `assistant/message` branch; the guard is at `:325`.
2. **`src/context.ts:395` → `:399`** (§1 P1-5 row): the reply push is at `:399`; `:394-395` is the users loop.
3. **`README.md:83` → `README.md:75`** (§5.9): that is where the legacy-record compatibility sentence lives.
4. **`P2-8` "≈14.9 MiB" → "≈1.50 MiB"** (or delete the figure): measured non-`results/` tracked bytes are 1.50 MiB of the 58.93 MiB total.
5. **`P0-3` wording** ("静默内容丢失"): the mechanism is real but the wording overstates it. My probe (`run_7ebf8f17`) on an ownerless `user/message` appended between two completed turns: after sealing, the message is off the surface, **its text is still rendered inside the sealed entry** (`orphan text in derived view = true | inside a sealed entry = true`), `recall_turn(1)`/`recall_turn(2)` do **not** serve it, and search finds it with neither default nor `scope:'auto'`. So the precise statement is "survives only inside the entry that absorbed it and has no recall page; if that entry is later compacted or the verbatim text is needed, it is unrecoverable" — which still justifies the guardrail (`ownerOf`-based protection), but it is not content that vanishes at seal time.

## 3. The two flagged adjudications, checked independently

- **T5-rebuild correction of `recall_search` (roadmap §5.13)** — correct. `resolveSearchKinds` adds `tool_output` when `scope === 'auto'` (`src/recall.ts:360-363`), the tool defaults `scope` to `'auto'` (`:581`), the schema documents `"auto" (default)` (`:556-560`), and the tool passes `scope` through to `searchSessionEvents` (`:583-586`). Probe on a sealed log: module default `(none)`, `scope:'auto'` → `tool_output@t1`, `scope:'dialogue'` → `(none)`, explicit `kinds:['tool_output']` → `tool_output@t1`. So T1-F7's proposed fix (and the claim that the default search cannot serve tool output) is correctly dropped/refuted; my own context/tape F7 measured the *module* default and must not be re-quoted as the tool's behavior.
- **T8 correction of T4 HH-9 (roadmap §5.14, P2-4)** — numerically confirmed to the byte: 38,363 B unreachable of 213,763 B shipped (17.9%), and `src/slice/internal/{difflib,errors,pytext,safety}.ts` reachable through `src/slice/tape.ts:8-11`. Convention note for the 12/25 module count: it counts `src` modules including `src/lab/**` and treats `lib/invariant.js` as reachable through the `./invariant` export; under that convention 12 unreachable is right (my `lib`-only walk sees 6 unreachable `.js` plus the 6 lab modules that are not shipped).

## 4. Remaining acceptance checks

- **No refuted item carried as a live fix:** the three verifications (T6-replacement, T7, T5-rebuild) all ended `accept`; the roadmap carries their two hard corrections into §5.13/§5.14 and the `F7 partly refuted` note, and no refuted claim (e.g. "default recall_search cannot serve tool_output", "internal/* deletable", HH-9's original figures) survives as an action item. Verified against the corrections themselves, not against the roadmap's summary.
- **Four dimensions present:** context/tape (§0, P0-3/P0-4, P1-5, P1-7, P1-9, §4, §5), recall/fold (P1-1, P1-6, P2-6, P2-7), token/cache (§0.4-0.6, §3, §4, P1-10, P2-1/P2-2), repo hygiene (P0-1, P0-2, P1-2/P1-3/P1-4/P1-8, P2-4/P2-5/P2-8…P2-13).
- **MEASURED/INFERRED honesty:** the roadmap separates `本任务` (its own run ids) from `转述` (accepted audits/verifications) and marks magnitudes it did not re-run. Sampled rows are consistent: anchor-verified rows are labelled static re-checks, and the large magnitudes (59,577-char worst entry, 58,755 vs 460 chars, scan timings) are explicitly `转述`. The only honesty defect found is the mis-cited `:327/:395` lines behind a claim of "我实测" — the claim itself is right, the anchor is not.
- **Executability of the verification methods:** §6's gates are real commands, and the four that already exist run green in this checkout (`npm run typecheck`-equivalent programs, `npm test` = 27/219, `check:size` = 58.93/64 MiB, `git status -- lib` clean); `verify:packed` is correctly described as currently failing by construction (retired fixture keys throw at load — proven by `tests/config-keys.spec.ts:57-58` — and the runner asserts an unemitted `[slice checkpoint v1`). The three proposed gates (`check-doc-anchors.mjs`, `check-peer-range.mjs`, `test:coverage`) are labelled as new work, not as existing.

## 5. Verdict and residual risk

**ACCEPT.** With corrections 1–5 applied, the roadmap is a faithful, actionable synthesis: every P0/P1 conclusion I checked reproduces on `62db5ce2`, the two adjudications are right, and the token/cache estimates carry口径 (bytes per event/round, full-price vs cached). Residual risk after the corrections: (a) the `P0-4` worst-case figure (59,577 chars) remains a `转述` from the deep review and should be re-measured before being used as a release blocker; (b) `P2-8`'s payload figure must not be quoted in its current form.

## 6. Evidence index (this attempt) and declared checks

| what | command | run id |
|---|---|---|
| roadmap read from artifact commit | `git show 41e8a2ad:docs/reviews/swarm-2026-09-improvement-plan.md` | `run_542e5534`, `run_041a8253` |
| source anchors (44 specs, line-by-line) | `sed -n` on `src/recall.ts`, `src/context.ts`, `src/index.ts`, `src/fold/index.ts`, `src/observations/files.ts`, `src/slice/*` | `run_7fb92fd5`, `run_77d591a0` |
| config/CI/doc anchors + retired symbols + helpers | `sed -n` on `package.json`, `tsconfig*.json`, `.github/workflows/*.yml`, `pnpm-workspace.yaml`, `plan/SEAMS.md`, `CONTEXT.md`, `README.md`; `grep`/`wc` | `run_da7e2e76`, `run_f23b3ef1` |
| lib reachability / bytes | node import-graph walk over `lib/**/*.js` | `run_232c9e7d` |
| `src/lab` build vs test program | `tsc -p tsconfig.json --listFilesOnly`, `tsc -p tsconfig.test.json --listFilesOnly` | `run_aa11ce45` |
| `recall_search` scope adjudication | `resolveSearchKinds` read + probe (`module default / scope auto / scope dialogue / explicit kinds`) | `run_ea9a74b5`, `run_c64d1e3f` |
| ownerless user message probe | synthetic session + `renderSealedTurn`/`searchSessionEvents` | `run_7ebf8f17` |
| full test baseline | `vitest run` with the repo's include set | `run_01428583` (27/219; narrower `*.spec.ts`-only run `run_6bddfcdf` = 26/201) |
| repo size / payload split | `node scripts/check-repo-size.mjs` + exact byte sum | `run_3b285dfe`, `run_3325cce4` |

Declared checks: `git status --porcelain -- src tests scripts docs package.json tsconfig.json vitest.config.ts` → only `?? docs/reviews/swarm-2026-09-verify-plan.md` (the expected untracked deliverable; git metadata is not writable from the sandbox); `node --version` → v22.22.3; HEAD `41e8a2ad` with `src/tests/scripts` identical to snapshot `62db5ce2`. No tracked source/test/script/config file was modified; the temporary probes and the `node_modules` symlink were removed before submission.
