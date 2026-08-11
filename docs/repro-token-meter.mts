/** 多轮：每轮 surface 增长 20k，但 provider 每轮只报 4k（bounded-slice 的正常状态）。 */
import { Context } from 'cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LlmService, { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

const ctx = new Context()
await ctx.plugin(LlmService); await ctx.plugin(SessionStore); await ctx.plugin(TokenMeter)
const s = ctx.sessions.create(SessionId('m'))
const header = { config: { provider: 'p', model: 'm' } }
s.append('request/header', { header, reason: 'initial' })
const REAL = 4_000                       // 每轮真实请求恒定 4k（切片有界）
console.log('turn | provider真实 | meter.totalTokens | baseline | 偏差倍数')
for (let turn = 1; turn <= 6; turn++) {
  s.append('turn/start', { turn })
  s.append('step/start', { turn, step: 1 })
  s.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'X'.repeat(80_000) }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  s.append('assistant/message', {
    turn, step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider: 'p', model: 'm' } }),
    usage: { inputTokens: REAL, outputTokens: 50, cacheReadTokens: 0 },
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
  s.append('step/end', { turn, step: 1 })
  s.append('turn/end', { turn, reason: { kind: 'completed' } })
  const m = ctx.tokenMeter.measure(s)
  console.log(`  ${turn}  |     ${REAL}    |     ${String(m.totalTokens).padStart(7)}      | ${m.baseline.kind.padEnd(9)} | ${(m.totalTokens/REAL).toFixed(1)}×`)
}
await ctx.fiber.dispose()
