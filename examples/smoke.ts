/**
 * E2E smoke: minimal cordis boot with the real DeepSeek adapter and the
 * slice-agent-loop plugin, one agent answering through dsh-llm.
 *
 * Key source: ~/.sliceagent/config.toml (the existing kernel key, same
 * resolution pattern as the owner's slice profile). Usage:
 *   npx tsx examples/smoke.ts
 */

import { readFileSync } from 'node:fs'
import { Context } from 'cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmService from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { DeepSeekAdapter, PUBLIC_BASE_URL, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '@deepseek-ai/dsh-llm-deepseek'
import apply from '../src/index.js'

const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-v4-flash'

function readKernelApiKey(): string {
  const toml = readFileSync(`${process.env.HOME}/.sliceagent/config.toml`, 'utf8')
  const match = toml.match(/^api_key\s*=\s*"([^"]+)"/m)
  if (!match) throw new Error('no api_key in ~/.sliceagent/config.toml')
  return match[1]
}

async function main(): Promise<void> {
  const apiKey = readKernelApiKey()
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(apply)

  ctx.llm.registerAdapter([PROVIDER], new DeepSeekAdapter({
    options: () => ({
      baseURL: PUBLIC_BASE_URL,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaults: {},
      maxTokens: DEFAULT_MAX_TOKENS,
      defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      models: [{ id: MODEL, name: MODEL, contextWindow: DEFAULT_CONTEXT_WINDOW }],
      retryPolicy: { attempts: 1, initialDelayMs: 0, backoff: 1, maxDelayMs: 0 },
    }),
    resolveApiKey: async () => apiKey,
  }))

  const events: string[] = []
  ctx.on('session/event', (_session, event) => {
    events.push(event.type)
    if (event.type === 'turn/end') console.log('TURN-END REASON:', JSON.stringify(event.data))
  })
  ctx.on('agent/error', (payload) => console.log('AGENT-ERROR:', JSON.stringify(payload, null, 1).slice(0, 600)))

  const handle = await ctx.agents.create({
    sessionId: SessionId('smoke-1'),
    agentOptions: { provider: PROVIDER, model: MODEL, maxTokens: 512 },
  })
  const agent = handle.agent

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Reply with exactly: SMOKE OK' }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()

  const assistant = agent.session.events.filter((event) => event.type === 'assistant/message')
  const last = assistant.at(-1)
  console.log('ASSISTANT EVENT:', JSON.stringify(last?.data).slice(0, 800))
  const text = last?.data?.message?.content?.map?.((block: { text?: string }) => block.text ?? '').join('') ?? ''
  console.log('REPLY:', text)
  const chunks = agent.session.events.filter((event) => event.type === 'assistant/chunk')
  console.log('CHUNK TYPES:', chunks.map((event) => event.data.chunk.type).join(','))
  const textChunks = chunks.filter((event) => event.data.chunk.type === 'text-delta')
  const text2 = textChunks.map((event) => event.data.chunk.text).join('')
  console.log('TEXT FROM CHUNKS:', text2)
  console.log('EVENTS:', events.join(' '))
  console.log('STATUS:', agent.status)

  await handle.dispose()
  await ctx.fiber.dispose()

  const required = ['turn/start', 'step/start', 'request/header', 'assistant/chunk', 'assistant/message', 'step/end', 'turn/end']
  const missing = required.filter((type) => !events.includes(type))
  if (missing.length > 0) {
    console.error('MISSING EVENTS:', missing.join(', '))
    process.exit(1)
  }
  if (!text.includes('SMOKE OK')) {
    console.error('REPLY did not contain SMOKE OK')
    process.exit(1)
  }
  console.log('SMOKE PASS')
}

main().catch((error) => {
  console.error('SMOKE FAIL:', error)
  process.exit(1)
})
