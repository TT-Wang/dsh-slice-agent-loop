/**
 * runtime-context 通道回归探针(20260901 首验转正——可复跑):
 * 挂真实生产者 user-approval(ASK/NEVER 两句常量),5 个免工具轮,
 * 在 turn2→3 之间切换策略。预期归因:边界 3 = runtime-context-volatile,
 * 其余 = ok。全链路 = 真生产者 → RuntimeContextProjection → 种子合并 →
 * sidecar → attribute-miss。
 */
import { Context } from '@deepseek-ai/cordis'
import LlmService, { createUserMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import apply from '../src/index.ts'

function harnessRoot(): string {
  const c = join(homedir(), '.dsh', 'source', 'current')
  if (!existsSync(c)) throw new Error('no harness')
  return c
}
const HARNESS = harnessRoot()
const { DeepSeekAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } =
  await import(join(HARNESS, 'packages', 'llm', 'llm-deepseek', 'src', 'adapter.ts'))
const ApprovalService = (await import(join(HARNESS, 'packages', 'interaction', 'user-approval', 'src', 'index.ts'))).default

const ctx = new Context()
await ctx.plugin(LlmService)
await ctx.plugin(SessionStore)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRegistry)
await ctx.plugin(AgentRegistry)
await ctx.plugin(ApprovalService, { policy: 'ask' })
await ctx.plugin(apply, {})

const MODEL = 'deepseek-v4-flash'
const connection = {
  baseURL: 'https://api.deepseek.com',
  apiKeyEnv: 'DEEPSEEK_API_KEY' as never,
  defaults: {},
  maxTokens: DEFAULT_MAX_TOKENS,
  defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
  models: [{ id: MODEL }],
  streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  retryPolicy: resolveRetryPolicy(undefined, 'rtc-probe retryPolicy'),
}
ctx.llm.registerAdapter(['deepseek'], new DeepSeekAdapter({
  options: () => connection,
  resolveApiKey: async () => process.env.DEEPSEEK_API_KEY!,
  resolveUserId: () => 'rtc-probe' as never,
  prepareExtensions: () => Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
}))

const sessionId = `rtc-probe-${Date.now()}`
const handle = await ctx.agents.create({
  sessionId: SessionId(sessionId),
  agentOptions: { provider: 'deepseek', model: MODEL },
})
const agent = handle.agent

const turnEnds = () => agent.session.events.filter((e: { type: string }) => e.type === 'turn/end')
async function runTurn(i: number, text: string): Promise<void> {
  const before = turnEnds().length
  const started = Date.now()
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  while (turnEnds().length === before) {
    if (Date.now() - started > 120_000) { console.error(`turn ${i} timeout`); process.exit(1) }
    await new Promise((r) => setTimeout(r, 300))
  }
  const end = turnEnds().at(-1)! as { data?: { reason?: { kind?: string } } }
  console.log(`turn ${i} · ${((Date.now() - started) / 1000).toFixed(1)}s · end=${end.data?.reason?.kind}`)
}

await runTurn(1, 'Reply with exactly: OK-1. No tools.')
await runTurn(2, 'Reply with exactly: OK-2. No tools.')
// ── 真实状态切换:approval ask → never。生产者变更 → 投影新快照 → 下一轮种子的
// runtime-context 块字节变化 → 归因应在边界 3 报 runtime-context-volatile。
ctx.approval.setPolicy(agent, 'never')
console.log('── setPolicy(never) between turn 2 and 3')
await runTurn(3, 'Reply with exactly: OK-3. No tools.')
await runTurn(4, 'Reply with exactly: OK-4. No tools.')
await runTurn(5, 'Reply with exactly: OK-5. No tools.')
await agent.whenIdle()
console.log(`session ${sessionId}`)
process.exit(0)
