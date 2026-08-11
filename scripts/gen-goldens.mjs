#!/usr/bin/env node
/**
 * Regenerate the Python-parity golden expectations.
 *
 * The goldens pin byte-level parity between this TypeScript port and the
 * upstream Python sliceagent engine, so regenerating them needs a sliceagent
 * checkout — which only the maintainer has. Contributors never need this: the
 * checked-in expectations are what `npm test` asserts against.
 *
 * Resolution order:
 *   1. $SLICEAGENT_REPO — explicit override
 *   2. ~/code/sliceagent — the maintainer's default layout
 * The interpreter comes from $SLICEAGENT_PYTHON, else <repo>/.venv/bin/python,
 * else `python3`.
 *
 * Usage: npm run goldens
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const candidates = [process.env.SLICEAGENT_REPO, join(homedir(), 'code', 'sliceagent')].filter(Boolean)
const sliceagent = candidates.find(path => existsSync(join(path, 'packages', 'sliceagent-core', 'src')))
if (sliceagent === undefined) {
  console.error(
    'Could not find a sliceagent checkout (needed only to REGENERATE goldens).\n'
    + 'Set SLICEAGENT_REPO to the sliceagent repo root.\n'
    + `Tried:\n${candidates.map(c => `  ${c}`).join('\n')}\n\n`
    + 'Running the test suite does not need this — the expectations are checked in.',
  )
  process.exit(1)
}

const venvPython = join(sliceagent, '.venv', 'bin', 'python')
const python = process.env.SLICEAGENT_PYTHON ?? (existsSync(venvPython) ? venvPython : 'python3')

const result = spawnSync(python, [join('tests', 'golden', 'gen_goldens.py')], {
  cwd: REPO,
  stdio: 'inherit',
  env: { ...process.env, PYTHONPATH: join(sliceagent, 'packages', 'sliceagent-core', 'src') },
})
if (result.error !== undefined) {
  console.error(`failed to run ${python}: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
