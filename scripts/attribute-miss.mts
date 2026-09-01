/**
 * attribute-miss — offline cache-miss attribution over call-ledger sidecars.
 *
 * Input: one or more `<sessionId>.calls.jsonl` files written by
 * src/call-ledger.ts (enable with SLICE_CALL_LEDGER_DIR=<dir> on the bench
 * run), or a directory of them.
 *
 *   npx tsx scripts/attribute-miss.mts <file.jsonl | dir> [--json] [--tolerance-blocks N]
 *
 * Per session it reports the totals (with reasoning split out) and one line
 * per turn boundary: where the request bytes first diverged from the previous
 * turn's seed (field / zone / char offset), the client-side expected miss,
 * the server-reported actual miss, and a verdict. Exit code 1 when any
 * boundary is not 'ok' — the same predicate the future CI assertion pins.
 *
 * Verdict semantics live in src/slice/miss-attribution.ts.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { analyze, type Analysis, type CallRecord, type SeedRecord } from '../src/slice/miss-attribution.js'

interface SessionData {
  name: string
  seeds: SeedRecord[]
  calls: CallRecord[]
  badLines: number
}

function parseSidecar(path: string): SessionData {
  const data: SessionData = { name: basename(path), seeds: [], calls: [], badLines: 0 }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const rec = JSON.parse(line) as Record<string, unknown>
      if (rec.kind === 'seed') {
        data.seeds.push({
          turn: Number(rec.turn),
          system: String(rec.system ?? ''),
          runtimeContext: String(rec.runtimeContext ?? ''),
          user: String(rec.user ?? ''),
        })
      } else if (rec.kind === 'call') {
        const norm = rec.norm as CallRecord['norm']
        data.calls.push({ turn: Number(rec.turn), step: Number(rec.step), ...(norm ? { norm } : {}) })
      }
    } catch {
      data.badLines += 1
    }
  }
  return data
}

function collectFiles(target: string): string[] {
  if (statSync(target).isDirectory()) {
    return readdirSync(target)
      .filter((f) => f.endsWith('.calls.jsonl'))
      .sort()
      .map((f) => join(target, f))
  }
  return [target]
}

function fmt(n: number | undefined): string {
  return n === undefined ? '—' : n.toLocaleString('en-US')
}

function report(session: SessionData, analysis: Analysis): void {
  const t = analysis.totals
  console.log(`\n━━ ${session.name} ━━`)
  console.log(
    `calls with usage: ${session.calls.filter((c) => c.norm).length}/${session.calls.length}`
    + `  ·  miss ${fmt(t.input)} · hit ${fmt(t.cacheRead)} (${(t.hitRate * 100).toFixed(1)}%)`
    + `  ·  out ${fmt(t.output)} (reasoning ${fmt(t.reasoning)})`
    + `  ·  chars/token ${analysis.charsPerToken.toFixed(2)} over ${analysis.calibratedTurns} turns`
    + `  ·  envelope ${analysis.envelopeTokens}t`
    + (session.badLines > 0 ? `  ·  ${session.badLines} unparsable lines skipped` : ''),
  )
  if (analysis.boundaries.length === 0) {
    console.log('  (fewer than two seed records — no boundaries to attribute)')
    return
  }
  console.log('  turn  verdict                   diverged-at                 expected   actual   Δblocks')
  for (const b of analysis.boundaries) {
    const at = b.divergence.field === 'user'
      ? `user/${b.divergence.zone}@${b.divergence.offset}`
      : `${b.divergence.field}@${b.divergence.offset}`
    console.log(
      `  ${String(b.turn).padStart(4)}`
      + `  ${b.verdict.padEnd(24)}`
      + `  ${at.padEnd(26)}`
      + `  ${fmt(b.expectedMissTokens).padStart(8)}`
      + `  ${fmt(b.actualMissTokens).padStart(7)}`
      + `  ${String(b.deltaBlocks).padStart(7)}`,
    )
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const jsonOut = args.includes('--json')
  const tolIdx = args.indexOf('--tolerance-blocks')
  const toleranceBlocks = tolIdx !== -1 ? Number(args[tolIdx + 1]) : undefined
  const targets = args.filter((a, i) => !a.startsWith('--') && (tolIdx === -1 || i !== tolIdx + 1))
  if (targets.length === 0) {
    console.error('usage: tsx scripts/attribute-miss.mts <sidecar.jsonl | dir> [--json] [--tolerance-blocks N]')
    process.exit(2)
  }

  let failed = false
  const jsonPayload: Record<string, Analysis> = {}
  for (const target of targets) {
    for (const file of collectFiles(target)) {
      const session = parseSidecar(file)
      const analysis = analyze(session.seeds, session.calls, {
        ...(toleranceBlocks !== undefined && Number.isFinite(toleranceBlocks) ? { toleranceBlocks } : {}),
      })
      if (analysis.boundaries.some((b) => b.verdict !== 'ok')) failed = true
      if (jsonOut) jsonPayload[session.name] = analysis
      else report(session, analysis)
    }
  }
  if (jsonOut) console.log(JSON.stringify(jsonPayload, null, 2))
  process.exit(failed ? 1 : 0)
}

main()
