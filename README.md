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

**default** = DSH's stock transcript loop (with calibrated compaction,
threshold 40K); **slice** = this plugin. Same harness, same model
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
> ratchets to 378K and slice stays flat at 32K. **Short coding tasks (1–10
> turns) are not where slice wins** — some scenarios run 17–72% above default
> (integration-fidelity tax: workspace baseline recomposition, more verbose
> verification output). The architecture pays off from long sessions onward;
> see "Weaknesses, honestly".

### ② Amnesia re-enactment · both arms · eviction-verified

24 benchmark numbers produced by the agent's own script run, existing only in
tool output — before the exam: the numbers never enter any reply (turn 1
explicitly asks only to confirm the run), the source samples are deleted on
first run (nothing on disk), and a dilution flood forces default's compaction
to rewrite history multiple times. **Eviction verification**: each arm carries
a request tap; the step-1 LLM request of the exam turn is checked
byte-by-byte — 16 strong marker values, zero present, or the entire run is
voided (two of our first three rounds WERE voided: once compaction copied all
34 facts into its checkpoint, once a compaction storm wedged the exam turn).
The exam has two tiers: first no hint at all, then an explicit "you produced
these numbers yourself in this session — go check the records."

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
fix depends on): a 20-question subset of the official 50-question benchmark
(selected by completion speed in a prior run, same questions for both arms,
every worktree reset to base_commit). Paired comparison, n=19 (default timed
out on one question at 20 minutes — slice finished it in 137 seconds):

| Metric (19-question paired mean) | slice | default |
|---|---:|---:|
| fileRecall | **0.816** | 0.761 |
| spanRecall | **0.847** | 0.772 |
| filePrecision | 0.227 | 0.229 |
| F1 (file-level) | **0.355** | 0.353 |
| total price | $0.2862 | **$0.2715** |
| completion | **20/20** | 19/20 |

> Same questions, same model: slice recovers 5.5pp more files and 7.5pp more
> lines at equal precision — the re-read discipline a bounded slice forces is
> an advantage on retrieval, not a burden; the cost is 5% on price.

## Weaknesses, honestly

1. **Short-task integration-fidelity tax**: workspace baselines recompose into
   the request after file edits, and verification discipline raises output
   tokens — short coding tasks run 17–72% above default. Byte-hygiene work is
   scheduled.
2. **Pricing-structure dependence**: DeepSeek's cache-hit price is 1/50 of a
   miss — the friendliest structure in the industry for append-only
   transcripts, i.e. the harshest for rebuilds. Every number above was
   measured under it; shallower cache discounts (Claude / OpenAI pricing) move
   the crossover earlier.
3. **The default arm's compaction is our calibration**: DSH's API path
   defaults to a 0.8× window threshold, which these loads would never trigger;
   we lowered it to 40K so default's loss-prevention actually engages. An
   uncalibrated default peaks even higher under flood load.
4. **Retrieval breadth vs. the frugal kernel is still being balanced**: the
   current kernel buys precision and price at some recall-breadth regression
   against the previous build; tuning continues.

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
