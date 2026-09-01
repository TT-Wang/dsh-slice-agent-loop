/** 召回可及性探针(Q3-b 闸门歧视性版):码字埋进头尾截断的中段,答对必须召回。 */
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
import { REPLY_HEAD_CHARS, REPLY_TAIL_CHARS } from '../src/slice/tape.ts'

const EFFORT = process.argv[2] ?? 'low'
// v2:码字由模型自己发明(4 位数字),指令原文里没有答案——v1 把码字写进 ask,
// 而 ask 头尾全保留,low 档从 ask 直接重建了目标句,探针空虚。
const CODE_PREFIX = 'KESTREL-'
const HARNESS = join(homedir(), '.dsh', 'source', 'current')
if (!existsSync(HARNESS)) throw new Error('no harness')
const { DeepSeekAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } =
  await import(join(HARNESS, 'packages', 'llm', 'llm-deepseek', 'src', 'adapter.ts'))

const ctx = new Context()
await ctx.plugin(LlmService)
await ctx.plugin(SessionStore)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRegistry)
await ctx.plugin(AgentRegistry)
await ctx.plugin(apply, {})
const connection = {
  baseURL: 'https://api.deepseek.com',
  apiKeyEnv: 'DEEPSEEK_API_KEY' as never,
  defaults: { reasoningEffort: EFFORT },
  maxTokens: DEFAULT_MAX_TOKENS,
  defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
  models: [{ id: 'deepseek-v4-flash' }],
  streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  retryPolicy: resolveRetryPolicy(undefined, 'recall-probe retryPolicy'),
}
ctx.llm.registerAdapter(['deepseek'], new DeepSeekAdapter({
  options: () => connection,
  resolveApiKey: async () => process.env.DEEPSEEK_API_KEY!,
  resolveUserId: () => 'recall-probe' as never,
  prepareExtensions: () => Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
}))
const handle = await ctx.agents.create({
  sessionId: SessionId(`recall-probe-${EFFORT}-${Date.now()}`),
  agentOptions: { provider: 'deepseek', model: 'deepseek-v4-flash' },
})
const agent = handle.agent
const turnEnds = () => agent.session.events.filter((e: { type: string }) => e.type === 'turn/end')
async function runTurn(text: string): Promise<void> {
  const before = turnEnds().length
  const started = Date.now()
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  while (turnEnds().length === before) {
    if (Date.now() - started > 180_000) { console.error('turn timeout'); process.exit(1) }
    await new Promise((r) => setTimeout(r, 300))
  }
}
const lastReply = (): string => {
  const es = agent.session.events.filter((e: { type: string }) => e.type === 'assistant/message')
  const m = (es.at(-1)?.data as { message: { content: Array<{ type: string; text?: string }> } }).message
  return m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
}

await runTurn([
  'Write nine numbered facts about magnetic tape storage. Each fact must be a',
  'full paragraph of 4-5 sentences (aim for 600+ characters per fact; the total',
  'must exceed 6000 characters). The VERY LAST sentence of fact 5 must state an',
  `archival code word that you invent yourself, in the exact form ${CODE_PREFIX}<four digits of your choosing>.`,
  'Do not repeat the code word anywhere else in the reply. Do not use any tools.',
].join(' '))
const t1 = lastReply()
const m = t1.match(/KESTREL-\d{4}/)
const CODE = m?.[0] ?? ''
const at = CODE ? t1.indexOf(CODE) : -1
const midOk = CODE !== '' && t1.length > 4000 && at > REPLY_HEAD_CHARS + 200 && at < t1.length - REPLY_TAIL_CHARS - 200 && t1.indexOf(CODE) === t1.lastIndexOf(CODE)
console.log(JSON.stringify({ phase: 'T1', effort: EFFORT, len: t1.length, codeAt: at, buriedInTruncatedBand: midOk }))
if (!midOk) { console.log('PROBE-INVALID: code word not in truncated band'); process.exit(3) }

const callsBefore = agent.session.events.filter((e: { type: string }) => e.type === 'tool/call').length
await runTurn('Quote, verbatim and in full, the exact last sentence of fact 5 from your previous reply, including the specific code word you chose. Do not paraphrase.')
const recallCalls = agent.session.events
  .filter((e: { type: string }) => e.type === 'tool/call').slice(callsBefore)
  .map((e: { data?: unknown }) => { const d = e.data as Record<string, unknown> | undefined; const c = (d?.call ?? d) as Record<string, unknown> | undefined; return String(c?.name ?? c?.tool ?? '?') })
const correct = lastReply().includes(CODE)
console.log(JSON.stringify({ phase: 'T2', effort: EFFORT, toolCalls: recallCalls, reachedForRecall: recallCalls.some((n) => n.startsWith('recall')), codeWordCorrect: correct }))
process.exit(0)
