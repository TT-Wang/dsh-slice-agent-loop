/**
 * SliceLoopAgent — the SliceAgent concrete agent driver for the DeepSeek Harness.
 *
 * The dsh `Agent` contract over the ported bounded-slice engine: claim input at
 * turn/step boundaries, assemble the bounded context via src/slice, stream one
 * model request through dsh-llm, and append the durable session events the
 * contract requires. Plan v2.1 phases 2–4 (driver core).
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
  PreStepDecision,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import type {
  GenerateOptions,
  LlmCallConfig,
  Message,
  PreparedLlmCall,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import { LlmError, createAssistantMessage, createUserMessage, deepFreeze, errorChain, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type {
  EpochHeader,
  RequestContext,
  Session,
  SessionId,
  TurnEndReason,
} from '@deepseek-ai/dsh-session'
import { InboxLedger, type InboxLedgerActivity } from './inbox-ledger.js'
import { assembleSlice, type AssembledSlice, type SliceCtx } from './slice/index.js'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number; wakeRequested: boolean }
  | { kind: 'running'; abort: AbortController; turn: number; step: number }

export interface DriverScope {
  ctx: Context
  dispose(): Promise<void> | void
}

/** Tool-call seam: routes model tool requests through dsh-tools (later phase). */
export interface ToolCallHandler {
  execute(calls: readonly unknown[], signal: AbortSignal): Promise<void>
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
  private readonly toolHandler?: ToolCallHandler
  private phase: Phase = { kind: 'idle', lastTurn: 0 }
  private activityDone: Promise<void> | undefined
  private requestHeaderLogged: EpochHeader | undefined
  private sliceState: Record<string, unknown> = {}

  constructor(
    loopCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    toolHandler?: ToolCallHandler,
  ) {
    this.loopCtx = loopCtx
    this.id = id
    this.options = options
    this.session = session
    this.toolHandler = toolHandler
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

  /** Called by the ledger when waking input arrives. */
  wakeDriver(): void {
    const phase = this.phase
    if (phase.kind === 'maintenance') {
      phase.wakeRequested = true
      return
    }
    if (phase.kind !== 'idle') return
    const abort = new AbortController()
    this.setPhase({ kind: 'running', abort, turn: phase.lastTurn + 1, step: 0 })
    const running = this.phase as Extract<Phase, { kind: 'running' }>
    const work = this.runPhase(running)
    this.activityDone = work
    void this.loopCtx.agents.withInitiator(this, () => work)
  }

  // ---------------------------------------------------------------- control

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) this.ledger.clear()
    const phase = this.phase
    if (phase.kind === 'idle') return // no-op; does not arm future work
    phase.abort.abort(cause)
  }

  whenIdle(): Promise<void> {
    return this.activityDone ?? Promise.resolve()
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

  private async runPhase(running: Extract<Phase, { kind: 'running' }>): Promise<void> {
    try {
      while (this.inbox.hasPending && !running.abort.signal.aborted) {
        await this.runTurn(running)
      }
    } finally {
      this.setPhase({ kind: 'idle', lastTurn: running.turn })
    }
  }

  private async runTurn(running: Extract<Phase, { kind: 'running' }>): Promise<void> {
    const turn = running.turn
    running.step = 0
    this.session.append('turn/start', { turn })
    let endReason: TurnEndReason = { kind: 'completed' }
    try {
      let messages = this.ledger.claimFirstStep(turn)
      let firstStep = true
      let continueLoop = this.inbox.hasPending || messages.length > 0
      while (continueLoop) {
        const outcome = await this.runStep(running, turn, messages)
        firstStep = false
        if (outcome === 'aborted') {
          endReason = { kind: 'aborted', reason: running.abort.signal.reason as AgentCancelCause }
          break
        }
        if (outcome === 'max-tokens') {
          endReason = { kind: 'max-tokens' } // sticky; keep stepping while pending
        }
        if (outcome === 'stop') break
        // turn-stopping: serial seam — a listener objects by steering new input
        await this.dispatch.serial('agent/turn-stopping', { turn, signal: running.abort.signal })
        if (!this.inbox.hasPending) break
        running.turn += 1
        running.step = 0
        this.session.append('turn/start', { turn: running.turn })
        messages = this.ledger.claimFirstStep(running.turn)
        continueLoop = true
        void firstStep
      }
    } catch (error) {
      this.dispatch.emit('agent/error', { turn, step: running.step, error: errorChain(error) })
      const failure = error instanceof LlmError
        ? error.failure
        : { message: String(error), code: 'UNKNOWN' }
      endReason = { kind: 'error', failure } as unknown as TurnEndReason
    }
    this.session.append('turn/end', { turn: running.turn, reason: endReason })
  }

  /** Returns 'stop' when the turn should close, 'aborted', 'max-tokens', or 'continue'. */
  private async runStep(
    running: Extract<Phase, { kind: 'running' }>,
    turn: number,
    claimed: UserMessage[],
  ): Promise<'stop' | 'aborted' | 'max-tokens' | 'continue'> {
    running.step += 1
    const step = running.step
    this.session.append('step/start', { turn, step })

    const decision: PreStepDecision = await this.dispatch.waterfall(
      'agent/pre-step',
      { messages: claimed, turn, step, signal: running.abort.signal },
      async () => ({ kind: 'enter', messages: claimed }) as PreStepDecision,
    )
    if (decision.kind === 'reject') {
      this.session.append('step/end', { turn, step })
      return 'stop' // the claimed batch is gone — never re-queued (contract)
    }

    // assemble the bounded slice for this step
    const requestText = decision.messages.map((m) => blockText(m)).join('\n')
    this.sliceState = { ...this.sliceState, task: requestText }
    const assembled: AssembledSlice = assembleSlice(this.sliceState as unknown as SliceCtx, {
      systemPrefix: '',
      request: requestText,
    })

    const proposal = {
      ...(this.options.provider !== undefined ? { provider: this.options.provider } : {}),
      ...(this.options.model !== undefined ? { model: this.options.model } : {}),
      ...(this.options.maxTokens !== undefined ? { maxTokens: this.options.maxTokens } : {}),
    } as LlmCallConfig
    const config: LlmCallConfig = await this.dispatch.waterfall(
      'agent/request',
      { turn, step, signal: running.abort.signal },
      async () => proposal,
    )
    if (!config.provider || !config.model) {
      throw new LlmError(`agent "${this.id}" has no provider/model route`, 'NO_ROUTE')
    }

    this.logRequestHeader(config, this.requestHeaderLogged === undefined ? 'initial' : 'change')

    const result = await this.executeModelCall(running, turn, step, assembled, config)
    this.session.append('step/end', { turn, step })
    return result
  }

  private logRequestHeader(config: LlmCallConfig, reason: 'initial' | 'resume' | 'change'): void {
    const header: EpochHeader = { config }
    this.session.append('request/header', { header, reason })
    this.session.append('request/context', {
      provider: config.provider!,
      model: config.model!,
    } as RequestContext)
    this.requestHeaderLogged = header
  }

  private async executeModelCall(
    running: Extract<Phase, { kind: 'running' }>,
    turn: number,
    step: number,
    assembled: AssembledSlice,
    config: LlmCallConfig,
  ): Promise<'aborted' | 'max-tokens' | 'continue'> {
    const prepared: PreparedLlmCall = await this.loopCtx.llm.prepareCall(config, running.abort.signal)
    const options: GenerateOptions = deepFreeze(
      markAgentLoopRequest({
        provider: config.provider,
        model: config.model,
        system: assembled.systemPrefix || undefined,
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: assembled.userString }],
            source: { kind: 'user' },
          }),
        ],
        ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
        ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
      }) as GenerateOptions,
    )
    const chunkSeqs: number[] = []
    let text = ''
    let sawMaxTokens = false
    try {
      for await (const chunk of prepared.stream(options)) {
        chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunk.type === 'finish' && chunk.reason.kind === 'max-tokens') sawMaxTokens = true
      }
    } catch (error) {
      // agent/request-error waterfall BEFORE any retry decision (contract)
      const failure = error instanceof LlmError
        ? error.failure
        : { message: String(error), code: 'UNKNOWN' }
      const action: RequestErrorAction = await this.dispatch.waterfall(
        'agent/request-error',
        { turn, step, provider: config.provider!, failure, retryPolicy: prepared.retryPolicy, signal: running.abort.signal },
        async () => undefined as RequestErrorAction,
      )
      if (action?.kind === 'retry') {
        return this.executeModelCall(running, turn, step, assembled, config)
      }
      if (running.abort.signal.aborted) return 'aborted'
      throw error
    }
    const assistant = createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: config.provider, model: config.model },
    })
    this.session.append(
      'assistant/message',
      { turn, step, message: assistant },
      { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
    )

    const toolCalls = (assistant as unknown as { toolCalls?: unknown[] }).toolCalls
    if (this.toolHandler && toolCalls?.length) {
      await this.toolHandler.execute(toolCalls, running.abort.signal)
    }
    return sawMaxTokens ? 'max-tokens' : 'continue'
  }
}

function blockText(message: UserMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('\n')
}
