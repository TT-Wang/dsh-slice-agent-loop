#!/usr/bin/env node
/**
 * Tracked-bytes gate.
 *
 * `results/` is a committed evidence archive and it is 98% of what a
 * `dsh plugin add github:...` install downloads (Git install clones the whole
 * repo; the npm tarball is unaffected — `files` only ships `lib/`). The archive
 * grew ~40 experiment directories in ten days with nothing watching, so this
 * gate makes the next jump a visible decision instead of a silent one.
 *
 * Raising LIMIT_MIB is allowed — but it should be a deliberate commit, not a
 * side effect of dropping a new run into results/.
 *
 *   node scripts/check-repo-size.mjs [--limit <MiB>] [--top <n>]
 */
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (flag, fallback) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : fallback }

const LIMIT_MIB = Number(opt('--limit', process.env.REPO_SIZE_LIMIT_MIB ?? '64'))
const TOP = Number(opt('--top', '10'))
if (!Number.isFinite(LIMIT_MIB) || LIMIT_MIB <= 0) throw new Error(`--limit must be a positive number, got ${opt('--limit')}`)

const files = execFileSync('git', ['-C', REPO, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })
  .split('\0').filter(Boolean)

let total = 0
const byTop = new Map()
const sizes = []
for (const file of files) {
  let size
  try { size = statSync(resolve(REPO, file)).size } catch { continue } // staged deletion / sparse checkout
  total += size
  sizes.push([file, size])
  const top = file.includes('/') ? file.slice(0, file.indexOf('/')) + '/' : file
  byTop.set(top, (byTop.get(top) ?? 0) + size)
}

const mib = (bytes) => (bytes / 1048576).toFixed(2)
console.log(`tracked: ${mib(total)} MiB across ${sizes.length} files (limit ${LIMIT_MIB} MiB)`)
for (const [top, bytes] of [...byTop].sort((a, b) => b[1] - a[1]).slice(0, TOP)) {
  console.log(`  ${mib(bytes).padStart(8)} MiB  ${top}`)
}

if (total > LIMIT_MIB * 1048576) {
  console.error(`\nTracked bytes ${mib(total)} MiB exceed the ${LIMIT_MIB} MiB limit.`)
  console.error('Largest tracked files:')
  for (const [file, bytes] of sizes.sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.error(`  ${mib(bytes).padStart(8)} MiB  ${file}`)
  console.error('\nMove the archive out of the repo, or raise --limit deliberately in .github/workflows/ci.yml.')
  process.exit(1)
}
