import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import LlmService, { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { KNOWN_SESSION_EVENT_TYPES, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture, TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import apply, { type Config } from '../src/index.js'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as agentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import * as sliceInvariant from '../src/invariant.js'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { sliceDigest, seedTextOf } from '../src/driver.js'
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

  it('removes a sealed assistant reply when its canonical replacement has empty content', async () => {
    const originalUser = 'EMPTY ASSISTANT REPLACEMENT USER MUST REMAIN'
    const originalAssistant = 'EMPTY ASSISTANT REPLACEMENT ORIGINAL MUST DISAPPEAR'
    const adapter = new MockAdapter([
      textResponse(originalAssistant),
      textResponse('live probe complete'),
      textResponse('resumed probe complete'),
    ])
    const ctx = await harness(adapter)
    const first = await ctx.agents.create({
      sessionId: SessionId('empty-assistant-replacement-source'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(first.agent, originalUser)
    await first.agent.whenIdle()

    const originalAssistantEvent = first.agent.session.events.find(event =>
      event.type === 'assistant/message' && event.data.turn === 1)
    if (originalAssistantEvent?.type !== 'assistant/message') {
      throw new Error('missing empty-assistant replacement fixture event')
    }
    first.agent.session.append('assistant/message', {
      ...originalAssistantEvent.data,
      message: createAssistantMessage({
        content: [],
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
    // Stock surface projection deliberately omits empty assistant messages:
    // the replacement removes the old assistant from derived history.
    const canonicalSurface = JSON.stringify(first.agent.session.deriveMessages())
    expect(canonicalSurface).toContain(originalUser)
    expect(canonicalSurface).not.toContain(originalAssistant)
    const seed = structuredClone(first.agent.session.events)

    send(first.agent, 'inspect the live empty-assistant replacement')
    await first.agent.whenIdle()
    const live = JSON.stringify(adapter.requests[1]?.messages)
    await first.dispose()

    const resumed = await ctx.agents.create({
      sessionId: SessionId('empty-assistant-replacement-target'),
      seed,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(resumed.agent, 'inspect the rebuilt empty-assistant replacement')
    await resumed.agent.whenIdle()
    const rebuilt = JSON.stringify(adapter.requests[2]?.messages)

    const projection = (text: string) => ({
      originalUser: text.includes(originalUser),
      originalAssistant: text.includes(originalAssistant),
    })
    const expected = { originalUser: true, originalAssistant: false }
    expect({ live: projection(live), rebuilt: projection(rebuilt) })
      .toEqual({ live: expected, rebuilt: expected })
    await resumed.dispose()
    await ctx.fiber.dispose()
  })

  it('adds a sealed reply when an empty assistant node is canonically replaced with text', async () => {
    const originalUser = 'EMPTY ASSISTANT INSERTION USER MUST REMAIN'
    const replacementAssistant = 'EMPTY ASSISTANT INSERTION REPLACEMENT MUST APPEAR'
    const adapter = new MockAdapter([
      [
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 0 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      textResponse('live probe complete'),
      textResponse('resumed probe complete'),
    ])
    const ctx = await harness(adapter)
    const first = await ctx.agents.create({
      sessionId: SessionId('empty-assistant-insertion-source'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(first.agent, originalUser)
    await first.agent.whenIdle()

    const emptyAssistantEvent = first.agent.session.events.find(event =>
      event.type === 'assistant/message' && event.data.turn === 1)
    if (emptyAssistantEvent?.type !== 'assistant/message'
      || emptyAssistantEvent.data.message.content.length !== 0) {
      throw new Error('missing empty-assistant insertion fixture event')
    }
    first.agent.session.append('assistant/message', {
      ...emptyAssistantEvent.data,
      message: createAssistantMessage({
        content: [{ type: 'text', text: replacementAssistant }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, {
      surfaceOp: {
        op: 'replace',
        start: emptyAssistantEvent.seq,
        end: emptyAssistantEvent.seq,
      },
      sourceEventSeqs: [emptyAssistantEvent.seq],
    })
    const canonicalSurface = JSON.stringify(first.agent.session.deriveMessages())
    expect(canonicalSurface).toContain(originalUser)
    expect(canonicalSurface).toContain(replacementAssistant)
    const seed = structuredClone(first.agent.session.events)

    send(first.agent, 'inspect the live empty-assistant insertion')
    await first.agent.whenIdle()
    const live = JSON.stringify(adapter.requests[1]?.messages)
    await first.dispose()

    const resumed = await ctx.agents.create({
      sessionId: SessionId('empty-assistant-insertion-target'),
      seed,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(resumed.agent, 'inspect the rebuilt empty-assistant insertion')
    await resumed.agent.whenIdle()
    const rebuilt = JSON.stringify(adapter.requests[2]?.messages)

    const projection = (text: string) => ({
      originalUser: text.includes(originalUser),
      replacementAssistant: text.includes(replacementAssistant),
    })
    const expected = { originalUser: true, replacementAssistant: true }
    expect({ live: projection(live), rebuilt: projection(rebuilt) })
      .toEqual({ live: expected, rebuilt: expected })
    await resumed.dispose()
    await ctx.fiber.dispose()
  })

  it('does not promote a stale assistant replacement over the latest assistant during replay', async () => {
    const originalUser = 'STALE ASSISTANT OWNER USER'
    const firstAssistant = 'STALE ASSISTANT ORIGINAL FIRST STEP'
    const latestAssistant = 'LATEST ASSISTANT ORIGINAL SECOND STEP MUST DISAPPEAR'
    const staleReplacement = 'STALE ASSISTANT REPLACEMENT MUST NOT OWN THE REPLY'
    const latestReplacement = 'LATEST ASSISTANT REPLACEMENT MUST OWN THE REPLY'
    const adapter = new MockAdapter([
      textResponse(firstAssistant),
      textResponse(latestAssistant),
      textResponse('live probe complete'),
      textResponse('resumed probe complete'),
    ])
    const ctx = await harness(adapter)
    const first = await ctx.agents.create({
      sessionId: SessionId('stale-assistant-owner-source'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    let steered = false
    first.agent.ctx.on('agent/turn-stopping', ({ agent }) => {
      if (steered) return
      steered = true
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: 'continue the same turn' }],
        source: { kind: 'plugin', plugin: 'driver-contract' },
      }))
    })
    send(first.agent, originalUser)
    await first.agent.whenIdle()

    const firstAssistantEvent = first.agent.session.events.find(event =>
      event.type === 'assistant/message' && event.data.turn === 1 && event.data.step === 1)
    const latestAssistantEvent = first.agent.session.events.find(event =>
      event.type === 'assistant/message' && event.data.turn === 1 && event.data.step === 2)
    if (firstAssistantEvent?.type !== 'assistant/message'
      || latestAssistantEvent?.type !== 'assistant/message') {
      throw new Error('missing stale-assistant ownership fixture events')
    }
    const stale = first.agent.session.append('assistant/message', {
      ...firstAssistantEvent.data,
      message: createAssistantMessage({
        content: [{ type: 'text', text: staleReplacement }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, {
      surfaceOp: {
        op: 'replace',
        start: firstAssistantEvent.seq,
        end: firstAssistantEvent.seq,
      },
      sourceEventSeqs: [firstAssistantEvent.seq],
    })
    first.agent.session.append('assistant/message', {
      ...latestAssistantEvent.data,
      message: createAssistantMessage({
        content: [{ type: 'text', text: latestReplacement }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, {
      surfaceOp: {
        op: 'replace',
        start: latestAssistantEvent.seq,
        end: latestAssistantEvent.seq,
      },
      sourceEventSeqs: [latestAssistantEvent.seq],
    })
    const canonicalSurface = JSON.stringify(first.agent.session.deriveMessages())
    expect(canonicalSurface).toContain(staleReplacement)
    expect(canonicalSurface).toContain(latestReplacement)
    expect(canonicalSurface).not.toContain(firstAssistant)
    expect(canonicalSurface).not.toContain(latestAssistant)
    expect(first.agent.session.surface.nodes).toContain(stale.seq)
    const seed = structuredClone(first.agent.session.events)

    send(first.agent, 'inspect the live latest-assistant owner')
    await first.agent.whenIdle()
    const live = JSON.stringify(adapter.requests[2]?.messages)
    await first.dispose()

    const resumed = await ctx.agents.create({
      sessionId: SessionId('stale-assistant-owner-target'),
      seed,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(resumed.agent, 'inspect the rebuilt latest-assistant owner')
    await resumed.agent.whenIdle()
    const rebuilt = JSON.stringify(adapter.requests[3]?.messages)

    const projection = (text: string) => ({
      latestReplacement: text.includes(latestReplacement),
      latestAssistant: text.includes(latestAssistant),
      staleReplacement: text.includes(staleReplacement),
    })
    const expected = {
      latestReplacement: true,
      latestAssistant: false,
      staleReplacement: false,
    }
    expect({ live: projection(live), rebuilt: projection(rebuilt) })
      .toEqual({ live: expected, rebuilt: expected })
    await resumed.dispose()
    await ctx.fiber.dispose()
  })

  it('recomputes a merged first-step ask when only one owned contribution is replaced', async () => {
    const firstContribution = 'MERGED FIRST-STEP ORIGINAL CONTRIBUTION MUST DISAPPEAR'
    const secondContribution = 'MERGED FIRST-STEP RETAINED CONTRIBUTION MUST REMAIN'
    const replacementContribution = 'MERGED FIRST-STEP REPLACEMENT CONTRIBUTION'
    const assistant = 'MERGED FIRST-STEP ASSISTANT MUST REMAIN'
    const adapter = new MockAdapter([
      textResponse(assistant),
      textResponse('live probe complete'),
      textResponse('resumed probe complete'),
    ])
    const ctx = await harness(adapter)
    const first = await ctx.agents.create({
      sessionId: SessionId('merged-first-step-source'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    first.agent.inject(createUserMessage({
      content: [{ type: 'text', text: firstContribution }],
      source: { kind: 'plugin', plugin: 'driver-contract' },
    }))
    send(first.agent, secondContribution)
    await first.agent.whenIdle()

    const firstContributionEvent = first.agent.session.events.find(event =>
      event.type === 'user/message'
      && JSON.stringify(event.data.content).includes(firstContribution))
    if (firstContributionEvent?.type !== 'user/message') {
      throw new Error('missing merged first-step fixture event')
    }
    first.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: replacementContribution }],
      source: { kind: 'plugin', plugin: 'driver-contract-compaction' },
    }), {
      surfaceOp: {
        op: 'replace',
        start: firstContributionEvent.seq,
        end: firstContributionEvent.seq,
      },
      sourceEventSeqs: [firstContributionEvent.seq],
    })
    const canonicalSurface = JSON.stringify(first.agent.session.deriveMessages())
    expect(canonicalSurface).toContain(replacementContribution)
    expect(canonicalSurface).toContain(secondContribution)
    expect(canonicalSurface).toContain(assistant)
    expect(canonicalSurface).not.toContain(firstContribution)
    const seed = structuredClone(first.agent.session.events)

    send(first.agent, 'inspect the live merged first-step replacement')
    await first.agent.whenIdle()
    const live = JSON.stringify(adapter.requests[1]?.messages)
    await first.dispose()

    const resumed = await ctx.agents.create({
      sessionId: SessionId('merged-first-step-target'),
      seed,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    send(resumed.agent, 'inspect the rebuilt merged first-step replacement')
    await resumed.agent.whenIdle()
    const rebuilt = JSON.stringify(adapter.requests[2]?.messages)

    const projection = (text: string) => ({
      replacementContribution: text.includes(replacementContribution),
      retainedContribution: text.includes(secondContribution),
      originalContribution: text.includes(firstContribution),
      assistant: text.includes(assistant),
    })
    const expected = {
      replacementContribution: true,
      retainedContribution: true,
      originalContribution: false,
      assistant: true,
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

  // 评审 C：DSH 0810 的 cancel 收敛期 latch。用户按 ESC 后立刻再问一句是最常见的
  // 交互序列；旧实现在 running 相位直接丢弃这次 wake，消息永久躺在 inbox 里，
  // agent 显示 idle 却对新 prompt 装死。
  it('replays a wake that arrived during cancel convergence', async () => {
    const adapter = new MockAdapter([textResponse('cancelled'), textResponse('answered')])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('cancel-convergence'),
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

    try {
      send(handle.agent, 'first')
      await entered.promise
      // 取消后（signal 已 abort）才到达——这正是 latch 要救的那条消息。
      handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
      send(handle.agent, 'arrived during convergence')
      release.resolve(undefined)
      await handle.agent.whenIdle()

      // 收敛后必须自己跑起来：消息被消费、模型真的被调用。
      expect(handle.agent.inbox.nextTurn).toHaveLength(0)
      expect(adapter.requests).toHaveLength(1)
      expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('arrived during convergence')
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('does not replay a cancel-convergence latch whose message was withdrawn', async () => {
    const adapter = new MockAdapter([textResponse('cancelled')])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('cancel-convergence-withdrawn'),
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

    try {
      send(handle.agent, 'first')
      await entered.promise
      handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
      send(handle.agent, 'withdrawn')
      handle.agent.inbox.clear()
      release.resolve(undefined)
      await handle.agent.whenIdle()

      // latch 已武装但队列被撤空：绝不能凭空开一个空的 durable turn。
      const turnStarts = handle.agent.session.events.filter(e => e.type === 'turn/start')
      expect(turnStarts).toHaveLength(1)
      expect(adapter.requests).toHaveLength(0)
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  // 评审 E：capacityChars 从不传入 assembleSlice 时，ElasticityController 恒取
  // Fidelity.FULL——locator 降级、ContextUnfitError、nextTighterCapacity 全是死
  // 代码，超窗只能靠 provider 报错兜底。这条门钉住"窗口小 ⇒ 切片更小"。
  it('never kills a turn because the slice does not fit the window', async () => {
    // mandatory 区块（task_objective / CURRENT REQUEST）无法降级，装不下是常态。
    // 那时必须退回无约束投影继续跑，绝不能把会话打成 error——"静默超窗由
    // provider 报错"仍然远好于"中途硬崩"。
    const adapter = new MockAdapter(
      Array.from({ length: 4 }, (_unused, index) => textResponse(`reply-${index}`)),
      500,
    )
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('capacity-unfit'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    try {
      for (let index = 0; index < 4; index += 1) {
        send(handle.agent, `${'X'.repeat(3000)}-${index}`)
        await handle.agent.whenIdle()
      }
      expect(adapter.requests).toHaveLength(4)
      expect(handle.agent.session.events
        .filter(event => event.type === 'turn/end')
        .map(event => event.data.reason.kind))
        .toEqual(['completed', 'completed', 'completed', 'completed'])
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
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




  // ── 0811 会话事件词汇表 ─────────────────────────────────────────────────
  // 20260811 关闭了事件词汇:持久化读路径拒绝解释含未知类型的日志(写路径故意
  // 不拦,所以毒发在【下一次 resume】)。已在真实 PersistenceCoordinator + jsonl
  // 后端上端到端复现:不注册 → SessionFormatUnsupportedError。本插件在装载时把
  // 自己的三个 slice/* 类型注册进 KNOWN_SESSION_EVENT_TYPES(词汇文件自己说
  // "registration surface 推迟到有消费者为止" —— 我们就是那个消费者),卸载时
  // 只删自己加的。这条门锁的是注册接线;冻结集合的未来版本会让插件在装载时
  // 响亮失败,而不是在 resume 时拿一条中毒日志。
  it('registers its slice/* event types into the known vocabulary, and reverts on unload', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    const during = ['slice/file-anchor', 'slice/request-slice', 'slice/step-budget']
      .map(type => KNOWN_SESSION_EVENT_TYPES.has(type))
    await ctx.fiber.dispose()
    const after = ['slice/file-anchor', 'slice/request-slice', 'slice/step-budget']
      .map(type => KNOWN_SESSION_EVENT_TYPES.has(type))
    expect({ during, after }).toEqual({ during: [true, true, true], after: [false, false, false] })
  })

  // ── complete 提示节(0811 新增)─────────────────────────────────────────
  // 宿主声明 complete: true 的 section 时,assemble 把它恢复为【唯一】提示节。
  // kernel 走注册表(slice:kernel, order -1000)而不是 driver 手工前置,正是为了
  // 让这个宿主保证真的成立 —— 手工前置会静默作废它。
  it('honors a host complete section as the sole system prompt', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    ctx.systemPrompt.section({ name: 'host:sole', order: 0, text: 'COMPLETE-ONLY-PROMPT', complete: true })
    const handle = await ctx.agents.create({
      sessionId: SessionId('complete-prompt'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    try {
      send(handle.agent, 'hello')
      await handle.agent.whenIdle()
      const system = String(adapter.requests[0]?.system ?? '')
      expect({
        sole: system.includes('COMPLETE-ONLY-PROMPT'),
        kernelSuppressed: !system.includes('You are sliceagent'),
      }).toEqual({ sole: true, kernelSuppressed: true })
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('renders the sliceagent kernel first in the ordinary prompt', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('kernel-first'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    try {
      send(handle.agent, 'hello')
      await handle.agent.whenIdle()
      const system = String(adapter.requests[0]?.system ?? '')
      expect(system.startsWith('You are sliceagent')).toBe(true)
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })



  // ── 合成 kernel(默认)────────────────────────────────────────────────────
  // CB50 A/B 的直接产物:默认 kernel 只保留 slice 结构必需(tape 语义 / hash
  // 信任规则 / 截断与 recall / 缺席≠不存在),行为束身衣全部不进面 —— 那三句
  // 节俭纪律实测砍掉 0.13 配对 spanR。'ported' 配置臂保留逐字移植版做 A/B。
  it('ships the synthesized kernel by default, without the frugality corset', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('kernel-synth'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    try {
      send(handle.agent, 'hi'); await handle.agent.whenIdle()
      const system = String(adapter.requests[0]?.system ?? '')
      expect({
        opensAsSliceagent: system.startsWith('You are sliceagent'),
        sliceSection: system.includes('<slice>'),
        tapeRule: system.includes('composition IS the current file'),
        recallTaught: system.includes('recall_turn({"turn": "slice-turn-N"}')
          && system.includes('recall_search'),
        absenceRule: system.includes('never false'),
        // 束身衣三句必须缺席 —— 它们是 CB50 探索塌缩的文本源头。
        corsetGone: !system.includes('stop exploring once the decision is grounded')
          && !system.includes('make no further tool call')
          && !system.includes('Do not accumulate transcript'),
        // 未挂载的 Python 机器不再被教。
        deadMachineryGone: !system.includes('ACTIVE WORK') && !system.includes('WorkDelta'),
        noUnresolvedSlots: !system.includes('{{'),
      }).toEqual({
        opensAsSliceagent: true, sliceSection: true, tapeRule: true, recallTaught: true,
        absenceRule: true, corsetGone: true, deadMachineryGone: true, noUnresolvedSlots: true,
      })
    } finally {
      await handle.dispose(); await ctx.fiber.dispose()
    }
  })

  it("kernel: 'ported' restores the verbatim Python prompt as the A/B arm", async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter, { kernel: 'ported' })
    const handle = await ctx.agents.create({
      sessionId: SessionId('kernel-ported'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    try {
      send(handle.agent, 'hi'); await handle.agent.whenIdle()
      const system = String(adapter.requests[0]?.system ?? '')
      expect({
        corset: system.includes('stop exploring once the decision is grounded'),
        contract: system.includes('# BRAIN AND SOURCE-LINKED ACTIVE WORK CONTRACT'),
      }).toEqual({ corset: true, contract: true })
    } finally {
      await handle.dispose(); await ctx.fiber.dispose()
    }
  })

  // ── 两级取回:recall_search → recall_turn ────────────────────────────────
  it('recall_search finds a fact by content and hands back a recall_turn locator', async () => {
    const FACT = 'the rollout gate threshold is ZX-4471'
    const adapter = new MockAdapter([
      textResponse(`noted: ${FACT}, plus ${'pad '.repeat(400)}`),   // turn 1:事实 + 超长(必截)
      textResponse('second turn'),                                   // turn 2:封存 turn 1
      toolCallResponse('rs1', 'recall_search', { query: 'rollout gate threshold' }), // turn 3 step 1
      toolCallResponse('rt1', 'recall_turn', { turn: 'slice-turn-1' }),              // turn 3 step 2
      textResponse('found it'),
    ])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('recall-two-tier'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    try {
      send(handle.agent, 'state the fact at length'); await handle.agent.whenIdle()
      send(handle.agent, 'ok'); await handle.agent.whenIdle()
      send(handle.agent, 'what was that threshold again?'); await handle.agent.whenIdle()

      const results = handle.agent.session.events
        .filter(e => e.type === 'tool/result').map(e => JSON.stringify(e.data))
      expect({
        searchNamedTheTurn: results.some(r => r.includes('slice-turn-1') && r.includes('recall_search')),
        // 逐字页必须同时带完整回应节 + sealed 页自己的认知诚实头(搜索页的
        // 同名短语不算数 —— 变异验证曾因此漏网)。
        verbatimCameBack: results.some(r => r.includes('ZX-4471')
          && r.includes('## Assistant response (verbatim)')
          && r.includes('[sealed turn slice-turn-1')
          && r.includes('historical record')),
      }).toEqual({ searchNamedTheTurn: true, verbatimCameBack: true })
    } finally {
      await handle.dispose(); await ctx.fiber.dispose()
    }
  })

  // ── #5 前缀跨轮字节不变门(缓存命中的结构性前提)─────────────────────────
  // system + tools 目录是 provider 前缀缓存的公共前缀。任何一轮悄悄变一个字节,
  // 整个会话的缓存前缀作废。这条门断言:同一会话第 N 轮与第 N+1 轮的 system
  // 逐字节相等、工具 schema JSON 逐字节相等。
  it('keeps the system prefix and tool catalog byte-stable across turns', async () => {
    const adapter = new MockAdapter([
      textResponse('one'), textResponse('two'), textResponse('three'),
    ])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('prefix-stability'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    try {
      send(handle.agent, 'a'); await handle.agent.whenIdle()
      send(handle.agent, 'b'); await handle.agent.whenIdle()
      send(handle.agent, 'c'); await handle.agent.whenIdle()
      const systems = adapter.requests.map(r => String(r.system ?? ''))
      const tools = adapter.requests.map(r => JSON.stringify(r.tools ?? []))
      expect({
        turns: adapter.requests.length,
        systemStable: systems.every(x => x === systems[0]),
        toolsStable: tools.every(x => x === tools[0]),
        systemNonEmpty: systems[0].length > 1000,
      }).toEqual({ turns: 3, systemStable: true, toolsStable: true, systemNonEmpty: true })
    } finally {
      await handle.dispose(); await ctx.fiber.dispose()
    }
  })

  // ── memory recall(src/recall.ts)────────────────────────────────────────
  // tape 在 1,200 码点截断封存回复;recall_turn 是回去的路。它从持久会话日志
  // 服务逐字文本——重建 agent 用的同一来源,所以按构造就是重建安全的。
  // 这三条门锁的分别是:全文回得来、模型真的看得见、以及不截断就不广告。

  it('recall_turn serves the verbatim full text of a truncated sealed turn', async () => {
    const LONG = `HEAD-${'x'.repeat(1400)}-TAIL-MARKER-9137`
    const adapter = new MockAdapter([
      textResponse(LONG),                                          // turn 1:超长回复,tape 必截
      toolCallResponse('r1', 'recall_turn', { turn: 'slice-turn-1' }), // turn 2 step 1
      textResponse('recalled'),                                    // turn 2 step 2
    ])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('recall-verbatim'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    try {
      send(handle.agent, 'produce the long answer')
      await handle.agent.whenIdle()
      send(handle.agent, 'now recall turn 1 in full')
      await handle.agent.whenIdle()

      // turn 2 的种子:tape 里截断标记 + 只在截断时渲染的 recall 行,指向真工具。
      const seed = JSON.stringify(adapter.requests[1]?.messages)
      // turn 2 step 2 的轨迹:工具结果必须把被截掉的尾部带回模型面。
      const trajectory = JSON.stringify(adapter.requests[2]?.messages)
      const result = handle.agent.session.events.find(
        event => event.type === 'tool/result'
          && !JSON.stringify(event.data).includes('"isError":true'),
      )
      const resultText = JSON.stringify(result?.data ?? {})

      expect({
        tapeMarksCut: seed.includes('chars in sealed turn]'),
        tapeAdvertises: seed.includes('recall: recall_turn({\\"turn\\": \\"slice-turn-1\\"})'),
        seedWithheldTail: !seed.includes('TAIL-MARKER-9137'),
        resultVerbatim: resultText.includes('TAIL-MARKER-9137'),
        modelSawIt: trajectory.includes('TAIL-MARKER-9137'),
      }).toEqual({
        tapeMarksCut: true,
        tapeAdvertises: true,
        seedWithheldTail: true,
        resultVerbatim: true,
        modelSawIt: true,
      })
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('renders no recall line when nothing was cut', async () => {
    const adapter = new MockAdapter([
      textResponse('short reply, well under every cap'),
      textResponse('second turn'),
    ])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('recall-quiet'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    try {
      send(handle.agent, 'short')
      await handle.agent.whenIdle()
      send(handle.agent, 'again')
      await handle.agent.whenIdle()
      const seed = JSON.stringify(adapter.requests[1]?.messages)
      expect({
        sealed: seed.includes('[turn slice-turn-1'),
        advertised: seed.includes('recall:'),
      }).toEqual({ sealed: true, advertised: false })
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('recall_turn explains itself on an unknown turn instead of failing opaquely', async () => {
    const adapter = new MockAdapter([
      textResponse('first'),
      toolCallResponse('r1', 'recall_turn', { turn: 'slice-turn-99' }),
      textResponse('handled the miss'),
    ])
    const ctx = await harness(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('recall-miss'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    try {
      send(handle.agent, 'one')
      await handle.agent.whenIdle()
      send(handle.agent, 'recall something absent')
      await handle.agent.whenIdle()
      // isError 位于 tool-result 内容块上,不在 message 顶层。
      const errorResult = handle.agent.session.events.find(
        event => event.type === 'tool/result'
          && JSON.stringify(event.data).includes('"isError":true'),
      )
      const text = JSON.stringify(errorResult?.data ?? {})
      expect({
        errored: errorResult !== undefined,
        namesTurn: text.includes('no recorded turn 99'),
        listsSealed: text.includes('sealed turns: 1'),
      }).toEqual({ errored: true, namesTurn: true, listsSealed: true })
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  // 轨迹界：单轮 step 硬顶。刻意不做「停滞检测」——把那个提案的判据
  //（continuation + 无可见文本 + 无新锚点，warn=4/terminate=8）在真实 19 轮会话上
  // 重放，会砍掉 143 步里的 45 步，其中 24 步来自一个做了 74 次不同工具调用的
  // 高产轮，而且在普通 5 步轮上就发警告。对推理模型「无可见文本 + 工具调用」是
  // 常态而非病态。所以只留界，不留诊断。
  it('ends the turn at the step ceiling instead of continuing forever', async () => {
    // 灌远多于预算的工具响应：模型永远不收敛，只有界能停下它。
    const adapter = new MockAdapter(
      Array.from({ length: 20 }, (_, i) => toolCallResponse(`call-${i}`, 'noop', {})),
    )
    const ctx = await harness(adapter, { maxStepsPerTurn: 3 })
    ctx.tools.register(defineContentToolFixture({
      name: 'noop',
      description: 'does nothing',
      parameters: {},
      execute: async () => [{ type: 'text', text: 'ok' }],
    }))
    const handle = await ctx.agents.create({
      sessionId: SessionId('slice-step-budget'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    try {
      send(handle.agent, 'never converge')
      await handle.agent.whenIdle()

      const budgets = handle.agent.session.events
        .filter(event => event.type === 'slice/step-budget')
        .map(event => ({ step: event.data.step, budget: event.data.budget }))
      const ends = handle.agent.session.events
        .filter(event => event.type === 'turn/end')
        .map(event => event.data.reason.kind)

      expect({ budgets, ends, requests: adapter.requests.length }).toEqual({
        budgets: [{ step: 3, budget: 3 }],
        ends: ['step-budget'],
        requests: 3,
      })
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('does not spend the step budget on a turn that converges on its own', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'noop', {}),
      textResponse('converged'),
    ])
    const ctx = await harness(adapter, { maxStepsPerTurn: 3 })
    ctx.tools.register(defineContentToolFixture({
      name: 'noop',
      description: 'does nothing',
      parameters: {},
      execute: async () => [{ type: 'text', text: 'ok' }],
    }))
    const handle = await ctx.agents.create({
      sessionId: SessionId('slice-step-budget-clean'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    try {
      send(handle.agent, 'converge normally')
      await handle.agent.whenIdle()

      expect({
        budgets: handle.agent.session.events.filter(e => e.type === 'slice/step-budget').length,
        ends: handle.agent.session.events
          .filter(e => e.type === 'turn/end')
          .map(e => e.data.reason.kind),
      }).toEqual({ budgets: 0, ends: ['completed'] })
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('rejects a non-positive maxStepsPerTurn at construction', async () => {
    const adapter = new MockAdapter([])
    await expect(harness(adapter, { maxStepsPerTurn: 0 })).rejects.toThrow(
      'maxStepsPerTurn must be a positive integer',
    )
  })

  // 接线门 2：模型可见面里出现的每一个「工具调用形状」，其名字必须是宿主真实
  // 注册过的工具。
  //
  // 这条门是为一个已经发生过的 bug 类而加的，不是假想：移植时把渲染器搬了过来、
  // 把解析器留在了原地，于是切片每轮都在教模型调 `read_file(...)`——DSH 注册的
  // 是 `read`，而且参数是 {file_path} 不是位置字符串。模型一次都没试过
  //（实测 104 轮 / 135 次调用 / 0 次），所以没有任何门红过；直到某一轮它真的
  // 照着找，花了 20 步 35 次搜索去找一个不存在的文件。
  //
  // 「没人用」不能证明「能用」。这条门检查的是能用。
  it('never renders a tool-call shape whose name the host does not register', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slice-loop-callname-'))
    const path = join(root, 'anchored.txt')
    const adapter = new MockAdapter([
      toolCallResponse('write-1', 'write_file', { path, content: 'BODY' }),
      textResponse('written'),
      textResponse('second turn seals the first'),
      textResponse('third turn renders the tape plus the open-files index'),
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
      sessionId: SessionId('slice-call-names'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    try {
      send(handle.agent, 'write the file')
      await handle.agent.whenIdle()
      send(handle.agent, 'seal that turn')
      await handle.agent.whenIdle()
      send(handle.agent, 'now render the tape and the open files index')
      await handle.agent.whenIdle()

      // 最后一次请求：tape 有两条封存轮、OPEN FILES 有一个锚定文件——两个热点
      // 站点都渲染了。
      const surface = JSON.parse(JSON.stringify(adapter.requests.at(-1)?.messages ?? []))
      const text = JSON.stringify(surface)
      expect(text).toContain('anchored.txt')

      const registered = new Set(ctx.tools.schemas().map((schema) => schema.name))
      // `name("…")` — a snake_case identifier applied to a quoted string is a
      // call shape the model can copy verbatim. Prose verbs ("re-read the
      // file") do not match it, so this only fires on text that genuinely
      // teaches a call.
      //
      // No suffix allowlist. An earlier version only checked names ending in
      // `_file`/`_history` plus `read`, which would have waved through a
      // future `fetch("…")` or `search("…")` — the same bug wearing a
      // different name is exactly what this gate exists to stop.
      const offenders = [...new Set(
        [...text.matchAll(/\b([a-z][a-z0-9_]{2,})\(\\?["']/g)].map((m) => m[1]),
      )].filter((name) => !registered.has(name))

      expect(offenders).toEqual([])
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  // 接线门（评审 A）：锚定必须挂在宿主真实注册的工具名上，而不是 fixture 名。
  // DSH 0810 的 tool-fs 注册 `write`/`edit`（参数键 file_path），
  // tool-str-replace-editor 注册 `str_replace_editor`（参数键 path + command）。
  // 之前的集合一个都不匹配，真实部署下 tape 恒空而测试全绿——测了两端没测接线。
  async function expectRealDshToolAnchors(
    tool: string,
    pathKey: 'file_path' | 'path',
    contentKey: 'content' | 'file_text',
    extraArgs: Record<string, string>,
  ): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'slice-loop-dsh-tool-'))
    const path = join(root, 'edited.txt')
    const marker = `DSH TOOL ${tool.toUpperCase()} ANCHOR MARKER`
    const adapter = new MockAdapter([
      toolCallResponse('edit-1', tool, { ...extraArgs, [pathKey]: path, [contentKey]: marker }),
      textResponse('edit complete'),
      textResponse('recalled'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: tool,
      description: `${tool} (real DSH tool name)`,
      parameters: {
        [pathKey]: { type: 'string', required: true },
        [contentKey]: { type: 'string', required: true },
        ...Object.fromEntries(Object.keys(extraArgs).map(k => [k, { type: 'string', required: true } as const])),
      },
      execute: async (raw) => {
        const args = raw as Record<string, string>
        await writeFile(args[pathKey]!, args[contentKey]!, 'utf8')
        return [{ type: 'text', text: 'written' }]
      },
    }))
    const handle = await ctx.agents.create({
      sessionId: SessionId(`dsh-tool-${tool}`),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    try {
      send(handle.agent, 'edit the file')
      await handle.agent.whenIdle()
      // 锚点必须落成 durable 事件（重建的唯一依据），且内容进入下一轮切片。
      expect(handle.agent.session.events.filter(e => e.type === 'slice/file-anchor')).toHaveLength(1)
      send(handle.agent, 'recall the edited file')
      await handle.agent.whenIdle()
      expect(JSON.stringify(adapter.requests[2]?.messages)).toContain(marker)
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }

  it('anchors edits made by the real DSH tool write into the next bounded slice', async () => {
    await expectRealDshToolAnchors('write', 'file_path', 'content', {})
  })

  it('anchors edits made by the real DSH tool edit into the next bounded slice', async () => {
    await expectRealDshToolAnchors('edit', 'file_path', 'content', {})
  })

  it('anchors edits made by the real DSH tool str_replace_editor into the next bounded slice', async () => {
    await expectRealDshToolAnchors('str_replace_editor', 'path', 'file_text', { command: 'create' })
  })

  // 评审 B：轮内到达的输入曾会重建种子并整条丢弃 turnTrajectory，模型因此看不到
  // 自己刚发起的 tool-call 与工具结果。轮界重建、轮内累积是本 loop 的不变式。
  it('keeps the in-turn trajectory visible when steering arrives mid-turn', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('probe-1', 'probe', { text: 'probe-value' }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    let steered = false
    let steerNow: (() => void) | undefined
    ctx.tools.register(defineContentToolFixture({
      name: 'probe',
      description: 'probe',
      parameters: { text: { type: 'string', required: true } },
      // 工具体内 steer：真实路径（工具/宿主在轮内插话），且不在 session/event
      // 监听器里——那里调 append 会撞 DSH 的重入保护。
      execute: async ({ text }) => {
        steerNow?.()
        return [{ type: 'text', text: `TOOL-RESULT-${text}` }]
      },
    }))
    const handle = await ctx.agents.create({
      sessionId: SessionId('mid-turn-steer'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    steerNow = () => {
      steered = true
      handle.agent.steer(createUserMessage({
        content: [{ type: 'text', text: 'MID-TURN-STEER' }],
        source: { kind: 'user' },
      }))
    }

    try {
      send(handle.agent, 'use probe')
      await handle.agent.whenIdle()

      expect(steered).toBe(true)
      const second = JSON.stringify(adapter.requests[1]?.messages)
      // 模型必须仍看到自己发起的调用、它的结果，以及新到的 steering。
      expect(second).toContain('probe-1')
      expect(second).toContain('TOOL-RESULT-probe-value')
      expect(second).toContain('MID-TURN-STEER')
      // 种子（含 CURRENT REQUEST 槽）不被篡夺。
      expect(second).toContain('use probe')
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('never anchors a read-only str_replace_editor view command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slice-loop-view-'))
    const path = join(root, 'viewed.txt')
    await writeFile(path, 'PRE-EXISTING CONTENT', 'utf8')
    const adapter = new MockAdapter([
      toolCallResponse('view-1', 'str_replace_editor', { command: 'view', path }),
      textResponse('viewed'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'str_replace_editor',
      description: 'str_replace_editor',
      parameters: {
        command: { type: 'string', required: true },
        path: { type: 'string', required: true },
      },
      execute: async () => [{ type: 'text', text: 'viewed' }],
    }))
    const handle = await ctx.agents.create({
      sessionId: SessionId('view-no-anchor'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    try {
      send(handle.agent, 'view the file')
      await handle.agent.whenIdle()
      // view 是只读：绝不进 tape（否则只读文件也会被当成本轮编辑锚定）。
      expect(handle.agent.session.events.filter(e => e.type === 'slice/file-anchor')).toHaveLength(0)
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
        indexed: text.includes(`${path} — 1 lines · sha256:`),
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
        indexed: text.includes(`${path} — 1 lines · sha256:`),
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
      // recall_turn is plugin-owned and rides every catalog (src/recall.ts).
      requestSystem: true,
      requestTools: ['audit_echo', 'recall_search', 'recall_turn'],
      headerSystem: true,
      headerTools: ['audit_echo', 'recall_search', 'recall_turn'],
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
    // 拼接契约属于移植 kernel(A/B 臂);默认合成 kernel 没有这段。
    const ctx = await harness(adapter, { kernel: 'ported' })
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

  // 评审 G：上面那条用「2 个调用 + 上限 2」，调用数等于上限时断言只能证明
  // "发生了重叠"，证不了"上限起作用"——把上限改成 1024 或 1 它都察觉不到。
  // 这两条用 6 个调用把 cap 和实际峰值分开。
  async function measureOverlap(cap: number, calls: number): Promise<{ maxActive: number; results: number }> {
    const adapter = new MockAdapter([
      multiToolCallResponse(Array.from({ length: calls }, (_unused, index) => ({
        id: `parallel-${index}`, name: 'parallel_audit', args: { id: `call-${index}` },
      }))),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, { maxParallelToolCalls: cap })
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
      sessionId: SessionId(`cap-${cap}-of-${calls}`),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    try {
      send(handle.agent, 'run every call')
      await handle.agent.whenIdle()
      return {
        maxActive,
        results: handle.agent.session.events.filter(event => event.type === 'tool/result').length,
      }
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  }

  it('never exceeds maxParallelToolCalls when more calls are ready than the cap', async () => {
    const { maxActive, results } = await measureOverlap(2, 6)
    expect(maxActive).toBe(2)   // 上限生效：不是 6
    expect(results).toBe(6)     // 但每个调用都跑完了
  })

  it('serializes tool bodies at maxParallelToolCalls = 1', async () => {
    const { maxActive, results } = await measureOverlap(1, 6)
    expect(maxActive).toBe(1)
    expect(results).toBe(6)
  })

  // 评审 G：取消发生在多个工具调用中间时，未派发的调用必须补一条配对的
  // tool/result——否则日志里出现无结果的 tool/call，重建出的消息序列对真实
  // provider 是非法的（tool_call 没有配对 tool_result 会 400）。这条保证之前
  // 只存在于注释里：在 appendSkippedToolCall 里塞无条件 throw，全套依然全绿。
  it('pairs every tool call with a result when cancelled mid-flight', async () => {
    const adapter = new MockAdapter([
      multiToolCallResponse([
        { id: 'cancel-1', name: 'slow_tool', args: { id: 'one' } },
        { id: 'cancel-2', name: 'slow_tool', args: { id: 'two' } },
        { id: 'cancel-3', name: 'slow_tool', args: { id: 'three' } },
      ]),
      textResponse('never reached'),
    ])
    // 上限 1：第一个工具体在跑时，后两个还没派发。
    const ctx = await harness(adapter, { maxParallelToolCalls: 1 })
    const entered = deferred<void>()
    let started = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'slow_tool',
      description: 'blocks until cancelled',
      parameters: { id: { type: 'string', required: true } },
      isConcurrencySafe: () => true,
      execute: async ({ id }, exec) => {
        started += 1
        if (started === 1) entered.resolve(undefined)
        await new Promise<void>((resolve) => {
          if (exec.signal?.aborted) { resolve(); return }
          exec.signal?.addEventListener('abort', () => { resolve() }, { once: true })
        })
        return [{ type: 'text', text: id }]
      },
    }))
    const handle = await ctx.agents.create({
      sessionId: SessionId('cancel-mid-tools'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    try {
      send(handle.agent, 'run three tools')
      await entered.promise
      handle.agent.cancel({ kind: 'user' })
      await handle.agent.whenIdle()

      const calls = handle.agent.session.events.filter(event => event.type === 'tool/call')
      const results = handle.agent.session.events.filter(event => event.type === 'tool/result')
      // 模型发起了 3 个调用 ⇒ 日志里必须有 3 个调用和 3 个配对结果。
      expect(calls).toHaveLength(3)
      expect(results).toHaveLength(3)
      // 每个结果都指向它自己的调用（provenance 不断链）。
      expect(results.map(event => event.sourceEventSeqs)).toEqual(calls.map(event => [event.seq]))
      // 未派发的那些带明确的 aborted-before-dispatch 归因。
      expect(results.filter(event => event.data.error?.code === TOOL_ABORTED_BEFORE_DISPATCH).length)
        .toBeGreaterThan(0)
      // deriveMessages 里每个 tool-call 都有配对 result——重放对真实 provider 合法。
      // 工具结果是带 tool-result 块的 user 消息（DSH 没有 tool 角色）。
      const derived = handle.agent.session.deriveMessages()
      const blocks = derived.flatMap(message => message.content as Array<{ type: string; id?: string; toolCallId?: string }>)
      const callIds = blocks.filter(block => block.type === 'tool-call').map(block => block.id!)
      const resultIds = blocks.filter(block => block.type === 'tool-result').map(block => block.toolCallId!)
      expect(callIds).toHaveLength(3)
      expect(new Set(resultIds)).toEqual(new Set(callIds))
      expect([...handle.agent.session.events].reverse()
        .find(event => event.type === 'turn/end')?.data.reason.kind).toBe('aborted')
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('stock-loop invariant incompatibility (评审 D)', () => {
  it('refuses to load beside @deepseek-ai/dsh-agent-loop/invariant', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(InvariantService)
    // 宿主先装了 stock 的伴生 invariant（scaffold 默认就是这样）。
    await ctx.plugin(agentLoopInvariant)

    await expect(ctx.plugin(apply, {})).rejects.toThrow(/incompatible with the @deepseek-ai\/dsh-agent-loop\/invariant/)
    await ctx.fiber.dispose()
  })

  it('loads cleanly when the companion is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(InvariantService)
    await ctx.plugin(apply, {})
    expect(ctx.get('sliceAgentLoop')).toBeDefined()
    await ctx.fiber.dispose()
  })
})

describe('slice-loop own invariant (评审 D · C)', () => {
  async function harnessWithInvariants(adapter: MockAdapter): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(InvariantService)
    await ctx.plugin(apply, {})
    await ctx.plugin(sliceInvariant)
    ctx.llm.registerAdapter(['mock'], adapter)
    return ctx
  }

  it('passes on real turns — the asserted property is actually true', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harnessWithInvariants(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('own-invariant-ok'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    try {
      send(handle.agent, 'first')
      await handle.agent.whenIdle()
      send(handle.agent, 'second')
      await handle.agent.whenIdle()

      expect(adapter.requests).toHaveLength(2)
      expect(handle.agent.session.events
        .filter(event => event.type === 'turn/end')
        .map(event => event.data.reason.kind)).toEqual(['completed', 'completed'])
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('records one audit digest per dispatched request', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await harnessWithInvariants(adapter)
    const handle = await ctx.agents.create({
      sessionId: SessionId('own-invariant-audit'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    try {
      send(handle.agent, 'audit me')
      await handle.agent.whenIdle()

      const audits = handle.agent.session.events.filter(event => event.type === 'slice/request-slice')
      expect(audits).toHaveLength(1)
      // 摘要必须真的对应发出去的种子——这条链断了审计就是空的。
      const dispatched = sliceDigest(seedTextOf(adapter.requests[0]!.messages))
      expect(audits[0]!.data.seedDigest).toBe(dispatched)
      expect(audits[0]!.data.messageCount).toBe(adapter.requests[0]!.messages.length)
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('Code Mode file anchoring (评审 · 执行平面)', () => {
  /** A scriptable CodeRuntime: `behavior` drives the sub-calls a run_code program makes. */
  class FakeRuntime extends CodeRuntime {
    readonly language = 'typescript'
    readonly isolation = 'fake'
    behavior: (request: CodeRunRequest) => Promise<CodeRunResult> = () => Promise.resolve({ logs: [] })
    run(request: CodeRunRequest): Promise<CodeRunResult> {
      return this.behavior(request)
    }
  }

  it('anchors a file written by a run_code SUB-CALL, not just a top-level tool call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slice-loop-codemode-'))
    const path = join(root, 'written-by-code.txt')
    const marker = 'CODE MODE SUB-CALL ANCHOR MARKER'
    const adapter = new MockAdapter([
      toolCallResponse('code-1', 'run_code', { code: 'await tools.write(...)', description: 'write the file' }),
      textResponse('code complete'),
      textResponse('recalled'),
    ])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(FakeRuntime)
    await ctx.plugin(apply, {})
    ctx.llm.registerAdapter(['mock'], adapter)
    // 真实的 write 工具（DSH tool-fs 的名字与参数键）。
    ctx.tools.register(defineContentToolFixture({
      name: 'write',
      description: 'write a UTF-8 file',
      parameters: {
        file_path: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      execute: async ({ file_path, content }) => {
        await writeFile(file_path as string, content as string, 'utf8')
        return [{ type: 'text', text: 'written' }]
      },
    }))

    const handle = await ctx.agents.create({
      sessionId: SessionId('code-mode-anchor'),
      agentOptions: { provider: 'mock', model: 'mock' },
      // preset 平面声明 code 模式：模型只看得到 run_code。
      setup: (agentCtx: Context) => { agentCtx.tools.presentAs('code') },
    })
    // run_code 程序体：调一次真实的 write 子工具。
    ;(ctx.codeRuntime as FakeRuntime).behavior = async (request: CodeRunRequest) => {
      // bindings 是 { global, functions: Record<name, fn> } 的列表。
      const write = request.bindings
        .map(namespace => namespace.functions.write)
        .find(fn => fn !== undefined)
      expect(write).toBeDefined()
      await write!({ file_path: path, content: marker })
      return { logs: [] }
    }

    try {
      send(handle.agent, 'write the file through code mode')
      await handle.agent.whenIdle()

      // 模型只发了一个 run_code —— 顶层看不到 write。
      const calls = handle.agent.session.events.filter(event => event.type === 'tool/call')
      expect(calls.map(event => event.data.name)).toEqual(['run_code'])
      // 但锚定挂在执行平面，所以子调用写的文件仍然进 tape。
      expect(handle.agent.session.events.filter(event => event.type === 'slice/file-anchor'))
        .toHaveLength(1)

      send(handle.agent, 'recall the edited file')
      await handle.agent.whenIdle()
      expect(JSON.stringify(adapter.requests[2]?.messages)).toContain(marker)
    } finally {
      await handle.dispose()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
