#!/usr/bin/env node
/**
 * Link the DeepSeek Harness peer packages into node_modules for local development.
 *
 * The peers are provided by the HOST at runtime, so they are declared only as
 * `peerDependencies` — never as `dependencies`. Publishing a manifest whose
 * `dependencies` point at `file:/Users/<someone>/...` makes the package
 * uninstallable for everyone else, which is exactly what this script replaces.
 *
 * Resolution order for the harness checkout:
 *   1. $DSH_SOURCE          — explicit override
 *   2. $DSH_HOME/source/current
 *   3. ~/.dsh/source/current — the default `dsh` install layout
 *
 * Usage: npm run link:dsh
 */
import { existsSync, mkdirSync, rmSync, symlinkSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Peer package name → its path inside the harness checkout. */
const PEERS = {
  '@deepseek-ai/dsh-agent': 'packages/core/agent',
  '@deepseek-ai/dsh-session': 'packages/core/session',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@deepseek-ai/dsh-system-prompt': 'packages/core/system-prompt',
  '@deepseek-ai/dsh-tools': 'packages/core/tools',
  '@deepseek-ai/dsh-scope': 'packages/core/scope',
  // Moved from packages/session-persistence/* in the 20260810 snapshot.
  '@deepseek-ai/dsh-session-persistence': 'packages/session/session-persistence',
  // Rescoped in the 20260811 snapshot (scripts/rescope-vendor.ts); the tree
  // ships it under vendor/ and every package reaches it by that symlink.
  '@deepseek-ai/cordis': 'vendor/cordis',
  // Test-only: the incompatibility gate mounts the stock loop's invariant
  // companion to prove this plugin refuses it at load time (评审 D).
  '@deepseek-ai/dsh-invariants': 'packages/support/invariants',
  '@deepseek-ai/dsh-agent-loop': 'packages/core/agent-loop',
  // Test-only: the Code Mode anchoring gate needs a CodeRuntime to mount run_code.
  '@deepseek-ai/dsh-code-runtime': 'packages/code-runtime/code-runtime',
  // driver.ts 自 a4 迁移起用它(SessionSeq 等品牌类型工具)。
  '@deepseek-ai/dsh-util-values': 'packages/util/values',
  '@deepseek-ai/dsh-token-meter': 'packages/llm/token-meter',
  // 原生 AgentLoop 的依赖:tool-result-fold 插件的契约测试要挂原生 loop。
  '@deepseek-ai/dsh-session-projection': 'packages/session/session-projection',
  // tool-result-fold 的 spill 预览臂:类型来自 dsh-spill,契约测试挂真实的 spill-local + spill-policy。
  '@deepseek-ai/dsh-spill': 'packages/spill/spill',
  '@deepseek-ai/dsh-spill-local': 'packages/spill/spill-local',
  '@deepseek-ai/dsh-spill-policy': 'packages/spill/spill-policy',
  '@deepseek-ai/dsh-output-retention': 'packages/util/output-retention',
}

/** Older harness snapshots that moved a package keep a fallback path here. */
const FALLBACKS = {
  '@deepseek-ai/dsh-session-persistence': ['packages/session-persistence/session-persistence'],
}

function resolveHarness() {
  const candidates = [
    process.env.DSH_SOURCE,
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'source', 'current') : undefined,
    join(homedir(), '.dsh', 'source', 'current'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'packages', 'core', 'agent', 'package.json'))) return candidate
  }
  console.error(
    'Could not find a DeepSeek Harness checkout.\n'
    + 'Set DSH_SOURCE to the harness repo root, or install dsh so that\n'
    + `${join(homedir(), '.dsh', 'source', 'current')} exists.\n`
    + `Tried:\n${candidates.map(c => `  ${c}`).join('\n')}`,
  )
  process.exit(1)
}

const harness = resolveHarness()
const modules = join(REPO, 'node_modules')
let linked = 0

// Discover every workspace package by its manifest name, so a snapshot that
// moves a directory (support/invariants → runtime-diagnostics/invariants in
// 20260812) cannot silently break a hardcoded path.
import { readFileSync, readdirSync } from 'node:fs'
const byName = new Map()
for (const root of ['packages', 'vendor']) {
  const rootDir = join(harness, root)
  if (!existsSync(rootDir)) continue
  for (const lvl1 of readdirSync(rootDir)) {
    for (const dir of [join(rootDir, lvl1), ...(() => {
      const d = join(rootDir, lvl1)
      try { return readdirSync(d).map(x => join(d, x)) } catch { return [] }
    })()]) {
      const manifest = join(dir, 'package.json')
      if (!existsSync(manifest)) continue
      try {
        const name = JSON.parse(readFileSync(manifest, 'utf8')).name
        if (name && !byName.has(name)) byName.set(name, dir)
      } catch { /* unparseable manifest — skip */ }
    }
  }
}

for (const [name, subpath] of Object.entries(PEERS)) {
  const options = [subpath, ...(FALLBACKS[name] ?? [])]
  const target = byName.get(name)
    ?? options.map(p => join(harness, p)).find(p => existsSync(join(p, 'package.json')))
  if (target === undefined) {
    console.error(`✗ ${name}: not found under ${harness} (scanned by name; tried ${options.join(', ')})`)
    process.exitCode = 1
    continue
  }
  const link = join(modules, name)
  mkdirSync(dirname(link), { recursive: true })
  try {
    if (lstatSync(link, { throwIfNoEntry: false }) !== undefined) rmSync(link, { recursive: true, force: true })
  } catch { /* nothing to remove */ }
  // Relative links keep the tree portable if the repo itself moves.
  symlinkSync(relative(dirname(link), target), link, 'dir')
  linked += 1
  console.log(`✓ ${name} -> ${relative(REPO, target)}`)
}

console.log(`\nlinked ${linked}/${Object.keys(PEERS).length} harness peers from ${harness}`)
