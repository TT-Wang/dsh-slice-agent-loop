/**
 * Heap growth of one long session in one process (2026-10-22).
 *
 * Drives the stock DSH agent loop (the same composition as tests/native-harness.ts)
 * with a scripted model adapter for N turns and records heapUsed after forced GC
 * at checkpoints. Nothing the driver keeps grows with the turn count: responses are
 * generated per turn, requests are measured (on checkpoint turns only) and dropped,
 * and no event snapshot is cloned. Whatever grows is the host, the plugin or V8.
 *
 *   node --expose-gc --import tsx scripts/bench/heap-growth.mts \
 *     --arm slice|stock|slice-recall --turns 800 --every 25 --out run.json
 *   [--config '{"fold":{"enabled":false}}'] [--no-invariants] [--persist dir]
 *   [--heap-snapshots 400,800 --snapshot-dir dir]
 *
 * Arms: `slice` mounts the slice plugin with --config (default {}); `stock` omits it (same
 * driver, same content; fold does not run, so large results stay raw); `slice-recall`
 * is `slice` plus one recall_turn + expand_result step every --recall-every turns.
 *
 * Per turn: one human message, a runtime-context {{tick}} change, three or four model
 * steps with reasoning, two parallel tool calls (a ~4 KB source read and a grep), a
 * test-run log (~2 KB, or ~40 KB every third turn) and every fifth turn a ~20 KB
 * document read, then a ~1 KB reply. Content is pseudo-random per (seed, turn), so no
 * two turns share strings. Analyse the output with scripts/bench/heap-fit.mts.
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { getHeapSpaceStatistics, writeHeapSnapshot } from 'node:v8'
import SliceLoopPlugin, { type Config } from '../../src/index.ts'
import { JsonlPersistence } from '../../tests/native-harness.ts'
import { requireReconstructableRequests } from '../../tests/request-reconstruction.ts'

const { values: opt } = parseArgs({
  options: {
    arm: { type: 'string', default: 'slice' },
    turns: { type: 'string', default: '400' },
    every: { type: 'string', default: '25' },
    seed: { type: 'string', default: '1' },
    out: { type: 'string' },
    'recall-every': { type: 'string', default: '20' },
    'no-invariants': { type: 'boolean', default: false },
    config: { type: 'string', default: '{}' },
    persist: { type: 'string' },
    'heap-snapshots': { type: 'string' },
    'snapshot-dir': { type: 'string' },
    quiet: { type: 'boolean', default: false },
  },
})

type Arm = 'slice' | 'stock' | 'slice-recall'
const arm = opt.arm as Arm
if (!['slice', 'stock', 'slice-recall'].includes(arm)) throw new Error(`unknown arm ${arm}`)
const TURNS = Number(opt.turns)
const EVERY = Number(opt.every)
const SEED = Number(opt.seed)
const RECALL_EVERY = Number(opt['recall-every'])
const SNAPSHOT_TURNS = new Set((opt['heap-snapshots'] ?? '').split(',').filter(Boolean).map(Number))
const gc = (globalThis as { gc?: () => void }).gc
if (gc === undefined) throw new Error('run with node --expose-gc')

// ------------------------------------------------------------------ content

/** mulberry32 over a 32-bit mix of (seed, turn, slot): deterministic, distinct per turn. */
function rng(turn: number, slot: number): () => number {
  let a = (SEED * 0x9e3779b1 ^ turn * 0x85ebca77 ^ slot * 0xc2b2ae3d) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const WORDS = ('the a session turn request result value config parser module context cache build test log error '
  + 'retry stream token budget seal tape recall entry window prefix fold digest index file path line commit '
  + 'branch merge review deploy runtime snapshot schema event handler service plugin adapter model user agent '
  + 'policy limit option default field record report metric heap growth memory process worker queue task').split(' ')
function words(r: () => number, n: number): string {
  const out: string[] = []
  for (let i = 0; i < n; i += 1) out.push(WORDS[Math.floor(r() * WORDS.length)]!)
  return out.join(' ')
}
function prose(r: () => number, chars: number): string {
  let text = ''
  while (text.length < chars) text += `${words(r, 8 + Math.floor(r() * 10))}. `
  return text.slice(0, chars)
}
function ident(r: () => number): string { return `${WORDS[Math.floor(r() * WORDS.length)]}_${Math.floor(r() * 1e6).toString(36)}` }

function sourceFile(turn: number, chars: number): string {
  const r = rng(turn, 1)
  const lines: string[] = [`// module ${turn}`, `import { ${ident(r)}, ${ident(r)} } from './${ident(r)}.js'`, '']
  let size = 0
  while (size < chars) {
    const block = [
      `export function ${ident(r)}(${ident(r)}: number, ${ident(r)}: string): string {`,
      `  const ${ident(r)} = ${Math.floor(r() * 1000)} + ${ident(r)}.length`,
      `  if (${ident(r)} > ${Math.floor(r() * 100)}) {`,
      `    return \`${words(r, 6)} \${${ident(r)}}\``,
      '  }',
      `  return '${words(r, 5)}'`,
      '}',
      '',
    ]
    lines.push(...block)
    size += block.join('\n').length
  }
  return lines.join('\n')
}
function grepOutput(turn: number, matches: number): string {
  const r = rng(turn, 2)
  return Array.from({ length: matches }, () =>
    `src/${ident(r)}/${ident(r)}.ts:${1 + Math.floor(r() * 900)}:  const ${ident(r)} = ${ident(r)}(${words(r, 3).replace(/ /g, ', ')})`).join('\n')
}
function testLog(turn: number, chars: number): string {
  const r = rng(turn, 3)
  const lines: string[] = [`> pnpm test --filter ${ident(r)}`, '']
  let size = 0
  let n = 0
  while (size < chars) {
    n += 1
    const roll = r()
    const stamp = `2026-10-22T${String(10 + (n % 10)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}:${String(Math.floor(r() * 60)).padStart(2, '0')}`
    const line = roll < 0.04
      ? `${stamp} ERROR ${ident(r)} failed: expected ${Math.floor(r() * 100)} to equal ${Math.floor(r() * 100)} (${words(r, 4)})`
      : roll < 0.08 ? `${stamp} WARN ${words(r, 7)}` : `${stamp} INFO ✓ ${words(r, 6)} (${Math.floor(r() * 90)}ms)`
    lines.push(line)
    size += line.length + 1
  }
  lines.push('', ` Test Files  ${Math.floor(r() * 3)} failed | ${20 + Math.floor(r() * 40)} passed`, ` Tests  ${n} total`)
  return lines.join('\n')
}
function documentText(turn: number, chars: number): string {
  const r = rng(turn, 4)
  const lines: string[] = [`# Specification ${turn}`, '']
  let size = 0
  let section = 0
  while (size < chars) {
    section += 1
    const block = [`## ${section}. ${words(r, 4)}`, '', prose(r, 300 + Math.floor(r() * 500)), '',
      `${ident(r)}: ${words(r, 3)}`, `${ident(r)} = ${Math.floor(r() * 1e4)}`, '']
    lines.push(...block)
    size += block.join('\n').length
  }
  return lines.join('\n')
}

// ------------------------------------------------------------------ model

interface Call { id: string; name: string; args: object }
function delta(kind: 'text' | 'reasoning', index: number, text: string): StreamChunk[] {
  // Real adapters stream many small deltas; the loop's accumulator compacts them.
  const chunks: StreamChunk[] = [{ type: 'block-start', index, blockType: kind }]
  for (let at = 0; at < text.length; at += 48) {
    const piece = text.slice(at, at + 48)
    chunks.push(kind === 'text' ? { type: 'text-delta', index, text: piece } : { type: 'reasoning-delta', index, text: piece })
  }
  chunks.push({ type: 'block-end', index, block: { type: kind, text } })
  return chunks
}
function response(reasoning: string, text: string, calls: readonly Call[]): StreamChunk[] {
  const chunks: StreamChunk[] = [...delta('reasoning', 0, reasoning)]
  let index = 1
  if (text) { chunks.push(...delta('text', index, text)); index += 1 }
  for (const call of calls) {
    chunks.push({ type: 'block-start', index, blockType: 'tool-call' },
      { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: JSON.stringify(call.args) } })
    index += 1
  }
  chunks.push({ type: 'usage', usage: { inputTokens: 1000, outputTokens: 200 } },
    { type: 'finish', reason: { kind: calls.length ? 'tool-calls' : 'stop' } })
  return chunks
}

/** Serves the current turn's queue; keeps no request. On demand, measures one request. */
class ScriptedAdapter extends LlmAdapter {
  queue: StreamChunk[][] = []
  measureNext = false
  measured: { messages: number; chars: number } | undefined
  requests = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: model, inputModalities: ['text'],
      reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }], defaultEffort: ReasoningEffortId('low') },
    })
  }

  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    if (this.measureNext) {
      this.measureNext = false
      this.measured = { messages: request.messages.length, chars: JSON.stringify(request.messages).length }
    }
    const next = this.queue.shift()
    if (next === undefined) throw new Error(`scripted adapter exhausted at request ${this.requests}`)
    for (const chunk of next) yield chunk
  }
}

// ------------------------------------------------------------------ composition

const ctx = new Context()
const adapter = new ScriptedAdapter()
const errors: unknown[] = []
const warns: string[] = []
ctx.logger.exporter({ levels: { default: 3 }, export(message) {
  if (message.type === 'warn' && warns.length < 50) warns.push(message.args.map(String).join(' ').slice(0, 300))
} })
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(SessionProjections)
await ctx.plugin(SystemPrompt, { personaPrefix: 'Heap-growth benchmark fixture.' })
await ctx.plugin(ToolRegistry)
await ctx.plugin(AgentRegistry)
if (opt.persist !== undefined) {
  mkdirSync(opt.persist, { recursive: true })
  await ctx.plugin(JsonlPersistence, { root: opt.persist, compression: 'none' })
}
await ctx.plugin(AgentLoop, { agents: [] })
// DSH 0.2.1 ships no runtime invariants. "Invariants" here is the test-owned request
// check that tests/native-harness.ts mounts on both hosts; the 2026-10-22 record was
// measured on 0.2.0-rc.2 with the three stock invariant plugins instead.
if (!opt['no-invariants']) requireReconstructableRequests(ctx)
const sliceConfig = JSON.parse(opt.config!) as Config
if (arm !== 'stock') await ctx.plugin(SliceLoopPlugin, sliceConfig)
ctx.llm.registerAdapter(['bench-mock'], adapter)
ctx.on('agent/error', ({ error }) => { if (errors.length < 20) errors.push(error) })

const content = (text: string) => [{ type: 'text' as const, text }]
const tool = (name: string, make: (args: Record<string, unknown>) => string) => ctx.tools.register(defineContentToolFixture({
  name, description: `${name} fixture`, parameters: { path: { type: 'string' }, pattern: { type: 'string' }, command: { type: 'string' }, turn: { type: 'number' }, size: { type: 'number' } },
  execute: async (args: unknown) => content(make(args as Record<string, unknown>)),
}))
tool('read', a => String(a.path).endsWith('.md') ? documentText(Number(a.turn), Number(a.size)) : sourceFile(Number(a.turn), Number(a.size)))
tool('grep', a => grepOutput(Number(a.turn), Number(a.size)))
tool('bash', a => testLog(Number(a.turn), Number(a.size)))

let tick = 0
ctx.systemPrompt.variable('tick', () => `${tick}`)
ctx.systemPrompt.context({
  name: 'bench-runtime', order: 50,
  text: `<runtime>\ntick: {{tick}}\ncwd: /work/project\nshell: zsh\nnotes: ${'the runtime context carries environment facts that change every turn; '.repeat(6)}\n</runtime>`,
})

const { agent } = await ctx.agents.create({ sessionId: SessionId(`heap-growth-${arm}-${SEED}`), agentOptions: { provider: 'bench-mock', model: 'scripted' } })
const session: Session = agent.session

// ------------------------------------------------------------------ script

/** Seq of the original record behind the most recent folded tool result, for expand_result. */
function lastFoldedOriginal(): number | undefined {
  const nodes = session.surface.nodes
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = session.eventAt(nodes[index]!) as SessionEvent | undefined
    if (event?.type === 'tool/result' && event.surfaceOp !== 'append') return event.sourceEventSeqs?.[0]
  }
  return undefined
}

function scriptTurn(turn: number): { user: string; responses: StreamChunk[][] } {
  const r = rng(turn, 0)
  const user = `Turn ${turn}: ${prose(r, 300 + Math.floor(r() * 600))}`
  const responses: StreamChunk[][] = []
  const id = (n: number) => `t${turn}-c${n}`
  responses.push(response(prose(r, 500), `Looking at ${ident(r)} first.`, [
    { id: id(1), name: 'read', args: { path: `src/${ident(r)}.ts`, turn, size: 3000 + Math.floor(r() * 3000) } },
    { id: id(2), name: 'grep', args: { pattern: ident(r), path: 'src', turn, size: 15 + Math.floor(r() * 20) } },
  ]))
  const step2: Call[] = [{ id: id(3), name: 'bash', args: { command: 'pnpm test', turn, size: turn % 3 === 0 ? 40_000 : 1_500 + Math.floor(r() * 1_500) } }]
  if (turn % 5 === 0) step2.push({ id: id(4), name: 'read', args: { path: `docs/spec-${turn}.md`, turn, size: 15_000 + Math.floor(r() * 10_000) } })
  responses.push(response(prose(r, 400), '', step2))
  if (arm === 'slice-recall' && turn % RECALL_EVERY === 0 && turn > 10) {
    const calls: Call[] = [{ id: id(5), name: 'recall_turn', args: { turn: String(turn - 10) } }]
    const seq = lastFoldedOriginal()
    if (seq !== undefined) calls.push({ id: id(6), name: 'expand_result', args: { seq, formatVersion: SESSION_FORMAT_VERSION } })
    responses.push(response(prose(r, 300), 'Checking what we did earlier.', calls))
  }
  responses.push(response(prose(r, 400), prose(r, 600 + Math.floor(r() * 600)), []))
  return { user, responses }
}

// ------------------------------------------------------------------ measurement

async function settle(): Promise<void> {
  // JSONL persistence buffers structuredClone copies of live events for a 200 ms
  // batching window; a scripted turn takes milliseconds, so drain it before
  // measuring or the window's copies are counted as retained heap.
  if (opt.persist !== undefined) await ctx.sessions.flush(session)
  for (let round = 0; round < 4; round += 1) {
    gc!()
    await new Promise(resolve => setImmediate(resolve))
  }
}

function logStats(): { events: number; logJsonChars: number; byType: Record<string, { n: number; chars: number }> } {
  const byType: Record<string, { n: number; chars: number }> = {}
  let total = 0
  const events = session.snapshotEvents()
  for (const event of events) {
    const chars = JSON.stringify(event).length
    total += chars
    const row = byType[event.type] ??= { n: 0, chars: 0 }
    row.n += 1
    row.chars += chars
  }
  return { events: events.length, logJsonChars: total, byType }
}

function surfaceStats(): Record<string, number> {
  let snapshots = 0
  let entries = 0
  let foldedResults = 0
  const nodes = session.surface.nodes
  for (const seq of nodes) {
    const event = session.eventAt(seq) as SessionEvent
    if (event.type === 'user/message') {
      const kind = event.data.source.kind as string
      if (kind === 'runtime-context') snapshots += 1
      if (kind === 'plugin:slice:history') entries += 1
    }
    if (event.type === 'tool/result' && event.surfaceOp !== 'append') foldedResults += 1
  }
  return { nodes: nodes.length, runtimeSnapshots: snapshots, sliceEntries: entries, foldedResults }
}

function packageVersion(specifier: string): string {
  return (createRequire(import.meta.url)(specifier) as { version: string }).version
}

function gitHead(): string {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim() } catch { return 'unknown' }
}

const checkpoints: Array<Record<string, unknown>> = []
async function checkpoint(turn: number, wallMs: number): Promise<void> {
  await settle()
  const mem = process.memoryUsage()
  const spaces = Object.fromEntries(getHeapSpaceStatistics().map(s => [s.space_name, +(s.space_used_size / 2 ** 20).toFixed(2)]))
  const log = turn === 0 ? { events: session.seq, logJsonChars: 0, byType: {} } : logStats()
  const row = {
    turn, wallMs: Math.round(wallMs),
    heapUsedMB: +(mem.heapUsed / 2 ** 20).toFixed(2), heapTotalMB: +(mem.heapTotal / 2 ** 20).toFixed(2),
    rssMB: +(mem.rss / 2 ** 20).toFixed(2), externalMB: +(mem.external / 2 ** 20).toFixed(2),
    events: log.events, logJsonMB: +(log.logJsonChars / 2 ** 20).toFixed(2), byType: log.byType,
    surface: surfaceStats(), request: adapter.measured, requests: adapter.requests, spaces,
  }
  checkpoints.push(row)
  if (!opt.quiet) console.error(`[${arm}] turn ${turn} heap ${row.heapUsedMB} MB log ${row.logJsonMB} MB events ${row.events} nodes ${row.surface.nodes} req ${adapter.measured?.chars ?? '-'} chars wall ${row.wallMs} ms`)
  if (SNAPSHOT_TURNS.has(turn)) {
    const dir = opt['snapshot-dir'] ?? '.'
    mkdirSync(dir, { recursive: true })
    const file = writeHeapSnapshot(join(dir, `${arm}-s${SEED}-t${turn}.heapsnapshot`))
    if (!opt.quiet) console.error(`[${arm}] wrote ${file}`)
  }
}

const started = Date.now()
await checkpoint(0, 0)
for (let turn = 1; turn <= TURNS; turn += 1) {
  tick = turn
  const { user, responses } = scriptTurn(turn)
  adapter.queue.push(...responses)
  if (turn % EVERY === 0) adapter.measureNext = true
  agent.followup(createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } }))
  await agent.whenIdle()
  if (adapter.queue.length) throw new Error(`turn ${turn} left ${adapter.queue.length} scripted responses unused (errors: ${errors.map(String).join('; ')})`)
  if (errors.length) throw new Error(`agent error at turn ${turn}: ${String(errors[0])}`)
  if (turn % EVERY === 0) await checkpoint(turn, Date.now() - started)
}

const result = {
  meta: {
    arm, turns: TURNS, every: EVERY, seed: SEED, recallEvery: arm === 'slice-recall' ? RECALL_EVERY : null,
    config: arm === 'stock' ? null : sliceConfig, invariants: !opt['no-invariants'], persist: opt.persist !== undefined,
    node: process.version, dsh: packageVersion('@deepseek-ai/dsh-agent-loop/package.json'),
    plugin: packageVersion('../../package.json'), git: gitHead(),
    date: new Date().toISOString(), wallMs: Date.now() - started, warns: [...new Set(warns)].slice(0, 10),
  },
  checkpoints,
}
if (opt.out !== undefined) {
  mkdirSync(dirname(opt.out), { recursive: true })
  writeFileSync(opt.out, `${JSON.stringify(result, null, 1)}\n`)
} else {
  console.log(JSON.stringify(result))
}
await ctx.fiber.dispose()
