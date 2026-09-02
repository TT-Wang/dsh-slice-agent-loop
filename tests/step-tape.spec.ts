/** 轮内封存纯函数层:切口精确、渲染确定、触发策略的经济学门槛。 */
import { describe, expect, it } from 'vitest'
import {
  SEAL_CHARS_PER_TOKEN,
  STEP_RESULT_HEAD_CHARS,
  STEP_RESULT_TAIL_CHARS,
  cutHeadTail,
  renderSealedStep,
  renderStepTape,
  resolveSealPolicy,
  stepsToSeal,
} from '../src/slice/step-tape.js'

describe('cutHeadTail', () => {
  it('keeps short text verbatim and cuts long text with an exact marker', () => {
    expect(cutHeadTail('short', 10, 5, 'step')).toBe('short')
    const long = 'a'.repeat(1000)
    const cut = cutHeadTail(long, 100, 50, 'step')
    expect(cut.startsWith('a'.repeat(100))).toBe(true)
    expect(cut.endsWith('a'.repeat(50))).toBe(true)
    expect(cut).toContain('…[+850 chars in sealed step]…')
  })
  it('counts code points, not UTF-16 units', () => {
    const cjk = '汉'.repeat(30)
    expect(cutHeadTail(cjk, 10, 5, 'step')).toContain('…[+15 chars in sealed step]…')
  })
})

describe('renderSealedStep', () => {
  it('renders call, cut result, error flag and interjection; byte-stable for equal input', () => {
    const input = {
      step: 7,
      assistantText: 'reading the manifest',
      calls: [
        { name: 'read', arguments: '{"file_path":"a.py"}', resultText: 'x'.repeat(2000), isError: false },
        { name: 'edit', arguments: '{"file_path":"b.py"}', resultText: 'no match', isError: true },
      ],
      interjections: ['stop, use the other file'],
    }
    const a = renderSealedStep(3, input)
    const b = renderSealedStep(3, input)
    expect(a).toBe(b)
    expect(a.startsWith('[step 7 · recall_step(3, 7) returns full results]')).toBe(true)
    expect(a).toContain('→ read({"file_path":"a.py"})')
    expect(a).toContain(`…[+${2000 - STEP_RESULT_HEAD_CHARS - STEP_RESULT_TAIL_CHARS} chars in sealed step]…`)
    expect(a).toContain('→ edit({"file_path":"b.py"}) !error')
    expect(a).toContain('user: stop, use the other file')
  })
  it('step tape is header + append-only concatenation', () => {
    const e1 = renderSealedStep(1, { step: 1, assistantText: '', calls: [], interjections: [] })
    const e2 = renderSealedStep(1, { step: 2, assistantText: '', calls: [], interjections: [] })
    const one = renderStepTape([e1])
    const two = renderStepTape([e1, e2])
    expect(two.startsWith(one)).toBe(true)
  })
})

describe('stepsToSeal', () => {
  const policy = resolveSealPolicy({ enabled: true, sealTokens: 1_000, batchSteps: 4, keepSteps: 2 })
  const over = 1_000 * SEAL_CHARS_PER_TOKEN + 1
  it('does nothing when disabled or below the token floor', () => {
    expect(stepsToSeal({ ...policy, enabled: false }, over, 20)).toBe(0)
    expect(stepsToSeal(policy, over - 2, 20)).toBe(0)
  })
  it('waits until batch + keep unsealed steps exist, then seals one batch keeping the tail', () => {
    expect(stepsToSeal(policy, over, 5)).toBe(0)
    expect(stepsToSeal(policy, over, 6)).toBe(4)
    expect(stepsToSeal(policy, over, 7)).toBe(4)
  })
  it('validates policy numbers', () => {
    expect(() => resolveSealPolicy({ batchSteps: 0 })).toThrow()
  })
})
