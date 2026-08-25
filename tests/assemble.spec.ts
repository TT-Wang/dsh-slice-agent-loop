/**
 * 切片装配的行为测试。取代 44 个 Python parity golden case 里测分区渲染的
 * 那 37 个（另 7 个测 tape.ts，见 tape.spec.ts）。
 *
 * 五条。第一条在保护架构，其余四条防手滑。
 */
import { describe, expect, it } from 'vitest'
import { assembleSlice, type SliceInput } from '../src/slice/assemble.js'
import { baseEntry, digestEntry, type TapeEntry } from '../src/slice/tape.js'

const EMPTY: SliceInput = { request: '', goal: '', tape: [], openFiles: '', lastError: '' }

function tape(): TapeEntry[] {
  return [
    digestEntry('[turn slice-turn-1 · task t · completed]\nask: 做点事\n', 'slice-turn-1'),
    baseEntry('a.py', 'print(1)\n'),
  ]
}

describe('assembleSlice', () => {
  // ── 1 · 缓存不变量。这是唯一一条在保护架构的测试。
  //
  // 命中边界 = system + 上一轮结束时的 tape。tape 一旦不是第一段，它之后
  // 每一轮都会因为前面的内容变化而整体作废——成本模型直接垮掉。
  it('renders the tape first, before every other segment', () => {
    const { user } = assembleSlice(
      { ...EMPTY, request: 'r', goal: 'g', tape: tape(), openFiles: '### a.py', lastError: 'boom' },
      'SYS',
    )
    const positions = [
      user.indexOf('# SESSION TAPE'),
      user.indexOf('# STABLE TASK OBJECTIVE'),
      user.indexOf('# OPEN FILES'),
      user.indexOf('# CURRENT ERROR'),
      user.indexOf('# CURRENT REQUEST'),
      user.indexOf('# NOW'),
    ]
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(positions[0]).toBe(user.indexOf('<context>') + '<context>\n'.length)
  })

  // ── 2 · 空输入不产生空壳。
  //
  // 没有任何段有内容时 <context> 整个不渲染，但 NOW 必须还在——它和
  // CURRENT REQUEST 是固定槽，不是段，不允许因为"渲染为空"而消失。
  it('drops the whole context fence when no segment has content, keeping NOW', () => {
    const { system, user } = assembleSlice(EMPTY, 'SYS')
    expect(system).toBe('SYS')
    expect(user).not.toContain('<context>')
    expect(user.startsWith('# NOW:')).toBe(true)
  })

  // ── 3 · 目标 == 本轮请求时不重复渲染。
  //
  // 追问的第一轮里 goal 就是 request，两处都发等于同一句话说两遍。
  it('suppresses the objective when it equals the current request', () => {
    const same = assembleSlice({ ...EMPTY, request: '  修 bug  ', goal: '修 bug' }, 'SYS')
    expect(same.user).not.toContain('# STABLE TASK OBJECTIVE')

    const differs = assembleSlice({ ...EMPTY, request: '继续', goal: '修 bug' }, 'SYS')
    expect(differs.user).toContain('keep it active across follow-ups)\n修 bug')
  })

  // ── 4 · 每段的空/非空边界。空串、纯空白都算空；段消失而不是发一个空标题。
  it('renders each segment only when its input is non-blank', () => {
    const blank = assembleSlice({ ...EMPTY, request: 'r', openFiles: '', lastError: '   ' }, 'SYS')
    expect(blank.user).not.toContain('# OPEN FILES')
    expect(blank.user).not.toContain('# CURRENT ERROR')
    expect(blank.user).not.toContain('# SESSION TAPE')

    const filled = assembleSlice(
      { ...EMPTY, request: 'r', openFiles: '### a.py — 1 lines', lastError: 'E' },
      'SYS',
    )
    expect(filled.user).toContain('# OPEN FILES')
    expect(filled.user).toContain('# CURRENT ERROR (unresolved — fix this, verbatim)\nE')
  })

  // ── 5 · 完整输出快照。防无意改动：header 文字和拼接空白都在这一份里。
  it('matches the exact assembled bytes', () => {
    const { user } = assembleSlice(
      { request: '继续', goal: '修 bug', tape: tape(), openFiles: '### a.py — 1 lines', lastError: 'E' },
      'SYS',
      'hint',
    )
    expect(user).toMatchSnapshot()
  })
})
