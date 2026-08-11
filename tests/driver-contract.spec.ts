import { Context } from 'cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import LlmService, { createUserMessage } from '@deepseek-ai/dsh-llm'
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
