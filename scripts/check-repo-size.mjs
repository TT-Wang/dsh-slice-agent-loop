#!/usr/bin/env node
/**
 * Tracked-bytes gate: sums the working-tree size of every file `git ls-files`
 * lists.
 *
 * A `dsh plugin add github:...` install has pnpm download a codeload tarball of
 * one commit's whole tree (not a clone; no history), then install only what
 * `files` in package.json names (`lib/`, `cordis.patch.yml`). Every Git install
 * downloads every tracked byte, compressed, although almost none is installed.
 *
 * Until 2026-09-27 `results/` held 57 MiB of raw experiment data here, about
 * 95% of that tarball. It moved to a GitHub release asset and is now ignored
 * (see results/README.md), leaving about 2 MiB tracked. The 8 MiB default
 * leaves room for normal growth and fails if a data archive is committed again.
 *
 * Raising the limit is allowed (--limit, or REPO_SIZE_LIMIT_MIB in
 * .github/workflows/ci.yml), but it should be a deliberate commit, not a side
 * effect of committing experiment output.
 *
 *   node scripts/check-repo-size.mjs [--limit <MiB>] [--top <n>]
 */
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
/** @param {string} flag @param {string} [fallback] */
const opt = (flag, fallback) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : fallback }

const LIMIT_MIB = Number(opt('--limit', process.env.REPO_SIZE_LIMIT_MIB ?? '8'))
const TOP = Number(opt('--top', '10'))
if (!Number.isFinite(LIMIT_MIB) || LIMIT_MIB <= 0) throw new Error(`--limit must be a positive number, got ${opt('--limit')}`)

const files = execFileSync('git', ['-C', REPO, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })
  .split('\0').filter(Boolean)

let total = 0
const byTop = new Map()
/** @type {[string,number][]} */
const sizes = []
for (const file of files) {
  let size
  try { size = statSync(resolve(REPO, file)).size } catch { continue } // staged deletion / sparse checkout
  total += size
  sizes.push([file, size])
  const top = file.includes('/') ? file.slice(0, file.indexOf('/')) + '/' : file
  byTop.set(top, (byTop.get(top) ?? 0) + size)
}

/** @param {number} bytes */
const mib = (bytes) => (bytes / 1048576).toFixed(2)
console.log(`tracked: ${mib(total)} MiB across ${sizes.length} files (limit ${LIMIT_MIB} MiB)`)
for (const [top, bytes] of [...byTop].sort((a, b) => b[1] - a[1]).slice(0, TOP)) {
  console.log(`  ${mib(bytes).padStart(8)} MiB  ${top}`)
}

if (total > LIMIT_MIB * 1048576) {
  console.error(`\nTracked bytes ${mib(total)} MiB exceed the ${LIMIT_MIB} MiB limit.`)
  console.error('Largest tracked files:')
  for (const [file, bytes] of sizes.sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.error(`  ${mib(bytes).padStart(8)} MiB  ${file}`)
  console.error('\nPublish data archives as a GitHub release asset instead of committing them (see results/README.md),')
  console.error('or raise the limit deliberately (REPO_SIZE_LIMIT_MIB in .github/workflows/ci.yml).')
  process.exit(1)
}
