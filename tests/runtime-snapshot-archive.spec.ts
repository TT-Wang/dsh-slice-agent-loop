/**
 * Acceptance gate for porting the superseded-runtime-snapshot fix into the pressure-archive control law:
 * superseded snapshots are archivable at a pressure event, the live one is never shadowed, and nothing is
 * rewritten between pressure events.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage, foldSurface, isReplacementSurfaceEvent, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { CHECKPOINT_PREFIX, HISTORY_SOURCE, RUNTIME_CONTEXT_SOURCE } from '../src/context.js'
import type { Config } from '../src/index.js'
import { nativeHarness, nativeSend, nativeText, nativeTool, type CapturedRequest, type NativeHarness } from './native-harness.js'

const live: NativeHarness[] = []
afterEach(async () => {
  for (const harness of live.splice(0).reverse()) await harness.ctx.fiber.dispose()
})

const WATER: Config = { history: { highWaterChars: 20_000, lowWaterChars: 8_000, keepRecentChars: 2_000 } }
const TURNS = 60

function isSnapshot(event: SessionEvent): event is SessionEvent<'user/message'> {
  return event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === RUNTIME_CONTEXT_SOURCE
}

function isCheckpoint(event: SessionEvent): event is SessionEvent<'user/message'> {
  return event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === HISTORY_SOURCE
    && event.data.content.some(block => block.type === 'text' && block.text.startsWith(CHECKPOINT_PREFIX))
}

function textOf(event: SessionEvent<'user/message'>): string {
  return event.data.content.map(block => block.type === 'text' ? block.text : '').join('')
}

/** Every third turn runs one tool step, so tool-continuation requests are part of the sequence. */
async function churn(): Promise<NativeHarness> {
  const responses: StreamChunk[][] = []
  for (let turn = 1; turn <= TURNS; turn += 1) {
    if (turn % 3 === 0) responses.push(nativeTool(`probe-${turn}`, 'probe', { turn }))
    responses.push(nativeText(`ANSWER_${turn}`))
  }
  const h = await nativeHarness(responses, { config: WATER })
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

/** Indices of captured requests at which a slice archive event (our replacement appends) became visible. */
function archiveIndices(captured: readonly CapturedRequest[]): number[] {
  return captured.flatMap((entry, index) => {
    const before = index === 0 ? 0 : captured[index - 1]!.events.length
    return entry.events.slice(before).some(ours) ? [index] : []
  })
}

describe('superseded runtime snapshots under the pressure-archive control law', () => {
  it('(a) never walls, archives repeatedly, and leaves only the unshadowed live snapshot after each archive', async () => {
    const h = await churn()
    expect(h.errors).toEqual([])
    expect(h.errors.some(error => String(error).includes('SliceBudgetError'))).toBe(false)
    expect(h.adapter.requests).toHaveLength(TURNS + TURNS / 3)
    const turnEnds = h.captured.at(-1)!.events.filter(event => event.type === 'turn/end')
    expect(turnEnds).toHaveLength(TURNS - 1) // the last turn/end lands after the last capture
    const events = h.captured.at(-1)!.events
    expect(events.filter(event => event.type === 'turn/end').every(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')).toBe(true)

    const indices = archiveIndices(h.captured)
    expect(indices.length).toBeGreaterThanOrEqual(2)
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
    // An event may shed only dead snapshots (one-line notes) when that already reaches lowWater;
    // later ones archive dialogue into checkpoints that nest the earlier notes.
    const checkpointEvents = indices.filter(index => {
      const before = index === 0 ? 0 : h.captured[index - 1]!.events.length
      return h.captured[index]!.events.slice(before).some(isCheckpoint)
    })
    expect(checkpointEvents.length).toBeGreaterThanOrEqual(2)
    for (const captured of h.captured) expectReconstructable(captured)
  }, 60_000)

  it('(b) rewrites nothing between archive events: each request strictly extends the previous one', async () => {
    const h = await churn()
    const indices = new Set(archiveIndices(h.captured))
    expect(indices.size).toBeGreaterThanOrEqual(2)
    let extensions = 0
    for (let i = 1; i < h.adapter.requests.length; i += 1) {
      if (indices.has(i)) continue
      const earlier = h.adapter.requests[i - 1]!.messages
      const later = h.adapter.requests[i]!.messages
      expect(later.length).toBeGreaterThan(earlier.length)
      expect(firstDivergence(earlier, later)).toBe(earlier.length)
      extensions += 1
    }
    // Superseded snapshots were therefore not removed turn by turn: between events they accumulate.
    expect(extensions).toBe(h.adapter.requests.length - 1 - indices.size)
    const beforeFirst = h.captured[[...indices][0]! - 1]!.events
    expect(foldSurface(beforeFirst).nodes.filter(seq => isSnapshot(beforeFirst[seq]!)).length).toBeGreaterThan(2)
  }, 60_000)

  it('(c) renders a superseded snapshot in a checkpoint as a note, never as a user request line', async () => {
    const h = await churn()
    const events = h.captured.at(-1)!.events
    const checkpoints = events.filter(isCheckpoint)
    expect(checkpoints.length).toBeGreaterThanOrEqual(2)
    for (const checkpoint of checkpoints) {
      const text = textOf(checkpoint)
      expect(text).not.toContain('RUNTIME_SNAPSHOT_')
      expect(text).not.toContain('x'.repeat(100))
    }
    const first = checkpoints[0]!
    expect(first.sourceEventSeqs?.some(seq => isSnapshot(events[seq]!))).toBe(true)
    expect(textOf(first)).toMatch(/\[turn 2\]\nQUESTION_2\n\[slice note · runtime-context snapshot superseded by a later one; not repeated here · verbatim: recall_turn\(\{"turn":"2"\}\)\]/)
  }, 60_000)

  it('(d) accepts a history section in the plugin config and reports a misspelt one', async () => {
    const h = await nativeHarness([nativeText('fine')], { config: { history: { highWaterChars: 20_000, lowWaterChars: 8_000 } } })
    live.push(h)
    const { agent } = await h.ctx.agents.create({ sessionId: SessionId('history-config'), agentOptions: { provider: 'native-mock', model: 'deterministic' } })
    await nativeSend(agent, 'hello')
    expect(h.errors).toEqual([])
    await expect(nativeHarness([], { config: { histroy: {} } as unknown as Config }))
      .rejects.toThrow('Unknown slice configuration key histroy. Did you mean history?')
  })
})
