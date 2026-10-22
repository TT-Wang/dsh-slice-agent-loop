/** Run plugin tests with every Harness workspace import resolved to one source checkout. */
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const sourceArgument = process.argv[2]
if (sourceArgument === undefined) throw new Error('Usage: node scripts/validation/run-master-tests.mjs /path/to/deepseek-harness')
const host = resolve(sourceArgument)
const plugin = fileURLToPath(new URL('../../', import.meta.url))
const requireHost = createRequire(join(host, 'package.json'))
const requirePlugin = createRequire(join(plugin, 'package.json'))
/** @type {typeof import('typescript')} */
const ts = requireHost('typescript')
const parsed = ts.parseConfigFileTextToJson('tsconfig.base.json', readFileSync(join(host, 'tsconfig.base.json'), 'utf8'))
if (parsed.error !== undefined) throw new Error('Cannot read source checkout tsconfig.base.json')
const aliases = Object.entries(/** @type {Record<string,string[]>} */ (parsed.config.compilerOptions.paths)).map(([name, targets]) => ({
  pattern: '^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '(.*)') + '$',
  replacement: resolve(host, targets[0]).replace('*', '$1'),
}))
// A DSH module the checkout no longer provides must fail to load, not resolve to
// this repository's pinned node_modules copy and mix two host versions in one
// run. On 0.2.1 that fallback hid the removal of the runtime invariant modules.
aliases.push({ pattern: '^@deepseek-ai/(dsh(?:-[^/]*)?(?:/.*)?)$', replacement: '/missing-from-host-source/@deepseek-ai/$1' })
const directory = mkdtempSync(join(tmpdir(), 'dsh-slice-master-'))
const report = join(directory, 'results.json')
const config = join(directory, 'vitest.config.mts')
writeFileSync(config, `import { standardDecoratorPlugin } from ${JSON.stringify(join(host, 'vitest.shared.ts'))}\n`
  + `const aliases = ${JSON.stringify(aliases)}\n`
  + `export default { root: ${JSON.stringify(plugin)}, plugins: [standardDecoratorPlugin()], resolve: { alias: aliases.map(({pattern,replacement}) => ({find:new RegExp(pattern),replacement})) }, test: { include: ['tests/**/*.{spec,test}.ts'], testTimeout: 30000 } }\n`)
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: host, encoding: 'utf8', timeout: 30_000 })
if (commit.status !== 0) throw new Error('Cannot identify source checkout revision')
// Read from the files on disk. HEAD alone can name another tag than the files a
// reused checkout holds, so record both.
const hostVersion = JSON.parse(readFileSync(join(host, 'package.json'), 'utf8')).version
const vitest = join(dirname(requirePlugin.resolve('vitest/package.json')), 'vitest.mjs')
// Some Harness source runs code in a worker thread through tsx (since 0.1.7 the JSONL
// migration verifier), which bypasses the Vite aliases above. Point tsx at the
// same path map so the worker also loads source rather than unbuilt lib/.
const env = { ...process.env, TSX_TSCONFIG_PATH: join(host, 'tsconfig.base.json') }
const result = spawnSync(process.execPath, [vitest, 'run', '--config', config, '--reporter=json', `--outputFile=${report}`], {
  cwd: plugin, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180_000,
})
writeFileSync(join(directory, 'command.log'), (result.stdout ?? '') + (result.stderr ?? ''))
writeFileSync(join(directory, 'metadata.json'), JSON.stringify({ hostCommit: commit.stdout.trim(), hostVersion, node: process.version, status: result.status }, null, 2) + '\n')
if (result.error !== undefined || result.status !== 0) throw new Error(`Source verification failed; see ${directory}`, { cause: result.error })
const summary = JSON.parse(readFileSync(report, 'utf8'))
console.log(JSON.stringify({ hostCommit: commit.stdout.trim(), hostVersion, tests: summary.numTotalTests, passed: summary.numPassedTests, skipped: summary.numPendingTests, evidence: directory }, null, 2))
