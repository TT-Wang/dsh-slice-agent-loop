/**
 * tool-result-fold — 给 dsh 默认 transcript loop 加"轮内折叠"的独立插件(2026-09-04)。
 *
 * 正式家在独立仓库 https://github.com/TT-Wang/dsh-tool-result-fold(`dsh plugin add github:TT-Wang/dsh-tool-result-fold`);
 * 这里的副本供本仓库的 runner(`--arm transcript-fold`)与契约测试使用,两边源码同源,改动请先改那边。
 *
 * 机制:每步开始前(`agent/pre-step`),把上一步刚落盘的工具结果按内容路由折成紧凑视图,以
 * **surface 替换事件**遮蔽原节点(`surfaceOp: replace`,引用被遮蔽的 seq)——与 dsh 自带的
 * compaction-tool-result-pruner 同一机制,会话不变量明确允许"引用被替换事件的内容改写"。
 * 原文原样留在日志里,`expand_result` 逐字取回;模型看到的上下文只追加不改写,前缀缓存不受影响。
 *
 * 路由规则复用 slice 的 result-digest(Headroom 式):代码与 grep/glob 不折,日志错误优先,
 * 文档/数据留头尾与结构行。默认 loop 不装 slice loop 也能用;两者不要同时挂(slice 自己折)。
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, ToolResultMessage } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { digestToolResult, resolveDigestPolicy, type DigestPolicy } from '../slice/result-digest.js'

export const name = 'tool-result-fold'

export interface Config {
  /** 关掉后插件只注册 expand_result,不折任何结果。 */
  enabled?: boolean
  /** 折叠策略(阈值、头尾行数、日志上下文行数……),见 result-digest.ts。 */
  digest?: Partial<DigestPolicy>
}

export const EXPAND_TOOL_NAME = 'expand_result'

/** 系统提示词里的可供性说明:模型得知道视图是折过的、原文一步可取。 */
export const FOLD_AFFORDANCE = `<fold>
Your context is append-only: nothing already in it is rewritten or dropped. Large tool results are condensed by the host as they enter. Data and document reads keep their first and last lines and every structured line (key = value, key: value, headings, section markers); build/test/log output keeps every error, failure and warning line with surrounding context, stack traces and summary lines; source code and grep/glob results are never condensed. Everything else is replaced by exact markers \`…[+N lines / M chars]…\`, and the view's first line names the call that returns the full result: ${EXPAND_TOOL_NAME}({"turn": t, "step": s, "call": n}), durable and one call away. So read a whole file in one call rather than paging it with offset/limit — a full read costs no more context than its condensed view, while every page costs a step.
</fold>`

interface ToolResultBlock { type: string; toolCallId?: string; isError?: boolean; content?: ReadonlyArray<{ type: string; text?: string }> }
interface CallInfo { name: string; path?: string }

function callPath(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const bag = args as Record<string, unknown>
  return typeof bag.file_path === 'string' ? bag.file_path : typeof bag.path === 'string' ? bag.path : undefined
}
function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { return undefined }
}
function resultText(block: ToolResultBlock): string {
  return (block.content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n')
}

/** 一个会话的折叠状态:处理游标、callId → 工具名/路径、统计。 */
class SessionFolder {
  private cursor = 0
  private readonly calls = new Map<string, CallInfo>()
  /** 每步的追加态结果计数(call 序号 = 该步第 n 个结果,expand_result 用同一规则定位)。 */
  readonly stats = { folded: 0, charsBefore: 0, charsAfter: 0 }
  constructor(private readonly session: Session, private readonly policy: DigestPolicy) {}

  /** 把游标之后新落盘的、仍在 surface 上的追加态工具结果折掉。 */
  fold(): void {
    const session = this.session
    const end = session.seq
    const onSurface = new Set<number>(session.surface.nodes as readonly number[])
    const ordinal = new Map<string, number>()
    for (let i = this.cursor; i < end; i += 1) {
      const event = session.eventAt(i as SessionSeq) as SessionEvent | undefined
      if (event === undefined) continue
      if (event.type === 'tool/call') {
        const d = event.data as { callId: string; name: string; arguments?: unknown }
        this.calls.set(d.callId, { name: d.name, path: callPath(parseArgs(d.arguments)) })
        continue
      }
      if (event.type !== 'tool/result' || !isAppendSurfaceEvent(event)) continue
      const d = event.data as { turn: number; step: number; message: ToolResultMessage }
      const key = `${d.turn}:${d.step}`
      const n = (ordinal.get(key) ?? this.countBefore(d.turn, d.step, i)) + 1
      ordinal.set(key, n)
      if (!onSurface.has(i)) continue
      this.foldOne(i as SessionSeq, event as SessionEvent<'tool/result'>, d, n)
    }
    this.cursor = end
  }

  /** 同一步里游标之前已有几个追加态结果(游标跨步时序号要接上)。 */
  private countBefore(turn: number, step: number, upto: number): number {
    let n = 0
    for (let i = Math.max(0, upto - 64); i < upto; i += 1) {
      const e = this.session.eventAt(i as SessionSeq) as SessionEvent | undefined
      if (e?.type === 'tool/result' && isAppendSurfaceEvent(e)) {
        const d = e.data as { turn: number; step: number }
        if (d.turn === turn && d.step === step) n += 1
      }
    }
    return n
  }

  private foldOne(seq: SessionSeq, event: SessionEvent<'tool/result'>, d: { turn: number; step: number; message: ToolResultMessage }, n: number): void {
    const first = d.message.content[0] as ToolResultBlock | undefined
    if (!first || first.type !== 'tool-result' || first.isError || !first.content) return
    const info = this.calls.get(String(first.toolCallId ?? d.message.source?.callId ?? '')) ?? { name: 'tool' }
    if (info.name === EXPAND_TOOL_NAME) return
    let changed = false
    let before = 0
    let after = 0
    const hint = `${EXPAND_TOOL_NAME}({"turn": ${d.turn}, "step": ${d.step}, "call": ${n}})`
    const inner = first.content.map((b) => {
      if (b.type !== 'text' || typeof b.text !== 'string') return b
      before += b.text.length
      const r = digestToolResult(b.text, { tool: info.name, ...(info.path ? { path: info.path } : {}) }, this.policy)
      after += r.text.length
      if (!r.digested) return b
      changed = true
      return { ...b, text: `[${info.name}${info.path ? ' ' + info.path : ''} · ${r.kind} · ${r.totalLines} lines, ${r.keptLines} kept · ${hint} returns the full text]\n${r.text}` }
    })
    if (!changed) return
    const message = freezeMessage<ToolResultMessage>({ ...d.message, content: [{ ...(first as object), content: inner }] as never })
    this.session.append('tool/result', { ...(event.data as object), message } as never, {
      surfaceOp: { op: 'replace', start: seq, end: seq },
      sourceEventSeqs: [seq],
    })
    this.stats.folded += 1
    this.stats.charsBefore += before
    this.stats.charsAfter += after
  }
}

/** 从日志取某步第 n 个追加态工具结果的原文(替换事件不算)。 */
export function fullResultAt(events: readonly SessionEvent[], turn: number, step: number, call: number): { name: string; text: string } | null {
  const calls = new Map<string, string>()
  let n = 0
  for (const e of events) {
    if (e.type === 'tool/call') { const d = e.data as { callId: string; name: string }; calls.set(d.callId, d.name); continue }
    if (e.type !== 'tool/result' || !isAppendSurfaceEvent(e)) continue
    const d = e.data as { turn: number; step: number; message: ToolResultMessage }
    if (d.turn !== turn || d.step !== step) continue
    n += 1
    if (n !== call) continue
    const first = d.message.content[0] as ToolResultBlock
    return { name: calls.get(String(first.toolCallId ?? d.message.source?.callId ?? '')) ?? 'tool', text: resultText(first) }
  }
  return null
}

export function expandResultToolDefinition(): ToolDefinition {
  return defineTool({
    name: EXPAND_TOOL_NAME,
    description: 'Return the FULL text of a tool result that the host condensed on entry. The condensed view\'s first line names the call: turn, step and the result\'s ordinal within that step (1-based).',
    parameters: {
      turn: { type: 'number', required: true, description: 'Turn number from the condensed view\'s first line.' },
      step: { type: 'number', required: true, description: 'Step number from the condensed view\'s first line.' },
      call: { type: 'number', description: 'Which result of that step (1-based; default 1).' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown, exec: ToolRunContext): Promise<string> => {
      const agent = exec.agent as Agent | undefined
      if (agent === undefined) throw new Error(`${EXPAND_TOOL_NAME} runs only inside an agent loop`)
      const a = args as { turn?: unknown; step?: unknown; call?: unknown }
      const turn = Number(a.turn); const step = Number(a.step); const call = a.call === undefined ? 1 : Number(a.call)
      if (!Number.isInteger(turn) || !Number.isInteger(step) || turn < 1 || step < 1 || !Number.isInteger(call) || call < 1) {
        throw new Error(`${EXPAND_TOOL_NAME} needs {"turn": N, "step": M} (and optional "call": K), all positive integers`)
      }
      const hit = fullResultAt(agent.session.snapshotEvents() as readonly SessionEvent[], turn, step, call)
      if (hit === null) throw new Error(`no tool result recorded at turn ${turn} step ${step} call ${call}`)
      return `[full result of ${hit.name} · turn ${turn} step ${step} call ${call}]\n${hit.text}`
    },
  })
}

/** 供 runner/评测读取:某会话的折叠统计。 */
export const FOLD_STATS = new WeakMap<Session, SessionFolder['stats']>()

/** cordis 插件本体:声明注入的服务(tools、systemPrompt),挂载即生效,卸载即回收(ctx.effect)。 */
export class ToolResultFold extends Service {
  static inject = ['tools', 'systemPrompt']

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'toolResultFold')
    const policy = resolveDigestPolicy(config.digest)
    const enabled = config.enabled ?? true
    ctx.effect(() => ctx.tools.register(expandResultToolDefinition()), 'toolResultFold.expandResult()')
    if (!enabled) return
    ctx.effect(
      () => ctx.systemPrompt.section({ name: 'fold:affordance', order: -900, text: FOLD_AFFORDANCE }),
      'toolResultFold.affordance()',
    )
    const folders = new WeakMap<Session, SessionFolder>()
    ctx.on('agent/pre-step', ({ agent }, next) => {
      const session = (agent as Agent).session
      let folder = folders.get(session)
      if (folder === undefined) {
        folder = new SessionFolder(session, policy)
        folders.set(session, folder)
        FOLD_STATS.set(session, folder.stats)
      }
      folder.fold()
      return next()
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    toolResultFold: ToolResultFold
  }
}

export default ToolResultFold
