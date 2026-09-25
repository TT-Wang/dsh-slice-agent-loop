/** Install one packed plugin into an isolated published dsh profile and verify it. */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const candidate = process.argv[2]
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
// The fixture pins this repository's package manager (package.json
// "packageManager"). Evidence from a different pnpm is not comparable, and a
// silently different install layout is exactly what this smoke exists to catch.
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const packageManager = manifest.packageManager
const hostVersion = process.env.SLICE_PACKED_DSH_VERSION ?? manifest.devDependencies['@deepseek-ai/dsh-agent']
if (!['0.1.7-rc.1', '0.1.7-rc.2'].includes(hostVersion)) throw new Error(`Unsupported packed validation host: ${hostVersion}`)
// Budget for each step (install, plugin add, the session run). A cold install of
// the published host tree over a slow registry link can exceed the default.
const stepTimeoutMs = Number.parseInt(process.env.SLICE_PACKED_STEP_TIMEOUT_MS ?? '', 10) || 180_000
// pnpm 11 applies a 1440-minute minimumReleaseAge by default, and a release
// candidate is verified on the day it ships. Carry the repository's own
// release-age policy, whose exclude list tracks the pinned DSH release, into
// every throwaway workspace instead of disabling the policy: the smoke then
// follows the same exemptions as CI. The published host's own closure is wider
// than this repository's tree; see installHost() for how that is handled.
/** @type {{minimumReleaseAge?: unknown, minimumReleaseAgeExclude?: unknown}} */
const repoWorkspace = parseYaml(readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')) ?? {}
const { minimumReleaseAge, minimumReleaseAgeExclude } = repoWorkspace
if (typeof minimumReleaseAge !== 'number' || !Array.isArray(minimumReleaseAgeExclude)
  || !minimumReleaseAgeExclude.every(entry => typeof entry === 'string')) {
  throw new Error('pnpm-workspace.yaml must declare minimumReleaseAge and a minimumReleaseAgeExclude string list')
}
/** @type {string[]} */
const carriedExclude = [...minimumReleaseAgeExclude]
const releaseAgePolicy = { minimumReleaseAge, minimumReleaseAgeExclude: carriedExclude }
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
    cwd: repoRoot, encoding: 'utf8',
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
  name: 'dsh-slice-packed-validation', private: true, type: 'module', packageManager,
  dependencies: { '@deepseek-ai/dsh': hostVersion },
}, null, 2) + '\n')
writeFileSync(join(directory, 'pnpm-workspace.yaml'), stringifyYaml({ packages: ['.'], ...releaseAgePolicy }))
copyFileSync(join(fixtureSources, 'packed-runner.mjs'), join(directory, 'runner.mjs'))
copyFileSync(join(fixtureSources, 'packed-profile.patch.yml'), join(profile, 'cordis.patch.yml'))
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'slice-packed-profile', private: true, type: 'module', packageManager,
  dsh: { profile: { bundles: [], patchReload: 'startup' } },
}, null, 2) + '\n')
// Match the supported launcher's own profile defaults; peers resolve to its
// installation, so the plugin and host share one Cordis/DSH module graph.
writeFileSync(join(profile, 'pnpm-workspace.yaml'), stringifyYaml({
  packages: ['.'], nodeLinker: 'hoisted', autoInstallPeers: false, ...releaseAgePolicy,
}))
const env = { ...process.env, DSH_HOME: home, DSH_VALIDATION_OUTPUT: output }
let commandNumber = 0
/** @param {string} command @param {string[]} args @param {string} [cwd] @param {{allowExitFailure?: boolean}} [options] */
function run(command, args, cwd = directory, options = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: stepTimeoutMs })
  const filename = `command-${++commandNumber}.log`
  const log = join(output, filename)
  writeFileSync(log, JSON.stringify({ command, args, cwd, status: result.status }) + '\n' + (result.stdout ?? '') + (result.stderr ?? ''))
  if (result.error !== undefined || (result.status !== 0 && options.allowExitFailure !== true)) {
    throw new Error(`Packed validation failed; see ${log}`, { cause: result.error })
  }
  return { ...result, log }
}
const hostScope = '@deepseek-ai/'
const immatureLine = /^\s*(@[^/\s]+\/[^@\s]+)@(\S+) was published at \S+, within the minimumReleaseAge cutoff/gm
/**
 * Install the published host under the carried policy. The host's release
 * closure (CLI, apps, platform kits) reaches far beyond this repository's
 * lockfile, and pnpm 11.7.0 does not auto-exempt transitive packages: it fails
 * with ERR_PNPM_NO_MATURE_MATCHING_VERSION and lists each immature name@version.
 * Exempt exactly those versions, and only inside the host vendor's own scope;
 * any other immature package still fails the smoke, so the policy keeps gating
 * third-party code. Every exemption is recorded as evidence.
 * @returns {string[]}
 */
function installHost() {
  /** @type {string[]} */
  const exempted = []
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = run('pnpm', ['install', '--ignore-scripts'], directory, { allowExitFailure: true })
    if (result.status === 0) return exempted
    const report = (result.stdout ?? '') + (result.stderr ?? '')
    if (!report.includes('ERR_PNPM_NO_MATURE_MATCHING_VERSION')) throw new Error(`Packed host install failed; see ${result.log}`)
    const listed = [...new Set([...report.matchAll(immatureLine)].map(match => `${match[1]}@${match[2]}`))]
    const foreign = listed.filter(entry => !entry.startsWith(hostScope))
    if (foreign.length > 0) {
      throw new Error(`Immature packages outside ${hostScope}* stay gated by minimumReleaseAge: ${foreign.join(', ')}; see ${result.log}`)
    }
    const fresh = listed.filter(entry => !exempted.includes(entry) && !carriedExclude.includes(entry))
    if (fresh.length === 0) throw new Error(`pnpm reported no new immature ${hostScope}* version to exempt; see ${result.log}`)
    exempted.push(...fresh)
    /** @type {{minimumReleaseAgeExclude?: unknown}} */
    const current = parseYaml(readFileSync(join(directory, 'pnpm-workspace.yaml'), 'utf8')) ?? {}
    const kept = Array.isArray(current.minimumReleaseAgeExclude) ? current.minimumReleaseAgeExclude : carriedExclude
    writeFileSync(join(directory, 'pnpm-workspace.yaml'), stringifyYaml({
      ...current, minimumReleaseAgeExclude: [...new Set([...kept, ...fresh])],
    }))
  }
  throw new Error('Packed host install still reported immature versions after three exemption rounds')
}
console.log(`Packed verification workspace: ${directory}`)
const pnpmVersion = run('pnpm', ['--version']).stdout.trim()
const wantedPnpm = /^pnpm@(\S+)$/.exec(packageManager ?? '')?.[1]
if (wantedPnpm !== undefined && pnpmVersion !== wantedPnpm && process.env.SLICE_PACKED_ALLOW_PNPM_MISMATCH !== '1') {
  throw new Error(`verify:packed needs pnpm ${wantedPnpm} (package.json packageManager) but found ${pnpmVersion}. `
    + 'Enable corepack (corepack enable) so the pinned version is used, or set SLICE_PACKED_ALLOW_PNPM_MISMATCH=1 to accept incomparable evidence.')
}
const releaseAgeHostExempted = installHost()
writeFileSync(join(output, 'release-age-host-exempted.json'), JSON.stringify(releaseAgeHostExempted, null, 2) + '\n')
// With minimumReleaseAgeStrict off, pnpm itself may append an immature direct
// dependency it resolved. Record anything beyond the carried and host-scope
// entries so the evidence shows every exemption that applied.
/** @type {{minimumReleaseAgeExclude?: unknown}} */
const installedWorkspace = parseYaml(readFileSync(join(directory, 'pnpm-workspace.yaml'), 'utf8')) ?? {}
const releaseAgeAppended = (Array.isArray(installedWorkspace.minimumReleaseAgeExclude) ? installedWorkspace.minimumReleaseAgeExclude : [])
  .filter(entry => !carriedExclude.includes(entry) && !releaseAgeHostExempted.includes(entry))
writeFileSync(join(output, 'release-age-appended.json'), JSON.stringify(releaseAgeAppended, null, 2) + '\n')
const host = createRequire(realpathSync(join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')))
// Since 0.1.5 DSH ships its platform flock addon as a package dependency; it
// no longer depends on fs-ext or needs a local native-addon build for this fixture.
const cli = join(dirname(host.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')
run(process.execPath, [cli, '--version'])
run(process.execPath, [cli, 'plugin', '--profile', 'slice-packed', 'add', artifact, '--ignore-scripts'])
run(process.execPath, [cli, '--profile', 'slice-packed', '--dump-config'])
run(process.execPath, [cli, '--profile', 'slice-packed'])
const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'))
if (summary.dsh !== hostVersion) throw new Error(`Expected DSH ${hostVersion}, loaded ${summary.dsh}`)
const verified = { ...summary, releaseAgeExcludeCarried: carriedExclude.length, releaseAgeHostExempted: releaseAgeHostExempted.length, releaseAgeExcludeAppended: releaseAgeAppended.length, artifactSha256: sha256, node: process.version, pnpm: pnpmVersion, platform: process.platform, arch: process.arch }
writeFileSync(join(output, 'summary.json'), JSON.stringify(verified, null, 2) + '\n')
console.log(JSON.stringify({ ...verified, evidence: output }, null, 2))
