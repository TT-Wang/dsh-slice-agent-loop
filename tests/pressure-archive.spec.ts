/** Acceptance gate for the pressure-triggered batch archive on the stock loop. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ImageBlock, Message } from '@deepseek-ai/dsh-llm'
import { isReplacementSurfaceEvent, SessionId, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HISTORY_SOURCE } from '../src/context.js'
import type { Config } from '../src/index.js'
import { nativeHarness, nativeMessage, nativeSend, nativeText, nativeTool, type NativeHarness } from './native-harness.js'

const live: NativeHarness[] = []
const roots: string[] = []
afterEach(async () => {
  for (const harness of live.splice(0).reverse()) await harness.ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** highWater is crossed at turn 5's first step and again at turn 7's with the flood shape below. */
const PRESSURE: Config = { history: { highWaterChars: 18_000, lowWaterChars: 14_000, keepRecentChars: 1_000 } }

function chars(value: unknown): number { return Array.from(JSON.stringify(value)).length }
function textIn(messages: readonly Message[]): string {
  return messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
}
function archives(events: readonly SessionEvent[]): SessionEvent<'user/message'>[] {
  return events.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === HISTORY_SOURCE)
}
function textOfEvent(event: SessionEvent<'user/message'>): string {
  return event.data.content.map(block => block.type === 'text' ? block.text : '').join('')
}
function request(n: number): string { return `REQUEST_${n} ${'u'.repeat(900)}` }

/** Every flood turn: one tool step returning ~3K chars, then a short final reply. */
async function boot(turns: number, options: { config?: Config; persistenceRoot?: string; extra?: import('@deepseek-ai/dsh-llm').StreamChunk[][] } = {}) {
  const responses = []
  for (let n = 1; n <= turns; n += 1) responses.push(nativeTool(`call-${n}`, 'probe', { n }), nativeText(`REPLY_${n} done`))
  const h = await nativeHarness([...responses, ...(options.extra ?? [])], { config: options.config ?? PRESSURE, ...(options.persistenceRoot ? { persistenceRoot: options.persistenceRoot } : {}) })
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

function firstDivergence(a: readonly Message[], b: readonly Message[]): number {
  let i = 0
  while (i < a.length && i < b.length && JSON.stringify(a[i]) === JSON.stringify(b[i])) i += 1
  return i
}

describe('pressure-triggered batch archive', () => {
  it('appends nothing under highWater and keeps every model request a strict extension of the previous one', async () => {
    const h = await boot(8, { config: {} })
    const agent = await create(h, 'pa-steady')
    await flood(agent, 1, 8)

    expect(h.errors).toEqual([])
    expect(h.adapter.requests).toHaveLength(16)
    expect(archives(agent.session.snapshotEvents())).toHaveLength(0)
    expect(agent.session.snapshotEvents().some(isReplacementSurfaceEvent)).toBe(false)
    for (let i = 1; i < h.adapter.requests.length; i += 1) {
      const earlier = h.adapter.requests[i - 1]!.messages
      const later = h.adapter.requests[i]!.messages
      expect(later.length).toBeGreaterThan(earlier.length)
      expect(firstDivergence(earlier, later)).toBe(earlier.length)
    }
  })

  it('archives once at the next first step when highWater is crossed and lands under lowWater', async () => {
    const h = await boot(5)
    const agent = await create(h, 'pa-pressure')
    const perTurn: number[] = []
    for (let n = 1; n <= 5; n += 1) { await nativeSend(agent, request(n)); perTurn.push(archives(agent.session.snapshotEvents()).length) }

    expect(h.errors).toEqual([])
    expect(perTurn).toEqual([0, 0, 0, 0, 1])
    const events = agent.session.snapshotEvents()
    const [checkpoint] = archives(events)
    const turn5Start = events.find(event => event.type === 'turn/start' && event.data.turn === 5)!.seq
    const step5Start = events.find(event => event.type === 'step/start' && event.data.turn === 5)!.seq
    expect(checkpoint!.seq).toBeGreaterThan(turn5Start)
    expect(checkpoint!.seq).toBeLessThan(step5Start)
    expect(chars(h.adapter.requests[8]!.messages)).toBeLessThanOrEqual(18_000)
    expect(chars(h.adapter.requests[8]!.messages)).toBeLessThanOrEqual(14_000)

    const firstUser = events.find(event => event.type === 'user/message' && event.surfaceOp === 'append')!
    expect(agent.session.surface.nodes).toContain(firstUser.seq)
    expect(checkpoint!.sourceEventSeqs).not.toContain(firstUser.seq)
    const tail = events.filter(event => (event.type === 'assistant/message' || event.type === 'tool/result') && event.data.turn === 4)
    expect(tail.length).toBeGreaterThanOrEqual(3)
    for (const event of tail) expect(agent.session.surface.nodes).toContain(event.seq)

    const text = textOfEvent(checkpoint!)
    expect(text.startsWith('[slice checkpoint v1 · turns 1-3 · 3 turns archived')).toBe(true)
    for (const n of [2, 3]) expect(text).toContain(request(n))
    expect(text).not.toContain(request(1))
    expect(text).toContain('[turn 1]')
    expect(text).toContain('REPLY_2 done')
    const seqs = [...text.matchAll(/expand_result\(\{"seq":(\d+)\}\)/g)].map(match => Number(match[1]))
    expect(seqs).toHaveLength(3)
    for (const seq of seqs) {
      const event = agent.session.eventAt(seq as SessionSeq)
      expect(event?.type).toBe('tool/result')
      expect(event?.type === 'tool/result' ? event.surfaceOp : undefined).toBe('append')
    }
    expect(text).not.toContain('r'.repeat(100))
  })

  it('keeps the checkpoint byte-identical until the next pressure event, which nests it', async () => {
    const h = await boot(7)
    const agent = await create(h, 'pa-nest')
    await flood(agent, 1, 5)
    const [first] = archives(agent.session.snapshotEvents())
    const firstText = textOfEvent(first!)
    await flood(agent, 6, 6)
    expect(archives(agent.session.snapshotEvents())).toHaveLength(1)
    expect(agent.session.surface.nodes).toContain(first!.seq)
    expect(textOfEvent(agent.session.eventAt(first!.seq) as SessionEvent<'user/message'>)).toBe(firstText)
    expect(textIn(h.adapter.requests[10]!.messages)).toContain(firstText)

    await flood(agent, 7, 7)
    expect(h.errors).toEqual([])
    const all = archives(agent.session.snapshotEvents())
    expect(all).toHaveLength(2)
    const second = all[1]!
    expect(agent.session.surface.nodes).not.toContain(first!.seq)
    expect(agent.session.surface.nodes).toContain(second.seq)
    expect(second.sourceEventSeqs).toContain(first!.seq)
    const text = textOfEvent(second)
    expect(text.startsWith('[slice checkpoint v1 · turns 1-5 · 5 turns archived')).toBe(true)
    expect(text).toContain('[earlier checkpoint covered turns 1-3; recall_turn for details]')
    expect(text).not.toContain(request(2))
    expect(text).toContain(request(4))
    expect(text).toContain(request(5))
    expect(text.split('[slice checkpoint v1')).toHaveLength(2)
    expect(chars(h.adapter.requests[12]!.messages)).toBeLessThanOrEqual(14_000)
    // Only the two archive requests rewrite the prefix, at the checkpoint index; every other request extends the previous one.
    for (let i = 1; i < h.adapter.requests.length; i += 1) {
      const earlier = h.adapter.requests[i - 1]!.messages
      const later = h.adapter.requests[i]!.messages
      expect(firstDivergence(earlier, later)).toBe(i === 8 || i === 12 ? 1 : earlier.length)
    }
  })

  it('never shadows runtime snapshots, foreign replacements or image messages and keeps their positions', async () => {
    const h = await boot(6)
    h.ctx.systemPrompt.context({ name: 'native-runtime', order: 50, text: 'RUNTIME_SENTINEL' })
    const agent = await create(h, 'pa-protected')
    await flood(agent, 1, 2)
    let foreign: SessionSeq | undefined
    agent.ctx.on('agent/pre-step', async ({ turn, step }, next) => {
      if (turn === 3 && step === 1) {
        const events = agent.session.snapshotEvents()
        const source = events.filter(event => (event.type === 'assistant/message' || event.type === 'tool/result') && event.data.turn === 2).map(event => event.seq)
        foreign = agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'FOREIGN_CANONICAL_SENTINEL' }], source: { kind: 'plugin', plugin: 'external-compaction' },
        }), { surfaceOp: { op: 'replace', start: source[0]!, end: source[source.length - 1]! }, sourceEventSeqs: source }).seq
      }
      return next()
    }, { prepend: true })
    await flood(agent, 3, 3)
    const image: ImageBlock = {
      type: 'image',
      attachment: { attachmentId: 'sha256:0123456789abcdef' as ImageBlock['attachment']['attachmentId'], mediaType: 'image/png', bytes: 70, width: 1, height: 1 },
    }
    const imageMessage = createUserMessage({ content: [{ type: 'text', text: `${request(4)} IMAGE_SENTINEL` }, image], source: { kind: 'user' } })
    agent.followup(imageMessage)
    await agent.whenIdle()
    await flood(agent, 5, 6)

    expect(h.errors).toEqual([])
    const events = agent.session.snapshotEvents()
    const runtime = events.find(event => event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === '@deepseek-ai/dsh-system-prompt')!
    const imageSeq = events.find(event => event.type === 'user/message' && event.data.id === imageMessage.id)!.seq
    const guarded = [runtime.seq, foreign!, imageSeq]
    expect(archives(events).length).toBeGreaterThanOrEqual(1)
    for (const checkpoint of archives(events)) for (const seq of guarded) expect(checkpoint.sourceEventSeqs).not.toContain(seq)
    const positions = guarded.map(seq => agent.session.surface.nodes.indexOf(seq))
    expect(positions.every(index => index >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    const last = h.adapter.requests.at(-1)!.messages
    expect(textIn(last).split('RUNTIME_SENTINEL')).toHaveLength(2)
    expect(textIn(last)).toContain('FOREIGN_CANONICAL_SENTINEL')
    expect(last.find(message => message.id === imageMessage.id)).toEqual(imageMessage)
    const blocks = last.flatMap(message => message.content)
    expect(blocks.flatMap(block => block.type === 'tool-call' ? [block.id] : []).sort())
      .toEqual(blocks.flatMap(block => block.type === 'tool-result' ? [block.toolCallId] : []).sort())
  })

  it('resumes from the durable log with the same derived messages and no re-archive under highWater', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slice-pressure-resume-'))
    roots.push(root)
    const sessionId = SessionId('pa-resume')
    const first = await boot(5, { persistenceRoot: root })
    const agent = await create(first, sessionId)
    await flood(agent, 1, 5)
    expect(first.errors).toEqual([])
    expect(archives(agent.session.snapshotEvents())).toHaveLength(1)
    const derived = structuredClone(agent.session.deriveMessages())
    const eventCount = agent.session.snapshotEvents().length
    await first.ctx.fiber.dispose()
    live.splice(live.indexOf(first), 1)

    const second = await boot(1, { persistenceRoot: root })
    const resumed = await second.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'native-mock', model: 'deterministic' } })
    expect(resumed.agent.session.deriveMessages()).toEqual(derived)
    await nativeSend(resumed.agent, request(6))
    expect(second.errors).toEqual([])
    expect(archives(resumed.agent.session.snapshotEvents())).toHaveLength(1)
    expect(resumed.agent.session.snapshotEvents().slice(eventCount).some(isReplacementSurfaceEvent)).toBe(false)
    expect(firstDivergence(derived, second.adapter.requests[0]!.messages)).toBe(derived.length)
  })

  it('refuses an impossible request budget with zero archive appends', async () => {
    const h = await boot(1, { config: { history: { highWaterChars: 4_000, lowWaterChars: 2_000, keepRecentChars: 1 }, maxRequestChars: 6_000 } })
    const agent = await create(h, 'pa-impossible')
    await nativeSend(agent, 'small first request')
    // Larger than maxRequestChars on its own: archiving every completed turn (tail included) cannot make room.
    const current = nativeMessage(`OVERSIZED_${'o'.repeat(7_000)}`)
    agent.followup(current)
    await agent.whenIdle()

    expect(h.adapter.requests).toHaveLength(2)
    expect(h.errors).toHaveLength(1)
    expect(String(h.errors[0])).toMatch(/maxRequestChars/)
    expect(archives(agent.session.snapshotEvents())).toHaveLength(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === current.id)).toBe(true)
    expect([...agent.session.snapshotEvents()].reverse().find(event => event.type === 'turn/end')?.data.reason.kind).toBe('error')
  })

  it('archives a legacy monolithic tape node as one unit without re-expanding it', async () => {
    const h = await boot(6)
    const agent = await create(h, 'pa-legacy')
    await flood(agent, 1, 1)
    const events = agent.session.snapshotEvents()
    const run = events.filter(event => (event.type === 'assistant/message' || event.type === 'tool/result') && event.data.turn === 1).map(event => event.seq)
    const legacy = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '# SESSION TAPE (sealed conversational history; not current-world truth)\n[sealed turn 1; status completed; full record: recall_turn({"turn":"1"})]\nLEGACY_TAPE_BODY\n' }],
      source: { kind: 'plugin', plugin: HISTORY_SOURCE },
    }), { surfaceOp: { op: 'replace', start: run[0]!, end: run[run.length - 1]! }, sourceEventSeqs: run })
    await flood(agent, 2, 6)

    expect(h.errors).toEqual([])
    const checkpoints = archives(agent.session.snapshotEvents()).filter(event => event.seq !== legacy.seq)
    expect(checkpoints).toHaveLength(1)
    const text = textOfEvent(checkpoints[0]!)
    expect(checkpoints[0]!.sourceEventSeqs).toContain(legacy.seq)
    expect(agent.session.surface.nodes).not.toContain(legacy.seq)
    expect(text).toContain('[earlier checkpoint covered turns 1-1; recall_turn for details]')
    expect(text).not.toContain('LEGACY_TAPE_BODY')
    expect(text).not.toContain('REPLY_1 done')
    expect(text).toContain('REPLY_2 done')
  })
})
