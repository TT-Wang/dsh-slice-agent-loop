import { Context, type Fiber } from 'cordis'
import { describe, expect, it } from 'vitest'
import AgentRegistry, {
  Inbox,
  type AgentCancelCause,
  type AgentOptions,
  type AgentStatus,
  type CancelOptions,
  type InboxTarget,
} from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import SessionStore, {
  SessionId,
  SessionPreparation,
  type Session,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SessionPersistence, {
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import { SliceAgentLifecycle, type LifecycleAgent } from '../src/lifecycle.ts'

function deferred<T>(): {
  readonly promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

class TestAgent implements LifecycleAgent {
  readonly scope: Scope
  readonly ctx: Context
  readonly inbox: Inbox
  readonly status: AgentStatus = 'idle'

  constructor(
    loopCtx: Context,
    readonly id: SessionId,
    readonly options: AgentOptions,
    readonly session: Session,
    private readonly order: string[],
    private readonly idleGate?: Promise<void>,
  ) {
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.ctx.effect(() => () => { this.order.push('scope-disposed') })
    const ignore = (): void => undefined
    this.inbox = new Inbox(session, { inserted: ignore, discarded: ignore, claimed: ignore })
  }

  cancel(_cause: AgentCancelCause, _options?: CancelOptions): void {
    this.order.push('cancel')
  }

  async whenIdle(): Promise<void> {
    this.order.push('when-idle')
    await this.idleGate
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return task(new AbortController().signal)
  }

  send(message: UserMessage, target: InboxTarget, _wakeup: boolean): void {
    this.inbox.append(target, message)
  }

  followup(message: UserMessage): void {
    this.send(message, 'next-turn', true)
  }

  steer(message: UserMessage): void {
    this.send(message, 'next-step', true)
  }

  inject(message: UserMessage): void {
    this.send(message, 'next-step', false)
  }
}

interface Harness {
  readonly ctx: Context
  readonly loopFiber: Fiber
  readonly order: string[]
}

async function harness(idleGate?: Promise<void>): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const order: string[] = []
  const loopFiber = await ctx.plugin(Object.assign((loopCtx: Context) => {
    const lifecycle = new SliceAgentLifecycle(
      loopCtx,
      (runtime, id, options, session) => new TestAgent(runtime, id, options, session, order, idleGate),
    )
    loopCtx.effect(() => loopCtx.agents.setFactory(lifecycle), 'sliceLoop.setFactory()')
  }, { inject: ['agents', 'sessions'] }))
  return { ctx, loopFiber, order }
}

class PreparedPersistence extends SessionPersistence {
  static inject = ['sessions']
  prepared = 0

  override locate(_meta: SessionHeader): SessionLocation | undefined { return undefined }
  override create(_meta: SessionHeader): Promise<void> { return Promise.resolve() }
  override append(_id: SessionId, _events: readonly SessionEvent[]): Promise<void> { return Promise.resolve() }
  override load(_id: SessionId): Promise<SessionInspection> { return Promise.reject(new Error('unused')) }
  override inspect(_id: SessionId): Promise<SessionInspection> { return Promise.reject(new Error('unused')) }
  override readFrom(_id: SessionId, _fromSeq: number): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return Promise.reject(new Error('unused'))
  }
  override list(): Promise<SessionHeader[]> { return Promise.resolve([]) }
  override listSnapshots(): Promise<SessionPersistenceSnapshot[]> { return Promise.resolve([]) }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    signal?.throwIfAborted()
    this.prepared += 1
    return Promise.resolve(SessionPreparation.create(this.ctx.sessions.prepare(id)))
  }
}

describe('SliceAgentLifecycle publication and teardown', () => {
  it('keeps setup unpublished, commits, then emits the five publication edges in order', async () => {
    const { ctx } = await harness()
    const setupGate = deferred<void>()
    const setupStarted = deferred<void>()
    const order: string[] = []
    ctx.on('session/created', session => {
      expect(ctx.sessions.get(session.id)).toBe(session)
      expect(ctx.agents.get(session.id)?.session).toBe(session)
      order.push('session-created')
    })
    ctx.on('agent/created', () => { order.push('agent-created') })
    ctx.on('agent/session-start', () => { order.push('session-start') })

    const creating = ctx.agents.create({
      sessionId: SessionId('atomic'),
      setup: async () => {
        order.push('setup-start')
        setupStarted.resolve(undefined)
        await setupGate.promise
        order.push('setup-end')
        return { commit: () => { order.push('setup-commit') } }
      },
    })
    await setupStarted.promise
    expect(ctx.sessions.get(SessionId('atomic'))).toBeUndefined()
    expect(ctx.agents.get(SessionId('atomic'))).toBeUndefined()
    setupGate.resolve(undefined)
    const handle = await creating

    expect(order).toEqual([
      'setup-start',
      'setup-end',
      'setup-commit',
      'session-created',
      'agent-created',
      'session-start',
    ])
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('uses the caller signal only until publication completes', async () => {
    const { ctx } = await harness()
    const pendingController = new AbortController()
    const setupStarted = deferred<void>()
    const pending = ctx.agents.create({
      sessionId: SessionId('pending'),
      signal: pendingController.signal,
      setup: async () => {
        setupStarted.resolve(undefined)
        await new Promise<never>(() => undefined)
      },
    })
    await setupStarted.promise
    pendingController.abort(new Error('cancel pending'))
    await expect(pending).rejects.toThrow('cancel pending')
    expect(ctx.agents.get(SessionId('pending'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('pending'))).toBeUndefined()

    const liveController = new AbortController()
    const live = await ctx.agents.create({
      sessionId: SessionId('live'),
      signal: liveController.signal,
    })
    liveController.abort(new Error('too late'))
    await Promise.resolve()
    expect(ctx.agents.get(live.agent.id)).toBe(live.agent)
    expect(ctx.sessions.get(live.agent.id)).toBe(live.agent.session)
    await live.dispose()
    await ctx.fiber.dispose()
  })

  it('publishes nothing when setup rejects and reopens the identity', async () => {
    const { ctx } = await harness()
    const published: string[] = []
    ctx.on('session/created', () => { published.push('session') })
    ctx.on('agent/created', () => { published.push('agent') })

    await expect(ctx.agents.create({
      sessionId: SessionId('retryable'),
      setup: () => Promise.reject(new Error('setup failed')),
    })).rejects.toThrow('setup failed')
    expect(published).toEqual([])
    expect(ctx.sessions.get(SessionId('retryable'))).toBeUndefined()
    expect(ctx.agents.get(SessionId('retryable'))).toBeUndefined()

    const retry = await ctx.agents.create({ sessionId: SessionId('retryable') })
    await retry.dispose()
    await ctx.fiber.dispose()
  })

  it('publishes nothing when the synchronous setup commit rejects', async () => {
    const { ctx } = await harness()
    const published: string[] = []
    ctx.on('session/created', () => { published.push('session') })
    ctx.on('agent/created', () => { published.push('agent') })

    await expect(ctx.agents.create({
      sessionId: SessionId('commit-veto'),
      setup: () => ({ commit: () => { throw new Error('commit failed') } }),
    })).rejects.toThrow('commit failed')
    expect(published).toEqual([])
    expect(ctx.sessions.get(SessionId('commit-veto'))).toBeUndefined()
    expect(ctx.agents.get(SessionId('commit-veto'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('pairs only the session edge when session announcement vetoes publication', async () => {
    const { ctx } = await harness()
    const order: string[] = []
    ctx.on('session/created', session => {
      order.push(`session-created:${session.id}`)
      throw new Error('session veto')
    })
    ctx.on('session/disposed', session => { order.push(`session-disposed:${session.id}`) })
    ctx.on('agent/created', () => { order.push('agent-created') })
    ctx.on('agent/disposed', () => { order.push('agent-disposed') })

    await expect(ctx.agents.create({ sessionId: SessionId('session-partial') }))
      .rejects.toThrow('session veto')
    expect(order).toEqual([
      'session-created:session-partial',
      'session-disposed:session-partial',
    ])
    expect(ctx.agents.get(SessionId('session-partial'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('session-partial'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('lets final SessionStore.enter arbitrate concurrent same-id preparations', async () => {
    const { ctx } = await harness()
    const gate = deferred<void>()
    const bothStarted = deferred<void>()
    let started = 0
    const setup = async (): Promise<void> => {
      started += 1
      if (started === 2) bothStarted.resolve(undefined)
      await gate.promise
    }
    const sessionId = SessionId('concurrent')
    const first = ctx.agents.create({ sessionId, setup })
    const second = ctx.agents.create({ sessionId, setup })
    await bothStarted.promise
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    gate.resolve(undefined)

    const outcomes = await Promise.allSettled([first, second])
    const winners = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<Awaited<typeof first>> => outcome.status === 'fulfilled',
    )
    const losers = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    )
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(String(losers[0]!.reason)).toContain('already exists')
    expect(ctx.sessions.get(sessionId)).toBe(winners[0]!.value.agent.session)
    expect(ctx.agents.get(sessionId)).toBe(winners[0]!.value.agent)
    await winners[0]!.value.dispose()
    await ctx.fiber.dispose()
  })

  it('rolls the entered Session back when final AgentRegistry.enter collides', async () => {
    const { ctx } = await harness()
    const id = SessionId('agent-collision')
    const occupantSession = ctx.sessions.prepare(id)
    const occupant = new TestAgent(ctx, id, {}, occupantSession, [], undefined)
    const detachOccupant = ctx.agents.enter(occupant, undefined)
    ctx.agents.announce(occupant)

    await expect(ctx.agents.create({ sessionId: id })).rejects.toThrow('already registered')
    expect(ctx.agents.get(id)).toBe(occupant)
    expect(ctx.sessions.get(id)).toBeUndefined()

    detachOccupant()
    await occupant.scope.dispose()
    await ctx.fiber.dispose()
  })

  it('pairs partially delivered announcements during rollback', async () => {
    const { ctx } = await harness()
    const order: string[] = []
    ctx.on('session/created', session => { order.push(`session-created:${session.id}`) })
    ctx.on('session/disposed', session => { order.push(`session-disposed:${session.id}`) })
    ctx.on('agent/created', ({ agent }) => {
      order.push(`agent-created:${agent.id}`)
      throw new Error('publication veto')
    })
    ctx.on('agent/disposed', ({ agent }) => { order.push(`agent-disposed:${agent.id}`) })

    await expect(ctx.agents.create({ sessionId: SessionId('partial') }))
      .rejects.toThrow('publication veto')
    expect(order).toEqual([
      'session-created:partial',
      'agent-created:partial',
      'agent-disposed:partial',
      'session-disposed:partial',
    ])
    expect(ctx.agents.get(SessionId('partial'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('partial'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('contains session-start listener failure because the final edge is veto-less', async () => {
    const { ctx } = await harness()
    const order: string[] = []
    ctx.on('session/created', () => { order.push('session-created') })
    ctx.on('agent/created', () => { order.push('agent-created') })
    ctx.on('agent/session-start', () => {
      order.push('session-start')
      throw new Error('start veto')
    })
    ctx.on('agent/disposed', () => { order.push('agent-disposed') })
    ctx.on('session/disposed', () => { order.push('session-disposed') })

    const handle = await ctx.agents.create({ sessionId: SessionId('start-contained') })
    expect(order).toEqual([
      'session-created',
      'agent-created',
      'session-start',
    ])
    expect(ctx.agents.get(SessionId('start-contained'))).toBe(handle.agent)
    expect(ctx.sessions.get(SessionId('start-contained'))).toBe(handle.agent.session)
    await handle.dispose()
    expect(order).toEqual([
      'session-created',
      'agent-created',
      'session-start',
      'agent-disposed',
      'session-disposed',
    ])
    await ctx.fiber.dispose()
  })

  it('drains and unwinds scope before agent detach, then detaches the session', async () => {
    const idle = deferred<void>()
    const { ctx, order } = await harness(idle.promise)
    const handle = await ctx.agents.create({ sessionId: SessionId('ordered') })
    ctx.on('agent/disposed', ({ agent }) => {
      if (agent !== handle.agent) return
      order.push(`agent-disposed:listed=${ctx.agents.get(agent.id) !== undefined}`)
      order.push(`session-still-live=${ctx.sessions.get(agent.id) !== undefined}`)
    })
    ctx.on('session/disposed', session => {
      if (session === handle.agent.session) order.push('session-disposed')
    })

    const disposing = handle.dispose()
    await Promise.resolve()
    expect(order).toEqual(['cancel', 'when-idle'])
    expect(ctx.agents.get(handle.agent.id)).toBe(handle.agent)
    idle.resolve(undefined)
    await disposing

    expect(order).toEqual([
      'cancel',
      'when-idle',
      'scope-disposed',
      'agent-disposed:listed=false',
      'session-still-live=true',
      'session-disposed',
    ])
    await ctx.fiber.dispose()
  })

  it('factory unload aborts pending setup, drains it, and clears the factory slot', async () => {
    const { ctx, loopFiber } = await harness()
    const setupStarted = deferred<void>()
    const creating = ctx.agents.create({
      sessionId: SessionId('factory-abort'),
      setup: async () => {
        setupStarted.resolve(undefined)
        await new Promise<never>(() => undefined)
      },
    })
    await setupStarted.promise
    await loopFiber.dispose()
    await expect(creating).rejects.toThrow('slice agent loop is not active')
    expect(ctx.agents.get(SessionId('factory-abort'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('factory-abort'))).toBeUndefined()
    await expect(ctx.agents.create({ sessionId: SessionId('no-factory') }))
      .rejects.toThrow('no agent factory registered')
    await ctx.fiber.dispose()
  })

  it('shares one quiescence boundary between factory unload and handle disposal', async () => {
    const idle = deferred<void>()
    const { ctx, loopFiber, order } = await harness(idle.promise)
    const handle = await ctx.agents.create({ sessionId: SessionId('shared-dispose') })
    let factorySettled = false
    let handleSettled = false
    const factoryDisposal = loopFiber.dispose().then(() => { factorySettled = true })
    const handleDisposal = handle.dispose().then(() => { handleSettled = true })
    await Promise.resolve()
    expect(order).toEqual(['cancel', 'when-idle'])
    expect(factorySettled).toBe(false)
    expect(handleSettled).toBe(false)
    idle.resolve(undefined)
    await Promise.all([factoryDisposal, handleDisposal])
    expect(ctx.agents.get(handle.agent.id)).toBeUndefined()
    expect(ctx.sessions.get(handle.agent.id)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('resumes only the exact persistence-balanced preparation', async () => {
    const { ctx } = await harness()
    const persistenceFiber = await ctx.plugin(PreparedPersistence)
    const sources: string[] = []
    ctx.on('agent/session-start', ({ source }) => { sources.push(source) })

    const handle = await ctx.agents.resume({ resumeSessionId: SessionId('restored') })
    expect((ctx.sessionPersistence as PreparedPersistence).prepared).toBe(1)
    expect(handle.agent.session).toBe(ctx.sessions.get(SessionId('restored')))
    expect(sources).toEqual(['resume'])
    await handle.dispose()
    await persistenceFiber.dispose()
    await ctx.fiber.dispose()
  })
})
