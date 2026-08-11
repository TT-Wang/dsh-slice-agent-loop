/**
 * Rollback-covered AgentFactory lifecycle for the Slice-backed DSH loop.
 *
 * The driver is deliberately injected. This module owns publication and
 * teardown only; it never reaches into the driver's phase machine.
 *
 * Plan v2.1: Phase 1 — transaction and teardown.
 */
import { Context } from 'cordis';
import type { Agent, AgentFactory, AgentHandle, AgentOptions, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Session } from '@deepseek-ai/dsh-session';
/** The driver surface the lifecycle owns and unwinds after quiescence. */
export interface LifecycleAgent extends Agent {
    /** Agent-local Cordis scope created by the driver constructor. */
    readonly scope: {
        dispose(): Promise<void> | void;
    };
}
/** Driver constructor seam shared with the stock loop's constructor shape. */
export type LifecycleAgentBuilder = (loopCtx: Context, id: SessionId, options: AgentOptions, session: Session) => LifecycleAgent;
/**
 * AgentFactory implementation for SliceLoopAgent.
 *
 * Construction installs the provider-owned teardown before the plugin should
 * register this factory in `ctx.agents`. That ordering makes factory-slot
 * removal happen before live lifecycle drainage on Cordis unload.
 */
export declare class SliceAgentLifecycle implements AgentFactory {
    private readonly ctx;
    private readonly buildAgent;
    private readonly ownership;
    constructor(ctx: Context, buildAgent: LifecycleAgentBuilder);
    /** Create a fresh, unpublished Session and publish its Agent transaction. */
    createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>;
    /** Consume a persistence-balanced preparation and publish a new live Agent. */
    resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>;
    /** Resume through an explicit service handle while preserving owner races. */
    private resumeWith;
    /** Run unpublished setup, commit it synchronously, then publish all edges. */
    private setupAndPublish;
    /**
     * Construct one driver and its single reverse-order teardown before setup.
     * Every abort owner shares this exact promise, so nobody can unregister a
     * still-running driver or unwind its scope twice.
     */
    private prepare;
}
