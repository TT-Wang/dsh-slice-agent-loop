import { createHash } from 'node:crypto'
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

function policy(over: Partial<HistoryPolicy> = {}): HistoryPolicy {
  return { keepRecentTurns: 0, pinFirstTurn: false, pinUserChars: 1_200, entryMaxChars: 8_000, ...over }
}

function surfaceText(session: S): string {
  return session.deriveMessages().flatMap(message => message.content.map(block => block.type === 'text' ? block.text : '')).join('\n')
}

/**
 * One completed turn whose read calls return `bodies[path]`. A path may be read twice in the same
 * turn to exercise de-duplication; `bodies` is re-read per call, so a caller can change a body
 * between turns to model an edit on disk.
 */
function readTurn(session: S, turn: number, paths: readonly string[], bodies: Record<string, string>) {
  session.append('turn/start', { turn })
  user(session, `TURN_${turn}_QUESTION`)
  paths.forEach((path, index) => {
    const id = ToolCallId(`read-${turn}-${index}`)
    const step = index + 1
    const argumentsJson = JSON.stringify({ path })
    assistant(session, turn, step, [{ type: 'tool-call', id, name: 'read', arguments: argumentsJson }])
    session.append('tool/call', { turn, step, callId: id, name: 'read', arguments: argumentsJson })
    session.append('tool/result', { turn, step, message: createToolResultMessage({ callId: id, isError: false, content: [{ type: 'text', text: bodies[path] ?? '' }] }) }, { surfaceOp: 'append' })
  })
  assistant(session, turn, paths.length + 1, [{ type: 'text', text: `ANSWER_${turn}` }])
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function sealedText(session: S): string {
  const plan = sealCompletedTurns(session, [], policy())
  expect(plan.appends.length).toBeGreaterThan(0)
  return surfaceText(session)
}

const BODY = 'line one\nline two\nline three'
const DIGEST = createHash('sha256').update(BODY, 'utf8').digest('hex').slice(0, 8)

describe('read fingerprints inside a sealed tape entry', () => {
  it('carries the line count and a digest of the bytes the read returned', () => {
    const session = Session.create(SessionId('read-digest-basic'))
    readTurn(session, 1, ['src/alpha.ts'], { 'src/alpha.ts': BODY })
    readTurn(session, 2, ['src/beta.ts'], { 'src/beta.ts': 'other' })
    readTurn(session, 3, ['src/gamma.ts'], { 'src/gamma.ts': 'third' })
    const text = sealedText(session)
    expect(text).toContain(TAPE_PREFIX)
    expect(text).toContain(`[files read this turn: src/alpha.ts (3 lines, ${DIGEST}, step 1, seq `)
    expect(text).not.toContain('= turn')
  })

  it('marks an unchanged re-read with the earlier turn, and a changed one with ≠', () => {
    const session = Session.create(SessionId('read-digest-change'))
    readTurn(session, 1, ['src/same.ts'], { 'src/same.ts': BODY })
    readTurn(session, 2, ['src/same.ts'], { 'src/same.ts': BODY })
    readTurn(session, 3, ['src/same.ts'], { 'src/same.ts': `${BODY}\nline four` })
    readTurn(session, 4, ['src/other.ts'], { 'src/other.ts': 'x' })
    const text = sealedText(session)
    expect(text).toContain(`, ${DIGEST}, step 1, seq `)
    expect(text).toContain('= turn 1 step 1, seq ')
    expect(text).toContain('≠ turn 2 step 1, seq ')
    expect(text).toContain('4 lines')
  })

  it('keeps the latest successful fingerprint per file window, and is absent when a turn read nothing', () => {
    const session = Session.create(SessionId('read-digest-dedupe'))
    readTurn(session, 1, ['src/dup.ts', 'src/dup.ts', 'src/other.ts'], { 'src/dup.ts': BODY, 'src/other.ts': 'y' })
    readTurn(session, 2, [], {})
    readTurn(session, 3, ['src/last.ts'], { 'src/last.ts': 'z' })
    const text = sealedText(session)
    expect((text.match(/src\/dup\.ts \(3 lines/g) ?? [])).toHaveLength(1)
    expect(text).toContain('src/other.ts (1 lines')
    // Turn 2 read nothing, so only turns 1 and 3 carry an index line.
    expect((text.match(/\[files read this turn:/g) ?? [])).toHaveLength(2)
  })

  it('caps a long read list and says how many were left out', () => {
    const session = Session.create(SessionId('read-digest-cap'))
    const many = Array.from({ length: 13 }, (_, index) => `src/f${index}.ts`)
    const bodies = Object.fromEntries(many.map(path => [path, `body ${path}`]))
    readTurn(session, 1, many, bodies)
    readTurn(session, 2, ['src/after.ts'], { 'src/after.ts': 'after' })
    const text = sealedText(session)
    expect(text).toContain('src/f0.ts (')
    expect(text).toContain('src/f9.ts (')
    expect(text).not.toContain('src/f10.ts')
    expect(text).toContain('+3 more]')
  })
})
