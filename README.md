# dsh-slice-agent-loop

English | [中文](README.zh.md)

A drop-in agent loop for the [DeepSeek Harness](https://github.com/dsh2026)
whose context is a **bounded slice**, not a growing transcript. Each turn's
context is rebuilt to the size of the current task: over a measured 600-turn
session the peak plateaus around 120k characters instead of growing without
bound. Early beta; tracks DSH snapshot `20260811T152241Z`.

## Architecture

**Session tape.** An append-only ledger of sealed turns: digests of what was
asked and done, file baselines with the patches already applied, and replies.
The tape — not the transcript — is what rides in context, so the peak stays
bounded no matter how long the session runs.

**Memory recall.** Nothing is lost at the cut. Long content is truncated in
the tape with an exact marker, and the full text stays durable in the session
log: `recall_turn` returns any earlier turn verbatim, `recall_search` finds
which turn said something. Bounded context, lossless history.

## Install

```sh
dsh plugin --profile <name> add "github:dsh-external/dsh-slice-agent-loop#main"
```

The bundled patch disables the stock loop and compaction — the bounded rebuild
replaces both. If your composition carries an `agent-loop-invariant` row,
remove it: a rebuilt slice cannot equal the derived history byte-for-byte, and
this plugin refuses to load beside that assertion. A transient
`SSL_ERROR_SYSCALL` during the git fetch (common behind proxies) is not a
failed install — re-run the same command; it is idempotent.

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
