/**
 * 读过未改的文件轮末锚定为 base(2026-09-03):多轮编码任务里 slice 每轮重读 2–3 个文件,
 * 这些字节在磁带上按命中价白带着,比重读便宜。契约:只读文件进 base;同 hash 不重复;
 * 同轮既读又改的文件只锚定一次(走编辑路径);读到的内容经 codeFile 脱敏。
 */
import { describe, expect, it } from 'vitest'
import { createContinuity, sealTurn, trackEdit, trackRead } from '../src/continuity.js'

const seal = (c: ReturnType<typeof createContinuity>, turn: number) => sealTurn(c, { turnId: `slice-turn-${turn}`, status: 'completed', userRequest: 'u', assistantReply: 'a', sessionId: 's' })

describe('read bases', () => {
  it('anchors read-only files as [base], dedups by hash, and lets a later edit ride as patch', () => {
    const c = createContinuity()
    trackRead(c, 'lib/core.py', 'def f():\n    return 1\n')
    trackRead(c, 'lib/core.py', 'def f():\n    return 1\n')     // 同轮重复读:只留一份
    seal(c, 1)
    const bases = c.sessionTape.filter((e) => e.kind === 'base')
    expect(bases).toHaveLength(1)
    expect(bases[0]!.rendered).toContain('[base lib/core.py @sha256:')
    expect(Object.keys(c.tapeFiles)).toEqual(['lib/core.py'])
    // 下一轮再读同一内容:hash 相同,不加条目
    trackRead(c, 'lib/core.py', 'def f():\n    return 1\n')
    seal(c, 2)
    expect(c.sessionTape.filter((e) => e.kind === 'base')).toHaveLength(1)
    // 第三轮编辑:相对已有 base 走 patch/base 择短
    trackEdit(c, 'lib/core.py', 'def f():\n    return 2\n')
    const before = c.sessionTape.length
    seal(c, 3)
    const added = c.sessionTape.slice(before).filter((e) => e.kind === 'base' || e.kind === 'patch')
    expect(added).toHaveLength(1)
    expect(c.tapeFiles['lib/core.py']!.content).toContain('return 2')
  })

  it('a file both read and edited in one turn is anchored once, from the edit', () => {
    const c = createContinuity()
    trackRead(c, 'a.txt', 'v1\n')
    trackEdit(c, 'a.txt', 'v2\n')
    const r = seal(c, 1)
    expect(r.anchored).toHaveLength(1)
    expect(c.tapeFiles['a.txt']!.content).toBe('v2\n')
    expect(c.pendingReads).toHaveLength(0)
  })
})
