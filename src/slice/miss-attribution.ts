/**
 * miss-attribution.ts — offline cache-miss attribution over call-ledger sidecars.
 *
 * Consumes the per-session JSONL written by src/call-ledger.ts (seed bytes per
 * turn + normalized usage per call) and answers, for every turn boundary:
 *
 *   1. WHERE did the request bytes first diverge from the previous turn's
 *      seed — system prefix / runtime-context block / which slice zone?
 *   2. Was the tape reused byte-identically (append-only invariant), or did
 *      sealed bytes drift?
 *   3. Does the server-reported miss (norm.input of the turn's first call)
 *      agree with the client-side expectation, within a 64-token-block
 *      tolerance?
 *
 * Verdicts:
 *   ok                       — healthy boundary: tape replayed byte-identical,
 *                              divergence in the per-turn suffix, miss size
 *                              within tolerance of expectation
 *   suspect-size             — structure healthy but actual miss exceeds the
 *                              client-side expectation by > tolerance (server
 *                              eviction, envelope drift, or estimation gap —
 *                              look at the turn before blaming the server)
 *   tape-drift               — sealed tape bytes changed between turns; the
 *                              append-only invariant is broken (a rendering
 *                              instability: fix in code, not tolerance)
 *   system-drift             — the system prefix changed mid-session
 *   runtime-context-volatile — the host runtime-context block changed; it sits
 *                              BEFORE the slice user text in the seed message,
 *                              so its churn invalidates the tape prefix too
 *
 * The verdict thresholds here are the future CI assertion (consensus Q5):
 * once the byte-hygiene fixes land, pin `analyze(...)` over a bench sidecar
 * and assert every boundary is 'ok'.
 */
import { ZONE_HEADERS } from './assemble.js'
import type { NormalizedUsage } from '../call-ledger.js'

// ───────────────────────────────────────────────────────────────── records

export interface SeedRecord {
  turn: number
  system: string
  runtimeContext: string
  user: string
}

export interface CallRecord {
  turn: number
  step: number
  norm?: NormalizedUsage
}

// ───────────────────────────────────────────────────────────────── basics

/** DeepSeek prefix cache granularity: 64-token blocks. */
export const BLOCK_TOKENS = 64
/** 实测(20260901,两场景 27 轮界):线性自校准后健康轮界的残差散布 ±3 块
 *  (CJK/ASCII 混合比逐轮波动的估算噪音);关注的漂移事件是 +100 块量级。
 *  默认 4 块 = 噪音之上、信号之下。 */
export const DEFAULT_TOLERANCE_BLOCKS = 4
/** chars-per-token clamp + fallback when a sidecar carries no usable usage. */
const CPT_MIN = 1.5
const CPT_MAX = 6
const CPT_FALLBACK = 3.6

export function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1
  return i
}

/** Zone label at a char offset of a slice user text: the last zone whose
 *  header starts at or before the offset; 'preamble' before every header. */
export function zoneAt(user: string, offset: number): string {
  let zone = 'preamble'
  for (const { zone: z, header } of ZONE_HEADERS) {
    const at = user.indexOf(header)
    if (at !== -1 && at <= offset) zone = z
  }
  return zone
}

// ─────────────────────────────────────────────────────────────── divergence

export type DivergenceField = 'system' | 'runtime-context' | 'user' | 'none'

export interface Divergence {
  field: DivergenceField
  /** First differing char offset within `field`. */
  offset: number
  /** Zone label (meaningful when field === 'user'). */
  zone: string
  /** Client-side estimate of the fresh bytes this boundary re-sends:
   *  everything from the divergence point to the end of NEXT's head. */
  freshChars: number
}

export function findDivergence(prev: SeedRecord, next: SeedRecord): Divergence {
  if (prev.system !== next.system) {
    const offset = commonPrefixLen(prev.system, next.system)
    return {
      field: 'system',
      offset,
      zone: 'system',
      freshChars: (next.system.length - offset) + next.runtimeContext.length + next.user.length,
    }
  }
  if (prev.runtimeContext !== next.runtimeContext) {
    const offset = commonPrefixLen(prev.runtimeContext, next.runtimeContext)
    return {
      field: 'runtime-context',
      offset,
      zone: 'runtime-context',
      freshChars: (next.runtimeContext.length - offset) + next.user.length,
    }
  }
  if (prev.user !== next.user) {
    const offset = commonPrefixLen(prev.user, next.user)
    return { field: 'user', offset, zone: zoneAt(prev.user, offset), freshChars: next.user.length - offset }
  }
  return { field: 'none', offset: 0, zone: 'none', freshChars: 0 }
}

/** End offset (exclusive, trailing separator newlines stripped) of the tape
 *  section's sealed CONTENT in a slice user text, or -1 when no tape section
 *  is present. A healthy append-only boundary diverges at or after this
 *  offset (the new entry lands where the old section separator sat); any
 *  divergence before it means sealed bytes changed. The section is bounded by
 *  the next zone header present, or the closing '</context>' fence when the
 *  tape is the last (or only) section. */
export function tapeContentEnd(user: string): number {
  const tapeHeader = ZONE_HEADERS[0]!.header
  const start = user.indexOf(tapeHeader)
  if (start === -1) return -1
  let end = user.length
  for (const { header } of ZONE_HEADERS.slice(1)) {
    const at = user.indexOf(header, start + tapeHeader.length)
    if (at !== -1 && at < end) end = at
  }
  const fence = user.indexOf('\n</context>', start + tapeHeader.length)
  if (fence !== -1 && fence < end) end = fence
  while (end > start && user[end - 1] === '\n') end -= 1
  return end
}

// ─────────────────────────────────────────────────────────────── analysis

export type Verdict = 'ok' | 'suspect-size' | 'tape-drift' | 'system-drift' | 'runtime-context-volatile'

export interface BoundaryReport {
  turn: number
  prevTurn: number
  divergence: Divergence
  expectedMissTokens: number
  /** Server-reported fresh tokens of this turn's first call; undefined when
   *  the sidecar has no usage for it. */
  actualMissTokens?: number
  /** (actual − expected) in 64-token blocks; 0 when actual is unknown. */
  deltaBlocks: number
  verdict: Verdict
}

export interface AnalysisTotals {
  input: number
  cacheRead: number
  output: number
  reasoning: number
  hitRate: number
}

export interface Analysis {
  boundaries: BoundaryReport[]
  charsPerToken: number
  calibratedTurns: number
  /** Self-calibrated fixed per-first-call overhead (tokens) the client-side
   *  byte diff cannot see — median(actual − expected) over healthy user-field
   *  boundaries, clamped at 0. Real data 20260901: ≈350 tokens, consistent
   *  across scenarios; verdicts compare against expected + envelope. */
  envelopeTokens: number
  totals: AnalysisTotals
}

function firstCallOf(calls: readonly CallRecord[], turn: number): CallRecord | undefined {
  let best: CallRecord | undefined
  for (const c of calls) {
    if (c.turn !== turn) continue
    if (best === undefined || c.step < best.step) best = c
  }
  return best
}

/** chars-per-token from the sidecar itself: head chars vs first-call prompt
 *  tokens, summed over turns where both sides are known. */
export function calibrateCharsPerToken(
  seeds: readonly SeedRecord[],
  calls: readonly CallRecord[],
): { charsPerToken: number; calibratedTurns: number } {
  let chars = 0
  let tokens = 0
  let turns = 0
  for (const seed of seeds) {
    const first = firstCallOf(calls, seed.turn)
    const norm = first?.norm
    if (norm === undefined) continue
    const promptTokens = norm.input + norm.cacheRead
    if (promptTokens <= 0) continue
    chars += seed.system.length + seed.runtimeContext.length + seed.user.length
    tokens += promptTokens
    turns += 1
  }
  if (turns === 0 || tokens === 0) return { charsPerToken: CPT_FALLBACK, calibratedTurns: 0 }
  const cpt = Math.min(CPT_MAX, Math.max(CPT_MIN, chars / tokens))
  return { charsPerToken: cpt, calibratedTurns: turns }
}

export interface AnalyzeOptions {
  toleranceBlocks?: number
}

export function analyze(
  seedsIn: readonly SeedRecord[],
  calls: readonly CallRecord[],
  options: AnalyzeOptions = {},
): Analysis {
  const tolerance = (options.toleranceBlocks ?? DEFAULT_TOLERANCE_BLOCKS) * BLOCK_TOKENS
  const seeds = [...seedsIn].sort((a, b) => a.turn - b.turn)
  const { charsPerToken, calibratedTurns } = calibrateCharsPerToken(seeds, calls)

  // Pass 1: raw expectations per boundary; collect (actual − expected) on
  // structurally-healthy user-field boundaries to learn the fixed envelope.
  interface Prelim { prev: SeedRecord; next: SeedRecord; divergence: Divergence; expected: number; actual?: number; structural: Verdict | null }
  const prelims: Prelim[] = []
  for (let i = 1; i < seeds.length; i += 1) {
    const prev = seeds[i - 1]!
    const next = seeds[i]!
    const divergence = findDivergence(prev, next)
    const expected = Math.round(divergence.freshChars / charsPerToken)
    const actual = firstCallOf(calls, next.turn)?.norm?.input
    let structural: Verdict | null = null
    if (divergence.field === 'system') structural = 'system-drift'
    else if (divergence.field === 'runtime-context') structural = 'runtime-context-volatile'
    else if (divergence.field === 'user') {
      const prevTapeEnd = tapeContentEnd(prev.user)
      if (prevTapeEnd !== -1 && divergence.offset < prevTapeEnd) structural = 'tape-drift'
    }
    prelims.push({ prev, next, divergence, expected, ...(actual === undefined ? {} : { actual }), structural })
  }
  // 实测残差是双峰的:大轮界被 cpt 高估(负残差),小轮界带固定请求包络
  // (正残差 ~350t)。单一常数吸收不了两者——线性自校准 actual ≈ a + b·expected:
  // a=客户端看不见的固定包络,b=估算斜率。样本 <4 或拟合病态时退化为 a=0,b=1
  // (即原始语义,合成小样本的单元测试走这条路)。
  const pts = prelims
    .filter((p) => p.structural === null && p.actual !== undefined)
    .map((p) => ({ x: p.expected, y: p.actual! }))
  let intercept = 0
  let slope = 1
  if (pts.length >= 4) {
    const n = pts.length
    const sx = pts.reduce((a, q) => a + q.x, 0)
    const sy = pts.reduce((a, q) => a + q.y, 0)
    const sxx = pts.reduce((a, q) => a + q.x * q.x, 0)
    const sxy = pts.reduce((a, q) => a + q.x * q.y, 0)
    const denom = n * sxx - sx * sx
    if (denom > 0) {
      const b = (n * sxy - sx * sy) / denom
      const a = (sy - b * sx) / n
      if (b > 0.3 && b < 1.5 && a >= 0) {
        slope = b
        intercept = Math.round(a)
      }
    }
  }
  const envelopeTokens = intercept

  // Pass 2: verdicts against the calibrated prediction a + b·expected.
  const boundaries: BoundaryReport[] = []
  for (const p of prelims) {
    const expectedAdj = Math.round(intercept + slope * p.expected)
    const deltaBlocks = p.actual === undefined ? 0 : Math.round((p.actual - expectedAdj) / BLOCK_TOKENS)
    let verdict: Verdict
    if (p.structural !== null) verdict = p.structural
    else if (p.actual !== undefined && p.actual - expectedAdj > tolerance) verdict = 'suspect-size'
    else verdict = 'ok'
    boundaries.push({
      turn: p.next.turn,
      prevTurn: p.prev.turn,
      divergence: p.divergence,
      expectedMissTokens: p.expected,
      ...(p.actual === undefined ? {} : { actualMissTokens: p.actual }),
      deltaBlocks,
      verdict,
    })
  }

  const totals: AnalysisTotals = { input: 0, cacheRead: 0, output: 0, reasoning: 0, hitRate: 0 }
  for (const c of calls) {
    if (c.norm === undefined) continue
    totals.input += c.norm.input
    totals.cacheRead += c.norm.cacheRead
    totals.output += c.norm.output
    totals.reasoning += c.norm.reasoning
  }
  const prompt = totals.input + totals.cacheRead
  totals.hitRate = prompt > 0 ? totals.cacheRead / prompt : 0

  return { boundaries, charsPerToken, calibratedTurns, envelopeTokens, totals }
}
