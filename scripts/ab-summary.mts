/**
 * ab-summary — 汇总 run-scenario 的通用账本(--ledger-dir)为「场景 × 臂」对照表。
 *
 *   npx tsx scripts/ab-summary.mts results/longturn [--json]
 *
 * 每格:判卷、rot 三段(从 verify detail 的 `early=a/b mid=c/d late=e/f` 解析)、
 * 步数、峰值 prompt、miss/hit/out/reasoning、刊例成本、封存次数。同一格多份
 * 账本时取最新(按文件名时间戳)。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

interface Ledger {
  scenario: string; arm: string; effort: string; model: string
  totals: { input: number; cacheRead: number; output: number; reasoning: number; steps: number; peakInput: number }
  seals: number
  verdict: { ok: boolean; detail: string }
  toolHistogram: Record<string, number>
  state?: { extractRules?: boolean; sideEffort?: string } | null
}

// flash 谷时刊例 $/M(与 effort-ladder 同口径;pro ×3)
const PRICE = { miss: 0.22, hit: 0.007, out: 0.66 }
// 固定顺序的基础臂;变体(stream 的 --no-rules / --side-effort、effort 非 low)按账本
// 字段自动加后缀成独立行,附在基础臂之后。
const BASE_ARMS = ['transcript', 'slice-noseal', 'slice-seal', 'state', 'stream']
function armLabel(l: Ledger): string {
  let label = l.arm
  if (l.state?.extractRules === false) label += '/no-rules'
  else if (l.state?.sideEffort !== undefined && l.state.sideEffort !== 'inherit') label += `/side-${l.state.sideEffort}`
  if (l.effort !== 'low') label += `/effort-${l.effort}`
  return label
}

const dirs = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (dirs.length === 0) dirs.push('results/longturn')
const jsonOut = process.argv.includes('--json')
const latest = new Map<string, Ledger>()
for (const dir of dirs) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  for (const f of files) {
    const l = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Ledger
    latest.set(`${l.scenario}|${armLabel(l)}`, l) // 目录顺序 + 文件名排序 → 后者覆盖前者
  }
}
const seenArms = [...new Set([...latest.keys()].map((k) => k.split('|')[1]!))]
const ARMS = [...BASE_ARMS.filter((a) => seenArms.includes(a)), ...seenArms.filter((a) => !BASE_ARMS.includes(a)).sort()]

function rot(detail: string): { early: string; mid: string; late: string } | null {
  const m = detail.match(/early=(\d+\/\d+)\s+mid=(\d+\/\d+)\s+late=(\d+\/\d+)/)
  return m ? { early: m[1]!, mid: m[2]!, late: m[3]! } : null
}
function cost(t: Ledger['totals']): number {
  return (t.input * PRICE.miss + t.cacheRead * PRICE.hit + t.output * PRICE.out) / 1e6
}

const scenarios = [...new Set([...latest.keys()].map((k) => k.split('|')[0]!))].sort()
if (jsonOut) {
  console.log(JSON.stringify(Object.fromEntries([...latest.entries()]), null, 2))
  process.exit(0)
}
for (const s of scenarios) {
  console.log(`\n━━ ${s} ━━`)
  console.log(`  ${'arm'.padEnd(14)}${'verdict'.padEnd(9)}${'early'.padEnd(8)}${'mid'.padEnd(8)}${'late'.padEnd(8)}${'steps'.padStart(6)}${'peak'.padStart(9)}${'miss'.padStart(9)}${'hit'.padStart(9)}${'out'.padStart(8)}${'reason'.padStart(8)}${'seals'.padStart(6)}${'$cost'.padStart(9)}`)
  for (const arm of ARMS) {
    const l = latest.get(`${s}|${arm}`)
    if (!l) { console.log(`  ${arm.padEnd(14)}(no ledger)`); continue }
    const r = rot(l.verdict.detail) ?? { early: '—', mid: '—', late: '—' }
    const t = l.totals
    console.log(
      `  ${arm.padEnd(14)}${(l.verdict.ok ? '✓' : '✗').padEnd(9)}${r.early.padEnd(8)}${r.mid.padEnd(8)}${r.late.padEnd(8)}`
      + `${String(t.steps).padStart(6)}${String(t.peakInput).padStart(9)}${String(t.input).padStart(9)}${String(t.cacheRead).padStart(9)}`
      + `${String(t.output).padStart(8)}${String(t.reasoning).padStart(8)}${String(l.seals).padStart(6)}${cost(t).toFixed(4).padStart(9)}`,
    )
  }
  for (const arm of ARMS) {
    const l = latest.get(`${s}|${arm}`)
    if (l && !l.verdict.ok) console.log(`    ${arm}: ${l.verdict.detail.slice(0, 220)}`)
  }
}
