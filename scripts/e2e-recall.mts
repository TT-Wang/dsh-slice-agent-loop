/**
 * E2E: recall_turn against a REAL model (deepseek-v4-flash, direct, no proxy).
 *
 * Same composition as the vitest harness, but the LLM adapter is the real
 * DeepSeekAdapter registered on the same seam the mock uses. Three turns:
 *   T1  force a >1,200-char reply ending in a verifiable code word
 *   T2  NEUTRAL ask for the exact final sentence (affordance test: does the
 *       model reach for recall_turn on its own, given only the tape's line?)
 *   T3  only if T2 didn't call it: explicit instruction (plumbing test)
 *
 * The API key stays in env (DEEPSEEK_API_KEY); nothing secret is printed.
 */
import { Context } from '@deepseek-ai/cordis'
import LlmService, { createUserMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import apply from '../src/index.ts'

// llm-deepseek 不在 peer 集里(它是宿主的供应商插件,不是 loop 的依赖),
// 所以从 harness 检出取 adapter 源码 —— 解析顺序与 scripts/link-dsh.mjs 一致。
function harnessRoot(): string {
  const candidates = [
    process.env.DSH_SOURCE,
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'source', 'current') : undefined,
    join(homedir(), '.dsh', 'source', 'current'),
  ].filter((c): c is string => Boolean(c))
  for (const c of candidates) if (existsSync(join(c, 'packages', 'llm', 'llm-deepseek', 'package.json'))) return c
  throw new Error('no DSH checkout found (set DSH_SOURCE)')
}
const { DeepSeekAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } =
  await import(join(harnessRoot(), 'packages', 'llm', 'llm-deepseek', 'src', 'adapter.ts'))
const PUBLIC_BASE_URL = 'https://api.deepseek.com' // llm-deepseek/src/index.ts:104(避免拉整个插件模块的服务依赖)

const MODEL = 'deepseek-v4-flash'
const CODE_WORD = 'QUOKKA-7431'

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

const ctx = new Context()
await ctx.plugin(LlmService)
await ctx.plugin(SessionStore)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRegistry)
await ctx.plugin(AgentRegistry)
await ctx.plugin(apply, {})

const connection = {
  baseURL: PUBLIC_BASE_URL,
  apiKeyEnv: 'DEEPSEEK_API_KEY' as never, // credentialRef = 校验过的品牌字符串,内联
  defaults: {},
  maxTokens: DEFAULT_MAX_TOKENS,
  defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
  models: [{ id: MODEL }],
  streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  retryPolicy: resolveRetryPolicy(undefined, 'e2e: deepseek retryPolicy'),
}
ctx.llm.registerAdapter(['deepseek'], new DeepSeekAdapter({
  options: () => connection,
  resolveApiKey: async () => {
    const key = process.env.DEEPSEEK_API_KEY
    if (!key) throw new Error('DEEPSEEK_API_KEY not in env')
    return key
  },
  resolveUserId: () => 'e2e-recall-probe' as never,
}))

const handle = await ctx.agents.create({
  sessionId: SessionId(`e2e-recall-${Date.now()}`),
  agentOptions: { provider: 'deepseek', model: MODEL },
})
const agent = handle.agent

// ── T1:超长回复,尾句带码字 ──────────────────────────────────────────────
send(agent, [
  'Write six numbered facts about magnetic tape storage. Each fact must be a',
  'paragraph of 3-4 sentences. Do not use any tools. The VERY LAST sentence of',
  `fact 6 must be exactly: The archival code word is ${CODE_WORD}.`,
].join(' '))
await agent.whenIdle()

const t1 = agent.session.events.filter(e => e.type === 'assistant/message').at(-1)
const t1text = (t1?.data as { message: { content: Array<{ type: string; text?: string }> } }).message.content
  .filter(b => b.type === 'text').map(b => b.text ?? '').join('')
console.log(`T1 reply: ${[...t1text].length} code points; code word present: ${t1text.includes(CODE_WORD)}`)

// ── T2:中性提问(affordance 测试)───────────────────────────────────────
send(agent, 'Quote, verbatim and in full, the exact final sentence of your previous reply. Do not paraphrase.')
await agent.whenIdle()

const callsAfterT2 = agent.session.events.filter(e => e.type === 'tool/call').length
const t2reply = agent.session.events.filter(e => e.type === 'assistant/message').at(-1)
const t2text = (t2reply?.data as { message: { content: Array<{ type: string; text?: string }> } }).message.content
  .filter(b => b.type === 'text').map(b => b.text ?? '').join('')
console.log(`T2: tool calls so far=${callsAfterT2}; reply quotes code word: ${t2text.includes(CODE_WORD)}`)

// ── T3:仅当 T2 没伸手 —— 显式要求(plumbing 测试)────────────────────────
let t3text = ''
if (callsAfterT2 === 0) {
  send(agent, 'Now use the recall_turn tool with {"turn": "slice-turn-1"} and quote that same final sentence from its output.')
  await agent.whenIdle()
  const t3reply = agent.session.events.filter(e => e.type === 'assistant/message').at(-1)
  t3text = (t3reply?.data as { message: { content: Array<{ type: string; text?: string }> } }).message.content
    .filter(b => b.type === 'text').map(b => b.text ?? '').join('')
}

// ── 取证 ──────────────────────────────────────────────────────────────────
const events = agent.session.events
const recallCalls = events.filter(e => e.type === 'tool/call' && JSON.stringify(e.data).includes('recall_turn'))
const recallResults = events.filter(e => e.type === 'tool/result')
  .map(e => JSON.stringify(e.data))
const resultHasWord = recallResults.some(r => r.includes(CODE_WORD))
// NOTE: request/header 按设计只装 system+tools,不装 messages —— 种子不重复进
// 日志正是 slice/request-slice 摘要设计的本意。广告行是否渲染由 mock 门直接
// 断言字节;这里的行为证据是:模型调用的参数拼写与广告行逐字一致。
const argsExact = recallCalls.some(c => JSON.stringify(c.data).includes('slice-turn-1'))

console.log('\n=== 判定 ===')
console.log(`调用参数与广告行拼写一致:  ${argsExact}`)
console.log(`recall_turn 被调用:        ${recallCalls.length} 次 (T2 自发: ${callsAfterT2 > 0})`)
console.log(`工具结果含码字(逐字回来): ${resultHasWord}`)
console.log(`最终回答引用了码字:        ${(t2text + t3text).includes(CODE_WORD)}`)

await handle.dispose()
await ctx.fiber.dispose()
const ok = recallCalls.length > 0 && resultHasWord && (t2text + t3text).includes(CODE_WORD)
console.log(ok ? '\nE2E PASS' : '\nE2E FAIL')
process.exit(ok ? 0 : 1)
