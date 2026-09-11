/** 配置键校验:退役键给迁移说明,拼错/未知键给最近的合法键——拼错不是退役。 */
import { describe, expect, it } from 'vitest'
import { checkConfigKeys } from '../src/index.js'

describe('checkConfigKeys', () => {
  it('accepts every documented key', () => {
    expect(() => checkConfigKeys({
      maxHistoryChars: 1, maxRequestChars: 1, maxStepsPerTurn: 1, defaultReasoningEffort: 'low', digest: {}, fold: {}, mode: 'slice',
    })).not.toThrow()
  })

  it('names a retired key as retired and says where it went', () => {
    expect(() => checkConfigKeys({ maxParallelToolCalls: 4 }))
      .toThrow('Retired slice configuration maxParallelToolCalls: scheduling belongs to the stock agent-loop row')
    for (const key of ['inTurnSeal', 'tape', 'state']) {
      expect(() => checkConfigKeys({ [key]: {} })).toThrow(`Retired slice configuration ${key}:`)
    }
  })

  it('reports a typo as unknown and suggests the nearest valid key', () => {
    expect(() => checkConfigKeys({ maxHistoryChar: 1 }))
      .toThrow('Unknown slice configuration key maxHistoryChar. Did you mean maxHistoryChars?')
    expect(() => checkConfigKeys({ MAXREQUESTCHARS: 1 })).toThrow('Did you mean maxRequestChars?')
  })

  it('lists the valid keys when nothing is close', () => {
    expect(() => checkConfigKeys({ banana: 1 }))
      .toThrow(/^Unknown slice configuration key banana\. Valid keys: maxHistoryChars, maxRequestChars,/)
  })
})
