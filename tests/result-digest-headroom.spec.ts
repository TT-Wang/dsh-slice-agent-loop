/**
 * Headroom 借鉴的三类压缩(2026-09-03 夜):JSON 按元素、grep 按文件配额、统一 diff 按 hunk;日志省略标记带层级计数。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_DIGEST_POLICY, digestToolResult } from '../src/slice/result-digest.js'

describe('json results', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item-${i}`, size: 1000 + i, status: i === 77 ? 500 : 200, tags: ['a', 'b'] }))
  it('keeps head, tail and error items of a large JSON array with an omission marker naming the fields', () => {
    const text = JSON.stringify(rows, null, 2)
    const r = digestToolResult(text, { tool: 'bash' })
    expect(r.kind).toBe('json'); expect(r.digested).toBe(true)
    expect(r.text).toContain('"id":0'); expect(r.text).toContain('"id":199')
    expect(r.text).toContain('"id":77')                                 // status 500 → error-ish → pinned
    expect(r.text).toMatch(/…\[\+\d+ of 200 items omitted; fields: id, name, size, status, tags\]…/)
    expect(r.text.length).toBeLessThan(text.length * 0.3)
  })
  it('handles an object with a big array field and JSONL, leaves small arrays alone', () => {
    const obj = JSON.stringify({ ok: true, page: 3, results: rows }, null, 2)
    const r = digestToolResult(obj, { tool: 'bash' })
    expect(r.digested).toBe(true); expect(r.text).toContain('"results": [')
    const jsonl = rows.map((x) => JSON.stringify(x)).join('\n')
    expect(digestToolResult(jsonl, { tool: 'bash' }).digested).toBe(true)
    expect(digestToolResult(JSON.stringify(rows.slice(0, 4), null, 2), { tool: 'bash' }).digested).toBe(false)
  })
})

describe('search results', () => {
  const big = Array.from({ length: 40 }, (_, f) => Array.from({ length: 12 }, (_, i) => `src/mod${f}.ts:${i * 3 + 1}:const value${i} = ${i}`)).flat().join('\n')
  it('caps matches per file above the threshold, keeps first and last per file, says how many were dropped', () => {
    const r = digestToolResult(big, { tool: 'grep' })
    expect(r.kind).toBe('search'); expect(r.digested).toBe(true)
    expect(r.text).toContain('src/mod0.ts:1:'); expect(r.text).toContain('src/mod0.ts:34:')
    expect(r.text).toContain('[... and 7 more matches in src/mod0.ts]')
    expect(r.text.split('\n').filter((l) => /^src\/mod\d+\.ts:\d+:/.test(l)).length).toBeLessThanOrEqual(DEFAULT_DIGEST_POLICY.searchMaxTotal)
  })
  it('leaves ordinary grep results untouched', () => {
    const small = Array.from({ length: 30 }, (_, i) => `src/a.ts:${i}:foo ${i}`).join('\n')
    expect(digestToolResult(small, { tool: 'grep' }).digested).toBe(false)
  })
})

describe('unified diffs', () => {
  const hunk = (file: string, k: number) => [`@@ -${k * 40},30 +${k * 40},31 @@ fn${k}`, ...Array.from({ length: 12 }, (_, i) => ` ctx ${i}`), `-old line ${k}`, `+new line ${k}`, ...Array.from({ length: 12 }, (_, i) => ` ctx tail ${i}`)]
  const diff = ['diff --git a/x.ts b/x.ts', 'index 111..222 100644', '--- a/x.ts', '+++ b/x.ts', ...Array.from({ length: 14 }, (_, k) => hunk('x.ts', k)).flat()].join('\n')
  it('keeps headers and changes with two context lines, caps hunks per file, never routes a diff as code', () => {
    const r = digestToolResult(diff, { tool: 'bash' })
    expect(r.kind).toBe('diff'); expect(r.digested).toBe(true)
    expect(r.text).toContain('diff --git a/x.ts b/x.ts'); expect(r.text).toContain('+new line 0'); expect(r.text).toContain('-old line 13')
    expect(r.text).not.toContain(' ctx 3')                                // 远离改动的上下文被折
    expect(r.text).toContain('[... and 4 more hunks in file #1]')
    expect(r.text.length).toBeLessThan(diff.length * 0.5)
  })
  it('passes short diffs through', () => {
    const short = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', ...hunk('x.ts', 0)].join('\n')
    expect(digestToolResult(short, { tool: 'bash' }).digested).toBe(false)
  })
})

describe('log omission marker', () => {
  it('reports how many error and warning lines were not shown', () => {
    const lines: string[] = []
    for (let i = 0; i < 400; i += 1) lines.push(i % 25 === 0 ? `2026-09-03 10:00:${String(i % 60).padStart(2, '0')} ERROR worker ${i} failed: boom` : i % 9 === 0 ? `2026-09-03 10:00:00 WARN slow ${i}` : `2026-09-03 10:00:00 INFO tick ${i}`)
    const r = digestToolResult(lines.join('\n'), { tool: 'bash' })
    expect(r.kind).toBe('log'); expect(r.digested).toBe(true)
    expect(r.text).toMatch(/\[\d+ lines omitted: \d+ more error lines, \d+ more warning\/summary lines\]/)
  })
})

describe('tables in documents', () => {
  it('keeps every table row of a fetched documentation page while folding the prose', () => {
    const prose = (i: number) => `The ${i}th paragraph explains the request lifecycle in great detail ${'and so on '.repeat(20)}`
    const rows = Array.from({ length: 12 }, (_, i) => ` | param_${i} | integer | ${i * 10} | what it does |`)
    const page = ['# https://docs.example.com/api/client', '', '# Client', ...Array.from({ length: 30 }, (_, i) => prose(i)), '## Configuration', ' | name | type | default | description |', ...rows, '## Retry policy', ...Array.from({ length: 30 }, (_, i) => prose(100 + i))].join('\n')
    const r = digestToolResult(page, { tool: 'fetch_page', path: 'https://docs.example.com/api/client' })
    expect(r.digested).toBe(true)
    for (const row of rows) expect(r.text).toContain(row.trim())
    expect(r.text).toContain('## Configuration'); expect(r.text).toContain('## Retry policy')
    expect(r.text.length).toBeLessThan(page.length * 0.55)
  })
})
