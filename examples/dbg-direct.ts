import { readFileSync } from 'node:fs'
import { Context } from 'cordis'
import LlmService from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, PUBLIC_BASE_URL, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '@deepseek-ai/dsh-llm-deepseek'

const toml = readFileSync(`${process.env.HOME}/.sliceagent/config.toml`, 'utf8')
const apiKey = toml.match(/^api_key\s*=\s*"([^"]+)"/m)![1]

const ctx = new Context()
await ctx.plugin(LlmService)
ctx.llm.registerAdapter(['deepseek-official'], new DeepSeekAdapter({
  options: () => ({
    baseURL: PUBLIC_BASE_URL, apiKeyEnv: 'DEEPSEEK_API_KEY', defaults: {},
    maxTokens: DEFAULT_MAX_TOKENS, defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    models: [{ id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', contextWindow: DEFAULT_CONTEXT_WINDOW }],
    retryPolicy: { attempts: 1, initialDelayMs: 0, backoff: 1, maxDelayMs: 0 },
  }),
  resolveApiKey: async () => apiKey,
}))

const prepared = await ctx.llm.prepareCall({ provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 512 })
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
