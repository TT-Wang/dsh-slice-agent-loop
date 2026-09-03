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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import apply from '../src/index.ts'
import StockAgentLoop from '@deepseek-ai/dsh-agent-loop'
import FoldPlugin, { FOLD_STATS } from '../src/fold/index.ts'
import { dbQueryTool, fetchPageTool } from '../src/bench/tools.ts'
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
const { DeepSeekAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } =
  await import(join(HARNESS, 'packages', 'llm', 'llm-deepseek', 'src', 'adapter.ts'))
const LocalFileSystem = (await import(join(HARNESS, 'packages', 'fs', 'fs-local', 'src', 'index.ts'))).default
const ToolFs = await import(join(HARNESS, 'packages', 'fs', 'tool-fs', 'src', 'index.ts'))
const hp = (...p: string[]) => import(join(HARNESS, 'packages', ...p, 'src', 'index.ts'))
const ToolFsSearch = await hp('fs', 'tool-fs-search')
// subprocess/subprocess 是抽象基类(spawn 未实现),具体实现是 subprocess-local——挂错了 bash 就是
// `this.ctx.subprocess.spawn is not a function`(2026-09-03 复盘:整批 s 系列 bash 实际不可用)。
const Subprocess = (await hp('subprocess', 'subprocess-local')).default
const BashLocal = (await hp('shell', 'bash-local')).default
const ShellEnv = await hp('shell', 'shell-env')
const ToolBash = await hp('shell', 'tool-bash')
const SpillLocal = (await hp('spill', 'spill-local')).default
const SpillPolicy = await hp('spill', 'spill-policy')
const SessionProjections = (await import(join(HARNESS, 'packages', 'session', 'session-projection', 'src', 'index.ts'))).default
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
if (!['off', 'low', 'high', 'max', 'default', 'inherit'].includes(EFFORT)) {
  console.error(`--effort must be off|low|high|max|default, got ${EFFORT}`)
  process.exit(2)
}
// 三臂 A/B(2026-09-02 轮内切片提案):transcript = DSH 原生 AgentLoop;
// slice-noseal = 现状 slice;slice-seal = 轮内封存开启。同 effort、同工具、同种子。
const armIdx = args.indexOf('--arm')
const ARM = armIdx !== -1 ? args[armIdx + 1]! : 'slice-noseal'
if (!['transcript', 'transcript-fold', 'slice-noseal', 'slice-seal', 'state', 'stream'].includes(ARM)) {
  console.error(`--arm must be transcript|transcript-fold|slice-noseal|slice-seal|state|stream, got ${ARM}`)
  process.exit(2)
}
const num = (flag: string, dflt: number) => { const i = args.indexOf(flag); return i !== -1 ? Number(args[i + 1]) : dflt }
const SEAL = { enabled: ARM === 'slice-seal', sealTokens: num('--seal-tokens', 40_000), batchSteps: num('--batch', 8), keepSteps: num('--keep', 4) }
const LEDGER_DIR = (() => { const i = args.indexOf('--ledger-dir'); return i !== -1 ? args[i + 1]! : 'results/longturn' })()
// state 臂的策略旋钮(成本下限实验):热窗步数、推送条数。
const HOT = num('--hot', 3)
const PUSH = num('--push', 3)
// v3 stream 实验旋钮:--no-rules 关掉旁路规则提取(宪法只剩请求 + 钉住清单,契约无谓词);
// --side-effort off|low|high|max|inherit 旁路调用的思考档(默认 off)。
const NO_RULES = args.includes('--no-rules')
const sideIdx = args.indexOf('--side-effort')
const SIDE_EFFORT = (sideIdx !== -1 ? args[sideIdx + 1]! : 'off') as 'off' | 'low' | 'high' | 'max' | 'inherit'
const STATE_OPTS = { hotWindowSteps: HOT, pushHits: PUSH, extractRules: !NO_RULES, sideEffort: SIDE_EFFORT }
// --digest-block-cap N:头部区外每个连续结构行块最多保留 N 行(默认不限)。
const CAP = num('--digest-block-cap', Infinity)
// --no-fold:关掉轮内折叠(对照旧 slice)。
const NO_FOLD = args.includes('--no-fold')
// 重读税实验旋钮(默认全关):--read-bases 读过未改的文件轮末锚定为 base;--read-pointer 磁带现行文件的整读换指针。
// 2026-09-03 起产品默认 = readBases(minReads 2)+ readPointer + anchor base + collapseEdits;
// --read-bases/--read-pointer/--collapse-edits 仍可显式打开,--no-read-bases/--no-read-pointer/
// --no-collapse-edits/--anchor auto 关掉(回归旧形态)。账本 tapeOpts 只记显式给出的项。
const READ_BASES = args.includes('--read-bases') ? true : args.includes('--no-read-bases') ? false : undefined
const READ_POINTER = args.includes('--read-pointer') ? true : args.includes('--no-read-pointer') ? false : undefined
// --anchor base:文件锚定永远存完整基线(不存 patch)。
const ANCHOR = (args.includes('--anchor') ? args[args.indexOf('--anchor') + 1] : undefined) as 'auto' | 'base' | undefined
// --rebase-after N / --reply-head N --reply-tail N / --check-digest:磁带内容实验旋钮。
const REBASE_AFTER = num('--rebase-after', Infinity)
const REPLY_HEAD = num('--reply-head', -1)
const REPLY_TAIL = num('--reply-tail', -1)
const CHECK_DIGEST = args.includes('--check-digest')
const COLLAPSE = args.includes('--collapse-edits') ? true : args.includes('--no-collapse-edits') ? false : undefined
const RB_MIN = num('--read-bases-min', 1)
const GC_SUPERSEDED = args.includes('--gc-superseded')
const NEW_MIN = num('--new-file-min', 1)
const BASE_MAX_FILES = num('--base-max-files', -1)
const TAPE_OPTS = { ...(READ_BASES !== undefined ? { readBases: READ_BASES } : {}), ...(READ_POINTER !== undefined ? { readPointer: READ_POINTER } : {}), ...(ANCHOR !== undefined ? { anchor: ANCHOR } : {}), ...(Number.isFinite(REBASE_AFTER) ? { rebaseAfterPatches: REBASE_AFTER } : {}), ...(REPLY_HEAD >= 0 ? { replyHeadChars: REPLY_HEAD } : {}), ...(REPLY_TAIL >= 0 ? { replyTailChars: REPLY_TAIL } : {}), ...(CHECK_DIGEST ? { checkInDigest: true } : {}), ...(COLLAPSE !== undefined ? { collapseEdits: COLLAPSE } : {}), ...(RB_MIN > 1 ? { readBasesMinReads: RB_MIN } : {}), ...(GC_SUPERSEDED ? { gcSupersededBases: true } : {}), ...(NEW_MIN > 1 ? { newFileMinTouches: NEW_MIN } : {}), ...(BASE_MAX_FILES >= 0 ? { baseMaxFiles: BASE_MAX_FILES } : {}) }
const TAPE_TOUCHED = READ_BASES !== undefined || READ_POINTER !== undefined || ANCHOR !== undefined || Number.isFinite(REBASE_AFTER) || REPLY_HEAD >= 0 || REPLY_TAIL >= 0 || CHECK_DIGEST || COLLAPSE !== undefined || RB_MIN > 1 || GC_SUPERSEDED || NEW_MIN > 1 || BASE_MAX_FILES >= 0
// --tools full:挂完整工具栈(grep/glob + bash),与原 h2h 评测一致;默认只有 read/write/edit。
const FULL_TOOLS = args.includes('--tools') && args[args.indexOf('--tools') + 1] === 'full'
const DIGEST_OPTS = { ...(Number.isFinite(CAP) ? { structuredBlockCap: CAP } : {}), ...(NO_FOLD ? { enabled: false } : {}) }
const scenario = basename(resolve(scenarioDir))
const prompts: string[] = JSON.parse(readFileSync(join(scenarioDir, 'prompts.json'), 'utf8'))
const meta = JSON.parse(readFileSync(join(scenarioDir, 'meta.json'), 'utf8')) as { turns: number; max_steps_per_turn?: number }
const MAX_STEPS_META = meta.max_steps_per_turn ?? 60
// --max-steps N 覆盖场景 meta 的每轮步数上限(历史 h2h 评测 slice 臂用 250,default 臂无上限)。
const MAX_STEPS = num('--max-steps', MAX_STEPS_META)
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
console.log(`scenario ${scenario} · ${prompts.length} turns (meta says ${meta.turns}) · model ${MODEL} · effort ${EFFORT} · arm ${ARM}${SEAL.enabled ? ` (seal ${SEAL.sealTokens}t/${SEAL.batchSteps}/${SEAL.keepSteps})` : ''}\nworkdir ${workdir}`)

// ── boot ────────────────────────────────────────────────────────────────────
const ctx = new Context()
await ctx.plugin(LlmService)
await ctx.plugin(SessionStore)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRegistry)
await ctx.plugin(AgentRegistry)
await ctx.plugin(LocalFileSystem, { cwd: workdir })
await ctx.plugin(ToolFs, {})
if (FULL_TOOLS) {
  await ctx.plugin(Subprocess)
  await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: false })
  await ctx.plugin(BashLocal, { cwd: workdir })
  await ctx.plugin(ShellEnv, {})
  await ctx.plugin(ToolBash, { enableRunInBackground: false })
  // 评测用的整份返回工具(2026-09-04):网页抓取镜像 + SQLite 查询;场景没有 site/ 或 data/*.db 时调用会报错,不影响其他场景。
  ctx.tools.register(fetchPageTool(workdir))
  ctx.tools.register(dbQueryTool(workdir))
  // 产品默认(dsh-base)同款:超过 50KB 的工具结果存成文件、模型看预览 + 路径。两臂同挂,A/B 才是产品条件。
  await ctx.plugin(SpillLocal, { root: join(workdir, '.spill') })
  await ctx.plugin(SpillPolicy, { maxInlineBytes: 50_000 })
}
// effort 经插件自身的 defaultReasoningEffort 通道注入(20260901 落地后,插件会给
// 无人选择的请求注入出厂默认 low——实验各臂必须显式走这个通道才能分臂)。
// 'default' = 不传配置,验证出厂默认的真实生效路径。
if (ARM === 'transcript' || ARM === 'transcript-fold') {
  // 原生 loop 需要 sessionProjections;effort 走 connection defaults(下面)。
  await ctx.plugin(SessionProjections)
  await ctx.plugin(StockAgentLoop, {})
  // transcript-fold:原生 loop + 独立的轮内折叠插件(src/fold),不挂 slice loop。
  if (ARM === 'transcript-fold') await ctx.plugin(FoldPlugin, { digest: DIGEST_OPTS })
} else {
  await ctx.plugin(apply, {
    ...(EFFORT === 'default' ? {} : { defaultReasoningEffort: EFFORT as 'off' | 'low' | 'high' | 'max' }),
    inTurnSeal: SEAL,
    // 场景自带的步预算(长链场景 150);插件默认值对 50 步链不够。
    maxStepsPerTurn: MAX_STEPS,
    ...(ARM === 'state' ? { mode: 'state' as const, state: STATE_OPTS } : {}),
    ...(ARM === 'stream' ? { state: STATE_OPTS, digest: DIGEST_OPTS } : {}),
    ...(ARM === 'slice-noseal' || ARM === 'slice-seal' ? { digest: DIGEST_OPTS } : {}),
    ...(TAPE_TOUCHED ? { tape: TAPE_OPTS } : {}),
    ...(ARM === 'stream' ? { mode: 'stream' as const } : {}),
  })
}

const connection = {
  baseURL: PUBLIC_BASE_URL,
  apiKeyEnv: 'DEEPSEEK_API_KEY' as never,
  // effort 阶梯实验(20260901 共识 Q2):经 connection defaults 注入——四臂提示词
  // 字节完全相同,epoch header 自动带 adapterDefaults 标记。恒显式设置以保证
  // 四臂走同一条解析路径。
  // transcript 臂没有插件注入通道,effort 经适配器默认落地;slice 臂两条通道同值。
  // 'inherit':插件不注入档位、适配器也不设默认 → 走适配器出厂档(与 2026-08 历史 default 臂同条件)。
  defaults: EFFORT === 'default' || EFFORT === 'inherit' ? {} : { reasoningEffort: EFFORT },
  maxTokens: DEFAULT_MAX_TOKENS,
  defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
  models: [{ id: MODEL }],
  streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  // 长批次里瞬时 TRANSPORT/RATE_LIMIT 常见:LLM 层重试放宽(默认 5 次 / 500ms 起)。
  retryPolicy: resolveRetryPolicy({ mode: 'normal', maxRetries: 8, backoff: { initialDelayMs: 2000, maxDelayMs: 30000 } }, 'run-scenario: deepseek retryPolicy'),
}
ctx.llm.registerAdapter(['deepseek'], new DeepSeekAdapter({
  options: () => connection,
  resolveApiKey: async () => process.env.DEEPSEEK_API_KEY!,
  resolveUserId: () => 'slice-scenario-validation' as never,
  // 20260811+ 协议:adapter 恒调 prepareExtensions。不挂 wire 扩展服务时,
  // 官方接线的兜底就是这个空实现(llm-deepseek/src/index.ts:465)——公开 API 直连。
  prepareExtensions: () => Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
}))

const sessionId = `slice-val-${scenario}-${ARM}-${EFFORT}-${Date.now()}`
const handle = await ctx.agents.create({
  sessionId: SessionId(sessionId),
  // driver 用 session.header.cwd 解析磁盘路径(文件锚定、状态账本、契约校验);
  // 不传则回退 process.cwd()(仓库目录)——与 tool-fs 的 cwd 不一致。
  meta: { cwd: workdir },
  agentOptions: { provider: 'deepseek', model: MODEL },
})
const agent: Agent = handle.agent

// ── turns ───────────────────────────────────────────────────────────────────
// followup() 只入队,whenIdle() 在唤醒注册前采样会立即返回(首跑实测:11 轮
// 0.0s 全部穿透)。以 turn/end 事件计数为准:每轮恰好落一条,带错误原因。
const TURN_TIMEOUT_MS = 45 * 60_000
const turnEnds = () => agent.session.snapshotEvents().filter((e) => e.type === 'turn/end')
let toolCallsSeen = 0
// 一轮以错误结束(LLM 层重试耗尽后的 TRANSPORT 等):同一提示重发,最多 3 次,15s 退避。
// 重发是新的一轮(turn 号递增),账本按 turn/end 计;失败那轮的部分用量照常计入。
const TURN_RETRIES = 3
for (let i = 0; i < prompts.length; i += 1) {
  const started = Date.now()
  let reason: { kind?: string; error?: { message?: string; code?: string } } | undefined
  for (let attempt = 1; attempt <= TURN_RETRIES; attempt += 1) {
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
    reason = end.data?.reason
    if (reason?.kind !== 'error') break
    console.error(`turn ${i + 1}: ended in error (attempt ${attempt}/${TURN_RETRIES}) — ${reason.error?.code}: ${reason.error?.message}`)
    if (attempt === TURN_RETRIES) process.exit(1)
    await new Promise((r) => setTimeout(r, 15000))
  }
  const calls = agent.session.snapshotEvents().filter((e) => e.type === 'tool/call').length
  const steps = calls - toolCallsSeen
  toolCallsSeen = calls
  console.log(`turn ${String(i + 1).padStart(2)}/${prompts.length} · ${((Date.now() - started) / 1000).toFixed(1)}s · tool calls +${steps} · end=${reason?.kind ?? '?'}`)
}
await agent.whenIdle()

// ── 通用账本(臂无关):从 assistant/message 事件的 usage 汇总 ─────────────────
interface TurnRow { turn: number; steps: number; input: number; cacheRead: number; output: number; reasoning: number; peakInput: number; wallMs: number }
const rowsByTurn = new Map<number, TurnRow>()
// 旁路调用(slice/side-call:规则提取等)不占步数,但用量全额计入——成本比较必须诚实。
for (const e of agent.session.snapshotEvents()) {
  if (e.type !== 'assistant/message' && e.type !== 'slice/side-call') continue
  const d = e.data as { turn: number; step: number; usage?: unknown }
  const n = normalizeUsage(d.usage)
  if (!n) continue
  const row = rowsByTurn.get(d.turn) ?? { turn: d.turn, steps: 0, input: 0, cacheRead: 0, output: 0, reasoning: 0, peakInput: 0, wallMs: 0 }
  if (e.type === 'assistant/message') row.steps = Math.max(row.steps, d.step)
  row.input += n.input; row.cacheRead += n.cacheRead; row.output += n.output; row.reasoning += n.reasoning
  row.peakInput = Math.max(row.peakInput, n.input + n.cacheRead)
  rowsByTurn.set(d.turn, row)
}
const turnRows = [...rowsByTurn.values()].sort((a, b) => a.turn - b.turn)
const seals = agent.session.snapshotEvents().filter((e) => e.type === 'slice/step-seal').length
const bounces = agent.session.snapshotEvents().filter((e) => e.type === 'slice/contract-bounce').length
const suspends = agent.session.snapshotEvents().filter((e) => e.type === 'slice/contract-suspend').map((e) => (e.data as { rules: string[] }).rules).flat()
const digests = agent.session.snapshotEvents().filter((e) => e.type === 'slice/digest') as Array<{ data: { charsBefore: number; charsAfter: number } }>
const foldStats = ARM === 'transcript-fold' ? FOLD_STATS.get(agent.session) : undefined
const digestStat = digests.length ? { count: digests.length, charsBefore: digests.reduce((a, e) => a + e.data.charsBefore, 0), charsAfter: digests.reduce((a, e) => a + e.data.charsAfter, 0) } : foldStats && foldStats.folded > 0 ? { count: foldStats.folded, charsBefore: foldStats.charsBefore, charsAfter: foldStats.charsAfter } : null
const rulesEv = agent.session.snapshotEvents().find((e) => e.type === 'slice/state-rules') as { data?: { rules?: number; enforced?: number; error?: string } } | undefined
const totals = turnRows.reduce((t, r) => ({ input: t.input + r.input, cacheRead: t.cacheRead + r.cacheRead, output: t.output + r.output, reasoning: t.reasoning + r.reasoning, steps: t.steps + r.steps, peakInput: Math.max(t.peakInput, r.peakInput) }), { input: 0, cacheRead: 0, output: 0, reasoning: 0, steps: 0, peakInput: 0 })

// ── verify.py ───────────────────────────────────────────────────────────────
// 行为闸门数据(Q3-b):工具名直方图——n1 召回调用数 / n2 施工轮工具数由此判。
const names: Record<string, number> = {}
for (const e of agent.session.snapshotEvents()) {
  if (e.type !== 'tool/call') continue
  const d = e.data as Record<string, unknown> | undefined
  const call = (d?.call ?? d) as Record<string, unknown> | undefined
  const name = String(call?.name ?? call?.tool ?? '?')
  names[name] = (names[name] ?? 0) + 1
}
console.log('tool histogram:', JSON.stringify(names))
const toolNames = ctx.tools.schemas().map((t) => t.name)
// 实际生效的 effort 档:从第一条 request/header 事件(logged ⟺ sent 审计不变式)读,不信参数。
const headerEv = agent.session.snapshotEvents().find((e) => e.type === 'request/header') as { data?: { header?: { config?: { reasoningEffort?: string; maxTokens?: number; model?: string } } } } | undefined
const resolvedEffort = headerEv?.data?.header?.config?.reasoningEffort ?? '(not in header)'
console.log(`env: tools=${FULL_TOOLS ? 'full' : 'fs'} registered=[${toolNames.join(',')}] maxStepsPerTurn=${MAX_STEPS} effort=${EFFORT} resolved=${resolvedEffort} model=${headerEv?.data?.header?.config?.model ?? '?'}`)
// 轨迹摘要(诊断用):每步的工具调用(名 + 参数前 160 字符)与助手正文前 200 字符,
// 写到账本旁的 .trace.jsonl——按步归因"为什么这一步在读/在写/在想"。
const trace: string[] = []
// 完整版(.full.jsonl):每步全部工具调用参数与助手正文,不截断——用于归因可见输出
// (2026-09-03:slice 的可见输出税主要是 bash 里的长 heredoc 探针,截断的 trace 看不出来)。
const full: string[] = []
for (const e of agent.session.snapshotEvents()) {
  if (e.type === 'assistant/message') {
    const d = e.data as { turn: number; step: number; message: { content: ReadonlyArray<{ type: string; text?: string; name?: string; arguments?: string }> } }
    const calls = d.message.content.filter((b) => b.type === 'tool-call').map((b) => `${b.name}(${(b.arguments ?? '').slice(0, 160)})`)
    const text = d.message.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').slice(0, 200)
    trace.push(JSON.stringify({ turn: d.turn, step: d.step, calls, text }))
    full.push(JSON.stringify({ turn: d.turn, step: d.step, calls: d.message.content.filter((b) => b.type === 'tool-call').map((b) => ({ name: b.name, arguments: b.arguments ?? '' })), text: d.message.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''), reasoning: d.message.content.filter((b) => b.type === 'reasoning').map((b) => b.text ?? '').join('') }))
  }
}

const verdictRaw = py(
  `import verify; ok, detail = verify.verify(${JSON.stringify(workdir)}); print(json.dumps({'ok': ok, 'detail': detail}))`,
)
const verdict = JSON.parse(verdictRaw.trim().split('\n').at(-1)!) as { ok: boolean; detail: string }
const ledger = { scenario, arm: ARM, effort: EFFORT, model: MODEL, tools: FULL_TOOLS ? 'full' : 'fs', readBases: ARM.startsWith('slice') || ARM === 'stream' ? (READ_BASES ?? true) : null, readPointer: ARM.startsWith('slice') || ARM === 'stream' ? (READ_POINTER ?? true) : null, readPointers: agent.session.snapshotEvents().filter((e) => e.type === 'slice/read-pointer').length, anchor: ARM.startsWith('slice') || ARM === 'stream' ? (ANCHOR ?? 'base') : null, tapeOpts: TAPE_TOUCHED ? TAPE_OPTS : null, env: { registeredTools: toolNames, maxStepsPerTurn: MAX_STEPS, resolvedEffort, spillMaxInlineBytes: FULL_TOOLS ? 50_000 : null, headerModel: headerEv?.data?.header?.config?.model ?? null }, seal: SEAL, state: ARM === 'state' || ARM === 'stream' ? STATE_OPTS : null, digestPolicy: ARM === 'stream' || ARM === 'slice-noseal' || ARM === 'slice-seal' || ARM === 'transcript-fold' ? DIGEST_OPTS : null, sessionId, workdir, turns: turnRows, totals, seals, bounces, suspends, digest: digestStat, stateRules: rulesEv?.data ?? null, toolHistogram: names, verdict }
mkdirSync(LEDGER_DIR, { recursive: true })
const ledgerPath = join(LEDGER_DIR, `${scenario}-${ARM}-${sessionId.split('-').at(-1)}.json`)
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2))
writeFileSync(ledgerPath.replace(/\.json$/, '.trace.jsonl'), trace.join('\n') + '\n')
writeFileSync(ledgerPath.replace(/\.json$/, '.full.jsonl'), full.join('\n') + '\n')
writeFileSync(join(workdir, 'verdict.json'), JSON.stringify(ledger, null, 2))
console.log(`totals: steps=${totals.steps} miss=${totals.input} hit=${totals.cacheRead} out=${totals.output} (reasoning ${totals.reasoning}) peakPrompt=${totals.peakInput} seals=${seals} bounces=${bounces}${rulesEv ? ` rules=${rulesEv.data?.rules}/${rulesEv.data?.enforced}enforced` : ''}${digestStat ? ` digests=${digestStat.count} (${digestStat.charsBefore}→${digestStat.charsAfter} chars)` : ''}`)
console.log(`verdict: ${verdict.ok ? '✓' : '✗'} ${verdict.detail}\nsession ${sessionId}\nledger ${ledgerPath}`)
process.exit(0)
