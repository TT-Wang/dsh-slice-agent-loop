/**
 * 归因核心 + sidecar 记账的行为测试。
 *
 * 七条。前五条钉 verdict 语义（healthy append / tape 漂移 / runtime-context
 * 易变 / system 漂移 / 尺寸可疑），第六条钉 usage 形状容忍，第七条钉记账的
 * flag 门控与落盘往返。种子一律经真实 assembleSlice 构造——归因对的是装配的
 * 真字节，不是测试自造的近似。
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { assembleSlice, type SliceInput } from '../src/slice/assemble.js'
import { baseEntry, digestEntry, type TapeEntry } from '../src/slice/tape.js'
import {
  BLOCK_TOKENS,
  analyze,
  calibrateCharsPerToken,
  findDivergence,
  tapeContentEnd,
  zoneAt,
  type CallRecord,
  type SeedRecord,
} from '../src/slice/miss-attribution.js'
import {
  normalizeUsage,
  recordCallEvent,
  recordSeedEvent,
  resetCallLedgerForTest,
} from '../src/call-ledger.js'

const SYSTEM = 'kernel prompt v1\n\nhost sections'

function sliceInput(tape: TapeEntry[], overrides: Partial<SliceInput> = {}): SliceInput {
  return {
    request: '下一步',
    goal: '把功能做完',
    tape,
    openFiles: 'a.py · 12 lines · sha256:aaaaaaaaaaaa',
    lastError: '',
    contributions: [],
    ...overrides,
  }
}

function seedOf(turn: number, input: SliceInput, runtimeContext = ''): SeedRecord {
  const assembled = assembleSlice(input, SYSTEM)
  return { turn, system: assembled.system, runtimeContext, user: assembled.user }
}

/** first-call CallRecord whose reported miss lands near the expectation. */
function callNear(turn: number, seed: SeedRecord, prev: SeedRecord, cpt: number, extraTokens = 0): CallRecord {
  const div = findDivergence(prev, seed)
  const expected = Math.round(div.freshChars / cpt)
  return {
    turn,
    step: 1,
    norm: { input: expected + extraTokens, cacheRead: 5_000, output: 200, reasoning: 120 },
  }
}

const TAPE_T1 = [
  digestEntry('[turn slice-turn-1 · task t · completed]\nask: 修一个 bug\n', 'slice-turn-1'),
  baseEntry('a.py', 'print(1)\n'),
]
const NEW_ENTRY = digestEntry('[turn slice-turn-2 · task t · completed]\nask: 加一个测试\n', 'slice-turn-2')

describe('miss attribution', () => {
  it('healthy boundary: tape appends, suffix changes → ok, divergence at tape tail', () => {
    const prev = seedOf(1, sliceInput(TAPE_T1))
    const next = seedOf(2, sliceInput([...TAPE_T1, NEW_ENTRY], {
      request: '再跑一遍测试',
      openFiles: 'a.py · 14 lines · sha256:bbbbbbbbbbbb',
    }))

    const div = findDivergence(prev, next)
    expect(div.field).toBe('user')
    // Append lands at (or just past) the sealed tape content of the previous
    // turn — never inside it.
    expect(div.offset).toBeGreaterThanOrEqual(tapeContentEnd(prev.user))
    expect(zoneAt(prev.user, div.offset)).toBe('tape')

    const cpt = 3.6
    const calls = [callNear(1, prev, prev, cpt), callNear(2, next, prev, cpt)]
    const analysis = analyze([prev, next], calls)
    expect(analysis.boundaries).toHaveLength(1)
    expect(analysis.boundaries[0]!.verdict).toBe('ok')
  })

  it('sealed tape byte changes → tape-drift', () => {
    const prev = seedOf(1, sliceInput(TAPE_T1))
    const mutated = [
      digestEntry('[turn slice-turn-1 · task t · completed]\nask: 修一个 BUG\n', 'slice-turn-1'),
      TAPE_T1[1]!,
      NEW_ENTRY,
    ]
    const next = seedOf(2, sliceInput(mutated))

    const div = findDivergence(prev, next)
    expect(div.field).toBe('user')
    expect(div.offset).toBeLessThan(tapeContentEnd(prev.user))
    const analysis = analyze([prev, next], [])
    expect(analysis.boundaries[0]!.verdict).toBe('tape-drift')
  })

  it('runtime-context churn → runtime-context-volatile (it precedes the whole slice)', () => {
    const prev = seedOf(1, sliceInput(TAPE_T1), '# RUNTIME CONTEXT (…)\nclock: 10:00')
    const next = seedOf(2, sliceInput([...TAPE_T1, NEW_ENTRY]), '# RUNTIME CONTEXT (…)\nclock: 10:05')
    expect(analyze([prev, next], []).boundaries[0]!.verdict).toBe('runtime-context-volatile')
  })

  it('system prefix change → system-drift', () => {
    const prev = seedOf(1, sliceInput(TAPE_T1))
    const next = { ...seedOf(2, sliceInput([...TAPE_T1, NEW_ENTRY])), system: SYSTEM + '\nlate-loaded section' }
    expect(analyze([prev, next], []).boundaries[0]!.verdict).toBe('system-drift')
  })

  it('healthy structure but oversized actual miss → suspect-size', () => {
    const prev = seedOf(1, sliceInput(TAPE_T1))
    const next = seedOf(2, sliceInput([...TAPE_T1, NEW_ENTRY]))
    const cpt = 3.6
    // 40 blocks of unexplained miss. analyze() 自校准 chars/token 会吸收一部分
    // 差额（超额 input 抬高 prompt tokens → 压低 cpt → 抬高内部期望值），所以
    // 断言的是语义边界——超出容差即 suspect——而不是外部预设 cpt 下的精确差值。
    const calls = [
      callNear(1, prev, prev, cpt),
      callNear(2, next, prev, cpt, 40 * BLOCK_TOKENS),
    ]
    const analysis = analyze([prev, next], calls)
    expect(analysis.boundaries[0]!.verdict).toBe('suspect-size')
    expect(analysis.boundaries[0]!.deltaBlocks).toBeGreaterThan(2)
  })

  it('normalizeUsage tolerates DeepSeek snake_case, camelCase, and generic details', () => {
    expect(normalizeUsage({
      prompt_tokens: 12_000,
      prompt_cache_hit_tokens: 10_000,
      prompt_cache_miss_tokens: 2_000,
      completion_tokens: 900,
      completion_tokens_details: { reasoning_tokens: 700 },
    })).toEqual({ input: 2_000, cacheRead: 10_000, output: 900, reasoning: 700 })

    expect(normalizeUsage({
      promptTokens: 5_000,
      promptCacheHitTokens: 4_000,
      completionTokens: 100,
    })).toEqual({ input: 1_000, cacheRead: 4_000, output: 100, reasoning: 0 })

    expect(normalizeUsage({
      prompt_tokens: 3_000,
      prompt_tokens_details: { cached_tokens: 2_500 },
      completion_tokens: 50,
    })).toEqual({ input: 500, cacheRead: 2_500, output: 50, reasoning: 0 })

    expect(normalizeUsage(undefined)).toBeUndefined()
    expect(normalizeUsage({ note: 'no numbers here' })).toBeUndefined()
  })

  it('chars-per-token calibrates from seed chars vs first-call prompt tokens', () => {
    const prev = seedOf(1, sliceInput(TAPE_T1))
    const chars = prev.system.length + prev.user.length
    const promptTokens = Math.round(chars / 4)
    const { charsPerToken, calibratedTurns } = calibrateCharsPerToken(
      [prev],
      [{ turn: 1, step: 1, norm: { input: promptTokens, cacheRead: 0, output: 10, reasoning: 0 } }],
    )
    expect(calibratedTurns).toBe(1)
    expect(charsPerToken).toBeCloseTo(4, 1)
  })
})

describe('call ledger sidecar', () => {
  afterEach(() => {
    delete process.env.SLICE_CALL_LEDGER_DIR
    resetCallLedgerForTest()
  })

  it('stays silent without SLICE_CALL_LEDGER_DIR, writes parseable JSONL with it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slice-ledger-'))
    const file = join(dir, 'sess-1.calls.jsonl')

    delete process.env.SLICE_CALL_LEDGER_DIR
    resetCallLedgerForTest()
    recordSeedEvent('sess-1', { turn: 1, system: 's', runtimeContext: '', user: 'u' })
    expect(existsSync(file)).toBe(false)

    process.env.SLICE_CALL_LEDGER_DIR = dir
    resetCallLedgerForTest()
    recordSeedEvent('sess-1', { turn: 1, system: 's', runtimeContext: '', user: 'u' })
    recordCallEvent('sess-1', {
      turn: 1,
      step: 1,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 60, completion_tokens: 9 },
    })

    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ kind: 'seed', turn: 1, user: 'u' })
    expect(lines[1]).toMatchObject({
      kind: 'call',
      model: 'deepseek-v4-flash',
      norm: { input: 40, cacheRead: 60, output: 9, reasoning: 0 },
    })
    rmSync(dir, { recursive: true, force: true })
  })
})
