/**
 * Working-set retention (history.workingSet, src/working-set.ts) on a bare Session.
 *
 * What it must keep raw: the step with the latest full view of a file the model
 * changed in the sealed turn or the K turns before it, plus that turn's later
 * changes to the file. What it must still seal: files that were only read, older
 * views the same turn superseded, every other step, and anything over the per-turn
 * cap. What it must never do: rewrite a node a request already carried, thaw a
 * sealed node, or seal a kept node later.
 */
import { describe, expect, it } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId, type Message } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage, isReplacementSurfaceEvent, Session, SessionId, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import './v4-fixtures.js'
import { HISTORY_SOURCE, planSeal, sealCompletedTurns, TAPE_PREFIX, type HistoryPolicy } from '../src/context.js'
import { renderSealedTurn } from '../src/recall.js'
import { DEFAULT_WORKING_SET, keepWorkingSet, workingSetNote } from '../src/working-set.js'
import { editText, readText, writeText } from './fs-fixtures.js'

const WS: HistoryPolicy = { keepRecentTurns: 0, workingSet: { ...DEFAULT_WORKING_SET } }
const ROOT = '/work/project'
const at = (name: string): string => `${ROOT}/${name}`

interface Call { name: string; args: object; result: string; isError?: boolean }
/** A window (`offset`) shows lines from there on of a longer file, as the host renders it. */
const read = (name: string, lines: readonly string[], window: { offset?: number; limit?: number } = {}): Call => ({
  name: 'read', args: { file_path: at(name), ...window },
  result: readText(at(name), lines, window.offset ?? 1, window.offset === undefined ? undefined : window.offset + lines.length + 10),
})
const edit = (name: string, isError = false): Call => ({ name: 'edit', args: { file_path: at(name), old_string: 'a', new_string: 'b' }, result: isError ? 'Error: FS_STALE_VERSION' : editText(at(name)), isError })
const write = (name: string, content: string): Call => ({ name: 'write', args: { file_path: at(name), content }, result: writeText(at(name)) })
const bash = (command: string, output = 'ok'): Call => ({ name: 'bash', args: { command }, result: output })
const lines = (tag: string, count = 20): string[] => Array.from({ length: count }, (_, index) => `${tag}_${index} = ${index}`)

interface Step { head: SessionSeq; results: SessionSeq[]; all: SessionSeq[] }

/** One session written the way the stock loop writes it (V4: one tool-role result event per call). */
class Script {
  turn = 0
  step = 0
  /** Reasoning of the next step only; each step otherwise reasons `REASONING_<turn>_<step>`. */
  reasoning: string | undefined
  constructor(readonly session: Session) {}
  start(turn: number): void {
    this.turn = turn
    this.step = 0
    this.session.append('turn/start', { turn })
    this.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `REQUEST_${turn}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  }
  private assistant(content: Message['content']): SessionEvent {
    return this.session.append('assistant/message', {
      turn: this.turn, step: this.step, stream: [],
      message: createMessage({ role: 'assistant', content, source: { kind: 'model', provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' })
  }
  call(...calls: Call[]): Step {
    this.step += 1
    const ids = calls.map((_, index) => ToolCallId(`t${this.turn}-s${this.step}-c${index}`))
    const reasoning = this.reasoning
    this.reasoning = undefined
    const head = this.assistant([
      { type: 'reasoning', text: reasoning ?? `REASONING_${this.turn}_${this.step}` },
      ...calls.map((call, index) => ({ type: 'tool-call' as const, id: ids[index]!, name: call.name, arguments: JSON.stringify(call.args) })),
    ])
    calls.forEach((call, index) => this.session.append('tool/call', { turn: this.turn, step: this.step, callId: ids[index]!, name: call.name, arguments: JSON.stringify(call.args) }))
    const results = calls.map((call, index) => this.session.append('tool/result', {
      turn: this.turn, step: this.step,
      message: createToolResultMessage({ callId: ids[index]!, isError: call.isError ?? false, content: [{ type: 'text', text: call.result }] }),
    }, { surfaceOp: 'append' }).seq)
    return { head: head.seq, results, all: [head.seq, ...results] }
  }
  end(text: string | null = `DONE_${this.turn}`, reason: 'completed' | 'blocked' = 'completed'): void {
    if (text !== null) { this.step += 1; this.assistant([{ type: 'text', text }]) }
    this.session.append('turn/end', { turn: this.turn, reason: { kind: reason } })
  }
}

function script(id: string): Script { return new Script(Session.create(SessionId(id))) }
/** Another producer's in-place view of a result (the fold, the host's pruner). */
function replaceResult(session: Session, seq: SessionSeq, text: string): SessionEvent {
  const original = session.eventAt(seq) as SessionEvent<'tool/result'>
  return session.append('tool/result', { ...original.data, message: { ...original.data.message, content: [{ type: 'text', text }] } }, {
    surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
  })
}
const textOf = (message: Message | null): string => (message?.content ?? []).map(block => block.type === 'text' ? block.text : '').join('')
const sealed = (session: Session): SessionEvent<'user/message'>[] => session.snapshotEvents().filter((event): event is SessionEvent<'user/message'> =>
  event.type === 'user/message' && event.data.source.kind === HISTORY_SOURCE)
const entryTexts = (session: Session): string[] => session.surface.nodes.flatMap(seq => {
  const event = session.eventAt(seq)!
  return event.type === 'user/message' && event.data.source.kind === HISTORY_SOURCE ? [textOf(event.data)] : []
})
const sources = (session: Session): Set<SessionSeq> => new Set(sealed(session).flatMap(event => event.sourceEventSeqs ?? []))
const raw = (session: Session, step: Step): boolean => step.all.every(seq => session.surface.nodes.includes(seq))
const swallowed = (session: Session, step: Step): boolean => step.all.every(seq => !session.surface.nodes.includes(seq) && sources(session).has(seq))
function firstDivergence(a: readonly Message[], b: readonly Message[]): number {
  let i = 0
  while (i < a.length && i < b.length && JSON.stringify(a[i]) === JSON.stringify(b[i])) i += 1
  return i
}
function expectPaired(session: Session): void {
  const messages = session.deriveMessages()
  const calls = messages.flatMap(message => message.content.flatMap(block => block.type === 'tool-call' ? [block.id] : [])).sort()
  expect(messages.flatMap(message => message.role === 'tool' ? [message.toolCallId] : []).sort()).toEqual(calls)
}

describe('working-set retention when a turn seals', () => {
  it('keeps the latest full read and the later edits of a file the turn changed, and seals every other step', () => {
    const s = script('ws-basic')
    s.start(1)
    const view = s.call(read('calc.py', lines('CALC')))
    const reference = s.call(read('README.md', lines('README')))
    const change = s.call(edit('calc.py'))
    const test = s.call(bash('python3 -m unittest -v 2>&1 | tail -5', 'TESTS_PASSED'))
    s.end()
    s.start(2)
    const plan = sealCompletedTurns(s.session, [], WS)

    expect(raw(s.session, view)).toBe(true)
    expect(raw(s.session, change)).toBe(true)
    expect(swallowed(s.session, reference)).toBe(true)
    expect(swallowed(s.session, test)).toBe(true)
    // The kept steps cut the turn: one entry between them, one after them, both for turn 1.
    expect(plan.appends).toHaveLength(2)
    const [between, after] = entryTexts(s.session)
    expect(between).toContain(`${TAPE_PREFIX}1-1`)
    expect(after).toContain(`${TAPE_PREFIX}1-1`)
    // The turn's first entry accounts for the kept steps, once.
    expect(between).toContain('[turn 1]\n[slice note · working set: step(s) 1, 3 of this turn kept raw in place for calc.py]')
    expect(after).not.toContain('working set')
    expect(after).toContain('DONE_1')
    // The sealed steps keep their recall pointers; the kept ones are not cited, they are on the surface.
    expect(between).toContain(`seq ${reference.results[0]} · read`)
    expect(after).toContain(`seq ${test.results[0]} · bash`)
    for (const seq of [...view.all, ...change.all]) expect(sources(s.session).has(seq)).toBe(false)
    const surface = s.session.deriveMessages().map(textOf).join('\n')
    expect(surface).toContain('CALC_19 = 19')
    expect(surface).not.toContain('README_0')
    expect(surface).not.toContain('TESTS_PASSED')
    expectPaired(s.session)
  })

  it('seals a file the window never changed, and a changed file once it leaves the window', () => {
    const s = script('ws-window')
    s.start(1)
    s.call(read('calc.py', lines('V1')))
    s.call(edit('calc.py'))
    s.end()
    const views: Step[] = []
    for (let turn = 2; turn <= 4; turn += 1) {
      s.start(turn)
      sealCompletedTurns(s.session, [], WS)
      views.push(s.call(read('calc.py', lines(`T${turn}`))))
      s.call(read('notes.md', lines(`NOTES${turn}`)))
      s.end()
    }
    s.start(5)
    sealCompletedTurns(s.session, [], WS)
    // K = 2: calc.py changed in turn 1 stays in the working set through turn 3, not turn 4.
    expect(raw(s.session, views[0]!)).toBe(true)
    expect(raw(s.session, views[1]!)).toBe(true)
    expect(swallowed(s.session, views[2]!)).toBe(true)
    const surface = s.session.deriveMessages().map(textOf).join('\n')
    expect(surface).not.toContain('NOTES')
    expect(entryTexts(s.session).filter(text => text.includes('working set')).map(text => /turns (\d+)/.exec(text)![1])).toEqual(['1', '2', '3'])

    // Without the key nothing changes: every completed step seals.
    const off = script('ws-off')
    off.start(1)
    const offView = off.call(read('calc.py', lines('V1')))
    off.call(edit('calc.py'))
    off.end()
    off.start(2)
    sealCompletedTurns(off.session, [], { keepRecentTurns: 0 })
    expect(swallowed(off.session, offView)).toBe(true)
    expect(entryTexts(off.session).join('\n')).not.toContain('working set')
  })

  it('keeps only the latest of several full reads of a file, with the changes after it', () => {
    const s = script('ws-superseded')
    s.start(1)
    const first = s.call(read('calc.py', lines('OLD')))
    const early = s.call(edit('calc.py'))
    const latest = s.call(read('calc.py', lines('NEW')))
    const late = s.call(edit('calc.py'))
    const partial = s.call(read('calc.py', lines('WINDOW', 5), { offset: 3, limit: 5 }))
    s.end()
    s.start(2)
    sealCompletedTurns(s.session, [], WS)
    expect(swallowed(s.session, first)).toBe(true)
    expect(swallowed(s.session, early)).toBe(true)
    expect(raw(s.session, latest)).toBe(true)
    expect(raw(s.session, late)).toBe(true)
    // A window read is not a full view and changes nothing: sealed as before.
    expect(swallowed(s.session, partial)).toBe(true)
    expect(entryTexts(s.session).join('\n')).toContain('step(s) 3, 4 of this turn kept raw in place for calc.py')
  })

  it('treats a write as the full view and supersedes the read before it', () => {
    const s = script('ws-write')
    s.start(1)
    const before = s.call(read('calc.py', lines('STUB', 3)))
    const rewrite = s.call(write('calc.py', 'WRITTEN_CONTENT'))
    const created = s.call(write('scratch.py', 'SCRATCH'))
    s.end()
    s.start(2)
    sealCompletedTurns(s.session, [], WS)
    expect(swallowed(s.session, before)).toBe(true)
    expect(raw(s.session, rewrite)).toBe(true)
    expect(raw(s.session, created)).toBe(true)
    expect(entryTexts(s.session).join('\n')).toContain('step(s) 2, 3 of this turn kept raw in place for scratch.py, calc.py')
  })

  it('holds the per-turn cap and keeps a file all or nothing, the file worked on longest first', () => {
    const big = (tag: string) => lines(tag, 700) // about 13.5K characters per read
    const s = script('ws-cap')
    s.start(1)
    s.call(read('calc.py', lines('C0')))
    s.call(edit('calc.py'))
    s.end()
    s.start(2)
    sealCompletedTurns(s.session, [], WS)
    const calcView = s.call(read('calc.py', big('CALC')))
    const calcEdit = s.call(edit('calc.py'))
    const otherView = s.call(read('other.py', big('OTHER')))
    const otherEdit = s.call(edit('other.py'))
    const thirdView = s.call(read('third.py', big('THIRD')))
    const thirdEdit = s.call(edit('third.py'))
    s.end()
    s.start(3)
    const policy: HistoryPolicy = { keepRecentTurns: 0, workingSet: { turns: 2, maxChars: 40_000 } }
    sealCompletedTurns(s.session, [], policy)
    // calc.py changed in two turns of the window: first. Of the one-turn files the most recent fits next; the third does not.
    expect(raw(s.session, calcView) && raw(s.session, calcEdit)).toBe(true)
    expect(raw(s.session, thirdView) && raw(s.session, thirdEdit)).toBe(true)
    expect(swallowed(s.session, otherView) && swallowed(s.session, otherEdit)).toBe(true)
    const kept = s.session.surface.nodes.flatMap(seq => {
      const event = s.session.eventAt(seq)!
      return (event.type === 'assistant/message' || event.type === 'tool/result') && event.data.turn === 2 ? [seq] : []
    })
    const size = kept.reduce((sum, seq) => {
      const content = (s.session.eventAt(seq)!.data as { message: Message }).message.content
      return sum + content.reduce((n, block) => n + (block.type === 'text' || block.type === 'reasoning' ? block.text.length : block.type === 'tool-call' ? block.arguments.length : 0), 0)
    }, 0)
    expect(size).toBeLessThanOrEqual(40_000)
    expect(size).toBeGreaterThan(25_000)

    // A cap below any chain keeps nothing at all.
    const tight = script('ws-cap-tight')
    tight.start(1)
    const tightView = tight.call(read('calc.py', big('CALC')))
    tight.call(edit('calc.py'))
    tight.end()
    tight.start(2)
    sealCompletedTurns(tight.session, [], { keepRecentTurns: 0, workingSet: { turns: 2, maxChars: 1_000 } })
    expect(swallowed(tight.session, tightView)).toBe(true)
  })

  it('extends a raw view across turns while it is intact, and stops once a change was sealed', () => {
    const s = script('ws-carry')
    const policy: HistoryPolicy = { keepRecentTurns: 0, workingSet: { turns: 2, maxChars: 20_000 } }
    s.start(1)
    const view = s.call(read('calc.py', lines('CALC')))
    s.call(edit('calc.py'))
    s.end()
    s.start(2)
    sealCompletedTurns(s.session, [], policy)
    // A long-running agent still holds the observation: it edits without reading again.
    const carried = s.call(edit('calc.py'))
    s.end()
    s.start(3)
    sealCompletedTurns(s.session, [], policy)
    expect(raw(s.session, view)).toBe(true)
    expect(raw(s.session, carried)).toBe(true)
    // An oversized change cannot be kept, so the raw view is stale from here on ...
    const oversized = s.call({ ...edit('calc.py'), args: { file_path: at('calc.py'), old_string: 'a', new_string: 'x'.repeat(30_000) } })
    s.end()
    s.start(4)
    sealCompletedTurns(s.session, [], policy)
    expect(swallowed(s.session, oversized)).toBe(true)
    // ... and a later change without a fresh view is sealed instead of extending it.
    const orphan = s.call(edit('calc.py'))
    s.end()
    s.start(5)
    sealCompletedTurns(s.session, [], policy)
    expect(swallowed(s.session, orphan)).toBe(true)
    // A fresh full view starts a new raw view.
    const fresh = s.call(read('calc.py', lines('FRESH')))
    s.end()
    s.start(6)
    sealCompletedTurns(s.session, [], policy)
    expect(raw(s.session, fresh)).toBe(true)
  })

  it('counts recognised shell writes as changes, including an interpreter here-document', () => {
    const s = script('ws-shell')
    s.start(1)
    const view = s.call(read('calc.py', lines('CALC')))
    const pythonEdit = s.call(bash([
      "cd \"$PWD\" && python3 - <<'PY'",
      'from pathlib import Path',
      "p = Path('calc.py')",
      "p.write_text(p.read_text().replace('a', 'b'))",
      'PY',
    ].join('\n')))
    const notes = s.call(read('notes.md', lines('NOTES')))
    const redirect = s.call(bash('echo extra >> notes.md'))
    const unrelated = s.call(bash('cat > /tmp/probe.py <<EOF\nprint(1)\nEOF'))
    const testRun = s.call(bash("python3 - <<'PY'\nimport calc\nprint(calc.evaluate('1 > 0'))\nPY"))
    s.end()
    s.start(2)
    sealCompletedTurns(s.session, [], WS)
    for (const step of [view, pythonEdit, notes, redirect]) expect(raw(s.session, step)).toBe(true)
    expect(swallowed(s.session, unrelated)).toBe(true)
    expect(swallowed(s.session, testRun)).toBe(true)
    expect(entryTexts(s.session).join('\n')).toContain('kept raw in place for notes.md, calc.py')
  })

  it('does not take a failed edit as a change, nor a folded read as a view', () => {
    const s = script('ws-errors')
    s.start(1)
    const onlyRead = s.call(read('a.py', lines('A')))
    const refused = s.call(edit('a.py', true))
    const folded = s.call(read('b.py', lines('B')))
    // Another producer condensed b.py's result in place: the model never saw the whole file.
    const view = replaceResult(s.session, folded.results[0]!, 'FOLDED_VIEW')
    const changeB = s.call(edit('b.py'))
    s.end()
    s.start(2)
    sealCompletedTurns(s.session, [], WS)
    expect(swallowed(s.session, onlyRead)).toBe(true)
    expect(swallowed(s.session, refused)).toBe(true)
    // No visible full view of b.py, so its change has no base to extend: both seal.
    expect(s.session.surface.nodes).not.toContain(view.seq)
    expect(swallowed(s.session, changeB)).toBe(true)
    expect(entryTexts(s.session).join('\n')).not.toContain('working set')
  })

  it('keeps a whole step: sibling results stay raw and paired with their calls', () => {
    const s = script('ws-siblings')
    s.start(1)
    const both = s.call(read('calc.py', lines('CALC')), read('README.md', lines('README')))
    s.call(edit('calc.py'))
    s.end()
    s.start(2)
    sealCompletedTurns(s.session, [], WS)
    expect(raw(s.session, both)).toBe(true)
    expect(s.session.deriveMessages().map(textOf).join('\n')).toContain('README_0')
    expectPaired(s.session)
  })

  it('does not keep a step whose other results outweigh its working-set content', () => {
    const s = script('ws-sibling-weight')
    s.start(1)
    // The flood-session shape: a large log and the small notes file read together, then the notes edited.
    const flood = s.call(read('data/blob_03.log', lines('LOG_LINE_WITH_PAYLOAD', 400)), read('digest.md', lines('DIGEST', 3)))
    const noteEdit = s.call(edit('digest.md'))
    // A source file read beside a short README stays within the allowance.
    const source = s.call(read('calc.py', lines('CALC', 300)), read('README.md', lines('README', 40)))
    const sourceEdit = s.call(edit('calc.py'))
    s.end()
    s.start(2)
    sealCompletedTurns(s.session, [], WS)
    expect(swallowed(s.session, flood)).toBe(true)
    expect(swallowed(s.session, noteEdit)).toBe(true)
    expect(raw(s.session, source)).toBe(true)
    expect(raw(s.session, sourceEdit)).toBe(true)
    expect(s.session.deriveMessages().map(textOf).join('\n')).not.toContain('LOG_LINE_WITH_PAYLOAD')
    expect(entryTexts(s.session).join('\n')).toContain('kept raw in place for calc.py]')
  })

  it('never rewrites the carried prefix: seals cover only the new sealed tail, and kept steps stay raw in every later seal', () => {
    const s = script('ws-prefix')
    const kept: Step[] = []
    let previous: Message[] = []
    for (let turn = 1; turn <= 5; turn += 1) {
      s.start(turn)
      const view = s.session.deriveMessages()
      const lastEntry = view.reduce((last, message, index) => message.role === 'user' && message.source.kind === HISTORY_SOURCE ? index : last, -1)
      const before = new Set(sealed(s.session).map(event => event.seq))
      const nodes = [...s.session.surface.nodes]
      const plan = sealCompletedTurns(s.session, [], WS)
      const after = s.session.deriveMessages()
      // Nothing before the last entry the previous request carried changes ...
      expect(firstDivergence(view, after)).toBeGreaterThan(lastEntry)
      // ... and the surface changes first exactly where the first newly sealed node was: a kept step ahead of it is untouched.
      if (plan.appends.length) {
        const changedAt = nodes.findIndex((seq, index) => s.session.surface.nodes[index] !== seq)
        expect(changedAt).toBe(Math.min(...plan.appends.flatMap(append => append.sources).map(seq => nodes.indexOf(seq))))
      }
      for (const step of kept) expect(raw(s.session, step)).toBe(true)
      for (const event of sealed(s.session)) {
        if (before.has(event.seq)) continue
        for (const step of kept) for (const seq of step.all) expect(event.sourceEventSeqs).not.toContain(seq)
      }
      // Repeating the seal changes nothing.
      expect(planSeal(s.session, [], WS).appends).toEqual([])
      previous = after
      kept.push(s.call(read('calc.py', lines(`T${turn}`))))
      s.call(bash('python3 -m unittest'))
      kept.push(s.call(edit('calc.py')))
      if (turn === 3) s.end(null, 'blocked') // A step cap ended the turn right after the edit: no entry follows it.
      else s.end()
    }
    expect(previous.length).toBeGreaterThan(0)
    for (const step of kept.slice(0, -2)) expect(raw(s.session, step)).toBe(true)
    // The blocked turn's kept edit sits after the last entry of its turn, and later seals still leave it raw.
    s.start(6)
    sealCompletedTurns(s.session, [], WS)
    for (const step of kept) expect(raw(s.session, step)).toBe(true)
    const replacements = s.session.snapshotEvents().filter(isReplacementSurfaceEvent)
    for (const step of kept) for (const seq of step.all) for (const event of replacements) expect(event.sourceEventSeqs ?? []).not.toContain(seq)
    expectPaired(s.session)
  })

  it('serves kept and sealed results alike from recall, and a restored session decides the same', () => {
    const s = script('ws-recall')
    s.start(1)
    const view = s.call(read('calc.py', lines('KEPT_BODY')))
    const reference = s.call(read('README.md', lines('SEALED_BODY')))
    s.call(edit('calc.py'))
    s.end()
    s.start(2)
    sealCompletedTurns(s.session, [], WS)
    const page = renderSealedTurn(s.session.snapshotEvents(), 1, { view: 'full' })!.rendered
    expect(page).toContain('KEPT_BODY_19')
    expect(page).toContain('SEALED_BODY_19')
    expect(raw(s.session, view)).toBe(true)
    expect(swallowed(s.session, reference)).toBe(true)

    s.call(read('calc.py', lines('SECOND')))
    s.call(edit('calc.py'))
    s.end()
    const restored = Session.create(SessionId('ws-recall-restored'), s.session.snapshotEvents())
    expect(restored.deriveMessages()).toEqual(s.session.deriveMessages())
    restored.append('turn/start', { turn: 3 })
    s.session.append('turn/start', { turn: 3 })
    const fromLog = planSeal(restored, [], WS)
    const live = planSeal(s.session, [], WS)
    expect(fromLog.appends.map(append => [append.start, append.end, append.sources])).toEqual(live.appends.map(append => [append.start, append.end, append.sources]))
    expect(fromLog.appends.map(append => textOf(append.message))).toEqual(live.appends.map(append => textOf(append.message)))
  })

  it('keeps its decision when another producer replaces a kept result after the turn ended', () => {
    // The step-capped shape: the turn's last step read the notes again and no request followed it, so the fold
    // condenses that result at the next turn's first step, right after the seal kept the step raw.
    const notes = lines('NOTE', 400) // non-code prose the fold condenses
    const s = script('ws-after-end')
    s.start(1)
    const first = s.call(read('notes.md', notes))
    s.call(edit('notes.md'))
    const last = s.call(read('notes.md', notes), read('README.md', lines('README', 250)))
    s.end(null, 'blocked')
    s.start(2)
    sealCompletedTurns(s.session, [], WS)
    expect(raw(s.session, last)).toBe(true)
    expect(swallowed(s.session, first)).toBe(true)
    // After the seal: the notes result shrinks to a fold view the sibling README now outweighs.
    const folded = replaceResult(s.session, last.results[0]!, 'FOLDED_NOTES')
    const carried = [...s.session.surface.nodes]
    s.call(bash('python3 -m unittest'))
    s.end()
    for (let turn = 3; turn <= 4; turn += 1) {
      s.start(turn)
      expect(planSeal(s.session, [], WS).appends.flatMap(append => append.sources)).not.toContain(folded.seq)
      sealCompletedTurns(s.session, [], WS)
      // Every node the turn-2 requests carried up to the kept step is still in place.
      const through = carried.indexOf(folded.seq)
      expect(s.session.surface.nodes.slice(0, through + 1)).toEqual(carried.slice(0, through + 1))
      s.end()
    }
    // A replacement made before the turn ended still means the model never saw the whole file (in-turn fold).
    const inTurn = script('ws-in-turn')
    inTurn.start(1)
    const seen = inTurn.call(read('notes.md', notes))
    replaceResult(inTurn.session, seen.results[0]!, 'FOLDED_NOTES')
    inTurn.call(edit('notes.md'))
    inTurn.end()
    inTurn.start(2)
    sealCompletedTurns(inTurn.session, [], WS)
    expect(entryTexts(inTurn.session).join('\n')).not.toContain('working set')
  })

  it('does not keep a step that lacks a result on the surface, so calls stay paired', () => {
    const s = script('ws-missing-result')
    s.start(1)
    const view = s.call(read('calc.py', lines('CALC')))
    const change = s.call(edit('calc.py'))
    s.end()
    s.start(2)
    const nodes = s.session.surface.nodes.filter(seq => seq !== view.results[0]).map(seq => {
      const event = s.session.eventAt(seq)!
      return { seq, event, message: deriveEventMessage(event) }
    })
    const kept = keepWorkingSet(s.session, nodes, 2, DEFAULT_WORKING_SET)
    expect(kept.seqs.has(view.head)).toBe(false)
    expect(kept.seqs.has(change.head)).toBe(false)
    expect(kept.notes.size).toBe(0)
    // With the result in place the same chain is kept.
    const whole = s.session.surface.nodes.map(seq => { const event = s.session.eventAt(seq)!; return { seq, event, message: deriveEventMessage(event) } })
    expect([...keepWorkingSet(s.session, whole, 2, DEFAULT_WORKING_SET).seqs].sort((a, b) => a - b)).toEqual([...view.all, ...change.all])
  })

  it('skips a file that does not fit the cap and still keeps a later, smaller one', () => {
    const s = script('ws-cap-skip')
    s.start(1)
    const small = s.call(read('small.py', lines('SMALL')))
    const smallEdit = s.call(edit('small.py'))
    const big = s.call(read('big.py', lines('BIG', 2_000)))
    const bigEdit = s.call(edit('big.py'))
    s.end()
    s.start(2)
    // big.py was touched last, so it is tried first; it does not fit, small.py still does.
    sealCompletedTurns(s.session, [], { keepRecentTurns: 0, workingSet: { turns: 2, maxChars: 10_000 } })
    expect(swallowed(s.session, big) && swallowed(s.session, bigEdit)).toBe(true)
    expect(raw(s.session, small) && raw(s.session, smallEdit)).toBe(true)
    expect(entryTexts(s.session).join('\n')).toContain('kept raw in place for small.py]')
  })

  it('counts a step\'s reasoning toward the cap', () => {
    const s = script('ws-reasoning')
    s.start(1)
    s.reasoning = 'R'.repeat(DEFAULT_WORKING_SET.maxChars)
    const view = s.call(read('calc.py', lines('CALC')))
    s.call(edit('calc.py'))
    s.end()
    s.start(2)
    sealCompletedTurns(s.session, [], WS)
    expect(swallowed(s.session, view)).toBe(true)
    expect(entryTexts(s.session).join('\n')).not.toContain('working set')
  })

  it('bounds the window by the session, however large turns is', () => {
    const s = script('ws-huge-window')
    const policy: HistoryPolicy = { keepRecentTurns: 0, workingSet: { turns: Number.MAX_SAFE_INTEGER, maxChars: 48_000 } }
    s.start(1)
    s.call(read('calc.py', lines('V1')))
    s.call(edit('calc.py'))
    s.end()
    const views: Step[] = []
    for (let turn = 2; turn <= 5; turn += 1) {
      s.start(turn)
      sealCompletedTurns(s.session, [], policy)
      views.push(s.call(read('calc.py', lines(`T${turn}`))))
      s.end()
    }
    s.start(6)
    sealCompletedTurns(s.session, [], policy)
    // The turn-1 change keeps calc.py in the working set for the whole session.
    for (const view of views) expect(raw(s.session, view)).toBe(true)
  })

  it('drops the note from a compact capped entry but keeps the steps raw', () => {
    const s = script('ws-compact')
    s.start(1)
    const view = s.call(read('calc.py', lines('CALC')))
    s.call(edit('calc.py'))
    for (let step = 0; step < 8; step += 1) s.call(bash(`python3 -m unittest # run ${step}`, 'x'.repeat(200)))
    s.end('final '.repeat(400))
    s.start(2)
    sealCompletedTurns(s.session, [], { ...WS, entryMaxChars: 256 })
    expect(raw(s.session, view)).toBe(true)
    for (const text of entryTexts(s.session)) expect([...text].length).toBeLessThanOrEqual(256)
  })

  it('labels the note by the files\' shared directory and bounds it', () => {
    expect(workingSetNote({ steps: [1, 4], files: ['/w/p/src/calc.py', '/w/p/tests/test_calc.py'] }))
      .toBe('[slice note · working set: step(s) 1, 4 of this turn kept raw in place for src/calc.py, tests/test_calc.py]')
    expect(workingSetNote({ steps: [2], files: ['/w/p/calc.py'] })).toContain('in place for calc.py]')
    const many = workingSetNote({ steps: [1], files: Array.from({ length: 9 }, (_, i) => `/w/f${i}.py`) })
    expect(many).toContain('f5.py, +3 more]')
    expect(workingSetNote({ steps: [1], files: [`/${'d'.repeat(300)}/x.py`, '/y.py'] }).length).toBeLessThan(400)
  })
})
