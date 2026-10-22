/**
 * Fit heap-growth.mts output: heapUsed (after GC) against turns, linear and quadratic.
 *
 *   node --import tsx scripts/bench/heap-fit.mts [--from 50] [--json summary.json] run1.json run2.json ...
 *
 * Per run and pooled per arm: least-squares y = a + b·t and y = a + b·t + c·t²
 * with R², the t-statistic of c, c·T² (what the quadratic term adds at the last
 * turn), the per-turn increment in the first and last quarter of the range, the
 * same fits for the event log's JSON size, and heap per log byte. Wall time per
 * turn is reported per quarter as well, since CPU can grow when memory does not.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values: opt, positionals: files } = parseArgs({
  allowPositionals: true,
  options: { from: { type: 'string', default: '50' }, json: { type: 'string' } },
})
const FROM = Number(opt.from)

interface Row { turn: number; heapUsedMB: number; logJsonMB: number; wallMs: number; rssMB: number }
interface Run { file: string; arm: string; seed: number; rows: Row[] }

/** Solve the normal equations of a polynomial fit on centred, scaled t (well conditioned). */
function polyfit(t: readonly number[], y: readonly number[], degree: 1 | 2) {
  const n = t.length
  const mean = t.reduce((s, v) => s + v, 0) / n
  const scale = Math.max(...t.map(v => Math.abs(v - mean))) || 1
  const x = t.map(v => (v - mean) / scale)
  const k = degree + 1
  const A = Array.from({ length: k }, () => new Array<number>(k).fill(0))
  const B = new Array<number>(k).fill(0)
  for (let i = 0; i < n; i += 1) {
    const powers = Array.from({ length: k }, (_u, p) => x[i]! ** p)
    for (let r = 0; r < k; r += 1) {
      B[r]! += powers[r]! * y[i]!
      for (let c = 0; c < k; c += 1) A[r]![c]! += powers[r]! * powers[c]!
    }
  }
  const inv = invert(A)
  const beta = inv.map(row => row.reduce((s, v, j) => s + v * B[j]!, 0))
  const fitted = x.map(v => beta.reduce((s, b, p) => s + b * v ** p, 0))
  const ybar = y.reduce((s, v) => s + v, 0) / n
  const ssRes = y.reduce((s, v, i) => s + (v - fitted[i]!) ** 2, 0)
  const ssTot = y.reduce((s, v) => s + (v - ybar) ** 2, 0)
  const sigma2 = n > k ? ssRes / (n - k) : NaN
  // Back to raw t: y = Σ beta_p ((t - mean)/scale)^p
  const raw = degree === 1
    ? [beta[0]! - beta[1]! * mean / scale, beta[1]! / scale, 0]
    : [beta[0]! - beta[1]! * mean / scale + beta[2]! * mean ** 2 / scale ** 2,
      beta[1]! / scale - 2 * beta[2]! * mean / scale ** 2, beta[2]! / scale ** 2]
  const seTop = Math.sqrt(sigma2 * inv[degree]![degree]!) // SE of the highest-order coefficient (scaled)
  return { a: raw[0]!, b: raw[1]!, c: raw[2]!, r2: 1 - ssRes / ssTot, rmse: Math.sqrt(ssRes / n), tTop: beta[degree]! / seTop }
}

function invert(m: number[][]): number[][] {
  const n = m.length
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_u, j) => (i === j ? 1 : 0))])
  for (let col = 0; col < n; col += 1) {
    let pivot = col
    for (let r = col + 1; r < n; r += 1) if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r
    ;[a[col], a[pivot]] = [a[pivot]!, a[col]!]
    const p = a[col]![col]!
    for (let j = 0; j < 2 * n; j += 1) a[col]![j]! /= p
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue
      const f = a[r]![col]!
      for (let j = 0; j < 2 * n; j += 1) a[r]![j]! -= f * a[col]![j]!
    }
  }
  return a.map(row => row.slice(n))
}

/** Mean slope (MB/turn or ms/turn) over the first and last quarter of the fitted range. */
function quarterSlopes(rows: readonly Row[], key: 'heapUsedMB' | 'logJsonMB' | 'wallMs') {
  const slope = (lo: number, hi: number) => {
    const inRange = rows.filter(r => r.turn >= lo && r.turn <= hi)
    const first = inRange[0]!
    const last = inRange.at(-1)!
    return (last[key] - first[key]) / (last.turn - first.turn)
  }
  const t0 = rows[0]!.turn
  const t1 = rows.at(-1)!.turn
  const q = (t1 - t0) / 4
  return { first: slope(t0, t0 + q), last: slope(t1 - q, t1) }
}

function load(file: string): Run {
  const data = JSON.parse(readFileSync(file, 'utf8')) as {
    meta: { arm: string; seed: number; config?: object | null; invariants?: boolean; persist?: boolean }
    checkpoints: Row[]
  }
  const { meta } = data
  // Variants pool separately from the default arm: a non-default config, no invariants, persistence.
  const variant = [
    meta.config && Object.keys(meta.config).length ? JSON.stringify(meta.config) : '',
    meta.invariants === false ? 'no-invariants' : '',
    meta.persist ? 'persist' : '',
  ].filter(Boolean).join(' ')
  return { file, arm: variant ? `${meta.arm} ${variant}` : meta.arm, seed: meta.seed, rows: data.checkpoints.filter(r => r.turn >= FROM) }
}

function summarise(label: string, rows: readonly Row[], pooled: boolean) {
  const t = rows.map(r => r.turn)
  const heap = rows.map(r => r.heapUsedMB)
  const log = rows.map(r => r.logJsonMB)
  const lin = polyfit(t, heap, 1)
  const quad = polyfit(t, heap, 2)
  const logLin = polyfit(t, log, 1)
  const logQuad = polyfit(t, log, 2)
  const T = Math.max(...t)
  const sorted = [...rows].sort((x, y) => x.turn - y.turn)
  const ratio = polyfit(log, heap, 1)
  return {
    label, n: rows.length, from: Math.min(...t), to: T,
    heap: { linear: lin, quadratic: quad, quadAtEndMB: quad.c * T * T, ...(pooled ? {} : { increments: quarterSlopes(sorted, 'heapUsedMB') }) },
    log: { linear: logLin, quadratic: logQuad, quadAtEndMB: logQuad.c * T * T },
    heapPerLogByte: ratio.b,
    ...(pooled ? {} : { wallMsPerTurn: quarterSlopes(sorted, 'wallMs'), heapAtEndMB: sorted.at(-1)!.heapUsedMB, logAtEndMB: sorted.at(-1)!.logJsonMB, rssAtEndMB: sorted.at(-1)!.rssMB }),
  }
}

const runs = files.map(load)
const results = [
  ...runs.map(run => summarise(`${run.arm} seed ${run.seed}`, run.rows, false)),
  ...[...new Set(runs.map(r => r.arm))].map(arm => summarise(`${arm} pooled`, runs.filter(r => r.arm === arm).flatMap(r => r.rows), true)),
]

const f = (v: number, d = 4) => (Number.isFinite(v) ? v.toFixed(d) : String(v))
const e = (v: number) => v.toExponential(2)
console.log(`fit range: turn >= ${FROM}\n`)
console.log('| run | heap@end MB | linear b MB/turn | linear R² | quad c MB/turn² | t(c) | c·T² MB | quad R² | Δheap/turn first→last quarter | log b MB/turn | log c·T² MB | heap per log byte | wall ms/turn first→last quarter |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const r of results) {
  const inc = 'increments' in r.heap && r.heap.increments ? `${f(r.heap.increments.first)} → ${f(r.heap.increments.last)}` : '—'
  const wall = 'wallMsPerTurn' in r && r.wallMsPerTurn ? `${f(r.wallMsPerTurn.first, 1)} → ${f(r.wallMsPerTurn.last, 1)}` : '—'
  const end = 'heapAtEndMB' in r ? f(r.heapAtEndMB as number, 1) : '—'
  console.log(`| ${r.label} | ${end} | ${f(r.heap.linear.b)} | ${f(r.heap.linear.r2, 5)} | ${e(r.heap.quadratic.c)} | ${f(r.heap.quadratic.tTop, 1)} | ${f(r.heap.quadAtEndMB, 2)} | ${f(r.heap.quadratic.r2, 5)} | ${inc} | ${f(r.log.linear.b)} | ${f(r.log.quadAtEndMB, 2)} | ${f(r.heapPerLogByte, 2)} | ${wall} |`)
}
if (opt.json !== undefined) writeFileSync(opt.json, `${JSON.stringify({ from: FROM, files, results }, null, 1)}\n`)
