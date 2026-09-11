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
const ts = requireHost('typescript')
const parsed = ts.parseConfigFileTextToJson('tsconfig.base.json', readFileSync(join(host, 'tsconfig.base.json'), 'utf8'))
if (parsed.error !== undefined) throw new Error('Cannot read source checkout tsconfig.base.json')
const aliases = Object.entries(parsed.config.compilerOptions.paths).map(([name, targets]) => ({
  pattern: '^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '(.*)') + '$',
  replacement: resolve(host, targets[0]).replace('*', '$1'),
}))
const directory = mkdtempSync(join(tmpdir(), 'dsh-slice-master-'))
const report = join(directory, 'results.json')
const config = join(directory, 'vitest.config.mts')
writeFileSync(config, `import { standardDecoratorPlugin } from ${JSON.stringify(join(host, 'vitest.shared.ts'))}\n`
  + `const aliases = ${JSON.stringify(aliases)}\n`
  + `export default { root: ${JSON.stringify(plugin)}, plugins: [standardDecoratorPlugin()], resolve: { alias: aliases.map(({pattern,replacement}) => ({find:new RegExp(pattern),replacement})) }, test: { include: ['tests/**/*.{spec,test}.ts'], testTimeout: 30000 } }\n`)
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: host, encoding: 'utf8', timeout: 30_000 })
if (commit.status !== 0) throw new Error('Cannot identify source checkout revision')
const vitest = join(dirname(requirePlugin.resolve('vitest/package.json')), 'vitest.mjs')
const result = spawnSync(process.execPath, [vitest, 'run', '--config', config, '--reporter=json', `--outputFile=${report}`], {
  cwd: plugin, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180_000,
})
writeFileSync(join(directory, 'command.log'), (result.stdout ?? '') + (result.stderr ?? ''))
writeFileSync(join(directory, 'metadata.json'), JSON.stringify({ hostCommit: commit.stdout.trim(), node: process.version, status: result.status }, null, 2) + '\n')
if (result.error !== undefined || result.status !== 0) throw new Error(`Source verification failed; see ${directory}`, { cause: result.error })
const summary = JSON.parse(readFileSync(report, 'utf8'))
console.log(JSON.stringify({ hostCommit: commit.stdout.trim(), tests: summary.numTotalTests, passed: summary.numPassedTests, skipped: summary.numPendingTests, evidence: directory }, null, 2))
