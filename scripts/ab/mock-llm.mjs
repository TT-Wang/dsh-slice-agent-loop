// Scripted offline LLM adapter for P1-10 harness dry runs. Registers provider 'ab-mock'; no network.
// run_ab.py --offline mounts it through a generated eval-offline.patch.yml (see that template).
//
// Default script, per turn (one action per model request, then a text closeout):
//   1. bash `ls`;
//   1b. when the prompt states a correction ("应该是 X,不是 Y" / "should be X, not Y") and names an existing config
//      file (.env/.ini/.txt/.json), bash replaces Y with X in it, as r2's T4 asks before re-running its script;
//   2. when the user prompt names an existing script under tools/ (anywhere in the prompt), bash `python3 <it>`
//      (plus the prompt's `--region R`), so the tasks' delivery turns show its output as a real run does
//      (r2's T4 names config/service.env before tools/stamp.py);
//   3. `read` that file;
//   4. `read` it again (a same-turn unchanged re-read, so the metric has data);
//   5. expand_result on the newest tape tool line, parsed in whichever form the arm renders
//      (`expand_result({"seq":N,"formatVersion":V})` or `seq N · … · vV]`);
//   6. text "MOCK-DONE".
// Inapplicable actions are skipped. The MOCK-* keywords keep the scouting probes working.
//
// Isolation probe (run_ab.py isolation-probe): a prompt starting "[isolation-probe]" lists one action per line,
// `BASH: <command>`, `READ: <path>`, `GLOB: <dir>` (pattern **/*) or `GREP: <dir>` (pattern CANARY); the mock issues
// them in order, one per request, then closes with "MOCK-DONE".
//
// Compaction (slice-vs-stock, 2026-10-23): the adapter declares deepseek-flash's capacity (context window
// 1,000,000, default maxTokens 256,000), so compaction-basic resolves the same trigger on the mock route as on
// the paid one; a request with purpose 'compaction' (the summarizer's own call) gets a short text summary.
// AB_MOCK_PRESSURE_TOKENS=N makes every usage sample report N input tokens, so the token meter reuses that figure
// as context pressure (it does when the sample is no lower than its own estimate) and the shipped threshold can be
// crossed, or not, on purpose (the forced-compaction dry runs).
//
// Failure injection (budget accounting tests): with AB_MOCK_FAIL_EVERY=N (N >= 2) the 1st, (N+1)th, ...
// request of each process ends with a retryable TRANSPORT error instead of its action, so the host
// records an assistant/attempt and retries. AB_MOCK_FAIL_USAGE=1 lets that failed attempt report a usage
// sample first; otherwise it reports none, and the headless --json projector then drops the usage of the
// whole step (its step_end carries no usage).
// AB_MOCK_QUOTA_FILE=<path>: while that file exists, every request ends with a non-retryable QUOTA error (HTTP 402
// "Insufficient Balance", as DeepSeek reports an exhausted balance), so the harness's account stop can be exercised.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, realpathSync, statSync } from 'node:fs'

// The adapter runs inside the headless host process: resolve dsh-llm from that host, never from a user install.
const host = createRequire(realpathSync(process.env.AB_DSH_BIN ?? process.argv[1] ?? ''))
/** @type {typeof import('@deepseek-ai/dsh-llm')} */
const llm = await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-llm')).href)
export const name = 'ab-mock-llm'
export const inject = ['llm']
let n = 0
let requests = 0
const pressure = Number(process.env.AB_MOCK_PRESSURE_TOKENS ?? 0)
/** @param {number} i @returns {import('@deepseek-ai/dsh-llm').StreamChunk} */
const usage = i => ({ type: 'usage', usage: pressure > 0
  ? { inputTokens: pressure, cacheReadTokens: 0, outputTokens: 7 }
  : { inputTokens: 100 + i, cacheReadTokens: 1000, outputTokens: 7 } })
/** @param {string} value @returns {import('@deepseek-ai/dsh-llm').StreamChunk[]} */
const text = value => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: value },
  { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  usage(value.length), { type: 'finish', reason: { kind: 'stop' } },
]
/** @param {string} tool @param {object} args @returns {import('@deepseek-ai/dsh-llm').StreamChunk[]} */
const call = (tool, args) => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: llm.ToolCallId(`mock-${++n}-${Date.now()}`), name: tool, arguments: JSON.stringify(args) } },
  usage(0), { type: 'finish', reason: { kind: 'tool-calls' } },
]
/** A retryable transport failure that ends an attempt (AB_MOCK_FAIL_EVERY). @type {import('@deepseek-ai/dsh-llm').StreamChunk} */
const transportDrop = { type: 'finish', reason: { kind: 'error', failure: { message: 'mock transport drop', code: 'TRANSPORT' } } }
/** An account-level refusal (AB_MOCK_QUOTA_FILE). @type {import('@deepseek-ai/dsh-llm').StreamChunk} */
const quotaRefusal = { type: 'finish', reason: { kind: 'error', failure: { message: 'Insufficient Balance (mock)', code: 'QUOTA', status: 402 } } }
/** @param {any} message @returns {string[]} */
const texts = message => (message?.content ?? []).flatMap((/** @type {any} */ b) => (b.type === 'text' ? [b.text] : []))
/** @param {any} message @returns {string|undefined} */
const kind = message => (typeof message?.source?.kind === 'string' ? message.source.kind : undefined)

/**
 * Newest tape tool-line locator, in either arm's rendering.
 * @param {string} tape @returns {{seq:number, formatVersion:number}|undefined}
 */
function tapeLocator(tape) {
  /** @type {{seq:number, formatVersion:number, at:number}[]} */
  const found = []
  for (const m of tape.matchAll(/\[tool turn \d+ step \d+ seq (\d+) · [^\]\n]*?(?:expand_result\(\{"seq":\d+,"formatVersion":(\d+)\}\)|· v(\d+))\]/g)) {
    found.push({ seq: Number(m[1]), formatVersion: Number(m[2] ?? m[3]), at: m.index ?? 0 })
  }
  const last = found.at(-1)
  return last && { seq: last.seq, formatVersion: last.formatVersion }
}

/**
 * First file named in the prompt that exists under the session cwd (the headless cwd is the workdir) and, when
 * given, matches `only`.
 * @param {string} ask @param {RegExp} [only] @returns {string|undefined}
 */
function namedFile(ask, only) {
  for (const m of ask.matchAll(/[\w./-]+\.(?:py|txt|md|json|csv|env|ini|log|toml)\b/g)) {
    const path = m[0].replace(/^\.\//, '')
    if (only && !only.test(path)) continue
    try { if (existsSync(path) && statSync(path).isFile()) return path } catch { /* not a file */ }
  }
  return undefined
}

/** @param {import('@deepseek-ai/cordis').Context & {llm: any}} ctx */
export function apply(ctx) {
  class Adapter extends llm.LlmAdapter {
    /** @param {string} provider @param {string} model @returns {Promise<any>} */
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 1_000_000 }, defaultMaxTokens: 256_000, reasoning: { efforts: [{ id: llm.ReasoningEffortId('high'), name: 'High' }], defaultEffort: llm.ReasoningEffortId('high') } }
    }

    /** @param {import('@deepseek-ai/dsh-llm').GenerateOptions} request */
    async *stream(request) {
      const msgs = request.messages
      let u = msgs.length - 1
      while (u >= 0 && !(msgs[u]?.role === 'user' && kind(msgs[u]) === 'user')) u -= 1
      const ask = texts(msgs[u]).join('\n')
      const after = msgs.slice(u + 1).filter(m => m.role === 'assistant').length
      const all = msgs.map(m => texts(m).join('\n')).join('\n')
      const tape = msgs.filter(m => kind(m) === 'plugin:slice:history').map(m => texts(m).join('\n')).join('\n')
      /** @type {import('@deepseek-ai/dsh-llm').StreamChunk[]} */
      let out
      if (request.purpose === 'compaction') {
        // The summarizer's call (compaction-basic): one short text checkpoint, no tool call.
        out = text(`MOCK-SUMMARY of ${msgs.length} messages`)
      } else if (ask.startsWith('[isolation-probe]')) {
        /** @type {Array<() => import('@deepseek-ai/dsh-llm').StreamChunk[]>} */
        const actions = []
        for (const line of ask.split('\n').slice(1)) {
          const m = /^(BASH|READ|GLOB|GREP): (.+)$/.exec(line)
          if (!m) continue
          const [, op, arg] = m
          if (op === 'BASH') actions.push(() => call('bash', { command: arg, description: 'isolation probe' }))
          else if (op === 'READ') actions.push(() => call('read', { file_path: arg }))
          else if (op === 'GLOB') actions.push(() => call('glob', { pattern: '**/*', path: arg }))
          else actions.push(() => call('grep', { pattern: 'CANARY', path: arg }))
        }
        const next = actions[after]
        out = next ? next() : text('MOCK-DONE')
      } else if (/MOCK-(RUN|READ|BADVER|RECALL|TURN)/.test(ask)) {
        if (after > 0) out = text('MOCK-DONE')
        else if (ask.includes('MOCK-RUN')) out = call('bash', { command: 'cat data.txt', description: 'read data' })
        else if (ask.includes('MOCK-READ')) out = call('read', { file_path: 'data.txt' })
        else if (ask.includes('MOCK-BADVER')) out = call('expand_result', { seq: tapeLocator(all)?.seq ?? 1, formatVersion: 3 })
        else if (ask.includes('MOCK-RECALL')) out = call('expand_result', tapeLocator(tape) ?? { seq: 1, formatVersion: 4 })
        else out = call('recall_turn', { turn: '1' })
      } else {
        const file = namedFile(ask)
        const tool = namedFile(ask, /^tools\/[\w-]+\.py$/)
        const locator = tapeLocator(tape)
        /** @type {Array<() => import('@deepseek-ai/dsh-llm').StreamChunk[]>} */
        const script = [() => call('bash', { command: 'ls', description: 'list the workspace' })]
        const fix = /应该是\s*([\w.-]+)\s*[,，]\s*不是\s*([\w.-]+)/.exec(ask) ?? /should be ([\w.-]+), not ([\w.-]+)/.exec(ask)
        const target = fix && namedFile(ask, /\.(?:env|ini|txt|json)$/)
        if (fix && target) {
          const py = `import pathlib; p = pathlib.Path('${target}'); p.write_text(p.read_text().replace('${fix[2]}', '${fix[1]}'))`
          script.push(() => call('bash', { command: `python3 -c "${py}"`, description: 'apply the correction' }))
        }
        if (tool) {
          const region = /--region (\w+)/.exec(ask)?.[1]
          script.push(() => call('bash', { command: `python3 ${tool}${region ? ` --region ${region}` : ''}`, description: 'run the script' }))
        }
        if (file) script.push(() => call('read', { file_path: file }), () => call('read', { file_path: file }))
        if (locator) script.push(() => call('expand_result', locator))
        const next = script[after]
        out = next ? next() : text('MOCK-DONE')
      }
      // AB_MOCK_DELAY_MS slows every request, so the harness's mid-turn budget kill can be exercised offline.
      const delay = Number(process.env.AB_MOCK_DELAY_MS ?? 0)
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      requests += 1
      const quotaFile = process.env.AB_MOCK_QUOTA_FILE
      if (quotaFile && existsSync(quotaFile)) {
        yield quotaRefusal
        return
      }
      const failEvery = Number(process.env.AB_MOCK_FAIL_EVERY ?? 0)
      if (failEvery >= 2 && requests % failEvery === 1) {
        if (process.env.AB_MOCK_FAIL_USAGE === '1') yield usage(1000)
        yield transportDrop
        return
      }
      for (const chunk of out) yield chunk
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['ab-mock'], new Adapter()))
}
