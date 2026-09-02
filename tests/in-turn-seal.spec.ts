/**
 * 轮内封存的契约测试(mock adapter,零 API):阈值触发、请求重组、原文可召回。
 *
 * 设定极小阈值(sealTokens=1)让封存在第 4 步前触发:已完成 3 步、batch 2 + keep 1
 * → 封存 step 1–2,保留 step 3 原文。断言:第 4 次请求含 SEALED STEPS 块与精确
 * 切口、不再含 step 1 的完整结果;step 3 原文仍在;审计事件落账;recall_step
 * 从会话日志逐字取回 step 1。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmService, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import apply from '../src/index.js'
import { STEP_TAPE_HDR } from '../src/slice/step-tape.js'
import { renderSealedStepPage } from '../src/recall-step.js'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.js'

const LONG = 'L' + 'x'.repeat(2400) + 'R'

describe('in-turn sealing', () => {
  it('seals the oldest batch past the threshold, keeps the tail raw, and recalls verbatim', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { n: 1 }),
      toolCallResponse('c2', 'probe', { n: 2 }),
      toolCallResponse('c3', 'probe', { n: 3 }),
      toolCallResponse('c4', 'probe', { n: 4 }),
      textResponse('done'),
    ])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(apply, { inTurnSeal: { enabled: true, sealTokens: 1, batchSteps: 2, keepSteps: 1 } })
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'probe',
      description: 'returns a long payload tagged by n',
      parameters: { n: { type: 'number', required: true } },
      execute: async ({ n }) => [{ type: 'text', text: `payload-${n}:${LONG}` }],
    }))
    const handle = await ctx.agents.create({
      sessionId: SessionId('seal-contract'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run the probes' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()

    expect(adapter.requests).toHaveLength(5)
    const text = (i: number) => JSON.stringify(adapter.requests[i]!.messages)

    // 第 4 次请求(step 4):step 1–2 已封存,step 3 原文保留。
    expect(text(3)).toContain(STEP_TAPE_HDR.slice(0, 20))
    expect(text(3)).toContain('chars in sealed step]')
    expect(text(3)).not.toContain(`payload-1:${LONG}`)
    expect(text(3)).toContain(`payload-3:${LONG}`)
    // 第 3 次请求(step 3)还没到阈值条件(已完成 2 步 < batch+keep),仍是全原文。
    expect(text(2)).toContain(`payload-1:${LONG}`)
    expect(text(2)).not.toContain('SEALED STEPS')

    const seals = handle.agent.session.events.filter(e => e.type === 'slice/step-seal')
    expect(seals).toHaveLength(1)
    expect((seals[0]!.data as { sealedThrough: number; sealedSteps: number }).sealedThrough).toBe(2)
    const lastSlice = handle.agent.session.events.filter(e => e.type === 'slice/request-slice').at(-1)!
    expect((lastSlice.data as { sealedThrough?: number }).sealedThrough).toBe(2)

    // 召回:会话日志里 step 1 的完整结果逐字可得。
    const page = renderSealedStepPage(handle.agent.session.events, 1, 1)
    expect(page).not.toBeNull()
    expect(page).toContain(`payload-1:${LONG}`)
    expect(page).toContain('probe(')
  })

  it('is byte-for-byte the old behavior when disabled', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { n: 1 }),
      toolCallResponse('c2', 'probe', { n: 2 }),
      toolCallResponse('c3', 'probe', { n: 3 }),
      textResponse('done'),
    ])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(apply, {})
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'probe',
      description: 'returns a long payload',
      parameters: { n: { type: 'number', required: true } },
      execute: async ({ n }) => [{ type: 'text', text: `payload-${n}:${LONG}` }],
    }))
    const handle = await ctx.agents.create({ sessionId: SessionId('seal-off'), agentOptions: { provider: 'mock', model: 'mock' } })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    expect(JSON.stringify(adapter.requests[3]!.messages)).not.toContain('SEALED STEPS')
    expect(handle.agent.session.events.filter(e => e.type === 'slice/step-seal')).toHaveLength(0)
  })
})
