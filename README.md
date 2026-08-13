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

Early beta; tracks DSH snapshot `20260812T172954Z` (rc.2; rc.1-compatible).

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
model generations**: deepseek-v4-flash (0731; miss $0.14/M · hit $0.0028/M ·
output $0.28/M) and deepseek-v4-pro (0813; $0.435 / $0.003625 / $0.87) — each
at its official pricing, per-call ledgers kept, every number recomputable.
Pro's cache discount (1/120) is even deeper than flash's (1/50) — a pricing
structure that favors append-only transcripts; results below report both
rounds.

### ① Long-horizon loads · both arms × both models

The bounded slice's home turf is the long session — a transcript's cost and
peak grow with every turn, a slice's do not. Two long-horizon scenarios
(16-turn compaction amnesia · 76-turn context flood), each cell flash / pro:

| Scenario | Arm | Verifier (flash / pro) | Price (flash / pro) | Peak (flash / pro) |
|---|---|---|---|---|
| s13 (16 turns) | slice | ✓ / ✓ | **$0.0127** / $0.0440 | **16K** / **17K** |
| | default | ✓ / ✓ | $0.0147 / **$0.0383** | 59K / 40K |
| s10 (76-turn flood) | slice | **✓ zero loss / ✓ zero loss** | **$0.0843** / **$0.2960** | **32K** / 43K |
| | default | ✓ / **✗ early timeline LOST** | $0.1700 / $0.3992 | 378K / 42K |

> **The two s10 rounds together are the transcript dilemma caught whole.**
> Flash round: default's compaction can't keep up with the flood, the peak
> ratchets to 378K — everything stays in context, every quiz passes, but the
> context is out of control. Pro round: compaction works properly (peak
> sawtooths 40→34→39→40, bounded at the threshold) — and it costs the early
> timeline that lived only in history: **the verifier fails the run.**
> Unbounded peak or lossy forgetting: a transcript must pick one. Slice, both
> rounds: bounded peak + zero loss, at 50% / 26% lower price. The short s13
> scenario's price swings with the pricing structure (slice -14% under flash,
> +15% under pro's 1/120 discount); the peak advantage (2.4–3.7×) does not.

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
| flash | slice | ✓ 0/16 | **24/24** | 24/24 | no fabrication ✓ | **21.5K** | **$0.0287** | **222s** |
| | default | ✓ 0/16 | **0/24** | 24/24 | no fabrication ✓ | 51.9K | $0.0541 | 569s |
| pro | slice | ✓ 0/16 | **24/24** | 24/24 | no fabrication ✓ | **22.1K** | **$0.0897** | **383s** |
| | default | ✓ 0/16 | 24/24 | 24/24 | no fabrication ✓ | 33.4K | $0.2863 | 2014s |

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
> same 24/24 takes slice **3 requests** (383s / $0.090) and default **32
> requests** (2014s / $0.286) — 3.2× the price, 5.2× the wall clock.
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
| total price | $0.2862 | **$0.2715** | **$0.5718** | $0.8228 |
| completion | **20/20** | 19/20 | **20/20** | 19/20 |

> The two generations swap the recall lead (slice +5.5pp under flash, default
> +2.8pp under pro), but **slice wins F1 and completion on both**, and pulls
> ahead on precision under pro (+3.2pp); price flips from +5% under flash to
> **-31%** under pro — pro's output is expensive ($0.87/M), and default's
> longer sessions and extra steps cost more on an expensive model. The
> re-read discipline a bounded slice forces stays an advantage on retrieval
> across both generations.

<details>
<summary>Per-question detail · flash (19 paired: recall / span / F1 / price)</summary>

| Question (Multi-SWE-Bench) | slice R/span/F1 | default R/span/F1 | slice $ | default $ |
|---|---|---|---:|---:|
| c__0f94ce4d | 1.00/1.00/0.36 | 1.00/1.00/0.26 | 0.0275 | 0.0294 |
| c__1ac60ce9 | 1.00/1.00/0.25 | 1.00/1.00/0.20 | 0.0080 | 0.0127 |
| c__b9b45262 | 0.33/0.30/0.17 | 0.33/0.30/0.13 | 0.0506 | 0.0314 |
| c__cdbc5890 | 1.00/1.00/0.22 | 1.00/1.00/0.18 | 0.0151 | 0.0134 |
| cpp__6a4e21e9 | 0.67/0.63/0.22 | 0.67/0.25/0.40 | 0.0168 | 0.0140 |
| cpp__7c9ef76c | 0.67/0.97/0.33 | 0.33/0.93/0.18 | 0.0097 | 0.0140 |
| cpp__bca55dea | 1.00/1.00/0.64 | 0.29/0.14/0.21 | 0.0205 | 0.0100 |
| cpp__fe080aac | 0.50/0.87/0.33 | 0.50/0.87/0.25 | 0.0127 | 0.0167 |
| go__0498ad7f | 1.00/1.00/0.29 | 1.00/1.00/0.18 | 0.0087 | 0.0165 |
| go__0b78ed50 | 1.00/1.00/0.67 | 1.00/1.00/1.00 | 0.0073 | 0.0050 |
| go__0f79e39c | 1.00/1.00/0.50 | 1.00/1.00/0.50 | 0.0068 | 0.0044 |
| go__1384380d | 0.67/0.39/0.42 | 0.67/0.51/0.32 | 0.0142 | 0.0393 |
| go__1ba303a5 | 0.67/0.92/0.36 | 0.67/0.92/0.44 | 0.0179 | 0.0197 |
| go__250649eb | 1.00/1.00/0.50 | 1.00/1.00/0.57 | 0.0051 | 0.0065 |
| go__2a889a1d | 1.00/1.00/0.29 | 1.00/1.00/0.29 | 0.0143 | 0.0045 |
| go__2c512ec3 | 0.00/0.00/0.00 | 0.00/0.00/0.00 | 0.0156 | 0.0086 |
| go__3d1b3145 | 1.00/1.00/0.50 | 1.00/1.00/0.29 | 0.0070 | 0.0138 |
| go__3d85271b | 1.00/1.00/0.22 | 1.00/1.00/0.22 | 0.0081 | 0.0054 |
| go__3deeea9c | 1.00/1.00/0.22 | 1.00/0.75/0.50 | 0.0203 | 0.0064 |

Unpaired timeout: c__8bffb1b1 (default timed out at 20 minutes; slice finished
in 137s, R/span 1.00/1.00, $0.0140).

</details>

<details>
<summary>Per-question detail · pro (19 paired: recall / span / F1 / price)</summary>

| Question (Multi-SWE-Bench) | slice R/span/F1 | default R/span/F1 | slice $ | default $ |
|---|---|---|---:|---:|
| c__0f94ce4d | 0.40/0.65/0.17 | 0.80/0.85/0.33 | 0.0572 | 0.0646 |
| c__8bffb1b1 | 1.00/1.00/0.44 | 1.00/1.00/0.36 | 0.0222 | 0.0437 |
| c__b9b45262 | 0.33/0.30/0.40 | 0.33/0.30/0.20 | 0.0222 | 0.0727 |
| c__cdbc5890 | 1.00/1.00/0.20 | 1.00/1.00/0.18 | 0.0225 | 0.0606 |
| cpp__6a4e21e9 | 0.67/0.49/0.16 | 0.33/0.15/0.13 | 0.0533 | 0.0427 |
| cpp__7c9ef76c | 0.33/0.93/0.12 | 0.67/0.97/0.27 | 0.0489 | 0.0526 |
| cpp__bca55dea | 0.71/0.56/0.45 | 0.86/0.86/0.36 | 0.0457 | 0.0804 |
| cpp__fe080aac | 0.50/0.87/0.36 | 0.50/0.71/0.29 | 0.0280 | 0.0372 |
| go__0498ad7f | 1.00/1.00/0.40 | 1.00/1.00/0.29 | 0.0224 | 0.0228 |
| go__0b78ed50 | 1.00/1.00/0.67 | 1.00/1.00/0.40 | 0.0190 | 0.0469 |
| go__0f79e39c | 1.00/1.00/0.40 | 1.00/1.00/0.50 | 0.0163 | 0.0126 |
| go__1384380d | 0.67/0.36/0.47 | 0.67/0.66/0.44 | 0.0400 | 0.0413 |
| go__1ba303a5 | 0.67/0.92/0.44 | 0.67/0.92/0.36 | 0.0257 | 0.0588 |
| go__250649eb | 1.00/1.00/0.57 | 1.00/1.00/0.50 | 0.0298 | 0.0163 |
| go__2a889a1d | 1.00/1.00/0.22 | 1.00/1.00/0.40 | 0.0183 | 0.0251 |
| go__2c512ec3 | 0.00/0.00/0.00 | 0.00/0.00/0.00 | 0.0282 | 0.0443 |
| go__3d1b3145 | 1.00/1.00/0.29 | 1.00/1.00/0.29 | 0.0233 | 0.0218 |
| go__3d85271b | 1.00/1.00/0.40 | 1.00/1.00/0.40 | 0.0126 | 0.0127 |
| go__3deeea9c | 1.00/1.00/0.33 | 1.00/1.00/0.50 | 0.0362 | 0.0656 |

Unpaired timeout: c__1ac60ce9 (default timed out at 20 minutes; slice finished
in 949s, R/span 1.00/1.00, $0.0463).

</details>

## Defects and directions

| Defect | What it is, measured | Direction |
|---|---|---|
| **1 · Cache hits are structurally fewer than a transcript loop's** | The slice is rebuilt every turn; when bytes move, cache entries die, so the fresh-input share is high (2–3× on short coding tasks). DeepSeek's deep cache discounts (flash 1/50, pro 1/120 — the deepest in the industry) favor append-only transcripts — short and mid-length tasks may show no price advantage (measured +17–72% on some flash scenarios, +15% on s13 under pro). | Two byte-hygiene optimizations (stable rendering, freeze-on-second-read) are scheduled; long-session and retrieval loads win under both pricings (s10: -50%/-26%; CB-20 pro: -31%); shallower cache discounts (Claude / OpenAI) move the crossover earlier. |
| **2 · The recall channel depends on the model reaching for it** | History is byte-recoverable, and spontaneous recall under controlled pressure is proven (test ②); but on everyday coding loads active recall is near zero (most information fits tape capacity and push covers it), and cross-session "continue from yesterday" cold starts remain a risk. | Make recall habitual on everyday loads and cold starts; agent memory is still frontier territory, work scheduled. |
| **3 · Retrieval breadth vs. the frugal kernel is still being balanced** | The current kernel buys precision and price at some recall-breadth regression against the previous build. | Kernel A/B iteration continues. |
| **4 · Still an early plugin overall** | Covers the web profile's agent-loop surface today; settings-panel alignment, the subagent ecosystem, and TUI are catching up. The core mechanisms (sealing, audit events, two-tier recall) are validated by the three test groups above. | An engineering-coverage problem, not a technical-difficulty one. |

## Install

```sh
dsh plugin --profile web add "github:dsh-external/dsh-slice-agent-loop#main"
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
