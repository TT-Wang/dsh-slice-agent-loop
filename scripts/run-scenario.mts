/**
 * run-scenario — thin single-arm scenario runner for sidecar validation.
 *
 * The original head-to-head bench runner lived in a companion workspace that
 * is no longer on this machine; this script re-creates just enough of it to
 * feed a scenarios-snapshot scenario (meta.json / prompts.json / setup.py /
 * verify.py) through the SLICE arm against the real DeepSeek adapter, so the
 * call-ledger sidecar (SLICE_CALL_LEDGER_DIR) captures real seeds + usage for
 * scripts/attribute-miss.mts.
 *
 *   DEEPSEEK_API_KEY=… SLICE_CALL_LEDGER_DIR=results/sidecars \
 *     npx tsx scripts/run-scenario.mts results/20260826-retention/scenarios-snapshot/n2_intent_ledger
 *
 * Boot recipe follows scripts/e2e-recall.mts (services + adapter from the
 * harness checkout); adds fs-local (rooted at a fresh workdir) + tool-fs so
 * the model has the stock read/write/edit suite the scenarios assume.
 * Cost note: one n-series scenario on v4-flash is a few cents.
 */
import { Context } from '@deepseek-ai/cordis'
import LlmService, { createUserMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import apply from '../src/index.ts'

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
const { DeepSeekAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } =
  await import(join(HARNESS, 'packages', 'llm', 'llm-deepseek', 'src', 'adapter.ts'))
const LocalFileSystem = (await import(join(HARNESS, 'packages', 'fs', 'fs-local', 'src', 'index.ts'))).default
const ToolFs = await import(join(HARNESS, 'packages', 'fs', 'tool-fs', 'src', 'index.ts'))
const PUBLIC_BASE_URL = 'https://api.deepseek.com'

// ── args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const scenarioDir = args.find((a) => !a.startsWith('--'))
if (!scenarioDir || !existsSync(join(scenarioDir, 'prompts.json'))) {
  console.error('usage: tsx scripts/run-scenario.mts <scenario-dir> [--model deepseek-v4-flash]')
  process.exit(2)
}
const modelIdx = args.indexOf('--model')
const MODEL = modelIdx !== -1 ? args[modelIdx + 1]! : 'deepseek-v4-flash'
const effortIdx = args.indexOf('--effort')
const EFFORT = effortIdx !== -1 ? args[effortIdx + 1]! : 'high'
if (!['off', 'low', 'high', 'max', 'default'].includes(EFFORT)) {
  console.error(`--effort must be off|low|high|max|default, got ${EFFORT}`)
  process.exit(2)
}
const scenario = basename(resolve(scenarioDir))
const prompts: string[] = JSON.parse(readFileSync(join(scenarioDir, 'prompts.json'), 'utf8'))
const meta = JSON.parse(readFileSync(join(scenarioDir, 'meta.json'), 'utf8')) as { turns: number }
if (!process.env.DEEPSEEK_API_KEY) {
  console.error('DEEPSEEK_API_KEY not in env')
  process.exit(2)
}
if (!process.env.SLICE_CALL_LEDGER_DIR) {
  console.warn('!! SLICE_CALL_LEDGER_DIR unset — running without the sidecar defeats the point of this runner')
}

// ── workdir + setup.py ──────────────────────────────────────────────────────
const workdir = mkdtempSync(join(tmpdir(), `slice-val-${scenario}-`))
const py = (fn: string) =>
  execFileSync('python3', ['-c', [
    'import sys, json',
    `sys.path.insert(0, ${JSON.stringify(resolve(scenarioDir))})`,
    fn,
  ].join('\n')], { encoding: 'utf8' })
py(`import setup; setup.setup(${JSON.stringify(workdir)})`)
console.log(`scenario ${scenario} · ${prompts.length} turns (meta says ${meta.turns}) · model ${MODEL} · effort ${EFFORT}\nworkdir ${workdir}`)

// ── boot ────────────────────────────────────────────────────────────────────
const ctx = new Context()
await ctx.plugin(LlmService)
await ctx.plugin(SessionStore)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRegistry)
await ctx.plugin(AgentRegistry)
await ctx.plugin(LocalFileSystem, { cwd: workdir })
await ctx.plugin(ToolFs, {})
// effort 经插件自身的 defaultReasoningEffort 通道注入(20260901 落地后,插件会给
// 无人选择的请求注入出厂默认 low——实验各臂必须显式走这个通道才能分臂)。
// 'default' = 不传配置,验证出厂默认的真实生效路径。
await ctx.plugin(apply, EFFORT === 'default' ? {} : { defaultReasoningEffort: EFFORT as 'off' | 'low' | 'high' | 'max' })

const connection = {
  baseURL: PUBLIC_BASE_URL,
  apiKeyEnv: 'DEEPSEEK_API_KEY' as never,
  // effort 阶梯实验(20260901 共识 Q2):经 connection defaults 注入——四臂提示词
  // 字节完全相同,epoch header 自动带 adapterDefaults 标记。恒显式设置以保证
  // 四臂走同一条解析路径。
  defaults: {},
  maxTokens: DEFAULT_MAX_TOKENS,
  defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
  models: [{ id: MODEL }],
  streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  retryPolicy: resolveRetryPolicy(undefined, 'run-scenario: deepseek retryPolicy'),
}
ctx.llm.registerAdapter(['deepseek'], new DeepSeekAdapter({
  options: () => connection,
  resolveApiKey: async () => process.env.DEEPSEEK_API_KEY!,
  resolveUserId: () => 'slice-scenario-validation' as never,
  // 20260811+ 协议:adapter 恒调 prepareExtensions。不挂 wire 扩展服务时,
  // 官方接线的兜底就是这个空实现(llm-deepseek/src/index.ts:465)——公开 API 直连。
  prepareExtensions: () => Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
}))

const sessionId = `slice-val-${scenario}-${EFFORT}-${Date.now()}`
const handle = await ctx.agents.create({
  sessionId: SessionId(sessionId),
  agentOptions: { provider: 'deepseek', model: MODEL },
})
const agent: Agent = handle.agent

// ── turns ───────────────────────────────────────────────────────────────────
// followup() 只入队,whenIdle() 在唤醒注册前采样会立即返回(首跑实测:11 轮
// 0.0s 全部穿透)。以 turn/end 事件计数为准:每轮恰好落一条,带错误原因。
const TURN_TIMEOUT_MS = 10 * 60_000
const turnEnds = () => agent.session.events.filter((e) => e.type === 'turn/end')
let toolCallsSeen = 0
for (let i = 0; i < prompts.length; i += 1) {
  const started = Date.now()
  const endsBefore = turnEnds().length
  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompts[i]! }], source: { kind: 'user' } }))
  while (turnEnds().length === endsBefore) {
    if (Date.now() - started > TURN_TIMEOUT_MS) {
      console.error(`turn ${i + 1}: timed out after ${TURN_TIMEOUT_MS / 1000}s`)
      process.exit(1)
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  const end = turnEnds().at(-1)! as { data?: { reason?: { kind?: string; error?: { message?: string; code?: string } } } }
  const reason = end.data?.reason
  if (reason?.kind === 'error') {
    console.error(`turn ${i + 1}: ended in error — ${reason.error?.code}: ${reason.error?.message}`)
    process.exit(1)
  }
  const calls = agent.session.events.filter((e) => e.type === 'tool/call').length
  const steps = calls - toolCallsSeen
  toolCallsSeen = calls
  console.log(`turn ${String(i + 1).padStart(2)}/${prompts.length} · ${((Date.now() - started) / 1000).toFixed(1)}s · tool calls +${steps} · end=${reason?.kind ?? '?'}`)
}
await agent.whenIdle()

// ── verify.py ───────────────────────────────────────────────────────────────
// 行为闸门数据(Q3-b):工具名直方图——n1 召回调用数 / n2 施工轮工具数由此判。
const names: Record<string, number> = {}
for (const e of agent.session.events) {
  if (e.type !== 'tool/call') continue
  const d = e.data as Record<string, unknown> | undefined
  const call = (d?.call ?? d) as Record<string, unknown> | undefined
  const name = String(call?.name ?? call?.tool ?? '?')
  names[name] = (names[name] ?? 0) + 1
}
console.log('tool histogram:', JSON.stringify(names))

const verdictRaw = py(
  `import verify; ok, detail = verify.verify(${JSON.stringify(workdir)}); print(json.dumps({'ok': ok, 'detail': detail}))`,
)
const verdict = JSON.parse(verdictRaw.trim().split('\n').at(-1)!) as { ok: boolean; detail: string }
writeFileSync(join(workdir, 'verdict.json'), JSON.stringify({ scenario, sessionId, model: MODEL, effort: EFFORT, toolHistogram: names, ...verdict }, null, 2))
console.log(`verdict: ${verdict.ok ? '✓' : '✗'} ${verdict.detail}\nsession ${sessionId}\nsidecar ${process.env.SLICE_CALL_LEDGER_DIR ?? '(unset)'}/${sessionId}.calls.jsonl`)
process.exit(0)
