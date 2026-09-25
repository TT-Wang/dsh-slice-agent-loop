import { describe, expect, it } from 'vitest'
import { createMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId, type ContentBlock, type Message } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent, type SessionSeq, type UserMessage } from '@deepseek-ai/dsh-session'
import './v4-fixtures.js'
import { HISTORY_SOURCE, planSeal, RUNTIME_CONTEXT_SOURCE, sealCompletedTurns, TAPE_PREFIX, type HistoryPolicy } from '../src/context.js'
import { renderSealedTurn, searchSessionEvents } from '../src/recall.js'

/** A user-role message; `kind` is the producer's V4 source kind (a third-party producer is `plugin:<name>`). */
function user(session: Session, text: string, kind?: string) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: (kind ? { kind } : { kind: 'user' }) as UserMessage['source'],
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
  if (protectedText !== undefined) user(session, protectedText, 'plugin:runtime-fixture')
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

/** Sealed tape entries on the surface, in surface order. */
function entries(session: Session): SessionEvent<'user/message'>[] {
  return session.surface.nodes.flatMap(seq => {
    const event = session.eventAt(seq)
    return event?.type === 'user/message' && event.data.source.kind === HISTORY_SOURCE ? [event] : []
  })
}

/** Seq and bytes of every entry on the surface: an entry is written once and is never re-rendered. */
function frozen(session: Session): Array<{ seq: SessionSeq; text: string }> {
  return entries(session).map(event => ({ seq: event.seq, text: textOfEvent(event) }))
}

/** Index of the first message two consecutive request views disagree on. */
function firstDivergence(a: readonly Message[], b: readonly Message[]): number {
  let i = 0
  while (i < a.length && i < b.length && JSON.stringify(a[i]) === JSON.stringify(b[i])) i += 1
  return i
}

/** Default tape policy: seal completed assistant/tool runs without a character cap. */
function policy(over: Partial<HistoryPolicy> = {}): HistoryPolicy {
  return {
    keepRecentTurns: 0, ...over,
  }
}

describe('append-only tape sealing', () => {
  it('preserves the system prompt head, later prompt updates and dormant system nodes', () => {
    const session = Session.create(SessionId('context-system-surface'))
    const systemEvents: SessionEvent<'system/message'>[] = []
    for (const [index, prompt] of ['HEAD_SYSTEM_INSTRUCTION', 'UPDATED_SYSTEM_INSTRUCTION', ''].entries()) {
      const turn = index + 1
      session.append('turn/start', { turn })
      systemEvents.push(session.append('system/message', {
        turn, step: 1, message: createSystemMessage(prompt),
      }, { surfaceOp: 'append' }))
      user(session, `QUESTION_${turn}`)
      assistant(session, turn, [{ type: 'text', text: `ANSWER_${turn}` }])
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const before = structuredClone(session.snapshotEvents())
    const plan = sealCompletedTurns(session, [], policy())
    expect(plan.appends).toHaveLength(3)
    expect(session.surface.nodes[0]).toBe(systemEvents[0]!.seq)
    for (const event of systemEvents) {
      expect(session.surface.nodes).toContain(event.seq)
      expect(session.eventAt(event.seq)).toEqual(event)
      expect(plan.appends.flatMap(append => append.sources)).not.toContain(event.seq)
    }
    expect(session.deriveMessages().filter(message => message.role === 'system')).toEqual(systemEvents.slice(0, 2).map(event => event.data.message))
    expect(session.snapshotEvents().slice(0, before.length)).toEqual(before)
    expect(surfaceText(session)).toContain('UPDATED_SYSTEM_INSTRUCTION')
    expect(entries(session).map(textOfEvent).join('\n')).not.toContain('SYSTEM_INSTRUCTION')
  })

  it('never seals or cites the V4 system head node 0, even after the host replaces it in place behind existing entries', () => {
    const session = Session.create(SessionId('context-system-head-v4'))
    session.append('turn/start', { turn: 1 })
    const head = session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('HEAD_SYSTEM_V1') }, { surfaceOp: 'append' })
    user(session, 'QUESTION_1')
    assistant(session, 1, [{ type: 'text', text: 'ANSWER_1' }])
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    completedTurn(session, 2, 'QUESTION_2', 'ANSWER_2')
    session.append('turn/start', { turn: 3 })
    const first = sealCompletedTurns(session, [], policy())
    expect(first.appends).toHaveLength(2)
    expect(session.surface.nodes[0]).toBe(head.seq)
    const written = frozen(session)

    // The host rewrites the prompt in place: node 0 now holds a replacement appended after the entries.
    const rewritten = session.append('system/message', { turn: 3, step: 1, message: createSystemMessage('HEAD_SYSTEM_V2') }, {
      surfaceOp: { op: 'replace', startSeq: head.seq, endSeq: head.seq }, sourceEventSeqs: [head.seq],
    })
    user(session, 'QUESTION_3')
    assistant(session, 3, [{ type: 'text', text: 'ANSWER_3' }])
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 4 })
    const view = session.deriveMessages()
    const lastEntry = view.reduce((last, message, index) => message.role === 'user' && message.source.kind === HISTORY_SOURCE ? index : last, -1)
    const plan = sealCompletedTurns(session, [], policy())

    expect(plan.appends).toHaveLength(1)
    expect(textOfEvent(entries(session).at(-1)!).startsWith(`${TAPE_PREFIX}3-3`)).toBe(true)
    const systemSeqs = [head.seq, rewritten.seq]
    for (const append of [...first.appends, ...plan.appends]) {
      for (const seq of systemSeqs) expect(append.sources).not.toContain(seq)
      expect(systemSeqs).not.toContain(append.start)
    }
    // Node 0 stays the host's replacement; entries written behind it are neither rewritten nor re-rendered.
    expect(session.surface.nodes[0]).toBe(rewritten.seq)
    expect(session.deriveMessages()[0]).toEqual(rewritten.data.message)
    expect(frozen(session).slice(0, written.length)).toEqual(written)
    expect(firstDivergence(view, session.deriveMessages())).toBeGreaterThan(lastEntry)
    expect(entries(session).map(textOfEvent).join('\n')).not.toContain('HEAD_SYSTEM')
  })

  it('preserves every long user node and seals only the completed assistant runs', () => {
    const session = Session.create(SessionId('context-large-history'))
    const original: Array<ReturnType<typeof completedTurn>> = []
    for (let turn = 1; turn <= 10; turn += 1) {
      const question = `ORIGINAL_TURN_${turn}_` + 'x'.repeat(60_000)
      original.push(completedTurn(session, turn, question, `ANSWER_${turn}`))
    }
    const before = structuredClone(session.snapshotEvents())
    // User nodes remain raw and divide the completed assistant runs into entries.
    const plan = sealCompletedTurns(session, [], policy({ keepRecentTurns: 1 }))
    const text = surfaceText(session)
    expect(plan.appends).toHaveLength(9)
    expect(plan.viewChars).toBe(Array.from(JSON.stringify(session.deriveMessages())).length)
    expect(plan.viewChars).toBeGreaterThan(600_000)
    expect(entries(session)).toHaveLength(9)
    expect(entries(session)[0]!.surfaceOp).toEqual({
      op: 'replace', startSeq: plan.appends[0]!.start, endSeq: plan.appends[0]!.end,
    })
    expect(text).toContain(`ORIGINAL_TURN_10_${'x'.repeat(60_000)}`)
    expect(text).toContain(`ORIGINAL_TURN_1_${'x'.repeat(60_000)}`)
    expect(text).toContain('recall_turn({"turn":"<n>","view":"dialogue"})')
    expect(session.snapshotEvents().slice(0, before.length)).toEqual(before)
    original.forEach(({ request, response }, index) => {
      expect(session.surface.nodes).toContain(request.seq)
      expect(session.eventAt(request.seq)).toEqual(request)
      expect(plan.appends.flatMap(append => append.sources)).not.toContain(request.seq)
      expect(renderSealedTurn(session.snapshotEvents(), index + 1)?.rendered).toContain(textOfEvent(request))
      expect(session.surface.nodes.includes(response.seq)).toBe(index === 9)
    })
  })

  it('appends nothing while a turn is open, one entry per completed turn, and nothing on a repeat call', () => {
    const open = Session.create(SessionId('context-open-turn'))
    open.append('turn/start', { turn: 1 })
    user(open, `QUESTION_1 ${'q'.repeat(300)}`)
    // Nothing has completed yet, so there is nothing to seal.
    expect(planSeal(open, [], policy()).appends).toEqual([])

    const session = Session.create(SessionId('context-repeat-history'))
    let settled: ReturnType<typeof frozen> = []
    for (let turn = 1; turn <= 6; turn += 1) {
      completedTurn(session, turn, `QUESTION_${turn} ${'q'.repeat(300)}`, `ANSWER_${turn} ${'a'.repeat(300)}`)
      const before = session.snapshotEvents().length
      const plan = sealCompletedTurns(session, [], policy())
      expect(session.snapshotEvents().length - before).toBe(plan.appends.length)
      // Exactly one entry per turn, at that turn's own position, leaving every earlier entry byte-identical.
      expect(plan.appends).toHaveLength(1)
      expect(frozen(session).slice(0, settled.length)).toEqual(settled)
      expect(entries(session)).toHaveLength(turn)
      settled = frozen(session)
      const snapshot = structuredClone(session.snapshotEvents())
      const surface = [...session.surface.nodes]
      for (let repeat = 0; repeat < 3; repeat += 1) expect(sealCompletedTurns(session, [], policy()).appends).toEqual([])
      expect(session.snapshotEvents()).toEqual(snapshot)
      expect(session.surface.nodes).toEqual(surface)
      expect(surfaceText(session).split(`QUESTION_${turn} `)).toHaveLength(2)
      expect(surfaceText(session).split(`ANSWER_${turn} `)).toHaveLength(2)
    }
    expect(session.snapshotEvents().filter(event => event.type === 'user/message' && event.surfaceOp !== 'append')).toHaveLength(6)
    expect(entries(session).map(event => /turns (\d+)-(\d+) · (\d+) turn\(s\) sealed/.exec(textOfEvent(event))![0])).toEqual([
      'turns 1-1 · 1 turn(s) sealed', 'turns 2-2 · 1 turn(s) sealed', 'turns 3-3 · 1 turn(s) sealed',
      'turns 4-4 · 1 turn(s) sealed', 'turns 5-5 · 1 turn(s) sealed', 'turns 6-6 · 1 turn(s) sealed',
    ])
  })

  it('keeps every user message raw even when an explicit entry cap omits assistant detail', () => {
    const session = Session.create(SessionId('context-user-fidelity'))
    for (let turn = 1; turn <= 3; turn += 1) {
      const text = `  USER_${turn}_${'u'.repeat(1_600)}_MIDDLE_REQUIREMENT_${'v'.repeat(10_000)}\n\t `
      const { request } = completedTurn(session, turn, text, 'assistant detail '.repeat(2_000))
      const plan = sealCompletedTurns(session, [], policy({ entryMaxChars: 256 }))
      expect(session.surface.nodes).toContain(request.seq)
      expect(session.eventAt(request.seq)).toEqual(request)
      expect(plan.appends[0]!.sources).not.toContain(request.seq)
      expect(textOfEvent(request)).toBe(text)
      expect(surfaceText(session)).toContain(text)
      expect(Array.from(textOfEvent(entries(session).at(-1)!)).length).toBeLessThanOrEqual(256)
    }
  })

  it('preserves every assistant text message and whitespace without the old reply or entry caps', () => {
    const session = Session.create(SessionId('context-assistant-fidelity'))
    session.append('turn/start', { turn: 1 })
    user(session, 'USER_REQUIREMENTS')
    const first = `  FIRST ${'a'.repeat(3_000)} MIDDLE_FIRST ${'b'.repeat(8_000)}\n\t `
    const last = `\n LAST ${'c'.repeat(3_000)} MIDDLE_LAST ${'d'.repeat(8_000)}  `
    const before = assistant(session, 1, [{ type: 'text', text: first }])
    const after = assistant(session, 1, [{ type: 'text', text: last }])
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const plan = sealCompletedTurns(session, [], policy())
    expect(plan.appends).toHaveLength(1)
    const text = textOfEvent(entries(session)[0]!)
    expect(text).toContain(`\n${first}\n[end reply`)
    expect(text).toContain(`\n${last}\n[end reply`)
    expect(text.indexOf(first)).toBeLessThan(text.indexOf(last))
    expect(text).toContain(`step-1-seq-${before.seq}`)
    expect(text).toContain(`step-1-seq-${after.seq}`)
    expect(Array.from(text).length).toBeGreaterThan(22_000)
    expect(text).not.toContain('chars in sealed turn')
  })

  it('keeps a complete reply when it fits an explicit entry cap despite exceeding the former reply cap', () => {
    const session = Session.create(SessionId('context-explicit-cap-full-reply'))
    const reply = `  ${'a'.repeat(1_800)}_MIDDLE_${'z'.repeat(1_800)}\n\t `
    completedTurn(session, 1, 'QUESTION', reply)
    sealCompletedTurns(session, [], policy({ entryMaxChars: 5_000 }))
    expect(textOfEvent(entries(session)[0]!)).toContain(`\n${reply}\n[end reply`)
  })

  it('preserves earlier truncated entries on restore while applying uncapped defaults to new turns', () => {
    const original = Session.create(SessionId('context-restore-capped'))
    completedTurn(original, 1, 'ORIGINAL_REQUEST', 'OLD_DETAIL_'.repeat(1_000))
    sealCompletedTurns(original, [], policy({ entryMaxChars: 256 }))
    const [sealed] = frozen(original)
    const restored = Session.create(SessionId('context-restore-uncapped'), original.snapshotEvents())
    const userText = 'USER_HEAD_' + 'u'.repeat(9_000) + '_USER_MIDDLE_' + 'v'.repeat(9_000)
    const reply = 'REPLY_HEAD_' + 'a'.repeat(9_000) + '_REPLY_MIDDLE_' + 'b'.repeat(9_000)
    const { request } = completedTurn(restored, 2, userText, reply)
    sealCompletedTurns(restored, [], policy())
    expect(frozen(restored)[0]).toEqual(sealed)
    expect(frozen(restored)[1]!.text).toContain(reply)
    expect(restored.surface.nodes).toContain(request.seq)
    expect(surfaceText(restored)).toContain(userText)
    expect(sealCompletedTurns(restored, [], policy()).appends).toEqual([])
  })

  it('preserves a foreign canonical replacement without resurrecting the messages it shadows', () => {
    const session = Session.create(SessionId('context-canonical-replacement'))
    const original = completedTurn(session, 1, 'SHADOWED_QUESTION', 'SHADOWED_RESPONSE')
    const canonical = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'CANONICAL_FOREIGN_CONTEXT' }], source: { kind: 'plugin:test-context' },
    }), {
      surfaceOp: { op: 'replace', startSeq: original.request.seq, endSeq: original.response.seq },
      sourceEventSeqs: [original.request.seq, original.response.seq],
    })
    completedTurn(session, 2, 'SECOND_QUESTION', 'SECOND_RESPONSE')
    completedTurn(session, 3, 'THIRD_QUESTION', 'THIRD_RESPONSE')
    sealCompletedTurns(session, [], policy())
    expect(session.surface.nodes).toContain(canonical.seq)
    expect(entries(session)).toHaveLength(2)
    expect(entries(session)[0]!.sourceEventSeqs).not.toContain(canonical.seq)
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
      surfaceOp: { op: 'replace', startSeq: original.request.seq, endSeq: original.response.seq },
      sourceEventSeqs: [original.request.seq, original.response.seq],
    })
    completedTurn(session, 2, 'SECOND_USER_QUESTION', 'SECOND_USER_RESPONSE')
    completedTurn(session, 3, 'THIRD_USER_QUESTION', 'THIRD_USER_RESPONSE')
    expect(renderSealedTurn(session.snapshotEvents(), 1)?.rendered).not.toContain(text)
    sealCompletedTurns(session, [], policy())
    expect(session.surface.nodes).toContain(canonical.seq)
    expect(surfaceText(session)).toContain(text)
    expect(surfaceText(session)).not.toContain('ORIGINAL_RAW_QUESTION')
  })

  it('seals closed calls with their results and points at the original result records', () => {
    const session = Session.create(SessionId('context-closed-tools'))
    const result = toolTurn(session, 1, 'closed-read', 'DURABLE_FILE_BYTES')
    completedTurn(session, 2, 'next question', 'next answer')
    sealCompletedTurns(session, [], policy())
    expect(entries(session)).toHaveLength(2)
    expect(session.deriveMessages().some(message => message.role === 'tool')).toBe(false)
    expect(session.deriveMessages().flatMap(message => message.content).some(block => block.type === 'tool-call')).toBe(false)
    const text = surfaceText(session)
    expect(text).toContain(`[tool turn 1 step 1 seq ${result.seq} · read · 18 chars · expand_result({"seq":${result.seq},"formatVersion":${SESSION_FORMAT_VERSION}})]`)
    expect(text).not.toContain('DURABLE_FILE_BYTES')
    expect(renderSealedTurn(session.snapshotEvents(), 1, { view: 'full' })?.rendered).toContain('DURABLE_FILE_BYTES')
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
    const plan = sealCompletedTurns(session, [], policy())
    expect(plan.appends).toHaveLength(4)
    expect(plan.appends[1]!.sources).toContain(empty.seq)
    expect(session.surface.nodes).not.toContain(empty.seq)
    expect(entries(session)[1]!.sourceEventSeqs).toContain(empty.seq)
    expect(textOfEvent(entries(session)[1]!)).toContain(`${TAPE_PREFIX}2-2 · 1 turn(s) sealed`)
    expect(surfaceText(session)).toContain('SECOND_QUESTION')
    expect(surfaceText(session)).toContain('FOURTH_QUESTION')
  })

  it('cuts a sealed span at a turn with an unclosed tool call instead of suppressing the whole span', () => {
    const session = Session.create(SessionId('context-unclosed-cut'))
    for (let turn = 1; turn <= 4; turn += 1) completedTurn(session, turn, `QUESTION_${turn}`, `ANSWER_${turn}`)
    session.append('turn/start', { turn: 5 })
    const open = user(session, 'QUESTION_5')
    const call = assistant(session, 5, [{ type: 'tool-call', id: ToolCallId('never-closed'), name: 'read', arguments: '{}' }])
    session.append('turn/end', { turn: 5, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    for (let turn = 6; turn <= 8; turn += 1) completedTurn(session, turn, `QUESTION_${turn}`, `ANSWER_${turn}`)
    const warnings: string[] = []
    const plan = sealCompletedTurns(session, [], policy(), message => warnings.push(message))
    expect(plan.appends).toHaveLength(7)
    // A-RT-05: the cut is reported, naming the call; a silent cut looks like a seal that never shrinks.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('turn 5')
    expect(warnings[0]).toContain('never-closed')
    expect(warnings[0]).toContain('cut the sealed span')
    expect(entries(session).map(textOfEvent)).toEqual([1, 2, 3, 4, 6, 7, 8].map(turn => expect.stringContaining(`turns ${turn}-${turn} · 1 turn(s) sealed`)))
    expect(session.surface.nodes).toContain(open.seq)
    expect(session.surface.nodes).toContain(call.seq)
    // Eight original user nodes, seven entries, and one unmatched assistant call.
    expect(session.surface.nodes).toHaveLength(16)
    const blocks = session.deriveMessages().flatMap(message => message.content)
    expect(blocks.filter(block => block.type === 'tool-call')).toHaveLength(1)
    expect(surfaceText(session)).toContain('QUESTION_8')
  })

  it('does not split a tool call from its result across a protected plugin context boundary', () => {
    const session = Session.create(SessionId('context-protected-tool-span'))
    toolTurn(session, 1, 'protected-read', 'UNCHANGED_RESULT', 'PROTECTED_CONTEXT')
    completedTurn(session, 2, 'next question', 'next answer')
    const before = [...session.surface.nodes]
    const warnings: string[] = []
    // Turn 1 is inside the seal window (turn 2 is the kept tail): only the unpaired cut keeps it raw.
    expect(sealCompletedTurns(session, [], policy({ keepRecentTurns: 1 }), message => warnings.push(message)).appends).toEqual([])
    expect(session.surface.nodes).toEqual(before)
    expect(warnings.every(message => message.includes('turn 1') && message.includes('protected-read'))).toBe(true)
    expect(warnings.length).toBeGreaterThanOrEqual(1)
    const blocks = session.deriveMessages().flatMap(message => message.content)
    expect(blocks.filter(block => block.type === 'tool-call')).toHaveLength(1)
    expect(session.deriveMessages().filter(message => message.role === 'tool')).toHaveLength(1)
  })

  it('stays silent when every sealed turn is call-closed', () => {
    const session = Session.create(SessionId('context-no-spurious-warn'))
    toolTurn(session, 1, 'closed-one', 'RESULT_ONE')
    for (let turn = 2; turn <= 4; turn += 1) completedTurn(session, turn, `QUESTION_${turn}`, `ANSWER_${turn}`)
    const warnings: string[] = []
    expect(sealCompletedTurns(session, [], policy(), message => warnings.push(message)).appends).toHaveLength(4)
    expect(warnings).toEqual([])
  })

  it('seals superseded runtime snapshots with their own turn and keeps only the live one protected', () => {
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
    sealCompletedTurns(session, [], policy({ keepRecentTurns: 1 }))
    const text = surfaceText(session)
    // The live snapshot keeps its node, its source and its position.
    expect(session.surface.nodes).toContain(snapshots[7])
    expect(session.eventAt(snapshots[7]!)).toEqual(live)
    for (const entry of entries(session)) expect(entry.sourceEventSeqs).not.toContain(snapshots[7])
    expect(text.split('RUNTIME_SNAPSHOT_8')).toHaveLength(2)
    for (let stale = 1; stale <= 7; stale += 1) {
      expect(session.surface.nodes).not.toContain(snapshots[stale - 1])
      expect(text).not.toContain(`RUNTIME_SNAPSHOT_${stale}`)
    }
    // User nodes split turns; each old snapshot joins its assistant run.
    expect(entries(session)).toHaveLength(7)
    expect(textOfEvent(entries(session)[0]!)).toContain('turns 1-1 · 1 turn(s) sealed')
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
    sealCompletedTurns(session, [], policy({ keepRecentTurns: 1 }))
    const text = entries(session).map(textOfEvent).join('\n')
    expect(text).toContain('[turn 2]\n[slice note · runtime-context snapshot superseded by a later one; not repeated here · verbatim: recall_turn({"turn":"2"})]')
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
    const pending = createUserMessage({ content: [{ type: 'text', text: 'RUNTIME_SNAPSHOT_4' }], source: { kind: RUNTIME_CONTEXT_SOURCE } })
    const plan = sealCompletedTurns(session, [pending], policy())
    // Turn 3's snapshot would be the live one; the pending projection supersedes it, so its own turn absorbs it.
    expect(plan.appends).toHaveLength(3)
    for (const seq of snapshots) expect(session.surface.nodes).not.toContain(seq)
    const text = surfaceText(session)
    expect(text).not.toContain('RUNTIME_SNAPSHOT_')
    expect(text).toContain('[turn 3]\n[slice note · runtime-context snapshot superseded by a later one; not repeated here · verbatim: recall_turn({"turn":"3"})]')
  })

  it('seals a snapshot appended between turns behind a locator that recall actually serves', () => {
    const session = Session.create(SessionId('context-unattributable-runtime'))
    completedTurn(session, 1, 'QUESTION_1', 'ANSWER_1')
    const orphan = user(session, 'BETWEEN_TURNS_SNAPSHOT', RUNTIME_CONTEXT_SOURCE)
    completedTurn(session, 2, 'QUESTION_2', 'ANSWER_2')
    completedTurn(session, 3, 'QUESTION_3', 'ANSWER_3')
    const liveSnapshot = user(session, 'LIVE_SNAPSHOT', RUNTIME_CONTEXT_SOURCE)
    sealCompletedTurns(session, [], policy())
    expect(session.surface.nodes).not.toContain(orphan.seq)
    expect(session.surface.nodes).toContain(liveSnapshot.seq)
    expect(entries(session)).toHaveLength(3)
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
    sealCompletedTurns(session, [], policy())
    expect(session.surface.nodes).toContain(early.seq)
    expect(searchSessionEvents(session.snapshotEvents(), 'BEFORE_ANY_TURN_SNAPSHOT', { kinds: ['context'] })).toEqual([])
  })

  it('seals on every consecutive turn and never re-renders an entry an un-sealable floor sits above', () => {
    const session = Session.create(SessionId('context-floor-headroom'))
    user(session, 'P'.repeat(700), 'plugin:runtime-fixture')
    const appends: number[] = []
    let settled: ReturnType<typeof frozen> = []
    for (let turn = 1; turn <= 8; turn += 1) {
      completedTurn(session, turn, `Q${turn}`, `A${turn}`)
      const view = session.deriveMessages()
      appends.push(sealCompletedTurns(session, [], policy()).appends.length)
      // A seal lands after every entry already written, so the request keeps the previous request's prefix.
      expect(firstDivergence(view, session.deriveMessages())).toBeGreaterThanOrEqual(settled.length)
      expect(frozen(session).slice(0, settled.length)).toEqual(settled)
      settled = frozen(session)
    }
    // Consecutive seals are the point, not a hazard: one entry per turn, and no earlier entry is re-billed.
    expect(appends).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
    expect(entries(session)).toHaveLength(8)
  })

  it('caps an entry at entryMaxChars by dropping tool lines before shrinking excerpts', () => {
    const session = Session.create(SessionId('context-checkpoint-cap'))
    const id = ToolCallId('cap-read')
    session.append('turn/start', { turn: 1 })
    user(session, 'REQUIREMENTS_STAY_RAW')
    assistant(session, 1, [{ type: 'tool-call', id, name: 'read', arguments: '{}' }])
    session.append('tool/call', { turn: 1, step: 1, callId: id, name: 'read', arguments: '{}' })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: id, isError: false, content: [{ type: 'text', text: 'x'.repeat(200) }] }) }, { surfaceOp: 'append' })
    assistant(session, 1, [{ type: 'text', text: 'ANSWER_' + 'a'.repeat(5_000) }])
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const plan = sealCompletedTurns(session, [], policy({ entryMaxChars: 3_000 }))
    expect(plan.appends).toHaveLength(1)
    const text = plan.appends[0]!.message.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(Array.from(text).length).toBeLessThanOrEqual(3_000)
    expect(text).not.toContain('[tool turn')
    expect(text).toContain('…[+')
    expect(text).toContain('[turn 1]')
    expect(text).not.toContain('REQUIREMENTS_STAY_RAW')
    expect(surfaceText(session)).toContain('REQUIREMENTS_STAY_RAW')
  })

  it('never nests or re-renders an entry: a legacy tape keeps its bytes and the seal lands after it', () => {
    const session = Session.create(SessionId('context-nesting'))
    const first = completedTurn(session, 1, 'FIRST_QUESTION', 'FIRST_ANSWER')
    const legacy = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '# SESSION TAPE (sealed conversational history; not current-world truth)\nLEGACY_BODY' }],
      source: { kind: HISTORY_SOURCE },
    }), { surfaceOp: { op: 'replace', startSeq: first.response.seq, endSeq: first.response.seq }, sourceEventSeqs: [first.response.seq] })
    completedTurn(session, 2, 'SECOND_QUESTION', 'SECOND_ANSWER')
    completedTurn(session, 3, 'THIRD_QUESTION', 'THIRD_ANSWER')
    sealCompletedTurns(session, [], policy())
    const [legacyEntry, one, two] = frozen(session)
    // The legacy entry is an entry: it is neither thawed into the new one nor re-rendered, so it keeps its bytes.
    expect(session.surface.nodes).toContain(legacy.seq)
    expect(legacyEntry).toEqual({ seq: legacy.seq, text: textOfEvent(legacy) })
    expect(one!.text).toContain(`${TAPE_PREFIX}2-2 · 1 turn(s) sealed`)
    expect(two!.text).toContain(`${TAPE_PREFIX}3-3 · 1 turn(s) sealed`)
    expect(entries(session)[1]!.sourceEventSeqs).not.toContain(legacy.seq)
    const oneText = surfaceText(session)
    expect(oneText).toContain('LEGACY_BODY')
    expect(oneText).not.toContain('[earlier checkpoint covered')
    expect(oneText).not.toContain('FIRST_ANSWER')
    expect(oneText).toContain('SECOND_QUESTION')

    completedTurn(session, 4, 'FOURTH_QUESTION', 'FOURTH_ANSWER')
    const view = session.deriveMessages()
    sealCompletedTurns(session, [], policy())
    const after = frozen(session)
    expect(after.slice(0, 3)).toEqual([legacyEntry, one, two])
    expect(after).toHaveLength(4)
    expect(after[3]!.text).toContain(`${TAPE_PREFIX}4-4 · 1 turn(s) sealed`)
    // Every older user node and entry, plus turn 4's user input, remains byte-identical.
    expect(firstDivergence(view, session.deriveMessages())).toBe(7)
    const twoText = surfaceText(session)
    // Turn 2 and 3 user nodes and entries are written once and never repeated.
    expect(twoText.split('SECOND_QUESTION')).toHaveLength(2)
    expect(twoText.split('THIRD_QUESTION')).toHaveLength(2)
    expect(twoText).toContain('FOURTH_QUESTION')
  })
})

describe('recall source attribution', () => {
  it('keeps generated context out of the user request but still serves it from both recall tools', () => {
    const session = Session.create(SessionId('recall-authority'))
    session.append('turn/start', { turn: 1 })
    user(session, 'REAL_USER_SENTINEL')
    user(session, 'PLUGIN_INPUT_SENTINEL', 'plugin:runtime-fixture')
    assistant(session, 1, [{ type: 'text', text: 'REAL_ASSISTANT_SENTINEL' }])
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    user(session, 'SECOND_REAL_USER')
    assistant(session, 2, [{ type: 'text', text: 'SECOND_REAL_ASSISTANT' }])
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 3 })
    sealCompletedTurns(session, [], policy())
    expect(entries(session)).toHaveLength(2)
    const first = renderSealedTurn(session.snapshotEvents(), 1)!
    const second = renderSealedTurn(session.snapshotEvents(), 2)!
    // Attribution is unchanged: generated context is not a user request.
    expect(first.userMessages).toBe(1)
    expect(first.contextMessages).toBe(1)
    const request = first.rendered.slice(first.rendered.indexOf('## User request'), first.rendered.indexOf('## Assistant response'))
    expect(request).toContain('REAL_USER_SENTINEL')
    expect(request).not.toContain('PLUGIN_INPUT_SENTINEL')
    // Reachability, however, is required: entries omit superseded runtime snapshots and name
    // these tools as the locator, so both must serve plugin-produced context.
    expect(first.rendered).toContain('## Generated context recorded during this turn (verbatim)')
    expect(first.rendered).toContain('PLUGIN_INPUT_SENTINEL')
    const context = searchSessionEvents(session.snapshotEvents(), 'PLUGIN_INPUT_SENTINEL')
    expect(context).toHaveLength(1)
    expect(context[0]).toMatchObject({ turn: 1, kind: 'context' })
    expect(second.userMessages).toBe(1)
    expect(second.contextMessages).toBe(0)
    expect(second.rendered).not.toContain('REAL_USER_SENTINEL')
    expect(second.rendered).not.toContain(TAPE_PREFIX)
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
    const content = [{ type: 'text' as const, text: 'GENERATED_RESULT_SENTINEL' }]
    session.append('tool/result', { ...original.data, message: { ...original.data.message, content } }, {
      surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq],
    })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(searchSessionEvents(session.snapshotEvents(), 'GENERATED_RESULT_SENTINEL', { kinds: ['tool_output'] })).toEqual([])
    expect(searchSessionEvents(session.snapshotEvents(), 'ORIGINAL_RESULT_SENTINEL', { kinds: ['tool_output'] })).toHaveLength(1)
    expect(renderSealedTurn(session.snapshotEvents(), 1, { view: 'full' })?.rendered).toContain('ORIGINAL_RESULT_SENTINEL')
    expect(renderSealedTurn(session.snapshotEvents(), 1, { view: 'full' })?.rendered).not.toContain('GENERATED_RESULT_SENTINEL')
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
