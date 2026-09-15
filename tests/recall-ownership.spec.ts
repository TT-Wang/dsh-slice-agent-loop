import { describe, expect, it } from 'vitest'
import { createMessage, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { sealCompletedTurns, type HistoryPolicy } from '../src/context.js'
import { renderSealedTurn, searchSessionEvents } from '../src/recall.js'

const policy: HistoryPolicy = {
  keepRecentTurns: 0, pinFirstTurn: false, pinUserChars: 1_200, entryMaxChars: 8_000,
}

function user(session: Session, text: string) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function assistant(session: Session, turn: number, content: ContentBlock[]) {
  return session.append('assistant/message', {
    turn, step: 1, stream: [],
    message: createMessage({ role: 'assistant', content, source: { kind: 'model', provider: 'mock', model: 'mock' } }),
  }, { surfaceOp: 'append' })
}

function complete(session: Session, turn: number) {
  session.append('turn/start', { turn })
  user(session, `Question ${turn}`)
  assistant(session, turn, [{ type: 'text', text: `Answer ${turn}` }])
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function originalRecords(session: Session, turn: number): unknown[] {
  const page = renderSealedTurn(session.snapshotEvents(), turn)!.rendered
  return JSON.parse(page.split('## Original records (including reasoning, tool output and recorded file metadata)\n')[1]!) as unknown[]
}

describe('shared surface and recall turn ownership', () => {
  it('keeps an archived between-turn human message on the exact page named by search', () => {
    const session = Session.create(SessionId('recall-between-turn-user'))
    complete(session, 1)
    const exact = '  BETWEEN_TURN_SENTINEL\n保留 Unicode 和空白\t\n'
    const between = user(session, exact)
    complete(session, 2)

    const plan = sealCompletedTurns(session, [], policy)
    expect(plan.appends.flatMap(append => append.sources)).toContain(between.seq)
    expect(session.surface.nodes).not.toContain(between.seq)
    expect(session.eventAt(between.seq)).toEqual(between)

    for (const view of ['dialogue', 'full'] as const) {
      const page = renderSealedTurn(session.snapshotEvents(), 1, { view })!
      expect(page.userMessages).toBe(2)
      expect(page.rendered).toContain(exact)
      expect(renderSealedTurn(session.snapshotEvents(), 2, { view })!.rendered).not.toContain(exact)
    }
    expect(originalRecords(session, 1)).toContainEqual({ type: between.type, data: between.data })
    const hits = searchSessionEvents(session.snapshotEvents(), 'BETWEEN_TURN_SENTINEL')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ turn: 1, kind: 'user', locator: 'recall_turn({"turn":"1","view":"dialogue"})' })
  })

  it('never archives human input before the first turn into a nonexistent recall page', () => {
    const session = Session.create(SessionId('recall-before-first-user'))
    const orphan = user(session, 'PRE_FIRST_TURN_SENTINEL')
    complete(session, 1)
    complete(session, 2)
    const plan = sealCompletedTurns(session, [], policy)
    expect(session.surface.nodes).toContain(orphan.seq)
    expect(plan.appends.flatMap(append => append.sources)).not.toContain(orphan.seq)
    expect(session.deriveMessages().some(message => message.content.some(block => block.type === 'text' && block.text === 'PRE_FIRST_TURN_SENTINEL'))).toBe(true)
    expect(searchSessionEvents(session.snapshotEvents(), 'PRE_FIRST_TURN_SENTINEL')).toEqual([])
    expect(renderSealedTurn(session.snapshotEvents(), 1)!.rendered).not.toContain('PRE_FIRST_TURN_SENTINEL')
  })

  it('assigns mid-turn steering to the open turn rather than the preceding ended turn', () => {
    const session = Session.create(SessionId('recall-open-turn-user'))
    complete(session, 1)
    session.append('turn/start', { turn: 2 })
    user(session, 'SECOND_TURN_STEERING_SENTINEL')
    assistant(session, 2, [{ type: 'text', text: 'understood' }])
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    sealCompletedTurns(session, [], policy)
    expect(searchSessionEvents(session.snapshotEvents(), 'SECOND_TURN_STEERING_SENTINEL').map(hit => hit.turn)).toEqual([2])
    expect(renderSealedTurn(session.snapshotEvents(), 1)!.rendered).not.toContain('SECOND_TURN_STEERING_SENTINEL')
    expect(renderSealedTurn(session.snapshotEvents(), 2)!.rendered).toContain('SECOND_TURN_STEERING_SENTINEL')
  })
})

describe('empty and whitespace dialogue records', () => {
  it('counts an empty user message and explicitly records an assistant step without text', () => {
    const session = Session.create(SessionId('recall-empty-dialogue'))
    session.append('turn/start', { turn: 1 })
    const request = user(session, '')
    const response = assistant(session, 1, [])
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    sealCompletedTurns(session, [], policy)
    const page = renderSealedTurn(session.snapshotEvents(), 1, { view: 'dialogue' })!
    expect(page.userMessages).toBe(1)
    expect(page.assistantSteps).toBe(0)
    expect(page.rendered).toContain('(no user text recorded in this message)')
    expect(page.rendered).toContain('[step 1]\n(no assistant text recorded for this step)')
    expect(originalRecords(session, 1)).toEqual([
      { type: request.type, data: request.data }, { type: response.type, data: response.data },
    ])
  })

  it('preserves whitespace-only text instead of silently dropping the recorded message', () => {
    const session = Session.create(SessionId('recall-whitespace-dialogue'))
    session.append('turn/start', { turn: 1 })
    const request = user(session, ' \t\n ')
    const response = assistant(session, 1, [{ type: 'text', text: '\t  \n\t' }])
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const page = renderSealedTurn(session.snapshotEvents(), 1, { view: 'dialogue' })!
    expect(page.userMessages).toBe(1)
    expect(page.assistantSteps).toBe(1)
    expect(page.rendered).toContain('## User request (verbatim)\n \t\n ')
    expect(page.rendered).toContain('[step 1]\n\t  \n\t')
    expect(originalRecords(session, 1)).toEqual([
      { type: request.type, data: request.data }, { type: response.type, data: response.data },
    ])
  })
})
