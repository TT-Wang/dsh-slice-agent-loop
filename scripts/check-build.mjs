#!/usr/bin/env node
/** Fail on tracked, staged, untracked, and ignored generated artifact drift. */
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @param {string} repo */
export function checkBuild(repo) {
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--ignored=matching', '--', 'lib'], {
    cwd: repo, encoding: 'utf8', timeout: 30_000,
  }).trim()
  if (status) throw new Error(`Generated lib/ differs from the committed artifacts. Rebuild and commit every generated file:\n${status}`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  checkBuild(fileURLToPath(new URL('../', import.meta.url)))
  console.log('Generated lib/ matches committed artifacts.')
}
