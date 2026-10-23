// Offline adapter variant for the svs2 working-set demonstration (docs/svs2-ablation-2026-10-24.md §12): mock-llm.mjs
// unchanged, plus one coding move per turn. Where mock-llm.mjs would close a turn with its text "MOCK-DONE", this
// variant first issues a `read` of the first existing `.py` file outside tools/ that the user prompt names (c1:
// calc.py) and then an `edit` of it, which appends a comment to one line that occurs once in the file. So a turn
// changes a file it has just viewed whole, as a real coding turn does, and arm C's retention has a file to keep.
// Offline only: run_ab.py mounts it instead of mock-llm.mjs when AB_MOCK_ADAPTER=mock-llm-edit.mjs (recorded in the
// manifest's mock_env); paid cells never mount a mock. Every other request is mock-llm.mjs's own answer.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import * as base from './mock-llm.mjs'

const host = createRequire(realpathSync(process.env.AB_DSH_BIN ?? process.argv[1] ?? ''))
/** @type {typeof import('@deepseek-ai/dsh-llm')} */
const llm = await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-llm')).href)
export const name = 'ab-mock-llm-edit'
export const inject = base.inject
export const MARK = '  # svs2 mock edit'
let n = 0

/** @param {string} tool @param {object} args @returns {import('@deepseek-ai/dsh-llm').StreamChunk[]} */
const call = (tool, args) => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: llm.ToolCallId(`mock-edit-${++n}-${Date.now()}`), name: tool, arguments: JSON.stringify(args) } },
  { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 1000, outputTokens: 7 } }, { type: 'finish', reason: { kind: 'tool-calls' } },
]
/** @param {any} message @returns {string[]} */
const texts = message => (message?.content ?? []).flatMap((/** @type {any} */ b) => (b.type === 'text' ? [b.text] : []))

/** The first existing .py file outside tools/ that the prompt names (paths relative to the session cwd, the workdir). */
function target(/** @type {string} */ ask) {
  for (const m of ask.matchAll(/[\w./-]+\.py\b/g)) {
    const path = m[0].replace(/^\.\//, '')
    if (path.startsWith('tools/')) continue
    try { if (existsSync(path) && statSync(path).isFile()) return path } catch { /* not a file */ }
  }
  return undefined
}

/** A line that occurs once in the file and can take a trailing comment, or undefined. */
function uniqueLine(/** @type {string} */ content) {
  for (const line of content.split('\n')) {
    if (!line.trim() || line.trimEnd().endsWith('\\')) continue
    if (content.split(line).length === 2) return line
  }
  return undefined
}

/**
 * The read or the edit this turn still needs, or undefined: one edit per turn, right after a read of the target.
 * @param {any[]} msgs @returns {import('@deepseek-ai/dsh-llm').StreamChunk[]|undefined}
 */
function nextMove(msgs) {
  let u = msgs.length - 1
  while (u >= 0 && !(msgs[u]?.role === 'user' && msgs[u]?.source?.kind === 'user')) u -= 1
  if (u < 0) return undefined
  const ask = texts(msgs[u]).join('\n')
  if (ask.startsWith('[isolation-probe]') || /MOCK-(RUN|READ|BADVER|RECALL|TURN)/.test(ask)) return undefined
  const file = target(ask)
  if (!file) return undefined
  const calls = msgs.slice(u + 1).filter(m => m.role === 'assistant').flatMap(m => (m.content ?? []).filter((/** @type {any} */ b) => b.type === 'tool-call'))
  if (calls.some(c => c.name === 'edit')) return undefined
  const last = calls.at(-1)
  let args = {}
  try { args = JSON.parse(last?.arguments ?? '{}') } catch { /* not JSON */ }
  if (last?.name !== 'read' || /** @type {any} */ (args).file_path !== file) return call('read', { file_path: file })
  const line = uniqueLine(readFileSync(file, 'utf8'))
  return line === undefined ? undefined : call('edit', { file_path: file, old_string: line, new_string: `${line}${MARK}` })
}

/** The base adapter, with its closing text replaced by the coding move while one is due. */
function editing(/** @type {any} */ adapter) {
  const wrapped = Object.create(adapter)
  wrapped.stream = async function* (/** @type {import('@deepseek-ai/dsh-llm').GenerateOptions} */ request) {
    /** @type {import('@deepseek-ai/dsh-llm').StreamChunk[]} */
    const chunks = []
    for await (const chunk of adapter.stream(request)) chunks.push(chunk)
    const closing = request.purpose !== 'compaction' && chunks.some((/** @type {any} */ c) => c.type === 'block-end' && c.block?.type === 'text' && c.block.text === 'MOCK-DONE')
    const move = closing ? nextMove(/** @type {any[]} */ (request.messages)) : undefined
    for (const chunk of move ?? chunks) yield chunk
  }
  return wrapped
}

/** @param {import('@deepseek-ai/cordis').Context & {llm: any}} ctx */
export function apply(ctx) {
  const bind = (/** @type {any} */ target, /** @type {PropertyKey} */ key) => { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value }
  const registry = new Proxy(ctx.llm, { get: (t, k) => k === 'registerAdapter' ? (/** @type {any} */ ids, /** @type {any} */ adapter) => t.registerAdapter(ids, editing(adapter)) : bind(t, k) })
  base.apply(/** @type {any} */ (new Proxy(ctx, { get: (t, k) => k === 'llm' ? registry : bind(t, k) })))
}
