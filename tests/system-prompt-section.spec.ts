/** Where the slice section lands in the system prompt the real DSH system-prompt service assembles. */
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { nativeHarness, nativeSend, nativeText, type NativeHarness } from './native-harness.js'

/** The host's own opener (core/system-prompt `harness:identity`, order -1000), spelled independently of the plugin. */
const HOST_IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'
/** The deployment persona prefix (order 0) that tests/native-harness.ts configures. */
const PERSONA_PREFIX = 'Native-context integration fixture.'

const live: NativeHarness[] = []
afterEach(async () => {
  for (const harness of live.splice(0).reverse()) await harness.ctx.fiber.dispose()
})

/** The system message of the first request the stock loop dispatches. */
async function renderedSystemPrompt(): Promise<string> {
  const harness = await nativeHarness([nativeText('done')])
  live.push(harness)
  const { agent } = await harness.ctx.agents.create({
    sessionId: SessionId('slice-system-prompt-section'),
    agentOptions: { provider: 'native-mock', model: 'deterministic' },
  })
  await nativeSend(agent, 'hello')
  expect(harness.errors).toEqual([])
  const system = harness.adapter.requests[0]!.messages[0]!
  expect(system.role).toBe('system')
  return system.content.map(block => block.type === 'text' ? block.text : '').join('')
}

describe('slice system-prompt section', () => {
  it('carries no persona of its own, so the identity in the prompt is the host\'s', async () => {
    const prompt = await renderedSystemPrompt()
    expect(prompt).not.toMatch(/sliceagent/i)
    const section = prompt.slice(prompt.indexOf('<slice>'), prompt.indexOf('</slice>'))
    expect(section.length).toBeGreaterThan(0)
    expect(section).not.toMatch(/\bYou are\b/)
  })

  it('renders after the host identity line and before the fold section and the deployment persona', async () => {
    const prompt = await renderedSystemPrompt()
    expect(prompt.startsWith(HOST_IDENTITY)).toBe(true)
    const order = [HOST_IDENTITY, '<slice>', '</slice>', '<fold>', PERSONA_PREFIX].map(marker => prompt.indexOf(marker))
    expect(order.every(position => position >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
})
