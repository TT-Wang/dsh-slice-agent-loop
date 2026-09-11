/**
 * E2E smoke: minimal cordis boot with the real DeepSeek adapter and the
 * slice-agent-loop plugin, one agent answering through dsh-llm.
 *
 * Prerequisites (see examples/host-deepseek.ts):
 *   npm run link:dsh          # the DSH peers live in the host checkout
 *   export DEEPSEEK_API_KEY=…
 *
 *   npx tsx examples/smoke.ts
 */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmService from '@deepseek-ai/dsh-llm'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import apply from '../src/index.js'
import { MODEL, PROVIDER, registerDeepSeek, requireApiKey } from './host-deepseek.js'

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

  const events: string[] = []
  ctx.on('session/event', (_session, event) => {
    events.push(event.type)
    if (event.type === 'turn/end') console.log('TURN-END REASON:', JSON.stringify(event.data))
  })
  // Chunks are process-local: they never land in the session log, so the only
  // way to observe the live stream is this hook.
  const streamed: StreamChunk[] = []
  ctx.on('agent/assistant-stream', ({ frame }) => {
    if (frame.type === 'chunk') streamed.push(frame.chunk)
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

  const assistant = agent.session.snapshotEvents().filter((event) => event.type === 'assistant/message')
  const last = assistant.at(-1)
  console.log('ASSISTANT EVENT:', JSON.stringify(last?.data).slice(0, 800))
  const text = last?.data.message.content.map((block) => (block.type === 'text' ? block.text : '')).join('') ?? ''
  console.log('REPLY:', text)
  console.log('CHUNK TYPES:', streamed.map((chunk) => chunk.type).join(','))
  const text2 = streamed.map((chunk) => (chunk.type === 'text-delta' ? chunk.text : '')).join('')
  console.log('TEXT FROM CHUNKS:', text2)
  console.log('EVENTS:', events.join(' '))
  console.log('STATUS:', agent.status)

  await handle.dispose()
  await ctx.fiber.dispose()

  const required = ['turn/start', 'step/start', 'request/header', 'assistant/message', 'step/end', 'turn/end']
  const missing = required.filter((type) => !events.includes(type))
  if (missing.length > 0) {
    console.error('MISSING EVENTS:', missing.join(', '))
    process.exit(1)
  }
  if (streamed.length === 0) {
    console.error('no assistant stream chunks observed')
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
