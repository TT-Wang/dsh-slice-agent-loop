# Experiment plan 2026-09: five directions on the native slice policy

> ⚠️ **Status as of 2026-09-10: NOT EXECUTED. Nothing in this plan was run;
> treat it as an unstarted design, not as evidence.** Verified in this
> repository:
> - All five boxes in §6 "Deliverables checklist" are still unchecked.
> - No results directory exists for any direction — the archive stops at
>   `results/20260904-*`, and `ls results | grep -E '2026090[5-9]'` is empty, so
>   the required `results/202609xx-d{3,4,5,2}/` were never created.
> - The two delivery scripts the plan depends on do not exist here:
>   `scripts/session-metrics.py` and `scripts/aggregate-cells.py` are absent
>   from `scripts/`.
> - The plan is **not runnable from this repository** even if someone wanted to:
>   §0 and §1 point at absolute paths in a maintainer-only workspace
>   (`/Users/tongtao/Documents/kimi/workspace/dsh-slice/...`,
>   `~/.dsh/profiles/<arm-profile>`) and at
>   `/Users/tongtao/code/dsh-tool-result-fold/bench/scenarios`. None of these
>   exist inside the checkout. Reproducing it requires that external workspace.
>
> **Historical configuration:** `maxHistoryChars` and `maxRequestChars` are now
> rejected at load (2026-09-21); the pressure/admission design below is retired.
> Defaults for effort and position pinning, and the scope of fold backoff, have also
> changed. This table is not a current profile template.
> The old-architecture comparison boundary in §5 still applies.
>
> **Archive status:** this file is tracked as an unexecuted historical plan. Its
> earlier "untracked on main" note described the working copy before archival.
> See `CONTEXT.md` for the current policy; do not execute the profiles below as-is.

Original plan follows unchanged.

---

Status: phase 1 (direction 1) is scheduled; this document fixes phase 2 (directions 3, 4, 5, 2) so it can
be run without further design. Architecture under test: `dsh-slice-agent-loop@main` (merged 2026-09-08) as
a context POLICY on DSH's stock agent-loop — `compactHistory` seals completed spans into one `# SESSION TAPE`
user message (user text verbatim, replies cut to head 1400 / tail 500 of a 2000-char cap, tool output only
via recall), admission drops oldest turn groups with recall markers above `maxHistoryChars`, and
`tool-result-fold` folds large tool results in-turn.

## 0. Held fixed in every cell

| Item | Value |
|---|---|
| Model / pricing | deepseek-v4-flash; $ = freshIn×0.22 + cacheIn×0.007 + out×0.66 per M (`H2H_PRICE_*`, off-peak table); token counts are the ground truth, price is recomputable |
| Driver | `/Users/tongtao/Documents/kimi/workspace/dsh-slice/scripts/dsh-h2h.mjs <scenario> slice` with `H2H_BASE_SLICE=http://127.0.0.1:<port>`, `H2H_TOKEN_SLICE=<token from sidecar log "dsh web: ...?token=">`, `H2H_SCENARIOS_DIR=<dir>`, `RUN_TAG=<yyyymmdd>-<dir>-<arm>-r<k>`; one invocation = one arm × one scenario × one rep; results land in `dsh-slice/results/<RUN_TAG>-<scenario>-slice.json` |
| Sidecars | one dsh process per arm: `--profile <arm-profile> --patch ~/.dsh/profiles/<arm-profile>/port-<port>.patch.yml --no-open`; each arm profile is a copy of `~/.dsh/profiles/slice-ts` (bundles dsh-base + dsh-web-app + dsh-eval-request-tap; `compact-basic`/`compaction-basic`/`command-compact` disabled) differing only in the plugin `config:` block |
| Ports | 3082/3083 are the running phase-1 A/B: never touched. Phase 2 uses 3087–3089. Pre-flight: `lsof -nP -iTCP:<port> -sTCP:LISTEN` must be empty. NOTE: at plan time 3084 is listening as `--profile sovereign` (pid 4901); the phase-1 port map (stock-nocompact=3084) must be confirmed or moved before launch |
| Plugin baseline (`both`) | `maxHistoryChars: 120000`, `maxRequestChars: 400000`, `maxStepsPerTurn: 250`, `defaultReasoningEffort: low`, fold default (`pinSteps 2`, `pinMaxChars 8000`, `backoffAfterExpansions 2`, `spillPreviewMinBytes 50000`), digest = `DEFAULT_DIGEST_POLICY` |
| Scheduling | arms run serially (cross-arm cache crowding was observed in the effort ladder); reps interleaved by arm (r1 for all arms, then r2, then r3) inside one day so all arms share the same provider weather |
| Telemetry | `SLICE_CALL_LEDGER_DIR=results/sidecars` on every plugin arm (per-call `norm.input/cacheRead/output/reasoning` + per-turn seed bytes for `scripts/attribute-miss.mts`); `EVAL_TAP_FILE` on stock arms |
| Validity gates | a run is INVALID (excluded, re-run) if: driver reports `FAILED-RUN`; stock-default shows 0 `compact/start` events; stock-nocompact shows ≥1; a plugin arm's first call does not carry the intended `reasoningEffort` (D5); `SliceBudgetError` raised |

## 1. Shared metrics (one extractor, one row per session)

Deliverable `dsh-slice/scripts/session-metrics.py <session.jsonl.zstd> [--ledger <calls.jsonl>] [--scenario-dir d]`
(system `python3`, `zstandard`; extends `behavior-metrics.py`). Fields:

| Field | Source / definition |
|---|---|
| `pass`, `verify_msg` | driver verdict (`[ok,msg]`, bool, or `{ok}`) |
| `constraint_ok` | scenario-declared sub-check parsed from `verify_msg` (e.g. n1 `CANNOT-RECOVER`, s5 `reason` parameter); `null` when the scenario has none |
| `cost_usd`, `fresh_in`, `cache_in`, `out` | sums over `assistant/message.usage` (inputTokens = miss, cacheReadTokens = hit) |
| `wall_s`, `steps` | driver `wallMs`; count of `step/start` |
| `miss_step1`, `hit_step1`, `miss_later`, `hit_later` | same usage split by `data.step == 1` vs `> 1` (turn-boundary miss vs in-turn miss) |
| `reasoning_step1`, `reasoning_later` | `norm.reasoning` from the call ledger (plugin arms); provider `reasoning_tokens` in usage when present (stock arms), else `null` |
| `recall_calls` = {`recall_turn`,`recall_search`,`recall_step`,`expand_result`} | tool-call names in `assistant/message` content, per session and per turn |
| `calls_to_find` | per recall-probe turn: recall_* calls issued before the correct value is first written (`∞` if never) |
| `guessed` / `denied` / `stale` | probe turn wrote a wrong value with zero recall calls / wrote `CANNOT-RECOVER` although the fact is in the log (always true by construction) / wrote the superseded value (r2d) |
| `folded`, `expanded`, `repeat_expand`, `critical_kept` | `tool/result` events with `surfaceOp.replace start==end`; `expand_result` calls; same `(turn,step,call)` expanded ≥2; folded views that still contain the scenario's `critical_patterns` (add to `meta.json` of D4 scenarios) |
| `reads_after_own_edit`, `retests` | `behavior-metrics.py` proxy; identical bash test command repeated within a turn |
| `false_complete` | last assistant text of the final turn claims completion (done/完成/PASS marker list) while `pass == false` |

Aggregation: `scripts/aggregate-cells.py` → per cell: pass count, median/min/max of each numeric field, and paired
per-rep deltas versus the cell's baseline arm (same scenario, same rep index).

## 2. Phase 1 (scheduled): direction 1 — what the new composition buys

First batch 6–8 tasks × 5 arms × 3 reps. Arms: `stock-default` 3082 (stock loop, host compaction re-enabled and
calibrated as in `~/.dsh/profiles/web/eval-3082-compact.patch.yml`), `stock-nocompact` 3084 (compaction ids
disabled, nothing else), `fold-only` 3085 (standalone `dsh-tool-result-fold` on the stock loop, same source as
`src/fold`), `history-only` 3086 (this plugin with `fold: { enabled: false }` — note `expand_result` stays
registered but nothing is folded), `both` 3083 (plugin baseline above). Tasks: n1, h2, s5_standing_constraints,
s13_compact_amnesia, s15b_toolresult_amnesia, s1_longhorizon_debug (+ s4, s10 if time). Metrics: full row.
Decision rule: a component (fold, history) is "paying for itself" if its arm is not worse on pass count than
`stock-nocompact` and is ≥15 % cheaper in ≥2 of 3 paired reps; `both` must dominate each single component on
pass count to justify the default composition. Phase 2 baseline = `both` unless phase 1 shows `history-only`
or `fold-only` strictly dominating, in which case phase 2 rebases on that arm and the plan is re-cut.

## 3. Phase 2

### 3.1 Direction 3 — replacement timing (config knobs to add to `src/context.ts` / `src/index.ts`)

Current behaviour: `SliceLoopPlugin` calls `compactHistory(agent.session, history)` in `agent/pre-step` when
`step === 1`; inside, every conversational surface node with `seq < completedThrough` (or an existing tape,
`ours(event)`) joins a span and the whole span is replaced by one tape every turn.

Config (new key `history`, add `'history'` to the `allowed` set in `src/index.ts`):

```ts
history?: {
  trigger?: 'every-turn' | 'over-budget'   // default 'every-turn'  (= current)
  keepRecentTurns?: number                 // default 0             (= current)
  batchTurns?: number                      // default 1             (= current)
  evidenceIndex?: boolean                  // default false; direction 2, see 3.4
}
// compactHistory(session, maxHistoryChars, policy: Required<HistoryPolicy>)
```

Seams inside `compactHistory` (all three knobs reduce to the current code at their defaults):

1. Span selection (line 88, `for (const seq of session.surface.nodes)`): the `turns` map already gives
   `seq → turn`; let `latest` = last `turn/start` seen. Replace the condition with
   `conversational(event) && (ours(event) || (seq < completedThrough && turns.get(seq)! <= latest - 1 - keepRecentTurns))`.
   Turns newer than the cutoff stay raw on the surface (their tool results included; they are outside admission,
   so `assertRequestBudget` is the only bound — a gate, see caveats).
2. Trigger/batching (after `flush()`, before building entries, per span): let
   `rawNodes = span.nodes.filter(s => !ours(session.eventAt(s)!))`, `rawTurns = new Set(rawNodes.map(s => turns.get(s)))`,
   `rawChars = Σ Array.from(textOf(deriveEventMessage(e))).length` over rawNodes (tool results counted).
   Skip the span (leave the surface untouched) when `rawTurns.size > 0 && rawTurns.size < batchTurns`, or when
   `trigger === 'over-budget' && rawChars <= maxHistoryChars`. The existing identical-text short-circuit
   (`span.nodes.length === 1 && ours(existing)`) already handles "nothing new".
3. Rendering is unchanged; `perSpan` budget and `admitTape` still apply to whatever is sealed.
   Miss attribution keeps working because the tape is still one plugin user message.

Arms (everything else = `both` baseline; effort low; fold default):

| Arm | Config | Predicted mechanism |
|---|---|---|
| T0 every-turn (current) | defaults | tape tail grows each turn: miss = new entry + current turn |
| T1 over-budget | `trigger: 'over-budget'` | raw turns append (pure prefix hits) until 120 k raw chars, then one big reseal |
| T2 keep-recent + batch | `keepRecentTurns: 3, batchTurns: 3` | last 3 turns raw with tool output; tape rewritten every 3rd turn |
| T3 (only if T2 wins) | `keepRecentTurns: 3, batchTurns: 1` | separates the K effect from the B effect |

Scenarios: n1, h2, s13, s10_compactloss (long enough to trigger reseals). Metrics: `miss_step1`/`hit_step1`
(turn-boundary miss), `reasoning_step1`, `recall_calls`, `cost_usd`, `pass`, plus `attribute-miss` verdicts per
turn boundary. Decision: replace the default when the variant's `cost_usd` ≤ 0.85 × T0 in ≥2 of 3 paired reps,
pass count ≥ T0, and median `recall_calls` ≤ T0 + 1; otherwise keep `every-turn`. n = 3 screening; the winning
knob set goes to n = 8 on the same four scenarios before becoming the shipped default.

### 3.2 Direction 4 — fold content routing (fold/digest config sets)

`digest` validation rejects `Infinity` for integer fields, so "never fold this kind" is expressed with `1e9`.

| Arm | `fold` / `digest` config |
|---|---|
| F0 none | `fold: { enabled: false }` |
| F1 logs only | `digest: { minChars: 1000000000, searchMinChars: 1000000000, searchMinMatches: 1000000000, jsonMinItems: 1000000000, diffMinLines: 1000000000 }` (log route keeps `logMinChars 512`, `logMaxErrors 10`, `logContextLines 3`); `fold.spillPreviewMinBytes: 0` |
| F2 logs + docs/data routing (current default) | `DEFAULT_DIGEST_POLICY`, fold defaults |

Scenarios (`H2H_SCENARIOS_DIR=/Users/tongtao/code/dsh-tool-result-fold/bench/scenarios`): f1_log_triage,
f3_test_suite_fix, f7_build_fix, f8_verbose_tests (log-shaped), f9_docs_research, f10_db_investigation
(doc/data-shaped); l1_chain_migrate/l2_ledger_state from `results/20260902-longturn-v2/scenarios-snapshot` only
if the arm profile mounts `fetch_page`/`db_query` (`src/lab/bench-tools.ts`) — otherwise drop them rather than run
them with shell tools. Add `critical_patterns` (regexes of the error/field lines the verifier depends on) to each
scenario's `meta.json`. Metrics: `critical_kept` rate (F0 is 100 % by construction), expand rate =
`expanded / folded`, `repeat_expand`, `pass`, `cost_usd`, `steps`, folded chars before/after (from the replaced
view sizes). Decision: F2 stays default unless F1 matches F2 on pass count and `cost_usd` within 5 % while
scoring higher `critical_kept`; F0 is the reference for what folding costs in quality — any F1/F2 pass loss
versus F0 on the same rep is a routing bug to fix, not a trade-off. n = 3; expand to n = 8 only for the arm pair
where the decision fires.

### 3.3 Direction 5 — reasoning effort as settings variants

Fixed policy = `both` + T0 + F2. Plugin arms: `defaultReasoningEffort: 'low'` (E-low, current factory default)
vs `'high'` (E-high) — injected only when nobody set effort explicitly (`applyEffortDefault`). Stock comparators
(from phase 1 sessions, not re-run) set effort through `agent-default-model.reasoningEffort` in the arm patch.
Validity gate: the ledger `call` line must record the effort sent (add `reasoningEffort` to `call-ledger.ts` in
phase 2; one field). Scenarios: n1, h2, s5, s1 (correctness-heavy) + f3, f7 (build/test loops). Metrics: `pass`,
`reasoning_step1` vs `reasoning_later`, `out`, `reads_after_own_edit`, `retests`, `false_complete`, `cost_usd`.
Decision: keep `low` unless E-high wins pass count by ≥2 tasks (of 6 × 3 reps, counting paired reps) or E-low
shows `false_complete` on any task in ≥2 reps; then flip the default and re-run direction 3 winners under it.

### 3.4 Direction 2 — recall under four information shapes

Scenarios (being authored; dir per scenario, `meta.json`/`prompts.json`/`setup.py`/`verify.py`, mirroring
`n1_verbatim_restore` and `h2_deep_recall_synthesis`: 12–16 turns, log-batch filler turns to build pressure,
`max_steps_per_turn 12`, verifier returns `[ok, msg]` with `CANNOT-RECOVER` handling and a `loss:` sub-check list):

| Scenario | Fact lives only in | What it discriminates |
|---|---|---|
| r2a_reply_mid | the middle of a >2000-char assistant reply (cut by head 1400 / tail 500) | model must notice `…[+N chars in sealed turn]…` and call `recall_turn` |
| r2b_tool_only | a tool result (script then deleted, as h2 turn 1/4) | `recall_search` default kinds exclude `tool_output`; needs `kinds:["tool_output"]`, `recall_step`, or `recall_turn` |
| r2c_early_constraint | a user constraint in turn 1–2, applied at turn ≥ 12 after admission has dropped the oldest group | verbatim user text survives only until admission omits its group with a marker |
| r2d_superseded_fact | a value stated, later overridden by the user; the ask must use the newer | stale-fact misuse; tape order vs recall order |

Answer-placement rule (lesson from the effort-ladder probe): the target value must not exist in any retained
channel (user text, reply head/tail, folded view head/tail); verify with a dry render before running.

Arms: R0 = `both` baseline (current recall tools + `<slice>` kernel hints); R1 = R0 + `history.evidenceIndex: true`.
Code seam for R1 (same `groups` loop in `compactHistory`): for each `tool/result` origin in a turn append one
line `[tool bash("python3 tools/gen_report.py") → 41 chars · recall_step({"turn":"1","step":"1"})]` (args preview
≤ 80 chars via `previewArgs` from `step-tape.ts`, at most 6 lines per turn, then `…+N more calls`). The index
is tape text, so it is counted by admission and rendered every turn; its char cost is a measured outcome.

Metrics: `calls_to_find` per probe, `guessed`, `denied`, `stale`, `recall_calls`, `pass`, `cost_usd`, tape
chars per turn (R1 − R0). Decision: adopt `evidenceIndex` if r2b median `calls_to_find` drops by ≥1 and
`guessed + denied` drops, with no regression on r2a/r2c/r2d pass count and `cost_usd` increase ≤ 5 %; otherwise
drop the knob (keep the code path off by default). n = 3 per scenario; expand to n = 8 for r2b and any scenario
where the two arms disagree on pass.

## 4. Run order, size, budget

1. Phase 1 completes and 3082/3083 are released → 2. D3 (T0–T2; T3 conditional) → 3. D4 → 4. D5 → 5. D2
(scenarios must pass a dry render first). Rebase later directions on any earlier winner (D3 winner becomes the
timing used in D4/D5/D2). Screening size: D3 3×4×3 = 36, D4 3×6×3 = 54, D5 2×6×3 = 36, D2 2×4×3 = 24 → 150 runs;
observed 12–16-turn runs take 10–40 min (phase-1 n1 turns ran 50–210 s each) → ≈ 60 h serial, ~8 working days,
$0.02–0.15 per run at v4-flash (≈ $10–20 total). Expansion to n = 8 adds ≤ 5 runs per winning cell-scenario.

## 5. Caveats (read before believing any table)

- n = 3 detects only large effects: a 3/3 vs 0/3 pass split or a ≥30 % cost gap seen in every paired rep.
  Anything smaller is "not distinguishable at this n"; the expansion to n = 8 is what makes a claim.
- Provider weather: latency, cache-eviction behaviour and off-peak pricing change within a day. Always report
  timestamps, interleave reps by arm, and compare paired reps, never cross-day medians. `wall_s` is weather-bound.
- Character budgets are not token budgets: `maxHistoryChars`/`maxRequestChars`/reply caps are code points;
  the CJK prompts and log filler tokenize at very different ratios. Report tokens; treat 120 k chars as a
  proxy that is re-derived per scenario, and use `attribute-miss` for the 64-token-block accounting.
- Old-architecture results (everything under `results/` before 2026-09-08, the loop-replacement driver, the Python
  sidecar arm, `docs/eval-report.md`) are archived and NOT comparable: different loop, tool schema, and
  compaction validity. The driver still labels the plugin arm `slice`; the RUN_TAG carries the real arm name.
- Direction 3 knobs put raw turns with full tool output outside admission: `assertRequestBudget` (400 k chars) is
  the only bound, so a `SliceBudgetError` in T1/T2 is a finding, not noise — record it and cap `keepRecentTurns`.
- `fold: { enabled: false }` still registers `expand_result`; `history-only`/F0 sessions with expand calls are a
  data error. `recall_search`'s tool-output exclusion means r2b measures the prompt affordance as much as the tool.
- Verifiers differ in strictness (n1 length ratio 0.85–1.25, h2 selective-copy check); `pass` is not comparable
  across scenarios, only across arms within a scenario.
- Nothing under `src/` changes before phase 1 ends; the D3/D2 knobs land behind defaults that reproduce current
  behaviour byte-for-byte, verified by the existing `native-context`/`tape-knobs` specs before any phase-2 run.

## 6. Deliverables checklist

- [ ] `scripts/session-metrics.py`, `scripts/aggregate-cells.py` (dsh-slice), both tested on one phase-1 session
- [ ] arm profiles `~/.dsh/profiles/slice-{t1,t2,f0,f1,ehigh,r1}` + `port-308{7,8,9}.patch.yml`, pre-flight `lsof`
- [ ] `history` knobs + `evidenceIndex` + ledger `reasoningEffort` field (phase 2 PR, defaults = current behaviour)
- [ ] r2a–r2d scenarios with dry-render check; `critical_patterns` in D4 scenario metas
- [ ] one results dir per direction: `results/202609xx-d{3,4,5,2}/` with the run log, cell table, and this plan's decision line filled in
