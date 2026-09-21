/** 配置键校验:退役键给迁移说明,拼错/未知键给最近的合法键——拼错不是退役。
 *  顶层键由 checkConfigKeys 纯函数校验;history 小节的键在装载插件时校验,所以那几例走原生 harness。 */
import { afterEach, describe, expect, it } from 'vitest'
import { checkConfigKeys } from '../src/index.js'
import { nativeHarness, type NativeHarness } from './native-harness.js'

const live: NativeHarness[] = []
afterEach(async () => { for (const harness of live.splice(0).reverse()) await harness.ctx.fiber.dispose() })

/** 装载一次插件:构造函数里解析 history 小节,非法键在这里抛出。 */
async function load(history: object): Promise<void> {
  const harness = await nativeHarness([], { config: { history } as never })
  live.push(harness)
}

describe('checkConfigKeys', () => {
  it('accepts every documented key', () => {
    expect(() => checkConfigKeys({
      maxHistoryChars: 1, maxRequestChars: 1, maxStepsPerTurn: 1, defaultReasoningEffort: 'low', digest: {}, fold: {}, history: {}, mode: 'slice',
    })).not.toThrow()
  })

  it('accepts the tape history section and suggests it for a typo', () => {
    expect(() => checkConfigKeys({ history: { keepRecentTurns: 2 } })).not.toThrow()
    expect(() => checkConfigKeys({ histroy: { keepRecentTurns: 2 } }))
      .toThrow('Unknown slice configuration key histroy. Did you mean history?')
    // 小节内容不归它管:顶层只认得 history 这个名字,里面的键由装载时的 resolveHistory 校验。
    expect(() => checkConfigKeys({ history: { highWaterChars: 20_000 } })).not.toThrow()
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

describe('history section keys', () => {
  it('requires enough space for a complete recall-only entry', async () => {
    await expect(load({ entryMaxChars: 255 })).rejects.toThrow('history.entryMaxChars must be at least 256')
    await load({ entryMaxChars: 256 })
  })

  it('accepts every documented history key', async () => {
    await load({ keepRecentTurns: 1, pinFirstTurn: false, pinUserChars: 600, entryMaxChars: 4_000 })
  })

  it('names each retired water-mark knob as retired and says where it went', async () => {
    await expect(load({ highWaterChars: 20_000 }))
      .rejects.toThrow('Retired history configuration highWaterChars: every completed turn is sealed, so there is no pressure threshold to cross')
    await expect(load({ lowWaterChars: 12_000 }))
      .rejects.toThrow('Retired history configuration lowWaterChars: every completed turn is sealed, so there is no archive target to fall back to')
    await expect(load({ keepRecentChars: 4_000 }))
      .rejects.toThrow('Retired history configuration keepRecentChars: use history.keepRecentTurns')
    await expect(load({ checkpointMaxChars: 8_000 }))
      .rejects.toThrow('Retired history configuration checkpointMaxChars: renamed to history.entryMaxChars')
  })

  it('reports anything else in the section as unknown and lists the valid keys', async () => {
    await expect(load({ keepRecent: 2 }))
      .rejects.toThrow('Unknown history configuration keepRecent; valid keys: keepRecentTurns, pinFirstTurn, pinUserChars, entryMaxChars')
    // 退役键与未知键是两种错:未知键不冒充迁移说明。
    await expect(load({ keepRecent: 2 })).rejects.not.toThrow('Retired history configuration')
  })
})

describe('optional step cap', () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '50'])(
    'rejects an invalid explicit cap: %s', async value => {
      await expect(nativeHarness([], { config: { maxStepsPerTurn: value } as never }))
        .rejects.toThrow('maxStepsPerTurn must be a positive safe integer')
    },
  )
})
