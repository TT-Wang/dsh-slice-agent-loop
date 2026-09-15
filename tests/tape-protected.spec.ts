/**
 * What a seal must leave untouched.
 *
 * The append-only tape is gated by tests/tape-seal.spec.ts: one entry per
 * completed turn, written at the first step of the next turn, never re-rendered.
 * This file gates the other half — the nodes a seal may not swallow and the bytes
 * it may not rewrite: the pinned first user message, the live runtime snapshot, a
 * replacement another plugin owns, multimodal user content, the open turn, an
 * entry an older build wrote, and the durable log a session resumes from. A seal
 * that ate any of them would still look like a working tape from the outside.
 *
 * Every case also carries the invariant the policy exists for: a request never
 * diverges from its predecessor before the entries that predecessor already had.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ImageBlock, Message } from '@deepseek-ai/dsh-llm'
import { isReplacementSurfaceEvent, SessionId, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HISTORY_SOURCE, TAPE_PREFIX } from '../src/context.js'
import type { Config } from '../src/index.js'
import { nativeHarness, nativeMessage, nativeSend, nativeText, nativeTool, type NativeHarness } from './native-harness.js'

const live: NativeHarness[] = []
const roots: string[] = []
afterEach(async () => {
  for (const harness of live.splice(0).reverse()) await harness.ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

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
/** Index just past the last entry in a request: everything before it is already written and frozen. */
function sealedPrefix(messages: readonly Message[]): number {
  let last = -1
  messages.forEach((message, index) => { if (entryOf(message)) last = index })
  return last + 1
}
function sealedEvents(events: readonly SessionEvent[]): SessionEvent<'user/message'>[] {
  return events.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === HISTORY_SOURCE)
}
function textOfEvent(event: SessionEvent<'user/message'>): string {
  return event.data.content.map(block => block.type === 'text' ? block.text : '').join('')
}
function firstDivergence(a: readonly Message[], b: readonly Message[]): number {
  let i = 0
  while (i < a.length && i < b.length && JSON.stringify(a[i]) === JSON.stringify(b[i])) i += 1
  return i
}
/** A seal lands after everything already written, so no request may diverge before its predecessor's entries. */
function expectStablePrefix(requests: ReadonlyArray<{ messages: readonly Message[] }>): void {
  for (let i = 1; i < requests.length; i += 1) {
    const earlier = requests[i - 1]!.messages
    expect(firstDivergence(earlier, requests[i]!.messages)).toBeGreaterThanOrEqual(sealedPrefix(earlier))
  }
}
function range(text: string): string { return /turns \d+-\d+/.exec(text)![0] }
function request(n: number): string { return `REQUEST_${n} ${'u'.repeat(900)}` }

/** Every turn: one tool step returning ~3K chars, then a short final reply. */
async function boot(turns: number, options: { config?: Config; persistenceRoot?: string } = {}) {
  const responses = []
  for (let n = 1; n <= turns; n += 1) responses.push(nativeTool(`call-${n}`, 'probe', { n }), nativeText(`REPLY_${n} done`))
  const h = await nativeHarness(responses, { config: options.config ?? {}, ...(options.persistenceRoot ? { persistenceRoot: options.persistenceRoot } : {}) })
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

describe('what a seal leaves untouched', () => {
  it('seals a turn between the next turn start and its first step, and never the pinned first user message', async () => {
    const h = await boot(5)
    const agent = await create(h, 'tape-pinned')
    const perTurn: number[] = []
    for (let n = 1; n <= 5; n += 1) { await nativeSend(agent, request(n)); perTurn.push(sealedEvents(agent.session.snapshotEvents()).length) }

    expect(h.errors).toEqual([])
    // One entry per turn already followed by another: nothing waits for a threshold.
    expect(perTurn).toEqual([0, 1, 2, 3, 4])
    const events = agent.session.snapshotEvents()
    const written = sealedEvents(events)
    const turnStart = (turn: number): SessionSeq => events.find(event => event.type === 'turn/start' && event.data.turn === turn)!.seq
    const firstStep = (turn: number): SessionSeq => events.find(event => event.type === 'step/start' && event.data.turn === turn)!.seq
    written.forEach((entry, index) => {
      const sealed = index + 1
      expect(textOfEvent(entry).startsWith(`${TAPE_PREFIX}${sealed}-${sealed} · 1 turn(s) sealed`)).toBe(true)
      // Written after the next turn opened and before its first request is built.
      expect(entry.seq).toBeGreaterThan(turnStart(sealed + 1))
      expect(entry.seq).toBeLessThan(firstStep(sealed + 1))
    })

    // pinFirstTurn: turn 1's user message stays its own append node, so it is verbatim in every request.
    const firstUser = events.find(event => event.type === 'user/message' && event.surfaceOp === 'append')!
    expect(agent.session.surface.nodes).toContain(firstUser.seq)
    for (const entry of written) expect(entry.sourceEventSeqs).not.toContain(firstUser.seq)
    expect(textOfEvent(written[0]!)).toContain('[turn 1]')
    expect(textOfEvent(written[0]!)).not.toContain(request(1))
    expect(textIn(h.adapter.requests.at(-1)!.messages)).toContain(request(1))

    // The last turn has nothing after it to trigger its seal, so its run is still raw on the surface.
    const open = events.filter(event => (event.type === 'assistant/message' || event.type === 'tool/result') && event.data.turn === 5)
    expect(open.length).toBeGreaterThanOrEqual(3)
    for (const event of open) expect(agent.session.surface.nodes).toContain(event.seq)
    expectStablePrefix(h.adapter.requests)
  })

  it('points at the original tool-result records instead of copying their bytes', async () => {
    const h = await boot(5)
    const agent = await create(h, 'tape-pointers')
    await flood(agent, 1, 5)

    expect(h.errors).toEqual([])
    const written = sealedEvents(agent.session.snapshotEvents())
    expect(written).toHaveLength(4)
    written.forEach((entry, index) => {
      const turn = index + 1
      const text = textOfEvent(entry)
      expect(text).toContain(`[turn ${turn}]`)
      expect(text).toContain(`REPLY_${turn} done`)
      // Turn 1's request is pinned on the surface instead; every later one is quoted in its own entry.
      if (turn > 1) expect(text).toContain(request(turn))
      expect(text).not.toContain('r'.repeat(100))
    })

    // Each pointer resolves to the untouched append record that still holds the full result.
    const seqs = written.flatMap(entry => [...textOfEvent(entry).matchAll(/expand_result\(\{"seq":(\d+),"formatVersion":3\}\)/g)].map(match => Number(match[1])))
    expect(seqs).toHaveLength(4)
    for (const seq of seqs) {
      const event = agent.session.eventAt(seq as SessionSeq)
      expect(event?.type).toBe('tool/result')
      expect(event?.type === 'tool/result' ? event.surfaceOp : undefined).toBe('append')
    }
    const last = textIn(h.adapter.requests.at(-1)!.messages)
    expect(last).toContain('recall_turn')
    expect(last).not.toContain('r'.repeat(3_000))
    expectStablePrefix(h.adapter.requests)
  })

  it('never rewrites an entry it already wrote and never nests one inside a later one', async () => {
    const h = await boot(7)
    const agent = await create(h, 'tape-frozen')
    await flood(agent, 1, 5)
    const before = sealedEvents(agent.session.snapshotEvents()).map(event => ({ seq: event.seq, text: textOfEvent(event) }))
    expect(before).toHaveLength(4)

    await flood(agent, 6, 7)
    expect(h.errors).toEqual([])
    const after = sealedEvents(agent.session.snapshotEvents())
    expect(after.map(event => range(textOfEvent(event))))
      .toEqual(['turns 1-1', 'turns 2-2', 'turns 3-3', 'turns 4-4', 'turns 5-5', 'turns 6-6'])
    for (const entry of before) {
      // Still on the surface, byte-identical, and no later entry took it as a source.
      expect(agent.session.surface.nodes).toContain(entry.seq)
      expect(textOfEvent(agent.session.eventAt(entry.seq) as SessionEvent<'user/message'>)).toBe(entry.text)
      for (const later of after) expect(later.sourceEventSeqs ?? []).not.toContain(entry.seq)
    }
    // One header per entry, and never the nesting line the retired archive law folded earlier work into.
    for (const entry of after) {
      expect(textOfEvent(entry).split(TAPE_PREFIX)).toHaveLength(2)
      expect(textOfEvent(entry)).not.toContain('earlier checkpoint covered')
    }
    // The oldest entry's bytes are still shipped exactly as first written.
    expect(textIn(h.adapter.requests.at(-1)!.messages)).toContain(before[0]!.text)
    expectStablePrefix(h.adapter.requests)
  })

  it('never seals the live runtime snapshot, a foreign replacement or an image message, and keeps their positions', async () => {
    const h = await boot(6)
    h.ctx.systemPrompt.context({ name: 'native-runtime', order: 50, text: 'RUNTIME_SENTINEL' })
    const agent = await create(h, 'tape-protected')
    await flood(agent, 1, 2)
    let foreign: SessionSeq | undefined
    agent.ctx.on('agent/pre-step', async ({ turn, step }, next) => {
      if (turn === 3 && step === 1) {
        const events = agent.session.snapshotEvents()
        const source = events.filter(event => (event.type === 'assistant/message' || event.type === 'tool/result') && event.data.turn === 2).map(event => event.seq)
        foreign = agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'FOREIGN_CANONICAL_SENTINEL' }], source: { kind: 'plugin', plugin: 'external-compaction' },
        }), { surfaceOp: { op: 'replace', startSeq: source[0]!, endSeq: source[source.length - 1]! }, sourceEventSeqs: source }).seq
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
    const written = sealedEvents(events)
    expect(written.map(event => range(textOfEvent(event))))
      .toEqual(['turns 1-1', 'turns 2-2', 'turns 3-3', 'turns 4-4', 'turns 5-5'])
    for (const entry of written) for (const seq of guarded) expect(entry.sourceEventSeqs).not.toContain(seq)
    // A seal around them never reorders them either.
    const positions = guarded.map(seq => agent.session.surface.nodes.indexOf(seq))
    expect(positions.every(index => index >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)

    const last = h.adapter.requests.at(-1)!.messages
    expect(textIn(last).split('RUNTIME_SENTINEL')).toHaveLength(2)
    expect(textIn(last)).toContain('FOREIGN_CANONICAL_SENTINEL')
    expect(last.find(message => message.id === imageMessage.id)).toEqual(imageMessage)
    // A seal that cut a call from its result would leave an unmatched tool block behind.
    const blocks = last.flatMap(message => message.content)
    expect(blocks.flatMap(block => block.type === 'tool-call' ? [block.id] : []).sort())
      .toEqual(blocks.flatMap(block => block.type === 'tool-result' ? [block.toolCallId] : []).sort())
    expectStablePrefix(h.adapter.requests)
  })

  it('resumes from the durable log with the same derived messages and seals only the turn that just ended', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slice-tape-resume-'))
    roots.push(root)
    const sessionId = SessionId('tape-resume')
    const first = await boot(5, { persistenceRoot: root })
    const agent = await create(first, sessionId)
    await flood(agent, 1, 5)
    expect(first.errors).toEqual([])
    expect(sealedEvents(agent.session.snapshotEvents())).toHaveLength(4)
    const derived = structuredClone(agent.session.deriveMessages())
    const eventCount = agent.session.snapshotEvents().length
    await first.ctx.fiber.dispose()
    live.splice(live.indexOf(first), 1)

    const second = await boot(1, { persistenceRoot: root })
    const resumed = await second.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'native-mock', model: 'deterministic' } })
    // Entries are events in the log, so the resumed view is the disposed one byte for byte.
    expect(resumed.agent.session.deriveMessages()).toEqual(derived)
    await nativeSend(resumed.agent, request(6))

    expect(second.errors).toEqual([])
    const written = sealedEvents(resumed.agent.session.snapshotEvents())
    expect(written).toHaveLength(5)
    // Turn 5 was the only completed turn left unsealed; the four carried over are not re-sealed or re-rendered.
    expect(textOfEvent(written[4]!).startsWith(`${TAPE_PREFIX}5-5 · 1 turn(s) sealed`)).toBe(true)
    written.slice(0, 4).forEach((entry, index) => expect(textOfEvent(entry)).toBe(entries(derived)[index]))
    const added = resumed.agent.session.snapshotEvents().slice(eventCount).filter(isReplacementSurfaceEvent)
    expect(added.map(event => event.seq)).toEqual([written[4]!.seq])
    // The first request after the resume keeps the resumed prefix and diverges only where turn 5 sealed.
    expect(firstDivergence(derived, second.adapter.requests[0]!.messages)).toBeGreaterThanOrEqual(sealedPrefix(derived))
    expectStablePrefix(second.adapter.requests)
  })

  it.each([
    ['monolithic tape', 'legacy-tape', '# SESSION TAPE (sealed conversational history; not current-world truth)\n[sealed turn 1; status completed; full record: recall_turn({"turn":"1"})]\nLEGACY_BODY\n'],
    ['pressure-archive checkpoint', 'legacy-checkpoint', '[slice checkpoint v1 · turns 1-1 · 1 turns archived · recall_turn({"turn":"<n>"})]\n[turn 1]\nLEGACY_BODY'],
  ])('leaves a %s node written by an older build frozen where it is', async (_label, id, legacyText) => {
    const h = await boot(6)
    const agent = await create(h, `tape-${id}`)
    await flood(agent, 1, 1)
    const events = agent.session.snapshotEvents()
    const run = events.filter(event => (event.type === 'assistant/message' || event.type === 'tool/result') && event.data.turn === 1).map(event => event.seq)
    const legacy = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: legacyText }], source: { kind: 'plugin', plugin: HISTORY_SOURCE },
    }), { surfaceOp: { op: 'replace', startSeq: run[0]!, endSeq: run[run.length - 1]! }, sourceEventSeqs: run })
    await flood(agent, 2, 6)

    expect(h.errors).toEqual([])
    const written = sealedEvents(agent.session.snapshotEvents()).filter(event => event.seq !== legacy.seq)
    // Turn 1 is already covered by the legacy node, so only the turns after it seal.
    expect(written.map(event => range(textOfEvent(event)))).toEqual(['turns 2-2', 'turns 3-3', 'turns 4-4', 'turns 5-5'])
    expect(textOfEvent(agent.session.eventAt(legacy.seq) as SessionEvent<'user/message'>)).toBe(legacyText)
    for (const entry of written) {
      expect(entry.sourceEventSeqs).not.toContain(legacy.seq)
      // Never re-expanded: neither the node's own body nor the turn it shadows comes back.
      expect(textOfEvent(entry)).not.toContain('LEGACY_BODY')
      expect(textOfEvent(entry)).not.toContain('REPLY_1 done')
    }
    // It keeps its place, and every seal lands after it.
    const position = agent.session.surface.nodes.indexOf(legacy.seq)
    expect(position).toBeGreaterThanOrEqual(0)
    for (const entry of written) expect(agent.session.surface.nodes.indexOf(entry.seq)).toBeGreaterThan(position)
    expect(textIn(h.adapter.requests.at(-1)!.messages)).toContain(legacyText)
    expectStablePrefix(h.adapter.requests)
  })
})
