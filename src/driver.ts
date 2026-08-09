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
 * idle edge, the active abort signal reaches every model request, and model
 * tool calls execute through the dsh-tools scheduler with durable
 * tool/call + tool/result pairing before a continuation step.
 *
 * Plan gates honored here: wake-after-abort reroute is owned by the inbox
 * ledger; status flips only on real transitions; a rejected step's claimed
 * batch is gone (never re-queued); cancel is first-cause-wins and never arms
 * future work when idle; agent/request-error fires BEFORE any retry.
 */

import type { Context } from 'cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
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
  EpochHeader,
  RequestContext,
  Session,
  SessionId,
  TurnEndReason,
} from '@deepseek-ai/dsh-session'
import {
  TOOL_ABORTED_BEFORE_DISPATCH,
  TOOL_REGISTRY_SCHEDULER,
  type ToolExecutionInput,
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

export class SliceLoopAgent implements Agent {
  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: Session
  readonly ctx: Context
  readonly scope: Scope

  private readonly loopCtx: Context
  private readonly dispatch: AgentEventDispatch
  private readonly ledger: InboxLedger
  private phase: Phase = { kind: 'idle', lastTurn: 0 }
  private activityDone: Promise<void> = Promise.resolve()
  private requestHeaderLogged = false
  private sliceSpec: Record<string, unknown> = { s: { task: {} } }

  constructor(
    loopCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
  ) {
    this.loopCtx = loopCtx
    this.id = id
    this.options = options
    this.session = session
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.dispatch = agentEvents(this.ctx, this)
    this.ledger = new InboxLedger(session, this.dispatch, {
      signal: () => (this.phase.kind === 'idle' ? undefined : this.phase.abort.signal),
      wake: () => this.wakeDriver(),
    })
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
    const driverPromise = new Promise<void>((resolve, reject) => {
      resolveDriver = resolve
      rejectDriver = reject
    })
    this.activityDone = driverPromise
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

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const phase = this.phase
    if (phase.kind !== 'idle') {
      throw new Error(`agent "${this.id}" is not idle (phase=${phase.kind})`)
    }
    const abort = new AbortController()
    const maintenance: Phase = { kind: 'maintenance', abort, lastTurn: phase.lastTurn, wakeRequested: false }
    this.phase = maintenance
    const done = (async (): Promise<T> => {
      try {
        return await task(abort.signal)
      } finally {
        if (this.phase === maintenance) {
          this.phase = { kind: 'idle', lastTurn: maintenance.lastTurn }
          if (maintenance.wakeRequested) this.wakeDriver()
        }
      }
    })()
    this.activityDone = done.then(() => undefined)
    return done
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

  /** Claim the boundary's batch and run the pre-step waterfall before any durable step opens. */
  private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreStepDecision> {
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    const claimed = target === 'next-turn'
      ? this.ledger.claimFirstStep(position.turn)
      : this.ledger.claimNextStep(position.turn)
    const decision: PreStepDecision = await this.dispatch.waterfall(
      'agent/pre-step',
      { messages: claimed, ...position, signal },
      async () => ({ kind: 'enter', messages: claimed }) as PreStepDecision,
    )
    signal.throwIfAborted()
    return decision
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
          const stepEnd = await this.step(decision.messages)
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
  private async step(claimed: UserMessage[]): Promise<StepEndReason | null> {
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()

    // Assemble the bounded slice for this step — the engine owns what the model sees.
    const requestText = claimed.map((m) => blockText(m)).join('\n')
    this.sliceSpec = {
      ...this.sliceSpec,
      s: { ...(this.sliceSpec.s as Record<string, unknown>),
           task: { goal: requestText, goal_source: 'conversation' } },
    }
    const assembled: AssembledSlice = assembleSlice(
      normalizeCtx(this.sliceSpec, (text) => text),
      { systemPrefix: '', request: requestText },
    )

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
      this.logRequestHeader(config, this.requestHeaderLogged ? 'change' : 'initial')

      // Tool continuations replay the derived history so the provider sees the
      // exact tool-call/tool-result pairing; input steps send the bounded slice.
      const messages: Message[] = claimed.length === 0
        ? this.session.deriveMessages()
        : [createUserMessage({
            content: [{ type: 'text', text: assembled.userString }],
            source: { kind: 'user' },
          })]
      const request = markAgentLoopRequest(deepFreeze({
        ...config,
        messages,
        ...(assembled.systemPrefix ? { system: assembled.systemPrefix } : {}),
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

  /**
   * Execute one step's tool calls through the dsh-tools scheduler, in model
   * order. Deliberately sequential: the stock driver's bounded parallel pool
   * (maxParallelToolCalls) is collapsed to one-at-a-time dispatch, preserving
   * the contract-visible behavior — ordered tool/call + tool/result pairing
   * with provenance, abort recording synthetic results for unstarted calls,
   * additionalContexts staged into the next-step inbox, and concludesTurn.
   */
  private async executeToolCalls(
    turn: number,
    step: number,
    toolCalls: ToolCallBlock[],
    signal: AbortSignal,
  ): Promise<{ concluded: boolean }> {
    let concluded = false
    let started = 0
    for (const block of toolCalls) {
      if (signal.aborted) break
      started += 1
      const callSeq = this.session.append('tool/call', {
        turn, step, callId: block.id, name: block.name, arguments: block.arguments,
      }).seq
      const exec: ToolExecutionInput = {
        callId: block.id,
        name: block.name,
        arguments: parseArguments(block.arguments),
        agent: this,
        signal,
      }
      const scheduler = this.loopCtx.tools[TOOL_REGISTRY_SCHEDULER]
      const prepared = await scheduler.prepare(exec)
      let slot: { exec: ToolRunContext; result: ToolExecutionResult; needsPost: boolean }
      if (prepared.kind === 'dispatch') {
        const outcome = await scheduler.dispatch(prepared.exec)
        slot = { exec: prepared.exec, result: outcome.result, needsPost: outcome.kind === 'post-result' }
      } else {
        slot = { exec: prepared.exec, result: prepared.result, needsPost: prepared.kind === 'post-result' }
      }
      const result = slot.needsPost
        ? await scheduler.finalize(slot.exec, slot.result)
        : scheduler.finish(slot.exec, slot.result)
      const message = createToolResultMessage({
        callId: block.id,
        content: result.content,
        isError: result.isError,
      })
      this.session.append('tool/result', {
        turn, step, message,
        ...(result.error?.info ? { error: result.error.info } : {}),
        ...(result.meta !== undefined ? { meta: result.meta } : {}),
      }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
      for (const context of result.additionalContexts ?? []) {
        this.ledger.inbox.append('next-step', context)
      }
      concluded ||= result.concludesTurn === true
    }
    // Abort records synthetic error results for skipped calls so replay stays valid.
    for (const block of toolCalls.slice(started)) {
      const callSeq = this.session.append('tool/call', {
        turn, step, callId: block.id, name: block.name, arguments: block.arguments,
      }).seq
      const message = createToolResultMessage({
        callId: block.id,
        content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
        isError: true,
      })
      this.session.append('tool/result', {
        turn, step, message,
        error: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
      }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    }
    return { concluded }
  }

  private logRequestHeader(config: LlmCallConfig, reason: 'initial' | 'change'): void {
    const header: EpochHeader = { config }
    this.session.append('request/header', { header, reason })
    this.session.append('request/context', {
      provider: config.provider!,
      model: config.model!,
    } as RequestContext)
    this.requestHeaderLogged = true
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
