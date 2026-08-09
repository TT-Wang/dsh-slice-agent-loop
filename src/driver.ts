/**
 * SliceLoopAgent — the SliceAgent concrete agent driver for the DeepSeek Harness.
 *
 * The dsh `Agent` contract over the ported bounded-slice engine: claim input at
 * turn/step boundaries, assemble the bounded context via src/slice, stream one
 * model request through dsh-llm, and append the durable session events the
 * contract requires. Plan v2.1 phases 2–4 (driver core).
 *
 * Contract behavior mirrors the stock dsh-agent-loop driver:
 * turn/steps stay balanced (new turns open only from next-turn claims),
 * pre-step runs BEFORE step/start and a rejection closes the turn blocked,
 * claimed user input is appended as durable `user/message` surface events,
 * agent/error carries the verbatim thrown value, provider finish-errors route
 * through agent/request-error before any retry, turn-stopping steering stays
 * in the same turn, the whole request lifetime runs inside the agent's
 * initiator scope, whenIdle follows replacement work started at the retiring
 * idle edge, the active abort signal reaches every model request, scoped
 * system sections and registered tool schemas ride the request and its
 * canonical epoch header (deduplicated across same-turn steps), turn
 * numbering recovers from a seeded session, maintenance-task rejection stays
 * with its caller (agent quiescence still fulfills), and model tool calls
 * execute through the dsh-tools scheduler with durable tool/call +
 * tool/result pairing — parallel-safe bodies overlap up to the plugin-owned
 * maxParallelToolCalls cap before a continuation step replays derived history
 * for exact callId pairing.
 *
 * Plan gates honored here: wake-after-abort reroute is owned by the inbox
 * ledger; status flips only on real transitions; a rejected step's claimed
 * batch is gone (never re-queued); cancel is first-cause-wins and never arms
 * future work when idle; agent/request-error fires BEFORE any retry.
 */

import type { Context } from 'cordis'
import { agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  PreStepDecision,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import type {
  GenerateOptions,
  LlmCallConfig,
  Message,
  PreparedLlmCall,
  ToolCallBlock,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import {
  BlockAssembler,
  LlmError,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  deepFreeze,
  errorChain,
  markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type {
  RequestContext,
  Session,
  SessionId,
  TurnEndReason,
} from '@deepseek-ai/dsh-session'
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session'
import { renderPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import {
  TOOL_ABORTED_BEFORE_DISPATCH,
  TOOL_REGISTRY_SCHEDULER,
  type ToolExecutionInput,
  type ToolExecutionMode,
  type ToolExecutionResult,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { InboxLedger } from './inbox-ledger.js'
import { assembleSlice, normalizeCtx, type AssembledSlice } from './slice/index.js'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number; wakeRequested: boolean }
  | { kind: 'running'; abort: AbortController; turn: number; step: number }

type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>

type PreparedStep =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; assembly: PromptAssembly }

/** Plugin-owned scheduler settings, validated by SliceLoopPlugin before construction. */
export interface SliceLoopDriverConfig {
  /** Maximum in-flight parallel-safe tool calls per step. */
  maxParallelToolCalls: number
}

/** One tool call after argument parsing, ready to schedule. */
interface PlannedCall {
  block: ToolCallBlock
  exec: ToolExecutionInput
}

/** Settled dispatch awaiting model-order finalization. */
interface ToolSlot {
  exec: ToolRunContext
  result: ToolExecutionResult
  needsPost: boolean
}

export class SliceLoopAgent implements Agent {
  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: Session
  readonly ctx: Context
  readonly scope: Scope

  private readonly loopCtx: Context
  private readonly dispatch: AgentEventDispatch
  private readonly ledger: InboxLedger
  private readonly maxParallelToolCalls: number
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()
  private requestHeaderLogged = false
  private sliceSpec: Record<string, unknown> = { s: { task: {} } }

  constructor(
    loopCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    config: SliceLoopDriverConfig,
  ) {
    this.loopCtx = loopCtx
    this.id = id
    this.options = options
    this.session = session
    this.maxParallelToolCalls = config.maxParallelToolCalls
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.dispatch = agentEvents(this.ctx, this)
    this.ledger = new InboxLedger(session, this.dispatch, {
      signal: () => (this.phase.kind === 'idle' ? undefined : this.phase.abort.signal),
      wake: () => this.wakeDriver(),
    })
    // Resume: turn numbering continues from the seeded session's last turn.
    let lastTurn = 0
    for (let index = session.events.length - 1; index >= 0; index -= 1) {
      const event = session.events[index]!
      if (event.type === 'turn/start') {
        lastTurn = event.data.turn
        break
      }
    }
    this.phase = { kind: 'idle', lastTurn }
  }

  get status(): AgentStatus {
    return this.phase.kind === 'running' ? 'running' : 'idle'
  }

  get inbox() {
    return this.ledger.inbox
  }

  // ------------------------------------------------------------------ input

  send(message: UserMessage, target: 'next-turn' | 'next-step', wakeup: boolean): void {
    this.ledger.send(message, target, wakeup)
  }
  followup(message: UserMessage): void {
    this.ledger.followup(message)
  }
  steer(message: UserMessage): void {
    this.ledger.steer(message)
  }
  inject(message: UserMessage): void {
    this.ledger.inject(message)
  }

  /** Start one driver, or remember its wake behind maintenance. */
  wakeDriver(): void {
    const phase = this.phase
    if (phase.kind === 'maintenance') {
      if (!phase.abort.signal.aborted) phase.wakeRequested = true
      return
    }
    if (phase.kind !== 'idle') return
    let resolveDriver!: () => void
    let rejectDriver!: (error: unknown) => void
    this.activityDone = new Promise<void>((resolve, reject) => {
      resolveDriver = resolve
      rejectDriver = reject
    })
    this.setPhase({ kind: 'running', abort: new AbortController(), turn: phase.lastTurn, step: 0 })
    // The complete request lifetime runs inside this agent's initiator scope.
    void this.loopCtx.agents.withInitiator(this, () => this.kick())
      .then(resolveDriver, rejectDriver)
  }

  // ---------------------------------------------------------------- control

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.ledger.clear()
      if (this.phase.kind === 'maintenance') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  /** Settles only when no activity remains, following replacement work started at a retiring idle edge. */
  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /**
   * Run one maintenance task behind the idle boundary. A task rejection stays
   * with the caller; agent quiescence observed via whenIdle still fulfills.
   */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') {
      throw new Error(`agent "${this.id}" already has active work`)
    }
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done
    return (async (): Promise<T> => {
      try {
        return await task(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested) this.wakeDriver()
        resolveDone()
      }
    })()
  }

  // ------------------------------------------------------------------ turns

  private setPhase(next: Phase): void {
    const before = this.status
    this.phase = next
    if (before !== this.status) {
      this.dispatch.emit('agent/status', { status: this.status })
    }
  }

  /** Report one failure at its live boundary with the verbatim thrown value, then rethrow. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) { /* queued followups close as distinct balanced turns */ }
    } catch {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      if (this.phase.kind === 'running') {
        this.setPhase({ kind: 'idle', lastTurn: this.phase.turn })
      }
    }
  }

  /** Claim the boundary's batch, assemble the scoped prompt, then run pre-step before any durable step opens. */
  private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    const claimed = target === 'next-turn'
      ? this.ledger.claimFirstStep(position.turn)
      : this.ledger.claimNextStep(position.turn)
    const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
    signal.throwIfAborted()
    const decision: PreStepDecision = await this.dispatch.waterfall(
      'agent/pre-step',
      { messages: claimed, ...position, signal },
      async () => ({ kind: 'enter', messages: claimed }) as PreStepDecision,
    )
    signal.throwIfAborted()
    return decision.kind === 'reject' ? decision : { ...decision, assembly }
  }

  /** Open one turn before claiming its first proposed step; returns true when queued work owns a later turn. */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    let turnEnds: TurnEndReason | null = null
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        const decision = await this.preStep(target, { turn, step })
        if (decision.kind === 'reject') {
          // No durable step opens; the claimed batch is gone (never re-queued).
          turnEnds = { kind: 'blocked' }
          return false
        }
        if (turnEnds && decision.messages.length === 0) break
        // An empty first batch still owns the turn boundary but spends no model call.
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })
        phase.step = step
        try {
          for (const message of decision.messages) {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
          const stepEnd = await this.step(decision.messages, decision.assembly)
          // max-tokens is sticky: a later completed step must not downgrade it.
          if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
        } finally {
          this.session.append('step/end', { turn, step })
        }
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) {
          // turn-stopping: serial seam — a listener objects by steering new input,
          // and that steering continues in the SAME turn as a later step.
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnEnds = { kind: 'aborted', reason: signal.reason as AgentCancelCause }
        throw error
      }
      // Every failure is structured: an LlmError keeps its facts, anything else
      // flattens to errorChain text under the UNKNOWN code.
      turnEnds = {
        kind: 'error',
        error: error instanceof LlmError
          ? error.failure
          : { message: errorChain(error), code: 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      try {
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    if (!this.inbox.hasPending) return false
    // A later turn gets a fresh abort scope: a cancel that killed this turn must
    // not poison queued work, and an idle-edge wake must see an unaborted signal.
    phase.abort = new AbortController()
    phase.step = 0
    return true
  }

  /**
   * Execute one model request and the tool calls it asks for.
   * Returns null when tool results require a continuation step in this turn.
   */
  private async step(claimed: UserMessage[], assembly: PromptAssembly): Promise<StepEndReason | null> {
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()

    // Assemble the bounded slice for this step. The dsh system prompt is the
    // host-owned byte-stable system prefix; the slice engine owns the volatile
    // user-side context selection.
    const requestText = claimed.map((m) => blockText(m)).join('\n')
    this.sliceSpec = {
      ...this.sliceSpec,
      s: { ...(this.sliceSpec.s as Record<string, unknown>),
           task: { goal: requestText, goal_source: 'conversation' } },
    }
    const assembled: AssembledSlice = assembleSlice(
      normalizeCtx(this.sliceSpec, (text) => text),
      { systemPrefix: renderPrompt(assembly), request: requestText },
    )
    const tools = assembly.tools

    while (true) {
      const seed = {
        ...(this.options.provider !== undefined ? { provider: this.options.provider } : {}),
        ...(this.options.model !== undefined ? { model: this.options.model } : {}),
        ...(this.options.maxTokens !== undefined ? { maxTokens: this.options.maxTokens } : {}),
      } as LlmCallConfig
      const proposed: LlmCallConfig = await this.dispatch.waterfall(
        'agent/request',
        { turn, step, signal },
        async () => seed,
      )
      signal.throwIfAborted()
      if (!proposed.provider || !proposed.model) {
        throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`)
      }
      let config: LlmCallConfig
      let preparedCall: PreparedLlmCall | undefined
      try {
        preparedCall = await this.loopCtx.llm.prepareCall(proposed, signal)
        config = preparedCall.config
      } catch (error: unknown) {
        // Middleware may serve an unregistered route; terminal dispatch still requires an adapter.
        if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
        config = proposed
      }
      signal.throwIfAborted()

      // Canonical epoch header: appended on initial/resume/change only, so
      // identical same-turn requests share one durable epoch and context.
      const header = canonicalHeader({
        config,
        ...(preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults }),
        ...(assembled.systemPrefix ? { system: assembled.systemPrefix } : {}),
        ...(tools.length > 0 ? { tools } : {}),
      })
      const baseline = this.session.requestHeader()
      if (!this.requestHeaderLogged) {
        this.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
        this.requestHeaderLogged = true
      } else if (baseline === undefined || !headerEquals(baseline, header)) {
        this.session.append('request/header', { header, reason: 'change' })
      }
      const contextWindow = preparedCall?.context?.contextWindow
      const requestContext: RequestContext = {
        provider: config.provider!,
        model: config.model!,
        ...(contextWindow === undefined ? {} : { contextWindow }),
      }
      const previousContext = this.session.requestContext()
      if (previousContext?.provider !== requestContext.provider
        || previousContext.model !== requestContext.model
        || previousContext.contextWindow !== requestContext.contextWindow) {
        this.session.append('request/context', requestContext)
      }

      // Tool continuations replay the derived history so the provider sees the
      // exact tool-call/tool-result pairing; input steps send the bounded slice.
      const messages: Message[] = claimed.length === 0
        ? this.session.deriveMessages()
        : [createUserMessage({
            content: [{ type: 'text', text: assembled.userString }],
            source: { kind: 'user' },
          })]
      const request = markAgentLoopRequest(deepFreeze({
        ...header.config,
        messages,
        ...(header.system !== undefined ? { system: header.system } : {}),
        ...(header.tools !== undefined ? { tools: header.tools } : {}),
        sessionId: this.session.id,
        signal,
      })) as GenerateOptions

      const assembler = new BlockAssembler()
      const chunkSeqs: number[] = []
      const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
      signal.throwIfAborted()
      for await (const chunk of stream) {
        signal.throwIfAborted()
        chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
        assembler.push(chunk)
      }
      signal.throwIfAborted()
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        // agent/request-error fires BEFORE any retry decision (contract).
        const action: RequestErrorAction = await this.dispatch.waterfall(
          'agent/request-error',
          { turn, step, provider: request.provider, failure: finish.failure, retryPolicy: preparedCall?.retryPolicy, signal },
          async () => undefined as RequestErrorAction,
        )
        signal.throwIfAborted()
        if (action?.kind !== 'retry') {
          throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
        }
        continue
      }

      const message = createAssistantMessage({
        content: assembler.blocks(),
        source: {
          provider: request.provider,
          model: request.model,
          ...(assembler.replayState !== undefined ? { replayState: assembler.replayState } : {}),
        },
      })
      this.session.append(
        'assistant/message',
        { turn, step, message, ...(assembler.usage === undefined ? {} : { usage: assembler.usage }) },
        { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
      )
      if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }

      const toolCalls = message.content.filter(
        (block): block is ToolCallBlock => block.type === 'tool-call',
      )
      if (toolCalls.length === 0) return { kind: 'completed' }
      const { concluded } = await this.executeToolCalls(turn, step, toolCalls, signal)
      return concluded ? { kind: 'completed' } : null
    }
  }

  // ------------------------------------------------------------------ tools

  /**
   * Execute one step's tool calls through the dsh-tools scheduler, mirroring
   * the stock driver's scheduler: exclusive calls form barriers, parallel-safe
   * calls overlap in a bounded rolling pool (the plugin-owned
   * maxParallelToolCalls cap), results and result contexts commit in model
   * order, and abort stops replenishment, drains started calls, and records
   * synthetic error results for skipped calls so replay stays valid.
   */
  private async executeToolCalls(
    turn: number,
    step: number,
    toolCalls: ToolCallBlock[],
    signal: AbortSignal,
  ): Promise<{ concluded: boolean }> {
    const planned: PlannedCall[] = toolCalls.map((block) => ({
      block,
      exec: {
        callId: block.id,
        name: block.name,
        arguments: parseArguments(block.arguments),
        agent: this,
        signal,
      },
    }))

    let next = 0
    let concluded = false
    while (next < planned.length) {
      // Commit before classifying again so registry changes affect unstarted calls.
      const first = planned[next]!
      const mode = this.loopCtx.tools.executionMode(first.exec).kind
      const group = mode === 'parallel' ? planned.slice(next) : [first]
      const outcome = await this.runToolGroup(turn, step, group, mode, signal)
      next += outcome.consumed
      concluded ||= outcome.concluded
      if (outcome.aborted) {
        for (const call of planned.slice(next)) this.appendSkippedToolCall(turn, step, call.block)
        return { concluded }
      }
    }
    return { concluded }
  }

  /** Run one exclusive barrier or parallel pool; results commit in model order. */
  private async runToolGroup(
    turn: number,
    step: number,
    group: PlannedCall[],
    mode: ToolExecutionMode['kind'],
    signal: AbortSignal,
  ): Promise<{ consumed: number; aborted: boolean; concluded: boolean }> {
    const scheduler = this.loopCtx.tools[TOOL_REGISTRY_SCHEDULER]
    const slots: Array<ToolSlot | undefined> = group.map(() => undefined)
    // Started slots retain their tool/call seq for result provenance.
    const callSeqs: number[] = group.map(() => -1)
    let nextToStart = 0
    let committed = 0
    let started = 0
    let aborted: boolean = signal.aborted
    let concluded = false
    let schedulerFailure: { error: unknown } | undefined
    const throwSchedulerFailure = (): void => {
      if (schedulerFailure !== undefined) throw schedulerFailure.error
    }

    // `committed` advances only across contiguous model-order slots.
    const commitReady = async (): Promise<void> => {
      while (committed < group.length) {
        const slot = slots[committed]
        if (slot === undefined) break
        const call = group[committed]!
        const result = slot.needsPost
          ? await scheduler.finalize(slot.exec, slot.result)
          : scheduler.finish(slot.exec, slot.result)
        this.appendToolResult(turn, step, call.block, result, callSeqs[committed]!)
        for (const context of result.additionalContexts ?? []) {
          this.ledger.inbox.append('next-step', context)
        }
        concluded ||= result.concludesTurn === true
        committed += 1
      }
    }

    const inFlight = new Map<number, Promise<number>>()

    const startCall = async (index: number): Promise<void> => {
      const call = group[index]!
      callSeqs[index] = this.appendToolCall(turn, step, call.block)
      started += 1
      const prepared = await scheduler.prepare(call.exec)
      throwSchedulerFailure()
      switch (prepared.kind) {
        case 'dispatch': {
          const promise = scheduler.dispatch(prepared.exec).then(
            (outcome) => {
              slots[index] = { exec: prepared.exec, result: outcome.result, needsPost: outcome.kind === 'post-result' }
              return index
            },
            (error: unknown) => {
              schedulerFailure ??= { error }
              return index
            },
          )
          inFlight.set(index, promise)
          break
        }
        case 'post-result':
          slots[index] = { exec: prepared.exec, result: prepared.result, needsPost: true }
          break
        case 'final-result':
          slots[index] = { exec: prepared.exec, result: prepared.result, needsPost: false }
          break
      }
    }

    const fillPool = async (): Promise<void> => {
      while (!aborted && nextToStart < group.length && inFlight.size < this.maxParallelToolCalls) {
        // Re-read later modes after ordered commits so registry changes can create a barrier.
        const nextCall = group[nextToStart]!
        if (nextToStart > 0 && mode === 'parallel'
          && this.loopCtx.tools.executionMode(nextCall.exec).kind !== 'parallel') break
        await startCall(nextToStart)
        nextToStart += 1
        throwSchedulerFailure()
        await commitReady()
        throwSchedulerFailure()
        // Abort may arrive while pre-execute awaits.
        if (signal.aborted) aborted = true
      }
    }

    // Ordered pre-execute may await; only dispatch/body overlaps. A scheduler
    // failure stops new dispatches, drains started ones, and rejects with the
    // first failure without fabricating tool results.
    try {
      await fillPool()
      while (inFlight.size > 0) {
        const settledIndex = await Promise.race(inFlight.values())
        inFlight.delete(settledIndex)
        throwSchedulerFailure()
        await commitReady()
        throwSchedulerFailure()
        // Abort may arrive while a tool or ordered commit awaits.
        if (signal.aborted) aborted = true
        await fillPool()
      }
    } catch (error: unknown) {
      schedulerFailure ??= { error }
      await Promise.allSettled(inFlight.values())
      throw schedulerFailure.error
    }

    if (aborted) {
      // Started calls and accepted context settle first; every remaining model
      // call then receives an ordered synthetic result before the turn aborts.
      for (const call of group.slice(started)) this.appendSkippedToolCall(turn, step, call.block)
      return { consumed: group.length, aborted: true, concluded }
    }
    if (committed !== started) throw new Error('tool-call scheduler: uncommitted settled calls')
    return { consumed: started, aborted: false, concluded }
  }

  /** Append a started call and return its provenance sequence. */
  private appendToolCall(turn: number, step: number, block: ToolCallBlock): number {
    const event = this.session.append('tool/call', {
      turn, step, callId: block.id, name: block.name, arguments: block.arguments,
    })
    return event.seq
  }

  /** Append a model-ordered result linked to its call event. */
  private appendToolResult(
    turn: number,
    step: number,
    block: ToolCallBlock,
    result: ToolExecutionResult,
    callSeq: number,
  ): void {
    const message = createToolResultMessage({
      callId: block.id,
      content: result.content,
      isError: result.isError,
    })
    this.session.append('tool/result', {
      turn, step,
      message,
      ...result.error?.info ? { error: result.error.info } : {},
      // The tool's private presentation payload, persisted for replay.
      ...result.meta !== undefined ? { meta: result.meta } : {},
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
  }

  /** Append the durable call/result pair for a model call skipped after cancellation. */
  private appendSkippedToolCall(turn: number, step: number, block: ToolCallBlock): void {
    const callSeq = this.appendToolCall(turn, step, block)
    const message = createToolResultMessage({
      callId: block.id,
      content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
      isError: true,
    })
    this.session.append('tool/result', {
      turn, step,
      message,
      error: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
  }
}

/** Parse model arguments, preserving invalid JSON as text and mapping empty input to `{}`. */
function parseArguments(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return raw
  }
}

function blockText(message: UserMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('\n')
}
