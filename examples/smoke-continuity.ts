/**
 * E2E continuity smoke: 抗 goal 污染的三轮暗号测试（与 sidecar 的
 * smoke-memory v2 同构），验证 TS driver 的跨轮连续性（对话环 + tape 封存）。
 *
 *   t1 "你好"（占住 goal）→ t2 "暗号：蓝莓42" → t3 "暗号是什么？"
 * 只有 recordUser + sealTurn + toSliceCtx 链路通了，t3 才答得出。
 *
 * 前提（见 examples/host-deepseek.ts）：先 `npm run link:dsh` 软链宿主 peer，
 * 并导出 DEEPSEEK_API_KEY。
 *
 * 用法：npx tsx examples/smoke-continuity.ts
 */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import LlmService from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import apply from '../src/index.js'
import { MODEL, PROVIDER, registerDeepSeek, requireApiKey } from './host-deepseek.js'

function lastAssistantText(agent: Agent): string {
  const msgs = agent.session.snapshotEvents().filter((e) => e.type === 'assistant/message')
  const last = msgs.at(-1)
  return last?.data.message.content
    .map((b) => (b.type === 'text' ? b.text : '')).join('') ?? ''
}

async function main(): Promise<void> {
  const apiKey = requireApiKey()
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(apply)

  await registerDeepSeek(ctx.llm, apiKey)

  ctx.on('agent/error', (payload) => console.log('AGENT-ERROR:', JSON.stringify(payload).slice(0, 400)))

  const handle = await ctx.agents.create({
    sessionId: SessionId('smoke-continuity-1'),
    agentOptions: { provider: PROVIDER, model: MODEL, maxTokens: 512 },
  })
  const agent = handle.agent

  const prompts = [
    '你好，随便聊一句',
    '记住一个暗号：蓝莓42。只回答：已记住',
    '我之前告诉你的暗号是什么？只回答暗号本身',
  ]
  for (let i = 0; i < prompts.length; i++) {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompts[i]! }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    console.log(`turn${i + 1}:`, lastAssistantText(agent).slice(0, 60))
  }

  const answer = lastAssistantText(agent)
  const turns = agent.session.snapshotEvents().filter((e) => e.type === 'turn/start').length
  const ends = agent.session.snapshotEvents().filter((e) => e.type === 'turn/end')
  console.log('turns:', turns, 'ends:', ends.map((e) => e.data.reason.kind).join(','))

  await handle.dispose()
  await ctx.fiber.dispose()

  const memoryOk = answer.includes('蓝莓') && answer.includes('42')
  const balanced = turns === 3 && ends.length === 3 && ends.every((e) => e.data.reason.kind === 'completed')
  console.log(`CONTINUITY ${memoryOk && balanced ? 'PASS ✓ 跨轮记忆 + 平衡轮' : 'FAIL ✗'} (answer=${answer.slice(0, 40)})`)
  process.exit(memoryOk && balanced ? 0 : 1)
}

main().catch((error) => {
  console.error('SMOKE FAIL:', error)
  process.exit(1)
})
