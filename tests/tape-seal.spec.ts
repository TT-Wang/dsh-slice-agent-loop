/**
 * Acceptance gate for the append-only session tape on the stock loop.
 *
 * The property under test is the reason this policy exists: sealing a turn must
 * land AFTER everything already written, so each request keeps the previous
 * one's prefix and re-bills only the new entry. Two assertions carry it — an
 * entry's text never changes once written, and consecutive requests never
 * diverge before the entries already on the surface.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { RequestMessage as Message } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HISTORY_SOURCE, TAPE_PREFIX } from '../src/context.js'
import type { Config } from '../src/index.js'
import { nativeHarness, nativeSend, nativeText, nativeTool, type NativeHarness } from './native-harness.js'

const live: NativeHarness[] = []
afterEach(async () => { for (const harness of live.splice(0).reverse()) await harness.ctx.fiber.dispose() })

function textIn(messages: readonly Message[]): string {
  return messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
}
function entryOf(message: Message): string | null {
  const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
  return text.startsWith(TAPE_PREFIX) ? text : null
}
function entries(messages: readonly Message[]): string[] {
  return messages.flatMap(message => { const text = entryOf(message); return text ? [text] : [] })
}
function header(text: string): string { return text.split('\n')[0]! }
function sealedEvents(events: readonly SessionEvent[]): SessionEvent<'user/message'>[] {
  return events.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && event.data.source.kind === HISTORY_SOURCE)
}
function firstDivergence(a: readonly Message[], b: readonly Message[]): number {
  let i = 0
  while (i < a.length && i < b.length && JSON.stringify(a[i]) === JSON.stringify(b[i])) i += 1
  return i
}
function request(n: number): string { return `REQUEST_${n} ${'u'.repeat(900)}` }

/** Every turn: one tool step returning ~3K chars, then a short final reply. */
async function boot(turns: number, config: Config = {}) {
  const responses = []
  for (let n = 1; n <= turns; n += 1) responses.push(nativeTool(`call-${n}`, 'probe', { n }), nativeText(`REPLY_${n} done`))
  const h = await nativeHarness(responses, { config })
  live.push(h)
  h.ctx.tools.register(defineContentToolFixture({
    name: 'probe', description: 'Return a medium result', parameters: { n: { type: 'number' } },
    execute: async (args: unknown) => [{ type: 'text', text: `RESULT_${(args as { n?: number }).n ?? 0} ${'r'.repeat(3_000)}` }],
  }))
  return h
}
async function create(h: NativeHarness, id: string): Promise<Agent> {
  return (await h.ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'native-mock', model: 'deterministic' } })).agent
}
async function flood(agent: Agent, from: number, to: number): Promise<void> {
  for (let n = from; n <= to; n += 1) await nativeSend(agent, request(n))
}

describe('append-only session tape', () => {
  it('seals the turn that just ended into one entry and never rewrites an earlier one', async () => {
    const h = await boot(8)
    const agent = await create(h, 'tape-steady')
    await flood(agent, 1, 8)

    expect(h.errors).toEqual([])
    // turns 1..7 seal at the first step of turns 2..8; turn 8 is still the open turn.
    const written = sealedEvents(agent.session.snapshotEvents())
    expect(written).toHaveLength(7)
    written.forEach((event, index) => {
      const text = event.data.content.map(block => block.type === 'text' ? block.text : '').join('')
      expect(header(text)).toContain(`${TAPE_PREFIX}${index + 1}-${index + 1} · 1 turn(s) sealed`)
    })

    // An entry is written once and never re-rendered: same header, same bytes, in every later request.
    const firstSeen = new Map<string, string>()
    for (const sent of h.adapter.requests) {
      for (const text of entries(sent.messages)) {
        const key = header(text)
        const before = firstSeen.get(key)
        if (before === undefined) firstSeen.set(key, text)
        else expect(text).toBe(before)
      }
    }
    expect(firstSeen.size).toBe(7)

    // No request diverges from its predecessor before the entries already written: the seal lands at the tail,
    // so the cached prefix survives and only the new entry is re-billed.
    for (let i = 1; i < h.adapter.requests.length; i += 1) {
      const earlier = h.adapter.requests[i - 1]!.messages
      const later = h.adapter.requests[i]!.messages
      expect(firstDivergence(earlier, later)).toBeGreaterThanOrEqual(entries(earlier).length)
    }

    // Every sealed turn is still reachable verbatim, and its raw tool text is gone from the view. V4 tool-role
    // results carry their text directly, so the open turn's own raw result is visible and is the only one.
    const last = textIn(h.adapter.requests.at(-1)!.messages)
    expect(last).toContain('recall_turn')
    expect(last).toContain('expand_result')
    for (let n = 1; n <= 7; n += 1) expect(last).not.toContain(`RESULT_${n} r`)
    expect(last.split('r'.repeat(3_000))).toHaveLength(2)
    expect(last).toContain('RESULT_8 r')
    expect(last).toContain('REQUEST_8')
  })

  it('keeps the newest completed turns raw while keepRecentTurns asks for them', async () => {
    const h = await boot(6, { history: { keepRecentTurns: 2 } })
    const agent = await create(h, 'tape-keep')
    await flood(agent, 1, 6)

    expect(h.errors).toEqual([])
    // turns 1..3 seal; turns 4 and 5 stay raw behind the window, turn 6 is open.
    expect(sealedEvents(agent.session.snapshotEvents())).toHaveLength(3)
    // the entries cover turns 1-3 and nothing newer; turns 4 and 5 are still raw behind the window
    const last = h.adapter.requests.at(-1)!.messages
    expect(entries(last).map(header).map(line => /turns (\d+)-(\d+)/.exec(line)![0])).toEqual(['turns 1-1', 'turns 2-2', 'turns 3-3'])
    const text = textIn(last)
    expect(text).toContain('[tool turn 3 step 1')
    expect(text).not.toContain('[tool turn 4 step 1')
    expect(text).toContain('REQUEST_6')
    for (let i = 1; i < h.adapter.requests.length; i += 1) {
      const earlier = h.adapter.requests[i - 1]!.messages
      expect(firstDivergence(earlier, h.adapter.requests[i]!.messages)).toBeGreaterThanOrEqual(entries(earlier).length)
    }
  })

  it('seals nothing and appends nothing while the first turn is still open', async () => {
    const h = await boot(1)
    const agent = await create(h, 'tape-open')
    await flood(agent, 1, 1)

    expect(h.errors).toEqual([])
    expect(sealedEvents(agent.session.snapshotEvents())).toHaveLength(0)
    for (let i = 1; i < h.adapter.requests.length; i += 1) {
      const earlier = h.adapter.requests[i - 1]!.messages
      expect(firstDivergence(earlier, h.adapter.requests[i]!.messages)).toBe(earlier.length)
    }
  })
})
