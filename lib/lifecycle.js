/**
 * Rollback-covered AgentFactory lifecycle for the Slice-backed DSH loop.
 *
 * The driver is deliberately injected. This module owns publication and
 * teardown only; it never reaches into the driver's phase machine.
 *
 * Plan v2.1: Phase 1 — transaction and teardown.
 */
import { emitAgentEvent } from '@deepseek-ai/dsh-agent';
import { SessionPreparation } from '@deepseek-ai/dsh-session';
/** Factory-level structural ownership of live lifecycles and wrappers. */
class FactoryOwnership {
    fiber;
    accepting = true;
    teardown = new AbortController();
    liveAgents = new Set();
    wrappers = new Set();
    disposing;
    constructor(fiber) {
        this.fiber = fiber;
    }
    get signal() {
        return this.teardown.signal;
    }
    isActive() {
        // Cordis exposes FiberState as a const enum, so no runtime object exists.
        // Keep the three inactive values aligned with its public declaration:
        // FAILED=3, DISPOSED=4, UNLOADING=5. PENDING/LOADING/ACTIVE may still own
        // startup work, exactly like the stock AgentLoop.
        const state = this.fiber.state;
        return this.accepting && state !== 3 && state !== 4 && state !== 5;
    }
    track(dispose) {
        this.liveAgents.add(dispose);
        return () => { this.liveAgents.delete(dispose); };
    }
    trackWrapper(task) {
        const settled = task.then(() => undefined, () => undefined);
        this.wrappers.add(settled);
        const forget = () => { this.wrappers.delete(settled); };
        void settled.then(forget, forget);
    }
    dispose() {
        return (this.disposing ??= this.disposeOnce());
    }
    async disposeOnce() {
        this.accepting = false;
        this.teardown.abort(new Error('slice agent loop is not active'));
        await Promise.all([
            ...[...this.liveAgents].map(dispose => dispose()),
            ...this.wrappers,
        ]);
    }
}
/** ES2022-compatible deferred used while the package keeps a conservative target. */
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}
/** Invoke the runtime's explicit-resource-management hook without requiring an ESNext lib target. */
function releasePreparation(preparation) {
    const dispose = Symbol.dispose;
    const disposable = preparation;
    disposable[dispose]();
}
/** Turn an arbitrary abort reason into the creation boundary's stable Error. */
function abortError(signal, id) {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error(`agent "${id}" creation aborted`, { cause: signal.reason });
}
/** Await an operation, but stop waiting as soon as its owner aborts. */
async function raceAbort(operation, signal, id) {
    if (signal.aborted)
        throw abortError(signal, id);
    const aborted = deferred();
    const listener = () => { aborted.reject(abortError(signal, id)); };
    signal.addEventListener('abort', listener, { once: true });
    try {
        return await Promise.race([Promise.resolve(operation), aborted.promise]);
    }
    finally {
        signal.removeEventListener('abort', listener);
    }
}
/** Release a value that arrives after cancellation of an abortable acquisition. */
async function raceAbortCall(operation, signal, id, releaseAbandoned) {
    if (signal.aborted)
        throw abortError(signal, id);
    const pending = Promise.resolve().then(operation);
    try {
        return await raceAbort(pending, signal, id);
    }
    catch (error) {
        if (signal.aborted && releaseAbandoned !== undefined) {
            void pending.then(releaseAbandoned, () => undefined);
        }
        throw error;
    }
}
/** Reject an output-token cap that DSH cannot represent exactly. */
function assertAgentOptions(options) {
    if (options.maxTokens !== undefined
        && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) {
        throw new TypeError('agent maxTokens must be a positive safe integer');
    }
}
/**
 * AgentFactory implementation for SliceLoopAgent.
 *
 * Construction installs the provider-owned teardown before the plugin should
 * register this factory in `ctx.agents`. That ordering makes factory-slot
 * removal happen before live lifecycle drainage on Cordis unload.
 */
export class SliceAgentLifecycle {
    ctx;
    buildAgent;
    ownership;
    constructor(ctx, buildAgent) {
        this.ctx = ctx;
        this.buildAgent = buildAgent;
        this.ownership = new FactoryOwnership(ctx.fiber);
        ctx.effect(() => () => this.ownership.dispose(), 'sliceLoop.transactions()');
    }
    /** Create a fresh, unpublished Session and publish its Agent transaction. */
    async createAgent(ownerCtx, options) {
        const preparation = SessionPreparation.create(this.ctx.sessions.prepare(options.sessionId, {
            ...options.seed === undefined ? {} : { seed: options.seed },
            ...options.meta === undefined ? {} : { meta: options.meta },
        }));
        const published = this.setupAndPublish(ownerCtx, options.sessionId, preparation, options.agentOptions ?? {}, options.setup, options.signal, 'startup');
        this.ownership.trackWrapper(published);
        return published;
    }
    /** Consume a persistence-balanced preparation and publish a new live Agent. */
    async resume(ownerCtx, options) {
        const persistence = this.ctx.get('sessionPersistence');
        if (persistence === undefined) {
            throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)');
        }
        return this.resumeWith(ownerCtx, persistence, options);
    }
    /** Resume through an explicit service handle while preserving owner races. */
    resumeWith(ownerCtx, persistence, options) {
        const id = options.resumeSessionId;
        const published = (async () => {
            const ownerAbort = new AbortController();
            const unfollowOwner = ownerCtx.effect(() => () => {
                ownerAbort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`));
            }, `sliceLoop.resume-load(${id})`);
            const fused = AbortSignal.any([
                ...options.signal === undefined ? [] : [options.signal],
                ownerAbort.signal,
                this.ownership.signal,
            ]);
            let preparation;
            try {
                try {
                    preparation = await raceAbortCall(() => persistence.prepare(id, fused), fused, id, releasePreparation);
                }
                finally {
                    await unfollowOwner();
                }
                ownerCtx.fiber.assertActive();
                if (!this.ownership.isActive())
                    throw new Error('slice agent loop is not active');
                return await this.setupAndPublish(ownerCtx, id, preparation, options.agentOptions ?? {}, options.setup, options.signal, 'resume');
            }
            finally {
                if (preparation !== undefined)
                    releasePreparation(preparation);
            }
        })();
        this.ownership.trackWrapper(published);
        return published;
    }
    /** Run unpublished setup, commit it synchronously, then publish all edges. */
    async setupAndPublish(ownerCtx, id, preparation, agentOptions, setup, signal, source) {
        try {
            const prepared = this.prepare(ownerCtx, id, agentOptions, preparation.session, signal);
            try {
                const setupCommit = await raceAbort(setup?.(prepared.agent.ctx), prepared.signal, id);
                setupCommit?.commit();
                return prepared.publish(source);
            }
            catch (error) {
                await prepared.dispose();
                throw error;
            }
        }
        finally {
            releasePreparation(preparation);
        }
    }
    /**
     * Construct one driver and its single reverse-order teardown before setup.
     * Every abort owner shares this exact promise, so nobody can unregister a
     * still-running driver or unwind its scope twice.
     */
    prepare(ownerCtx, id, options, session, callerSignal) {
        assertAgentOptions(options);
        ownerCtx.fiber.assertActive();
        if (!this.ownership.isActive())
            throw new Error('slice agent loop is not active');
        if (callerSignal?.aborted)
            throw abortError(callerSignal, id);
        const abort = new AbortController();
        const onCallerAbort = () => {
            abort.abort(callerSignal?.reason instanceof Error
                ? callerSignal.reason
                : new Error(`agent "${id}" creation aborted`, { cause: callerSignal?.reason }));
        };
        const onFactoryTeardown = () => { abort.abort(this.ownership.signal.reason); };
        callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
        this.ownership.signal.addEventListener('abort', onFactoryTeardown, { once: true });
        let agent;
        let detachSession;
        let detachAgent;
        let disposing;
        let callerSignalDetached = false;
        const agentReady = deferred();
        const detachCallerSignal = () => {
            if (callerSignalDetached)
                return;
            callerSignalDetached = true;
            callerSignal?.removeEventListener('abort', onCallerAbort);
        };
        const dispose = (ownerTriggered = false) => (disposing ??= (async () => {
            abort.abort(new Error(`agent "${id}" lifecycle disposed`));
            detachCallerSignal();
            this.ownership.signal.removeEventListener('abort', onFactoryTeardown);
            try {
                if (agent === undefined)
                    await agentReady.promise;
                if (agent !== undefined) {
                    agent.cancel({ kind: 'disposed' });
                    await agent.whenIdle();
                    await agent.scope.dispose();
                }
            }
            finally {
                try {
                    detachAgent?.();
                    detachSession?.();
                }
                finally {
                    untrack();
                    if (!ownerTriggered)
                        await unfollowOwner();
                }
            }
        })());
        const untrack = this.ownership.track(dispose);
        let unfollowOwner;
        try {
            unfollowOwner = ownerCtx.effect(() => () => {
                if (disposing !== undefined)
                    return;
                abort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`));
                return dispose(true);
            }, `sliceLoop.lifecycle(${id})`);
        }
        catch (error) {
            untrack();
            detachCallerSignal();
            this.ownership.signal.removeEventListener('abort', onFactoryTeardown);
            throw error;
        }
        const assertLive = () => {
            if (abort.signal.aborted)
                throw abortError(abort.signal, id);
        };
        try {
            agent = this.buildAgent(this.ctx, id, options, session);
            agentReady.resolve(undefined);
            assertLive();
            return {
                agent,
                signal: abort.signal,
                publish: (source) => {
                    assertLive();
                    detachSession = agent.ctx.sessions.enter(session);
                    detachAgent = this.ctx.agents.enter(agent, ownerCtx.agent);
                    agent.ctx.sessions.announce(session);
                    assertLive();
                    this.ctx.agents.announce(agent);
                    assertLive();
                    emitAgentEvent(this.ctx, agent, 'agent/session-start', { source });
                    assertLive();
                    // The caller's signal is creation-only; returned live handles do not
                    // inherit later aborts from it.
                    detachCallerSignal();
                    return { agent: agent, dispose };
                },
                dispose,
            };
        }
        catch (error) {
            agentReady.resolve(undefined);
            void dispose();
            throw error;
        }
    }
}
