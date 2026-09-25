import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { sealCompletedTurns } from '../src/context.js'
import { nativeHarness, nativeSend, nativeText, nativeTool, type NativeHarness } from './native-harness.js'
import { FixtureCodeRuntime } from './fixture-code-runtime.js'
import { toolResult } from './v4-fixtures.js'

const live: NativeHarness[] = []
afterEach(async () => { for (const harness of live.splice(0).reverse()) await harness.ctx.fiber.dispose() })
const policy = { keepRecentTurns: 0 }
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 8)

function assistant(session: Session, turn: number, step: number, content: ContentBlock[]) {
  session.append('assistant/message', { turn, step, stream: [], message: createMessage({ role: 'assistant', content, source: { kind: 'model', provider: 'mock', model: 'mock' } }) }, { surfaceOp: 'append' })
}
function start(session: Session, turn: number) {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `QUESTION_${turn}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}
function read(session: Session, turn: number, step: number, path: string, text: string, isError = false, window: object = {}) {
  const callId = ToolCallId(`read-${turn}-${step}`)
  const args = JSON.stringify({ file_path: path, ...window })
  assistant(session, turn, step, [{ type: 'tool-call', id: callId, name: 'read', arguments: args }])
  session.append('tool/call', { turn, step, callId, name: 'read', arguments: args })
  return session.append('tool/result', { turn, step, message: createToolResultMessage({ callId, isError, content: [{ type: 'text', text }] }) }, { surfaceOp: 'append' })
}
function finish(session: Session, turn: number) {
  assistant(session, turn, 99, [{ type: 'text', text: 'done' }])
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  sealCompletedTurns(session, [], policy)
}
function index(session: Session): string[] {
  return session.deriveMessages().flatMap(message => message.content.flatMap(block => block.type === 'text' ? block.text.split('\n') : [])).filter(line => line.startsWith('[files read this turn:'))
}

describe('successful read provenance in tape entries', () => {
  it('excludes errors and keeps a successful retry even when a later retry fails', () => {
    const session = Session.create(SessionId('read-errors'))
    start(session, 1)
    read(session, 1, 1, 'a.ts', 'ENOENT', true)
    finish(session, 1)
    expect(index(session)).toEqual([])
    start(session, 2)
    read(session, 2, 1, 'a.ts', 'ENOENT', true)
    const success = read(session, 2, 2, 'a.ts', 'FILE_BODY')
    read(session, 2, 3, 'a.ts', 'EACCES', true)
    finish(session, 2)
    const lines = index(session)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`${digest('FILE_BODY')}, step 2, seq ${success.seq} block 1`)
    expect(lines[0]).not.toContain(digest('ENOENT'))
    expect(lines[0]).not.toContain(digest('EACCES'))
    expect(lines[0]).not.toMatch(/[=≠] turn/)
  })

  it('compares the same latest successful read that the previous entry displayed', () => {
    const session = Session.create(SessionId('read-first-last'))
    start(session, 1)
    read(session, 1, 1, 'a.ts', 'OLD')
    const latest = read(session, 1, 2, 'a.ts', 'NEW')
    finish(session, 1)
    const firstEntry = index(session)[0]!
    expect(firstEntry).toContain(`${digest('NEW')}, step 2, seq ${latest.seq} block 1`)
    expect(firstEntry).not.toContain(digest('OLD'))
    start(session, 2)
    read(session, 2, 1, 'a.ts', 'OLD')
    finish(session, 2)
    expect(index(session)[0]).toBe(firstEntry)
    expect(index(session)[1]).toContain(`${digest('OLD')}, step 1`)
    expect(index(session)[1]).toContain(`≠ turn 1 step 2, seq ${latest.seq} block 1`)
  })

  it('keeps different requested windows distinct and compares only the same window', () => {
    const session = Session.create(SessionId('read-windows'))
    start(session, 1)
    const first = read(session, 1, 1, 'a.ts', 'FIRST', false, { offset: 1, limit: 10 })
    const second = read(session, 1, 2, 'a.ts', 'SECOND', false, { offset: 11, limit: 10 })
    finish(session, 1)
    expect(index(session)[0]).toContain(`seq ${first.seq} block 1, read window {"limit":10,"offset":1}`)
    expect(index(session)[0]).toContain(`seq ${second.seq} block 1, read window {"limit":10,"offset":11}`)
    start(session, 2)
    read(session, 2, 1, 'a.ts', 'FIRST', false, { limit: 10, offset: 1 })
    read(session, 2, 2, 'a.ts', 'THIRD', false, { offset: 21, limit: 10 })
    finish(session, 2)
    expect(index(session)[1]).toContain(`= turn 1 step 1, seq ${first.seq} block 1`)
    expect(index(session)[1]).not.toContain(`turn 1 step 2`)
    expect(index(session)[1]).not.toContain('≠ turn')
  })

  it('fingerprints an original result block without unrelated sibling bytes', () => {
    const session = Session.create(SessionId('read-siblings'))
    start(session, 1)
    const a = ToolCallId('read-a')
    const b = ToolCallId('read-b')
    assistant(session, 1, 1, [a, b].map((id, i) => ({ type: 'tool-call', id, name: 'read', arguments: JSON.stringify({ file_path: `${i}.ts` }) })))
    // Session format V4: sibling results of one step are separate tool-role result events.
    const results = ([[a, 'A_BODY'], [b, 'B_BODY']] as const).map(([callId, text]) =>
      session.append('tool/result', { turn: 1, step: 1, message: toolResult(callId, text) }, { surfaceOp: 'append' }))
    finish(session, 1)
    expect(index(session)[0]).toContain(`0.ts (1 lines, ${digest('A_BODY')}, step 1, seq ${results[0]!.seq} block 1`)
    expect(index(session)[0]).toContain(`1.ts (1 lines, ${digest('B_BODY')}, step 1, seq ${results[1]!.seq} block 1`)
    expect(index(session)[0]).not.toContain(digest('A_BODYB_BODY'))
  })

  it('indexes native code-dispatch reads without claiming their bytes reached the model', async () => {
    const body = 'INNER_READ_ONLY_7231'
    let returnedBody = body
    class FixtureRuntime extends FixtureCodeRuntime {
      readonly language = 'typescript'
      readonly isolation = 'deterministic fixture'
      async run(request: Parameters<FixtureCodeRuntime['run']>[0]) {
        const sdk = request.bindings!.find(binding => binding.global === 'tools')!.functions
        await sdk.read!({ file_path: 'nested.ts', offset: 3, limit: 2 })
        return { value: 'PROCESSED_WITHOUT_FORWARDING_BODY', logs: [] }
      }
    }
    const code = () => nativeTool('outer', 'run_code', { code: 'fixture read without forwarding', description: 'Read privately' })
    const h = await nativeHarness([code(), nativeText('done'), code(), nativeText('done again'), nativeText('next')], { config: { history: { keepRecentTurns: 1 } } })
    live.push(h)
    await h.ctx.plugin(FixtureRuntime)
    h.ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'Read fixture', parameters: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, execute: async () => [{ type: 'text', text: returnedBody }] }))
    const { agent } = await h.ctx.agents.create({ sessionId: SessionId('native-code-read-index'), agentOptions: { provider: 'native-mock', model: 'deterministic' } })
    agent.ctx.tools.presentAs('both')
    await nativeSend(agent, 'Read once')
    expect(JSON.stringify(h.adapter.requests[1]!.messages)).not.toContain(body)
    const dispatched = agent.session.snapshotEvents().find(event => event.type === 'tool/ptc-dispatch')!
    expect(dispatched.type).toBe('tool/ptc-dispatch')
    // Reusing a model call id in a later turn cannot attach that later read to
    // the earlier turn, which is still raw until the keep window advances.
    returnedBody = 'LATER_INNER_READ'
    await nativeSend(agent, 'Read again')
    await nativeSend(agent, 'Continue')
    expect(h.errors).toEqual([])
    expect(index(agent.session)[0]).toContain(`${digest(body)}, step 1, dispatch seq ${dispatched.seq}`)
    expect(index(agent.session)[0]).toContain('read window {"limit":2,"offset":3}')
    expect(index(agent.session)[0]).toContain('code log; model visibility not implied; recall_turn({"turn":"1","view":"full"})')
    expect(index(agent.session)[0]).not.toContain(digest(returnedBody))
    expect(JSON.stringify(h.adapter.requests.at(-1)!.messages)).not.toContain(body)
  })
})
