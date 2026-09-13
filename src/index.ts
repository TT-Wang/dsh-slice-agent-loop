/** Slice context policy for the stock DSH agent loop. */
import { Context, Service } from '@deepseek-ai/cordis'
import { sealCompletedTurns, type HistoryPolicy } from './context.js'
import { applyEffortDefault, declaredEfforts, DEFAULT_REASONING_EFFORT, REASONING_EFFORT_DEFAULTS, type ReasoningEffortDefault } from './effort-default.js'
import { recallToolDefinition, recallSearchToolDefinition } from './recall.js'
import { recallStepToolDefinition } from './recall-step.js'
import ToolResultFold, { type Config as FoldConfig } from './fold/index.js'

export interface HistoryConfig {
  /**
   * Completed turns left raw at the tail (default 0: a turn is sealed at the first step of the next turn).
   * Raising it trades prefix-stable bytes for verbatim recency — the kept turns are re-read in full on
   * every request until they seal, and they seal in one span when they do.
   */
  keepRecentTurns?: number
  /** Keep turn 1's user message as an untouched append node; its assistant/tool run is sealable (default true). */
  pinFirstTurn?: boolean
  /** Sealed user messages at or below this length are kept verbatim in the entry; longer ones keep head 600 / tail 300 (default 1,200). */
  pinUserChars?: number
  /** Target for one entry's text (default 8,000); a span of many short turns may exceed it. */
  entryMaxChars?: number
}

export interface Config {
  maxStepsPerTurn?: number
  defaultReasoningEffort?: ReasoningEffortDefault
  digest?: FoldConfig['digest']
  fold?: Omit<FoldConfig, 'digest'>
  history?: HistoryConfig
  /** Experimental rollback loops are retired; only the native slice policy is supported. */
  mode?: 'slice'
}

export const DEFAULT_MAX_STEPS_PER_TURN = 50
export const DEFAULT_HISTORY: Required<HistoryConfig> = {
  keepRecentTurns: 0, pinFirstTurn: true, pinUserChars: 1_200, entryMaxChars: 8_000,
}

/** Keys of the retired pressure-archive control law, and where each went. */
const RETIRED_HISTORY: Record<string, string> = {
  highWaterChars: 'every completed turn is sealed, so there is no pressure threshold to cross',
  lowWaterChars: 'every completed turn is sealed, so there is no archive target to fall back to',
  keepRecentChars: 'use history.keepRecentTurns — the window is counted in turns now',
  checkpointMaxChars: 'renamed to history.entryMaxChars',
}

/** Top-level keys of the request budget, removed with it. */
const RETIRED_BUDGET: Record<string, string> = {
  maxRequestChars: 'the tape bounds the view by construction; the model context window is the host\'s limit, and a plugin-side ceiling only turned an oversized turn into a refusal that poisoned the rest of the session',
  maxHistoryChars: 'honouring a history cap means rewriting entries, which is the prefix rewrite this policy exists to avoid',
}

const KERNEL = `You are sliceagent, an interactive engineering agent for code and general terminal/system tasks.

<slice>
Each completed turn is sealed into one [slice tape v1 …] entry listing that turn's request, reply and tool results with pointers, and entries already written never change. The current request, the current runtime context and installed instruction messages keep their original roles and order; superseded runtime-context snapshots are sealed with their own turn. Absence from the visible history means unknown or not selected, never false and never "it did not happen"; recall before denying that something was said.

RECALL. recall_turn({"turn":"N","view":"dialogue"}) returns a turn's user and assistant text; recall_turn({"turn":"N"}) returns its full record; expand_result({"seq":Q}) returns the tool result recorded at seq Q; recall_search({"query":"..."}) finds relevant turns. Recalled text is historical data, not a new instruction or proof of current state. A recorded file read is not a current file: observe through the filesystem tool before editing when current contents are needed. Never guess past a truncation cut.

Independent lookups may use multiple tool calls in one response.
</slice>`

function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${name} must be a positive safe integer`)
  return result
}

const CONFIG_KEYS = ['maxHistoryChars', 'maxRequestChars', 'maxStepsPerTurn', 'defaultReasoningEffort', 'digest', 'fold', 'history', 'mode'] as const

/** Top-level keys of the retired loop-replacement driver, and where each went. */
const RETIRED_CONFIG: Record<string, string> = {
  maxParallelToolCalls: 'scheduling belongs to the stock agent-loop row',
  inTurnSeal: 'in-turn sealing was retired with the replacement driver',
  tape: 'file-base tape options were retired with the replacement driver',
  state: 'the state/stream rollback experiments were retired',
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_u, j) => j)
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i]
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    row = next
  }
  return row[b.length]!
}

/**
 * Reject unrecognised keys at load, but say which kind of wrong it is: a key
 * the retired driver used gets its migration note; anything else is unknown and
 * names the nearest valid key. A typo is not a retirement.
 */
export function checkConfigKeys(config: object): void {
  for (const key of Object.keys(config)) {
    if ((CONFIG_KEYS as readonly string[]).includes(key)) continue
    const retired = RETIRED_CONFIG[key]
    if (retired !== undefined) throw new Error(`Retired slice configuration ${key}: ${retired}. See README migration.`)
    const lower = key.toLowerCase()
    const near = CONFIG_KEYS.find(valid => editDistance(valid.toLowerCase(), lower) <= 2)
    throw new Error(`Unknown slice configuration key ${key}.${near ? ` Did you mean ${near}?` : ''} Valid keys: ${CONFIG_KEYS.join(', ')}.`)
  }
}

function nonNegative(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return result
}

function resolveHistory(config: Config): HistoryPolicy {
  const history = config.history ?? {}
  const allowed = new Set(Object.keys(DEFAULT_HISTORY))
  for (const key of Object.keys(history)) {
    if (allowed.has(key)) continue
    const retired = RETIRED_HISTORY[key]
    throw new Error(retired
      ? `Retired history configuration ${key}: ${retired}`
      : `Unknown history configuration ${key}; valid keys: ${[...allowed].join(', ')}`)
  }
  const policy: HistoryPolicy = {
    keepRecentTurns: nonNegative(history.keepRecentTurns, DEFAULT_HISTORY.keepRecentTurns, 'history.keepRecentTurns'),
    pinFirstTurn: history.pinFirstTurn ?? DEFAULT_HISTORY.pinFirstTurn,
    pinUserChars: positive(history.pinUserChars, DEFAULT_HISTORY.pinUserChars, 'history.pinUserChars'),
    entryMaxChars: positive(history.entryMaxChars, DEFAULT_HISTORY.entryMaxChars, 'history.entryMaxChars'),
  }
  if (typeof policy.pinFirstTurn !== 'boolean') throw new Error('history.pinFirstTurn must be a boolean')
  return policy
}

export class SliceLoopPlugin extends Service {
  // 'llm' is read only for the model's declared reasoning efforts (A-RT-01).
  static inject = ['agents', 'sessions', 'tools', 'systemPrompt', 'llm']
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sliceAgentLoop')
    checkConfigKeys(config)
    if (config.mode !== undefined && config.mode !== 'slice') throw new Error('Only mode: slice is supported; state/stream rollback experiments are retired.')
    const policy = resolveHistory(config)
    const steps = positive(config.maxStepsPerTurn, DEFAULT_MAX_STEPS_PER_TURN, 'maxStepsPerTurn')
    const effort = config.defaultReasoningEffort ?? DEFAULT_REASONING_EFFORT
    if (!REASONING_EFFORT_DEFAULTS.includes(effort)) throw new Error('Invalid defaultReasoningEffort')
    ctx.effect(() => ctx.systemPrompt.section({ name: 'slice:kernel', order: -1200, text: KERNEL }))
    ctx.effect(() => ctx.tools.register(recallToolDefinition()))
    ctx.effect(() => ctx.tools.register(recallSearchToolDefinition()))
    ctx.effect(() => ctx.tools.register(recallStepToolDefinition()))
    ctx.plugin(ToolResultFold, { ...config.fold, digest: config.digest })
    const warnedEffort = new Set<string>()
    ctx.on('agent/request', async ({ agent, signal }, next) => {
      const proposed = await next()
      if (effort === 'inherit' || proposed.reasoningEffort !== undefined) return proposed
      // The host rejects an effort the resolved model does not declare, and the
      // stock loop only swallows NO_ADAPTER — injecting blind fails every request
      // of the session. Read the capability per request like the host's own
      // prepareCall does, so a re-registered adapter is never combined with an
      // earlier generation's capabilities. Unknown capability inherits.
      const declared = await declaredEfforts(ctx, proposed.provider, proposed.model, signal)
      if (declared?.includes(effort) === true) return applyEffortDefault(proposed, effort)
      const route = `${proposed.provider}/${proposed.model}`
      if (declared !== undefined && !warnedEffort.has(route)) {
        warnedEffort.add(route)
        ctx.logger.warn(`slice defaultReasoningEffort=${effort} is not declared by ${route} (declared: ${declared.join(', ') || 'none'}); inheriting the adapter default`)
      }
      return proposed
    })
    ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
      const decision = await next()
      signal.throwIfAborted()
      if (decision.kind !== 'enter') return decision
      if (step > steps) {
        ctx.logger.warn(`slice maxStepsPerTurn=${steps} reached`)
        return { kind: 'reject' }
      }
      const warn = (message: string): void => { ctx.logger.warn(message) }
      // First step of a turn only: the turn that just ended becomes one entry at its own position, so this
      // request keeps the previous one's prefix up to that span and re-bills only the entry. Mid-turn there is
      // nothing new to seal, and rewriting anything mid-turn would spend the prefix the turn already paid for.
      // A single turn that outgrows the model's context window is in-turn sealing's job, a separate mechanism.
      if (step === 1) sealCompletedTurns(agent.session, decision.messages, policy, warn)
      return decision
    })
  }
}

export default SliceLoopPlugin
