# dsh-slice-agent-loop

English | [中文](README.zh.md)

> **Every turn, hand the model exactly the context it needs. No more, no less.**

That sounds like common sense, but today's mainstream coding agents replay the
entire conversation history back to the model every call: the excess is never
trimmed, and what falls short can never be recovered. This plugin brings a
slice loop built around that one sentence into the
[DeepSeek Harness](https://github.com/dsh2026): **same harness, same model,
same tools and persistence — only the agent loop is swapped**, so in every
comparison below the loop itself is the only variable.

Early beta; tracks DSH `0.1.2-alpha.4` (`snapshotEvents`, typert `/api/<ns>/<method>` RPC with cookie auth; the bundled bench drivers speak the new protocol).

## One sentence, two constraints

| | Constraint | Transcript (full-history) status quo |
|---|---|---|
| **No more** | Context has an upper bound | Context grows to the window limit, then compacts; attention dilutes, the bill grows with every turn |
| **No less** | Information stays recoverable | After compaction, detail is gone and cannot be brought back |

Three structural problems of the transcript architecture: **A · Context rot** —
the longer the context, the less the model gets out of each item in it;
**B · compaction beheads the session** — summaries are lossy and irreversible,
the original text is nowhere; **C · cost grows quadratically with turns** —
every call resends the full history; cache discounts delay the blow-up but
cannot beat volume.

## The design: a tape, and recall

What the model sees each turn is not the conversation history but a working
slice rebuilt for that turn:

| Zone | Nature |
|---|---|
| system prompt · tool schemas | Frozen, byte-identical for the whole session (prefix-cache friendly) |
| **SESSION TAPE** | Append-only ledger of sealed turns: what was asked and done, file baselines with patches applied, replies |
| OPEN FILES | Currently open files, with sha256 anchors and edited markers |
| Current turn + tool observations | Appended within the turn — large tool results are **condensed at insertion** (see below) — sealed and archived at turn end |

The **tape** looks like a transcript — append-only, cache-friendly — but every
entry carries a hash and provenance. Long content is truncated at the cut with
an exact marker, and the full text stays durable in the session log.

**Recall** is how "no less" is honored, in three tiers: `recall_search` finds
which turn said something (scored search, tool-output flood excluded by
default), `recall_turn` returns that turn verbatim, and `recall_step(turn, step)`
returns one tool result in full when its condensed view is not enough. The tape
and every condensed view leave a signpost at the cut pointing back to the original.

| Transcript's problem | This plugin's answer |
|---|---|
| A · Context rot | Bounded peak: the model always works in a small context |
| B · Compaction loss | Fold without losing: the session log is fully durable, two-tier recall retrieves verbatim |
| C · Quadratic cost | Each turn carries only what that turn needs; the tape is append-only, so the prefix cache works |

### Two folds, two time scales

Slice folds history twice, at different moments:

| Fold | When | What survives in context | What stays recoverable |
|---|---|---|---|
| **Cross-turn** (the tape) | At turn end | Turn digest, file baselines + patches, reply head/tail | Everything, via `recall_turn` / `recall_search` |
| **In-turn** (insertion-time condensation, default since 2026-09) | The moment a tool result enters the turn | Data/document reads: first and last lines plus every structured line, appendix blocks trimmed to their first few keys. Build/test/log output: every error, failure and warning with context, stack traces, summary lines. Source code and grep/glob results: never condensed | The full result, via `recall_step(turn, step)` |

Why the in-turn fold is the lever: under DeepSeek's prefix cache a hit costs
~1/30 of a miss, so anything that rewrites earlier bytes (sliding windows,
mid-turn sealing, per-step ledgers) pays the miss price every step and loses to
an append-only stream. Within a turn the only cost left to cut is the size of
each **new** result — so the stream stays append-only and each result is
condensed once, on entry, never rewritten. Measured on a 45-node chain-migration
turn (~300K tokens of reads): $0.135 → $0.024, 45/45 correct. The routing rules
and their Headroom lineage are in `docs/fold-content-routing.md`.

Modes: `mode: 'slice'` (default) is everything above. `mode: 'stream'`
(experimental, off by default) adds a per-turn **constitution** (the request
plus rules extracted from the first files read) and a **contract** (host-side
predicate checks on writes, with a bounce budget so a mis-extracted rule can
interrupt at most once); it is the configuration that passes the rule-document
ledger task (l2) reliably. `mode: 'state'` (hot-window world-state loop) is kept
as an archived experiment — `docs/world-state-loop.md`. `defaultReasoningEffort:
'low'` is the plugin default (an explicit connection setting wins) — the effort
ladder is in `docs/effort-ladder.md`.

## Measurements: two arms, head to head

**default** = DSH's stock transcript loop (with calibrated compaction);
**slice** = this plugin. Same harness, same tools, **one round on each of two
model generations**: deepseek-v4-flash (0731) and deepseek-v4-pro (0813). Prices use the **sheet
effective 2026-08-16, at off-peak rates**: flash miss $0.22/M · hit $0.007/M ·
output $0.66/M; pro $0.66 / $0.022 / $1.98 (peak doubles every rate, so
relative deltas are unchanged). The new sheet narrows both cache discounts to
~1/30 (formerly flash 1/50, pro 1/120). Per-call ledgers kept, every number
recomputable; results below report both rounds.

### ① Long-horizon loads · both arms × both models

The bounded slice's home turf is the long session — a transcript's cost and
peak grow with every turn, a slice's do not. Two long-horizon scenarios
(16-turn compaction amnesia · 76-turn context flood), each cell flash / pro:

| Scenario | Arm | Verifier (flash / pro) | Price (flash / pro) | Peak (flash / pro) |
|---|---|---|---|---|
| s13 (16 turns) | slice | ✓ / ✓ | **$0.0241** / $0.0900 | **16K** / **17K** |
| | default | ✓ / ✓ | $0.0296 / **$0.0852** | 59K / 40K |
| s10 (76-turn flood) | slice | **✓ zero loss / ✓ zero loss** | **$0.1529** / **$0.6163** | **32K** / 43K |
| | default | ✓ / **✗ early timeline LOST** | $0.3755 / $0.7682 | 378K / 42K |

> **The two s10 rounds together are the transcript dilemma caught whole.**
> Flash round: default's compaction can't keep up with the flood, the peak
> ratchets to 378K — everything stays in context, every quiz passes, but the
> context is out of control. Pro round: compaction works properly (peak
> sawtooths 40→34→39→40, bounded at the threshold) — and it costs the early
> timeline that lived only in history: **the verifier fails the run.**
> Unbounded peak or lossy forgetting: a transcript must pick one. Slice, both
> rounds: bounded peak + zero loss, at 59% / 20% lower price. The short s13
> scenario's price swings with the pricing structure (slice -18% under flash,
> +6% under pro); the peak advantage (2.4–3.7×) does not.

> **Amendment (2026-08)** — the flash-round **default** cell above is
> *invalidated*: a config-name drift (`compact-basic` → `compaction-basic`)
> had silently disabled that arm's compaction, which is exactly why its peak
> ratcheted to 378K while "keeping everything". Re-run with compaction
> correctly calibrated **and verified firing**, the flash default **fails the
> verifier too** (3 planted facts lost; peak 96K sawtooth). Both model
> generations now resolve the dilemma the same way: once compaction actually
> runs, the transcript pays with lossy forgetting. Slice cells re-validated
> unchanged on the rewritten schema.

### Results update — 2026-08-24 → 31 (rewritten schema)

- **Schema rewritten DSH-native**: 19 ported regions → 4 fed segments + 2
  fixed slots; the fidelity ladder / elasticity controller / Python golden
  parity retired (−3.4K lines). Kernel prompt 12.7k → **1.9k** chars; ask/
  reply truncation now keeps **head AND tail** with exact cut markers; a
  plugin contribution registry (`ctx.sliceContext`) lets plugins feed the
  slice without the loop knowing them.
- **Retention series** (7 new paired scenarios + re-runs; same model & effort
  both arms; per-call ledgers): **slice 12/12, transcript 10/12** — both
  transcript losses are compaction-destroys-history (the s10 flood, and a
  3.4KB verbatim-restore scenario where slice recovered via a *self-directed*
  `recall_turn` — first benchmark-level proof the recall path is
  load-bearing, not decoration).
- **1M-window cost** (product-default compaction 0.8/0.16; the transcript arm
  genuinely climbs to 764–779K and crosses twice; 74 turns ≈ 2M tok content):
  slice **−27%** (pure input flood) / **−39%** (flood + real coding work).
  The differential is the transcript's per-cycle history re-reads
  (≈ W²/2Δ ≈ 10M cache tokens/cycle) plus summarization billed as output.
- **Honest cons, measured**: light/short sessions cost **+5–46%** on slice —
  reasoning generation runs 2–5× (visible text equal; the price of
  re-orienting against a compiled dossier plus verify-don't-trust
  epistemics). Crossover ≈ the transcript's first compaction. Single-turn
  (Ralph-style) work gains nothing: within a turn this loop is a transcript.
- **Reasoning-passback refuted from both sides**: feeding old chains onto the
  tape → reasoning **+42%**; stripping the transcript's native
  `reasoning_content` passback (471 strips) → **−25%**, run still passes.
  Old reasoning in context is cost, never continuation; the transcript's
  thrift comes from trusting its own narrative — the exact failure mode this
  loop removes. Wiring kept behind `SLICE_REASONING_TAPE=1`.
- Archives: `results/20260826-retention`, `results/20260827-cost1m`,
  `results/20260831-reasoning-ab` in the companion workspace, plus a
  per-request viewer (`build-request-viewer.mjs`) that renders exactly what
  each arm sent the model, turn by turn.

### Results update — 2026-09-01 (header dedup refuted)

The composition rule (tape composition == OPEN FILES hash ⇒ edit directly)
is stated three times per turn: kernel (cached) + FILES_HDR + NOW footer
(both per-turn paid text). An A/B deduplicated the two paid restatements
(−21% paid fixed text, ~80 tok/turn) against four pre-declared behavior
gates on s10 (76 turns) + n1, dual runs each arm. Result: **rejected**.
Cross-turn composition trust held in both arms (kernel's single teaching
site is sufficient for the rule itself: 0–2 cross-turn re-reads everywhere)
— but the restatements turn out to damp **same-turn post-edit verification
re-reads**: control 10/10 redundant re-reads across two runs, dedup 25/15.
The paid repetition is not teaching the rule; it is suppressing re-read
paranoia, worth more than the ~80 tok/turn it costs. Cost delta was −7–9%
in dedup's favor and did not override the behavior gate. Decision recorded
in `docs/adr/0001-keep-header-restatements.md`; ledgers in
`results/20260901-header-dedup/`; branch `feature/header-dedup` left
unmerged as the artifact.

### Results update — 2026-09-03 (in-turn fold · three arms)

Conditions: flash, adapter-default effort (high), no step cap (250), full tool
stack (bash/grep/glob); the default arm's numbers are recomputed from the
August session logs at the same price sheet; single runs unless noted. Full
tables and the environment audit: `docs/slice-fold-multiturn.md`.

| Scenario | default (Aug) | slice, Aug build (no in-turn fold) | slice, now (in-turn fold) |
|---|---|---|---|
| s1 long-horizon debug (6 turns) | ✓ $0.091 | ✓ $0.074 | ✓ $0.068 |
| s2 task-DAG scheduler (10) | ✓ $0.081 | ✓ $0.094 | ✓ $0.120 |
| s3 interval algebra (10) | ✓ $0.051 | ✓ $0.087 | ✓ $0.081 |
| s13 amnesia (16) | ✓ $0.030 | ✓ $0.026 | ✓ $0.021 |
| s14b recall ladder (17) | ✓ $0.031 | ✓ $0.029 | ✓ $0.025 |
| s10 flood (76) | **✗** 3 facts lost · $0.250 | ✓ $0.164 | **✓ zero loss** · $0.157 |
| CB-20 retrieval (19 paired) | fileR 0.761 · $0.541 · 19/20 | fileR 0.816 · $0.602 · 20/20 | fileR 0.749 · **$0.482** · 20/20 |
| l1 chain migration (1 turn, ~300K read) | ✓ $0.135 | ✓ $0.142 | ✓ **$0.024–0.031** |
| l2 ledger posting (rule doc + running state) | ✓ $0.124 | ✓ $0.050 | ✓/✗ without a constitution; `mode: 'stream'` 3/3 at $0.0285 |

Readings: 9/9 on the multi-turn set (default 8/9); memory and flood loads
−21–37%; retrieval −11% at parity recall against default (−4–7pp against the
August slice build, confounded with kernel changes); single-turn heavy reads
−80%. Coding tasks split from −25% to +61%: the **output tax** — after each
per-turn rebuild the model re-reasons and re-runs tests — is a property of the
slice architecture, not of the fold, which never triggers on source code.

### ② Amnesia re-enactment · both arms · eviction-verified

24 benchmark numbers produced by the agent's own script run, existing only in
tool output — before the exam: the numbers never enter any reply (turn 1
explicitly asks only to confirm the run), the source samples are deleted on
first run (nothing on disk), and a dilution flood forces default's compaction
to rewrite history multiple times. The exam has two tiers: first no hint at
all, then an explicit "you produced these numbers yourself in this session —
go check the records."

| Model | Arm | Eviction | No-hint tier | Explicit tier | Trap | Peak | Price | Wall |
|---|---|---|---:|---:|---|---:|---:|---:|
| flash | slice | ✓ 0/16 | **24/24** | 24/24 | no fabrication ✓ | **21.5K** | **$0.0521** | **222s** |
| | default | ✓ 0/16 | **0/24** | 24/24 | no fabrication ✓ | 51.9K | $0.0910 | 569s |
| pro | slice | ✓ 0/16 | **24/24** | 24/24 | no fabrication ✓ | **22.1K** | **$0.1692** | **383s** |
| | default | ✓ 0/16 | 24/24 | 24/24 | no fabrication ✓ | 33.4K | $0.4612 | 2014s |

> Both arms share the same durable substrate — DSH persists the full session
> log, so recovery is possible *in principle* for either. The difference is
> **affordance**, and it changes shape with model strength. On flash: given
> the neutral exam, slice **spontaneously** ran `recall_search → recall_turn`
> (the tape leaves signposts at every cut) and recovered within the turn;
> default searched the workspace, found nothing, and wrote UNKNOWN as
> instructed (**zero fabrication, duly recorded**) — until the explicit tier,
> where it zstd-decompressed its own session jsonl and dug the values out.
> Pro is strong enough that default performs that forensic dig unprompted —
> so the gap moves from *whether* recovery happens to **what it costs**: the
> same 24/24 takes slice **3 requests** (383s / $0.169) and default **32
> requests** (2014s / $0.461) — 2.7× the price, 5.2× the wall clock.
> "Recoverable" and "goes and recovers" are separated by one layer of tools
> and signposts; the stronger the model, the more that layer shows up as pure
> efficiency.

### ③ CB-20 precision retrieval · both arms

ContextBench (given a real issue, the agent retrieves the code locations the
fix depends on): a 20-question subset of the official 50-question benchmark.
Paired comparison n=19 — default timed out (20 min) on one question in each
round (different questions; both finished by slice in minutes):

| Metric (19-question paired mean) | slice flash | default flash | slice pro | default pro |
|---|---:|---:|---:|---:|
| fileRecall | **0.816** | 0.761 | 0.752 | **0.780** |
| spanRecall | **0.847** | 0.772 | 0.794 | **0.811** |
| filePrecision | 0.227 | 0.229 | **0.244** | 0.212 |
| F1 · file-level (from means) | **0.355** | 0.353 | **0.368** | 0.333 |
| F1 · file-level (macro) | **0.342** | 0.323 | **0.343** | 0.327 |
| total price | $0.6021 | **$0.5414** | **$1.3603** | $1.7318 |
| completion | **20/20** | 19/20 | **20/20** | 19/20 |

> The two generations swap the recall lead (slice +5.5pp under flash, default
> +2.8pp under pro), but **slice wins F1 and completion on both**, and pulls
> ahead on precision under pro (+3.2pp); price flips from +11% under flash to
> **-21%** under pro — pro's output is expensive ($1.98/M), and default's
> longer sessions and extra steps cost more on an expensive model. The
> re-read discipline a bounded slice forces stays an advantage on retrieval
> across both generations.

<details>
<summary>Per-question detail · flash (19 paired: recall / span / F1 / price)</summary>

| Question (Multi-SWE-Bench) | slice R/span/F1 | default R/span/F1 | slice $ | default $ |
|---|---|---|---:|---:|
| c__0f94ce4d | 1.00/1.00/0.36 | 1.00/1.00/0.26 | 0.0601 | 0.0597 |
| c__1ac60ce9 | 1.00/1.00/0.25 | 1.00/1.00/0.20 | 0.0160 | 0.0237 |
| c__b9b45262 | 0.33/0.30/0.17 | 0.33/0.30/0.13 | 0.1118 | 0.0627 |
| c__cdbc5890 | 1.00/1.00/0.22 | 1.00/1.00/0.18 | 0.0300 | 0.0267 |
| cpp__6a4e21e9 | 0.67/0.63/0.22 | 0.67/0.25/0.40 | 0.0363 | 0.0283 |
| cpp__7c9ef76c | 0.67/0.97/0.33 | 0.33/0.93/0.18 | 0.0194 | 0.0276 |
| cpp__bca55dea | 1.00/1.00/0.64 | 0.29/0.14/0.21 | 0.0438 | 0.0206 |
| cpp__fe080aac | 0.50/0.87/0.33 | 0.50/0.87/0.25 | 0.0258 | 0.0342 |
| go__0498ad7f | 1.00/1.00/0.29 | 1.00/1.00/0.18 | 0.0175 | 0.0341 |
| go__0b78ed50 | 1.00/1.00/0.67 | 1.00/1.00/1.00 | 0.0150 | 0.0095 |
| go__0f79e39c | 1.00/1.00/0.50 | 1.00/1.00/0.50 | 0.0135 | 0.0094 |
| go__1384380d | 0.67/0.39/0.42 | 0.67/0.51/0.32 | 0.0302 | 0.0764 |
| go__1ba303a5 | 0.67/0.92/0.36 | 0.67/0.92/0.44 | 0.0365 | 0.0389 |
| go__250649eb | 1.00/1.00/0.50 | 1.00/1.00/0.57 | 0.0099 | 0.0129 |
| go__2a889a1d | 1.00/1.00/0.29 | 1.00/1.00/0.29 | 0.0299 | 0.0088 |
| go__2c512ec3 | 0.00/0.00/0.00 | 0.00/0.00/0.00 | 0.0315 | 0.0171 |
| go__3d1b3145 | 1.00/1.00/0.50 | 1.00/1.00/0.29 | 0.0137 | 0.0270 |
| go__3d85271b | 1.00/1.00/0.22 | 1.00/1.00/0.22 | 0.0162 | 0.0106 |
| go__3deeea9c | 1.00/1.00/0.22 | 1.00/0.75/0.50 | 0.0449 | 0.0131 |

Unpaired timeout: c__8bffb1b1 (default timed out at 20 minutes; slice finished
in 137s, R/span 1.00/1.00, $0.0213).

</details>

<details>
<summary>Per-question detail · pro (19 paired: recall / span / F1 / price)</summary>

| Question (Multi-SWE-Bench) | slice R/span/F1 | default R/span/F1 | slice $ | default $ |
|---|---|---|---:|---:|
| c__0f94ce4d | 0.40/0.65/0.17 | 0.80/0.85/0.33 | 0.1446 | 0.1326 |
| c__8bffb1b1 | 1.00/1.00/0.44 | 1.00/1.00/0.36 | 0.0485 | 0.0906 |
| c__b9b45262 | 0.33/0.30/0.40 | 0.33/0.30/0.20 | 0.0501 | 0.1579 |
| c__cdbc5890 | 1.00/1.00/0.20 | 1.00/1.00/0.18 | 0.0515 | 0.1199 |
| cpp__6a4e21e9 | 0.67/0.49/0.16 | 0.33/0.15/0.13 | 0.1411 | 0.0947 |
| cpp__7c9ef76c | 0.33/0.93/0.12 | 0.67/0.97/0.27 | 0.1240 | 0.1051 |
| cpp__bca55dea | 0.71/0.56/0.45 | 0.86/0.86/0.36 | 0.1144 | 0.1728 |
| cpp__fe080aac | 0.50/0.87/0.36 | 0.50/0.71/0.29 | 0.0648 | 0.0763 |
| go__0498ad7f | 1.00/1.00/0.40 | 1.00/1.00/0.29 | 0.0486 | 0.0551 |
| go__0b78ed50 | 1.00/1.00/0.67 | 1.00/1.00/0.40 | 0.0415 | 0.1038 |
| go__0f79e39c | 1.00/1.00/0.40 | 1.00/1.00/0.50 | 0.0346 | 0.0257 |
| go__1384380d | 0.67/0.36/0.47 | 0.67/0.66/0.44 | 0.0976 | 0.0872 |
| go__1ba303a5 | 0.67/0.92/0.44 | 0.67/0.92/0.36 | 0.0604 | 0.1281 |
| go__250649eb | 1.00/1.00/0.57 | 1.00/1.00/0.50 | 0.0630 | 0.0348 |
| go__2a889a1d | 1.00/1.00/0.22 | 1.00/1.00/0.40 | 0.0393 | 0.0603 |
| go__2c512ec3 | 0.00/0.00/0.00 | 0.00/0.00/0.00 | 0.0643 | 0.0902 |
| go__3d1b3145 | 1.00/1.00/0.29 | 1.00/1.00/0.29 | 0.0545 | 0.0501 |
| go__3d85271b | 1.00/1.00/0.40 | 1.00/1.00/0.40 | 0.0259 | 0.0266 |
| go__3deeea9c | 1.00/1.00/0.33 | 1.00/1.00/0.50 | 0.0915 | 0.1201 |

Unpaired timeout: c__1ac60ce9 (default timed out at 20 minutes; slice finished
in 949s, R/span 1.00/1.00, $0.1222).

</details>

## Defects and directions

### transcript vs slice, stated fairly

Everything below is priced on the same sheet (flash off-peak: miss $0.22/M ·
hit $0.007/M · output $0.66/M). Same-code, same-day comparisons exist for
l1/l2, n1–n3 and one s4 cell; the multi-turn s-series and CB-20 transcript
numbers are August sessions recomputed, on a slightly different host. Every
cell is a single run and repeats of one configuration move ±30%, so anything
inside 15% is a tie.

| Task shape | transcript | slice | Reading |
|---|---|---|---|
| Single-turn heavy read (l1, ~300K tokens) | ✓ $0.135 | ✓ $0.024–0.031 | slice −80%; the in-turn fold is decisive |
| Flood / memory (s10 · s13 · s14b) | ✗ $0.250 · ✓ $0.030 · ✓ $0.031 | ✓ $0.157 · ✓ $0.021 · ✓ $0.025 | slice −21% to −37%; only s10 separates the arms on correctness (compaction lost 3 planted facts) |
| Multi-turn coding (s1 · s4) | ✓ $0.091 · ✓ $0.143 | ✓ $0.068 · ✓ $0.125 | slice −12% to −25% |
| Multi-turn coding (s2 · s3) | ✓ $0.081 · ✓ $0.051 | ✓ $0.120 · ✓ $0.081 | **transcript 32–38% cheaper**: after every per-turn rebuild the model re-reasons and re-runs tests, 1.7–2× the output tokens; the August slice build showed the same, so this is the architecture, not the fold |
| Small-file multi-turn (n2 · n3) | ✓ $0.012 · ✓ $0.020 | ✓ $0.012 · ✓ $0.019 | tie |
| Rule document + running state (l2) | ✓ $0.124 | ✓/✗ $0.030 | slice drifted to the wrong output directory in 3 of 4 runs without a constitution; `mode: 'stream'` passes 3/3 at $0.0285 |
| CB-20 retrieval (19 paired) | fileR 0.761 · $0.541 · 19/20 | fileR 0.749 · $0.482 · 20/20 | recall at parity (span 0.803 vs 0.772), slice −11%, per-instance F1 9:8 |

Peak context: transcript reaches 59–96K on s13/s10 and 302–330K on l1/l2;
slice stays at 11–33K on the multi-turn set and 42–52K on l1/l2 after the fold.
A small peak does not save money by itself under a 1/30 cache discount — it
buys no window limit, no compaction and no rot; in this suite rot never
appeared and compaction loss appeared once (s10), but that once was real.

The price sheet is the premise. With no cache discount (hit priced as miss),
l1 becomes $1.81 vs $0.31, n2 $0.088 vs $0.025, n3 $0.174 vs $0.038 — slice
3–6× cheaper across the board. DeepSeek's 1/30 discount is the whole reason
transcript keeps up on short tasks.

**Where transcript wins:** short interactive coding sessions under DeepSeek
pricing (cheaper, equally correct); the fewest moving parts; nothing "present
but unseen" inside the window; complete engineering coverage. If your sessions
are tens of turns with small files, transcript shows no visible disadvantage.

**Slice's inherent risks:** recall depends on the model reaching for it —
proven under controlled pressure (s10, s14b), near zero on everyday loads; the
fold changes what the model sees (CB-20 file recall 0.749 vs 0.816 on the
August build, confounded with kernel changes); rule-document tasks need the
constitution; more mechanism means more surface for failure, and the plugin
is early.

**Hard conclusions:** long sessions, floods, heavy reads and log-dense tasks
belong to slice — correctness not worse, cost −21% to −80%, bounded peak;
short multi-turn coding under DeepSeek pricing belongs to transcript; on any
provider with a shallow cache discount slice wins broadly. **Soft conclusions**
(need same-code reruns with three runs per cell): the +48–61% on s2/s3 and
the 4–7pp CB-20 recall gap may be half noise and version drift.

### Defects

| Defect | What it is, measured | Direction |
|---|---|---|
| **1 · Coding tasks pay an output tax** | The slice is rebuilt every turn, so on coding loads the model re-reasons and re-runs tests after each rebuild: s2/s3 cost +48–61% against default with 1.7–2× the output tokens, while s1/s4 come in −12–25%. Input-side, the in-turn fold settled the cache question: an append-only stream that condenses each new result beats every rewrite-history design under a 1/30 cache discount (l1: −80%). | Tape rounds 2–3, 2026-09-03 (now the default): rent-or-buy anchoring (read twice / touched twice), collapsing a turn's edits, and full bases with read pointers bring s2 to a median $0.085 over nine runs (old slice 0.120, transcript 0.081) and s1 to 0.050 (0.068), memory scenarios at parity, all green. The same full-base shape loses on 8–12-file working sets (s4/s5/s6, six samples all above the old shape): with the whole working set in front of it the model does the work in its head, and reasoning at effort high costs more than a few extra tool steps — hence the `baseMaxFiles` switch back to the old shape beyond 4 tracked files. Turn-start reasoning is 2–4× the transcript's and does not depend on seed size (r = 0.01 over 241 turn starts); a snapshot-semantics header cut tape-interpretation from a third to a tenth of it without lowering the total. Carrying old reasoning was refuted a second time. Next: three runs per cell, and shapes with 5–7 files. |
| **5 · In-turn condensation trades a little retrieval breadth for bytes** | CB-20 file recall 0.749 vs 0.816 on the August build (confounded with kernel and host changes), 20/20 completion, −20% price. Condensation never touches source code or grep results; its rules were tuned on logs and dossiers. | `--no-fold` ablation on today's build; error-first log rules and structured-line rules are the two knobs. |
| **6 · Rule-document tasks need the constitution** | Without it the model drifted to a wrong output directory in 3 of 4 l2 runs; `mode: 'stream'` passes 3/3 and costs the same. | Decide whether stream becomes the default for long single-turn tasks; keep it opt-in for interactive sessions (short turns pay for extraction and gain nothing). |
| **1b · Folding without the slice** | The in-turn fold is the one universal saving (l1 −80%) and it never needed the tape. `@dsh-external/dsh-slice-agent-loop/fold` is a standalone plugin that mounts on the stock transcript loop: at each pre-step it condenses the tool results that just landed and shadows the originals with `tool/result` surface replacements (the compaction pruner's own mechanism); the durable log keeps the originals and `expand_result` returns them. Standalone repo: [TT-Wang/dsh-tool-result-fold](https://github.com/TT-Wang/dsh-tool-result-fold); see `docs/tool-result-fold.md`. | Measured same-day against the stock loop: l1 0.023 vs 0.135 (−83%, 45/45, peak 43K vs 331K), s13 and s2 neutral (nothing to fold on coding loads), all green. Recommended product default: transcript + fold; the slice tape only for sessions the transcript would have to compact. |
| **2 · The recall channel depends on the model reaching for it** | History is byte-recoverable, and spontaneous recall under controlled pressure is proven (test ②); but on everyday coding loads active recall is near zero (most information fits tape capacity and push covers it), and cross-session "continue from yesterday" cold starts remain a risk. | Make recall habitual on everyday loads and cold starts; agent memory is still frontier territory, work scheduled. |
| **3 · Retrieval breadth vs. the frugal kernel is still being balanced** | The current kernel buys precision and price at some recall-breadth regression against the previous build. | Kernel A/B iteration continues. |
| **4 · Still an early plugin overall** | Covers the web profile's agent-loop surface today; settings-panel alignment, the subagent ecosystem, and TUI are catching up. The core mechanisms (sealing, audit events, two-tier recall) are validated by the three test groups above. | An engineering-coverage problem, not a technical-difficulty one. |

## Install

```sh
dsh plugin --profile web add "github:TT-Wang/dsh-slice-agent-loop#main"
```

Or from a local checkout: `git clone` then `dsh plugin --profile web add .`
Restart web afterwards — bundles are composed at boot.

The bundled patch disables the stock loop and compaction — the bounded rebuild
replaces both. If your composition carries an `agent-loop-invariant` row,
remove it: a rebuilt slice cannot equal the derived history byte-for-byte, and
this plugin refuses to load beside that assertion.

## Configuration

| key | default | |
|---|--:|---|
| `maxStepsPerTurn` | `50` | hard ceiling on continuation steps per turn |
| `maxParallelToolCalls` | `10` | parallel tool bodies per step; since DSH 0811 this also caps subagent fan-out |
| `defaultReasoningEffort` | `'low'` | effort injected when the connection sets none; `'inherit'` keeps the adapter default |
| `digest` | `{ enabled: true, minChars: 1500, logMinChars: 512, … }` | in-turn condensation policy (`docs/fold-content-routing.md`); `enabled: false` restores the August behavior |
| `mode` | `'slice'` | `'stream'` adds constitution + contract; `'state'` is the archived hot-window experiment |
| `state` | `{ pinSteps: 2, extractAtStep: 3, enforceFromStep: 8, contractBounceBudget: 1, sideEffort: 'off' }` | stream/state knobs |
| `inTurnSeal` | `{ enabled: false }` | mid-turn sealing experiment (not worth it under cache pricing) |
| `tape` | `{ readBases: true, readBasesMinReads: 2, newFileMinTouches: 2, readPointer: true, anchor: 'base', baseMaxFiles: 4, baseMaxChars: 60000, collapseEdits: true, gcSupersededBases: false }` | tape shape. Rent-or-buy rules (checked against 89 historical sessions): a read-only file is anchored once read in 2 turns; a file this session created is anchored on its second touch; a turn's repeated edits of one file collapse to the final state. Working-set switch: while the tape tracks ≤ `baseMaxFiles` files, edited files re-land as full bases and a full read of a tape-current file answers with a pointer (wins on 1–4-file coding loops); beyond that the tape falls back to patch-or-base without pointers (wins on 8–12-file working sets). `baseMaxChars` caps a single full base. Opt-in: `gcSupersededBases` (one current base per file in the seed), `rebaseAfterPatches`, `replyHeadChars`/`replyTailChars`, `checkInDigest` |

Set them from your profile's `cordis.patch.yml`, targeting the existing row by
id (`- id: slice-agent-loop` + `config:`).

## Development

```bash
npm install --legacy-peer-deps   # the @deepseek-ai/* peers are unpublished
npm run link:dsh                 # symlink them from your dsh checkout
npm run typecheck && npm test
```

`lib/` is committed (git-source installs run no build) — `npm run build`
before pushing. Real-model smoke: `npm run e2e:recall` (needs
`DEEPSEEK_API_KEY` in env).

Benchmarks (`DEEPSEEK_API_KEY` and `SLICE_CALL_LEDGER_DIR` in env): run the
environment probe first, then any scenarios-snapshot scenario:

```bash
npx tsx scripts/run-scenario.mts results/20260902-multiturn/scenarios-snapshot/z0_env_smoke --arm slice-noseal --tools full --ledger-dir results/probe
npx tsx scripts/run-scenario.mts <scenario-dir> --arm transcript|slice-noseal|stream --effort low|inherit --max-steps 250 --tools full --ledger-dir results/<batch>
```

`--effort inherit --max-steps 250 --tools full` reproduces the August
conditions; every ledger records the effort, step cap and tool list that
actually took effect. `scripts/h2h-sessions.py` recomputes usage from
`~/.dsh/sessions`, `scripts/mt-report.py` builds the comparison table,
`scripts/cb20-dsh.mjs` drives CB-20 against a running web profile. Design notes:
`docs/fold-content-routing.md`, `docs/slice-fold-multiturn.md`,
`docs/world-state-loop.md`, `docs/effort-ladder.md`, `docs/in-turn-slicing.md`,
`docs/miss-attribution.md`.

## License

BSD-3-Clause — see [LICENSE](LICENSE).
