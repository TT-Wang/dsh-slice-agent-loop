import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { checkDocAnchors } from '../scripts/check-doc-anchors.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('rejects retired symbols even when their names remain in comments or strings', () => {
  const root = mkdtempSync(join(tmpdir(), 'slice-docs-'))
  roots.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/policy.ts'), 'export function planSeal() {}\n// planArchive\nconst old = "planArchive"')
  writeFileSync(join(root, 'CONTEXT.md'), '<!-- code-anchor: src/policy.ts#planSeal -->\n[source](src/policy.ts)')
  expect(checkDocAnchors(root)).toEqual([])
  writeFileSync(join(root, 'CONTEXT.md'), '<!-- code-anchor: src/policy.ts#planArchive -->')
  expect(checkDocAnchors(root)).toEqual([expect.stringContaining('missing code declaration src/policy.ts#planArchive')])
})

it('checks relative links but allows explicit historical code and external links', () => {
  const root = mkdtempSync(join(tmpdir(), 'slice-docs-'))
  roots.push(root)
  writeFileSync(join(root, 'CONTEXT.md'), '`[historical](missing.ts)`\n[external](https://example.com)\n[bad](missing.ts)')
  expect(checkDocAnchors(root)).toEqual([expect.stringContaining('missing relative link missing.ts')])
})
