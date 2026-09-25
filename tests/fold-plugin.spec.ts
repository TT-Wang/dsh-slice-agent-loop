/**
 * tool-result-fold 插件契约:挂在 dsh 原生 AgentLoop 上(不挂 slice loop)。
 *   ① 大的数据型结果在下一步请求里是折叠视图,原文仍在日志(追加态节点被替换事件遮蔽);
 *   ② 源代码结果不折;错误结果不折;
 *   ③ expand_result 逐字取回原文;
 *   ④ 原生 loop 的请求重建不变量(request == deriveMessages)在替换后仍成立。
 */
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import LlmService, { createUserMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, isAppendSurfaceEvent, isReplacementSurfaceEvent, type Session, type ToolResultMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import StockAgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as agentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import fold, { EXPAND_TOOL_NAME, FOLD_AFFORDANCE, FOLD_STATS, foldAffordance, fullResultAt } from '../src/fold/index.js'
import { DEFAULT_DIGEST_POLICY, digestData } from '../src/slice/result-digest.js'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.js'

const BIG = Array.from({ length: 120 }, (_, i) => (i % 10 === 0 ? `section_${i / 10}: header` : `row ${i} payload ${'x'.repeat(30)} ${i * 7}`)).join('\n')
const CODE = Array.from({ length: 80 }, (_, i) => `def f${i}(x):\n    return x + ${i}`).join('\n')
/** 5 个文件各 60 条命中:超过 searchMinMatches 120 与 searchMinChars 10_000,按文件配额(5)折。 */
const GREP_HUGE = Array.from({ length: 5 }, (_, f) =>
  Array.from({ length: 60 }, (_, i) => `src/mod${f}/file${f}.ts:${i + 1}:  const handler${i} = createHandler('route-${i}', options)`).join('\n')).join('\n')
/** 30 条命中、约 1K 字符:两个阈值都不到,原样。 */
const GREP_SMALL = Array.from({ length: 30 }, (_, i) => `src/small.ts:${i + 1}:  const handler${i} = createHandler()`).join('\n')

async function harness(adapter: MockAdapter, tools: Array<{ name: string; text: string; isError?: boolean }>, config: { pinSteps?: number; digest?: Record<string, unknown> } = { pinSteps: 0, digest: { minChars: 1500 } }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(InvariantService)
  await ctx.plugin(agentLoopInvariant)
  await ctx.plugin(SessionProjections)      // 原生 loop 依赖会话投影服务
  await ctx.plugin(StockAgentLoop, {} as never)
  await ctx.plugin(fold, config as never)
  for (const t of tools) {
    ctx.tools.register(defineContentToolFixture({
      name: t.name,
      description: t.name,
      parameters: { file_path: { type: 'string' }, url: { type: 'string' } },   // 夹具:接受 read 类与 fetch 类两种参数
      execute: async () => [{ type: 'text', text: t.text }],
    }))
  }
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}
function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}
const requestText = (adapter: MockAdapter, i: number): string => JSON.stringify(adapter.requests[i]?.messages ?? [])

describe('tool-result-fold on the stock loop', () => {
  it('folds a large data result before the next step, keeps the original in the log, expands it on demand', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: 'notes.md' }),
      toolCallResponse('c2', EXPAND_TOOL_NAME, { turn: 1, step: 1, call: 1 }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, [{ name: 'read', text: BIG }])
    const handle = await ctx.agents.create({ sessionId: SessionId('fold-data'), agentOptions: { provider: 'mock', model: 'mock' } })
    send(handle.agent, 'summarize notes.md')
    await handle.agent.whenIdle()

    // ① 第 2 步的请求里是折叠视图:带 expand 提示,且比原文短得多
    const second = requestText(adapter, 1)
    expect(second).toContain(`${EXPAND_TOOL_NAME}({\\"turn\\": 1, \\"step\\": 1, \\"call\\": 1})`)
    expect(second).toContain('[+')                       // 省略标记
    expect(second).not.toContain('row 55 payload')      // 中段被折掉
    expect(second).toContain('section_0: header')       // 结构行保留
    // 日志:追加态原文 + 引用它的替换事件
    const events = handle.agent.session.snapshotEvents()
    const originals = events.filter((e) => e.type === 'tool/result' && isAppendSurfaceEvent(e))
    const replacements = events.filter((e) => e.type === 'tool/result' && isReplacementSurfaceEvent(e))
    expect(originals.length).toBeGreaterThanOrEqual(2)  // read + expand_result
    expect(replacements).toHaveLength(1)                // 只有 read 的结果被折
    expect(replacements[0]!.surfaceOp).toEqual({
      op: 'replace', startSeq: originals[0]!.seq, endSeq: originals[0]!.seq,
    })
    expect(JSON.stringify(originals[0])).toContain('row 55 payload')
    expect((replacements[0] as { sourceEventSeqs?: unknown }).sourceEventSeqs).toEqual([originals[0]!.seq])
    // ③ expand_result 返回原文,且它自己的结果不会被折
    const third = requestText(adapter, 2)
    expect(third).toContain('row 55 payload')
    expect(third).toContain('[full result of read · turn 1 step 1 call 1]')
    const stats = FOLD_STATS.get(handle.agent.session)!
    expect(stats.folded).toBe(1)
    expect(stats.charsAfter).toBeLessThan(stats.charsBefore * 0.55)
    // ④ 不变量:三次请求都通过了 agent-loop 的 request == deriveMessages 检查(失败会抛)
    expect(adapter.requests).toHaveLength(3)
  })

  it('never folds source code or error results', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: 'core.py' }),
      toolCallResponse('c2', 'bash', { file_path: 'x' }),
      textResponse('ok'),
    ])
    const ctx = await harness(adapter, [{ name: 'read', text: CODE }])
    ctx.tools.register(defineContentToolFixture({
      name: 'bash', description: 'bash', parameters: { file_path: { type: 'string', required: true } },
      execute: async () => { throw new Error('boom ' + BIG) },
    }))
    const handle = await ctx.agents.create({ sessionId: SessionId('fold-code'), agentOptions: { provider: 'mock', model: 'mock' } })
    send(handle.agent, 'read core.py then run')
    await handle.agent.whenIdle()
    expect(requestText(adapter, 1)).toContain('def f79(x)')
    expect(requestText(adapter, 2)).toContain('row 55 payload')   // 错误结果原样
    expect(handle.agent.session.snapshotEvents().filter((e) => e.type === 'tool/result' && isReplacementSurfaceEvent(e))).toHaveLength(0)
    expect(FOLD_STATS.get(handle.agent.session)?.folded ?? 0).toBe(0)
  })
})

/**
 * A-RT-13:可供性曾写 "source code and grep/glob results are never condensed",而 grep/glob 走
 * digestSearch,巨量命中会按文件配额折。这里把措辞钉在行为上:措辞承诺的标记形状必须真的出现,
 * 而"代码不折"与"小结果不折"仍然成立。
 */
describe('the fold affordance states the real grep/glob contract', () => {
  it('no longer claims grep/glob is never condensed, and names the per-file drop marker it emits', () => {
    expect(FOLD_AFFORDANCE).not.toContain('grep/glob results are never condensed')
    expect(FOLD_AFFORDANCE).toContain('source code is never condensed')
    expect(FOLD_AFFORDANCE).toContain('[... and N more matches in <file>]')
    // 独立挂载(没有 slice loop)时不宣告 recall_step;slice 挂着时才加,见 fold-reject-step.spec.ts。
    expect(FOLD_AFFORDANCE).not.toContain('recall_step')
    expect(foldAffordance(true)).toContain('recall_step({"turn": t, "step": s})')
  })

  it('condenses a huge grep result with that exact marker', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'grep', { file_path: 'src' }), textResponse('done')])
    const ctx = await harness(adapter, [{ name: 'grep', text: GREP_HUGE }])
    const handle = await ctx.agents.create({ sessionId: SessionId('fold-grep-huge'), agentOptions: { provider: 'mock', model: 'mock' } })
    send(handle.agent, 'grep the repo')
    await handle.agent.whenIdle()
    expect(GREP_HUGE.length).toBeGreaterThan(10_000)
    const second = requestText(adapter, 1)
    expect(second).toContain('[... and 55 more matches in src/mod0/file0.ts]')   // 措辞承诺的标记
    expect(second).toContain('src/mod0/file0.ts:1:')                             // 每文件首条留下
    expect(second).toContain('src/mod4/file4.ts:60:')                            // 末条留下
    expect(second).not.toContain('file0.ts:30:')                                 // 中段确实被丢了
    expect(FOLD_STATS.get(handle.agent.session)!.folded).toBe(1)
  })

  it('leaves a search under both thresholds exactly as the tool returned it', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'grep', { file_path: 'src' }), textResponse('done')])
    const ctx = await harness(adapter, [{ name: 'grep', text: GREP_SMALL }])
    const handle = await ctx.agents.create({ sessionId: SessionId('fold-grep-small'), agentOptions: { provider: 'mock', model: 'mock' } })
    send(handle.agent, 'grep the repo')
    await handle.agent.whenIdle()
    expect(GREP_SMALL.length).toBeLessThan(10_000)
    // Session format V4: each result is a tool-role message in the request.
    const results = adapter.requests[1]!.messages.filter(message => message.role === 'tool')
    expect(results).toHaveLength(1)
    expect(results[0]!.content).toEqual([{ type: 'text', text: GREP_SMALL }])
    expect(FOLD_STATS.get(handle.agent.session)?.folded ?? 0).toBe(0)
  })
})

/**
 * P2-7:可供性曾写 "Data and document reads keep … every structured line",而 digestData 对每个结构块只留
 * 前 structuredBlockMin 行 + 键没出现过的行(并受 structuredBlockCap 约束),同键的 300 行只剩 17 行。
 * 这里把措辞钉在默认策略的实际行为上:结构行会被丢,所以文案不能承诺"全留",丢掉的部分由标记 + expand_result 兜底。
 * 两条分支都要盖住:整份结构化时 `cap = Infinity`(只有键新颖性在起作用),散文夹结构块时 structuredBlockCap 生效,
 * 键全新的行照样被丢——只写"新键都留"同样是假话,所以文案还得写出上限。
 */
describe('the fold affordance states the real data/document contract', () => {
  /** 整份都是结构行、键始终是 `item`:结构行占比 1.0 ≥ 0.8,块上限不生效,只有头尾区与块起始的几行留下。 */
  const REPEATED_KEYS = Array.from({ length: 300 }, (_, i) => `item: value_${i} ${'y'.repeat(20)}`).join('\n')
  /** 混合文档:结构行占比 < 80%,块上限真的生效——80 条互不相同的变更条目只留 structuredBlockCap 条。 */
  const MIXED_PROSE = [
    ...Array.from({ length: 50 }, (_, i) => `Narrative line ${i} ${'w'.repeat(40)}`),
    ...Array.from({ length: 80 }, (_, i) => `- CHANGE_${i}: rewrote handler ${i} ${'z'.repeat(40)}`),
    ...Array.from({ length: 20 }, (_, i) => `Closing line ${i} ${'w'.repeat(40)}`),
  ].join('\n')

  it('condenses an all-structured result whose keys repeat, so the text cannot promise every structured line', () => {
    const r = digestData(REPEATED_KEYS, DEFAULT_DIGEST_POLICY)
    expect(r.kind).toBe('data')
    expect(r.digested).toBe(true)
    expect(r.keptLines).toBeLessThan(r.totalLines / 10)   // 300 行 → 17 行
    expect(r.text).toContain('…[+')                       // 丢掉的整段由标记说明
    expect(r.text).not.toContain('item: value_150')       // 重复键的中段确实没留下

    expect(FOLD_AFFORDANCE).not.toContain('every structured line')
    expect(FOLD_AFFORDANCE).toContain('keeps only its first few lines, later lines whose key has not appeared yet')
    // 取回路径必须同时写明:丢的是行,不是内容。
    expect(FOLD_AFFORDANCE).toContain('…[+N lines / M chars]…')
    expect(FOLD_AFFORDANCE).toContain('"grep": <regex> or "lines": "a-b"')
  })

  it('caps a run of all-new keys inside prose, so the text cannot promise every new key either', () => {
    const r = digestData(MIXED_PROSE, DEFAULT_DIGEST_POLICY)
    expect(r.kind).toBe('data')
    expect(r.digested).toBe(true)
    // 结构行 80 / 150 < 80%,所以 result-digest 走 cap = structuredBlockCap 这一支。
    const kept = Array.from({ length: 80 }, (_, i) => i).filter(i => r.text.includes(`CHANGE_${i}:`))
    expect(kept).toHaveLength(DEFAULT_DIGEST_POLICY.structuredBlockCap)   // 80 条全新键只留 12 条
    expect(r.text).toContain('CHANGE_0:')
    expect(r.text).not.toContain('CHANGE_12:')                            // 键从没出现过,仍被块上限丢掉
    expect(r.text).toContain('…[+')

    expect(FOLD_AFFORDANCE).toContain('at most a dozen or so lines per run')
  })

  it('condenses such a result end to end and leaves the full text one expand_result away', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'read', { file_path: 'inventory.txt' }), textResponse('done')])
    const ctx = await harness(adapter, [{ name: 'read', text: REPEATED_KEYS }])
    const handle = await ctx.agents.create({ sessionId: SessionId('fold-repeated-keys'), agentOptions: { provider: 'mock', model: 'mock' } })
    send(handle.agent, 'read the inventory')
    await handle.agent.whenIdle()
    const second = requestText(adapter, 1)
    expect(second).toContain('item: value_0')
    expect(second).not.toContain('item: value_150')
    expect(second).toContain(EXPAND_TOOL_NAME)
    expect(FOLD_STATS.get(handle.agent.session)!.folded).toBe(1)
  })
})

describe('pinned early steps', () => {
  it('applies content rules from the first step by default while preserving small results', async () => {
    const document = Array.from({ length: 150 }, (_, i) => `row ${i} payload ${'x'.repeat(30)}`).join('\n')
    expect(document.length).toBeGreaterThan(6000)
    expect(document.length).toBeLessThan(8000)
    const adapter = new MockAdapter([
      toolCallResponse('large', 'read', { file_path: 'notes.md' }),
      toolCallResponse('small', 'small_read', { file_path: 'RULES.md' }), textResponse('done'),
    ])
    const ctx = await harness(adapter, [{ name: 'read', text: document }, { name: 'small_read', text: BIG }], {})
    try {
      const handle = await ctx.agents.create({ sessionId: SessionId('fold-default-pin'), agentOptions: { provider: 'mock', model: 'mock' } })
      send(handle.agent, 'read both')
      await handle.agent.whenIdle()
      expect(requestText(adapter, 1)).not.toContain('row 55 payload')
      expect(requestText(adapter, 2)).toContain('row 55 payload')
      expect(FOLD_STATS.get(handle.agent.session)!.folded).toBe(1)
    } finally { await ctx.fiber.dispose() }
  })

  it('never folds results that land in the first pinSteps steps of a turn (spec and rules reads)', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: 'RULES.md' }),   // step 1: pinned
      toolCallResponse('c2', 'read', { file_path: 'data.txt' }),   // step 2: pinned
      toolCallResponse('c3', 'read', { file_path: 'data2.txt' }),  // step 3: folded
      textResponse('done'),
    ])
    const ctx = await harness(adapter, [{ name: 'read', text: BIG }], { pinSteps: 2, digest: { minChars: 1500 } })
    const handle = await ctx.agents.create({ sessionId: SessionId('fold-pin'), agentOptions: { provider: 'mock', model: 'mock' } })
    send(handle.agent, 'go')
    await handle.agent.whenIdle()
    expect(requestText(adapter, 1)).toContain('row 55 payload')        // step-1 result verbatim in step 2's request
    expect(requestText(adapter, 2)).toContain('row 55 payload')        // step-2 result verbatim too
    expect(requestText(adapter, 3)).toContain('\\"turn\\": 1, \\"step\\": 3')  // step-3 result folded
    expect(FOLD_STATS.get(handle.agent.session)!.folded).toBe(1)
  })
})

describe('expansion back-off', () => {
  it('backs off only the resource whose distinct folded results were fully recovered', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: 'a.txt' }),                       // step 1: folded
      toolCallResponse('c2', EXPAND_TOOL_NAME, { turn: 1, step: 1, call: 1 }),      // step 2: expand #1
      toolCallResponse('c3', 'read', { file_path: 'a.txt' }),                       // step 3: same resource, different original
      toolCallResponse('c4', EXPAND_TOOL_NAME, { turn: 1, step: 3, call: 1 }),      // step 4: full recovery #2 → back off a.txt
      toolCallResponse('c5', 'read', { file_path: 'a.txt' }),                       // step 5: NOT folded
      toolCallResponse('c6', 'read', { file_path: 'other.txt' }),                   // step 6: still folded
      textResponse('done'),
    ])
    const ctx = await harness(adapter, [{ name: 'read', text: BIG }], { pinSteps: 0, digest: { minChars: 1500 } })
    const handle = await ctx.agents.create({ sessionId: SessionId('fold-backoff'), agentOptions: { provider: 'mock', model: 'mock' } })
    send(handle.agent, 'go')
    await handle.agent.whenIdle()
    const stats = FOLD_STATS.get(handle.agent.session)!
    expect(stats.folded).toBe(3)
    expect(stats.expanded).toBe(2)
    expect(stats.backedOff).toEqual(['["read","path","a.txt"]'])
    expect(requestText(adapter, 5)).toContain('row 55 payload')                    // 第 5 步的结果原样进了第 6 个请求
    expect(requestText(adapter, 5)).not.toContain('"step\\": 5')
    expect(requestText(adapter, 6)).toContain('read other.txt · data')
  })
})

describe('pinned steps still fold huge results', () => {
  it('a 20K+ result at step 1 is condensed even with pinSteps 2', async () => {
    const HUGE = Array.from({ length: 600 }, (_, i) => `2026-09-04 10:00:00 INFO tick ${i} ${'x'.repeat(30)}`).join('\n')
    const adapter = new MockAdapter([toolCallResponse('c1', 'bash', { file_path: 'run' }), textResponse('done')])
    const ctx = await harness(adapter, [{ name: 'bash', text: HUGE }], { pinSteps: 2, digest: { minChars: 1500 } })
    const handle = await ctx.agents.create({ sessionId: SessionId('fold-pin-huge'), agentOptions: { provider: 'mock', model: 'mock' } })
    send(handle.agent, 'go')
    await handle.agent.whenIdle()
    expect(FOLD_STATS.get(handle.agent.session)!.folded).toBe(1)
    expect(requestText(adapter, 1)).not.toContain('tick 300 ')
  })
})

describe('pinned steps and medium documents', () => {
  it('a 10K document fetched at step 2 is condensed (pinMaxChars 8000), a 3K rules file is not', async () => {
    // 普通散文行(不能长得像 `key: value`,否则整页都是结构行、按规则原样保留)
    const DOC = Array.from({ length: 60 }, (_, i) => (i % 12 === 0 ? `## Section ${i / 12}` : `The ${i}th paragraph goes on about ${'lorem ipsum '.repeat(14)}`)).join('\n')
    const RULES = Array.from({ length: 18 }, (_, i) => `R${i} rule ${i}: ${'must '.repeat(25)}`).join('\n')
    const adapter = new MockAdapter([toolCallResponse('c1', 'read', { file_path: 'RULES.md' }), toolCallResponse('c2', 'fetch_page', { url: 'https://d/x' }), textResponse('done')])
    const ctx = await harness(adapter, [{ name: 'read', text: RULES }, { name: 'fetch_page', text: DOC }], { pinSteps: 2, digest: { minChars: 1500 } })
    const handle = await ctx.agents.create({ sessionId: SessionId('fold-pin-medium'), agentOptions: { provider: 'mock', model: 'mock' } })
    send(handle.agent, 'go')
    await handle.agent.whenIdle()
    expect(DOC.length).toBeGreaterThan(8000); expect(RULES.length).toBeLessThan(8000)
    expect(requestText(adapter, 1)).toContain('R17 rule 17')                     // 规则文件钉住,原样
    expect(FOLD_STATS.get(handle.agent.session)!.folded).toBe(1)                  // 第 2 步的整页文档折了
  })
})

import { partialByGrep, partialByLines } from '../src/fold/index.js'
describe('partial expansion', () => {
  const text = Array.from({ length: 300 }, (_, i) => (i === 150 ? 'ERROR: pool exhausted at 14:31:40' : `line ${i} info tick`)).join('\n')
  it('grep returns matching lines with two lines of context and the count', () => {
    const out = partialByGrep(text, 'pool exhausted', 'read · turn 1 step 2 call 1')
    expect(out).toContain('1 of 300 lines match'); expect(out).toContain('151: ERROR: pool exhausted'); expect(out).toContain('149: line 148'); expect(out).toContain('153: line 152')
    expect(out.split('\n').length).toBeLessThan(10)
    expect(partialByGrep(text, 'nothing here', 'x')).toContain('0 of 300 lines match')
    expect(() => partialByGrep(text, '(', 'x')).toThrow('invalid regex')
  })
  it('lines returns an inclusive numbered range', () => {
    const out = partialByLines(text, '10-12', 'read · turn 1 step 2 call 1')
    expect(out).toContain('lines 10-12 of 300'); expect(out).toContain('10: line 9 info tick'); expect(out).toContain('12: line 11 info tick'); expect(out).not.toContain('13: ')
  })
})

/** Drive the real plugin hook over controlled durable events, including historic
 * combined result messages the current stock loop no longer produces. */
async function folderHarness(seed?: readonly import('@deepseek-ai/dsh-session').SessionEvent[]) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(fold, { pinSteps: 0, digest: { minChars: 1500 }, spillPreviewMinBytes: 0 })
  const session = ctx.sessions.create(SessionId('folder-events'), seed ? { seed } : undefined)
  const run = () => ctx.waterfall('agent/pre-step', {
    agent: { session } as Agent, messages: [], turn: 1, step: 2, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter' as const, messages: [] }))
  return { ctx, session, run }
}

function appendResult(session: Session, id: string, text: string, step = 3, name = 'read', args: unknown = { file_path: 'data.txt' }) {
  const callId = ToolCallId(id)
  session.append('tool/call', { turn: 1, step, callId, name, arguments: JSON.stringify(args) })
  return session.append('tool/result', {
    turn: 1, step, message: createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text }] }),
  }, { surfaceOp: 'append' })
}

function appendExpansion(session: Session, id: string, args: unknown, step = 4) {
  const callId = ToolCallId(id)
  session.append('tool/call', { turn: 1, step, callId, name: EXPAND_TOOL_NAME, arguments: JSON.stringify(args) })
  session.append('tool/result', {
    turn: 1, step, message: createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: 'retrieved evidence' }] }),
  }, { surfaceOp: 'append' })
}

describe('fold result identity and replay', () => {
  it('does not back off for partial recoveries or repeated full locator aliases', async () => {
    const bench = await folderHarness()
    try {
      const one = appendResult(bench.session, 'one', BIG, 1)
      const two = appendResult(bench.session, 'two', BIG, 2)
      await bench.run()
      const view = bench.session.snapshotEvents().find(event => isReplacementSurfaceEvent(event) && event.sourceEventSeqs?.includes(one.seq))!
      appendExpansion(bench.session, 'grep-one', { seq: one.seq, formatVersion: SESSION_FORMAT_VERSION, grep: 'row 55' })
      appendExpansion(bench.session, 'lines-two', { seq: two.seq, formatVersion: SESSION_FORMAT_VERSION, lines: '10-12' })
      await bench.run()
      expect(FOLD_STATS.get(bench.session)).toMatchObject({ expanded: 2, backedOff: [] })

      appendResult(bench.session, 'three', BIG, 3)
      await bench.run()
      for (const [index, locator] of [
        { seq: one.seq, formatVersion: SESSION_FORMAT_VERSION },
        { seq: view.seq, formatVersion: SESSION_FORMAT_VERSION, block: 1 },
        { turn: 1, step: 1, call: 1 },
      ].entries()) appendExpansion(bench.session, `full-one-${index}`, locator)
      await bench.run()
      expect(FOLD_STATS.get(bench.session)).toMatchObject({ folded: 3, expanded: 5, backedOff: [] })

      appendExpansion(bench.session, 'full-two', { seq: two.seq, formatVersion: SESSION_FORMAT_VERSION })
      await bench.run()
      expect(FOLD_STATS.get(bench.session)?.backedOff).toEqual(['["read","path","data.txt"]'])
      appendResult(bench.session, 'four', BIG, 5)
      appendResult(bench.session, 'other-file', BIG, 6, 'read', { path: 'other.txt' })
      await bench.run()
      expect(FOLD_STATS.get(bench.session)?.folded).toBe(4)
    } finally { await bench.ctx.fiber.dispose() }
  })

  it('scopes pathless calls by canonical arguments without disabling unrelated commands', async () => {
    const bench = await folderHarness()
    try {
      const args = { command: 'report', options: { cwd: '/repo', flags: ['a', 'b'] } }
      const reordered = { options: { flags: ['a', 'b'], cwd: '/repo' }, command: 'report' }
      const one = appendResult(bench.session, 'one', BIG, 1, 'bash', args)
      const two = appendResult(bench.session, 'two', BIG, 2, 'bash', reordered)
      await bench.run()
      // Empty grep and malformed lines both take execute's full-result fallback.
      appendExpansion(bench.session, 'full-one', { seq: one.seq, formatVersion: SESSION_FORMAT_VERSION, grep: ' ' })
      appendExpansion(bench.session, 'full-two', { seq: two.seq, formatVersion: SESSION_FORMAT_VERSION, lines: 'not-a-range' })
      await bench.run()
      expect(FOLD_STATS.get(bench.session)?.backedOff).toEqual(['["bash","arguments",{"command":"report","options":{"cwd":"/repo","flags":["a","b"]}}]'])
      appendResult(bench.session, 'same', BIG, 5, 'bash', reordered)
      appendResult(bench.session, 'other-command', BIG, 6, 'bash', { ...args, command: 'test' })
      appendResult(bench.session, 'other-flags', BIG, 7, 'bash', { command: 'report', options: { cwd: '/repo', flags: ['b', 'a'] } })
      await bench.run()
      expect(FOLD_STATS.get(bench.session)?.folded).toBe(4)
    } finally { await bench.ctx.fiber.dispose() }
  })

  it('keeps exact expansion ordinals across cursors after more than 64 earlier events of the same step', async () => {
    const bench = await folderHarness()
    try {
      for (let i = 1; i <= 70; i += 1) appendResult(bench.session, `old-${i}`, `short result ${i}`)
      await bench.run()
      const original = appendResult(bench.session, 'last', BIG)
      await bench.run()
      const replacement = bench.session.snapshotEvents().find((event) =>
        event.type === 'tool/result' && isReplacementSurfaceEvent(event) && event.sourceEventSeqs?.[0] === original.seq)
      expect(JSON.stringify(replacement)).toContain('"call\\": 71')
      expect(fullResultAt(bench.session.snapshotEvents(), 1, 3, 71)).toEqual({ name: 'read', text: BIG })
      expect(fullResultAt(bench.session.snapshotEvents(), 1, 3, 70)?.text).toBe('short result 70')
    } finally { await bench.ctx.fiber.dispose() }
  })

  it('preserves each sibling result, error and non-text content, and expands every original text', async () => {
    const bench = await folderHarness()
    try {
      for (const id of ['first', 'second', 'error']) {
        bench.session.append('tool/call', {
          turn: 1, step: 3, callId: ToolCallId(id), name: 'read', arguments: '{"file_path":"data.txt"}',
        })
      }
      // Session format V4: parallel calls in one step log one tool-role result event each.
      const first = createToolResultMessage({ callId: ToolCallId('first'), isError: false, content: [
        { type: 'text', text: BIG }, { type: 'reasoning', text: 'opaque non-text content' },
      ] })
      const second = createToolResultMessage({ callId: ToolCallId('second'), isError: false, content: [{ type: 'text', text: `${BIG}\nSECOND END` }] })
      const error = createToolResultMessage({ callId: ToolCallId('error'), isError: true, content: [{ type: 'text', text: `ERROR CONTENT\n${BIG}` }] })
      const originals = [first, second, error].map((message) => bench.session.append('tool/result', { turn: 1, step: 3, message }, { surfaceOp: 'append' }))
      await bench.run()
      const replacementOf = (seq: number) => bench.session.snapshotEvents().find((event) =>
        event.type === 'tool/result' && isReplacementSurfaceEvent(event) && event.sourceEventSeqs?.[0] === seq)
      const [one, two, failed] = originals.map((original) => replacementOf(original.seq))
      if (one?.type !== 'tool/result' || two?.type !== 'tool/result') throw new Error('missing replacement')
      expect(one.data.message).toMatchObject({ role: 'tool', toolCallId: 'first', isError: false })
      expect(one.data.message.content).toHaveLength(2)
      expect(one.data.message.content[1]).toEqual(first.content[1])
      expect(one.data.message.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('expand_result') })
      expect(two.data.message.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('expand_result') })
      // An error result is never condensed.
      expect(failed).toBeUndefined()
      expect(fullResultAt(bench.session.snapshotEvents(), 1, 3, 1)).toEqual({ name: 'read', text: BIG })
      expect(fullResultAt(bench.session.snapshotEvents(), 1, 3, 2)).toEqual({ name: 'read', text: `${BIG}\nSECOND END` })
      expect(fullResultAt(bench.session.snapshotEvents(), 1, 3, 3)).toEqual({ name: 'read', text: `ERROR CONTENT\n${BIG}` })
      expect(originals.map((original) => original.data.message)).toEqual([first, second, error])
      expect(FOLD_STATS.get(bench.session)?.folded).toBe(2)
    } finally { await bench.ctx.fiber.dispose() }
  })

  it('replays fold counts and expansion backoff from exact durable replacement messages', async () => {
    const live = await folderHarness()
    try {
      appendResult(live.session, 'read-one', BIG, 1)
      await live.run()
      live.session.append('tool/call', { turn: 1, step: 2, callId: ToolCallId('expand-one'), name: EXPAND_TOOL_NAME, arguments: '{"turn":1,"step":1,"call":1}' })
      live.session.append('tool/result', { turn: 1, step: 2, message: createToolResultMessage({ callId: ToolCallId('expand-one'), isError: false, content: [{ type: 'text', text: 'recovered evidence' }] }) }, { surfaceOp: 'append' })
      await live.run()
      appendResult(live.session, 'read-two', BIG, 3)
      await live.run()
      live.session.append('tool/call', { turn: 1, step: 4, callId: ToolCallId('expand-two'), name: EXPAND_TOOL_NAME, arguments: '{"turn":1,"step":3,"call":1}' })
      live.session.append('tool/result', { turn: 1, step: 4, message: createToolResultMessage({ callId: ToolCallId('expand-two'), isError: false, content: [{ type: 'text', text: 'recovered evidence' }] }) }, { surfaceOp: 'append' })
      await live.run()
      const replay = await folderHarness(live.session.snapshotEvents())
      try {
        await replay.run()
        expect(FOLD_STATS.get(replay.session)).toEqual(FOLD_STATS.get(live.session))
        expect(FOLD_STATS.get(replay.session)?.backedOff).toEqual(['["read","path","data.txt"]'])
        appendResult(live.session, 'after-backoff', BIG, 5)
        appendResult(replay.session, 'after-backoff', BIG, 5)
        await live.run()
        await replay.run()
        expect(FOLD_STATS.get(replay.session)).toEqual(FOLD_STATS.get(live.session))
        expect(FOLD_STATS.get(replay.session)?.folded).toBe(2)
      } finally { await replay.ctx.fiber.dispose() }
    } finally { await live.ctx.fiber.dispose() }
  })

  it('deduplicates repeated selections of one result and does not charge its siblings', async () => {
    const bench = await folderHarness()
    try {
      const pair = (step: number, suffix: string) => ([['read', 'read'], ['bash', 'bash']] as const).map(([id, name]) =>
        appendResult(bench.session, `${id}-${suffix}`, BIG, step, name))
      const [readOne, bashOne] = pair(1, 'one')
      await bench.run()
      // The only block of a V4 result is block 1: selecting it and omitting it name the same evidence.
      for (let n = 1; n <= 2; n++) {
        const callId = ToolCallId(`block-expansion-${n}`)
        bench.session.append('tool/call', { turn: 1, step: 2, callId, name: EXPAND_TOOL_NAME, arguments: JSON.stringify({ formatVersion: SESSION_FORMAT_VERSION, seq: readOne!.seq, block: 1 }) })
        bench.session.append('tool/result', { turn: 1, step: 2, message: createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: BIG }] }) }, { surfaceOp: 'append' })
        await bench.run()
      }
      expect(FOLD_STATS.get(bench.session)).toMatchObject({ expanded: 2, backedOff: [] })
      appendExpansion(bench.session, 'all-read-one', { seq: readOne!.seq, formatVersion: SESSION_FORMAT_VERSION })
      await bench.run()
      expect(FOLD_STATS.get(bench.session)).toMatchObject({ expanded: 3, backedOff: [] })
      // A block beyond the single result selects nothing and is not counted.
      appendExpansion(bench.session, 'missing-block', { seq: readOne!.seq, formatVersion: SESSION_FORMAT_VERSION, block: 2 })
      await bench.run()
      expect(FOLD_STATS.get(bench.session)).toMatchObject({ expanded: 3, backedOff: [] })
      appendExpansion(bench.session, 'all-bash-one', { seq: bashOne!.seq, formatVersion: SESSION_FORMAT_VERSION })
      await bench.run()
      expect(FOLD_STATS.get(bench.session)).toMatchObject({ expanded: 4, backedOff: [] })

      // New originals are independent; recovering the read sibling must not charge bash.
      const [readTwo, bashTwo] = pair(3, 'two')
      await bench.run()
      appendExpansion(bench.session, 'read-two', { seq: readTwo!.seq, formatVersion: SESSION_FORMAT_VERSION, block: 1 })
      await bench.run()
      expect(FOLD_STATS.get(bench.session)?.backedOff).toEqual(['["read","path","data.txt"]'])
      appendExpansion(bench.session, 'bash-two', { seq: bashTwo!.seq, formatVersion: SESSION_FORMAT_VERSION })
      await bench.run()
      expect(FOLD_STATS.get(bench.session)?.backedOff).toEqual(['["read","path","data.txt"]', '["bash","path","data.txt"]'])
    } finally { await bench.ctx.fiber.dispose() }
  })

  it('does not attribute an unrelated surface replacement to this fold plugin', async () => {
    const live = await folderHarness()
    try {
      const original = appendResult(live.session, 'external', BIG)
      live.session.append('tool/result', {
        ...original.data,
        message: { ...original.data.message, content: [{ type: 'text', text: '[another plugin summary]' }] },
      }, { surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] })
      await live.run()
      expect(FOLD_STATS.get(live.session)?.folded).toBe(0)
      live.session.append('tool/call', { turn: 1, step: 4, callId: ToolCallId('expand-external'), name: EXPAND_TOOL_NAME, arguments: '{"turn":1,"step":3,"call":1}' })
      await live.run()
      expect(FOLD_STATS.get(live.session)?.expanded).toBe(0)
    } finally { await live.ctx.fiber.dispose() }
  })
})

import SpillLocal from '@deepseek-ai/dsh-spill-local'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
describe('spill preview arm', () => {
  it('a 60K bash result is stored through the spill store and the model sees the content-routed digest with the locator', async () => {
    const LOG = Array.from({ length: 1200 }, (_, i) => (i === 700 ? '2026-09-04 10:00:00 ERROR worker 7 failed: boom' : `2026-09-04 10:00:00 INFO tick ${i} ${'x'.repeat(30)}`)).join('\n')
    expect(LOG.length).toBeGreaterThan(60000)
    const adapter = new MockAdapter([toolCallResponse('c1', 'bash', { file_path: 'run' }), toolCallResponse('c2', 'bash', { file_path: 'run' }), toolCallResponse('c3', 'bash', { file_path: 'run' }), textResponse('done')])
    const ctx = new Context()
    await ctx.plugin(LlmService); await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRegistry); await ctx.plugin(AgentRegistry)
    await ctx.plugin(InvariantService); await ctx.plugin(agentLoopInvariant); await ctx.plugin(SessionProjections); await ctx.plugin(StockAgentLoop, {} as never)
    await ctx.plugin(SpillLocal, { root: mkdtempSync(join(tmpdir(), 'spill-')) } as never)
    await ctx.plugin(SpillPolicy, { maxInlineTokens: 12_500 })   // DSH 0.1.7 token budget, about 50 KB of this ASCII log
    await ctx.plugin(fold, { pinSteps: 0, spillPreviewMinBytes: 50000 } as never)
    ctx.tools.register(defineContentToolFixture({ name: 'bash', description: 'bash', parameters: { file_path: { type: 'string' } }, execute: async () => [{ type: 'text', text: LOG }] }))
    ctx.llm.registerAdapter(['mock'], adapter)
    const handle = await ctx.agents.create({ sessionId: SessionId('fold-spill'), agentOptions: { provider: 'mock', model: 'mock' } })
    send(handle.agent, 'run it three times')
    await handle.agent.whenIdle()
    const second = requestText(adapter, 1)
    expect(second).toContain('ERROR worker 7 failed')                 // 错误行留在视图里
    expect(second).toContain('stored at')                              // 定位
    expect(second).not.toContain('tick 300 ')                          // 噪音没进上下文
    expect(second).not.toContain('Omitted')                            // spill-policy 没有再做头尾预览
    expect(FOLD_STATS.get(handle.agent.session)!.spilled).toBeGreaterThanOrEqual(1)
    expect(adapter.requests).toHaveLength(4)                           // 不变量全程成立
  })
})
