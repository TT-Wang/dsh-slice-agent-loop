/**
 * Acceptance gate for superseded runtime snapshots on the append-only session tape:
 * a superseded snapshot is absorbed by the entry of the turn it belongs to, the live one is
 * never shadowed, and a seal never rewrites anything already on the surface.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createMessage, createUserMessage, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage, foldSurface, isReplacementSurfaceEvent, Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { HISTORY_SOURCE, RUNTIME_CONTEXT_SOURCE, TAPE_PREFIX, sealCompletedTurns } from '../src/context.js'
import type { Config } from '../src/index.js'
import { nativeHarness, nativeSend, nativeText, nativeTool, type CapturedRequest, type NativeHarness } from './native-harness.js'

const live: NativeHarness[] = []
afterEach(async () => {
  for (const harness of live.splice(0).reverse()) await harness.ctx.fiber.dispose()
})

/** The default keep window, spelled out: a completed turn seals at the first step of the next turn. */
const TAPE: Config = { history: { keepRecentTurns: 0 } }
const TURNS = 60

function isSnapshot(event: SessionEvent): event is SessionEvent<'user/message'> {
  return event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === RUNTIME_CONTEXT_SOURCE
}

function isEntry(event: SessionEvent): event is SessionEvent<'user/message'> {
  return event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === HISTORY_SOURCE
    && event.data.content.some(block => block.type === 'text' && block.text.startsWith(TAPE_PREFIX))
}

function textOf(event: SessionEvent<'user/message'>): string {
  return event.data.content.map(block => block.type === 'text' ? block.text : '').join('')
}

/** Sealed entries as they appear in one dispatched request, in surface order. */
function entriesIn(messages: readonly Message[]): string[] {
  return messages.flatMap(message => {
    const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
    return text.startsWith(TAPE_PREFIX) ? [text] : []
  })
}

function header(text: string): string { return text.split('\n')[0]! }

/** Every third turn runs one tool step, so tool-continuation requests are part of the sequence. */
async function churn(): Promise<NativeHarness> {
  const responses: StreamChunk[][] = []
  for (let turn = 1; turn <= TURNS; turn += 1) {
    if (turn % 3 === 0) responses.push(nativeTool(`probe-${turn}`, 'probe', { turn }))
    responses.push(nativeText(`ANSWER_${turn}`))
  }
  const h = await nativeHarness(responses, { config: TAPE })
  live.push(h)
  h.ctx.tools.register(defineContentToolFixture({
    name: 'probe', description: 'Return a small result', parameters: { turn: { type: 'number' } },
    execute: async (args: unknown) => [{ type: 'text', text: `PROBE_${(args as { turn?: number }).turn ?? 0} ${'p'.repeat(400)}` }],
  }))
  let tick = 0
  h.ctx.systemPrompt.variable('tick', () => `${tick}`.padStart(6, '0') + 'x'.repeat(1_000))
  h.ctx.systemPrompt.context({ name: 'changing-runtime', order: 50, text: 'RUNTIME_SNAPSHOT_{{tick}}' })
  const { agent } = await h.ctx.agents.create({ sessionId: SessionId('runtime-snapshot-archive'), agentOptions: { provider: 'native-mock', model: 'deterministic' } })
  for (let turn = 1; turn <= TURNS; turn += 1) {
    tick = turn
    await nativeSend(agent, `QUESTION_${turn}`)
  }
  return h
}

function expectReconstructable({ request, events }: CapturedRequest): void {
  const expected = foldSurface(events).nodes.flatMap(seq => {
    const message = deriveEventMessage(events[seq]!)
    return message === null ? [] : [message]
  })
  expect(request.messages).toEqual(expected)
}

function firstDivergence(a: readonly Message[], b: readonly Message[]): number {
  let i = 0
  while (i < a.length && i < b.length && JSON.stringify(a[i]) === JSON.stringify(b[i])) i += 1
  return i
}

function ours(event: SessionEvent): boolean {
  return event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === HISTORY_SOURCE
}

/** Indices of captured requests at which a slice seal (our replacement appends) became visible. */
function sealIndices(captured: readonly CapturedRequest[]): number[] {
  return captured.flatMap((entry, index) => {
    const before = index === 0 ? 0 : captured[index - 1]!.events.length
    return entry.events.slice(before).some(ours) ? [index] : []
  })
}

describe('superseded runtime snapshots on the append-only session tape', () => {
  it('keeps the entire established tape prefix when context changes after several stable turns', async () => {
    const h = await nativeHarness(Array.from({ length: 8 }, (_, index) => nativeText(`ANSWER_${index + 1} ${'a'.repeat(1_000)}`)))
    live.push(h)
    let value = 'A'
    h.ctx.systemPrompt.variable('delayed_value', () => value)
    h.ctx.systemPrompt.context({ name: 'delayed-context', order: 50, text: 'DELAYED_CONTEXT_{{delayed_value}}' })
    const { agent } = await h.ctx.agents.create({ sessionId: SessionId('delayed-runtime-prefix'), agentOptions: { provider: 'native-mock', model: 'deterministic' } })
    for (let turn = 1; turn <= 8; turn += 1) {
      if (turn === 6) value = 'B'
      await nativeSend(agent, `QUESTION_${turn}`)
    }
    expect(h.errors).toEqual([])
    for (let index = 1; index < h.adapter.requests.length; index += 1) {
      const before = h.adapter.requests[index - 1]!.messages
      const after = h.adapter.requests[index]!.messages
      const lastEntry = before.reduce((last, message, position) => entriesIn([message]).length ? position : last, -1)
      // Check actual message position, not just the number of entries: a raw
      // snapshot and the pinned first request can precede those entries.
      expect(after.slice(0, lastEntry + 1)).toEqual(before.slice(0, lastEntry + 1))
    }
    const events = agent.session.snapshotEvents()
    const firstSnapshot = events.find(isSnapshot)!
    expect(agent.session.surface.nodes).toContain(firstSnapshot.seq)
    expect(events.filter(isEntry).every(entry => !entry.sourceEventSeqs?.includes(firstSnapshot.seq))).toBe(true)
    // The still-live snapshot can split its turn into two spans. Each written
    // entry still advances the frontier rather than retiring an older snapshot.
    expect(events.filter(isEntry).length).toBeGreaterThanOrEqual(7)
    for (const captured of h.captured) expectReconstructable(captured)
  })

  it('never reseals a snapshot-only entry written by an earlier build', () => {
    const session = Session.create(SessionId('old-snapshot-entry'))
    session.append('turn/start', { turn: 1 })
    const old = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'OLD_CONTEXT' }], source: { kind: 'plugin', plugin: RUNTIME_CONTEXT_SOURCE } }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const note = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `${TAPE_PREFIX}1-1 · snapshot-only legacy entry]` }], source: { kind: 'plugin', plugin: HISTORY_SOURCE } }), {
      surfaceOp: { op: 'replace', startSeq: old.seq, endSeq: old.seq }, sourceEventSeqs: [old.seq],
    })
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'QUESTION_2' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 2, step: 1, stream: [], message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'ANSWER_2' }], source: { kind: 'model', provider: 'mock', model: 'mock' } }) }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const pending = createUserMessage({ content: [{ type: 'text', text: 'NEW_CONTEXT' }], source: { kind: 'plugin', plugin: RUNTIME_CONTEXT_SOURCE } })
    const policy = { keepRecentTurns: 0, pinFirstTurn: false, pinUserChars: 1_200, entryMaxChars: 8_000 }
    const plan = sealCompletedTurns(session, [pending], policy)
    expect(plan.appends).toHaveLength(1)
    expect(plan.appends.flatMap(append => append.sources)).not.toContain(note.seq)
    expect(session.surface.nodes[0]).toBe(note.seq)
    expect(sealCompletedTurns(session, [pending], policy).appends).toEqual([])
  })

  it('(a) never walls, seals every completed turn, and leaves only the unshadowed live snapshot after each seal', async () => {
    const h = await churn()
    expect(h.errors).toEqual([])
    expect(h.errors.some(error => String(error).includes('SliceBudgetError'))).toBe(false)
    expect(h.adapter.requests).toHaveLength(TURNS + TURNS / 3)
    const turnEnds = h.captured.at(-1)!.events.filter(event => event.type === 'turn/end')
    expect(turnEnds).toHaveLength(TURNS - 1) // the last turn/end lands after the last capture
    const events = h.captured.at(-1)!.events
    expect(events.filter(event => event.type === 'turn/end').every(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')).toBe(true)

    // One seal per completed turn, at the first step of the turn after it; turn 1 has nothing to seal yet.
    const indices = sealIndices(h.captured)
    expect(indices).toHaveLength(TURNS - 1)
    for (const index of indices) {
      const { events: log } = h.captured[index]!
      const surface = foldSurface(log).nodes.map(seq => log[seq]!)
      const onSurface = surface.filter(isSnapshot)
      const newest = [...log].reverse().find(isSnapshot)!
      // Exactly the live snapshot, in place, with its original source and append op.
      expect(onSurface.map(event => event.seq)).toEqual([newest.seq])
      expect(newest.surfaceOp).toBe('append')
      expect(newest.data.source).toMatchObject({ kind: 'plugin', plugin: RUNTIME_CONTEXT_SOURCE })
      for (const replacement of log.filter(isReplacementSurfaceEvent)) expect(replacement.sourceEventSeqs ?? []).not.toContain(newest.seq)
    }
    // A turn absorbs its own dead snapshot, so every seal writes a tape entry: outside the
    // last-resort tier there is no separate note pass any more.
    const entryEvents = indices.filter(index => {
      const before = index === 0 ? 0 : h.captured[index - 1]!.events.length
      return h.captured[index]!.events.slice(before).some(isEntry)
    })
    expect(entryEvents).toEqual(indices)
    for (const captured of h.captured) expectReconstructable(captured)
  }, 60_000)

  it('(b) rewrites nothing: a mid-turn step extends the previous request, and a seal lands after every entry already written', async () => {
    const h = await churn()
    const indices = new Set(sealIndices(h.captured))
    expect(indices.size).toBe(TURNS - 1)
    let extensions = 0
    for (let i = 1; i < h.adapter.requests.length; i += 1) {
      const earlier = h.adapter.requests[i - 1]!.messages
      const later = h.adapter.requests[i]!.messages
      if (!indices.has(i)) {
        // No seal this step: the request only grows at its tail.
        expect(later.length).toBeGreaterThan(earlier.length)
        expect(firstDivergence(earlier, later)).toBe(earlier.length)
        extensions += 1
        continue
      }
      // A seal replaces the newest unsealed span, which sits after every entry already on the
      // surface, so the cached prefix through those entries survives untouched.
      expect(firstDivergence(earlier, later)).toBeGreaterThanOrEqual(entriesIn(earlier).length)
    }
    expect(extensions).toBe(h.adapter.requests.length - 1 - indices.size)

    // An entry is a pure function of the nodes it shadows: once written, its bytes never change.
    const firstSeen = new Map<string, string>()
    for (const sent of h.adapter.requests) {
      for (const text of entriesIn(sent.messages)) {
        const seen = firstSeen.get(header(text))
        if (seen === undefined) firstSeen.set(header(text), text)
        else expect(text).toBe(seen)
      }
    }
    expect(firstSeen.size).toBe(TURNS - 1)
  }, 60_000)

  it('(c) renders a superseded snapshot in an entry as a note, never as a user request line', async () => {
    const h = await churn()
    const events = h.captured.at(-1)!.events
    const written = events.filter(isEntry)
    expect(written.length).toBeGreaterThanOrEqual(2)
    for (const entry of written) {
      const text = textOf(entry)
      expect(text).not.toContain('RUNTIME_SNAPSHOT_')
      expect(text).not.toContain('x'.repeat(100))
    }
    // Turn 1's own snapshot is sealed with turn 1, whose user message stays pinned on the surface.
    const first = written[0]!
    expect(header(textOf(first))).toContain(`${TAPE_PREFIX}1-1 · 1 turn(s) sealed`)
    expect(first.sourceEventSeqs?.some(seq => isSnapshot(events[seq]!))).toBe(true)
    expect(textOf(first)).toContain('[slice note · runtime-context snapshot superseded by a later one')
    // From turn 2 on the note sits inside its own turn block, after that turn's request line.
    const second = written[1]!
    expect(header(textOf(second))).toContain(`${TAPE_PREFIX}2-2 · 1 turn(s) sealed`)
    expect(textOf(second)).toMatch(/\[turn 2\]\nQUESTION_2\n\[slice note · runtime-context snapshot superseded by a later one; not repeated here · verbatim: recall_turn\(\{"turn":"2"\}\)\]/)
  }, 60_000)

  it('(d) accepts a history section in the plugin config, reports a misspelt one and migrates the retired water marks', async () => {
    const h = await nativeHarness([nativeText('fine')], { config: { history: { keepRecentTurns: 2, entryMaxChars: 4_000 } } })
    live.push(h)
    const { agent } = await h.ctx.agents.create({ sessionId: SessionId('history-config'), agentOptions: { provider: 'native-mock', model: 'deterministic' } })
    await nativeSend(agent, 'hello')
    expect(h.errors).toEqual([])
    await expect(nativeHarness([], { config: { histroy: {} } as unknown as Config }))
      .rejects.toThrow('Unknown slice configuration key histroy. Did you mean history?')
    // The water marks this gate was written against are retired, and each says where it went.
    await expect(nativeHarness([], { config: { history: { highWaterChars: 20_000, lowWaterChars: 8_000 } } as unknown as Config }))
      .rejects.toThrow('Retired history configuration highWaterChars')
    await expect(nativeHarness([], { config: { history: { keepRecentChars: 2_000 } } as unknown as Config }))
      .rejects.toThrow('Retired history configuration keepRecentChars: use history.keepRecentTurns')
  })
})
