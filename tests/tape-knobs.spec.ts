/**
 * 磁带内容旋钮(2026-09-03,寻找"成本最低、正确度不降"的磁带形态):
 *   replyCaps        —— 上一轮回复留多少(默认 head 1400 / tail 500);
 *   checkInDigest    —— 本轮最后一次测试命令及其结论写进轮摘要;
 *   rebaseAfterPatches —— auto 锚定下同一文件累积 N 个 patch 就重落完整基线。
 */
import { describe, expect, it } from 'vitest'
import { createContinuity, sealTurn, trackCheck, trackEdit, trackRead } from '../src/continuity.js'

const seal = (c: ReturnType<typeof createContinuity>, turn: number, reply: string, extra: Record<string, unknown> = {}) =>
  sealTurn(c, { turnId: `slice-turn-${turn}`, status: 'completed', userRequest: 'u', assistantReply: reply, sessionId: 's', ...extra })

describe('tape knobs', () => {
  it('replyCaps widens how much of the previous reply stays on tape', () => {
    const text = Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n') // ≈2.9K chars
    const probe = text.slice(1800, 1900)                                                       // 默认截断会丢掉的中段
    const a = createContinuity(); seal(a, 1, text)
    const b = createContinuity(); seal(b, 1, text, { replyCaps: { cap: 5600, head: 4000, tail: 1500 } })
    const reply = (c: ReturnType<typeof createContinuity>) => c.sessionTape.find((e) => e.kind === 'reply')!.rendered
    expect(reply(a)).not.toContain(probe)
    expect(reply(b)).toContain(probe)
    expect(reply(a)).toContain('chars in sealed turn')
    expect(a.sessionTape.find((e) => e.kind === 'digest')!.rendered).toContain('recall_turn')
    expect(reply(b)).not.toContain('chars in sealed turn')
    expect(b.sessionTape.find((e) => e.kind === 'digest')!.rendered).not.toContain('recall_turn')
  })

  it('checkInDigest carries the last test command and its tail into the turn digest, then clears', () => {
    const c = createContinuity()
    trackCheck(c, 'python -m pytest -q', '....\n\n4 passed in 0.12s\n')
    trackCheck(c, 'python -m pytest -q tests/test_x.py', 'F\nFAILED tests/test_x.py::test_a - AssertionError\n1 failed in 0.05s\n')
    seal(c, 1, 'done', { checkInDigest: true })
    const digest = c.sessionTape.find((e) => e.kind === 'digest')!.rendered
    expect(digest).toContain('check: python -m pytest -q tests/test_x.py → ')
    expect(digest).toContain('1 failed in 0.05s')
    expect(digest).not.toContain('4 passed')
    expect(c.pendingCheck).toBeUndefined()
    // 关掉旋钮:同样的追踪不进摘要
    const d = createContinuity()
    trackCheck(d, 'pytest -q', '3 passed in 0.1s\n')
    seal(d, 1, 'done')
    expect(d.sessionTape.find((e) => e.kind === 'digest')!.rendered).not.toContain('check:')
  })

  it('rebaseAfterPatches re-anchors a full base once N patches have accumulated', () => {
    const c = createContinuity()
    const file = (v: number) => Array.from({ length: 40 }, (_, i) => (i === 20 ? `    return ${v}` : `def f${i}():\n    return ${i}`)).join('\n') + '\n'
    const kinds = () => c.sessionTape.filter((e) => e.kind === 'base' || e.kind === 'patch').map((e) => e.kind)
    trackEdit(c, 'm.py', file(1)); seal(c, 1, 'a', { rebaseAfterPatches: 2 })
    trackEdit(c, 'm.py', file(2)); seal(c, 2, 'a', { rebaseAfterPatches: 2 })
    trackEdit(c, 'm.py', file(3)); seal(c, 3, 'a', { rebaseAfterPatches: 2 })
    expect(kinds()).toEqual(['base', 'patch', 'patch'])
    expect(c.tapeFiles['m.py']!.patches).toBe(2)
    trackEdit(c, 'm.py', file(4)); seal(c, 4, 'a', { rebaseAfterPatches: 2 })
    expect(kinds()).toEqual(['base', 'patch', 'patch', 'base'])
    expect(c.tapeFiles['m.py']!.patches).toBe(0)
    trackEdit(c, 'm.py', file(5)); seal(c, 5, 'a', { rebaseAfterPatches: 2 })
    expect(kinds().at(-1)).toBe('patch')
    // 默认(Infinity)永不重落
    const d = createContinuity()
    for (let v = 1; v <= 6; v++) { trackEdit(d, 'm.py', file(v)); seal(d, v, 'a') }
    expect(d.sessionTape.filter((e) => e.kind === 'base')).toHaveLength(1)
  })
})

describe('collapseEdits', () => {
  it('anchors only the final post-state of a file edited several times in one turn', () => {
    const file = (v: number) => Array.from({ length: 30 }, (_, i) => (i === 10 ? `    return ${v}` : `def g${i}():\n    return ${i}`)).join('\n') + '\n'
    const a = createContinuity()
    trackEdit(a, 'm.py', file(1)); trackEdit(a, 'm.py', file(2)); trackEdit(a, 'm.py', file(3)); trackEdit(a, 'o.py', 'x = 1\n')
    const ra = seal(a, 1, 'r', { anchorMode: 'base', collapseEdits: true })
    expect(ra.anchored.map((x) => x.path)).toEqual(['m.py', 'o.py'])
    expect(a.sessionTape.filter((e) => e.kind === 'base')).toHaveLength(2)
    expect(a.tapeFiles['m.py']!.content).toBe(file(3))
    // 默认:每次编辑各落一条
    const b = createContinuity()
    trackEdit(b, 'm.py', file(1)); trackEdit(b, 'm.py', file(2)); trackEdit(b, 'm.py', file(3))
    const rb = seal(b, 1, 'r', { anchorMode: 'base' })
    expect(rb.anchored).toHaveLength(3)
    expect(b.sessionTape.filter((e) => e.kind === 'base')).toHaveLength(3)
  })
})

describe('readBasesMinReads', () => {
  it('anchors a read-only file only once it has been read in that many turns', () => {
    const c = createContinuity()
    trackRead(c, 'blob.txt', 'big blob\n'); trackRead(c, 'core.py', 'def f(): pass\n')
    seal(c, 1, 'r', { readBasesMinReads: 2 })
    expect(c.sessionTape.filter((e) => e.kind === 'base')).toHaveLength(0)     // 首次读:不锚
    trackRead(c, 'core.py', 'def f(): pass\n')
    seal(c, 2, 'r', { readBasesMinReads: 2 })
    const bases = c.sessionTape.filter((e) => e.kind === 'base')
    expect(bases).toHaveLength(1)                                              // 第二轮再读:锚
    expect(bases[0]!.rendered).toContain('[base core.py')
    // 同轮既读又改的文件不受阈值影响(走编辑路径)
    trackRead(c, 'new.py', 'x\n'); trackEdit(c, 'new.py', 'y\n')
    seal(c, 3, 'r', { readBasesMinReads: 2 })
    expect(c.tapeFiles['new.py']!.content).toBe('y\n')
    // 默认阈值 1:读一次就锚
    const d = createContinuity(); trackRead(d, 'blob.txt', 'big blob\n'); seal(d, 1, 'r')
    expect(d.sessionTape.filter((e) => e.kind === 'base')).toHaveLength(1)
  })
})

describe('baseMaxChars', () => {
  it("anchor 'base' falls back to the patch/base choice for files whose base exceeds the cap", () => {
    const big = (v: number) => Array.from({ length: 400 }, (_, i) => (i === 7 ? `v = ${v}` : `line ${i} ${'#'.repeat(30)}`)).join('\n') + '\n'
    const c = createContinuity()
    trackEdit(c, 'big.py', big(1)); seal(c, 1, 'r', { anchorMode: 'base', baseMaxChars: 5000 })
    trackEdit(c, 'big.py', big(2)); seal(c, 2, 'r', { anchorMode: 'base', baseMaxChars: 5000 })
    expect(c.sessionTape.filter((e) => e.kind === 'base' || e.kind === 'patch').map((e) => e.kind)).toEqual(['base', 'patch'])
    const d = createContinuity()
    trackEdit(d, 'big.py', big(1)); seal(d, 1, 'r', { anchorMode: 'base' })
    trackEdit(d, 'big.py', big(2)); seal(d, 2, 'r', { anchorMode: 'base' })
    expect(d.sessionTape.filter((e) => e.kind === 'base')).toHaveLength(2)      // 默认 60K 之内:完整基线
  })
})
