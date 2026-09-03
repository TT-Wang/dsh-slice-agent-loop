/**
 * data 类超长行按字符截断(2026-09-03):s13 的 blob 是 3 行 × 3K 字符,按行的头尾逻辑一行不少地全留下。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_DIGEST_POLICY, digestToolResult } from '../src/slice/result-digest.js'

const word = () => Math.random().toString(36).slice(2, 8)
const blobLine = (n: number) => Array.from({ length: n }, word).join(' ')

describe('long lines in data results', () => {
  it('cuts a 3-line 9K blob to head/tail chars per line and marks it digested', () => {
    const text = [blobLine(450), blobLine(450), blobLine(450)].join('\n')
    expect(text.length).toBeGreaterThan(8000)
    const r = digestToolResult(text, { tool: 'read', path: 'data/blob_01.txt' })
    expect(r.kind).toBe('data')
    expect(r.digested).toBe(true)
    expect(r.text.length).toBeLessThan(text.length * 0.5)
    expect(r.text).toContain('…[+')
    expect(r.text.startsWith(text.slice(0, 700))).toBe(true)           // 首行头 700 字符原样
    expect(r.totalLines).toBe(3)
  })
  it('leaves ordinary lines alone and never touches code or search results', () => {
    const prose = Array.from({ length: 40 }, (_, i) => `line ${i}: ${blobLine(8)}`).join('\n')
    const r = digestToolResult(prose, { tool: 'read', path: 'notes.md' })
    for (const line of r.text.split('\n')) expect(line.length).toBeLessThan(200)
    const code = `const x = "${'a'.repeat(3000)}"\nexport default x\n` + Array.from({ length: 30 }, (_, i) => `function f${i}() { return ${i} }`).join('\n')
    expect(digestToolResult(code, { tool: 'read', path: 'x.ts' }).digested).toBe(false)
    const grep = Array.from({ length: 5 }, (_, i) => `a.txt:${i}:${'z'.repeat(2000)}`).join('\n')
    expect(digestToolResult(grep, { tool: 'grep' }).digested).toBe(false)
  })
  it('can be switched off', () => {
    const text = [blobLine(450), blobLine(450), blobLine(450)].join('\n')
    const r = digestToolResult(text, { tool: 'read', path: 'blob.txt' }, { ...DEFAULT_DIGEST_POLICY, maxLineChars: Infinity })
    expect(r.digested).toBe(false)
  })
})
