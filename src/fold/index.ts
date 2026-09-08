/**
 * tool-result-fold — 给 dsh 默认 transcript loop 加"轮内折叠"的独立插件(2026-09-04)。
 *
 * 正式家在独立仓库 https://github.com/TT-Wang/dsh-tool-result-fold(`dsh plugin add github:TT-Wang/dsh-tool-result-fold`);
 * 这里的副本供本仓库的 runner(`--arm transcript-fold`)与契约测试使用,两边源码同源,改动请先改那边。
 *
 * 机制:每步开始前(`agent/pre-step`,`prepend` 挂在最外层、拿到下游的 enter 判定之后才折),把上一步
 * 刚落盘的工具结果按内容路由折成紧凑视图,以 **surface 替换事件**遮蔽原节点(`surfaceOp: replace`,
 * 引用被遮蔽的 seq)——与 dsh 自带的 compaction-tool-result-pruner 同一机制,会话不变量明确允许
 * "引用被替换事件的内容改写"。
 * 原文原样留在日志里,`expand_result` 逐字取回;模型看到的上下文只追加不改写,前缀缓存不受影响。
 *
 * 路由规则复用 slice 的 result-digest(Headroom 式):代码不折,grep/glob 只在巨量命中时按文件配额折,
 * 日志错误优先,文档/数据留头尾与结构行。
 * 装载:默认 loop 不装 slice loop 也能用;slice loop 则无条件挂这一份副本(折叠只在这里做,slice 自己不折)。
 * 同一个 ctx 里不要再挂独立仓库那一份——两份都会注册 `expand_result`,重名注册直接失败。
 *
 * 定位(2026-09-09):折叠视图首行同时给出 `{turn, step, call}`(步内序号)和 `{seq}`(原结果的日志 seq,跨进程稳定);
 * `expand_result({"seq": N})` 接受折叠视图自己的 seq——顺着 sourceEventSeqs[0] 回到原文。
 *
 * spill 臂(tools/post-execute)改写的是**落盘前**的内容,日志里只剩视图;所以视图首行必须带 spill locator,
 * expand_result 从 locator 读回原文。做不到(没有 spill 后端 / 存储失败)就不改写,留给 pre-step 在 surface 上折。
 * 它与 pre-step 共用同一份退避/钉住状态:已退避的工具、钉住步里的小结果,这条路同样不折。
 *
 * 恢复(resume / 插件晚挂):folder 建立时日志里最后一个 request/header 或 assistant/message 之前的追加态结果,
 * 已经原样给模型看过(上一进程发过请求),第一次 pre-step 不再折它们——折了会让整段前缀改写、缓存全失;
 * 只折之后新落盘的结果。之前进程留下的折叠替换仍按 restoreFold 逐个认领计数,退避阈值跨进程一致。
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, ToolResultMessage } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import { defineTool, type PostToolDecision, type ToolDefinition, type ToolExecution, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SpillStore } from '@deepseek-ai/dsh-spill'
import { digestToolResult, resolveDigestPolicy, type DigestPolicy } from '../slice/result-digest.js'

export const name = 'tool-result-fold'

export interface Config {
  /** 关掉后插件只注册 expand_result,不折任何结果。 */
  enabled?: boolean
  /** 折叠策略(阈值、头尾行数、日志上下文行数……),见 result-digest.ts。 */
  digest?: Partial<DigestPolicy>
  /** 每轮前这么多步的工具结果不折(默认 2):任务的规则/说明文档几乎总在开头被读,l2 实测折掉规则段就全错。 */
  pinSteps?: number
  /** 钉住步里仍然要折的体量(默认 8000 字符):规则/说明文档只有几 K(l1 的 MANIFEST 3K、l2 的规则 3.7K),而开头两步
   *  整页抓回来的 10–14K 文档、170K 的测试输出不是规则;f9 实测模型把 6 页都放在第 2 步抓,20000 的阈值让它们全被钉住。 */
  pinMaxChars?: number
  /** spill 预览臂(默认 50000 字节,与 dsh-base 的 spill-policy maxInlineBytes 对齐;0 = 关):结果达到这个体量时,在 tools/post-execute
   *  就把原文存进 ctx.spillStore(有 spill 后端时),模型看到的是按内容路由的折叠视图 + 文件定位,而不是 spill-policy 的头尾预览。
   *  没挂 spill 后端时此臂不生效。read 结果与 spill-policy 同样跳过(它靠 pre-step 的 surface 替换折叠,原文留日志)。 */
  spillPreviewMinBytes?: number
  /** 展开退避(默认 2):某个工具的折叠视图被 expand_result 取回这么多次、且取回率 ≥ 一半,本会话就不再折它的结果——
   *  s10 实测模型把 64 次折叠逐一取回,折了等于白折还多走一步。 */
  backoffAfterExpansions?: number
}

export const EXPAND_TOOL_NAME = 'expand_result'
/** slice loop 注册的整步召回工具;独立挂载时它不存在,可供性里就不能提(见 foldAffordance)。 */
const RECALL_STEP_TOOL_NAME = 'recall_step'

/** grep/glob 的措辞必须与 digestSearch 的实际契约一致:巨量命中会按文件配额折,并写明丢了多少
 *  (`src/slice/result-digest.ts` 的 searchMinMatches/searchMinChars/searchMaxPerFile 与 maxKeepRatio)。
 *  阈值是可配的,所以这里只说"很多命中"而不写死数字;`tests/fold-plugin.spec.ts` 把措辞钉在行为上。 */
const FOLD_BODY = `Within the current turn, newly completed large tool results may be condensed before the next model request. Data and document reads keep their first and last lines and every structured line (key = value, key: value, headings, section markers); build/test/log output keeps every error, failure and warning line with surrounding context, stack traces and summary lines; source code is never condensed; grep/glob results are kept whole unless one search returns very many matches, and then each file keeps its first and last matching lines and an exact \`[... and N more matches in <file>]\` marker names what was dropped. Everything else is replaced by exact markers \`…[+N lines / M chars]…\`, and the view's first line names the call that returns the full result: ${EXPAND_TOOL_NAME}({"turn": t, "step": s, "call": n}) or ${EXPAND_TOOL_NAME}({"seq": N}) (N is the durable log id printed in that line), durable and one call away; add "grep": <regex> or "lines": "a-b" to get just the part you need, which is far cheaper than the whole result. Use the file tool's read limits: a condensed view represents only what the tool actually returned.`

/** 整步召回句:只有 ${RECALL_STEP_TOOL_NAME} 真的注册了才加,否则就是在宣告一个不存在的工具。 */
const RECALL_STEP_CLAUSE = ` The locator stays valid after the turn is sealed; ${RECALL_STEP_TOOL_NAME}({"turn": t, "step": s}) returns that whole step — every call and every full result — from the same durable log.`

/** 系统提示词里的可供性说明:模型得知道视图是折过的、原文一步可取。 */
export function foldAffordance(hasRecallStep: boolean): string {
  return `<fold>\n${FOLD_BODY}${hasRecallStep ? RECALL_STEP_CLAUSE : ''}\n</fold>`
}

export const FOLD_AFFORDANCE = foldAffordance(false)

interface ToolResultBlock { type: string; toolCallId?: string; isError?: boolean; content?: ReadonlyArray<{ type: string; text?: string }> }
interface CallInfo { name: string; path?: string }
interface FoldView { message: ToolResultMessage; tools: string[]; before: number; after: number; condensed: boolean }

function callPath(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const bag = args as Record<string, unknown>
  return typeof bag.file_path === 'string' ? bag.file_path : typeof bag.path === 'string' ? bag.path : undefined
}
function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { return undefined }
}
function resultChars(message: ToolResultMessage): number {
  let n = 0
  for (const b of message.content as ReadonlyArray<ToolResultBlock>) for (const inner of b.content ?? []) if (inner.type === 'text' && typeof inner.text === 'string') n += inner.text.length
  return n
}
function resultText(block: ToolResultBlock): string {
  return (block.content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n')
}
function headLine(text: string): { head: string; rest: string } {
  const nl = text.indexOf('\n')
  return nl === -1 ? { head: text, rest: '' } : { head: text.slice(0, nl), rest: text.slice(nl) }
}
/** post-execute spill 视图首行 `[… · full text (N bytes) stored at <locator> — <hint>]`:日志里只有视图,原文靠 locator。 */
export function spillLocatorOf(text: string): { bytes: number; locator: string } | undefined {
  const m = /^\[.* · full text \((\d+) bytes\) stored at (.+?) — .*\]$/.exec(headLine(text).head)
  return m ? { bytes: Number(m[1]), locator: m[2]! } : undefined
}

/** 一个会话的折叠状态:处理游标、callId → 工具名/路径、统计。 */
class SessionFolder {
  private cursor = 0
  private readonly calls = new Map<string, CallInfo>()
  /** 每步的追加态结果计数(call 序号 = 该步第 n 个结果,expand_result 用同一规则定位)。 */
  private readonly ordinals = new Map<string, number>()
  private readonly originalAt = new Map<number, { turn: number; step: number; ordinal: number }>()
  private readonly countedFolds = new Set<number>()
  readonly stats = { folded: 0, charsBefore: 0, charsAfter: 0, expanded: 0, backedOff: [] as string[], spilled: 0 }
  /** (turn:step:call) → 被折结果的工具名;展开时据此记账。 */
  private readonly foldedAt = new Map<string, readonly string[]>()
  private readonly perTool = new Map<string, { folded: number; expanded: number }>()
  /** 建 folder 时最后一个 request/header / assistant/message 的 seq:不晚于它的追加态结果已经原样发给过模型,不折。 */
  private readonly shownThrough: number
  /** 当前步(pre-step 记录);post-execute 的钉住判断用。 */
  step = 0
  constructor(private readonly session: Session, private readonly policy: DigestPolicy, private readonly pinSteps: number, private readonly backoffAfter: number, private readonly pinMaxChars: number) {
    let shown = -1
    for (const e of session.snapshotEvents()) if (e.type === 'request/header' || e.type === 'assistant/message') shown = e.seq
    this.shownThrough = shown
  }

  pinned(step: number, chars: number): boolean {
    return step <= this.pinSteps && chars < this.pinMaxChars
  }

  /** 把游标之后新落盘的、仍在 surface 上的追加态工具结果折掉。 */
  fold(): void {
    const session = this.session
    const end = session.seq
    const onSurface = new Set<number>(session.surface.nodes as readonly number[])
    for (let i = this.cursor; i < end; i += 1) {
      const event = session.eventAt(i as SessionSeq) as SessionEvent | undefined
      if (event === undefined) continue
      if (event.type === 'tool/call') {
        const d = event.data as { callId: string; name: string; arguments?: unknown }
        this.calls.set(d.callId, { name: d.name, path: callPath(parseArgs(d.arguments)) })
        if (d.name === EXPAND_TOOL_NAME) this.noteExpansion(parseArgs(d.arguments))
        continue
      }
      if (event.type !== 'tool/result') continue
      if (isReplacementSurfaceEvent(event)) {
        this.restoreFold(event)
        continue
      }
      if (!isAppendSurfaceEvent(event)) continue
      const d = event.data as { turn: number; step: number; message: ToolResultMessage }
      const key = `${d.turn}:${d.step}`
      const n = (this.ordinals.get(key) ?? 0) + 1
      this.ordinals.set(key, n)
      this.originalAt.set(i, { turn: d.turn, step: d.step, ordinal: n })
      if (!onSurface.has(i) || i <= this.shownThrough) continue
      if (this.pinned(d.step, resultChars(d.message))) continue
      this.foldOne(i as SessionSeq, event as SessionEvent<'tool/result'>, d, n)
    }
    this.cursor = end
  }

  /** expand_result 被调用:记到被折结果的工具名上;达到退避阈值就把该工具列入不折名单。 */
  private noteExpansion(args: unknown): void {
    const a = (typeof args === 'object' && args !== null ? args : {}) as { seq?: unknown; turn?: unknown; step?: unknown; call?: unknown }
    let key: string
    if (a.seq !== undefined) {
      let at
      try { at = this.originalAt.get(originalResultAt(this.session.snapshotEvents(), Number(a.seq)).seq) } catch { return }
      if (at === undefined) return
      key = `${at.turn}:${at.step}:${at.ordinal}`
    } else key = `${Number(a.turn)}:${Number(a.step)}:${a.call === undefined ? 1 : Number(a.call)}`
    const tools = this.foldedAt.get(key)
    if (tools === undefined) return
    this.stats.expanded += 1
    for (const tool of tools) {
      const t = this.perTool.get(tool) ?? { folded: 0, expanded: 0 }
      t.expanded += 1
      this.perTool.set(tool, t)
      if (t.expanded >= this.backoffAfter && t.expanded * 2 >= t.folded && !this.stats.backedOff.includes(tool)) this.stats.backedOff.push(tool)
    }
  }

  /**
   * Replay only replacements that exactly match this folder's deterministic
   * renderer and cited original. Other plugins' replacements do not count as
   * folds. Changing digest policy can prevent recognition of an old fold;
   * without a durable policy record we deliberately leave that count unknown.
   */
  private restoreFold(event: SessionEvent<'tool/result'>): void {
    if (event.sourceEventSeqs?.length !== 1) return
    const source = event.sourceEventSeqs[0]!
    if (this.countedFolds.has(source)) return
    const at = this.originalAt.get(source)
    const original = this.session.eventAt(source)
    if (at === undefined || original?.type !== 'tool/result' || !isAppendSurfaceEvent(original)) return
    const view = this.buildFold(original.data, at.ordinal, source)
    if (view === undefined || !isDeepStrictEqual(view.message, event.data.message)) return
    this.recordFold(source, at.turn, at.step, at.ordinal, view)
  }

  private buildFold(d: { turn: number; step: number; message: ToolResultMessage }, n: number, seq: number): FoldView | undefined {
    let changed = false
    let condensed = false
    let before = 0
    let after = 0
    const tools = new Set<string>()
    const hint = `${EXPAND_TOOL_NAME}({"turn": ${d.turn}, "step": ${d.step}, "call": ${n}}) or ${EXPAND_TOOL_NAME}({"seq": ${seq}})`
    const content = (d.message.content as readonly ToolResultBlock[]).map((block) => {
      if (block.type !== 'tool-result' || block.isError || !block.content) return block
      const info = this.calls.get(String(block.toolCallId ?? d.message.source?.callId ?? '')) ?? { name: 'tool' }
      if (info.name === EXPAND_TOOL_NAME || this.stats.backedOff.includes(info.name)) return block
      let blockChanged = false
      const inner = block.content.map((b) => {
        if (b.type !== 'text' || typeof b.text !== 'string') return b
        before += b.text.length
        if (spillLocatorOf(b.text) !== undefined) {
          // post-execute 已把原文存进 spill store、视图落了盘:不再折,只在首行补上 expand_result 定位(此时还没发过,替换零成本)。
          changed = blockChanged = true
          tools.add(info.name)
          const { head, rest } = headLine(b.text)
          const text = `${head.slice(0, -1)} · ${hint} returns the full text]${rest}`
          after += text.length
          return { ...b, text }
        }
        const r = digestToolResult(b.text, { tool: info.name, ...(info.path ? { path: info.path } : {}) }, this.policy)
        if (!r.digested) {
          after += b.text.length
          return b
        }
        changed = blockChanged = condensed = true
        tools.add(info.name)
        const text = `[${info.name}${info.path ? ' ' + info.path : ''} · ${r.kind} · ${r.totalLines} lines, ${r.keptLines} kept · ${hint} returns the full text]\n${r.text}`
        after += text.length
        return { ...b, text }
      })
      return blockChanged ? { ...block, content: inner } : block
    })
    if (!changed) return undefined
    return { message: freezeMessage<ToolResultMessage>({ ...d.message, content: content as never }), tools: [...tools], before, after, condensed }
  }

  private recordFold(seq: number, turn: number, step: number, n: number, view: FoldView): void {
    if (this.countedFolds.has(seq)) return
    this.countedFolds.add(seq)
    if (view.condensed) {
      this.stats.folded += 1
      this.stats.charsBefore += view.before
      this.stats.charsAfter += view.after
    }
    this.foldedAt.set(`${turn}:${step}:${n}`, view.tools)
    for (const tool of view.tools) {
      const t = this.perTool.get(tool) ?? { folded: 0, expanded: 0 }
      t.folded += 1
      this.perTool.set(tool, t)
    }
  }

  private foldOne(seq: SessionSeq, event: SessionEvent<'tool/result'>, d: { turn: number; step: number; message: ToolResultMessage }, n: number): void {
    const view = this.buildFold(d, n, seq)
    if (view === undefined) return
    this.session.append('tool/result', { ...(event.data as object), message: view.message } as never, {
      surfaceOp: { op: 'replace', start: seq, end: seq },
      sourceEventSeqs: [seq],
    })
    this.recordFold(seq, d.turn, d.step, n, view)
  }
}

function describeResult(calls: ReadonlyMap<string, string>, d: { message: ToolResultMessage }): { name: string; text: string } {
  const blocks = (d.message.content as readonly ToolResultBlock[]).filter((block) => block.type === 'tool-result')
  const names = [...new Set(blocks.map((block) => calls.get(String(block.toolCallId ?? d.message.source?.callId ?? '')) ?? 'tool'))]
  return { name: names.join(', ') || 'tool', text: blocks.map(resultText).join('\n') }
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
    if (n === call) return describeResult(calls, d)
  }
  return null
}

function eventAt(events: readonly SessionEvent[], seq: number): SessionEvent | undefined {
  const direct = events[seq]
  return direct?.seq === seq ? direct : events.find((e) => e.seq === seq)
}

/** 顺着替换链(折叠视图 → sourceEventSeqs[0])回到追加态原文事件;不是 tool/result 就明确报错。 */
export function originalResultAt(events: readonly SessionEvent[], seq: number): SessionEvent<'tool/result'> {
  const seen = new Set<number>()
  for (let s = seq; ;) {
    const e = eventAt(events, s)
    if (e === undefined) throw new Error(`${EXPAND_TOOL_NAME}: no session event at seq ${s}`)
    if (e.type !== 'tool/result') throw new Error(`${EXPAND_TOOL_NAME}: seq ${s} is a ${e.type} event, not a tool result`)
    if (isAppendSurfaceEvent(e)) return e
    const source = e.sourceEventSeqs?.[0]
    if (source === undefined || seen.has(source)) throw new Error(`${EXPAND_TOOL_NAME}: the replacement at seq ${s} names no original tool result`)
    seen.add(s)
    s = source
  }
}

/** 按日志 seq 取结果:seq 可以是原文,也可以是它的折叠视图;附带 turn/step/call 以便两种定位互认。 */
export function resultBySeq(events: readonly SessionEvent[], seq: number): { name: string; text: string; seq: number; turn: number; step: number; call: number } {
  const original = originalResultAt(events, seq)
  const d = original.data as { turn: number; step: number; message: ToolResultMessage }
  const calls = new Map<string, string>()
  let call = 0
  for (const e of events) {
    if (e.seq > original.seq) break
    if (e.type === 'tool/call') { const c = e.data as { callId: string; name: string }; calls.set(c.callId, c.name); continue }
    if (e.type !== 'tool/result' || !isAppendSurfaceEvent(e)) continue
    const x = e.data as { turn: number; step: number }
    if (x.turn === d.turn && x.step === d.step) call += 1
  }
  return { ...describeResult(calls, d), seq: original.seq, turn: d.turn, step: d.step, call }
}

/** 日志里的文本若是 spill 视图(原文在 post-execute 就被换掉了),从 locator 读回原文。 */
export async function originalText(logged: string, where: string): Promise<string> {
  const spill = spillLocatorOf(logged)
  if (spill === undefined) return logged
  try { return await readFile(spill.locator, 'utf8') } catch (error) {
    throw new Error(`${EXPAND_TOOL_NAME}: the full text of ${where} (${spill.bytes} bytes) was stored at ${spill.locator} and cannot be read from here (${String(error)}); read that locator with the file tools instead`)
  }
}

/** 部分取回(2026-09-04):按正则取匹配行(±2 行上下文)或按行号区间——比整份取回便宜得多;s10 的 64 次整份取回、f9 的散文事实都是它的场景。 */
export function partialByGrep(text: string, pattern: string, head: string): string {
  let re: RegExp
  try { re = new RegExp(pattern, 'i') } catch { throw new Error(`expand_result: invalid regex ${JSON.stringify(pattern)}`) }
  const lines = text.split('\n')
  const hits: number[] = []
  for (let i = 0; i < lines.length; i += 1) if (re.test(lines[i]!)) hits.push(i)
  if (hits.length === 0) return `[${head} · 0 of ${lines.length} lines match /${pattern}/i]`
  const keep = new Set<number>()
  for (const i of hits) for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 2); k += 1) keep.add(k)
  const out: string[] = []
  let prev = -1
  for (const i of [...keep].sort((x, y) => x - y)) {
    if (prev !== -1 && i > prev + 1) out.push(`…[${i - prev - 1} lines]…`)
    out.push(`${i + 1}: ${lines[i]!}`)
    prev = i
  }
  const shown = Math.min(hits.length, 200)
  return `[${head} · ${hits.length} of ${lines.length} lines match /${pattern}/i${hits.length > 200 ? ', first 200 shown' : ''}]\n${out.slice(0, shown * 5 + 200).join('\n')}`
}

export function partialByLines(text: string, range: string, head: string): string {
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(range.trim())!
  const lines = text.split('\n')
  const a = Math.max(1, Number(m[1])); const b = Math.min(lines.length, Number(m[2]))
  if (b < a) throw new Error(`expand_result: empty range ${range} (result has ${lines.length} lines)`)
  return `[${head} · lines ${a}-${b} of ${lines.length}]\n${lines.slice(a - 1, b).map((l, i) => `${a + i}: ${l}`).join('\n')}`
}

export function expandResultToolDefinition(): ToolDefinition {
  return defineTool({
    name: EXPAND_TOOL_NAME,
    description: 'Return the text of a tool result that the host condensed on entry. The condensed view\'s first line names the call two ways: `seq` (the durable log id of the result) or turn, step and the result\'s ordinal within that step (1-based). Pass `grep` to get only the lines matching a regex (with 2 lines of context) or `lines` as "start-end" for a line range — both are much cheaper than the whole result; omit both for the full text.',
    parameters: {
      seq: { type: 'number', description: 'Durable log id from the condensed view\'s first line; when given, turn/step/call are ignored.' },
      turn: { type: 'number', description: 'Turn number from the condensed view\'s first line (required without seq).' },
      step: { type: 'number', description: 'Step number from the condensed view\'s first line (required without seq).' },
      call: { type: 'number', description: 'Which result of that step (1-based; default 1).' },
      grep: { type: 'string', description: 'Case-insensitive regex: return only matching lines, each with 2 lines of context, and a count of matches.' },
      lines: { type: 'string', description: 'Line range "start-end" (1-based, inclusive), e.g. "120-180".' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown, exec: ToolRunContext): Promise<string> => {
      const agent = exec.agent as Agent | undefined
      if (agent === undefined) throw new Error(`${EXPAND_TOOL_NAME} runs only inside an agent loop`)
      const a = args as { seq?: unknown; turn?: unknown; step?: unknown; call?: unknown; grep?: unknown; lines?: unknown }
      const events = agent.session.snapshotEvents() as readonly SessionEvent[]
      let hit: { name: string; text: string }
      let head: string
      if (a.seq !== undefined) {
        const seq = Number(a.seq)
        if (!Number.isInteger(seq) || seq < 0) throw new Error(`${EXPAND_TOOL_NAME}: "seq" must be a non-negative integer`)
        const r = resultBySeq(events, seq)
        hit = r
        head = `${r.name} · seq ${r.seq} (turn ${r.turn} step ${r.step} call ${r.call})`
      } else {
        const turn = Number(a.turn); const step = Number(a.step); const call = a.call === undefined ? 1 : Number(a.call)
        if (!Number.isInteger(turn) || !Number.isInteger(step) || turn < 1 || step < 1 || !Number.isInteger(call) || call < 1) {
          throw new Error(`${EXPAND_TOOL_NAME} needs {"seq": N} or {"turn": N, "step": M} (and optional "call": K), all positive integers`)
        }
        const found = fullResultAt(events, turn, step, call)
        if (found === null) throw new Error(`no tool result recorded at turn ${turn} step ${step} call ${call}`)
        hit = found
        head = `${found.name} · turn ${turn} step ${step} call ${call}`
      }
      const text = await originalText(hit.text, head)
      if (typeof a.grep === 'string' && a.grep.trim()) return partialByGrep(text, a.grep, head)
      if (typeof a.lines === 'string' && /^\d+\s*-\s*\d+$/.test(a.lines.trim())) return partialByLines(text, a.lines, head)
      return `[full result of ${head}]\n${text}`
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
    const pinSteps = config.pinSteps ?? 2
    if (!Number.isInteger(pinSteps) || pinSteps < 0) throw new Error('pinSteps must be a non-negative integer')
    const pinMaxChars = config.pinMaxChars ?? 8_000
    if (!(pinMaxChars >= 0)) throw new Error('pinMaxChars must be >= 0')
    const backoffAfter = config.backoffAfterExpansions ?? 2
    if (!Number.isInteger(backoffAfter) || backoffAfter < 1) throw new Error('backoffAfterExpansions must be an integer >= 1')
    ctx.effect(() => ctx.tools.register(expandResultToolDefinition()), 'toolResultFold.expandResult()')
    if (!enabled) return
    ctx.effect(
      () => ctx.systemPrompt.section({
        name: 'fold:affordance', order: -900,
        // 每次装配现算一次(结果对同一装载是恒定的,前缀缓存不受影响):slice loop 挂着时才提 recall_step。
        text: (assembly) => foldAffordance(ctx.tools.get(RECALL_STEP_TOOL_NAME, assembly.scope) !== undefined),
      }),
      'toolResultFold.affordance()',
    )
    const folders = new WeakMap<Session, SessionFolder>()
    const folderFor = (session: Session): SessionFolder => {
      let folder = folders.get(session)
      if (folder === undefined) {
        folder = new SessionFolder(session, policy, pinSteps, backoffAfter, pinMaxChars)
        folders.set(session, folder)
        FOLD_STATS.set(session, folder.stats)
      }
      return folder
    }
    const spillMin = config.spillPreviewMinBytes ?? 50_000
    if (!(spillMin >= 0)) throw new Error('spillPreviewMinBytes must be >= 0')
    if (spillMin > 0) {
      // 跑在 spill-policy 的 next() 里(它是 prepend 的):我们先把超大结果换成折叠视图 + 定位,它再看到的就是小结果,不会二次 spill。
      // 这里改写的是落盘前的内容,所以只有 saveText 成功、视图首行带上 locator 才改写;否则原样放行,留给 pre-step 在 surface 上折。
      ctx.on('tools/post-execute', async (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision> => {
        const downstream = await next()
        if (downstream.kind !== 'accept' || downstream.value !== undefined || downstream.content !== undefined) return downstream
        if (result.isError || exec.name === 'read' || exec.name === 'read_file' || exec.name === EXPAND_TOOL_NAME) return downstream
        const store = ctx.get('spillStore') as SpillStore | undefined
        const agent = exec.agent as Agent | undefined
        if (store === undefined || agent === undefined) return downstream
        const texts = result.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
        const full = texts.map((b) => b.text).join('\n')
        if (Buffer.byteLength(full, 'utf8') < spillMin) return downstream
        // 与 pre-step 同一份退避/钉住状态:模型已经把这个工具的折叠视图逐一取回,这条路也不再折。
        const folder = folderFor(agent.session)
        if (folder.stats.backedOff.includes(exec.name) || folder.pinned(folder.step, full.length)) return downstream
        const path = callPath(parseArgs(exec.arguments))
        const r = digestToolResult(full, { tool: exec.name, ...(path ? { path } : {}) }, policy)
        if (!r.digested) return downstream
        let ref
        try {
          ref = await store.saveText({ owner: { sessionId: agent.session.id }, source: { toolName: exec.name, callId: String((exec as { callId?: unknown }).callId ?? ''), label: 'result' }, suggestedName: `${exec.name}.txt`, content: full } as never)
        } catch { return downstream }
        const text = `[${exec.name}${path ? ' ' + path : ''} · ${r.kind} · ${r.totalLines} lines, ${r.keptLines} kept · full text (${ref.bytes} bytes) stored at ${ref.locator} — ${ref.retrievalHint}]\n${r.text}`
        if (spillLocatorOf(text) === undefined) return downstream   // 定位行必须能被 expand_result 解析回去,否则原文不可取回,不改写
        folder.stats.spilled += 1
        return { ...downstream, content: [...result.content.filter((b) => b.type !== 'text'), { type: 'text', text }] as never }
      })
    }
    // 折在 next() 之后:下游(slice loop 的步数上限、宿主的中止)可能把这一步判成非 enter,
    // 那一步不再构造请求,先折就是一次没人看的 surface 替换 + 日志写入(A-RT-12)。
    // enter 之后仍然早于请求构造(agent/request),折叠视图照常进这一步的请求。
    // folder 在 next() 之前建:shownThrough 取的是恢复时日志的样子,不受下游 pre-step 追加的事件影响。
    ctx.on('agent/pre-step', async ({ agent, step }, next) => {
      const folder = folderFor((agent as Agent).session)
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      folder.step = step
      folder.fold()
      return decision
    }, { prepend: true })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    toolResultFold: ToolResultFold
  }
}

export default ToolResultFold
