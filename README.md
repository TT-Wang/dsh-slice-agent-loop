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

Early beta; tracks DSH `0.1.2-alpha.2` (slash-route wire + cookie auth; the bundled bench driver speaks the new protocol).

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
| Current turn + tool observations | Appended within the turn, sealed and archived at turn end |

The **tape** looks like a transcript — append-only, cache-friendly — but every
entry carries a hash and provenance. Long content is truncated at the cut with
an exact marker, and the full text stays durable in the session log.

**Recall** is how "no less" is honored, in two tiers: `recall_search` finds
which turn said something (scored search, tool-output flood excluded by
default), `recall_turn` returns that turn verbatim. The tape leaves a signpost
at every cut pointing back to the original.

| Transcript's problem | This plugin's answer |
|---|---|
| A · Context rot | Bounded peak: the model always works in a small context |
| B · Compaction loss | Fold without losing: the session log is fully durable, two-tier recall retrieves verbatim |
| C · Quadratic cost | Each turn carries only what that turn needs; the tape is append-only, so the prefix cache works |

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

| Defect | What it is, measured | Direction |
|---|---|---|
| **1 · Cache hits are structurally fewer than a transcript loop's** | The slice is rebuilt every turn; when bytes move, cache entries die, so the fresh-input share is high (2–3× on short coding tasks). DeepSeek's cache discounts favor append-only transcripts (both ~1/30 under the sheet effective 2026-08-16; formerly flash 1/50, pro 1/120) — short and mid-length tasks may show no price advantage (measured +10–65% on some flash scenarios, though long-horizon debug now flips to -38%; +6% on s13 under pro). | Two byte-hygiene optimizations (stable rendering, freeze-on-second-read) are scheduled; long-session and retrieval loads win under both pricings (s10: -59%/-20%; CB-20 pro: -21%); shallower cache discounts (Claude / OpenAI) move the crossover earlier. |
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
| `kernel` | `'slice'` | system-prompt kernel; `'ported'` swaps in the verbatim Python prompt (A/B arm) |
| `maxStepsPerTurn` | `50` | hard ceiling on continuation steps per turn |
| `maxParallelToolCalls` | `10` | parallel tool bodies per step; since DSH 0811 this also caps subagent fan-out |

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

## License

BSD-3-Clause — see [LICENSE](LICENSE).
