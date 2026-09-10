/**
 * 最小观察点:绕开 agent,直接对 dsh-llm 发一次请求,看解析出来的 config 与 chunk 流。
 *
 * 前提: `npm run link:dsh` 已把宿主 peer 软链进来,且 DEEPSEEK_API_KEY 已导出。
 *
 *     DEEPSEEK_API_KEY=... npx tsx examples/dbg-direct.ts
 */
import { Context } from '@deepseek-ai/cordis'
import LlmService from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MODEL, PROVIDER, registerDeepSeek, requireApiKey } from './host-deepseek.js'

const apiKey = requireApiKey()

const ctx = new Context()
await ctx.plugin(LlmService)
await registerDeepSeek(ctx.llm, apiKey)

const prepared = await ctx.llm.prepareCall({ provider: PROVIDER, model: MODEL, maxTokens: 512 })
console.log('RESOLVED:', JSON.stringify(prepared.config))
const chunks: string[] = []
for await (const chunk of prepared.stream({
  provider: prepared.config.provider, model: prepared.config.model,
  ...(prepared.config.maxTokens !== undefined ? { maxTokens: prepared.config.maxTokens } : {}),
  ...(prepared.config.reasoningEffort !== undefined ? { reasoningEffort: prepared.config.reasoningEffort } : {}),
  messages: [createUserMessage({ content: [{ type: 'text', text: 'Reply with exactly: SMOKE OK' }], source: { kind: 'user' } })],
})) {
  chunks.push(chunk.type === 'text-delta' ? chunk.text : `[${chunk.type}:${JSON.stringify(chunk).slice(0, 160)}]`)
}
console.log('CHUNKS:', chunks.join(''))
await ctx.fiber.dispose()
