/**
 * tape.ts 的行为测试。
 *
 * 这 7 个 fixture 原本是 44 个 Python parity golden case 里的 tape 部分——
 * 另外 37 个测的是已被 assemble.ts 取代的分区/弹性/placement 机制，随
 * golden 套件一起退役。tape.ts 本身没动，所以它的字节级保护值得留下，
 * 只是基准从「Python 引擎的输出」换成了「TS 自己的快照」。
 *
 * fixture 与原 cases.json 逐字一致，唯一的改动：reply 的长度从写死的 5000
 * 改为从 REPLY_CAP_CHARS 派生——cap 调过一次（1200 → 5000），写死的长度会在
 * 下一次调整时静默绕过截断路径。
 */
import { describe, expect, it } from 'vitest'
import {
  REPLY_CAP_CHARS,
  compactTape,
  composeAfter,
  entryFromOp,
  baseEntry,
  patchEntry,
  tapeRender,
  unifiedPatch,
  type TapeEntry,
} from '../src/slice/tape.js'

describe('tape rendering', () => {
  it('renders every entry kind', () => {
    const entries = [
      { op: 'digest', rendered: '[turn t-1 · task k · completed]\nask: first\n', ref: 't-1' },
      { op: 'base', path: 'dir/a file.py', body: 'x = 1' },
      { op: 'patch', path: 'dir/a file.py', before: 'x = 1', after: 'x = 2' },
      {
        op: 'external',
        path: 'b.py',
        new_hash: '0123456789ab',
        reason: 'changed after your last recorded edit this turn (a command/script modified it)',
      },
      { op: 'reply', artifact_id: 't-1', text: 'y'.repeat(REPLY_CAP_CHARS + 100) },
      { op: 'reasoning', artifact_id: 't-1', text: 'first I checked the file, then I edited it' },
      // 脱敏必须命中：这一行里的 key 不允许原样进 tape。
      { op: 'finding', line: 'config holds sk-1234567890abcdef for staging', task: 'k' },
      { op: 'knowledge', text: '- lesson: rotate keys monthly', task: '' },
    ] as const

    const rendered = tapeRender(
      entries.map((op) => entryFromOp(op as never)).filter((e): e is TapeEntry => e !== null),
    )
    expect(rendered).not.toContain('sk-1234567890abcdef')
    expect(rendered).toContain('chars in sealed turn]')
    expect(rendered).toMatchSnapshot()
  })
})

describe('tape patches', () => {
  it('emits one hunk per changed region', () => {
    expect(
      unifiedPatch(
        'g.py',
        'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\n',
        'alpha\nBETA\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\nIOTA\nkappa\n',
      ),
    ).toMatchSnapshot()
  })

  // >200 行触发 difflib 的 autojunk 启发式；CPython 的 purge 行为在移植里
  // 是逐字复刻的，这条守着它。
  it('survives difflib autojunk on a >200-line file', () => {
    const pad = 'pad\n'.repeat(250)
    expect(unifiedPatch('big.py', `start\n${pad}end\n`, `start\n${pad}END!\n`)).toMatchSnapshot()
  })
})

describe('tape composition', () => {
  it('composes base + patch back to the exact post-state without a trailing newline', () => {
    const base = baseEntry('f.py', 'x = 1')
    const patch = patchEntry('f.py', 'x = 1', 'x = 2')
    expect(composeAfter(patch, 'x = 1')).toBe('x = 2')
    expect([base.rendered, patch.rendered]).toMatchSnapshot()
  })
})

describe('tape compaction', () => {
  function run(budget: number, files: Record<string, string>, ops: readonly unknown[]) {
    const tape = ops.map((op) => entryFromOp(op as never)).filter((e): e is TapeEntry => e !== null)
    const state: Record<string, { hash: string; content: string }> = {}
    for (const [path, content] of Object.entries(files)) state[path] = { hash: '', content }
    const info = compactTape(tape, state, { budget })
    return { info, rendered: tapeRender(tape) }
  }

  const digest = (id: string, pad: number) => ({
    op: 'digest',
    rendered: `[turn ${id} · task k · completed]\nask: ${'x'.repeat(pad)}\n`,
    ref: id,
  })

  it('folds a span into an epoch marker and re-anchors affected files', () => {
    const body = `${'A'.repeat(300)}\n`
    const out = run(2000, { 'f.py': `${'A'.repeat(300)}\nB\n` }, [
      digest('t-1', 800),
      digest('t-2', 800),
      digest('t-3', 800),
      digest('t-4', 800),
      { op: 'base', path: 'f.py', body },
      { op: 'patch', path: 'f.py', before: body, after: `${'A'.repeat(300)}\nB\n` },
      // 折叠通道要求 tape.length > 8 —— 少于这个数只会走 GC，测不到折叠。
      digest('t-5', 800),
      digest('t-6', 800),
      digest('t-7', 800),
      digest('t-8', 800),
      digest('t-9', 800),
    ])
    expect(out.info.epoch_folds).toBe(1)
    expect(out.rendered).toContain('[epoch compacted:')
    expect(out.rendered).toMatchSnapshot()
  })

  // 路径里带空格：GC 按 path 精确匹配，不能靠空格分词。
  it('GCs superseded file history for paths containing spaces', () => {
    const out = run(5000, { 'dir/a one.py': 'ONE v2\n', 'dir/a two.py': 'TWO v1\n' }, [
      { op: 'base', path: 'dir/a one.py', body: 'ONE v1\n' },
      { op: 'base', path: 'dir/a two.py', body: 'TWO v1\n' },
      { op: 'base', path: 'dir/a one.py', body: 'ONE v2\n' },
      digest('t-1', 2000),
      digest('t-2', 2000),
      digest('t-3', 2000),
    ])
    expect(out.info.gc_removed).toBeGreaterThan(0)
    expect(out.rendered).not.toContain('ONE v1')
    expect(out.rendered).toContain('ONE v2')
  })

  it('does nothing under budget', () => {
    const out = run(10_000_000, {}, [digest('t-1', 1), digest('t-2', 1)])
    expect(out.info).toEqual({ gc_removed: 0, epoch_folds: 0 })
    expect(out.rendered).toContain('t-1')
    expect(out.rendered).toContain('t-2')
  })
})
