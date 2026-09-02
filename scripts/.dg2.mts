import { readFileSync } from 'node:fs'
import { digestText } from '../src/slice/result-digest.js'
const t = readFileSync(process.argv[2], 'utf8')
const lines = t.split('\n'); if (lines.at(-1) === '') lines.pop()
const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join('\n') + `\n\n(End of file - total ${lines.length} lines)`
const d = digestText(numbered, 'recall_step(1, 1)')
console.log(`digested=${d.digested} lines=${d.totalLines} kept=${d.keptLines} chars ${numbered.length} -> ${d.text.length}`)
console.log(d.text)
