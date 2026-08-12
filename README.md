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

Early beta; tracks DSH snapshot `20260811T152241Z`.

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
**slice** = this plugin. Same harness, same model
(deepseek-v4-flash), same tools, same official pricing (miss $0.14/M · cache
hit $0.0028/M · output $0.28/M). Per-call ledgers are kept; every number is
recomputable.

### ① Long-horizon loads · both arms PASS

The bounded slice's home turf is the long session — a transcript's cost and
peak grow with every turn, a slice's do not. Two long-horizon scenarios
(16-turn compaction amnesia · 76-turn context flood):

| Scenario | Turns | slice price | default price | Δ | slice peak | default peak |
|---|---:|---:|---:|---:|---:|---:|
| s13 compaction amnesia | 16 | **$0.0127** | $0.0147 | **-14%** | **16K** | 59K |
| s10 context flood | 76 | **$0.0843** | $0.1700 | **-50%** | **32K** | 378K |

> Both arms pass every verifier (no capability loss). The more turns, the
> wider the gap — 14% cheaper at 16 turns, 50% at 76, while default's peak
> ratchets to 378K and slice stays flat at 32K.

### ② Amnesia re-enactment · both arms · eviction-verified

24 benchmark numbers produced by the agent's own script run, existing only in
tool output — before the exam: the numbers never enter any reply (turn 1
explicitly asks only to confirm the run), the source samples are deleted on
first run (nothing on disk), and a dilution flood forces default's compaction
to rewrite history multiple times. The exam has two tiers: first no hint at
all, then an explicit "you produced these numbers yourself in this session —
go check the records."

| Arm | Eviction | No-hint tier | Explicit tier | Trap | Peak | Price | Wall |
|---|---|---:|---:|---|---:|---:|---:|
| slice | ✓ 0/16 present | **24/24** | 24/24 | no fabrication ✓ | **21.5K** | **$0.0287** | **222s** |
| default | ✓ 0/16 present | **0/24** | 24/24 | no fabrication ✓ | 51.9K | $0.0541 | 569s |

> Both arms share the same durable substrate — DSH persists the full session
> log, so recovery is possible *in principle* for either. The whole difference
> is **affordance**: given the neutral exam, slice **spontaneously** ran
> `recall_search → recall_turn` (the tape leaves signposts at every cut),
> recovered 16/16 values within the turn, and its recall note honestly states
> "retrieved, not remembered". Default searched the workspace, found nothing
> (the numbers aren't on disk), and wrote UNKNOWN as instructed — **zero
> fabrication, duly recorded** — until the explicit tier, where it resourcefully
> sniffed env vars and zstd-decompressed its own session jsonl to dig the
> values out of pre-compaction history, at 2.4× the peak, 1.9× the price and
> 2.6× the wall clock. "Recoverable" and "goes and recovers" are separated by
> exactly one layer of tools and signposts.

### ③ CB-20 precision retrieval · both arms

ContextBench (given a real issue, the agent retrieves the code locations the
fix depends on): a 20-question subset of the official 50-question benchmark.
Paired comparison, n=19 (default timed out on one question at 20 minutes —
slice finished it in 137 seconds):

| Metric (19-question paired mean) | slice | default |
|---|---:|---:|
| fileRecall | **0.816** | 0.761 |
| spanRecall | **0.847** | 0.772 |
| filePrecision | 0.227 | 0.229 |
| F1 · file-level (from means) | **0.355** | 0.353 |
| F1 · file-level (macro, per-question F1 averaged) | **0.342** | 0.323 |
| total price | $0.2862 | **$0.2715** |
| completion | **20/20** | 19/20 |

> Same questions, same model: slice recovers 5.5pp more files and 7.5pp more
> lines at equal precision — the re-read discipline a bounded slice forces is
> an advantage on retrieval, not a burden; the cost is 5% on price.

<details>
<summary>Per-question detail (19 paired: recall / span / F1 / price)</summary>

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

## Defects and directions

| Defect | What it is, measured | Direction |
|---|---|---|
| **1 · Cache hits are structurally fewer than a transcript loop's** | The slice is rebuilt every turn; when bytes move, cache entries die, so the fresh-input share is high (2–3× on short coding tasks). DeepSeek prices a cache hit at 1/50 of a miss — the deepest discount in the industry, and the friendliest structure for append-only transcripts — so under this pricing, short and mid-length tasks may show no price advantage (measured +17–72% on some scenarios). | Two byte-hygiene optimizations (stable rendering, freeze-on-second-read) are scheduled; long sessions win even under this pricing (-14%/-50%); shallower cache discounts (Claude / OpenAI) move the crossover earlier. |
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
