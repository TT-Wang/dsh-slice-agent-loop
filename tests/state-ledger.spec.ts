/** 世界状态纯函数层:账本 append-only 字节前缀性、谓词校验、规则 JSON 防御解析。 */
import { describe, expect, it } from 'vitest'
import {
  addFact, checkPredicates, createLedger, currentFiles, globToRegExp, liveFacts,
  parseRulesJson, recordFile, renderConstitution, renderLedger, supersedeFact,
} from '../src/slice/state-ledger.js'

describe('state ledger', () => {
  it('renders append-only: a later render extends the earlier one as a byte prefix', () => {
    const l = createLedger()
    recordFile(l, { path: 'a.py', sha: 'aaaaaaaaaaaa', action: 'read', step: 1 })
    addFact(l, { kind: 'rule', text: 'ports are 5 digits', sourceDigest: 'host:3', step: 1 })
    const r1 = renderLedger(l)
    recordFile(l, { path: 'a.py', sha: 'bbbbbbbbbbbb', action: 'edit', step: 4 })
    addFact(l, { kind: 'decision', text: 'migrate in chain order', sourceDigest: 'host:9', step: 4 })
    const r2 = renderLedger(l)
    // 文件段在事实段之前,追加文件行会插在中间——所以前缀性只对"文件段"与"事实段"分别成立。
    const filesPart = (s: string) => s.split('## facts')[0]!
    const factsPart = (s: string) => s.split('## facts')[1]!
    expect(filesPart(r2).startsWith(filesPart(r1))).toBe(true)
    expect(factsPart(r2).startsWith(factsPart(r1).replace(/\n$/, ''))).toBe(true)
    expect(currentFiles(l).get('a.py')?.sha).toBe('bbbbbbbbbbbb')
  })

  it('dedups repeated identical reads and supersedes facts without rewriting old lines', () => {
    const l = createLedger()
    recordFile(l, { path: 'x', sha: '1', action: 'read', step: 1 })
    recordFile(l, { path: 'x', sha: '1', action: 'read', step: 2 })
    expect(l.fileLog).toHaveLength(1)
    const f1 = addFact(l, { kind: 'fact', text: 'tier of n01 is gold', sourceDigest: 'h:1', step: 1 })
    const before = renderLedger(l)
    const f2 = supersedeFact(l, f1.id, { kind: 'fact', text: 'tier of n01 is silver', sourceDigest: 'h:7', step: 7 })
    const after = renderLedger(l)
    expect(liveFacts(l).map((f) => f.id)).toEqual([f2.id])
    // 旧条目那一行字节不变;取代关系作为新行追加。
    const oldLine = `#${f1.id} [fact] tier of n01 is gold  (src:h:1 @1)`
    expect(before).toContain(oldLine)
    expect(after).toContain(oldLine)
    expect(after).toContain(`#${f2.id} supersedes #${f1.id}`)
  })
})

describe('constitution & predicates', () => {
  it('glob → regexp', () => {
    expect(globToRegExp('out/*.svc').test('out/a.svc')).toBe(true)
    expect(globToRegExp('out/*.svc').test('out/x/a.svc')).toBe(false)
    expect(globToRegExp('**/*.md').test('docs/a/b.md')).toBe(true)
  })
  it('checks each predicate kind and skips non-matching globs', () => {
    const rules = parseRulesJson(JSON.stringify([
      { id: 'R1', text: 'svc files are lowercase', predicate: { kind: 'path-regex', glob: 'out/*.svc', pattern: '^[a-z]+\\.svc$' } },
      { id: 'R2', text: 'header line', predicate: { kind: 'content-includes', glob: 'out/*.svc', needle: '# migrated-by: kestrel-v3' } },
      { id: 'R3', text: 'no legacy prefix', predicate: { kind: 'content-excludes', glob: 'out/*.svc', needle: 'legacy-' } },
      { id: 'R4', text: 'width', predicate: { kind: 'line-max', glob: 'out/*.svc', max: 40 } },
      { id: 'R5', text: 'tier enum', predicate: { kind: 'field-enum', glob: 'out/*.svc', field: 'tier', values: ['p1', 'p3', 'p7'] } },
      { id: 'R6', text: 'soft rule without predicate' },
    ]))
    expect(rules).toHaveLength(6)
    expect(rules[5]!.predicate).toBeUndefined()
    const good = '# migrated-by: kestrel-v3\nname = alpha\ntier = p3\n'
    expect(checkPredicates(rules, 'out/alpha.svc', good)).toEqual([])
    const bad = 'name = legacy-alpha\ntier = gold\nthis line is definitely too long for a forty char limit\n'
    const v = checkPredicates(rules, 'out/Alpha.svc', bad)
    expect(v.some((s) => s.startsWith('R1'))).toBe(true)
    expect(v.some((s) => s.startsWith('R2'))).toBe(true)
    expect(v.some((s) => s.startsWith('R3'))).toBe(true)
    expect(v.some((s) => s.startsWith('R4'))).toBe(true)
    expect(v.some((s) => s.startsWith('R5') && s.includes('gold'))).toBe(true)
    // 不匹配 glob 的路径不检查
    expect(checkPredicates(rules, 'README.md', bad)).toEqual([])
  })
  it('parseRulesJson is defensive: garbage → [], bad predicate → text-only rule', () => {
    expect(parseRulesJson('nope')).toEqual([])
    const r = parseRulesJson('prose before [{"text":"keep it","predicate":{"kind":"line-max","glob":"*","max":"x"}}] after')
    expect(r).toHaveLength(1)
    expect(r[0]!.predicate).toBeUndefined()
  })
  it('renders the constitution with request, pinned files and enforced markers', () => {
    const c = renderConstitution({
      request: 'migrate the chain',
      pinned: [{ path: 'MANIFEST.txt', text: 'rule A\nrule B\n' }],
      rules: [{ id: 'R1', text: 'lowercase', predicate: { kind: 'path-regex', glob: '*', pattern: '^[a-z]+$' } }, { id: 'R2', text: 'be formal' }],
    })
    expect(c).toContain('## request\nmigrate the chain')
    expect(c).toContain('## pinned: MANIFEST.txt\nrule A\nrule B')
    expect(c).toContain('R1 [enforced]: lowercase')
    expect(c).toContain('R2: be formal')
  })
})
