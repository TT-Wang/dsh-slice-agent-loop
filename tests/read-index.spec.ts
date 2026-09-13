import { describe, expect, it } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TAPE_PREFIX, sealCompletedTurns, type HistoryPolicy } from '../src/context.js'

type S = Session

function user(session: S, text: string) {
  return session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

function assistant(session: S, turn: number, step: number, content: ContentBlock[]) {
  return session.append('assistant/message', { turn, step, stream: [],
    message: createMessage({ role: 'assistant', content, source: { kind: 'model', provider: 'mock', model: 'mock' } }) }, { surfaceOp: 'append' })
}

/** Default tape policy: every completed turn seals, with a budget no fixture here reaches. */
function policy(over: Partial<HistoryPolicy> = {}): HistoryPolicy {
  return { keepRecentTurns: 0, pinFirstTurn: false, pinUserChars: 1_200, entryMaxChars: 8_000, ...over }
}

function surfaceText(session: S): string {
  return session.deriveMessages().flatMap(message => message.content.map(block => block.type === 'text' ? block.text : '')).join('\n')
}

/** One completed turn whose only tool work is a read-style call per entry of `targets`. */
function readTurn(session: S, turn: number, targets: readonly string[]) {
  session.append('turn/start', { turn })
  user(session, `TURN_${turn}_QUESTION`)
  targets.forEach((target, index) => {
    const id = ToolCallId(`read-${turn}-${index}`)
    const step = index + 1
    const argumentsJson = JSON.stringify({ path: target })
    assistant(session, turn, step, [{ type: 'tool-call', id, name: 'read', arguments: argumentsJson }])
    session.append('tool/call', { turn, step, callId: id, name: 'read', arguments: argumentsJson })
    session.append('tool/result', { turn, step, message: createToolResultMessage({ callId: id, isError: false, content: [{ type: 'text', text: `BODY_${turn}_${index}` }] }) }, { surfaceOp: 'append' })
  })
  assistant(session, turn, targets.length + 1, [{ type: 'text', text: `ANSWER_${turn}` }])
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function sealedText(session: S): string {
  const plan = sealCompletedTurns(session, [], policy())
  expect(plan.appends.length).toBeGreaterThan(0)
  return surfaceText(session)
}

describe('per-turn read index inside a sealed tape entry', () => {
  it('names every file a sealed turn read, with the step that read it', () => {
    const session = Session.create(SessionId('read-index-basic'))
    readTurn(session, 1, ['src/alpha.ts'])
    readTurn(session, 2, ['src/beta.ts'])
    readTurn(session, 3, ['src/gamma.ts']) // gives turn 2 its sealing opportunity
    const text = sealedText(session)
    expect(text).toContain(TAPE_PREFIX)
    // Turn 1 is sealed inside turn 2's entry... each sealed turn names its own read with a fingerprint.
    expect(text).toMatch(/\[files read this turn: src\/alpha\.ts \(\d+ lines, [0-9a-f]{8}, step 1\)\]/u)
    expect(text).toMatch(/\[files read this turn: src\/beta\.ts \(\d+ lines, [0-9a-f]{8}, step 1\)\]/u)
  })

  it('keeps one entry per file, cites the first step, and is absent when a turn read nothing', () => {
    const session = Session.create(SessionId('read-index-dedupe'))
    readTurn(session, 1, ['src/dup.ts', 'src/dup.ts', 'src/other.ts'])
    readTurn(session, 2, []) // a turn with no read at all
    readTurn(session, 3, ['src/last.ts'])
    const text = sealedText(session)
    expect(text).toMatch(/\[files read this turn: src\/dup\.ts \(\d+ lines, [0-9a-f]{8}, step 1\), src\/other\.ts \(\d+ lines, [0-9a-f]{8}, step 3\)\]/u)
    expect((text.match(/src\/dup\.ts \(/g) ?? [])).toHaveLength(1)
    expect(text).not.toContain('[files read this turn:]')
  })

  it('caps a long read list and says how many were left out', () => {
    const session = Session.create(SessionId('read-index-cap'))
    const many = Array.from({ length: 13 }, (_, index) => `src/f${index}.ts`)
    readTurn(session, 1, many)
    readTurn(session, 2, ['src/after.ts'])
    const text = sealedText(session)
    expect(text).toContain('src/f0.ts (')
    expect(text).toContain('src/f9.ts (')
    expect(text).not.toContain('src/f10.ts')
    expect(text).toContain('+3 more]')
  })
})
