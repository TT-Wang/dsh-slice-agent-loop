/**
 * dsh-slice-agent-loop — the SliceAgent concrete agent loop plugin.
 *
 * Registers the SliceAgentLifecycle factory into ctx.agents (single
 * registration enforced by the interface: loading beside the stock AgentLoop
 * factory fails loudly, never an order-dependent pick — plan v2.1 phase 0).
 *
 * The plugin owns its scheduler configuration: maxParallelToolCalls is
 * validated at construction and handed to every driver instance, replacing
 * the stock loop's `ctx.agentLoop.config` lookup.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { RESOLVED_SYSTEM_PROMPT } from './system-prompt.js'
import { SliceAgentLifecycle, type LifecycleAgent } from './lifecycle.js'
import { SliceLoopAgent } from './driver.js'
import { recallSearchToolDefinition, recallToolDefinition } from './recall.js'

export interface Config {
  maxParallelToolCalls?: number
  maxStepsPerTurn?: number
}

/** Default maximum in-flight parallel-safe tool calls per agent step. */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10

/**
 * Default hard ceiling on continuation steps within one turn.
 *
 * This is a BOUND, not a diagnosis. An earlier proposal paired it with stall
 * detection ("a continuation step with no assistant text and no new file
 * anchor is a stalled step; warn at 4, terminate at 8"). Replayed against a
 * real 19-turn session that predicate would have cut 45 of 143 steps — 31% —
 * including 24 steps off a turn that did 74 distinct tool calls of real work,
 * and it fired a warning on ordinary 5-step turns. The reason is that for a
 * reasoning model "no visible text plus tool calls" is the NORMAL shape of
 * investigation: narration goes into reasoning blocks and visible text only
 * appears at the close. A productive 49-step turn and a futile 20-step turn
 * were indistinguishable on that axis, and on repetition too (both 0%).
 *
 * So: no heuristic that pretends to know whether the model is making
 * progress. Just a ceiling. 50 clears every legitimate turn observed in that
 * session (longest was 49) while still bounding the trajectory.
 */
export const DEFAULT_MAX_STEPS_PER_TURN = 50

function resolveMaxParallelToolCalls(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error('maxParallelToolCalls must be a positive integer')
  }
  return resolved
}

function resolveMaxStepsPerTurn(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_STEPS_PER_TURN
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error('maxStepsPerTurn must be a positive integer')
  }
  return resolved
}

/**
 * The plugin's durable event types. 20260811 closed the session event
 * vocabulary: the persistence read path REFUSES to interpret a log containing
 * a type outside `KNOWN_SESSION_EVENT_TYPES` (SessionFormatUnsupportedError at
 * prepare/load/inspect/readFrom — reproduced end to end against a real
 * PersistenceCoordinator on the jsonl backend). Writes are deliberately
 * unguarded, so without this registration every session this loop writes
 * poisons its own resume: it works live, then refuses to load.
 *
 * The vocabulary file's own doc defers "a registration surface for downstream
 * plugin events ... until such a consumer exists". This plugin is that
 * consumer; until the surface exists, the exported set is a live (unfrozen)
 * Set and adding our three types at load is the honest interim: while this
 * plugin is mounted, the harness DOES understand them — restoreContinuity
 * replays slice/file-anchor to rebuild the tape. The effect reverts on
 * unload, restoring the stock refusal for a harness that genuinely cannot
 * interpret these logs.
 */
const SLICE_EVENT_TYPES = ['slice/file-anchor', 'slice/request-slice', 'slice/step-budget'] as const

function registerSliceEventTypes(ctx: Context): void {
  const vocabulary = KNOWN_SESSION_EVENT_TYPES as Set<string>
  if (typeof vocabulary.add !== 'function' || typeof vocabulary.delete !== 'function') {
    // A future harness freezing the set must fail HERE, loudly, at load —
    // not at the next resume with a poisoned log.
    throw new Error(
      'dsh-slice-agent-loop cannot register its slice/* session event types: '
      + 'KNOWN_SESSION_EVENT_TYPES is no longer a mutable Set. Without registration, sessions '
      + 'written by this loop fail to resume (SessionFormatUnsupportedError). '
      + 'Update the plugin to the harness\'s event-type registration surface.',
    )
  }
  ctx.effect(() => {
    const added = SLICE_EVENT_TYPES.filter((type) => !vocabulary.has(type))
    for (const type of added) vocabulary.add(type)
    return () => { for (const type of added) vocabulary.delete(type) }
  }, 'sliceLoop.knownEventTypes()')
}

/** The invariant-registry name the stock loop's companion check reserves. */
const STOCK_LOOP_INVARIANT = '@deepseek-ai/dsh-agent-loop'

const INCOMPATIBLE_INVARIANT_MESSAGE = [
  'dsh-slice-agent-loop is incompatible with the @deepseek-ai/dsh-agent-loop/invariant companion.',
  '',
  'That invariant asserts the model request equals session.deriveMessages() byte for byte.',
  'This loop deliberately sends a REBUILT bounded slice instead of the full derived history —',
  'that is what "bounded context per turn" means, so the assertion can never hold. Leaving the',
  'companion mounted makes every model request fail inside llm/stream, and the error is attributed',
  'to a package you have already replaced.',
  '',
  'Fix: remove (or disable) the `agent-loop-invariant` row in your cordis configuration.',
  'Compositions commonly carry it as a row SEPARATE from `agent-loop`, so swapping the loop',
  'row does not remove the companion with it.',
].join('\n')

/**
 * Fail at load time when the stock loop's reconstructability invariant is
 * mounted, instead of letting every turn die inside `llm/stream`.
 *
 * The registry rejects a duplicate package name synchronously, so registering a
 * no-op under the stock name does double duty: it detects a companion that
 * loaded first (we catch and explain), and it reserves the slot so a companion
 * loading later fails at boot too. Either order surfaces as one startup error
 * rather than a per-request one.
 *
 * `invariants` is intentionally NOT in `static inject` — a deployment without
 * the service is perfectly valid, and injecting it would suspend this fiber
 * forever instead.
 */
function guardStockLoopInvariant(ctx: Context): void {
  const invariants = ctx.get('invariants')
  if (invariants === undefined) return
  try {
    ctx.effect(
      () => invariants.register(STOCK_LOOP_INVARIANT, () => { /* this loop asserts no such property */ }),
      'sliceLoop.reserveStockLoopInvariant()',
    )
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('already registered')) {
      throw new Error(INCOMPATIBLE_INVARIANT_MESSAGE, { cause: error })
    }
    throw error
  }
}

export class SliceLoopPlugin extends Service {
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sliceAgentLoop')
    const maxParallelToolCalls = resolveMaxParallelToolCalls(config.maxParallelToolCalls)
    const maxStepsPerTurn = resolveMaxStepsPerTurn(config.maxStepsPerTurn)
    guardStockLoopInvariant(ctx)
    registerSliceEventTypes(ctx)
    // The byte-stable sliceagent kernel rides the prompt REGISTRY as an
    // ordinary section (order -1000: first), not a driver-side prepend. Same
    // bytes in the ordinary case — renderPrompt joins sections with '\n\n',
    // exactly what the old `RESOLVED + '\n\n' + scoped` produced — but now a
    // host section declaring `complete: true` (new in 20260811) genuinely
    // becomes the SOLE prompt: assembly restores it alone, and this kernel
    // correctly disappears with every other contribution. A driver-side
    // prepend silently voided that host guarantee.
    ctx.effect(
      () => ctx.systemPrompt.section({ name: 'slice:kernel', order: -1000, text: RESOLVED_SYSTEM_PROMPT }),
      'sliceLoop.kernelSection()',
    )
    // Memory recall (src/recall.ts): the tape truncates sealed replies, and
    // this is the way back. Registered once — the scheduler stamps exec.agent
    // on every call, so the handler reads the CALLING agent's session log and
    // cannot cross sessions. ctx.effect makes the registration revertible with
    // the plugin, per cordis discipline.
    ctx.effect(() => ctx.tools.register(recallToolDefinition()), 'sliceLoop.recallTurn()')
    // Tier 1 of two-tier recall: scored search over the same durable log,
    // hits name recall_turn follow-ups. Ordinary tool output excluded by
    // default (flood guard) — see DEFAULT_SEARCH_KINDS in src/recall.ts.
    ctx.effect(() => ctx.tools.register(recallSearchToolDefinition()), 'sliceLoop.recallSearch()')
    // 提示词变量所有权（架构文档：the loop supplies provider/model/cwd）——
    // stock agent-loop/index.ts:312-314 同构；缺了 persona 节的 {{cwd}} 解析不了。
    ctx.systemPrompt.variable('provider', (context) => context.agent?.options.provider)
    ctx.systemPrompt.variable('model', (context) => context.agent?.options.model)
    ctx.systemPrompt.variable('cwd', (context) => context.agent?.session.header.cwd)
    const lifecycle = new SliceAgentLifecycle(
      ctx,
      (loopCtx: Context, id: SessionId, options: AgentOptions, session: Session): LifecycleAgent =>
        new SliceLoopAgent(loopCtx, id, options, session, { maxParallelToolCalls, maxStepsPerTurn }),
    )
    ctx.effect(() => ctx.agents.setFactory(lifecycle), 'sliceLoop.setFactory()')
  }
}

export default SliceLoopPlugin
