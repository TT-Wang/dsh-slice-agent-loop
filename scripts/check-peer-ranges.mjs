#!/usr/bin/env node
/** Check the plugin's own promise, which pnpm's dependency-peer check omits. */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { satisfies, validRange } from 'semver'

/** @typedef {{peerDependencies?: Record<string, string>, peerDependenciesMeta?: Record<string, {optional?: boolean}>}} PeerManifest */
/** @param {string} repo */
export function checkPeerRanges(repo) {
  const path = join(repo, 'package.json')
  /** @type {PeerManifest} */
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  const require = createRequire(path)
  const versions = []
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!validRange(range)) throw new Error(`Invalid declared peer range: ${name}@${range}`)
    let installed
    try { installed = require.resolve(`${name}/package.json`) } catch (error) {
      // Optional means absent is allowed, not that an installed package may
      // hide its version or otherwise fail resolution. Fail closed in that case.
      const present = (require.resolve.paths(name) ?? []).some(path => existsSync(join(path, name)))
      const missing = !present && error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND'
      if (manifest.peerDependenciesMeta?.[name]?.optional && missing) continue
      throw new Error(`${missing ? 'Required peer is missing' : 'Cannot inspect installed peer'}: ${name}@${range}`, { cause: error })
    }
    const { version } = JSON.parse(readFileSync(installed, 'utf8'))
    if (typeof version !== 'string' || !satisfies(version, range)) {
      throw new Error(`Installed ${name}@${version} does not satisfy declared peer range ${range}`)
    }
    versions.push(`${name}@${version} satisfies ${range}`)
  }
  return versions
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  console.log(checkPeerRanges(fileURLToPath(new URL('../', import.meta.url))).join('\n'))
}
