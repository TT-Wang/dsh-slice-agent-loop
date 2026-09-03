/** effort 默认注入的语义测试:显式值永不覆盖 / undefined 注入 / inherit 退出。 */
import { describe, expect, it } from 'vitest'
import { applyEffortDefault, DEFAULT_REASONING_EFFORT } from '../src/effort-default.js'

describe('applyEffortDefault', () => {
  it('injects the configured default when nobody chose', () => {
    expect(applyEffortDefault({ provider: 'deepseek' } as { provider: string; reasoningEffort?: string }, 'low'))
      .toEqual({ provider: 'deepseek', reasoningEffort: 'low' })
  })
  it('never overrides an explicit choice — including explicit high and off', () => {
    for (const explicit of ['off', 'low', 'high', 'max']) {
      expect(applyEffortDefault({ reasoningEffort: explicit }, 'low')).toEqual({ reasoningEffort: explicit })
    }
  })
  it("'inherit' opts out entirely (adapter default wins downstream)", () => {
    const proposed = { provider: 'deepseek' } as { provider: string; reasoningEffort?: string }
    expect(applyEffortDefault(proposed, 'inherit')).toBe(proposed)
  })
  it('factory default is low (the ladder ruling)', () => {
    expect(DEFAULT_REASONING_EFFORT).toBe('low')
  })
})
