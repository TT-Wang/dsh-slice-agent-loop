/**
 * tool-result-fold 插件契约:挂在 dsh 原生 AgentLoop 上(不挂 slice loop)。
 *   ① 大的数据型结果在下一步请求里是折叠视图,原文仍在日志(追加态节点被替换事件遮蔽);
 *   ② 源代码结果不折;错误结果不折;
 *   ③ expand_result 逐字取回原文;
 *   ④ 原生 loop 的请求重建不变量(request == deriveMessages)在替换后仍成立。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import LlmService, { createUserMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, isAppendSurfaceEvent, isReplacementSurfaceEvent, type Session, type ToolResultMessage } from '@deepseek-ai/dsh-session'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import StockAgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as agentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import fold, { EXPAND_TOOL_NAME, FOLD_STATS, fullResultAt } from '../src/fold/index.js'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.js'

const BIG = Array.from({ length: 120 }, (_, i) => (i % 10 === 0 ? `section_${i / 10}: header` : `row ${i} payload ${'x'.repeat(30)} ${i * 7}`)).join('\n')
const CODE = Array.from({ length: 80 }, (_, i) => `def f${i}(x):\n    return x + ${i}`).join('\n')

class TestSettings extends SettingsProvider {
  readonly writable = false
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(): Promise<void> { return Promise.reject(new Error('read-only test settings')) }
}

async function harness(adapter: MockAdapter, tools: Array<{ name: string; text: string; isError?: boolean }>, config: { pinSteps?: number; digest?: Record<string, unknown> } = { pinSteps: 0, digest: { minChars: 1500 } }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(TestSettings)
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

describe('pinned early steps', () => {
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
  it('stops folding a tool\'s results once the model has expanded them twice', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: 'a.txt' }),                       // step 1: folded
      toolCallResponse('c2', EXPAND_TOOL_NAME, { turn: 1, step: 1, call: 1 }),      // step 2: expand #1
      toolCallResponse('c3', 'read', { file_path: 'b.txt' }),                       // step 3: folded
      toolCallResponse('c4', EXPAND_TOOL_NAME, { turn: 1, step: 3, call: 1 }),      // step 4: expand #2 → back off `read`
      toolCallResponse('c5', 'read', { file_path: 'c.txt' }),                       // step 5: NOT folded
      textResponse('done'),
    ])
    const ctx = await harness(adapter, [{ name: 'read', text: BIG }], { pinSteps: 0, digest: { minChars: 1500 } })
    const handle = await ctx.agents.create({ sessionId: SessionId('fold-backoff'), agentOptions: { provider: 'mock', model: 'mock' } })
    send(handle.agent, 'go')
    await handle.agent.whenIdle()
    const stats = FOLD_STATS.get(handle.agent.session)!
    expect(stats.folded).toBe(2)
    expect(stats.expanded).toBe(2)
    expect(stats.backedOff).toEqual(['read'])
    expect(requestText(adapter, 5)).toContain('row 55 payload')                    // 第 5 步的结果原样进了第 6 个请求
    expect(requestText(adapter, 5)).not.toContain('"step\\": 5')
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

function appendResult(session: Session, id: string, text: string, step = 3) {
  const callId = ToolCallId(id)
  session.append('tool/call', { turn: 1, step, callId, name: 'read', arguments: '{"file_path":"data.txt"}' })
  return session.append('tool/result', {
    turn: 1, step, message: createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text }] }),
  }, { surfaceOp: 'append' })
}

describe('fold result identity and replay', () => {
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

  it('preserves every sibling result block, error and non-text block, and expands all original text', async () => {
    const bench = await folderHarness()
    try {
      for (const id of ['first', 'second', 'error']) {
        bench.session.append('tool/call', {
          turn: 1, step: 3, callId: ToolCallId(id), name: 'read', arguments: '{"file_path":"data.txt"}',
        })
      }
      const first = createToolResultMessage({ callId: ToolCallId('first'), isError: false, content: [
        { type: 'text', text: BIG }, { type: 'reasoning', text: 'opaque non-text content' },
      ] })
      const second = createToolResultMessage({ callId: ToolCallId('second'), isError: false, content: [{ type: 'text', text: `${BIG}\nSECOND END` }] })
      const error = createToolResultMessage({ callId: ToolCallId('error'), isError: true, content: [{ type: 'text', text: `ERROR CONTENT\n${BIG}` }] })
      const message = { ...first, content: [...first.content, ...second.content, ...error.content] } as unknown as ToolResultMessage
      const original = bench.session.append('tool/result', { turn: 1, step: 3, message }, { surfaceOp: 'append' })
      await bench.run()
      const replacement = bench.session.snapshotEvents().find((event) =>
        event.type === 'tool/result' && isReplacementSurfaceEvent(event) && event.sourceEventSeqs?.[0] === original.seq)
      expect(replacement?.type).toBe('tool/result')
      if (replacement?.type !== 'tool/result') throw new Error('missing replacement')
      const blocks = replacement.data.message.content as readonly { content: readonly { type: string; text?: string }[] }[]
      expect(blocks).toHaveLength(3)
      expect(blocks[0]?.content[1]).toEqual(first.content[0].content[1])
      expect(blocks[2]).toEqual(error.content[0])
      expect(blocks[0]?.content[0]?.text).toContain('expand_result')
      expect(blocks[1]?.content[0]?.text).toContain('expand_result')
      expect(fullResultAt(bench.session.snapshotEvents(), 1, 3, 1)).toEqual({
        name: 'read', text: `${BIG}\n${BIG}\nSECOND END\nERROR CONTENT\n${BIG}`,
      })
      expect(original.data.message).toEqual(message)
    } finally { await bench.ctx.fiber.dispose() }
  })

  it('replays fold counts and expansion backoff from exact durable replacement messages', async () => {
    const live = await folderHarness()
    try {
      appendResult(live.session, 'read-one', BIG, 1)
      await live.run()
      live.session.append('tool/call', { turn: 1, step: 2, callId: ToolCallId('expand-one'), name: EXPAND_TOOL_NAME, arguments: '{"turn":1,"step":1,"call":1}' })
      await live.run()
      appendResult(live.session, 'read-two', BIG, 3)
      await live.run()
      live.session.append('tool/call', { turn: 1, step: 4, callId: ToolCallId('expand-two'), name: EXPAND_TOOL_NAME, arguments: '{"turn":1,"step":3,"call":1}' })
      await live.run()
      const replay = await folderHarness(live.session.snapshotEvents())
      try {
        await replay.run()
        expect(FOLD_STATS.get(replay.session)).toEqual(FOLD_STATS.get(live.session))
        expect(FOLD_STATS.get(replay.session)?.backedOff).toEqual(['read'])
        appendResult(live.session, 'after-backoff', BIG, 5)
        appendResult(replay.session, 'after-backoff', BIG, 5)
        await live.run()
        await replay.run()
        expect(FOLD_STATS.get(replay.session)).toEqual(FOLD_STATS.get(live.session))
        expect(FOLD_STATS.get(replay.session)?.folded).toBe(2)
      } finally { await replay.ctx.fiber.dispose() }
    } finally { await live.ctx.fiber.dispose() }
  })

  it('does not attribute an unrelated surface replacement to this fold plugin', async () => {
    const live = await folderHarness()
    try {
      const original = appendResult(live.session, 'external', BIG)
      live.session.append('tool/result', {
        ...original.data,
        message: { ...original.data.message, content: [{ ...original.data.message.content[0], content: [{ type: 'text', text: '[another plugin summary]' }] }] },
      }, { surfaceOp: { op: 'replace', start: original.seq, end: original.seq }, sourceEventSeqs: [original.seq] })
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
    await ctx.plugin(TestSettings)
    await ctx.plugin(LlmService); await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRegistry); await ctx.plugin(AgentRegistry)
    await ctx.plugin(InvariantService); await ctx.plugin(agentLoopInvariant); await ctx.plugin(SessionProjections); await ctx.plugin(StockAgentLoop, {} as never)
    await ctx.plugin(SpillLocal, { root: mkdtempSync(join(tmpdir(), 'spill-')) } as never)
    await ctx.plugin(SpillPolicy as never, { maxInlineBytes: 50000 } as never)
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
