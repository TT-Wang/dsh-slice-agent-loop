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
import { ensureHarnessUniverse, type HarnessUniverse } from './universe.js'
import { CONSTITUTION_SYSTEM_ADDENDUM, FOLD_SYSTEM_ADDENDUM, SLICE_SYSTEM_PROMPT } from './system-prompt.js'
import { SliceAgentLifecycle, type LifecycleAgent } from './lifecycle.js'
import { SliceLoopAgent } from './driver.js'
import { DEFAULT_REASONING_EFFORT, REASONING_EFFORT_DEFAULTS } from './effort-default.js'
import { resolveSealPolicy } from './slice/step-tape.js'
import { DEFAULT_READ_BASES, DEFAULT_STATE_POLICY } from './driver.js'
import { resolveDigestPolicy } from './slice/result-digest.js'
import { recallStepToolDefinition } from './recall-step.js'
import { recallSearchToolDefinition, recallToolDefinition } from './recall.js'

export interface Config {
  maxParallelToolCalls?: number
  maxStepsPerTurn?: number
  /** reasoningEffort 插件默认档(无人显式选择时注入);'inherit' 退出。缺省 'low'。 */
  defaultReasoningEffort?: 'off' | 'low' | 'high' | 'max' | 'inherit'
  /** 轮内封存(提案 2026-09-02)。缺省关闭;A/B 裁决后再定出厂值。 */
  inTurnSeal?: { enabled?: boolean; sealTokens?: number; batchSteps?: number; keepSteps?: number }
  /** 'slice'(缺省)或 'state':世界状态循环(提案 2026-09-02)。 */
  mode?: 'slice' | 'state' | 'stream'
  /** v3 追加流的注入时摘要策略。 */
  digest?: { enabled?: boolean; minChars?: number; headLines?: number; tailLines?: number; maxKeepRatio?: number; structuredBlockCap?: number; structuredBlockMin?: number; logMinChars?: number; logMaxErrors?: number; logContextLines?: number }
  /** 读过未改的文件轮末锚定为 base(默认开;maxChars 守卫)。 */
  tape?: { readBases?: boolean; readBaseMaxChars?: number; readPointer?: boolean; anchor?: 'auto' | 'base' }
  state?: { hotWindowSteps?: number; pinSteps?: number; pushHits?: number; extractRules?: boolean; sideEffort?: 'off' | 'low' | 'high' | 'max' | 'inherit'; contractBounceBudget?: number; extractAtStep?: number; enforceFromStep?: number }
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

function registerSliceEventTypes(ctx: Context, universe: HarnessUniverse): void {
  // The HOST's Set, via the universe adapter: mutating our own copy's Set
  // would leave the host's persistence read path still refusing slice/* logs.
  const vocabulary = universe.session.KNOWN_SESSION_EVENT_TYPES as Set<string>
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

/**
 * 切片贡献登记口 —— loop 对插件开放的第四个报名处（前三个是 DSH 自己的：
 * 提示词段、运行时上下文、工具）。插件在启动时登记一个渲染函数；driver 每轮
 * 把事实包交给每个登记者，非空返回按 order 排好进切片的 PLUGIN CONTEXT 段。
 *
 * loop 永远不认识具体插件：这里只存 {name, order, render}。出场规则（第几轮
 * 出现、看什么条件）写在插件自己的 render 里 —— loop 提供事实，不定政策。
 */
export interface SliceContributionFacts {
  /** 用户这轮的原话。 */
  readonly request: string
  /** 第几轮（1 起）。 */
  readonly turn: number
  /** 已经在 tape 上的文件路径。 */
  readonly tapePaths: readonly string[]
  /** 会话工作目录。 */
  readonly cwd: string
}

export interface SliceContributor {
  readonly name: string
  /** 段内排序，小的在前。缺省 50。 */
  readonly order?: number
  /** 返回要塞进切片的文本；空串 = 这轮不出场。报错/超时按空串处理。 */
  render(facts: SliceContributionFacts): string | Promise<string>
}

export interface SliceContextService {
  /** 登记一个贡献者；返回注销函数（配 ctx.effect 与插件同生共死）。 */
  contribute(entry: SliceContributor): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sliceContext: SliceContextService
  }
}

export class SliceLoopPlugin extends Service {
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sliceAgentLoop')
    const maxParallelToolCalls = resolveMaxParallelToolCalls(config.maxParallelToolCalls)
    const maxStepsPerTurn = resolveMaxStepsPerTurn(config.maxStepsPerTurn)
    const defaultReasoningEffort = config.defaultReasoningEffort ?? DEFAULT_REASONING_EFFORT
    const inTurnSeal = resolveSealPolicy(config.inTurnSeal)
    const mode = config.mode ?? 'slice'
    if (mode !== 'slice' && mode !== 'state' && mode !== 'stream') throw new Error("mode must be 'slice', 'state' or 'stream'")
    const digest = resolveDigestPolicy(config.digest)
    const readBases = { enabled: config.tape?.readBases ?? DEFAULT_READ_BASES.enabled, maxChars: config.tape?.readBaseMaxChars ?? DEFAULT_READ_BASES.maxChars }
    if (!Number.isInteger(readBases.maxChars) || readBases.maxChars < 0) throw new Error('tape.readBaseMaxChars must be a non-negative integer')
    const readPointer = config.tape?.readPointer ?? false
    const anchorMode = config.tape?.anchor ?? 'auto'
    if (anchorMode !== 'auto' && anchorMode !== 'base') throw new Error("tape.anchor must be 'auto' or 'base'")
    const state = { ...DEFAULT_STATE_POLICY, ...(config.state ?? {}) }
    for (const key of ['hotWindowSteps', 'pinSteps', 'pushHits', 'contractBounceBudget', 'extractAtStep', 'enforceFromStep'] as const) {
      if (!Number.isInteger(state[key]) || state[key] < 0) throw new Error(`state.${key} must be a non-negative integer`)
    }
    if (!REASONING_EFFORT_DEFAULTS.includes(defaultReasoningEffort)) {
      throw new Error(`defaultReasoningEffort must be one of ${REASONING_EFFORT_DEFAULTS.join('|')}`)
    }
    guardStockLoopInvariant(ctx)
    // 贡献登记簿。provide 挂在本插件的 fiber 上，插件卸载即服务消失，
    // 依赖它的贡献插件随之休眠 —— 无需任何清理代码。
    const contributors: SliceContributor[] = []
    ctx.provide('sliceContext', {
      contribute(entry: SliceContributor) {
        contributors.push(entry)
        return () => {
          const i = contributors.indexOf(entry)
          if (i >= 0) contributors.splice(i, 1)
        }
      },
    })
    // Resolve which copy of the harness packages the HOST runs (universe.ts:
    // a source-run dsh loads plugins through the internal ModuleLoader, so our
    // static imports may be a second copy with split symbol identities). Event
    // types register as soon as it resolves — before any session can prepare,
    // because every createAgent/resume awaits this same promise and rethrows
    // its failure, so a failed resolution fails loudly at the first session
    // instead of silently writing logs the host refuses to read back.
    const universeReady: Promise<HarnessUniverse> = ensureHarnessUniverse(ctx).then((universe) => {
      registerSliceEventTypes(ctx, universe)
      return universe
    })
    // The rejection (if any) is DELIVERED at every createAgent/resume await;
    // this guard only stops it from also surfacing as an unhandled rejection.
    universeReady.catch(() => {})
    // The byte-stable sliceagent kernel rides the prompt REGISTRY as an
    // ordinary section (order -1000: first), not a driver-side prepend. Same
    // bytes in the ordinary case — renderPrompt joins sections with '\n\n',
    // exactly what the old `RESOLVED + '\n\n' + scoped` produced — but now a
    // host section declaring `complete: true` (new in 20260811) genuinely
    // becomes the SOLE prompt: assembly restores it alone, and this kernel
    // correctly disappears with every other contribution. A driver-side
    // prepend silently voided that host guarantee.
    ctx.effect(
      () => ctx.systemPrompt.section({
        name: 'slice:kernel',
        // rc8 把 HARNESS_IDENTITY 排到 -1000,与本 kernel 同序竞位——kernel 必须
        // 是模型读到的第一个字(缓存前缀与身份宣告都系于此),再前移一档。
        order: -1200,
        // 折叠开启(slice/stream 默认)追加 <fold> 可供性说明;stream 再追加宪法说明;state 模式字节不变。
        text: [SLICE_SYSTEM_PROMPT, ...(digest.enabled && mode !== 'state' ? [FOLD_SYSTEM_ADDENDUM] : []), ...(mode === 'stream' ? [CONSTITUTION_SYSTEM_ADDENDUM] : [])].join('\n\n'),
      }),
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
    // 轮内封存的召回(src/recall-step.ts):SEALED STEPS 块的切口指回这里。
    ctx.effect(() => ctx.tools.register(recallStepToolDefinition()), 'sliceLoop.recallStep()')
    // 提示词变量所有权（架构文档：the loop supplies provider/model/cwd）——
    // stock agent-loop/index.ts:312-314 同构；缺了 persona 节的 {{cwd}} 解析不了。
    ctx.systemPrompt.variable('provider', (context) => context.agent?.options.provider)
    ctx.systemPrompt.variable('model', (context) => context.agent?.options.model)
    ctx.systemPrompt.variable('cwd', (context) => context.agent?.session.header.cwd)
    const lifecycle = new SliceAgentLifecycle(
      ctx,
      (loopCtx: Context, id: SessionId, options: AgentOptions, session: Session): LifecycleAgent =>
        new SliceLoopAgent(loopCtx, id, options, session, { maxParallelToolCalls, maxStepsPerTurn, contributors, defaultReasoningEffort, inTurnSeal, mode, state, digest, readBases, readPointer, anchorMode }),
      universeReady,
    )
    ctx.effect(() => ctx.agents.setFactory(lifecycle), 'sliceLoop.setFactory()')
  }
}

export default SliceLoopPlugin
