/**
 * fold 与 slice loop 一起挂时的两条契约(深评审 A-RT-12 尾项、A-RT-08):
 *   ① 折叠只发生在真正会进入的那一步——被 slice 的 maxStepsPerTurn 拒掉的步不折
 *      (那一步不再构造请求,先折就是一次没人看的 surface 替换 + 日志写入);
 *   ② slice 挂着时 recall_step 已注册,fold 可供性才提它;可供性里的 grep/glob 措辞与实现一致。
 */
import { describe, expect, it } from 'vitest'
import { SessionId, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { FOLD_STATS } from '../src/fold/index.js'
import { nativeHarness, nativeSend, nativeText, nativeTool } from './native-harness.js'

const BIG = Array.from({ length: 120 }, (_, i) => (i % 10 === 0 ? `section_${i / 10}: header` : `row ${i} payload ${'x'.repeat(30)} ${i * 7}`)).join('\n')

async function slice(maxStepsPerTurn: number) {
  const h = await nativeHarness([
    nativeTool('c1', 'read', { file_path: 'a.txt' }),
    nativeTool('c2', 'read', { file_path: 'b.txt' }),
    nativeText('done'),
  ], { config: { maxStepsPerTurn, fold: { pinSteps: 0 }, digest: { minChars: 1500 } } })
  h.ctx.tools.register(defineContentToolFixture({
    name: 'read', description: 'read', parameters: { file_path: { type: 'string' } },
    execute: async () => [{ type: 'text', text: BIG }],
  }))
  const handle = await h.ctx.agents.create({ sessionId: SessionId(`fold-reject-${maxStepsPerTurn}`), agentOptions: { provider: 'native-mock', model: 'mock' } })
  return { h, handle }
}

describe('fold defers to the step decision', () => {
  it('does not fold the previous result on a step the slice loop rejects', async () => {
    const { h, handle } = await slice(2)
    try {
      await nativeSend(handle.agent, 'go')
      // 第 3 步被拒:只有两次派发,只有第 1 步的结果被折(在第 2 步的 pre-step 上)。
      expect(h.adapter.requests).toHaveLength(2)
      expect(FOLD_STATS.get(handle.agent.session)!.folded).toBe(1)
      const replacements = handle.agent.session.snapshotEvents().filter((e) => e.type === 'tool/result' && isReplacementSurfaceEvent(e))
      expect(replacements).toHaveLength(1)
      expect((replacements[0] as { data: { step: number } }).data.step).toBe(1)
    } finally { await h.ctx.fiber.dispose() }
  })

  it('still folds every entered step when the limit is not reached', async () => {
    const { h, handle } = await slice(50)
    try {
      await nativeSend(handle.agent, 'go')
      expect(h.adapter.requests).toHaveLength(3)
      expect(FOLD_STATS.get(handle.agent.session)!.folded).toBe(2)
    } finally { await h.ctx.fiber.dispose() }
  })
})

describe('fold affordance under the slice loop', () => {
  it('names expand_result and recall_step, and states the real grep/glob contract', async () => {
    const { h, handle } = await slice(50)
    try {
      await nativeSend(handle.agent, 'go')
      const system = h.adapter.requests[0]!.messages.filter(message => message.role === 'system')
        .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
      expect(system).toContain('expand_result({"turn": t, "step": s, "call": n})')
      expect(system).toContain('recall_step({"turn": t, "step": s})')      // 注册了却无人教学 → 已修
      expect(system).toContain('[... and N more matches in <file>]')
      expect(system).not.toContain('grep/glob results are never condensed')
    } finally { await h.ctx.fiber.dispose() }
  })
})
