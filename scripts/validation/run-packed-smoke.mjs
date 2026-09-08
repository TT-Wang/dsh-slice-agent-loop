/** Install one packed plugin into an isolated published dsh profile and verify it. */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const candidate = process.argv[2]
const directory = mkdtempSync(join(tmpdir(), 'dsh-slice-packed-'))
const fixtureSources = dirname(fileURLToPath(import.meta.url))
const home = join(directory, 'home')
const profile = join(home, 'profiles', 'slice-packed')
const output = join(directory, 'evidence')
mkdirSync(profile, { recursive: true })
mkdirSync(output)
let sourceArtifact = candidate
if (sourceArtifact === undefined) {
  const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', directory], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024, timeout: 180_000,
  })
  writeFileSync(join(output, 'pack.log'), (packed.stdout ?? '') + (packed.stderr ?? ''))
  if (packed.error !== undefined || packed.status !== 0) {
    throw new Error(`npm pack failed; see ${join(output, 'pack.log')}`, { cause: packed.error })
  }
  const reports = JSON.parse(packed.stdout)
  const filename = Array.isArray(reports) && reports.length === 1 ? reports[0]?.filename : undefined
  if (typeof filename !== 'string' || basename(filename) !== filename || !filename.endsWith('.tgz')) {
    throw new Error('npm pack did not report exactly one local tarball filename')
  }
  sourceArtifact = join(directory, filename)
}
const artifact = join(directory, 'candidate.tgz')
copyFileSync(resolve(sourceArtifact), artifact)
const sha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex')
writeFileSync(join(directory, 'package.json'), JSON.stringify({
  name: 'dsh-slice-packed-validation', private: true, type: 'module',
  dependencies: { '@deepseek-ai/dsh': '0.1.3-alpha.2' },
}, null, 2) + '\n')
copyFileSync(join(fixtureSources, 'packed-runner.mjs'), join(directory, 'runner.mjs'))
copyFileSync(join(fixtureSources, 'packed-profile.patch.yml'), join(profile, 'cordis.patch.yml'))
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'slice-packed-profile', private: true, type: 'module',
  dsh: { profile: { bundles: [], patchReload: 'startup' } },
}, null, 2) + '\n')
// Match the supported launcher's own profile defaults; peers resolve to its
// installation, so the plugin and host share one Cordis/DSH module graph.
writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
const env = { ...process.env, DSH_HOME: home, DSH_VALIDATION_OUTPUT: output }
let commandNumber = 0
function run(command, args, cwd = directory) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180_000 })
  const filename = `command-${++commandNumber}.log`
  writeFileSync(join(output, filename), JSON.stringify({ command, args, cwd, status: result.status }) + '\n' + (result.stdout ?? '') + (result.stderr ?? ''))
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Packed validation failed; see ${join(output, filename)}`, { cause: result.error })
  }
  return result
}
console.log(`Packed verification workspace: ${directory}`)
run('pnpm', ['install', '--ignore-scripts'])
const host = createRequire(realpathSync(join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')))
// Only persistence's declared native addon needs an install script for this
// composition; do not execute unrelated application dependencies' scripts.
const persistence = createRequire(host.resolve('@deepseek-ai/dsh-session-persistence-jsonl/package.json'))
run('npm', ['run', 'install'], dirname(persistence.resolve('fs-ext/package.json')))
const cli = join(dirname(host.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')
run(process.execPath, [cli, '--version'])
run(process.execPath, [cli, 'plugin', '--profile', 'slice-packed', 'add', artifact, '--ignore-scripts'])
run(process.execPath, [cli, '--profile', 'slice-packed', '--dump-config'])
run(process.execPath, [cli, '--profile', 'slice-packed'])
const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'))
const verified = { ...summary, artifactSha256: sha256, node: process.version, platform: process.platform, arch: process.arch }
writeFileSync(join(output, 'summary.json'), JSON.stringify(verified, null, 2) + '\n')
console.log(JSON.stringify({ ...verified, evidence: output }, null, 2))
