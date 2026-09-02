/**
 * replay-summary — 汇总 run-replay 账本为「案例 × 臂」对照表。
 *   npx tsx scripts/replay-summary.mts results/20260902-replay/ledgers
 * 同一格多份账本取最新。相似度是相对信号(与原轮不对等:模型/上下文都不同),只在臂之间比。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

interface Ledger {
  caseId: string; arm: string; endKind: string; error?: string
  totals: { steps: number; input: number; cacheRead: number; output: number; reasoning: number; peakInput: number }
  seals: number; bounces: number
  verdict: { touchedJaccard: number; meanFileSimilarity: number; perFile: Record<string, number>; replayChanged: string[]; oracleTouched: string[] }
}
const PRICE = { miss: 0.22, hit: 0.007, out: 0.66 }
const ARMS = ['transcript', 'slice-noseal', 'slice-seal', 'state']
const dir = process.argv[2] ?? 'results/20260902-replay/ledgers'
const latest = new Map<string, Ledger>()
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const l = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Ledger
  latest.set(`${l.caseId}|${l.arm}`, l)
}
const cases = [...new Set([...latest.keys()].map((k) => k.split('|')[0]!))].sort()
for (const c of cases) {
  console.log(`\n━━ ${c} ━━`)
  console.log(`  ${'arm'.padEnd(14)}${'end'.padEnd(11)}${'steps'.padStart(6)}${'peak'.padStart(8)}${'miss'.padStart(9)}${'hit'.padStart(9)}${'reason'.padStart(8)}${'$cost'.padStart(8)}${'jaccard'.padStart(9)}${'meanSim'.padStart(9)}${'changed'.padStart(9)}`)
  for (const arm of ARMS) {
    const l = latest.get(`${c}|${arm}`)
    if (!l) continue
    const t = l.totals
    const cost = (t.input * PRICE.miss + t.cacheRead * PRICE.hit + t.output * PRICE.out) / 1e6
    console.log(`  ${arm.padEnd(14)}${l.endKind.padEnd(11)}${String(t.steps).padStart(6)}${String(t.peakInput).padStart(8)}${String(t.input).padStart(9)}${String(t.cacheRead).padStart(9)}${String(t.reasoning).padStart(8)}${cost.toFixed(3).padStart(8)}${l.verdict.touchedJaccard.toFixed(2).padStart(9)}${l.verdict.meanFileSimilarity.toFixed(2).padStart(9)}${String(l.verdict.replayChanged.length).padStart(9)}`)
  }
  const any = [...latest.values()].find((l) => l.caseId === c)
  if (any) console.log(`  oracle touched ${any.verdict.oracleTouched.length} files: ${any.verdict.oracleTouched.slice(0, 6).join(', ')}${any.verdict.oracleTouched.length > 6 ? ', …' : ''}`)
}
