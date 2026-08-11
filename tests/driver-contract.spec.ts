import { Context } from 'cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import LlmService, { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import apply, { type Config } from '../src/index.js'
import {
  errorResponse,
  MockAdapter,
  multiToolCallResponse,
  textResponse,
  toolCallResponse,
} from './mock-adapter.js'

async function harness(adapter: MockAdapter, config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(apply, config)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}

describe('SliceLoopAgent contract gates', () => {
  it('runs one turn with balanced boundaries and a replayable user/assistant transcript', async () => {
    const adapter = new MockAdapter([textResponse('hello')])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('simple'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    send(handle.agent, 'hi')
    await handle.agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    const types = handle.agent.session.events.map(event => event.type)
    expect(types.filter(type => type === 'turn/start' || type === 'step/start'
      || type === 'step/end' || type === 'turn/end'))
      .toEqual(['turn/start', 'step/start', 'step/end', 'turn/end'])
    expect(types).toContain('user/message')
    expect(types).toContain('request/header')
    expect(types).toContain('request/context')
    expect(types).toContain('assistant/message')
    const chunks = handle.agent.session.events.filter(event => event.type === 'assistant/chunk')
    const assistant = handle.agent.session.events.find(event => event.type === 'assistant/message')
    expect(assistant?.sourceEventSeqs).toEqual(chunks.map(event => event.seq))
    expect(handle.agent.session.deriveMessages().map(message => message.role)).toEqual(['user', 'assistant'])
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects pre-step without opening a durable step and closes the turn blocked', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('reject'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.ctx.on('agent/pre-step', async () => ({ kind: 'reject' as const }))

    send(handle.agent, 'blocked')
    await handle.agent.whenIdle()

    expect(adapter.requests).toHaveLength(0)
    expect(handle.agent.session.events.some(event => event.type === 'step/start')).toBe(false)
    expect([...handle.agent.session.events].reverse()
      .find(event => event.type === 'turn/end')?.data.reason).toEqual({ kind: 'blocked' })
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('reports the verbatim Error object at agent/error', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('error-object'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const failure = new Error('pre-step exploded')
    let reported: unknown
    handle.agent.ctx.on('agent/error', ({ error }) => { reported = error })
    handle.agent.ctx.on('agent/pre-step', async () => { throw failure })

    send(handle.agent, 'trigger listener')
    await handle.agent.whenIdle()

    expect(reported === failure).toBe(true)
    expect([...handle.agent.session.events].reverse()
      .find(event => event.type === 'turn/end')?.data.reason)
      .toEqual({ kind: 'error', error: { message: 'pre-step exploded', code: 'UNKNOWN' } })
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('offers terminal provider failures to agent/request-error before retrying', async () => {
    const adapter = new MockAdapter([
      errorResponse('provider busy', 'SERVER'),
      textResponse('recovered'),
    ])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('request-error'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const failures: unknown[] = []
    handle.agent.ctx.on('agent/request-error', async ({ failure }) => {
      failures.push(failure)
      return { kind: 'retry' as const }
    })

    send(handle.agent, 'retry once')
    await handle.agent.whenIdle()

    expect(failures).toEqual([{ message: 'provider busy', code: 'SERVER' }])
    expect(adapter.requests).toHaveLength(2)
    expect(handle.agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('folds a frozen request proposal from the durable epoch across turns', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('request-config-fold'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const frozen: boolean[] = []
    let request = 0
    handle.agent.ctx.on('agent/request', async (_payload, next) => {
      const config = await next()
      frozen.push(Object.isFrozen(config))
      request += 1
      return request === 1 ? { ...config, temperature: 0.25 } : config
    })

    send(handle.agent, 'first')
    await handle.agent.whenIdle()
    send(handle.agent, 'second')
    await handle.agent.whenIdle()

    expect({
      frozen,
      requestTemperatures: adapter.requests.map(item => item.temperature),
      headerTemperatures: handle.agent.session.events.flatMap(event =>
        event.type === 'request/header' ? [event.data.header.config.temperature] : []),
    }).toEqual({
      frozen: [true, true],
      requestTemperatures: [0.25, 0.25],
      headerTemperatures: [0.25],
    })
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('makes the prior assistant turn available to the next bounded request', async () => {
    const adapter = new MockAdapter([
      textResponse('FIRST ASSISTANT ANSWER MARKER'),
      textResponse('continued'),
    ])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('cross-turn-continuity'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    send(handle.agent, 'first question')
    await handle.agent.whenIdle()
    send(handle.agent, 'what did you just answer?')
    await handle.agent.whenIdle()

    expect(JSON.stringify(adapter.requests[1]?.messages))
      .toContain('FIRST ASSISTANT ANSWER MARKER')
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('rebuilds bounded continuity from a seeded session after agent recreation', async () => {
    const adapter = new MockAdapter([
      textResponse('PERSISTED ASSISTANT ANSWER MARKER'),
      textResponse('resumed'),
    ])
    const ctx = await harness(adapter)
    const first = await ctx.agents.create({
      sessionId: SessionId('continuity-resume-source'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(first.agent, 'remember this across recreation')
    await first.agent.whenIdle()
    const seed = structuredClone(first.agent.session.events)
    await first.dispose()

    const resumed = await ctx.agents.create({
      sessionId: SessionId('continuity-resume-target'),
      seed,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(resumed.agent, 'what did the prior agent answer?')
    await resumed.agent.whenIdle()

    expect(JSON.stringify(adapter.requests[1]?.messages))
      .toContain('PERSISTED ASSISTANT ANSWER MARKER')
    await resumed.dispose()
    await ctx.fiber.dispose()
  })

  it('preserves sealed turn identity across recreation instead of minting resume aliases', async () => {
    const adapter = new MockAdapter([
      textResponse('SEALED ASSISTANT REPLY'),
      textResponse('live probe complete'),
      textResponse('resumed probe complete'),
    ])
    const ctx = await harness(adapter)
    const first = await ctx.agents.create({
      sessionId: SessionId('sealed-identity-source'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(first.agent, 'seal one turn')
    await first.agent.whenIdle()
    const seed = structuredClone(first.agent.session.events)

    send(first.agent, 'inspect the live sealed identity')
    await first.agent.whenIdle()
    const liveText = JSON.stringify(adapter.requests[1]?.messages)
    const liveId = liveText.match(/\[reply ([^\]]+)\]/)?.[1]
    await first.dispose()

    const resumed = await ctx.agents.create({
      sessionId: SessionId('sealed-identity-target'),
      seed,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(resumed.agent, 'inspect the live sealed identity')
    await resumed.agent.whenIdle()
    const resumedText = JSON.stringify(adapter.requests[2]?.messages)
    const resumedId = resumedText.match(/\[reply ([^\]]+)\]/)?.[1]

    expect({ liveId, resumedId }).toEqual({ liveId, resumedId: liveId })
    await resumed.dispose()
    await ctx.fiber.dispose()
  })

  it('honors a canonical surface replacement in both live and rebuilt bounded continuity', async () => {
    const originalUser = 'SHADOWED ORIGINAL USER TURN MUST DISAPPEAR'
    const originalAssistant = 'SHADOWED ORIGINAL ASSISTANT TURN MUST DISAPPEAR'
    const summary = 'CANONICAL COMPACTED TURN SUMMARY'
    const adapter = new MockAdapter([
      textResponse(originalAssistant),
      textResponse('live probe complete'),
      textResponse('resumed probe complete'),
    ])
    const ctx = await harness(adapter)
    const first = await ctx.agents.create({
      sessionId: SessionId('surface-replacement-source'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(first.agent, originalUser)
    await first.agent.whenIdle()

    const nodes = first.agent.session.surface.nodes
    first.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: summary }],
      source: { kind: 'plugin', plugin: 'driver-contract-compaction' },
    }), {
      surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes[1]! },
      sourceEventSeqs: [nodes[0]!, nodes[1]!],
    })
    const seed = structuredClone(first.agent.session.events)

    send(first.agent, 'inspect the live compacted continuity')
    await first.agent.whenIdle()
    const live = JSON.stringify(adapter.requests[1]?.messages)
    await first.dispose()

    const resumed = await ctx.agents.create({
      sessionId: SessionId('surface-replacement-target'),
      seed,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(resumed.agent, 'inspect the rebuilt compacted continuity')
    await resumed.agent.whenIdle()
    const rebuilt = JSON.stringify(adapter.requests[2]?.messages)

    const projection = (text: string) => ({
      summary: text.includes(summary),
      originalUser: text.includes(originalUser),
      originalAssistant: text.includes(originalAssistant),
    })
    expect({ live: projection(live), rebuilt: projection(rebuilt) }).toEqual({
      live: { summary: true, originalUser: false, originalAssistant: false },
      rebuilt: { summary: true, originalUser: false, originalAssistant: false },
    })
    await resumed.dispose()
    await ctx.fiber.dispose()
  })

  it('limits continuity compaction to the replaced surface span, not extra provenance sources', async () => {
    const retainedUser = 'UNSHADOWED EARLIER USER TURN MUST REMAIN'
    const retainedAssistant = 'UNSHADOWED EARLIER ASSISTANT TURN MUST REMAIN'
    const shadowedUser = 'SHADOWED LATER USER TURN MUST DISAPPEAR'
    const shadowedAssistant = 'SHADOWED LATER ASSISTANT TURN MUST DISAPPEAR'
    const summary = 'SUMMARY OF ONLY THE LATER TURN'
    const adapter = new MockAdapter([
      textResponse(retainedAssistant),
      textResponse(shadowedAssistant),
      textResponse('live probe complete'),
      textResponse('resumed probe complete'),
    ])
    const ctx = await harness(adapter)
    const first = await ctx.agents.create({
      sessionId: SessionId('surface-span-source'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(first.agent, retainedUser)
    await first.agent.whenIdle()
    send(first.agent, shadowedUser)
    await first.agent.whenIdle()

    const retainedUserEvent = first.agent.session.events.find(event =>
      event.type === 'user/message' && JSON.stringify(event.data.content).includes(retainedUser))
    const shadowedUserEvent = first.agent.session.events.find(event =>
      event.type === 'user/message' && JSON.stringify(event.data.content).includes(shadowedUser))
    const shadowedAssistantEvent = first.agent.session.events.find(event =>
      event.type === 'assistant/message' && event.data.turn === 2)
    if (retainedUserEvent?.type !== 'user/message'
      || shadowedUserEvent?.type !== 'user/message'
      || shadowedAssistantEvent?.type !== 'assistant/message') {
      throw new Error('missing surface-span fixture events')
    }
    first.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: summary }],
      source: { kind: 'plugin', plugin: 'driver-contract-compaction' },
    }), {
      surfaceOp: {
        op: 'replace',
        start: shadowedUserEvent.seq,
        end: shadowedAssistantEvent.seq,
      },
      // Legal extra derivation provenance from turn 1 must not expand the
      // surface span that the replacement actually shadows.
      sourceEventSeqs: [retainedUserEvent.seq, shadowedUserEvent.seq, shadowedAssistantEvent.seq],
    })
    const seed = structuredClone(first.agent.session.events)

    send(first.agent, 'inspect the live replacement span')
    await first.agent.whenIdle()
    const live = JSON.stringify(adapter.requests[2]?.messages)
    await first.dispose()

    const resumed = await ctx.agents.create({
      sessionId: SessionId('surface-span-target'),
      seed,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(resumed.agent, 'inspect the rebuilt replacement span')
    await resumed.agent.whenIdle()
    const rebuilt = JSON.stringify(adapter.requests[3]?.messages)

    const projection = (text: string) => ({
      summary: text.includes(summary),
      retainedUser: text.includes(retainedUser),
      retainedAssistant: text.includes(retainedAssistant),
      shadowedUser: text.includes(shadowedUser),
      shadowedAssistant: text.includes(shadowedAssistant),
    })
    const expected = {
      summary: true,
      retainedUser: true,
      retainedAssistant: true,
      shadowedUser: false,
      shadowedAssistant: false,
    }
    expect({ live: projection(live), rebuilt: projection(rebuilt) })
      .toEqual({ live: expected, rebuilt: expected })
    await resumed.dispose()
    await ctx.fiber.dispose()
  })

  it('follows nested surface replacements in both live and rebuilt bounded continuity', async () => {
    const originalUser = 'NESTED SHADOWED ORIGINAL USER MUST DISAPPEAR'
    const originalAssistant = 'NESTED SHADOWED ORIGINAL ASSISTANT MUST DISAPPEAR'
    const firstSummary = 'INTERMEDIATE COMPACTION SUMMARY MUST DISAPPEAR'
    const finalSummary = 'FINAL NESTED COMPACTION SUMMARY'
    const adapter = new MockAdapter([
      textResponse(originalAssistant),
      textResponse('live probe complete'),
      textResponse('resumed probe complete'),
    ])
    const ctx = await harness(adapter)
    const first = await ctx.agents.create({
      sessionId: SessionId('nested-surface-source'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(first.agent, originalUser)
    await first.agent.whenIdle()

    const originalNodes = first.agent.session.surface.nodes
    const intermediate = first.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: firstSummary }],
      source: { kind: 'plugin', plugin: 'driver-contract-compaction' },
    }), {
      surfaceOp: { op: 'replace', start: originalNodes[0]!, end: originalNodes[1]! },
      sourceEventSeqs: [originalNodes[0]!, originalNodes[1]!],
    })
    first.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: finalSummary }],
      source: { kind: 'plugin', plugin: 'driver-contract-compaction' },
    }), {
      // Replacing the currently active summary must transitively rewrite the
      // original turn carried by continuity, not leave the intermediate text.
      surfaceOp: { op: 'replace', start: intermediate.seq, end: intermediate.seq },
      sourceEventSeqs: [intermediate.seq],
    })
    const canonicalSurface = JSON.stringify(first.agent.session.deriveMessages())
    expect(canonicalSurface).toContain(finalSummary)
    expect(canonicalSurface).not.toContain(firstSummary)
    const seed = structuredClone(first.agent.session.events)

    send(first.agent, 'inspect the live nested replacement')
    await first.agent.whenIdle()
    const live = JSON.stringify(adapter.requests[1]?.messages)
    await first.dispose()

    const resumed = await ctx.agents.create({
      sessionId: SessionId('nested-surface-target'),
      seed,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(resumed.agent, 'inspect the rebuilt nested replacement')
    await resumed.agent.whenIdle()
    const rebuilt = JSON.stringify(adapter.requests[2]?.messages)

    const projection = (text: string) => ({
      finalSummary: text.includes(finalSummary),
      firstSummary: text.includes(firstSummary),
      originalUser: text.includes(originalUser),
      originalAssistant: text.includes(originalAssistant),
    })
    const expected = {
      finalSummary: true,
      firstSummary: false,
      originalUser: false,
      originalAssistant: false,
    }
    expect({ live: projection(live), rebuilt: projection(rebuilt) })
      .toEqual({ live: expected, rebuilt: expected })
    await resumed.dispose()
    await ctx.fiber.dispose()
  })

  it('uses surface order when a replacement span has descending event sequences', async () => {
    const firstUser = 'DESCENDING SPAN FIRST ORIGINAL USER MUST DISAPPEAR'
    const firstAssistant = 'DESCENDING SPAN FIRST ORIGINAL ASSISTANT MUST DISAPPEAR'
    const secondUser = 'DESCENDING SPAN SECOND ORIGINAL USER MUST DISAPPEAR'
    const secondAssistant = 'DESCENDING SPAN SECOND ORIGINAL ASSISTANT MUST DISAPPEAR'
    const firstSummary = 'DESCENDING SPAN INTERMEDIATE SUMMARY MUST DISAPPEAR'
    const finalSummary = 'DESCENDING SPAN FINAL SUMMARY'
    const adapter = new MockAdapter([
      textResponse(firstAssistant),
      textResponse(secondAssistant),
      textResponse('live probe complete'),
      textResponse('resumed probe complete'),
    ])
    const ctx = await harness(adapter)
    const first = await ctx.agents.create({
      sessionId: SessionId('descending-surface-source'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(first.agent, firstUser)
    await first.agent.whenIdle()
    send(first.agent, secondUser)
    await first.agent.whenIdle()

    const firstUserEvent = first.agent.session.events.find(event =>
      event.type === 'user/message' && JSON.stringify(event.data.content).includes(firstUser))
    const firstAssistantEvent = first.agent.session.events.find(event =>
      event.type === 'assistant/message' && event.data.turn === 1)
    const secondUserEvent = first.agent.session.events.find(event =>
      event.type === 'user/message' && JSON.stringify(event.data.content).includes(secondUser))
    const secondAssistantEvent = first.agent.session.events.find(event =>
      event.type === 'assistant/message' && event.data.turn === 2)
    if (firstUserEvent?.type !== 'user/message'
      || firstAssistantEvent?.type !== 'assistant/message'
      || secondUserEvent?.type !== 'user/message'
      || secondAssistantEvent?.type !== 'assistant/message') {
      throw new Error('missing descending-surface fixture events')
    }
    const intermediate = first.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: firstSummary }],
      source: { kind: 'plugin', plugin: 'driver-contract-compaction' },
    }), {
      surfaceOp: {
        op: 'replace',
        start: firstUserEvent.seq,
        end: firstAssistantEvent.seq,
      },
      sourceEventSeqs: [firstUserEvent.seq, firstAssistantEvent.seq],
    })
    expect(intermediate.seq).toBeGreaterThan(secondAssistantEvent.seq)
    first.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: finalSummary }],
      source: { kind: 'plugin', plugin: 'driver-contract-compaction' },
    }), {
      // Surface order is [intermediate, second user, second assistant], even
      // though the replacement node was appended after both later-turn nodes.
      surfaceOp: {
        op: 'replace',
        start: intermediate.seq,
        end: secondAssistantEvent.seq,
      },
      sourceEventSeqs: [intermediate.seq, secondUserEvent.seq, secondAssistantEvent.seq],
    })
    const canonicalSurface = JSON.stringify(first.agent.session.deriveMessages())
    expect(canonicalSurface).toContain(finalSummary)
    expect(canonicalSurface).not.toContain(firstSummary)
    expect(canonicalSurface).not.toContain(secondUser)
    const seed = structuredClone(first.agent.session.events)

    send(first.agent, 'inspect the live descending-sequence replacement span')
    await first.agent.whenIdle()
    const live = JSON.stringify(adapter.requests[2]?.messages)
    await first.dispose()

    const resumed = await ctx.agents.create({
      sessionId: SessionId('descending-surface-target'),
      seed,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(resumed.agent, 'inspect the rebuilt descending-sequence replacement span')
    await resumed.agent.whenIdle()
    const rebuilt = JSON.stringify(adapter.requests[3]?.messages)

    const projection = (text: string) => ({
      finalSummary: text.includes(finalSummary),
      firstSummary: text.includes(firstSummary),
      firstUser: text.includes(firstUser),
      firstAssistant: text.includes(firstAssistant),
      secondUser: text.includes(secondUser),
      secondAssistant: text.includes(secondAssistant),
    })
    const expected = {
      finalSummary: true,
      firstSummary: false,
      firstUser: false,
      firstAssistant: false,
      secondUser: false,
      secondAssistant: false,
    }
    expect({ live: projection(live), rebuilt: projection(rebuilt) })
      .toEqual({ live: expected, rebuilt: expected })
    await resumed.dispose()
    await ctx.fiber.dispose()
  })

  it('preserves the assistant when only a turn user node is replaced', async () => {
    const originalUser = 'PARTIAL USER ORIGINAL MUST DISAPPEAR'
    const replacementUser = 'PARTIAL USER REPLACEMENT MUST APPEAR'
    const originalAssistant = 'PARTIAL USER ASSISTANT MUST REMAIN'
    const adapter = new MockAdapter([
      textResponse(originalAssistant),
      textResponse('live probe complete'),
      textResponse('resumed probe complete'),
    ])
    const ctx = await harness(adapter)
    const first = await ctx.agents.create({
      sessionId: SessionId('partial-user-surface-source'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(first.agent, originalUser)
    await first.agent.whenIdle()

    const originalUserEvent = first.agent.session.events.find(event =>
      event.type === 'user/message' && JSON.stringify(event.data.content).includes(originalUser))
    if (originalUserEvent?.type !== 'user/message') {
      throw new Error('missing partial-user fixture event')
    }
    first.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: replacementUser }],
      source: { kind: 'plugin', plugin: 'driver-contract-compaction' },
    }), {
      surfaceOp: {
        op: 'replace',
        start: originalUserEvent.seq,
        end: originalUserEvent.seq,
      },
      sourceEventSeqs: [originalUserEvent.seq],
    })
    const canonicalSurface = JSON.stringify(first.agent.session.deriveMessages())
    expect(canonicalSurface).toContain(replacementUser)
    expect(canonicalSurface).toContain(originalAssistant)
    expect(canonicalSurface).not.toContain(originalUser)
    const seed = structuredClone(first.agent.session.events)

    send(first.agent, 'inspect the live partial-user replacement')
    await first.agent.whenIdle()
    const live = JSON.stringify(adapter.requests[1]?.messages)
    await first.dispose()

    const resumed = await ctx.agents.create({
      sessionId: SessionId('partial-user-surface-target'),
      seed,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(resumed.agent, 'inspect the rebuilt partial-user replacement')
    await resumed.agent.whenIdle()
    const rebuilt = JSON.stringify(adapter.requests[2]?.messages)

    const projection = (text: string) => ({
      replacementUser: text.includes(replacementUser),
      originalUser: text.includes(originalUser),
      originalAssistant: text.includes(originalAssistant),
    })
    const expected = {
      replacementUser: true,
      originalUser: false,
      originalAssistant: true,
    }
    expect({ live: projection(live), rebuilt: projection(rebuilt) })
      .toEqual({ live: expected, rebuilt: expected })
    await resumed.dispose()
    await ctx.fiber.dispose()
  })

  it('preserves the user and rewrites continuity when only an assistant node is replaced', async () => {
    const originalUser = 'PARTIAL ASSISTANT USER MUST REMAIN'
    const originalAssistant = 'PARTIAL ASSISTANT ORIGINAL MUST DISAPPEAR'
    const replacementAssistant = 'PARTIAL ASSISTANT REPLACEMENT MUST APPEAR'
    const adapter = new MockAdapter([
      textResponse(originalAssistant),
      textResponse('live probe complete'),
      textResponse('resumed probe complete'),
    ])
    const ctx = await harness(adapter)
    const first = await ctx.agents.create({
      sessionId: SessionId('partial-assistant-surface-source'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(first.agent, originalUser)
    await first.agent.whenIdle()

    const originalAssistantEvent = first.agent.session.events.find(event =>
      event.type === 'assistant/message' && event.data.turn === 1)
    if (originalAssistantEvent?.type !== 'assistant/message') {
      throw new Error('missing partial-assistant fixture event')
    }
    first.agent.session.append('assistant/message', {
      ...originalAssistantEvent.data,
      message: createAssistantMessage({
        content: [{ type: 'text', text: replacementAssistant }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, {
      surfaceOp: {
        op: 'replace',
        start: originalAssistantEvent.seq,
        end: originalAssistantEvent.seq,
      },
      sourceEventSeqs: [originalAssistantEvent.seq],
    })
    const canonicalSurface = JSON.stringify(first.agent.session.deriveMessages())
    expect(canonicalSurface).toContain(originalUser)
    expect(canonicalSurface).toContain(replacementAssistant)
    expect(canonicalSurface).not.toContain(originalAssistant)
    const seed = structuredClone(first.agent.session.events)

    send(first.agent, 'inspect the live partial-assistant replacement')
    await first.agent.whenIdle()
    const live = JSON.stringify(adapter.requests[1]?.messages)
    await first.dispose()

    const resumed = await ctx.agents.create({
      sessionId: SessionId('partial-assistant-surface-target'),
      seed,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(resumed.agent, 'inspect the rebuilt partial-assistant replacement')
    await resumed.agent.whenIdle()
    const rebuilt = JSON.stringify(adapter.requests[2]?.messages)

    const projection = (text: string) => ({
      originalUser: text.includes(originalUser),
      replacementAssistant: text.includes(replacementAssistant),
      originalAssistant: text.includes(originalAssistant),
    })
    const expected = {
      originalUser: true,
      replacementAssistant: true,
      originalAssistant: false,
    }
    expect({ live: projection(live), rebuilt: projection(rebuilt) })
      .toEqual({ live: expected, rebuilt: expected })
    await resumed.dispose()
    await ctx.fiber.dispose()
  })

  it('does not assign runtime-context replacement nodes to the turn user component', async () => {
    const originalUser = 'RUNTIME CONTEXT OWNER ORIGINAL USER MUST REMAIN'
    const originalAssistant = 'RUNTIME CONTEXT OWNER ASSISTANT MUST REMAIN'
    const contextMarker = 'RUNTIME CONTEXT OWNER SNAPSHOT'
    const replacementContext = 'RUNTIME CONTEXT REPLACEMENT MUST NOT BECOME THE TURN ASK'
    const adapter = new MockAdapter([
      textResponse(originalAssistant),
      textResponse('live probe complete'),
      textResponse('resumed probe complete'),
    ])
    const ctx = await harness(adapter)
    ctx.systemPrompt.context({
      name: 'audit:replacement-owner',
      order: 50,
      text: contextMarker,
    })
    const first = await ctx.agents.create({
      sessionId: SessionId('runtime-context-owner-source'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(first.agent, originalUser)
    await first.agent.whenIdle()

    const contextEvent = first.agent.session.events.find(event =>
      event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === '@deepseek-ai/dsh-system-prompt')
    if (contextEvent?.type !== 'user/message') {
      throw new Error('missing runtime-context fixture event')
    }
    first.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: replacementContext }],
      source: { kind: 'plugin', plugin: 'driver-contract-compaction' },
    }), {
      surfaceOp: { op: 'replace', start: contextEvent.seq, end: contextEvent.seq },
      sourceEventSeqs: [contextEvent.seq],
    })
    const seed = structuredClone(first.agent.session.events)

    send(first.agent, 'inspect the live runtime-context replacement owner')
    await first.agent.whenIdle()
    const live = JSON.stringify(adapter.requests[1]?.messages)
    await first.dispose()

    const resumed = await ctx.agents.create({
      sessionId: SessionId('runtime-context-owner-target'),
      seed,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(resumed.agent, 'inspect the rebuilt runtime-context replacement owner')
    await resumed.agent.whenIdle()
    const rebuilt = JSON.stringify(adapter.requests[2]?.messages)

    const projection = (text: string) => ({
      originalUser: text.includes(originalUser),
      originalAssistant: text.includes(originalAssistant),
      replacementAsTurnAsk: text.includes(`ask: ${replacementContext}`),
    })
    const expected = {
      originalUser: true,
      originalAssistant: true,
      replacementAsTurnAsk: false,
    }
    expect({ live: projection(live), rebuilt: projection(rebuilt) })
      .toEqual({ live: expected, rebuilt: expected })
    await resumed.dispose()
    await ctx.fiber.dispose()
  })

  it('does not assign same-turn steering replacements to the first-step user component', async () => {
    const originalUser = 'STEERING OWNER ORIGINAL USER MUST REMAIN'
    const steering = 'STEERING OWNER SAME-TURN INPUT'
    const replacementSteering = 'STEERING REPLACEMENT MUST NOT BECOME THE TURN ASK'
    const finalAssistant = 'STEERING OWNER FINAL ASSISTANT MUST REMAIN'
    const adapter = new MockAdapter([
      textResponse('first step answer'),
      textResponse(finalAssistant),
      textResponse('live probe complete'),
      textResponse('resumed probe complete'),
    ])
    const ctx = await harness(adapter)
    const first = await ctx.agents.create({
      sessionId: SessionId('steering-owner-source'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    let steered = false
    first.agent.ctx.on('agent/turn-stopping', ({ agent }) => {
      if (steered) return
      steered = true
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: steering }],
        source: { kind: 'plugin', plugin: 'driver-contract' },
      }))
    })
    send(first.agent, originalUser)
    await first.agent.whenIdle()

    const steeringEvent = first.agent.session.events.find(event =>
      event.type === 'user/message' && JSON.stringify(event.data.content).includes(steering))
    if (steeringEvent?.type !== 'user/message') {
      throw new Error('missing steering-owner fixture event')
    }
    first.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: replacementSteering }],
      source: { kind: 'plugin', plugin: 'driver-contract-compaction' },
    }), {
      surfaceOp: { op: 'replace', start: steeringEvent.seq, end: steeringEvent.seq },
      sourceEventSeqs: [steeringEvent.seq],
    })
    const seed = structuredClone(first.agent.session.events)

    send(first.agent, 'inspect the live steering replacement owner')
    await first.agent.whenIdle()
    const live = JSON.stringify(adapter.requests[2]?.messages)
    await first.dispose()

    const resumed = await ctx.agents.create({
      sessionId: SessionId('steering-owner-target'),
      seed,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(resumed.agent, 'inspect the rebuilt steering replacement owner')
    await resumed.agent.whenIdle()
    const rebuilt = JSON.stringify(adapter.requests[3]?.messages)

    const projection = (text: string) => ({
      originalUser: text.includes(originalUser),
      finalAssistant: text.includes(finalAssistant),
      replacementAsTurnAsk: text.includes(`ask: ${replacementSteering}`),
    })
    const expected = {
      originalUser: true,
      finalAssistant: true,
      replacementAsTurnAsk: false,
    }
    expect({ live: projection(live), rebuilt: projection(rebuilt) })
      .toEqual({ live: expected, rebuilt: expected })
    await resumed.dispose()
    await ctx.fiber.dispose()
  })

  it('replays same-turn steering with the same bounded grouping as the live agent', async () => {
    const marker = 'SAME TURN STEERING MUST NOT BECOME A NEW TURN MARKER'
    const adapter = new MockAdapter([
      textResponse('first step answer'),
      textResponse('second step answer'),
      textResponse('live probe complete'),
      textResponse('resumed probe complete'),
    ])
    const ctx = await harness(adapter)
    const first = await ctx.agents.create({
      sessionId: SessionId('steering-continuity-source'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    let steered = false
    first.agent.ctx.on('agent/turn-stopping', ({ agent }) => {
      if (steered) return
      steered = true
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: marker }],
        source: { kind: 'plugin', plugin: 'driver-contract' },
      }))
    })

    send(first.agent, 'one logical turn')
    await first.agent.whenIdle()
    const seed = structuredClone(first.agent.session.events)

    send(first.agent, 'continuity probe')
    await first.agent.whenIdle()
    const liveRequest = JSON.stringify(adapter.requests[2]?.messages)
    await first.dispose()

    const resumed = await ctx.agents.create({
      sessionId: SessionId('steering-continuity-target'),
      seed,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(resumed.agent, 'continuity probe')
    await resumed.agent.whenIdle()
    const resumedRequest = JSON.stringify(adapter.requests[3]?.messages)

    expect({
      live: liveRequest.includes(marker),
      resumed: resumedRequest.includes(marker),
    }).toEqual({ live: false, resumed: false })
    await resumed.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps steering from turn-stopping in the same turn as a later step', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('turn-stopping'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    let steered = false
    handle.agent.ctx.on('agent/turn-stopping', ({ agent }) => {
      if (steered) return
      steered = true
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: 'same turn' }],
        source: { kind: 'plugin', plugin: 'driver-contract' },
      }))
    })

    send(handle.agent, 'first step')
    await handle.agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    const boundaries = handle.agent.session.events.filter(event =>
      event.type === 'turn/start' || event.type === 'turn/end'
      || event.type === 'step/start' || event.type === 'step/end')
    expect(boundaries.map(event => event.type)).toEqual([
      'turn/start', 'step/start', 'step/end', 'step/start', 'step/end', 'turn/end',
    ])
    expect(boundaries.filter(event => event.type === 'turn/start')).toHaveLength(1)
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('closes queued followups as distinct balanced turns', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('two-turns'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    send(handle.agent, 'one')
    send(handle.agent, 'two')
    await handle.agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(handle.agent.session.events.filter(event =>
      event.type === 'turn/start' || event.type === 'turn/end').map(event => event.type))
      .toEqual(['turn/start', 'turn/end', 'turn/start', 'turn/end'])
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('runs the complete request lifetime inside the exact agent initiator scope', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('initiator'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    let initiator: Agent | undefined
    handle.agent.ctx.on('agent/request', async (_payload, next) => {
      initiator = ctx.agents.currentInitiator()
      return next()
    })

    send(handle.agent, 'owned request')
    await handle.agent.whenIdle()

    expect(initiator === handle.agent).toBe(true)
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('whenIdle follows replacement work started by the retiring idle transition', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('replacement')])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('reentrant-idle'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const replacementEntered = deferred<void>()
    const releaseReplacement = deferred<void>()
    let proposal = 0
    handle.agent.ctx.on('agent/pre-step', async (_payload, next) => {
      proposal += 1
      if (proposal !== 2) return next()
      replacementEntered.resolve(undefined)
      await releaseReplacement.promise
      return next()
    })
    let sentReplacement = false
    handle.agent.ctx.on('agent/status', ({ status }) => {
      if (status !== 'idle' || sentReplacement) return
      sentReplacement = true
      send(handle.agent, 'replacement')
    })

    send(handle.agent, 'first')
    let settled = false
    const idle = handle.agent.whenIdle().then(() => { settled = true })
    await replacementEntered.promise
    await Promise.resolve()

    const settledBeforeRelease = settled
    releaseReplacement.resolve(undefined)
    await idle
    await handle.agent.whenIdle()
    expect(settledBeforeRelease).toBe(false)
    expect(adapter.requests).toHaveLength(2)
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('carries the active abort signal into the model request', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('request-signal'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    send(handle.agent, 'cancellable')
    await handle.agent.whenIdle()

    expect(adapter.requests[0]?.signal).toBeInstanceOf(AbortSignal)
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('cancel keepInbox aborts the claimed turn and preserves later queued work', async () => {
    const adapter = new MockAdapter([textResponse('must not run'), textResponse('also must not run')])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('cancel-keep-inbox'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const entered = deferred<void>()
    const release = deferred<void>()
    let first = true
    handle.agent.ctx.on('agent/pre-step', async (_payload, next) => {
      if (!first) return next()
      first = false
      entered.resolve(undefined)
      await release.promise
      return next()
    })

    send(handle.agent, 'active')
    await entered.promise
    send(handle.agent, 'preserved')
    handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
    release.resolve(undefined)
    await handle.agent.whenIdle()

    expect(adapter.requests).toHaveLength(0)
    expect(handle.agent.inbox.nextTurn.map(message => message.content[0]))
      .toEqual([{ type: 'text', text: 'preserved' }])
    expect([...handle.agent.session.events].reverse()
      .find(event => event.type === 'turn/end')?.data.reason)
      .toEqual({ kind: 'aborted', reason: { kind: 'user' } })
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('executes tool calls through dsh-tools and continues in a later step', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'echo', { text: 'hello' }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    const executions: string[] = []
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo text',
      parameters: { text: { type: 'string', required: true } },
      execute: async ({ text }) => {
        executions.push(text)
        return [{ type: 'text', text }]
      },
    }))
    const handle = await ctx.agents.create({
      sessionId: SessionId('tool-call'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    send(handle.agent, 'use echo')
    await handle.agent.whenIdle()

    expect(executions).toEqual(['hello'])
    expect(adapter.requests).toHaveLength(2)
    expect(handle.agent.session.events.filter(event => event.type === 'tool/call')).toHaveLength(1)
    expect(handle.agent.session.events.filter(event => event.type === 'tool/result')).toHaveLength(1)
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('anchors a successful file edit into the next bounded slice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slice-loop-anchor-'))
    const path = join(root, 'anchored.txt')
    const marker = 'ANCHORED FILE CONTENT MARKER'
    const adapter = new MockAdapter([
      toolCallResponse('write-1', 'write_file', { path, content: marker }),
      textResponse('write complete'),
      textResponse('recalled'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'write_file',
      description: 'write a UTF-8 file',
      parameters: {
        path: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      execute: async ({ path: target, content }) => {
        await writeFile(target, content, 'utf8')
        return [{ type: 'text', text: 'written' }]
      },
    }))
    const handle = await ctx.agents.create({
      sessionId: SessionId('file-anchor'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    try {
      send(handle.agent, 'write the file')
      await handle.agent.whenIdle()
      send(handle.agent, 'recall the edited file')
      await handle.agent.whenIdle()

      expect(JSON.stringify(adapter.requests[2]?.messages)).toContain(marker)
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rebuilds durable file anchors from a seeded session after agent recreation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slice-loop-anchor-resume-'))
    const path = join(root, 'durable.txt')
    const marker = 'DURABLE FILE ANCHOR MUST SURVIVE AGENT RECREATION'
    const adapter = new MockAdapter([
      toolCallResponse('write-durable', 'write_file', { path, content: marker }),
      textResponse('write complete'),
      textResponse('resumed recall complete'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'write_file',
      description: 'write a UTF-8 file',
      parameters: {
        path: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      execute: async ({ path: target, content }) => {
        await writeFile(target, content, 'utf8')
        return [{ type: 'text', text: 'written' }]
      },
    }))
    const first = await ctx.agents.create({
      sessionId: SessionId('durable-file-anchor-source'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    try {
      send(first.agent, 'write the durable file')
      await first.agent.whenIdle()
      const seed = structuredClone(first.agent.session.events)
      await first.dispose()

      const resumed = await ctx.agents.create({
        sessionId: SessionId('durable-file-anchor-target'),
        seed,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      send(resumed.agent, 'recall the durable file without rediscovering it')
      await resumed.agent.whenIdle()

      const text = JSON.stringify(adapter.requests[2]?.messages)
      expect({
        tape: text.includes(marker),
        indexed: text.includes(`read_file(\\"${path}\\") to view`),
      }).toEqual({ tape: true, indexed: true })
      await resumed.dispose()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not replay a durable file anchor whose declared turn mismatches its enclosing turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slice-loop-anchor-turn-integrity-'))
    const path = join(root, 'mismatched.txt')
    const marker = 'MISMATCHED TURN ANCHOR MUST NOT ENTER THE REBUILT TAPE'
    const adapter = new MockAdapter([
      toolCallResponse('write-mismatched', 'write_file', { path, content: marker }),
      textResponse('write complete'),
      textResponse('resumed probe complete'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'write_file',
      description: 'write a UTF-8 file',
      parameters: {
        path: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      execute: async ({ path: target, content }) => {
        await writeFile(target, content, 'utf8')
        return [{ type: 'text', text: 'written' }]
      },
    }))
    const first = await ctx.agents.create({
      sessionId: SessionId('file-anchor-turn-integrity-source'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    try {
      send(first.agent, 'write the file whose anchor turn will be corrupted')
      await first.agent.whenIdle()
      const seed = structuredClone(first.agent.session.events)
      const anchor = seed.find(event => event.type === 'slice/file-anchor')
      if (anchor?.type !== 'slice/file-anchor') throw new Error('missing file-anchor fixture event')
      anchor.data.turn += 1
      await first.dispose()

      const resumed = await ctx.agents.create({
        sessionId: SessionId('file-anchor-turn-integrity-target'),
        seed,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      send(resumed.agent, 'inspect only structurally valid durable anchors')
      await resumed.agent.whenIdle()

      const text = JSON.stringify(adapter.requests[2]?.messages)
      expect({
        tape: text.includes(marker),
        indexed: text.includes(`read_file(\\"${path}\\") to view`),
      }).toEqual({ tape: false, indexed: false })
      await resumed.dispose()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not attach a durable file anchor emitted outside any turn to the next turn', async () => {
    const path = join(tmpdir(), 'slice-loop-orphan-anchor.txt')
    const marker = 'ORPHAN ANCHOR MUST NOT ENTER A LATER TURN TAPE'
    const adapter = new MockAdapter([
      textResponse('first turn complete'),
      textResponse('second turn complete'),
      textResponse('resumed probe complete'),
    ])
    const ctx = await harness(adapter)
    const first = await ctx.agents.create({
      sessionId: SessionId('orphan-file-anchor-source'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    send(first.agent, 'complete the first turn')
    await first.agent.whenIdle()
    first.agent.session.append('slice/file-anchor', { turn: 2, path, body: marker })
    send(first.agent, 'complete the second turn')
    await first.agent.whenIdle()
    const seed = structuredClone(first.agent.session.events)
    await first.dispose()

    const resumed = await ctx.agents.create({
      sessionId: SessionId('orphan-file-anchor-target'),
      seed,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(resumed.agent, 'inspect only turn-enclosed durable anchors')
    await resumed.agent.whenIdle()

    const text = JSON.stringify(adapter.requests[2]?.messages)
    expect({
      tape: text.includes(marker),
      indexed: text.includes(path),
    }).toEqual({ tape: false, indexed: false })
    await resumed.dispose()
    await ctx.fiber.dispose()
  })

  it('publishes an anchored file in the current OPEN FILES hash index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slice-loop-open-files-'))
    const path = join(root, 'indexed.txt')
    const adapter = new MockAdapter([
      toolCallResponse('write-indexed', 'write_file', { path, content: 'indexed content' }),
      textResponse('write complete'),
      textResponse('index checked'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'write_file',
      description: 'write a UTF-8 file',
      parameters: {
        path: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      execute: async ({ path: target, content }) => {
        await writeFile(target, content, 'utf8')
        return [{ type: 'text', text: 'written' }]
      },
    }))
    const handle = await ctx.agents.create({
      sessionId: SessionId('file-anchor-index'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    try {
      send(handle.agent, 'write the indexed file')
      await handle.agent.whenIdle()
      send(handle.agent, 'inspect the current file index')
      await handle.agent.whenIdle()

      const text = JSON.stringify(adapter.requests[2]?.messages)
      const openFiles = text.split('# OPEN FILES')[1]?.split('</context>')[0] ?? ''
      expect({
        path: openFiles.includes(path),
        hash: openFiles.includes('sha256:'),
      }).toEqual({ path: true, hash: true })
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('marks a deleted anchored file as missing instead of publishing a stale trusted hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slice-loop-deleted-index-'))
    const path = join(root, 'deleted.txt')
    const adapter = new MockAdapter([
      toolCallResponse('write-deleted', 'write_file', { path, content: 'will be deleted' }),
      textResponse('write complete'),
      textResponse('index checked'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'write_file',
      description: 'write a UTF-8 file',
      parameters: {
        path: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      execute: async ({ path: target, content }) => {
        await writeFile(target, content, 'utf8')
        return [{ type: 'text', text: 'written' }]
      },
    }))
    const handle = await ctx.agents.create({
      sessionId: SessionId('deleted-file-index'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    try {
      send(handle.agent, 'write the file')
      await handle.agent.whenIdle()
      await rm(path)
      send(handle.agent, 'inspect the current file index')
      await handle.agent.whenIdle()

      const text = JSON.stringify(adapter.requests[2]?.messages)
      const openFiles = text.split('# OPEN FILES')[1]?.split('</context>')[0] ?? ''
      expect({
        missing: openFiles.includes(`${path} (not created yet)`),
        staleHash: openFiles.includes('sha256:'),
      }).toEqual({ missing: true, staleHash: false })
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('redacts secret-shaped edited content before it enters the model-visible tape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slice-loop-redacted-anchor-'))
    const path = join(root, 'secret.env')
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz'
    const adapter = new MockAdapter([
      toolCallResponse('write-secret', 'write_file', { path, content: secret }),
      textResponse('write complete'),
      textResponse('tape checked'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'write_file',
      description: 'write a UTF-8 file',
      parameters: {
        path: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      execute: async ({ path: target, content }) => {
        await writeFile(target, content, 'utf8')
        return [{ type: 'text', text: 'written' }]
      },
    }))
    const handle = await ctx.agents.create({
      sessionId: SessionId('redacted-file-anchor'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    try {
      send(handle.agent, 'write the secret-bearing file')
      await handle.agent.whenIdle()
      send(handle.agent, 'inspect the safe tape')
      await handle.agent.whenIdle()

      expect(JSON.stringify(adapter.requests[2]?.messages)).not.toContain(secret)
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('captures each successful edit post-state instead of collapsing the turn to its final bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slice-loop-edit-snapshots-'))
    const path = join(root, 'twice.txt')
    const firstMarker = 'FIRST SUCCESSFUL EDIT POST-STATE MARKER'
    const secondMarker = 'SECOND SUCCESSFUL EDIT POST-STATE MARKER'
    const adapter = new MockAdapter([
      multiToolCallResponse([
        { id: 'write-first', name: 'write_file', args: { path, content: firstMarker } },
        { id: 'write-second', name: 'write_file', args: { path, content: secondMarker } },
      ]),
      textResponse('both writes complete'),
      textResponse('snapshots checked'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'write_file',
      description: 'write a UTF-8 file',
      parameters: {
        path: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      execute: async ({ path: target, content }) => {
        await writeFile(target, content, 'utf8')
        return [{ type: 'text', text: 'written' }]
      },
    }))
    const handle = await ctx.agents.create({
      sessionId: SessionId('edit-post-state-snapshots'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    try {
      send(handle.agent, 'apply both edits')
      await handle.agent.whenIdle()
      send(handle.agent, 'inspect both successful snapshots')
      await handle.agent.whenIdle()

      const text = JSON.stringify(adapter.requests[2]?.messages)
      expect({
        first: text.includes(firstMarker),
        second: text.includes(secondMarker),
      }).toEqual({ first: true, second: true })
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not anchor a failed edit call as a successful tape mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slice-loop-failed-anchor-'))
    const path = join(root, 'untouched.txt')
    const marker = 'PREEXISTING CONTENT MUST NOT BE CLAIMED AS AN APPLIED EDIT'
    await writeFile(path, marker, 'utf8')
    const adapter = new MockAdapter([
      toolCallResponse('write-failed', 'write_file', { path, content: 'replacement' }),
      textResponse('the write failed'),
      textResponse('recalled'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'write_file',
      description: 'a deliberately failing write fixture',
      parameters: {
        path: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      execute: async () => { throw new Error('deliberate write failure') },
    }))
    const handle = await ctx.agents.create({
      sessionId: SessionId('failed-file-anchor'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    try {
      send(handle.agent, 'attempt the failing write')
      await handle.agent.whenIdle()
      send(handle.agent, 'recall only successful edits')
      await handle.agent.whenIdle()

      expect(JSON.stringify(adapter.requests[2]?.messages)).not.toContain(marker)
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('assembles scoped system sections and registered tool schemas into the model request', async () => {
    const adapter = new MockAdapter([textResponse('ready')])
    const ctx = await harness(adapter)
    ctx.systemPrompt.section({ name: 'audit:system', order: 50, text: 'AUDIT SYSTEM MARKER' })
    ctx.tools.register(defineContentToolFixture({
      name: 'audit_echo',
      description: 'echo audit text',
      parameters: { text: { type: 'string', required: true } },
      execute: async ({ text }) => [{ type: 'text', text }],
    }))
    const handle = await ctx.agents.create({
      sessionId: SessionId('prompt-and-tools'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    send(handle.agent, 'discover the registered tool')
    await handle.agent.whenIdle()

    const header = handle.agent.session.events.find(event => event.type === 'request/header')
    const persisted = header?.type === 'request/header' ? header.data.header : undefined
    expect({
      requestSystem: adapter.requests[0]?.system?.includes('AUDIT SYSTEM MARKER') ?? false,
      requestTools: adapter.requests[0]?.tools?.map(tool => tool.name) ?? [],
      headerSystem: persisted?.system?.includes('AUDIT SYSTEM MARKER') ?? false,
      headerTools: persisted?.tools?.map(tool => tool.name) ?? [],
    }).toEqual({
      requestSystem: true,
      requestTools: ['audit_echo'],
      headerSystem: true,
      headerTools: ['audit_echo'],
    })
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('installs the byte-stable SliceAgent instruction prefix by default', async () => {
    const adapter = new MockAdapter([textResponse('ready')])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('slice-system-prompt'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    send(handle.agent, 'inspect the default instruction prefix')
    await handle.agent.whenIdle()

    const header = handle.agent.session.events.find(event => event.type === 'request/header')
    const persisted = header?.type === 'request/header' ? header.data.header.system : undefined
    expect({
      request: adapter.requests[0]?.system?.startsWith('You are sliceagent') ?? false,
      header: persisted?.startsWith('You are sliceagent') ?? false,
    }).toEqual({ request: true, header: true })
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('resolves the production memory-model splice before sending the system prompt', async () => {
    const adapter = new MockAdapter([textResponse('ready')])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('slice-memory-contract'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    send(handle.agent, 'inspect the production memory contract')
    await handle.agent.whenIdle()

    expect({
      unresolvedMarker: adapter.requests[0]?.system?.includes('{{MEMORY_MODEL}}') ?? false,
      contract: adapter.requests[0]?.system?.includes('# BRAIN AND SOURCE-LINKED ACTIVE WORK CONTRACT') ?? false,
    }).toEqual({ unresolvedMarker: false, contract: true })
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('does not re-seal the prior reply for a rejected no-step turn', async () => {
    const adapter = new MockAdapter([
      textResponse('PRIOR REPLY MARKER'),
      textResponse('after rejection'),
    ])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('reject-no-stale-seal'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    let boundary = 0
    handle.agent.ctx.on('agent/pre-step', async (_payload, next) => {
      boundary += 1
      if (boundary === 2) return { kind: 'reject' as const }
      return next()
    })

    send(handle.agent, 'first accepted turn')
    await handle.agent.whenIdle()
    send(handle.agent, 'rejected turn')
    await handle.agent.whenIdle()
    send(handle.agent, 'inspect the sealed tape')
    await handle.agent.whenIdle()

    const text = JSON.stringify(adapter.requests[1]?.messages)
    expect(text.match(/\[reply /g) ?? []).toHaveLength(1)
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('projects dynamic system-prompt context into durable model-visible input', async () => {
    const adapter = new MockAdapter([textResponse('ready')])
    const ctx = await harness(adapter)
    ctx.systemPrompt.context({
      name: 'audit:runtime-context',
      order: 50,
      text: 'AUDIT RUNTIME CONTEXT MARKER',
    })
    const handle = await ctx.agents.create({
      sessionId: SessionId('dynamic-prompt-context'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    send(handle.agent, 'read the runtime context')
    await handle.agent.whenIdle()

    const durableContext = handle.agent.session.events.find(event =>
      event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === '@deepseek-ai/dsh-system-prompt')
    expect({
      modelSawContext: JSON.stringify(adapter.requests[0]?.messages)
        .includes('AUDIT RUNTIME CONTEXT MARKER'),
      durableContext: durableContext?.type === 'user/message'
        && JSON.stringify(durableContext.data.content).includes('AUDIT RUNTIME CONTEXT MARKER'),
    }).toEqual({ modelSawContext: true, durableContext: true })
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps dynamic plugin context out of the exact CURRENT REQUEST authority slot', async () => {
    const adapter = new MockAdapter([textResponse('ready')])
    const ctx = await harness(adapter)
    ctx.systemPrompt.context({
      name: 'audit:lower-authority-context',
      order: 50,
      text: 'LOWER AUTHORITY PLUGIN CONTEXT MARKER',
    })
    const handle = await ctx.agents.create({
      sessionId: SessionId('context-authority'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    send(handle.agent, 'EXACT USER CURRENT REQUEST MARKER')
    await handle.agent.whenIdle()

    const blocks = adapter.requests[0]?.messages[0]?.content ?? []
    const userText = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const currentRequest = userText
      .split('# CURRENT REQUEST (what the user is asking for RIGHT NOW — your PRIMARY instruction; address THIS)\n')[1]
      ?.split('\n\n# NOW:')[0]
      ?.trim()
    expect({
      currentRequest,
      contextVisible: userText.includes('LOWER AUTHORITY PLUGIN CONTEXT MARKER'),
    }).toEqual({
      currentRequest: 'EXACT USER CURRENT REQUEST MARKER',
      contextVisible: true,
    })
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('deduplicates unchanged request epochs and request context across same-turn steps', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('stable-request-epoch'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    let steered = false
    handle.agent.ctx.on('agent/turn-stopping', ({ agent }) => {
      if (steered) return
      steered = true
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: 'same request epoch' }],
        source: { kind: 'plugin', plugin: 'driver-contract' },
      }))
    })

    send(handle.agent, 'first step')
    await handle.agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect({
      headers: handle.agent.session.events.filter(event => event.type === 'request/header').length,
      contexts: handle.agent.session.events.filter(event => event.type === 'request/context').length,
    }).toEqual({ headers: 1, contexts: 1 })
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('continues turn numbering from a balanced seeded session', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('resumed')])
    const ctx = await harness(adapter)
    const first = await ctx.agents.create({
      sessionId: SessionId('seed-source'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(first.agent, 'first turn')
    await first.agent.whenIdle()
    const seed = structuredClone(first.agent.session.events)
    await first.dispose()

    const resumed = await ctx.agents.create({
      sessionId: SessionId('seed-target'),
      seed,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(resumed.agent, 'second turn')
    await resumed.agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect({
      starts: resumed.agent.session.events.filter(event => event.type === 'turn/start')
        .map(event => event.data.turn),
      ends: resumed.agent.session.events.filter(event => event.type === 'turn/end')
        .map(event => event.data.turn),
    }).toEqual({ starts: [1, 2], ends: [1, 2] })
    await resumed.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps agent quiescence fulfilled when the maintenance caller observes rejection', async () => {
    const ctx = await harness(new MockAdapter([]))
    const handle = await ctx.agents.create({
      sessionId: SessionId('maintenance-rejection'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const failure = new Error('maintenance failed')

    await expect(handle.agent.runMaintenance(async () => { throw failure })).rejects.toBe(failure)
    await expect(handle.agent.whenIdle()).resolves.toBeUndefined()
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects invalid maxParallelToolCalls configuration in direct construction', () => {
    expect(() => new apply(new Context(), { maxParallelToolCalls: 0 })).toThrow(
      'maxParallelToolCalls must be a positive integer',
    )
    expect(() => new apply(new Context(), { maxParallelToolCalls: 1.5 })).toThrow(
      'maxParallelToolCalls must be a positive integer',
    )
  })

  it('overlaps concurrency-safe tool bodies up to maxParallelToolCalls', async () => {
    const adapter = new MockAdapter([
      multiToolCallResponse([
        { id: 'parallel-1', name: 'parallel_audit', args: { id: 'one' } },
        { id: 'parallel-2', name: 'parallel_audit', args: { id: 'two' } },
      ]),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, { maxParallelToolCalls: 2 })
    let active = 0
    let maxActive = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'parallel_audit',
      description: 'measure scheduler overlap',
      parameters: { id: { type: 'string', required: true } },
      isConcurrencySafe: () => true,
      execute: async ({ id }) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 20))
        active -= 1
        return [{ type: 'text', text: id }]
      },
    }))
    const handle = await ctx.agents.create({
      sessionId: SessionId('parallel-tool-calls'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    send(handle.agent, 'run both calls')
    await handle.agent.whenIdle()

    expect(maxActive).toBe(2)
    expect(handle.agent.session.events.filter(event => event.type === 'tool/result'))
      .toHaveLength(2)
    await handle.dispose()
    await ctx.fiber.dispose()
  })
})
