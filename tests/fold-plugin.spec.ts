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
import LlmService, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import StockAgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as agentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import fold, { EXPAND_TOOL_NAME, FOLD_STATS } from '../src/fold/index.js'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.js'

const BIG = Array.from({ length: 120 }, (_, i) => (i % 10 === 0 ? `section_${i / 10}: header` : `row ${i} payload ${'x'.repeat(30)} ${i * 7}`)).join('\n')
const CODE = Array.from({ length: 80 }, (_, i) => `def f${i}(x):\n    return x + ${i}`).join('\n')

async function harness(adapter: MockAdapter, tools: Array<{ name: string; text: string; isError?: boolean }>): Promise<Context> {
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
  await ctx.plugin(fold, {})
  for (const t of tools) {
    ctx.tools.register(defineContentToolFixture({
      name: t.name,
      description: t.name,
      parameters: { file_path: { type: 'string', required: true } },
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
