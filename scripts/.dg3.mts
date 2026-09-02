import { readFileSync } from 'node:fs'
import { DEFAULT_DIGEST_POLICY, digestText } from '../src/slice/result-digest.js'
for (const p of process.argv.slice(2)) {
  const t = readFileSync(p, 'utf8'); const lines = t.split('\n'); if (lines.at(-1) === '') lines.pop()
  const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join('\n') + `\n\n(End of file - total ${lines.length} lines)`
  const a = digestText(numbered, 'r'); const b = digestText(numbered, 'r', { ...DEFAULT_DIGEST_POLICY, structuredBlockCap: 4 }); const c = digestText(numbered, 'r', { ...DEFAULT_DIGEST_POLICY, structuredBlockCap: 2 })
  console.log(`${p.split('/').slice(-2).join('/')}: raw ${numbered.length} → uncapped ${a.text.length} (${a.keptLines} lines) → cap4 ${b.text.length} (${b.keptLines}) → cap2 ${c.text.length} (${c.keptLines})`)
  if (p.endsWith('.rec') && process.argv.indexOf(p) === process.argv.length - 1) console.log(b.text)
}
