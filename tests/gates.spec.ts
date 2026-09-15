import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkBuild } from '../scripts/check-build.mjs'
import { checkPeerRanges } from '../scripts/check-peer-ranges.mjs'
import { linkDsh, sourcePackages } from '../scripts/link-dsh.mjs'

const fault = vi.hoisted(() => ({ destination: '' }))
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, renameSync: (...args: Parameters<typeof original.renameSync>) => {
    if (fault.destination && String(args[0]).includes('.slice-stage-') && args[1] === fault.destination) {
      throw new Error('injected filesystem rename failure')
    }
    return original.renameSync(...args)
  } }
})

const temporary: string[] = []
function directory() { const path = mkdtempSync(join(tmpdir(), 'slice-gate-')); temporary.push(path); return path }
function write(path: string, value: object | string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}
afterEach(() => { fault.destination = ''; for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })

function git(repo: string, ...args: string[]) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
function gitFixture() {
  const repo = directory()
  git(repo, 'init')
  write(join(repo, 'lib/index.js'), 'export const value = 1\n')
  git(repo, 'add', 'lib')
  git(repo, '-c', 'user.name=Gate Fixture', '-c', 'user.email=fixture@invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture')
  return repo
}
describe('generated artifact gate', () => {
  it('accepts a clean generated tree', () => expect(() => checkBuild(gitFixture())).not.toThrow())
  it.each(['modified', 'deleted', 'untracked', 'staged', 'ignored'] as const)('rejects %s output drift', mode => {
    const repo = gitFixture()
    if (mode === 'modified') write(join(repo, 'lib/index.js'), 'changed\n')
    if (mode === 'deleted') rmSync(join(repo, 'lib/index.js'))
    if (mode === 'untracked' || mode === 'staged') write(join(repo, 'lib/new.js'), 'new\n')
    if (mode === 'staged') git(repo, 'add', 'lib/new.js')
    if (mode === 'ignored') {
      write(join(repo, '.gitignore'), 'lib/ignored.js\n')
      write(join(repo, 'lib/ignored.js'), 'ignored\n')
    }
    expect(() => checkBuild(repo)).toThrow('Generated lib/ differs')
  })
})
describe('declared root peer gate', () => {
  function fixture(version?: string, optional = false) {
    const repo = directory()
    write(join(repo, 'package.json'), { peerDependencies: { '@fixture/host': '0.1.5-rc.1 || 0.1.5-rc.2' }, peerDependenciesMeta: { '@fixture/host': { optional } } })
    if (version) write(join(repo, 'node_modules/@fixture/host/package.json'), { name: '@fixture/host', version })
    return repo
  }
  it.each(['0.1.5-rc.1', '0.1.5-rc.2'])('accepts supported prerelease %s', version => expect(checkPeerRanges(fixture(version))).toHaveLength(1))
  it.each(['0.1.5-rc.3', '0.2.0-alpha.1'])('rejects unsupported installed peer %s despite dev upgrade', version => expect(() => checkPeerRanges(fixture(version))).toThrow('does not satisfy'))
  it.each([false, true])('rejects an installed optional peer with an inaccessible package manifest (missing target %s)', missingTarget => {
    const repo = fixture('0.2.0-alpha.1', true)
    write(join(repo, 'node_modules/@fixture/host/package.json'), {
      name: '@fixture/host', version: '0.2.0-alpha.1', exports: { '.': './index.js', ...(missingTarget ? { './package.json': './missing.json' } : {}) },
    })
    write(join(repo, 'node_modules/@fixture/host/index.js'), 'module.exports = {}')
    expect(() => checkPeerRanges(repo)).toThrow('Cannot inspect installed peer')
  })
  it('rejects missing required peers but allows missing optional peers', () => {
    expect(() => checkPeerRanges(fixture())).toThrow('Required peer is missing')
    expect(checkPeerRanges(fixture(undefined, true))).toEqual([])
    expect(() => checkPeerRanges(fixture('0.2.0-alpha.1', true))).toThrow('does not satisfy')
  })
})
describe('source linking', () => {
  it('derives all DSH dependencies including native settings and JSONL tests from the manifest', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const names = sourcePackages(manifest)
    expect(names).toContain('@deepseek-ai/dsh-settings')
    expect(names).toContain('@deepseek-ai/dsh-session-persistence-jsonl')
    expect(names).toContain('@deepseek-ai/dsh-llm-deepseek')
    expect(names).not.toContain('typescript')
  })
  it('links every discovered manifest name and verifies the resolved source locations', () => {
    const repo = directory(), host = directory()
    write(join(repo, 'package.json'), { devDependencies: { '@deepseek-ai/dsh-settings': 'x', '@deepseek-ai/dsh-session-persistence-jsonl': 'x' } })
    for (const [path, name] of [['packages/moved/settings', '@deepseek-ai/dsh-settings'], ['packages/session/jsonl', '@deepseek-ai/dsh-session-persistence-jsonl']]) {
      write(join(host, path!, 'package.json'), { name })
    }
    expect(linkDsh(repo, host)).toHaveLength(2)
    expect(realpathSync(join(repo, 'node_modules/@deepseek-ai/dsh-settings'))).toBe(realpathSync(join(host, 'packages/moved/settings')))
    expect(realpathSync(join(repo, 'node_modules/@deepseek-ai/dsh-session-persistence-jsonl'))).toBe(realpathSync(join(host, 'packages/session/jsonl')))
  })
  it('preflights missing packages without changing any existing package', () => {
    const repo = directory(), host = directory()
    write(join(repo, 'package.json'), { devDependencies: { '@deepseek-ai/available': 'x', '@deepseek-ai/missing': 'x' } })
    write(join(host, 'packages/moved/available/package.json'), { name: '@deepseek-ai/available' })
    write(join(repo, 'node_modules/@deepseek-ai/available/package.json'), { name: '@deepseek-ai/available', version: 'sentinel' })
    expect(() => linkDsh(repo, host)).toThrow('no links changed')
    expect(JSON.parse(readFileSync(join(repo, 'node_modules/@deepseek-ai/available/package.json'), 'utf8')).version).toBe('sentinel')
  })
  it('restores all original package directories when a replacement fails after earlier links were installed', () => {
    const repo = realpathSync(directory()), host = directory()
    const names = ['@deepseek-ai/first', '@deepseek-ai/second']
    write(join(repo, 'package.json'), { devDependencies: Object.fromEntries(names.map(name => [name, 'x'])) })
    for (const name of names) {
      write(join(host, 'packages', name.split('/')[1]!, 'package.json'), { name })
      write(join(repo, 'node_modules', name, 'package.json'), { name, version: 'original' })
    }
    fault.destination = join(repo, 'node_modules', names[1]!)
    expect(() => linkDsh(repo, host)).toThrow('injected filesystem rename failure')
    for (const name of names) {
      expect(JSON.parse(readFileSync(join(repo, 'node_modules', name, 'package.json'), 'utf8')).version).toBe('original')
    }
  })

})
