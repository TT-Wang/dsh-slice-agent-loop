#!/usr/bin/env node
/** Link every declared DSH dependency to one source checkout, validated first.
 * DSH_SOURCE overrides DSH_HOME/source/current and ~/.dsh/source/current.
 * Example-only imports are listed in package.json's sliceDevelopment section.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, symlinkSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @typedef {{ name?: string, dependencies?: Record<string,string>, devDependencies?: Record<string,string>, peerDependencies?: Record<string,string>, sliceDevelopment?: {sourceOnlyPackages?: string[]} }} Manifest */
/** @param {string} file @returns {Manifest} */
function manifestAt(file) { return JSON.parse(readFileSync(file, 'utf8')) }
/** @param {Manifest} manifest */
export function sourcePackages(manifest) {
  return [...new Set([
    ...Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies }),
    ...manifest.sliceDevelopment?.sourceOnlyPackages ?? [],
  ].filter(name => name.startsWith('@deepseek-ai/')))].sort()
}
/** Discover by manifest name so upstream directory moves do not create mixed graphs.
 * @param {string} harness
 */
function discover(harness) {
  /** @type {Map<string,string>} */
  const packages = new Map()
  /** @param {string} dir @param {number} depth */
  function visit(dir, depth) {
    if (!existsSync(dir)) return
    const file = join(dir, 'package.json')
    if (existsSync(file)) {
      const { name } = manifestAt(file)
      if (name?.startsWith('@deepseek-ai/')) {
        const previous = packages.get(name)
        if (previous && realpathSync(previous) !== realpathSync(dir)) throw new Error(`Duplicate source package ${name}: ${previous}, ${dir}`)
        packages.set(name, dir)
      }
    }
    if (depth === 0) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !['node_modules', 'lib', '.git'].includes(entry.name)) visit(join(dir, entry.name), depth - 1)
    }
  }
  for (const root of ['packages', 'vendor']) visit(join(harness, root), 4)
  return packages
}
/** Preflight all packages before changing any local link.
 * @param {string} repo @param {string} harness
 */
export function linkDsh(repo, harness) {
  // Resolve macOS /var aliases and user symlinked checkouts before relative links.
  repo = realpathSync(repo)
  harness = realpathSync(harness)
  const byName = discover(harness)
  const links = sourcePackages(manifestAt(join(repo, 'package.json'))).map(name => {
    const target = byName.get(name)
    if (!target) throw new Error(`Source package ${name} is missing from ${harness}; no links changed`)
    return { name, target: realpathSync(target), link: join(repo, 'node_modules', name) }
  })
  const nonce = randomUUID()
  const transaction = links.map(item => ({
    ...item, stage: `${item.link}.slice-stage-${nonce}`, backup: `${item.link}.slice-backup-${nonce}`,
    backedUp: false, installed: false,
  }))
  try {
    // Prepare and verify every link before touching existing package directories.
    // Staging beside the destination preserves relative-link resolution on rename.
    for (const item of transaction) {
      mkdirSync(dirname(item.link), { recursive: true })
      symlinkSync(relative(dirname(item.link), item.target), item.stage, 'dir')
      if (realpathSync(item.stage) !== item.target || manifestAt(join(item.stage, 'package.json')).name !== item.name) {
        throw new Error(`Source link verification failed for ${item.name}`)
      }
    }
    for (const item of transaction) {
      if (lstatSync(item.link, { throwIfNoEntry: false })) {
        renameSync(item.link, item.backup)
        item.backedUp = true
      }
      renameSync(item.stage, item.link)
      item.installed = true
    }
    for (const item of transaction) {
      if (realpathSync(item.link) !== item.target) throw new Error(`Installed source link verification failed for ${item.name}`)
    }
  } catch (error) {
    const failures = [error]
    for (const item of transaction.reverse()) {
      try {
        if (item.installed) rmSync(item.link, { recursive: true, force: true })
        if (item.backedUp) renameSync(item.backup, item.link)
      } catch (rollback) { failures.push(rollback) }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Source linking failed and rollback was incomplete; preserved .slice-backup files require inspection')
    throw error
  } finally {
    for (const item of transaction) rmSync(item.stage, { recursive: true, force: true })
  }
  for (const item of transaction) {
    if (!item.backedUp) continue
    try { rmSync(item.backup, { recursive: true, force: true }) } catch (error) {
      process.emitWarning(`Source link installed, but old backup could not be removed: ${item.backup}`, { detail: String(error) })
    }
  }
  return links.map(({ name, target }) => `${name} -> ${target}`)
}
function resolveHarness() {
  const explicit = process.env.DSH_SOURCE
  const candidates = explicit !== undefined ? [explicit] : [
    ...process.env.DSH_HOME ? [join(process.env.DSH_HOME, 'source', 'current')] : [],
    join(homedir(), '.dsh', 'source', 'current'),
  ]
  const harness = candidates.find(candidate => existsSync(join(candidate, 'package.json')) && existsSync(join(candidate, 'packages')))
  if (!harness) throw new Error(`No DSH source checkout found. Set DSH_SOURCE. Tried:\n${candidates.join('\n')}`)
  return realpathSync(harness)
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  console.log(linkDsh(fileURLToPath(new URL('../', import.meta.url)), resolveHarness()).join('\n'))
}
