/** Independent integration gates against the stock DSH runtime and durable surface. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage, freezeMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { ImageBlock, Message } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage, foldRequestHeader, foldSurface, isReplacementSurfaceEvent, KNOWN_SESSION_EVENT_TYPES, SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import {
  nativeFailure, nativeHarness, nativeMessage, nativeSend, nativeText, nativeTool,
  type CapturedRequest, type NativeHarness,
} from './native-harness.js'
import { TAPE_PREFIX } from '../src/context.js'
import { type Config } from '../src/index.js'

/** The default keep window, spelled out: a completed turn seals into one entry at the next turn's first step. */
const SEAL: Config = { history: { keepRecentTurns: 0 } }

const live: NativeHarness[] = []
const roots: string[] = []
afterEach(async () => {
  for (const harness of live.splice(0).reverse()) await harness.ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function boot(...args: Parameters<typeof nativeHarness>): Promise<NativeHarness> {
  const harness = await nativeHarness(...args)
  live.push(harness)
  return harness
}

async function create(harness: NativeHarness, id: string) {
  return harness.ctx.agents.create({
    sessionId: SessionId(id),
    agentOptions: { provider: 'native-mock', model: 'deterministic' },
  })
}

function textIn(messages: readonly Message[]): string {
  return messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
}

/** Sealed tape entries of one dispatched request, in surface order. */
function entriesIn(messages: readonly Message[]): string[] {
  return messages.flatMap(message => {
    const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
    return text.startsWith(TAPE_PREFIX) ? [text] : []
  })
}

/** The turn range an entry's header declares, e.g. '1-1'. */
function rangeOf(entry: string): string {
  return entry.slice(TAPE_PREFIX.length).split(' ')[0]!
}

function firstDivergence(a: readonly Message[], b: readonly Message[]): number {
  let i = 0
  while (i < a.length && i < b.length && JSON.stringify(a[i]) === JSON.stringify(b[i])) i += 1
  return i
}

/**
 * The property the tape exists for: a seal lands after every entry already written, so no request
 * diverges from its predecessor before them and only the new entry is re-billed.
 */
function expectStablePrefix(requests: ReadonlyArray<{ messages: readonly Message[] }>): void {
  for (let i = 1; i < requests.length; i += 1) {
    const earlier = requests[i - 1]!.messages
    expect(firstDivergence(earlier, requests[i]!.messages)).toBeGreaterThanOrEqual(entriesIn(earlier).length)
  }
}

/** Reconstruct from a dispatch-time serialized log, without the plugin's projector. */
function expectReconstructable({ request, events }: CapturedRequest): void {
  const surface = foldSurface(events)
  const expected = surface.nodes.flatMap(seq => {
    const event = events[seq]
    if (event === undefined) throw new Error(`missing source event ${seq}`)
    const message = deriveEventMessage(event)
    return message === null ? [] : [message]
  })
  expect(request.messages).toEqual(expected)
  const header = foldRequestHeader(events)
  expect(header).toBeDefined()
  expect({
    provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort,
    temperature: request.temperature, maxTokens: request.maxTokens, stop: request.stop,
  }).toEqual({
    provider: header?.config.provider, model: header?.config.model, reasoningEffort: header?.config.reasoningEffort,
    temperature: header?.config.temperature, maxTokens: header?.config.maxTokens, stop: header?.config.stop,
  })
  expect(request.system).toEqual(header?.system)
  expect(request.tools ?? []).toEqual(header?.tools ?? [])
  expect(Object.isFrozen(request)).toBe(true)
  expect(Object.isFrozen(request.messages)).toBe(true)
}

describe('slice context on the native DSH loop', () => {
  it('reconstructs every request and retains the stock turn projection through positional history replacements', async () => {
    const h = await boot([nativeText('first durable answer'), nativeText('second answer'), nativeText('third answer')], { config: SEAL })
    const { agent } = await create(h, 'native-reconstruction')
    await nativeSend(agent, 'first question')
    await nativeSend(agent, 'second question')
    await nativeSend(agent, 'third question')

    expect(h.adapter.requests).toHaveLength(3)
    expect(h.errors).toEqual([])
    for (const captured of h.captured) expectReconstructable(captured)
    expect(agent.session.snapshotEvents().some(isReplacementSurfaceEvent)).toBe(true)
    expect(h.ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')).toMatchObject({ lastTurn: 3, openTurnStartSeq: null })
    // Turn 1 is already one entry at the first step of turn 2, and its reply text lives inside it.
    expect(textIn(h.adapter.requests[1]!.messages)).toContain(`${TAPE_PREFIX}1-1`)
    expect(textIn(h.adapter.requests[1]!.messages)).toContain('first durable answer')
    expect(entriesIn(h.adapter.requests[2]!.messages).map(rangeOf)).toEqual(['1-1', '2-2'])
    expect(textIn(h.adapter.requests[2]!.messages)).toContain('first durable answer')
    expectStablePrefix(h.adapter.requests)
    const originals = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.surfaceOp === 'append')
    expect(originals.map(event => event.type === 'user/message' ? event.data.content : [])).toEqual([
      nativeMessage('first question').content,
      nativeMessage('second question').content,
      nativeMessage('third question').content,
    ])
  })

  it('seals across an empty assistant reply that the stock loop leaves on the surface', async () => {
    const empty: import('@deepseek-ai/dsh-llm').StreamChunk[] = [
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 0 } }, { type: 'finish', reason: { kind: 'stop' } },
    ]
    const h = await boot([nativeText('one'), empty, nativeText('three'), nativeText('four'), nativeText('five')], { config: SEAL })
    const { agent } = await create(h, 'native-empty-reply')
    for (const input of ['first', 'second', 'third', 'fourth', 'fifth']) await nativeSend(agent, input)

    expect(h.errors).toEqual([])
    expect(h.adapter.requests).toHaveLength(5)
    const emptyReply = agent.session.snapshotEvents().find(event => event.type === 'assistant/message' && event.data.message.content.length === 0)!
    expect(emptyReply).toBeDefined()
    expect(agent.session.surface.nodes).not.toContain(emptyReply.seq)
    expect(agent.session.snapshotEvents().some(event => isReplacementSurfaceEvent(event) && event.sourceEventSeqs?.includes(emptyReply.seq))).toBe(true)
    expect([...agent.session.snapshotEvents()].reverse().find(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
    for (const captured of h.captured) expectReconstructable(captured)
    expectStablePrefix(h.adapter.requests)
  })

  it('preserves unchanged runtime and plugin authority nodes through three sealed turns', async () => {
    const h = await boot([nativeText('one'), nativeText('two'), nativeText('three')], { config: SEAL })
    h.ctx.systemPrompt.context({ name: 'native-runtime', order: 50, text: 'UNCHANGED_RUNTIME_SENTINEL' })
    const { agent } = await create(h, 'native-runtime')
    const authority = createUserMessage({
      content: [{ type: 'text', text: 'OPAQUE_PLUGIN_AUTHORITY_SENTINEL' }],
      source: { kind: 'plugin', plugin: 'foreign-authority', form: 'notice', summary: 'Persistent authority fixture' },
    })
    agent.inject(authority)
    for (const input of ['first', 'second', 'third']) await nativeSend(agent, input)

    expect(h.adapter.requests).toHaveLength(3)
    for (const request of h.adapter.requests) {
      expect(textIn(request.messages).split('UNCHANGED_RUNTIME_SENTINEL')).toHaveLength(2)
      expect(request.messages.filter(message => message.id === authority.id)).toEqual([authority])
    }
    expect(h.errors).toEqual([])
    for (const captured of h.captured) expectReconstructable(captured)
  })

  it('keeps a runtime update and clear marker authoritative after its turn is sealed', async () => {
    const h = await boot([nativeText('one'), nativeText('two'), nativeText('three')], { config: SEAL })
    let remove = h.ctx.systemPrompt.context({ name: 'native-runtime', order: 50, text: 'RUNTIME_A' })
    const { agent } = await create(h, 'native-runtime-change')
    await nativeSend(agent, 'first')
    remove()
    remove = h.ctx.systemPrompt.context({ name: 'native-runtime', order: 50, text: 'RUNTIME_B' })
    await nativeSend(agent, 'second')
    remove()
    await nativeSend(agent, 'third')

    const latestRuntime = h.adapter.requests.map(request => request.messages.filter(message =>
      message.role === 'user' && message.source.kind === 'plugin' && message.source.plugin === '@deepseek-ai/dsh-system-prompt').at(-1))
    expect(latestRuntime.map(message => message === undefined ? '' : textIn([message]))).toEqual([
      expect.stringContaining('RUNTIME_A'), expect.stringContaining('RUNTIME_B'),
      'Current runtime context: none. Earlier runtime-context snapshots no longer apply.',
    ])
    // Each superseded snapshot leaves with the entry of the turn it belongs to, so the text of a
    // retired runtime context never reaches a later request.
    expect(textIn(h.adapter.requests[2]!.messages)).not.toContain('RUNTIME_A')
    expect(textIn(h.adapter.requests[2]!.messages)).not.toContain('RUNTIME_B')
    expect(h.errors).toEqual([])
    expectStablePrefix(h.adapter.requests)
  })

  it('keeps superseded runtime snapshots raw inside the keep window and absorbs each one when its turn seals', async () => {
    const turns = 60
    const keepRecentTurns = 3
    const h = await boot(Array.from({ length: turns }, (_, index) => nativeText(`answer ${index + 1}`)), {
      config: { history: { keepRecentTurns } },
    })
    let tick = 0
    h.ctx.systemPrompt.variable('tick', () => `${tick}`.padStart(6, '0') + 'x'.repeat(3_000))
    h.ctx.systemPrompt.context({ name: 'changing-runtime', order: 50, text: 'RUNTIME {{tick}}' })
    const { agent } = await create(h, 'native-runtime-churn')
    const surfaceSnapshots: number[] = []
    for (let turn = 1; turn <= turns; turn += 1) {
      tick = turn
      h.captured.length = 0 // the fixture keeps a full event-log clone per request
      await nativeSend(agent, `question ${turn}`)
      surfaceSnapshots.push(agent.session.surface.nodes.filter(seq => {
        const event = agent.session.eventAt(seq)!
        return event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === '@deepseek-ai/dsh-system-prompt'
      }).length)
    }

    // On 5149e89 every snapshot stayed protected and the default-config session walled on
    // maxRequestChars; on the pressure-archive build each one was shadowed by a note pass that
    // rewrote the prefix. The tape does neither: a dead snapshot rides along raw while its turn is
    // still inside the keep window, and is absorbed by that turn's entry when the turn seals.
    expect(h.adapter.requests).toHaveLength(turns)
    expect(h.errors).toEqual([])
    // One per completed turn still held raw, plus the live one, then a flat ceiling: the count
    // tracks the keep window instead of the length of the session.
    expect(surfaceSnapshots.slice(0, keepRecentTurns + 1)).toEqual([1, 2, 3, 4])
    expect([...new Set(surfaceSnapshots.slice(keepRecentTurns + 1))]).toEqual([keepRecentTurns + 1])
    const last = h.adapter.requests.at(-1)!.messages
    const projected = last.filter(message => message.role === 'user' && message.source.kind === 'plugin'
      && message.source.plugin === '@deepseek-ai/dsh-system-prompt')
    expect(textIn([projected.at(-1)!])).toContain(`RUNTIME ${String(turns).padStart(6, '0')}`)
    expect(textIn(last)).not.toContain('RUNTIME 000001')
    expectStablePrefix(h.adapter.requests)
    for (const captured of h.captured) expectReconstructable(captured)
  }, 60_000)

  it('preserves structured image content and its position in current input after earlier turns are sealed', async () => {
    const h = await boot([nativeText('prior answer'), nativeText('middle answer'), nativeText('image answer')], { config: SEAL })
    const { agent } = await create(h, 'native-image')
    await nativeSend(agent, 'earliest request')
    await nativeSend(agent, 'prior request')
    const image: ImageBlock = {
      type: 'image',
      attachment: { attachmentId: 'sha256:0123456789abcdef' as ImageBlock['attachment']['attachmentId'], mediaType: 'image/png', bytes: 70, width: 1, height: 1 },
    }
    const message = createUserMessage({
      content: [{ type: 'text', text: 'before image' }, image, { type: 'text', text: 'after image' }], source: { kind: 'user' },
    })
    agent.followup(message)
    await agent.whenIdle()

    expect(h.adapter.requests).toHaveLength(3)
    expect(h.adapter.requests[2]!.messages.find(item => item.id === message.id)).toEqual(message)
    expect(agent.session.snapshotEvents().some(isReplacementSurfaceEvent)).toBe(true)
    expect(h.errors).toEqual([])
    expectStablePrefix(h.adapter.requests)
    for (const captured of h.captured) expectReconstructable(captured)
  })

  it('admits steering and extra context once when a continuation request retries', async () => {
    const h = await boot([nativeTool('retry-echo', 'echo'), nativeFailure(), nativeText('recovered')])
    const { agent } = await create(h, 'native-retry')
    const steering = nativeMessage('STEERING_ONCE_SENTINEL')
    const injected = createUserMessage({ content: [{ type: 'text', text: 'INJECTED_ONCE_SENTINEL' }], source: { kind: 'plugin', plugin: 'retry-fixture' } })
    h.ctx.tools.register(defineContentToolFixture({
      name: 'echo', description: 'Exercise a continuation step', parameters: {},
      async execute() {
        agent.steer(steering)
        agent.inject(injected)
        return [{ type: 'text', text: 'echo complete' }]
      },
    }))
    let recoveries = 0
    agent.ctx.on('agent/request-error', async () => { recoveries += 1; return { kind: 'retry' as const } })
    agent.ctx.on('agent/pre-step', async ({ step }, next) => {
      const decision = await next()
      return step === 2 && decision.kind === 'enter' ? { ...decision, startsRequestSeries: true } : decision
    })
    await nativeSend(agent, 'execute one tool')

    expect(h.adapter.requests).toHaveLength(3)
    expect(recoveries).toBe(1)
    expect(h.adapter.requests[1]!.messages).toEqual(h.adapter.requests[2]!.messages)
    for (const request of h.adapter.requests.slice(1)) {
      expect(request.messages.filter(message => message.id === steering.id)).toHaveLength(1)
      expect(request.messages.filter(message => message.id === injected.id)).toHaveLength(1)
    }
    expect(agent.session.snapshotEvents().flatMap(event => event.type === 'request/header' ? [event.data.reason] : [])).toEqual(['initial', 'series'])
    expect(h.errors).toEqual([])
    for (const captured of h.captured) expectReconstructable(captured)
  })

  it('honors the step limit without dispatching another model call', async () => {
    const h = await boot([nativeTool('limit-one', 'echo'), nativeTool('limit-two', 'echo')], { config: { maxStepsPerTurn: 2 } })
    h.ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'Return a result', parameters: {}, execute: async () => [{ type: 'text', text: 'ok' }] }))
    const { agent } = await create(h, 'native-limit')
    await nativeSend(agent, 'continue using tools')

    expect(h.adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'step/start')).toHaveLength(2)
    expect([...agent.session.snapshotEvents()].reverse().find(event => event.type === 'turn/end')?.data.reason.kind).toBe('blocked')
    expect(h.errors).toEqual([])
  })

  it('keeps another producer\'s canonical replacement authoritative across later slice turns', async () => {
    const h = await boot([nativeText('ORIGINAL_REPLY_MUST_STAY_SHADOWED'), nativeText('second'), nativeText('third'), nativeText('fourth')], { config: SEAL })
    const { agent } = await create(h, 'native-external-replacement')
    await nativeSend(agent, 'ORIGINAL_INPUT_MUST_STAY_SHADOWED')
    agent.ctx.on('agent/pre-step', async ({ turn }, next) => {
      if (turn === 2) {
        const source = [...agent.session.surface.nodes]
        agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'EXTERNAL_CANONICAL_SUMMARY' }], source: { kind: 'plugin', plugin: 'external-compaction' },
        }), {
          surfaceOp: { op: 'replace', start: source[0]!, end: source[source.length - 1]! }, sourceEventSeqs: source,
        })
      }
      return next()
    }, { prepend: true })
    await nativeSend(agent, 'second')
    await nativeSend(agent, 'third')
    await nativeSend(agent, 'fourth')

    expect(h.adapter.requests).toHaveLength(4)
    for (const request of h.adapter.requests.slice(1)) {
      expect(textIn(request.messages)).toContain('EXTERNAL_CANONICAL_SUMMARY')
      expect(textIn(request.messages)).not.toContain('ORIGINAL_INPUT_MUST_STAY_SHADOWED')
      expect(textIn(request.messages)).not.toContain('ORIGINAL_REPLY_MUST_STAY_SHADOWED')
    }
    expect(textIn(h.adapter.requests[3]!.messages)).toContain(`${TAPE_PREFIX}2-2`)
    expect(h.errors).toEqual([])
    for (const captured of h.captured) expectReconstructable(captured)
  })

  it('keeps tool call and result pairs intact when protected context splits completed history', async () => {
    const h = await boot([nativeTool('pair-one', 'echo'), nativeText('first completed'), nativeText('second completed'), nativeText('third completed')], { config: SEAL })
    const { agent } = await create(h, 'native-protected-tool-pair')
    h.ctx.tools.register(defineContentToolFixture({
      name: 'echo', description: 'Add context after one tool pair', parameters: {},
      async execute() {
        agent.inject(createUserMessage({ content: [{ type: 'text', text: 'PROTECTED_AFTER_TOOL' }], source: { kind: 'plugin', plugin: 'tool-authority' } }))
        return [{ type: 'text', text: 'tool result' }]
      },
    }))
    await nativeSend(agent, 'use the tool')
    await nativeSend(agent, 'continue after protected context')
    await nativeSend(agent, 'seal the first turn')

    expect(h.adapter.requests).toHaveLength(4)
    for (const request of h.adapter.requests) {
      const blocks = request.messages.flatMap(message => message.content)
      expect(blocks.flatMap(block => block.type === 'tool-call' ? [block.id] : []).sort())
        .toEqual(blocks.flatMap(block => block.type === 'tool-result' ? [block.toolCallId] : []).sort())
    }
    expect(textIn(h.adapter.requests[2]!.messages)).toContain('PROTECTED_AFTER_TOOL')
    expect(textIn(h.adapter.requests[3]!.messages)).toContain('PROTECTED_AFTER_TOOL')
    // The protected node cuts turn 1 in two, so the turn seals as two entries that keep their own
    // positions around it; the call/result pair stays inside one of them, as a recall pointer.
    expect(textIn(h.adapter.requests[3]!.messages)).toContain(`${TAPE_PREFIX}1-1`)
    expect(entriesIn(h.adapter.requests[3]!.messages).map(rangeOf)).toEqual(['1-1', '1-1', '2-2'])
    expect(entriesIn(h.adapter.requests[3]!.messages)[0]).toContain('[tool turn 1 step 1')
    expect(h.errors).toEqual([])
    expectStablePrefix(h.adapter.requests)
    for (const captured of h.captured) expectReconstructable(captured)
  })

  it('does not append context replacements after cancellation during pre-step contributions', async () => {
    const h = await boot([nativeText('first answer'), nativeText('second answer')], { config: SEAL })
    const { agent } = await create(h, 'native-pre-step-cancel')
    await nativeSend(agent, 'first input')
    await nativeSend(agent, 'second input')
    const before = agent.session.seq
    agent.ctx.on('agent/pre-step', async ({ turn }, next) => {
      const decision = await next()
      if (turn === 3) agent.cancel({ kind: 'user' })
      return decision
    })
    await nativeSend(agent, 'cancel before this step enters')

    expect(h.adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().slice(before).some(isReplacementSurfaceEvent)).toBe(false)
    expect([...agent.session.snapshotEvents()].reverse().find(event => event.type === 'turn/end')?.data.reason.kind).toBe('aborted')
  })

  it('recalls exact original tool output after digesting and replacing its conversational history', async () => {
    const original = `DOCUMENT_START\n${'row = stable value\n'.repeat(4_000)}EXACT_LAST_LINE\n`
    const h = await boot([
      nativeTool('large-result', 'large_document'), nativeText('document read'),
      nativeTool('recall-original', 'recall_turn', { turn: '1' }), nativeText('original recalled'),
    ])
    h.ctx.tools.register(defineContentToolFixture({
      name: 'large_document', description: 'Return a large document', parameters: {},
      execute: async () => [{ type: 'text', text: original }],
    }))
    const { agent } = await create(h, 'native-exact-recall')
    await nativeSend(agent, 'read the complete document')
    await nativeSend(agent, 'retrieve the original result from turn one')

    expect(h.adapter.requests).toHaveLength(4)
    expect(h.errors).toEqual([])
    const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result'
      && event.surfaceOp === 'append' && event.data.message.content[0]?.toolCallId === 'recall-original')
    if (result?.type !== 'tool/result') throw new Error('missing recall tool result')
    const text = result.data.message.content[0]!.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    const records = JSON.parse(text.split('## Original records (including reasoning, tool output and recorded file metadata)\n')[1]!) as Array<{
      type: string; data: { message?: { content: Array<{ toolCallId?: string; content?: Array<{ type: string; text?: string }> }> } }
    }>
    const record = records.find(event => event.type === 'tool/result' && event.data.message?.content[0]?.toolCallId === 'large-result')
    expect(record?.data.message?.content[0]?.content?.[0]?.text).toBe(original)
    expect(h.adapter.requests[3]!.messages).toContainEqual(result.data.message)
    for (const captured of h.captured) expectReconstructable(captured)
  })

  it('returns each original result once when recall_step reads a durably folded step', async () => {
    const original = `START\n${'ordinary unstructured content\n'.repeat(1_000)}END\n`
    const h = await boot([
      nativeTool('step-document', 'large_document'), nativeText('document read'),
      nativeTool('recall-step', 'recall_step', { turn: '1', step: '1' }), nativeText('step recalled'),
    ], { config: { fold: { pinSteps: 0 } } })
    h.ctx.tools.register(defineContentToolFixture({
      name: 'large_document', description: 'Return a document', parameters: {},
      execute: async () => [{ type: 'text', text: original }],
    }))
    const { agent } = await create(h, 'native-step-recall')
    await nativeSend(agent, 'read a document')
    await nativeSend(agent, 'recall its exact step output')

    expect(h.adapter.requests).toHaveLength(4)
    expect(h.errors).toEqual([])
    expect(agent.session.snapshotEvents().some(event => event.type === 'tool/result' && isReplacementSurfaceEvent(event))).toBe(true)
    const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result'
      && event.surfaceOp === 'append' && event.data.message.content[0]?.toolCallId === 'recall-step')
    if (result?.type !== 'tool/result') throw new Error('missing step recall')
    const text = result.data.message.content[0]!.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    expect(text).toContain(original)
    expect(text.split('[result]\n')).toHaveLength(2)
    expect(h.adapter.requests[3]!.messages).toContainEqual(result.data.message)
  })

  it('persists and resumes with runtime context, then opens the same session without slice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slice-native-resume-'))
    roots.push(root)
    const sessionId = SessionId('native-persistence')
    const originalVocabulary = [...KNOWN_SESSION_EVENT_TYPES].sort()
    const first = await boot([nativeText('PERSISTED_REPLY_SENTINEL'), nativeText('second answer')], { persistenceRoot: root, config: SEAL })
    first.ctx.systemPrompt.context({ name: 'native-runtime', order: 50, text: 'PERSISTED_RUNTIME_SENTINEL' })
    const { agent } = await create(first, sessionId)
    await nativeSend(agent, 'remember this')
    await nativeSend(agent, 'compact previous conversation')
    expect(first.errors).toEqual([])
    const beforeDispose = structuredClone(agent.session.snapshotEvents())
    await first.ctx.fiber.dispose()

    const second = await boot([nativeText('resumed with slice')], { persistenceRoot: root, config: SEAL })
    second.ctx.systemPrompt.context({ name: 'native-runtime', order: 50, text: 'PERSISTED_RUNTIME_SENTINEL' })
    const resumed = await second.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'native-mock', model: 'deterministic' } })
    expect(resumed.agent.session.snapshotEvents().slice(0, beforeDispose.length)).toEqual(beforeDispose)
    await nativeSend(resumed.agent, 'continue after reload')
    expect(second.adapter.requests).toHaveLength(1)
    expect(textIn(second.adapter.requests[0]!.messages)).toContain('PERSISTED_REPLY_SENTINEL')
    expect(textIn(second.adapter.requests[0]!.messages)).toContain(`${TAPE_PREFIX}1-1`)
    expect(resumed.agent.session.snapshotEvents().slice(beforeDispose.length).some(isReplacementSurfaceEvent)).toBe(true)
    // A reload does not re-render what the previous process sealed: turn 1's entry comes back byte
    // for byte, and the resumed turn seals turn 2 after it.
    expect(entriesIn(second.adapter.requests[0]!.messages).map(rangeOf)).toEqual(['1-1', '2-2'])
    expect(entriesIn(second.adapter.requests[0]!.messages)[0]).toBe(entriesIn(first.adapter.requests[1]!.messages)[0])
    expect(textIn(second.adapter.requests[0]!.messages).split('PERSISTED_RUNTIME_SENTINEL')).toHaveLength(2)
    expect(second.errors).toEqual([])
    for (const captured of second.captured) expectReconstructable(captured)
    await second.ctx.fiber.dispose()

    const stock = await boot([nativeText('stock continuation')], { persistenceRoot: root, slice: false })
    stock.ctx.systemPrompt.context({ name: 'native-runtime', order: 50, text: 'PERSISTED_RUNTIME_SENTINEL' })
    const loaded = await stock.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'native-mock', model: 'deterministic' } })
    await nativeSend(loaded.agent, 'continue with stock')
    expect(stock.adapter.requests).toHaveLength(1)
    expect(stock.errors).toEqual([])
    for (const captured of stock.captured) expectReconstructable(captured)
    expect([...KNOWN_SESSION_EVENT_TYPES].sort()).toEqual(originalVocabulary)
  })

  it('leaves the stock factory usable when slice contributions unload', async () => {
    const h = await boot([nativeText('slice answer'), nativeText('stock answer')])
    const { agent } = await create(h, 'native-unload')
    await nativeSend(agent, 'slice request')
    await h.sliceFiber?.dispose()
    const end = agent.session.seq
    await nativeSend(agent, 'stock request')

    expect(h.adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().slice(end).some(isReplacementSurfaceEvent)).toBe(false)
    expect(h.ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')).toMatchObject({ lastTurn: 2 })
    expect(h.errors).toEqual([])
  })

  it('keeps the stock invariant capable of rejecting changed later request content', async () => {
    const h = await boot([nativeText('one'), nativeText('two')])
    const { agent } = await create(h, 'native-tamper')
    await nativeSend(agent, 'first')
    await nativeSend(agent, 'second')
    const request = h.captured.at(-1)!.request
    const messages = agent.session.deriveMessages().map((message, index) => index === 0 ? message : freezeMessage({
      ...message, content: [{ type: 'text' as const, text: 'tampered later message' }],
    } as Message))
    Object.freeze(messages)
    const forged = markAgentLoopRequest(Object.freeze({ ...request, messages }))

    expect(() => h.ctx.llm.stream(forged)).toThrow(/durable derivation|reconstruction desync/)
    expect(h.adapter.requests).toHaveLength(2)
  })
})
