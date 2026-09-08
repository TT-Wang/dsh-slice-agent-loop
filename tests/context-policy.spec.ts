import { describe, expect, it } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { compactHistory, HISTORY_SOURCE, SliceBudgetError } from '../src/context.js'
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

function surfaceText(session: Session): string {
  return session.deriveMessages().flatMap(message => message.content.map(block => block.type === 'text' ? block.text : '')).join('\n')
}

function summaries(session: Session): SessionEvent<'user/message'>[] {
  return session.surface.nodes.flatMap(seq => {
    const event = session.eventAt(seq)
    return event?.type === 'user/message' && event.data.source.kind === 'plugin'
      && event.data.source.plugin === HISTORY_SOURCE ? [event] : []
  })
}

describe('durable conversational context policy', () => {
  it('bounds ten 60,000-character user entries while retaining exact original recall pages', () => {
    const session = Session.create(SessionId('context-large-history'))
    const original: string[] = []
    for (let turn = 1; turn <= 10; turn += 1) {
      const question = `ORIGINAL_TURN_${turn}_` + 'x'.repeat(60_000)
      original.push(question)
      completedTurn(session, turn, question, `ANSWER_${turn}`)
    }
    const before = structuredClone(session.snapshotEvents())
    compactHistory(session, 120_000)
    const text = surfaceText(session)
    expect(Array.from(text).length).toBeLessThanOrEqual(120_000)
    expect(summaries(session)).toHaveLength(1)
    expect(text).toContain('ORIGINAL_TURN_10_')
    expect(text).not.toContain('ORIGINAL_TURN_1_')
    expect(text).toContain('recall_turn({"turn":"1"})')
    expect(session.snapshotEvents().slice(0, before.length)).toEqual(before)
    original.forEach((question, index) => expect(renderSealedTurn(session.snapshotEvents(), index + 1)?.rendered).toContain(question))
  })

  it('resummarizes six turns from original sources once and is idempotent between turns', () => {
    const session = Session.create(SessionId('context-repeat-history'))
    for (let turn = 1; turn <= 6; turn += 1) {
      completedTurn(session, turn, `QUESTION_${turn}`, `ANSWER_${turn}`)
      compactHistory(session, 20_000)
      const snapshot = structuredClone(session.snapshotEvents())
      const surface = [...session.surface.nodes]
      for (let repeat = 0; repeat < 3; repeat += 1) compactHistory(session, 20_000)
      expect(session.snapshotEvents()).toEqual(snapshot)
      expect(session.surface.nodes).toEqual(surface)
      expect(summaries(session)).toHaveLength(1)
      for (let old = 1; old <= turn; old += 1) {
        expect(surfaceText(session).split(`QUESTION_${old}`)).toHaveLength(2)
        expect(surfaceText(session).split(`ANSWER_${old}`)).toHaveLength(2)
      }
    }
    expect(surfaceText(session).split('# SESSION TAPE')).toHaveLength(2)
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
    compactHistory(session, 2_000)
    expect(session.surface.nodes).toContain(canonical.seq)
    expect(surfaceText(session)).toContain('CANONICAL_FOREIGN_CONTEXT')
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
    expect(renderSealedTurn(session.snapshotEvents(), 1)?.rendered).not.toContain(text)
    compactHistory(session, 1_000)
    expect(session.surface.nodes).toContain(canonical.seq)
    expect(surfaceText(session)).toContain(text)
    expect(surfaceText(session)).not.toContain('ORIGINAL_RAW_QUESTION')
  })

  it('compacts closed calls with their results and leaves no unmatched tool blocks on the request surface', () => {
    const session = Session.create(SessionId('context-closed-tools'))
    const id = ToolCallId('closed-read')
    session.append('turn/start', { turn: 1 })
    user(session, 'read a file')
    assistant(session, 1, [{ type: 'tool-call', id, name: 'read', arguments: '{}' }])
    session.append('tool/call', { turn: 1, step: 1, callId: id, name: 'read', arguments: '{}' })
    session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: id, isError: false, content: [{ type: 'text', text: 'DURABLE_FILE_BYTES' }] }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    compactHistory(session, 2_000)
    expect(summaries(session)).toHaveLength(1)
    expect(session.deriveMessages().flatMap(message => message.content).some(block => block.type === 'tool-call' || block.type === 'tool-result')).toBe(false)
    expect(renderSealedTurn(session.snapshotEvents(), 1)?.rendered).toContain('DURABLE_FILE_BYTES')
  })

  it('does not split a tool call from its result across a protected plugin context boundary', () => {
    const session = Session.create(SessionId('context-protected-tool-span'))
    const id = ToolCallId('protected-read')
    session.append('turn/start', { turn: 1 })
    user(session, 'read a file')
    assistant(session, 1, [{ type: 'tool-call', id, name: 'read', arguments: '{}' }])
    user(session, 'PROTECTED_CONTEXT', 'runtime-fixture')
    session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: id, isError: false, content: [{ type: 'text', text: 'UNCHANGED_RESULT' }] }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const before = [...session.surface.nodes]
    compactHistory(session, 1_000)
    expect(session.surface.nodes).toEqual(before)
    const blocks = session.deriveMessages().flatMap(message => message.content)
    expect(blocks.filter(block => block.type === 'tool-call')).toHaveLength(1)
    expect(blocks.filter(block => block.type === 'tool-result')).toHaveLength(1)
  })

  it('does not partially replace history when a marker cannot fit', () => {
    const session = Session.create(SessionId('context-atomic-admission'))
    completedTurn(session, 1, 'a'.repeat(500), 'first answer')
    user(session, 'protected middle', 'runtime-fixture')
    completedTurn(session, 2, 'b'.repeat(500), 'second answer')
    const before = structuredClone(session.snapshotEvents())
    const surface = [...session.surface.nodes]
    expect(() => compactHistory(session, 150)).toThrow(SliceBudgetError)
    expect(session.snapshotEvents()).toEqual(before)
    expect(session.surface.nodes).toEqual(surface)
  })
})

describe('recall source attribution', () => {
  it('excludes plugin and generated context from user recall and search without duplicating originals', () => {
    const session = Session.create(SessionId('recall-authority'))
    session.append('turn/start', { turn: 1 })
    user(session, 'REAL_USER_SENTINEL')
    user(session, 'PLUGIN_INPUT_SENTINEL', 'runtime-fixture')
    assistant(session, 1, [{ type: 'text', text: 'REAL_ASSISTANT_SENTINEL' }])
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    compactHistory(session, 2_000)
    user(session, 'SECOND_REAL_USER')
    assistant(session, 2, [{ type: 'text', text: 'SECOND_REAL_ASSISTANT' }])
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const first = renderSealedTurn(session.snapshotEvents(), 1)!
    const second = renderSealedTurn(session.snapshotEvents(), 2)!
    expect(first.userMessages).toBe(1)
    expect(first.rendered).toContain('REAL_USER_SENTINEL')
    expect(first.rendered).not.toContain('PLUGIN_INPUT_SENTINEL')
    expect(second.userMessages).toBe(1)
    expect(second.rendered).not.toContain('REAL_USER_SENTINEL')
    expect(second.rendered).not.toContain('# SESSION TAPE')
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
