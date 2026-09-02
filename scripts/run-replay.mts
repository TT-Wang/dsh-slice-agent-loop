/**
 * run-replay — 真实会话回放基准:一个 Claude Code 单轮任务,在起始 commit 的临时
 * worktree 里,经指定 loop 臂真实执行,终态与该轮原本的产出(oracle)比对。
 *
 *   npx tsx scripts/run-replay.mts --case <corpus/<id>> --arm transcript|slice-noseal|slice-seal|state
 *       [--effort low] [--ledger-dir results/replay]
 *
 * 语料目录(scripts/extract-cc-turns 产出):prompt.txt · meta.json{repo,cwd,sha,touchedFiles}
 * · oracle/<相对路径>(原轮改动后的文件终态)。
 *
 * 工具栈 = tool-fs(read/write/edit)+ tool-fs-search(grep/glob)+ tool-bash(经
 * subprocess → bash-local → shell,+ shell-env),cwd 全部钉在临时 worktree。
 * 副作用护栏:语料已过滤 push/publish/curl 等命令;worktree 与主仓库共享 remote,
 * 残余风险记录在 docs,不宣称零风险。
 *
 * 裁决:touched-file Jaccard(回放改动集 vs oracle 改动集)+ 每个 oracle 文件的行级
 * 相似度(2·LCS/(a+b))+ 成本/峰值/步数/推理。不用摘要判卷,只比终态。
 */
import { Context } from '@deepseek-ai/cordis'
import LlmService, { createUserMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import StockAgentLoop from '@deepseek-ai/dsh-agent-loop'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import apply from '../src/index.ts'
import { normalizeUsage } from '../src/call-ledger.ts'

function harnessRoot(): string {
  const candidates = [
    process.env.DSH_SOURCE,
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'source', 'current') : undefined,
    join(homedir(), '.dsh', 'source', 'current'),
  ].filter((c): c is string => Boolean(c))
  for (const c of candidates) if (existsSync(join(c, 'packages', 'llm', 'llm-deepseek', 'package.json'))) return c
  throw new Error('no DSH checkout found (set DSH_SOURCE)')
}
const HARNESS = harnessRoot()
const pkg = (p: string) => import(join(HARNESS, 'packages', ...p.split('/'), 'src', 'index.ts'))
const { DeepSeekAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } =
  await import(join(HARNESS, 'packages', 'llm', 'llm-deepseek', 'src', 'adapter.ts'))
const LocalFileSystem = (await pkg('fs/fs-local')).default
const ToolFs = await pkg('fs/tool-fs')
const ToolFsSearch = await pkg('fs/tool-fs-search')
const Subprocess = (await pkg('subprocess/subprocess')).default
const BashLocal = (await pkg('shell/bash-local')).default
const ShellEnv = await pkg('shell/shell-env')
const ToolBash = await pkg('shell/tool-bash')
const SessionProjections = (await pkg('session/session-projection')).default

// ── args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const opt = (flag: string, dflt?: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1]! : dflt }
const CASE = opt('--case')
const ARM = opt('--arm', 'slice-noseal')!
const EFFORT = opt('--effort', 'low')!
const MODEL = opt('--model', 'deepseek-v4-flash')!
const LEDGER_DIR = opt('--ledger-dir', 'results/replay')!
const MAX_STEPS = Number(opt('--max-steps', '150'))
if (!CASE || !existsSync(join(CASE, 'meta.json'))) { console.error('usage: --case <corpus dir with meta.json>'); process.exit(2) }
if (!['transcript', 'slice-noseal', 'slice-seal', 'state'].includes(ARM)) { console.error('bad --arm'); process.exit(2) }
if (!process.env.DEEPSEEK_API_KEY) { console.error('DEEPSEEK_API_KEY not in env'); process.exit(2) }

const meta = JSON.parse(readFileSync(join(CASE, 'meta.json'), 'utf8')) as { repo: string; cwd: string; sha: string; touchedFiles: string[]; timestamp?: string }
const prompt = readFileSync(join(CASE, 'prompt.txt'), 'utf8')
const caseId = basename(resolve(CASE))

// ── 起始态:临时 worktree @ sha;node_modules 从活仓库软链(bash 里的 npm/tsx 能跑)──
const wtRoot = resolve('results/replay-worktrees')
mkdirSync(wtRoot, { recursive: true })
const workdir = join(wtRoot, `${caseId}-${ARM}-${Date.now()}`)
execFileSync('git', ['-C', meta.cwd, 'worktree', 'add', '--detach', workdir, meta.sha], { stdio: 'ignore' })
const liveNodeModules = join(meta.cwd, 'node_modules')
if (existsSync(liveNodeModules) && !existsSync(join(workdir, 'node_modules'))) symlinkSync(liveNodeModules, join(workdir, 'node_modules'))
console.log(`case ${caseId} · repo ${basename(meta.cwd)} @ ${meta.sha.slice(0, 8)} · arm ${ARM} · effort ${EFFORT}\nworkdir ${workdir}`)

// ── boot ────────────────────────────────────────────────────────────────────
const ctx = new Context()
await ctx.plugin(LlmService)
await ctx.plugin(SessionStore)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRegistry)
await ctx.plugin(AgentRegistry)
await ctx.plugin(LocalFileSystem, { cwd: workdir })
await ctx.plugin(ToolFs, {})
await ctx.plugin(Subprocess)
await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: false })
await ctx.plugin(BashLocal, { cwd: workdir })
await ctx.plugin(ShellEnv, {})
await ctx.plugin(ToolBash, { enableRunInBackground: false })
if (ARM === 'transcript') {
  await ctx.plugin(SessionProjections)
  await ctx.plugin(StockAgentLoop, {})
} else {
  await ctx.plugin(apply, {
    defaultReasoningEffort: EFFORT as 'off' | 'low' | 'high' | 'max',
    maxStepsPerTurn: MAX_STEPS,
    inTurnSeal: { enabled: ARM === 'slice-seal', sealTokens: 40_000, batchSteps: 8, keepSteps: 4 },
    ...(ARM === 'state' ? { mode: 'state' as const } : {}),
  })
}
const connection = {
  baseURL: 'https://api.deepseek.com',
  apiKeyEnv: 'DEEPSEEK_API_KEY' as never,
  defaults: { reasoningEffort: EFFORT },
  maxTokens: DEFAULT_MAX_TOKENS,
  defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
  models: [{ id: MODEL }],
  streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  retryPolicy: resolveRetryPolicy(undefined, 'replay: deepseek retryPolicy'),
}
ctx.llm.registerAdapter(['deepseek'], new DeepSeekAdapter({
  options: () => connection,
  resolveApiKey: async () => process.env.DEEPSEEK_API_KEY!,
  resolveUserId: () => 'cc-replay' as never,
  prepareExtensions: () => Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
}))
const sessionId = `replay-${caseId}-${ARM}-${Date.now()}`
const handle = await ctx.agents.create({ sessionId: SessionId(sessionId), meta: { cwd: workdir }, agentOptions: { provider: 'deepseek', model: MODEL } })
const agent: Agent = handle.agent

// ── one turn ────────────────────────────────────────────────────────────────
const TURN_TIMEOUT_MS = 45 * 60_000
const turnEnds = () => agent.session.snapshotEvents().filter((e) => e.type === 'turn/end')
const started = Date.now()
agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
while (turnEnds().length === 0) {
  if (Date.now() - started > TURN_TIMEOUT_MS) { console.error('turn timed out'); process.exit(1) }
  await new Promise((r) => setTimeout(r, 500))
}
await agent.whenIdle()
const end = turnEnds().at(-1)! as { data?: { reason?: { kind?: string; error?: { message?: string } } } }
const endKind = end.data?.reason?.kind ?? '?'

// ── 账本 ─────────────────────────────────────────────────────────────────────
let input = 0, cacheRead = 0, output = 0, reasoning = 0, steps = 0, peak = 0
for (const e of agent.session.snapshotEvents()) {
  if (e.type !== 'assistant/message') continue
  const d = e.data as { step: number; usage?: unknown }
  const n = normalizeUsage(d.usage); if (!n) continue
  steps = Math.max(steps, d.step); input += n.input; cacheRead += n.cacheRead; output += n.output; reasoning += n.reasoning
  peak = Math.max(peak, n.input + n.cacheRead)
}
const names: Record<string, number> = {}
for (const e of agent.session.snapshotEvents()) {
  if (e.type !== 'tool/call') continue
  const d = e.data as Record<string, unknown>; const c = (d.block ?? d) as Record<string, unknown>
  const nm = String(c.name ?? '?'); names[nm] = (names[nm] ?? 0) + 1
}
const seals = agent.session.snapshotEvents().filter((e) => e.type === 'slice/step-seal').length
const bounces = agent.session.snapshotEvents().filter((e) => e.type === 'slice/contract-bounce').length

// ── 裁决:终态 vs oracle ──────────────────────────────────────────────────────
function lcsLines(a: string[], b: string[]): number {
  const prev = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i += 1) {
    let diag = 0
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j]!
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(prev[j]!, prev[j - 1]!)
      diag = tmp
    }
  }
  return prev[b.length]!
}
function similarity(a: string, b: string): number {
  const la = a.split('\n'), lb = b.split('\n')
  if (la.length + lb.length === 0) return 1
  return (2 * lcsLines(la, lb)) / (la.length + lb.length)
}
const changedInReplay = execFileSync('git', ['-C', workdir, 'status', '--porcelain'], { encoding: 'utf8' })
  .split('\n').filter(Boolean).map((l) => l.slice(3).trim()).filter((p) => p !== 'node_modules')
const oracleSet = new Set(meta.touchedFiles)
const replaySet = new Set(changedInReplay)
const inter = [...oracleSet].filter((p) => replaySet.has(p)).length
const union = new Set([...oracleSet, ...replaySet]).size
const jaccard = union === 0 ? 1 : inter / union
const perFile: Record<string, number> = {}
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p] })
const oracleDir = join(CASE, 'oracle')
if (existsSync(oracleDir)) {
  for (const f of walk(oracleDir)) {
    const rel = relative(oracleDir, f)
    const got = existsSync(join(workdir, rel)) ? readFileSync(join(workdir, rel), 'utf8') : ''
    perFile[rel] = Number(similarity(got, readFileSync(f, 'utf8')).toFixed(3))
  }
}
const sims = Object.values(perFile)
const meanSim = sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length : 0

const ledger = {
  caseId, repo: basename(meta.cwd), sha: meta.sha, arm: ARM, effort: EFFORT, model: MODEL, sessionId, workdir,
  endKind, error: end.data?.reason?.error?.message,
  totals: { steps, input, cacheRead, output, reasoning, peakInput: peak },
  seals, bounces, toolHistogram: names,
  verdict: { touchedJaccard: Number(jaccard.toFixed(3)), meanFileSimilarity: Number(meanSim.toFixed(3)), perFile, replayChanged: changedInReplay, oracleTouched: meta.touchedFiles },
}
mkdirSync(LEDGER_DIR, { recursive: true })
const out = join(LEDGER_DIR, `${caseId}-${ARM}-${Date.now()}.json`)
writeFileSync(out, JSON.stringify(ledger, null, 2))
console.log(`totals: steps=${steps} miss=${input} hit=${cacheRead} out=${output} (reasoning ${reasoning}) peakPrompt=${peak} seals=${seals} bounces=${bounces} end=${endKind}`)
console.log(`verdict: jaccard=${jaccard.toFixed(2)} meanSim=${meanSim.toFixed(2)} files=${sims.length} replayChanged=${changedInReplay.length}\nledger ${out}`)
// worktree 保留供检视;清理见 scripts/.replay-clean.sh
process.exit(0)
