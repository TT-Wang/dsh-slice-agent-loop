# Heap growth over one long session — 2026-10-22

Question: does a long single-process session still grow its heap superlinearly? The 2026-09-11 notes, written under the since-replaced pressure-archive policy, recorded quadratic growth: after forced GC at turn 200, old main had 421 MB and the PR #6 branch 806 MB. Since then the policy has become the append-only session tape (49e20fb). Each completed turn is sealed once into a frozen `[slice tape v1 …]` entry, human user messages stay verbatim and superseded runtime-context snapshots are sealed with their turn.

**Answer: no.** On main 70e6e55 (plugin 0.2.0, DSH 0.2.0-rc.2, Node 22.22.3), heap after GC grows linearly with turns in every arm, up to 2000 turns. The per-turn increment stays flat:

| arm | MB/turn | heap at turn 200 | heap at turn 800 |
|---|---|---|---|
| slice | 0.088 | 36 MB | 89 MB |
| stock, no plugin | 0.064 | 29 MB | 68 MB |

About 97% of the growth is the host's in-memory session event log. Plugin-owned state adds 2.9 KB/turn. The old quadratic curve does not reproduce on current code.

## Method

[scripts/bench/heap-growth.mts](../scripts/bench/heap-growth.mts) uses the same stock composition as [tests/native-harness.ts](../tests/native-harness.ts): LlmRuntime, SessionStore, SessionProjections, SystemPrompt, ToolRegistry, AgentRegistry, the stock AgentLoop, and the three invariant plugins of DSH 0.2.0-rc.2 (see [Caveats](#caveats)). A scripted adapter replaces the model. The driver runs one session for N turns and keeps nothing that grows with N:

- responses are generated per turn;
- a request is measured only on checkpoint turns, and only its size is kept;
- no event snapshot is cloned. The test harness's `captured` array does clone one, and it is quadratic by construction.

Each turn contains:

- one human message of 0.3–0.9 K chars;
- a runtime-context `{{tick}}` change, with a context block of about 500 chars;
- three model steps, each with about 0.4–0.5 K of reasoning, streamed in 48-char deltas:
  1. two parallel calls: `read` of a 3–6 KB `.ts` file (code, never folded) and `grep` of 15–35 matches;
  2. `bash` returning a test log of 1.5–3 KB, or 40 KB every third turn (folded), plus a 15–25 KB `.md` read every fifth turn (folded);
  3. a reply of 0.6–1.2 K chars.

Content is pseudo-random per (seed, turn), so no two turns share strings.

At every checkpoint the driver runs `gc()` four times with `setImmediate` in between and records `process.memoryUsage()`, V8 space sizes and the size of the event log in memory. The log size is the sum of `JSON.stringify(event).length` over `snapshotEvents()`, split by event type. It also records surface counts (nodes, runtime-context snapshots, slice entries) and the size of the next request. With `--persist`, the driver first drains JSONL persistence with `ctx.sessions.flush()` (see below).

[scripts/bench/heap-fit.mts](../scripts/bench/heap-fit.mts) fits `heap = a + b·t` and `heap = a + b·t + c·t²` by least squares. It reports:

- R²;
- the t-statistic of c;
- `c·T²`, the amount the quadratic term adds by the last turn;
- the mean increment in the first and last quarter of the range;
- the same fits for the log size;
- heap per log byte.

Fits start at turn 200, which skips warm-up and V8 bytecode flushing (see the from-50 note below). [scripts/bench/heap-snapshot-summary.mts](../scripts/bench/heap-snapshot-summary.mts) builds the dominator tree of a `.heapsnapshot` and reports retained sizes:

- the Session;
- the slice `SessionFolder`;
- the slice read-history cache;
- per event type.

There are three arms:

- `slice`: the plugin with config `{}`;
- `stock`: the same driver without the plugin, so fold does not run;
- `slice-recall`: `slice` plus a `recall_turn` and an `expand_result` call every 20 turns.

Variants:

- `--no-invariants`;
- `--config '{"fold":{"enabled":false}}'`;
- `--persist <dir>` (JSONL, uncompressed).

```sh
node --expose-gc --import tsx scripts/bench/heap-growth.mts --arm slice --turns 800 --every 25 --seed 1 --out run.json
node --import tsx scripts/bench/heap-fit.mts --from 200 run*.json
node --expose-gc --import tsx scripts/bench/heap-growth.mts --arm slice --turns 800 --heap-snapshots 400,800 --snapshot-dir snap --out s.json
node --max-old-space-size=8192 --import tsx scripts/bench/heap-snapshot-summary.mts snap/slice-s1-t800.heapsnapshot
```

## Results

### Heap after GC (MB), 800 turns, two seeds per arm, invariants on

| turn | slice s1 / s2 | stock s1 / s2 | slice-recall s1 / s2 | slice log MB | stock log MB | slice request chars | stock request chars |
|---|---|---|---|---|---|---|---|
| 0 | 16.3 / 16.3 | 16.1 / 16.1 | 16.3 / 16.3 | 0 | 0 | — | — |
| 100 | 27.1 / 27.0 | 24.0 / 23.9 | 27.3 / 27.3 | 5.51 | 4.11 | 270,752 | 3,168,866 |
| 200 | 36.0 / 36.0 | 29.2 / 29.2 | 36.4 / 36.5 | 11.01 | 8.19 | 544,430 | 6,339,013 |
| 400 | 53.6 / 53.5 | 42.1 / 42.1 | 54.5 / 54.4 | 22.18 | 16.48 | 1,090,637 | 12,785,933 |
| 600 | 71.1 / 71.0 | 54.9 / 54.9 | 72.2 / 72.2 | 33.28 | 24.71 | 1,631,047 | 19,152,315 |
| 800 | 88.6 / 88.6 | 67.7 / 67.8 | 89.0 / 90.2 | 44.34 | 32.93 | 2,175,889 | 25,575,561 |

On the slice surface there is always exactly one runtime-context snapshot, the live one, plus one entry per sealed turn. On the stock surface there is one snapshot per turn: 800 at turn 800.

### Fits (turn ≥ 200)

| run | b MB/turn | linear R² | c MB/turn² | t(c) | c·T² MB | Δheap/turn, first → last quarter | log b MB/turn | heap per log byte |
|---|---|---|---|---|---|---|---|---|
| slice s1 | 0.0878 | 0.99998 | −6.1e−7 | −1.1 | −0.39 | 0.0887 → 0.0869 | 0.0555 | 1.58 |
| slice s2 | 0.0878 | 0.99997 | 8.0e−8 | 0.1 | 0.05 | 0.0887 → 0.0875 | 0.0556 | 1.58 |
| stock s1 | 0.0641 | 0.99999 | −2.3e−7 | −0.7 | −0.14 | 0.0647 → 0.0647 | 0.0412 | 1.56 |
| stock s2 | 0.0642 | 0.99999 | 3.5e−7 | 1.1 | 0.22 | 0.0647 → 0.0650 | 0.0413 | 1.56 |
| slice-recall s1 | 0.0883 | 0.99956 | −8.5e−6 | −5.0 | −5.41 | 0.0907 → 0.0811 | 0.0565 | 1.56 |
| slice-recall s2 | 0.0897 | 0.99997 | 9.5e−8 | 0.1 | 0.06 | 0.0905 → 0.0894 | 0.0566 | 1.59 |
| slice s3, 2000 turns | 0.0866 | 0.99994 | 5.7e−7 | 2.5 | 2.29 | 0.0878 → 0.0863 | 0.0556 | 1.56 |
| slice-recall s3, 2000 turns | 0.0886 | 0.99995 | 8.0e−7 | 4.3 | 3.19 | 0.0874 → 0.0883 | 0.0566 | 1.57 |
| stock s3, 1200 turns | 0.0641 | 1.00000 | −3.3e−8 | −0.3 | −0.05 | 0.0645 → 0.0645 | 0.0412 | 1.55 |
| slice, persist, no invariants, s3, 2000 turns | 0.0869 | 0.99994 | 7.7e−7 | 4.0 | 3.09 | 0.0853 → 0.0863 | 0.0556 | 1.56 |

What the fits show:

- **Linear in every run.** The quadratic term is insignificant at 800 turns, except slice-recall s1. That run's c is negative, which is sublinear: a one-off dip between turns 700 and 725.
- **A faint convexity at 2000 turns.** In the 2000-turn slice runs, c is about 6–8e−7 MB/turn². That adds 2–3 MB by turn 2000, which is 1.3–1.8% of the 175 MB growth. The per-turn increment changes by −1.7% to +1.0% between the first and last quarter.
- **Content explains part of it.** The log itself shows `c·T²` ≈ +0.26 MB, because seq numbers in locators gain digits. Stock shows none at 1200 turns.
- **Order of magnitude.** If the term were real, it would add about 70 MB at 10,000 turns against about 870 MB of linear growth.
- **From turn 50.** Fitting from turn 50 gives stock a positive c, with t of about 4.5 and +2.9 MB by turn 800. A single early dip causes it: the increment over turns 125–150 is 18 KB/turn against about 64 KB/turn elsewhere, which matches V8 flushing startup bytecode. From turn 200 that term is gone.
- **Heap tracks the log.** Heap is a constant 1.56–1.59 bytes per JSON byte of the event log in every arm.

### Where the heap is (dominator tree, slice s1 vs stock s1)

| | slice t400 | slice t800 | stock t400 | stock t800 |
|---|---|---|---|---|
| total retained | 55.7 | 89.9 | 44.6 | 70.3 |
| Session (event log, surface, derived messages) | 33.4 | 66.9 | 25.5 | 50.9 |
| of which tool/result originals | 16.7 | 33.4 | shared¹ | shared¹ |
| of which fold views (tool/result replacements) | 2.6 | 5.2 | — | — |
| of which assistant/message (text, reasoning, stream) | 6.2 | 12.4 | 4.5 | 9.1 |
| of which request/header (1221 events at t800) | 0.22 | 0.45 | 0 | 0 |
| of which tape entries (user/message replacements) | — | 0.27 | — | — |
| slice SessionFolder (fold state) | 0.48 | 0.97 | — | — |
| slice read-history cache ([src/context-reads.ts](../src/context-reads.ts)) | 0.67 | 1.34 | — | — |

¹ Under the stock arm, tool results and entry texts are still referenced by the surface's derived messages, so the Session dominates them directly rather than through the individual events.

Per turn over 400 → 800:

- Session: slice +83.7 KB, stock +63.5 KB;
- slice's own per-session indexes: +2.9 KB (SessionFolder 1.2 KB, read-history cache 1.7 KB);
- everything outside the Session and the indexes is flat. Code shrinks slightly as V8 flushes bytecode.

### Splitting the slice − stock slope (no invariants, seed 1)

| arm | MB/turn |
|---|---|
| stock | 0.0641 |
| slice, `fold.enabled: false` | 0.0759 (+0.0118 from sealing) |
| slice, default | 0.0878 (+0.0119 from fold) |

Sealing writes:

- one tape entry per turn;
- about 1.5 extra `request/header` "series" events per turn. Each seal and each fold replacement bumps `surface.contentGeneration`, and the loop then re-logs the full header with all tool schemas: 9.2 KB/turn of JSON, but only about 0.6 KB/turn of heap, because the schema strings are shared;
- read-history index entries.

Fold writes:

- one replacement event per large result: 486 in 800 turns, 6.6 KB/turn retained;
- its `SessionFolder` entries.

### Variants

- **Invariants** change no memory. Heap is 88.4 vs 88.6 MB (slice) and 68.8 vs 67.7 MB (stock) at turn 800. They dominate CPU, though: the agent-loop invariant re-folds the whole log and `JSON.stringify`s both the request and its re-derivation on every request. Stock at 800 turns takes 193 s with invariants and 10 s without; slice takes 25 s and 12 s. In a CPU profile of slice with invariants, 46% of samples fall in that hook, 8% in slice `inspectSurface` and 5% in `foldRequestHeader`. Wall time per turn grows linearly with session length in every arm, which is O(N) scans per turn. That is a CPU cost, not a retained-memory cost.
- **Persistence** (`--persist`, JSONL) retains nothing once drained. Heap is 87.9 MB at 800 turns and 192.4 MB at 2000, matching the runs without persistence. Without the drain the curve is a sawtooth up to +40 MB. The writer buffers `structuredClone` copies of live events for a 200 ms batching window, and a scripted turn takes milliseconds. In real use that window holds a few events. That raw run is kept as `slice-persist-s1-noflush.json`.
- **Recall** (`slice-recall`) changes nothing measurable: +0.001 MB/turn. Recall pages are ordinary tool results in the log.
- **RSS** at turn 800 is about 200 MB for slice and 268 MB for stock. RSS is a high-water mark of transient buffers: the 25 MB stock request, the invariant's stringification and the benchmark's own measurement. It does not measure retained memory. The live slicey-dsh host (PID 58905, up about 9 days, DSH 0.2.0-rc.2) showed 19.9 MB RSS in `ps` on 2026-10-22.

## What `tests/unit.test.ts` "plateaus instead of growing linearly" measures

It measures `tapeChars(c.sessionTape)` of `src/lab/continuity.ts`, the retired lab continuity tape. That code is unreachable from `src/index.ts` and excluded from `lib/`. The test therefore measures string length in a lab structure. It measures neither heap nor the production policy in [src/context.ts](../src/context.ts).

The production tape does not plateau, by design: the code says "there is no request budget … entries accumulate". The request grows about 2.7 K chars per turn: 2.18 M chars at turn 800 and 5.46 M at turn 2000 in this benchmark. The context window, which belongs to the host, is the limit long before heap is.

## Caveats

- **Composition.** This is the minimal harness composition. The CLI bundle adds compaction, spill and output-retention plugins, which this benchmark does not measure.
- **Invariants.** These runs used DSH 0.2.0-rc.2 and mounted its three stock invariant plugins. DSH 0.2.1 removed those plugins, so the benchmark now mounts the test-owned request check from [tests/request-reconstruction.ts](../tests/request-reconstruction.ts) instead, on either host, and `invariants: true` in a run's `meta` means only that check. The "invariants on" CPU and wall-time figures in this record are not comparable with runs made after that change.
- **Content profile.** The profile is synthetic: about 57 KB of log JSON per turn under slice. Heap scales with the log, so a heavier session scales the slope, not its shape.
- **Stock baseline.** The stock arm is a heap baseline only. Its 25 M-char request at turn 800 would be far past any model's context window.
- **Old regime.** The 2026-09-11 builds were not re-run; they need the DSH builds of that time. "Does not reproduce" means the current code under this driver.
- **Wall times.** Some runs overlapped with others, so wall times are indicative only. Heap is per-process and unaffected.

## Possible follow-ups (none needed for superlinearity)

1. **Make `inspectSurface` incremental.** It rescans `session.snapshotEvents()` and the whole surface on every turn. A cursor-based index, like `readHistory`'s, would remove slice's O(N)-per-turn CPU. It would also drop one more reader of the deprecated `snapshotEvents`/`eventAt`, which is the prerequisite if the host stops keeping the whole log in memory. That host change is the only lever on the ~97% of heap that is the log.
2. **Prune the slice indexes.** The `SessionFolder.calls` and read-history `calls`/`roots` maps keep every call ever made. Settled calls could be dropped, saving ~2.9 KB/turn (2.3 MB at 800 turns). This is low value.
3. **Cut the "series" header events.** One option is to apply seal and fold replacements in the same pre-step, so a turn bumps `contentGeneration` once rather than 1.5 times. Another is to ask the host to log a series marker that references the previous header instead of a full copy. Either saves up to 9 KB/turn on disk (16% of slice's log bytes). The heap saving is small.
4. **Replace or rename the unit-test "plateau" gate.** One option is a check over the native path, for example: the last-quarter increment of `heap-growth.mts --turns 200` is at most 1.2× the first quarter.

Raw data for every run, the fit tables, the heap snapshots and their summaries, and the CPU profile were kept outside the repository, in the session scratchpad (`heap/data`, `heap/snap`, `heap/prof`).
