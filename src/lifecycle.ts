/**
 * Rollback-covered AgentFactory lifecycle for the Slice-backed DSH loop.
 *
 * The driver is deliberately injected. This module owns publication and
 * teardown only; it never reaches into the driver's phase machine.
 *
 * Plan v2.1: Phase 1 — transaction and teardown.
 */

import { Context } from '@deepseek-ai/cordis'
import { harnessUniverse, type HarnessUniverse } from './universe.js'
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
  SessionStartSource,
} from '@deepseek-ai/dsh-agent'
import type { Session, SessionId, SessionPreparation } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

/** The driver surface the lifecycle owns and unwinds after quiescence. */
export interface LifecycleAgent extends Agent {
  /** Agent-local Cordis scope created by the driver constructor. */
  readonly scope: { dispose(): Promise<void> | void }
}

/** Driver constructor seam shared with the stock loop's constructor shape. */
export type LifecycleAgentBuilder = (
  loopCtx: Context,
  id: SessionId,
  options: AgentOptions,
  session: Session,
) => LifecycleAgent

/** Factory-level structural ownership of live lifecycles and wrappers. */
class FactoryOwnership {
  private accepting = true
  private readonly teardown = new AbortController()
  private readonly liveAgents = new Set<() => Promise<void>>()
  private readonly wrappers = new Set<Promise<void>>()
  private disposing: Promise<void> | undefined

  constructor(private readonly fiber: Context['fiber']) {}

  get signal(): AbortSignal {
    return this.teardown.signal
  }

  isActive(): boolean {
    // Cordis exposes FiberState as a const enum, so no runtime object exists.
    // Keep the three inactive values aligned with its public declaration:
    // FAILED=3, DISPOSED=4, UNLOADING=5. PENDING/LOADING/ACTIVE may still own
    // startup work, exactly like the stock AgentLoop.
    const state = this.fiber.state as number
    return this.accepting && state !== 3 && state !== 4 && state !== 5
  }

  track(dispose: () => Promise<void>): () => void {
    this.liveAgents.add(dispose)
    return () => { this.liveAgents.delete(dispose) }
  }

  trackWrapper(task: Promise<unknown>): void {
    const settled = task.then(() => undefined, () => undefined)
    this.wrappers.add(settled)
    const forget = (): void => { this.wrappers.delete(settled) }
    void settled.then(forget, forget)
  }

  dispose(): Promise<void> {
    return (this.disposing ??= this.disposeOnce())
  }

  private async disposeOnce(): Promise<void> {
    this.accepting = false
    this.teardown.abort(new Error('slice agent loop is not active'))
    await Promise.all([
      ...[...this.liveAgents].map(dispose => dispose()),
      ...this.wrappers,
    ])
  }
}

/** Prepared-but-unpublished resources sharing one memoized teardown. */
interface PreparedAgent {
  readonly agent: LifecycleAgent
  readonly signal: AbortSignal
  publish(source: SessionStartSource): AgentHandle
  dispose(): Promise<void>
}

/** ES2022-compatible deferred used while the package keeps a conservative target. */
function deferred<T>(): {
  readonly promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

/** Invoke the runtime's explicit-resource-management hook without requiring an ESNext lib target. */
function releasePreparation(preparation: SessionPreparation): void {
  const dispose = (Symbol as unknown as { readonly dispose: symbol }).dispose
  const disposable = preparation as unknown as Record<symbol, () => void>
  disposable[dispose]()
}

/** Turn an arbitrary abort reason into the creation boundary's stable Error. */
function abortError(signal: AbortSignal, id: SessionId): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
}

/** Await an operation, but stop waiting as soon as its owner aborts. */
async function raceAbort<T>(operation: PromiseLike<T> | T, signal: AbortSignal, id: SessionId): Promise<T> {
  if (signal.aborted) throw abortError(signal, id)
  const aborted = deferred<never>()
  const listener = (): void => { aborted.reject(abortError(signal, id)) }
  signal.addEventListener('abort', listener, { once: true })
  try {
    return await Promise.race([Promise.resolve(operation), aborted.promise])
  } finally {
    signal.removeEventListener('abort', listener)
  }
}

/** Release a value that arrives after cancellation of an abortable acquisition. */
async function raceAbortCall<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal,
  id: SessionId,
  releaseAbandoned?: (value: T) => void,
): Promise<T> {
  if (signal.aborted) throw abortError(signal, id)
  const pending = Promise.resolve().then(operation)
  try {
    return await raceAbort(pending, signal, id)
  } catch (error: unknown) {
    if (signal.aborted && releaseAbandoned !== undefined) {
      void pending.then(releaseAbandoned, () => undefined)
    }
    throw error
  }
}

/** Reject an output-token cap that DSH cannot represent exactly. */
function assertAgentOptions(options: AgentOptions): void {
  if (options.maxTokens !== undefined
    && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) {
    throw new TypeError('agent maxTokens must be a positive safe integer')
  }
}

/**
 * AgentFactory implementation for SliceLoopAgent.
 *
 * Construction installs the provider-owned teardown before the plugin should
 * register this factory in `ctx.agents`. That ordering makes factory-slot
 * removal happen before live lifecycle drainage on Cordis unload.
 */
export class SliceAgentLifecycle implements AgentFactory {
  private readonly ownership: FactoryOwnership

  constructor(
    private readonly ctx: Context,
    private readonly buildAgent: LifecycleAgentBuilder,
    private readonly universeReady: Promise<HarnessUniverse>,
  ) {
    this.ownership = new FactoryOwnership(ctx.fiber)
    ctx.effect(() => () => this.ownership.dispose(), 'sliceLoop.transactions()')
  }

  /** Create a fresh, unpublished Session and publish its Agent transaction. */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    // Universe first: every identity-sensitive value below (SessionPreparation,
    // createScope in the driver, emitAgentEvent) must come from the HOST's
    // module instances, and this await is what guarantees harnessUniverse()
    // is resolved before any of them run. Its rejection is the loud failure.
    const { session: sessionModule } = await this.universeReady
    const preparation = sessionModule.SessionPreparation.create(this.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta },
    }))
    const published = this.setupAndPublish(
      ownerCtx,
      options.sessionId,
      preparation,
      options.agentOptions ?? {},
      options.setup,
      options.signal,
      'startup',
    )
    this.ownership.trackWrapper(published)
    return published
  }

  /** Consume a persistence-balanced preparation and publish a new live Agent. */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    // Same gate as createAgent: the driver and emitAgentEvent downstream
    // require the resolved host universe.
    await this.universeReady
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    return this.resumeWith(ownerCtx, persistence, options)
  }

  /** Resume through an explicit service handle while preserving owner races. */
  private resumeWith(
    ownerCtx: Context,
    persistence: SessionPersistence,
    options: ResumeAgentOptions,
  ): Promise<AgentHandle> {
    const id = options.resumeSessionId
    const published = (async (): Promise<AgentHandle> => {
      const ownerAbort = new AbortController()
      const unfollowOwner = ownerCtx.effect(() => () => {
        ownerAbort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
      }, `sliceLoop.resume-load(${id})`)
      const fused = AbortSignal.any([
        ...options.signal === undefined ? [] : [options.signal],
        ownerAbort.signal,
        this.ownership.signal,
      ])
      let preparation: SessionPreparation | undefined
      try {
        try {
          preparation = await raceAbortCall(
            () => persistence.prepare(id, fused),
            fused,
            id,
            releasePreparation,
          )
        } finally {
          await unfollowOwner()
        }
        ownerCtx.fiber.assertActive()
        if (!this.ownership.isActive()) throw new Error('slice agent loop is not active')
        return await this.setupAndPublish(
          ownerCtx,
          id,
          preparation,
          options.agentOptions ?? {},
          options.setup,
          options.signal,
          'resume',
        )
      } finally {
        if (preparation !== undefined) releasePreparation(preparation)
      }
    })()
    this.ownership.trackWrapper(published)
    return published
  }

  /** Run unpublished setup, commit it synchronously, then publish all edges. */
  private async setupAndPublish(
    ownerCtx: Context,
    id: SessionId,
    preparation: SessionPreparation,
    agentOptions: AgentOptions,
    setup: AgentSetup | undefined,
    signal: AbortSignal | undefined,
    source: SessionStartSource,
  ): Promise<AgentHandle> {
    try {
      const prepared = this.prepare(ownerCtx, id, agentOptions, preparation.session, signal)
      try {
        const setupCommit = await raceAbort(setup?.(prepared.agent.ctx), prepared.signal, id)
        setupCommit?.commit()
        return prepared.publish(source)
      } catch (error: unknown) {
        await prepared.dispose()
        throw error
      }
    } finally {
      releasePreparation(preparation)
    }
  }

  /**
   * Construct one driver and its single reverse-order teardown before setup.
   * Every abort owner shares this exact promise, so nobody can unregister a
   * still-running driver or unwind its scope twice.
   */
  private prepare(
    ownerCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    callerSignal?: AbortSignal,
  ): PreparedAgent {
    assertAgentOptions(options)
    ownerCtx.fiber.assertActive()
    if (!this.ownership.isActive()) throw new Error('slice agent loop is not active')
    if (callerSignal?.aborted) throw abortError(callerSignal, id)

    const abort = new AbortController()
    const onCallerAbort = (): void => {
      abort.abort(callerSignal?.reason instanceof Error
        ? callerSignal.reason
        : new Error(`agent "${id}" creation aborted`, { cause: callerSignal?.reason }))
    }
    const onFactoryTeardown = (): void => { abort.abort(this.ownership.signal.reason) }
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    this.ownership.signal.addEventListener('abort', onFactoryTeardown, { once: true })

    let agent: LifecycleAgent | undefined
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined
    let callerSignalDetached = false
    const agentReady = deferred<void>()

    const detachCallerSignal = (): void => {
      if (callerSignalDetached) return
      callerSignalDetached = true
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }

    const dispose = (ownerTriggered = false): Promise<void> => (disposing ??= (async () => {
      abort.abort(new Error(`agent "${id}" lifecycle disposed`))
      detachCallerSignal()
      this.ownership.signal.removeEventListener('abort', onFactoryTeardown)
      try {
        if (agent === undefined) await agentReady.promise
        if (agent !== undefined) {
          agent.cancel({ kind: 'disposed' })
          await agent.whenIdle()
          await agent.scope.dispose()
        }
      } finally {
        try {
          detachAgent?.()
          detachSession?.()
        } finally {
          untrack()
          if (!ownerTriggered) await unfollowOwner()
        }
      }
    })())
    const untrack = this.ownership.track(dispose)
    let unfollowOwner: () => Promise<void> | void
    try {
      unfollowOwner = ownerCtx.effect(() => () => {
        if (disposing !== undefined) return
        abort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
        return dispose(true)
      }, `sliceLoop.lifecycle(${id})`)
    } catch (error: unknown) {
      untrack()
      detachCallerSignal()
      this.ownership.signal.removeEventListener('abort', onFactoryTeardown)
      throw error
    }

    const assertLive = (): void => {
      if (abort.signal.aborted) throw abortError(abort.signal, id)
    }

    try {
      agent = this.buildAgent(this.ctx, id, options, session)
      agentReady.resolve(undefined)
      assertLive()

      return {
        agent,
        signal: abort.signal,
        publish: (source) => {
          assertLive()
          detachSession = agent!.ctx.sessions.enter(session)
          detachAgent = this.ctx.agents.enter(agent!, ownerCtx.agent)
          agent!.ctx.sessions.announce(session)
          assertLive()
          this.ctx.agents.announce(agent!)
          assertLive()
          harnessUniverse().agent.emitAgentEvent(this.ctx, agent!, 'agent/session-start', { source })
          assertLive()
          // The caller's signal is creation-only; returned live handles do not
          // inherit later aborts from it.
          detachCallerSignal()
          return { agent: agent!, dispose }
        },
        dispose,
      }
    } catch (error: unknown) {
      agentReady.resolve(undefined)
      void dispose()
      throw error
    }
  }
}
