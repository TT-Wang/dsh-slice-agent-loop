// Scripted offline LLM adapter for P1-10 harness dry runs. Registers provider 'ab-mock'; no network.
// run_ab.py --offline mounts it through a generated eval-offline.patch.yml (see that template).
//
// Default script, per turn (one action per model request, then a text closeout):
//   1. bash `ls`;
//   2. `read` the first existing file the user prompt names;
//   3. `read` it again (a same-turn unchanged re-read, so the metric has data);
//   4. expand_result on the newest tape tool line, parsed in whichever form the arm renders
//      (`expand_result({"seq":N,"formatVersion":V})` or `seq N · … · vV]`);
//   5. text "MOCK-DONE".
// Inapplicable actions are skipped. The MOCK-* keywords keep the scouting probes working.
//
// Failure injection (budget accounting tests): with AB_MOCK_FAIL_EVERY=N (N >= 2) the 1st, (N+1)th, ...
// request of each process ends with a retryable TRANSPORT error instead of its action, so the host
// records an assistant/attempt and retries. AB_MOCK_FAIL_USAGE=1 lets that failed attempt report a usage
// sample first; otherwise it reports none, and the headless --json projector then drops the usage of the
// whole step (its step_end carries no usage).
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
/** @param {number} i @returns {import('@deepseek-ai/dsh-llm').StreamChunk} */
const usage = i => ({ type: 'usage', usage: { inputTokens: 100 + i, cacheReadTokens: 1000, outputTokens: 7 } })
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
 * First file named in the prompt that exists under the session cwd (the headless cwd is the workdir).
 * @param {string} ask @returns {string|undefined}
 */
function namedFile(ask) {
  for (const m of ask.matchAll(/[\w./-]+\.(?:py|txt|md|json|csv|env|ini)\b/g)) {
    const path = m[0].replace(/^\.\//, '')
    try { if (existsSync(path) && statSync(path).isFile()) return path } catch { /* not a file */ }
  }
  return undefined
}

/** @param {import('@deepseek-ai/cordis').Context & {llm: any}} ctx */
export function apply(ctx) {
  class Adapter extends llm.LlmAdapter {
    /** @param {string} provider @param {string} model @returns {Promise<any>} */
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, inputModalities: ['text'], reasoning: { efforts: [{ id: llm.ReasoningEffortId('high'), name: 'High' }], defaultEffort: llm.ReasoningEffortId('high') } }
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
      if (/MOCK-(RUN|READ|BADVER|RECALL|TURN)/.test(ask)) {
        if (after > 0) out = text('MOCK-DONE')
        else if (ask.includes('MOCK-RUN')) out = call('bash', { command: 'cat data.txt', description: 'read data' })
        else if (ask.includes('MOCK-READ')) out = call('read', { file_path: 'data.txt' })
        else if (ask.includes('MOCK-BADVER')) out = call('expand_result', { seq: tapeLocator(all)?.seq ?? 1, formatVersion: 3 })
        else if (ask.includes('MOCK-RECALL')) out = call('expand_result', tapeLocator(tape) ?? { seq: 1, formatVersion: 4 })
        else out = call('recall_turn', { turn: '1' })
      } else {
        const file = namedFile(ask)
        const locator = tapeLocator(tape)
        /** @type {Array<() => import('@deepseek-ai/dsh-llm').StreamChunk[]>} */
        const script = [() => call('bash', { command: 'ls', description: 'list the workspace' })]
        if (file) script.push(() => call('read', { file_path: file }), () => call('read', { file_path: file }))
        if (locator) script.push(() => call('expand_result', locator))
        const next = script[after]
        out = next ? next() : text('MOCK-DONE')
      }
      // AB_MOCK_DELAY_MS slows every request, so the harness's mid-turn budget kill can be exercised offline.
      const delay = Number(process.env.AB_MOCK_DELAY_MS ?? 0)
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      requests += 1
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
