import { describe, expect, it } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import { archiveUnderPressure, HISTORY_SOURCE, planArchive, RUNTIME_CONTEXT_SOURCE, SliceBudgetError, type HistoryPolicy } from '../src/context.js'
import { renderSealedTurn, searchSessionEvents } from '../src/recall.js'

function user(session: Session, text: string, plugin?: string) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: plugin ? { kind: 'plugin', plugin } : { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function assistant(session: Session, turn: number, content: ContentBlock[]) {
  return session.append('assistant/message', {
    turn, step: 1, stream: [],
    message: createMessage({ role: 'assistant', content, source: { kind: 'model', provider: 'mock', model: 'mock' } }),
  }, { surfaceOp: 'append' })
}

function completedTurn(session: Session, turn: number, question: string, answer: string) {
  session.append('turn/start', { turn })
  const request = user(session, question)
  const response = assistant(session, turn, [{ type: 'text', text: answer }])
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return { request, response }
}

function toolTurn(session: Session, turn: number, rawId: string, text: string, protectedText?: string) {
  const id = ToolCallId(rawId)
  session.append('turn/start', { turn })
  user(session, `read a file ${turn}`)
  assistant(session, turn, [{ type: 'tool-call', id, name: 'read', arguments: '{}' }])
  session.append('tool/call', { turn, step: 1, callId: id, name: 'read', arguments: '{}' })
  if (protectedText !== undefined) user(session, protectedText, 'runtime-fixture')
  const result = session.append('tool/result', { turn, step: 1,
    message: createToolResultMessage({ callId: id, isError: false, content: [{ type: 'text', text }] }),
  }, { surfaceOp: 'append' })
  assistant(session, turn, [{ type: 'text', text: `done ${turn}` }])
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return result
}

function surfaceText(session: Session): string {
  return session.deriveMessages().flatMap(message => message.content.map(block => block.type === 'text' ? block.text : '')).join('\n')
}

function textOfEvent(event: SessionEvent<'user/message'>): string {
  return event.data.content.map(block => block.type === 'text' ? block.text : '').join('')
}

function checkpoints(session: Session): SessionEvent<'user/message'>[] {
  return session.surface.nodes.flatMap(seq => {
    const event = session.eventAt(seq)
    return event?.type === 'user/message' && event.data.source.kind === 'plugin'
      && event.data.source.plugin === HISTORY_SOURCE ? [event] : []
  })
}

/** Water marks low enough that any completed history is under pressure; the recent tail is one turn. */
function forced(over: Partial<HistoryPolicy> = {}): HistoryPolicy {
  return {
    highWaterChars: 100, lowWaterChars: 50, keepRecentChars: 1, pinFirstTurn: true, pinUserChars: 1_200,
    checkpointMaxChars: 8_000, maxRequestChars: 400_000, ...over,
  }
}

describe('pressure-triggered conversational archive', () => {
  it('bounds ten 60,000-character user entries in one checkpoint while retaining exact original recall pages', () => {
    const session = Session.create(SessionId('context-large-history'))
    const original: string[] = []
    for (let turn = 1; turn <= 10; turn += 1) {
      const question = `ORIGINAL_TURN_${turn}_` + 'x'.repeat(60_000)
      original.push(question)
      completedTurn(session, turn, question, `ANSWER_${turn}`)
    }
    const before = structuredClone(session.snapshotEvents())
    const plan = archiveUnderPressure(session, [], forced({ highWaterChars: 120_000, lowWaterChars: 100_000, pinFirstTurn: false }))
    const text = surfaceText(session)
    expect(plan.appends).toHaveLength(1)
    expect(plan.viewChars).toBe(Array.from(JSON.stringify(session.deriveMessages())).length)
    expect(plan.viewChars).toBeLessThanOrEqual(100_000)
    expect(checkpoints(session)).toHaveLength(1)
    expect(text).toContain(`ORIGINAL_TURN_10_${'x'.repeat(60_000)}`)
    expect(text).toMatch(/ORIGINAL_TURN_1_x+…\[\+\d+ chars, recall_turn\]…x+/)
    expect(text).not.toContain(`ORIGINAL_TURN_1_${'x'.repeat(60_000)}`)
    expect(text).toContain('recall_turn({"turn":"<n>","view":"dialogue"})')
    expect(Array.from(text).length).toBeLessThanOrEqual(8_000 + 61_000)
    expect(session.snapshotEvents().slice(0, before.length)).toEqual(before)
    original.forEach((question, index) => expect(renderSealedTurn(session.snapshotEvents(), index + 1)?.rendered).toContain(question))
  })

  it('appends nothing under highWater and archives at most once per pressure event, idempotently', () => {
    const session = Session.create(SessionId('context-repeat-history'))
    for (let turn = 1; turn <= 6; turn += 1) {
      completedTurn(session, turn, `QUESTION_${turn} ${'q'.repeat(300)}`, `ANSWER_${turn} ${'a'.repeat(300)}`)
      const policy = forced({ highWaterChars: 2_500, lowWaterChars: 1_800 })
      const before = session.snapshotEvents().length
      const plan = archiveUnderPressure(session, [], policy)
      expect(session.snapshotEvents().length - before).toBe(plan.appends.length)
      expect(plan.appends.length).toBeLessThanOrEqual(1)
      const snapshot = structuredClone(session.snapshotEvents())
      const surface = [...session.surface.nodes]
      for (let repeat = 0; repeat < 3; repeat += 1) expect(archiveUnderPressure(session, [], policy).appends).toEqual([])
      expect(session.snapshotEvents()).toEqual(snapshot)
      expect(session.surface.nodes).toEqual(surface)
      expect(checkpoints(session).length).toBeLessThanOrEqual(1)
      expect(surfaceText(session).split(`QUESTION_${turn} `)).toHaveLength(2)
      expect(surfaceText(session).split(`ANSWER_${turn} `)).toHaveLength(2)
    }
    expect(session.snapshotEvents().filter(event => event.type === 'user/message' && event.surfaceOp !== 'append').length).toBeGreaterThanOrEqual(1)
    expect(surfaceText(session).split('[slice checkpoint v1')).toHaveLength(2)
  })

  it('keeps the first turn user message raw when pinned and archives it otherwise', () => {
    for (const pinFirstTurn of [true, false]) {
      const session = Session.create(SessionId(`context-pin-${pinFirstTurn}`))
      completedTurn(session, 1, 'FIRST_QUESTION', 'FIRST_ANSWER')
      completedTurn(session, 2, 'SECOND_QUESTION', 'SECOND_ANSWER')
      completedTurn(session, 3, 'THIRD_QUESTION', 'THIRD_ANSWER')
      const first = session.surface.nodes[0]!
      archiveUnderPressure(session, [], forced({ pinFirstTurn }))
      expect(session.surface.nodes.includes(first)).toBe(pinFirstTurn)
      expect(checkpoints(session)).toHaveLength(1)
      const text = surfaceText(session)
      expect(text.split('FIRST_QUESTION')).toHaveLength(2)
      expect(text).toContain('FIRST_ANSWER')
      expect(text).toContain('SECOND_QUESTION')
      expect(text).toContain('THIRD_QUESTION')
    }
  })

  it('preserves a foreign canonical replacement without resurrecting the messages it shadows', () => {
    const session = Session.create(SessionId('context-canonical-replacement'))
    const original = completedTurn(session, 1, 'SHADOWED_QUESTION', 'SHADOWED_RESPONSE')
    const canonical = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'CANONICAL_FOREIGN_CONTEXT' }], source: { kind: 'plugin', plugin: 'foreign-compactor' },
    }), {
      surfaceOp: { op: 'replace', start: original.request.seq, end: original.response.seq },
      sourceEventSeqs: [original.request.seq, original.response.seq],
    })
    completedTurn(session, 2, 'SECOND_QUESTION', 'SECOND_RESPONSE')
    completedTurn(session, 3, 'THIRD_QUESTION', 'THIRD_RESPONSE')
    archiveUnderPressure(session, [], forced())
    expect(session.surface.nodes).toContain(canonical.seq)
    expect(checkpoints(session)).toHaveLength(1)
    expect(checkpoints(session)[0]!.sourceEventSeqs).not.toContain(canonical.seq)
    expect(surfaceText(session)).toContain('CANONICAL_FOREIGN_CONTEXT')
    expect(surfaceText(session)).toContain('SECOND_QUESTION')
    expect(surfaceText(session)).not.toContain('SHADOWED_QUESTION')
    expect(surfaceText(session)).not.toContain('SHADOWED_RESPONSE')
  })

  it('keeps a foreign user-source canonical replacement when its generated text is absent from original recall pages', () => {
    const session = Session.create(SessionId('context-canonical-user-replacement'))
    const original = completedTurn(session, 1, 'ORIGINAL_RAW_QUESTION', 'ORIGINAL_RAW_RESPONSE')
    const text = `CANONICAL_USER_REPLACEMENT_${'c'.repeat(4_000)}`
    const canonical = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }], source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', start: original.request.seq, end: original.response.seq },
      sourceEventSeqs: [original.request.seq, original.response.seq],
    })
    completedTurn(session, 2, 'SECOND_USER_QUESTION', 'SECOND_USER_RESPONSE')
    completedTurn(session, 3, 'THIRD_USER_QUESTION', 'THIRD_USER_RESPONSE')
    expect(renderSealedTurn(session.snapshotEvents(), 1)?.rendered).not.toContain(text)
    archiveUnderPressure(session, [], forced())
    expect(session.surface.nodes).toContain(canonical.seq)
    expect(surfaceText(session)).toContain(text)
    expect(surfaceText(session)).not.toContain('ORIGINAL_RAW_QUESTION')
  })

  it('archives closed calls with their results and points at the original result records', () => {
    const session = Session.create(SessionId('context-closed-tools'))
    const result = toolTurn(session, 1, 'closed-read', 'DURABLE_FILE_BYTES')
    completedTurn(session, 2, 'next question', 'next answer')
    archiveUnderPressure(session, [], forced())
    expect(checkpoints(session)).toHaveLength(1)
    expect(session.deriveMessages().flatMap(message => message.content).some(block => block.type === 'tool-call' || block.type === 'tool-result')).toBe(false)
    const text = surfaceText(session)
    expect(text).toContain(`[tool turn 1 step 1 seq ${result.seq} · read · 18 chars · expand_result({"seq":${result.seq}})]`)
    expect(text).not.toContain('DURABLE_FILE_BYTES')
    expect(renderSealedTurn(session.snapshotEvents(), 1)?.rendered).toContain('DURABLE_FILE_BYTES')
  })

  it('shadows and cites a surface node that derives no message', () => {
    const session = Session.create(SessionId('context-empty-assistant'))
    completedTurn(session, 1, 'FIRST_QUESTION', 'FIRST_ANSWER')
    session.append('turn/start', { turn: 2 })
    user(session, 'SECOND_QUESTION')
    const empty = assistant(session, 2, [])
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    completedTurn(session, 3, 'THIRD_QUESTION', 'THIRD_ANSWER')
    completedTurn(session, 4, 'FOURTH_QUESTION', 'FOURTH_ANSWER')
    expect(session.surface.nodes).toContain(empty.seq)
    const plan = archiveUnderPressure(session, [], forced())
    expect(plan.appends).toHaveLength(1)
    expect(plan.appends[0]!.sources).toContain(empty.seq)
    expect(session.surface.nodes).not.toContain(empty.seq)
    expect(checkpoints(session)[0]!.sourceEventSeqs).toContain(empty.seq)
    expect(surfaceText(session)).toContain('[turn 2]\nSECOND_QUESTION')
    expect(surfaceText(session)).toContain('FOURTH_QUESTION')
  })

  it('cuts a run at a turn with an unclosed tool call instead of suppressing the whole run', () => {
    const session = Session.create(SessionId('context-unclosed-cut'))
    for (let turn = 1; turn <= 4; turn += 1) completedTurn(session, turn, `QUESTION_${turn}`, `ANSWER_${turn}`)
    session.append('turn/start', { turn: 5 })
    const open = user(session, 'QUESTION_5')
    const call = assistant(session, 5, [{ type: 'tool-call', id: ToolCallId('never-closed'), name: 'read', arguments: '{}' }])
    session.append('turn/end', { turn: 5, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    for (let turn = 6; turn <= 8; turn += 1) completedTurn(session, turn, `QUESTION_${turn}`, `ANSWER_${turn}`)
    const warnings: string[] = []
    const plan = archiveUnderPressure(session, [], forced(), message => warnings.push(message))
    expect(plan.appends).toHaveLength(2)
    // A-RT-05: the cut is reported, naming the call; a silent cut looks like an archive that never shrinks.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('turn 5')
    expect(warnings[0]).toContain('never-closed')
    expect(warnings[0]).toContain('cut the archive run')
    expect(checkpoints(session).map(textOfEvent)).toEqual([
      expect.stringContaining('turns 1-4 · 4 turns archived'), expect.stringContaining('turns 6-7 · 2 turns archived'),
    ])
    expect(session.surface.nodes).toContain(open.seq)
    expect(session.surface.nodes).toContain(call.seq)
    expect(session.surface.nodes).toHaveLength(7)
    const blocks = session.deriveMessages().flatMap(message => message.content)
    expect(blocks.filter(block => block.type === 'tool-call')).toHaveLength(1)
    expect(surfaceText(session)).toContain('QUESTION_8')
  })

  it('does not split a tool call from its result across a protected plugin context boundary', () => {
    const session = Session.create(SessionId('context-protected-tool-span'))
    toolTurn(session, 1, 'protected-read', 'UNCHANGED_RESULT', 'PROTECTED_CONTEXT')
    completedTurn(session, 2, 'next question', 'next answer')
    const before = [...session.surface.nodes]
    expect(archiveUnderPressure(session, [], forced()).appends).toEqual([])
    expect(session.surface.nodes).toEqual(before)
    const blocks = session.deriveMessages().flatMap(message => message.content)
    expect(blocks.filter(block => block.type === 'tool-call')).toHaveLength(1)
    expect(blocks.filter(block => block.type === 'tool-result')).toHaveLength(1)
  })

  it('stays silent when every archived turn is call-closed', () => {
    const session = Session.create(SessionId('context-no-spurious-warn'))
    toolTurn(session, 1, 'closed-one', 'RESULT_ONE')
    for (let turn = 2; turn <= 4; turn += 1) completedTurn(session, turn, `QUESTION_${turn}`, `ANSWER_${turn}`)
    const warnings: string[] = []
    expect(archiveUnderPressure(session, [], forced(), message => warnings.push(message)).appends).toHaveLength(1)
    expect(warnings).toEqual([])
  })

  it('archives superseded runtime snapshots into one run and keeps only the live one protected', () => {
    const session = Session.create(SessionId('context-runtime-snapshots'))
    const snapshots: SessionSeq[] = []
    for (let turn = 1; turn <= 8; turn += 1) {
      session.append('turn/start', { turn })
      user(session, `QUESTION_${turn}`)
      snapshots.push(user(session, `RUNTIME_SNAPSHOT_${turn}`, RUNTIME_CONTEXT_SOURCE).seq)
      assistant(session, turn, [{ type: 'text', text: `ANSWER_${turn}` }])
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const live = session.eventAt(snapshots[7]!)
    archiveUnderPressure(session, [], forced())
    const text = surfaceText(session)
    // The live snapshot keeps its node, its source and its position.
    expect(session.surface.nodes).toContain(snapshots[7])
    expect(session.eventAt(snapshots[7]!)).toEqual(live)
    for (const checkpoint of checkpoints(session)) expect(checkpoint.sourceEventSeqs).not.toContain(snapshots[7])
    expect(text.split('RUNTIME_SNAPSHOT_8')).toHaveLength(2)
    for (let stale = 1; stale <= 7; stale += 1) {
      expect(session.surface.nodes).not.toContain(snapshots[stale - 1])
      expect(text).not.toContain(`RUNTIME_SNAPSHOT_${stale}`)
    }
    // Superseded snapshots no longer split runs: one checkpoint covers turns 1-7.
    expect(checkpoints(session)).toHaveLength(1)
    expect(textOfEvent(checkpoints(session)[0]!)).toContain('turns 1-7 · 7 turns archived')
    for (let turn = 1; turn <= 8; turn += 1) expect(text).toContain(`QUESTION_${turn}`)
  })

  it('renders a superseded snapshot as a note with a recall locator, never as a user request line', () => {
    const session = Session.create(SessionId('context-runtime-locator'))
    for (let turn = 1; turn <= 3; turn += 1) {
      session.append('turn/start', { turn })
      user(session, `QUESTION_${turn}`)
      user(session, `RUNTIME_SNAPSHOT_${turn}`, RUNTIME_CONTEXT_SOURCE)
      assistant(session, turn, [{ type: 'text', text: `ANSWER_${turn}` }])
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    archiveUnderPressure(session, [], forced({ pinFirstTurn: false }))
    const text = textOfEvent(checkpoints(session)[0]!)
    expect(text).toContain('[turn 2]\nQUESTION_2\n[slice note · runtime-context snapshot superseded by a later one; not repeated here · verbatim: recall_turn({"turn":"2"})]')
    for (const stale of [1, 2]) {
      expect(text).not.toContain(`RUNTIME_SNAPSHOT_${stale}`)
      expect(text).toContain(`recall_turn({"turn":"${stale}"})`)
      // The omitted text stays reachable on the page the note names.
      expect(renderSealedTurn(session.snapshotEvents(), stale)?.rendered).toContain(`RUNTIME_SNAPSHOT_${stale}`)
    }
  })

  it('treats the surface snapshot as superseded when this step carries a newer projection', () => {
    const session = Session.create(SessionId('context-runtime-pending'))
    const snapshots: SessionSeq[] = []
    for (let turn = 1; turn <= 3; turn += 1) {
      session.append('turn/start', { turn })
      user(session, `QUESTION_${turn}`)
      snapshots.push(user(session, `RUNTIME_SNAPSHOT_${turn}`, RUNTIME_CONTEXT_SOURCE).seq)
      assistant(session, turn, [{ type: 'text', text: `ANSWER_${turn}` }])
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    session.append('turn/start', { turn: 4 })
    const pending = createUserMessage({ content: [{ type: 'text', text: 'RUNTIME_SNAPSHOT_4' }], source: { kind: 'plugin', plugin: RUNTIME_CONTEXT_SOURCE } })
    const plan = archiveUnderPressure(session, [pending], forced())
    // Turn 3 is the raw recent tail, so its dead snapshot is shadowed by a one-line note, not a checkpoint.
    expect(plan.appends).toHaveLength(2)
    for (const seq of snapshots) expect(session.surface.nodes).not.toContain(seq)
    const text = surfaceText(session)
    expect(text).not.toContain('RUNTIME_SNAPSHOT_')
    expect(text).toContain('QUESTION_3\n[slice note · runtime-context snapshot superseded by a later one; not repeated here · verbatim: recall_turn({"turn":"3"})]\nANSWER_3')
  })

  it('archives a snapshot appended between turns behind a locator that recall actually serves', () => {
    const session = Session.create(SessionId('context-unattributable-runtime'))
    completedTurn(session, 1, 'QUESTION_1', 'ANSWER_1')
    const orphan = user(session, 'BETWEEN_TURNS_SNAPSHOT', RUNTIME_CONTEXT_SOURCE)
    completedTurn(session, 2, 'QUESTION_2', 'ANSWER_2')
    completedTurn(session, 3, 'QUESTION_3', 'ANSWER_3')
    const liveSnapshot = user(session, 'LIVE_SNAPSHOT', RUNTIME_CONTEXT_SOURCE)
    archiveUnderPressure(session, [], forced())
    expect(session.surface.nodes).not.toContain(orphan.seq)
    expect(session.surface.nodes).toContain(liveSnapshot.seq)
    expect(checkpoints(session)).toHaveLength(1)
    const text = surfaceText(session)
    expect(text).not.toContain('BETWEEN_TURNS_SNAPSHOT')
    // Generated context between turns belongs to the turn that just ended, in the note and in both recall tools.
    expect(text).toContain('[slice note · runtime-context snapshot superseded by a later one; not repeated here · verbatim: recall_turn({"turn":"1"})]')
    expect(renderSealedTurn(session.snapshotEvents(), 1)?.rendered).toContain('BETWEEN_TURNS_SNAPSHOT')
    expect(renderSealedTurn(session.snapshotEvents(), 1, { view: 'dialogue' })?.rendered).toContain('BETWEEN_TURNS_SNAPSHOT')
    expect(renderSealedTurn(session.snapshotEvents(), 2)?.rendered).not.toContain('BETWEEN_TURNS_SNAPSHOT')
    for (const opts of [{ kinds: ['context'] as const }, { scope: 'auto' as const }, {}]) {
      const hits = searchSessionEvents(session.snapshotEvents(), 'BETWEEN_TURNS_SNAPSHOT', opts)
      expect(hits).toHaveLength(1)
      expect(hits[0]).toMatchObject({ turn: 1, kind: 'context', locator: 'recall_turn({"turn":"1","view":"dialogue"})' })
    }
  })

  it('keeps a snapshot no recall page serves protected instead of omitting it', () => {
    const session = Session.create(SessionId('context-pre-turn-runtime'))
    const early = user(session, 'BEFORE_ANY_TURN_SNAPSHOT', RUNTIME_CONTEXT_SOURCE)
    for (let turn = 1; turn <= 3; turn += 1) completedTurn(session, turn, `QUESTION_${turn}`, `ANSWER_${turn}`)
    user(session, 'LIVE_SNAPSHOT', RUNTIME_CONTEXT_SOURCE)
    archiveUnderPressure(session, [], forced({ pinFirstTurn: false }))
    expect(session.surface.nodes).toContain(early.seq)
    expect(searchSessionEvents(session.snapshotEvents(), 'BEFORE_ANY_TURN_SNAPSHOT', { kinds: ['context'] })).toEqual([])
  })

  it('sheds superseded snapshots of the open turn at a last-resort mid-turn archive', () => {
    const session = Session.create(SessionId('context-open-turn-runtime'))
    for (let turn = 1; turn <= 2; turn += 1) completedTurn(session, turn, `QUESTION_${turn}`, `ANSWER_${turn}`)
    session.append('turn/start', { turn: 3 })
    user(session, 'QUESTION_3')
    const dead: SessionSeq[] = []
    const results: SessionSeq[] = []
    for (let step = 1; step <= 5; step += 1) {
      dead.push(user(session, `STEP_SNAPSHOT_${step} ${'s'.repeat(2_000)}`, RUNTIME_CONTEXT_SOURCE).seq)
      const id = ToolCallId(`c${step}`)
      session.append('assistant/message', { turn: 3, step, stream: [],
        message: createMessage({ role: 'assistant', content: [{ type: 'tool-call', id, name: 'read', arguments: '{}' }], source: { kind: 'model', provider: 'mock', model: 'mock' } }),
      }, { surfaceOp: 'append' })
      session.append('tool/call', { turn: 3, step, callId: id, name: 'read', arguments: '{}' })
      results.push(session.append('tool/result', { turn: 3, step,
        message: createToolResultMessage({ callId: id, isError: false, content: [{ type: 'text', text: `result ${step}` }] }),
      }, { surfaceOp: 'append' }).seq)
    }
    const pending = createUserMessage({ content: [{ type: 'text', text: 'STEP_SNAPSHOT_6' }], source: { kind: 'plugin', plugin: RUNTIME_CONTEXT_SOURCE } })
    const plan = archiveUnderPressure(session, [pending], forced({ highWaterChars: 5_000, lowWaterChars: 2_000, maxRequestChars: 6_000 }))
    expect(plan.viewChars).toBeLessThanOrEqual(6_000)
    for (const seq of dead) expect(session.surface.nodes).not.toContain(seq)
    const text = surfaceText(session)
    expect(text).not.toContain('STEP_SNAPSHOT_')
    expect(text).toContain('recall_turn({"turn":"3"})')
    // The open turn's tool calls and results stay raw and paired on the surface.
    for (const seq of results) expect(session.surface.nodes).toContain(seq)
    expect(renderSealedTurn(session.snapshotEvents(), 3)?.rendered).toContain('STEP_SNAPSHOT_1 ')
  })

  it('archives the recent tail too before refusing on maxRequestChars', () => {
    const session = Session.create(SessionId('context-tail-degradation'))
    for (let turn = 1; turn <= 3; turn += 1) completedTurn(session, turn, `QUESTION_${turn}`, `ANSWER_${turn} ${'a'.repeat(3_000)}`)
    const warnings: string[] = []
    // keepRecentChars holds the last two turns raw (~6K); the bound only fits once they are archived too.
    const plan = archiveUnderPressure(session, [], forced({ keepRecentChars: 5_000, maxRequestChars: 5_000, checkpointMaxChars: 1_500 }), message => warnings.push(message))
    expect(plan.viewChars).toBeLessThanOrEqual(5_000)
    expect(checkpoints(session)).toHaveLength(1)
    expect(textOfEvent(checkpoints(session)[0]!)).toContain('turns 1-3 · 3 turns archived')
    expect(warnings.join('\n')).toContain('archived the recent tail (keepRecentChars) as well')
  })

  it('drops checkpoint bodies as the last tier before refusing', () => {
    const session = Session.create(SessionId('context-bare-degradation'))
    for (let turn = 1; turn <= 40; turn += 1) completedTurn(session, turn, `QUESTION_${turn} ${'q'.repeat(200)}`, `ANSWER_${turn} ${'a'.repeat(200)}`)
    const warnings: string[] = []
    const plan = archiveUnderPressure(session, [], forced({ maxRequestChars: 1_000 }), message => warnings.push(message))
    expect(plan.viewChars).toBeLessThanOrEqual(1_000)
    const text = textOfEvent(checkpoints(session)[0]!)
    expect(text.startsWith('[slice checkpoint v1 · turns 1-40 · 40 turns archived')).toBe(true)
    expect(text).toContain('served verbatim by recall_turn')
    expect(text).not.toContain('QUESTION_2 ')
    expect(renderSealedTurn(session.snapshotEvents(), 2)?.rendered).toContain('QUESTION_2 ')
    expect(warnings.join('\n')).toContain('checkpoint bodies omitted')
  })

  it('says a refusal repeats until the budget or the session changes', () => {
    const session = Session.create(SessionId('context-permanent-refusal'))
    completedTurn(session, 1, 'first question', 'first answer')
    user(session, 'P'.repeat(500), 'runtime-fixture')
    completedTurn(session, 2, 'second question', 'second answer')
    expect(() => archiveUnderPressure(session, [], forced({ maxRequestChars: 300 })))
      .toThrow(/every later turn of this session fails the same way until maxRequestChars is raised/)
  })

  it('decides the whole archive before appending and refuses an impossible request budget atomically', () => {
    const session = Session.create(SessionId('context-atomic-admission'))
    completedTurn(session, 1, 'a'.repeat(500), 'first answer')
    user(session, 'protected middle', 'runtime-fixture')
    completedTurn(session, 2, 'b'.repeat(500), 'second answer')
    completedTurn(session, 3, 'c'.repeat(500), 'third answer')
    const before = structuredClone(session.snapshotEvents())
    const surface = [...session.surface.nodes]
    expect(() => planArchive(session, [], forced({ maxRequestChars: 150 }))).toThrow(SliceBudgetError)
    expect(() => archiveUnderPressure(session, [], forced({ maxRequestChars: 150 }))).toThrow(/maxRequestChars/)
    expect(session.snapshotEvents()).toEqual(before)
    expect(session.surface.nodes).toEqual(surface)
  })

  it('treats an explicit maxHistoryChars as an extra cap on rendered history', () => {
    const session = Session.create(SessionId('context-explicit-history-cap'))
    for (let turn = 1; turn <= 4; turn += 1) completedTurn(session, turn, `QUESTION_${turn} ${'q'.repeat(400)}`, `ANSWER_${turn}`)
    const relaxed = forced({ highWaterChars: 300_000, lowWaterChars: 150_000 })
    expect(archiveUnderPressure(session, [], relaxed).appends).toEqual([])
    const plan = archiveUnderPressure(session, [], { ...relaxed, maxHistoryChars: 1_500 })
    expect(plan.appends).toHaveLength(1)
    expect(checkpoints(session)).toHaveLength(1)
    expect(surfaceText(session)).toContain(`QUESTION_4 ${'q'.repeat(400)}`)
  })

  it('stops at the explicit cap when pressure did not fire instead of draining to lowWater', () => {
    const session = Session.create(SessionId('context-cap-target'))
    completedTurn(session, 1, 'QUESTION_1', `ANSWER_1 ${'a'.repeat(20_000)}`)
    completedTurn(session, 2, 'QUESTION_2', `ANSWER_2 ${'a'.repeat(20_000)}`)
    user(session, 'P'.repeat(5_000), 'runtime-fixture')
    completedTurn(session, 3, 'QUESTION_3', `ANSWER_3 ${'a'.repeat(5_000)}`)
    completedTurn(session, 4, 'QUESTION_4', `ANSWER_4 ${'a'.repeat(5_000)}`)
    completedTurn(session, 5, 'QUESTION_5', `ANSWER_5 ${'a'.repeat(5_000)}`)
    // History 55K exceeds the 50K cap; the view (~61K) never crossed highWater, so lowWater is not a target.
    const policy = forced({ highWaterChars: 200_000, lowWaterChars: 10_000, maxHistoryChars: 50_000 })
    const plan = planArchive(session, [], policy)
    expect(plan.appends).toHaveLength(1)
    expect(plan.historyChars).toBeLessThanOrEqual(50_000)
    expect(plan.viewChars).toBeGreaterThan(10_000)
    expect(plan.appends[0]!.message.content[0]).toMatchObject({ text: expect.stringContaining('turns 1-2 · 2 turns archived') })
  })

  it('keeps one water-mark band of append headroom when an un-archivable floor stays above the target', () => {
    const session = Session.create(SessionId('context-floor-headroom'))
    user(session, 'P'.repeat(700), 'runtime-fixture')
    // Each turn is well under the 300-char band, so two archives can never land on consecutive turns.
    const policy = forced({ highWaterChars: 600, lowWaterChars: 300 })
    const appends: number[] = []
    for (let turn = 1; turn <= 8; turn += 1) {
      completedTurn(session, turn, `Q${turn}`, `A${turn}`)
      appends.push(archiveUnderPressure(session, [], policy).appends.length)
    }
    expect(appends.every(n => n <= 1)).toBe(true)
    expect(appends.reduce((n, m) => n + m, 0)).toBeGreaterThanOrEqual(2)
    expect(appends.some((n, i) => n === 1 && appends[i - 1] === 1)).toBe(false)
    expect(checkpoints(session)).toHaveLength(1)
  })

  it('does not re-archive every turn under an explicit cap smaller than the recent tail', () => {
    const session = Session.create(SessionId('context-cap-floor'))
    const policy = forced({ highWaterChars: 300_000, lowWaterChars: 150_000, maxHistoryChars: 10 })
    const appends: number[] = []
    for (let turn = 1; turn <= 6; turn += 1) {
      completedTurn(session, turn, `QUESTION_${turn} ${'q'.repeat(150)}`, `ANSWER_${turn} ${'a'.repeat(150)}`)
      appends.push(archiveUnderPressure(session, [], policy).appends.length)
    }
    expect(appends).toEqual([0, 1, 0, 0, 0, 0])
    expect(session.snapshotEvents().filter(event => event.type === 'user/message' && event.surfaceOp !== 'append')).toHaveLength(1)
  })

  it('caps a checkpoint at checkpointMaxChars by dropping tool lines before shrinking excerpts', () => {
    const session = Session.create(SessionId('context-checkpoint-cap'))
    for (let turn = 1; turn <= 5; turn += 1) toolTurn(session, turn, `cap-${turn}`, 'x'.repeat(200))
    for (let turn = 6; turn <= 10; turn += 1) completedTurn(session, turn, `LONG_${turn} ${'l'.repeat(5_000)}`, `ANSWER_${turn}`)
    completedTurn(session, 11, 'tail', 'tail answer')
    const plan = archiveUnderPressure(session, [], forced({ pinUserChars: 10_000, checkpointMaxChars: 3_000 }))
    expect(plan.appends).toHaveLength(1)
    const text = plan.appends[0]!.message.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(Array.from(text).length).toBeLessThanOrEqual(3_000)
    expect(text).not.toContain('[tool turn')
    expect(text).toContain('…[+')
    for (let turn = 1; turn <= 10; turn += 1) expect(text).toContain(`[turn ${turn}]`)
  })

  it('nests an earlier checkpoint as one line and a legacy tape as one unit', () => {
    const session = Session.create(SessionId('context-nesting'))
    const first = completedTurn(session, 1, 'FIRST_QUESTION', 'FIRST_ANSWER')
    const legacy = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '# SESSION TAPE (sealed conversational history; not current-world truth)\nLEGACY_BODY' }],
      source: { kind: 'plugin', plugin: HISTORY_SOURCE },
    }), { surfaceOp: { op: 'replace', start: first.response.seq, end: first.response.seq }, sourceEventSeqs: [first.response.seq] })
    completedTurn(session, 2, 'SECOND_QUESTION', 'SECOND_ANSWER')
    completedTurn(session, 3, 'THIRD_QUESTION', 'THIRD_ANSWER')
    archiveUnderPressure(session, [], forced())
    const [one] = checkpoints(session)
    expect(session.surface.nodes).not.toContain(legacy.seq)
    expect(one!.sourceEventSeqs).toContain(legacy.seq)
    const oneText = surfaceText(session)
    expect(oneText).toContain('[slice checkpoint v1 · turns 1-2 · 2 turns archived')
    expect(oneText).toContain('[earlier checkpoint covered turns 1-1; recall_turn for details]')
    expect(oneText).not.toContain('LEGACY_BODY')
    expect(oneText).not.toContain('FIRST_ANSWER')

    completedTurn(session, 4, 'FOURTH_QUESTION', 'FOURTH_ANSWER')
    archiveUnderPressure(session, [], forced())
    const [two] = checkpoints(session)
    expect(checkpoints(session)).toHaveLength(1)
    expect(two!.seq).not.toBe(one!.seq)
    expect(two!.sourceEventSeqs).toContain(one!.seq)
    const twoText = surfaceText(session)
    expect(twoText).toContain('[slice checkpoint v1 · turns 1-3 · 3 turns archived')
    expect(twoText).toContain('[earlier checkpoint covered turns 1-2; recall_turn for details]')
    expect(twoText).not.toContain('SECOND_QUESTION')
    expect(twoText).toContain('THIRD_QUESTION')
    expect(twoText.split('[slice checkpoint v1')).toHaveLength(2)
  })
})

describe('recall source attribution', () => {
  it('keeps generated context out of the user request but still serves it from both recall tools', () => {
    const session = Session.create(SessionId('recall-authority'))
    session.append('turn/start', { turn: 1 })
    user(session, 'REAL_USER_SENTINEL')
    user(session, 'PLUGIN_INPUT_SENTINEL', 'runtime-fixture')
    assistant(session, 1, [{ type: 'text', text: 'REAL_ASSISTANT_SENTINEL' }])
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    user(session, 'SECOND_REAL_USER')
    assistant(session, 2, [{ type: 'text', text: 'SECOND_REAL_ASSISTANT' }])
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 3 })
    archiveUnderPressure(session, [], forced())
    expect(checkpoints(session)).toHaveLength(1)
    const first = renderSealedTurn(session.snapshotEvents(), 1)!
    const second = renderSealedTurn(session.snapshotEvents(), 2)!
    // Attribution is unchanged: generated context is not a user request.
    expect(first.userMessages).toBe(1)
    expect(first.contextMessages).toBe(1)
    const request = first.rendered.slice(first.rendered.indexOf('## User request'), first.rendered.indexOf('## Assistant response'))
    expect(request).toContain('REAL_USER_SENTINEL')
    expect(request).not.toContain('PLUGIN_INPUT_SENTINEL')
    // Reachability, however, is required: checkpoints omit superseded runtime snapshots and name
    // these tools as the locator, so both must serve plugin-produced context.
    expect(first.rendered).toContain('## Generated context recorded during this turn (verbatim)')
    expect(first.rendered).toContain('PLUGIN_INPUT_SENTINEL')
    const context = searchSessionEvents(session.snapshotEvents(), 'PLUGIN_INPUT_SENTINEL')
    expect(context).toHaveLength(1)
    expect(context[0]).toMatchObject({ turn: 1, kind: 'context' })
    expect(second.userMessages).toBe(1)
    expect(second.contextMessages).toBe(0)
    expect(second.rendered).not.toContain('REAL_USER_SENTINEL')
    expect(second.rendered).not.toContain('[slice checkpoint')
    expect(searchSessionEvents(session.snapshotEvents(), 'PLUGIN_INPUT_SENTINEL', { kinds: ['user'] })).toEqual([])
    const hits = searchSessionEvents(session.snapshotEvents(), 'REAL_USER_SENTINEL', { kinds: ['user'] })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.turn).toBe(1)
  })

  it('indexes original tool results once and excludes their generated replacement views', () => {
    const session = Session.create(SessionId('recall-result-replacements'))
    session.append('turn/start', { turn: 1 })
    const original = session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: ToolCallId('lookup'), isError: false, content: [{ type: 'text', text: 'ORIGINAL_RESULT_SENTINEL' }] }),
    }, { surfaceOp: 'append' })
    const content = [{ ...original.data.message.content[0], content: [{ type: 'text' as const, text: 'GENERATED_RESULT_SENTINEL' }] }] as [typeof original.data.message.content[0]]
    session.append('tool/result', { ...original.data, message: { ...original.data.message, content } }, {
      surfaceOp: { op: 'replace', start: original.seq, end: original.seq }, sourceEventSeqs: [original.seq],
    })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(searchSessionEvents(session.snapshotEvents(), 'GENERATED_RESULT_SENTINEL', { kinds: ['tool_output'] })).toEqual([])
    expect(searchSessionEvents(session.snapshotEvents(), 'ORIGINAL_RESULT_SENTINEL', { kinds: ['tool_output'] })).toHaveLength(1)
    expect(renderSealedTurn(session.snapshotEvents(), 1)?.rendered).toContain('ORIGINAL_RESULT_SENTINEL')
    expect(renderSealedTurn(session.snapshotEvents(), 1)?.rendered).not.toContain('GENERATED_RESULT_SENTINEL')
  })

  it('uses explicit assistant and tool turns when recording raw historical provenance', () => {
    const session = Session.create(SessionId('recall-explicit-turn'))
    session.append('turn/start', { turn: 1 })
    user(session, 'TURN_ONE_INPUT')
    assistant(session, 2, [{ type: 'text', text: 'EXPLICIT_TURN_TWO_RECORD' }])
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(renderSealedTurn(session.snapshotEvents(), 1)?.rendered).not.toContain('EXPLICIT_TURN_TWO_RECORD')
    expect(renderSealedTurn(session.snapshotEvents(), 2)?.rendered).toContain('EXPLICIT_TURN_TWO_RECORD')
  })
})
