import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import LlmService, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import apply from '../src/index.js'
import { errorResponse, MockAdapter, textResponse, toolCallResponse } from './mock-adapter.js'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(apply)
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
})
