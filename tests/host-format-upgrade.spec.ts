/**
 * Real published JSONL migration into session format V4; frozen tape bytes are never rewritten.
 *
 * Three provider-written fixtures are restored through the current host catalog:
 * alpha.2 (format 2, see fixtures/slice-alpha2-session.md) and two 0.1.5 slice
 * sessions (format 3, see fixtures/slice-v3-session.md, and
 * fixtures/slice-v3-tools-session.md for parallel, error, PTC-nested and folded
 * results). Restoration renames
 * message sources (slice's `{ kind: 'plugin', plugin: 'slice:history' }` becomes
 * `plugin:slice:history`, the system-prompt plugin's user-role snapshot becomes
 * `runtime-context`) and lifts tool results into tool-role messages; message
 * text, including every old `formatVersion` locator inside a tape entry, stays
 * byte for byte.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { HISTORY_SOURCE, RUNTIME_CONTEXT_SOURCE, sealCompletedTurns, TAPE_PREFIX } from '../src/context.js'
import { EXPAND_TOOL_NAME, expandResultToolDefinition, FOLD_STATS, fullResultAt, resultBySeq } from '../src/fold/index.js'
import { recallToolDefinition, renderSealedTurn, searchSessionEvents } from '../src/recall.js'
import { recallStepToolDefinition } from '../src/recall-step.js'
import { nativeHarness, nativeSend, nativeText, nativeTool, type NativeHarness } from './native-harness.js'
import './v4-fixtures.js'

const contexts: Context[] = []
const harnesses: NativeHarness[] = []
const roots: string[] = []
afterEach(async () => {
  for (const harness of harnesses.splice(0).reverse()) await harness.ctx.fiber.dispose()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface Fixture { id: SessionId; file: string; version: number }
const ALPHA2: Fixture = { id: SessionId('slice-alpha2-migration'), file: 'slice-alpha2-session.v2.jsonl', version: 2 }
const V3: Fixture = { id: SessionId('slice-v3-session'), file: 'slice-v3-session.v3.jsonl', version: 3 }
const V3_TOOLS: Fixture = { id: SessionId('slice-v3-tools-session'), file: 'slice-v3-tools-session.v3.jsonl', version: 3 }

/** A raw, provider-written event line; its sources may still use the pre-V4 plugin wrapper. */
type RawEvent = SessionEvent
function oldPlugin(event: RawEvent): string | undefined {
  if (event.type !== 'user/message') return undefined
  const source = event.data.source as { kind: string; plugin?: string }
  return source.kind === 'plugin' ? source.plugin : undefined
}
/** The pre-V4 slice source, spelled as the old builds wrote it. */
function oldTape(event: RawEvent): boolean {
  return oldPlugin(event) === 'slice:history'
}
function isTape(event: SessionEvent): event is SessionEvent<'user/message'> {
  return event.type === 'user/message' && event.data.source.kind === HISTORY_SOURCE
}
function tapes(events: readonly SessionEvent[]): SessionEvent<'user/message'>[] {
  const found = events.filter(isTape)
  if (!found.length) throw new Error('fixture lost its immutable slice tape')
  return found
}
function textOf(event: { data: { content: readonly { type: string; text?: string }[] } }): string {
  return event.data.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('')
}
function alphaBody(call: number): string { return `EXACT_result-${call}_BODY="saved"\nline two\n` }
function v3Body(call: number): string { return `EXACT_v3-result-${call}_BODY="saved"\nline two\n` }

async function stage(fixture: Fixture) {
  const root = await mkdtemp(join(tmpdir(), 'slice-format-upgrade-'))
  roots.push(root)
  const sourcePath = join(root, '_no-cwd', fixture.id, `session.v${fixture.version}.jsonl`)
  const source = await readFile(new URL(`./fixtures/${fixture.file}`, import.meta.url), 'utf8')
  await mkdir(dirname(sourcePath), { recursive: true })
  await writeFile(sourcePath, source)
  const original = source.trimEnd().split('\n').slice(1).map(line => JSON.parse(line)) as RawEvent[]
  return { root, sourcePath, source, original }
}

async function boot(fixture: Fixture) {
  const staged = await stage(fixture)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlPersistence, { root: staged.root, compression: 'none' })
  const reader = await ctx.sessionPersistence.open(fixture.id, 'read')
  try {
    const read = await reader.read()
    const session = Session.fromRestore(fixture.id, read.events, reader.header, reader.inheritedEventCount, read.eventState)
    return { ...staged, ctx, session, events: read.events }
  } finally { await reader.close() }
}

function execute(session: Session, name: 'expand' | 'turn', args: object) {
  const definition = name === 'expand' ? expandResultToolDefinition() : recallToolDefinition()
  // The handlers read only their owning Session. Migration and restoration use
  // the actual published persistence/provider and Session implementations.
  return definition.execute(args, { agent: { session } } as ToolRunContext)
}

describe('alpha.2 JSONL restored into session format V4', () => {
  it('remaps native references while preserving original dialogue, results and frozen tape bytes', async () => {
    const { ctx, source, sourcePath, session, events, original } = await boot(ALPHA2)
    expect(session.header.version).toBe(SESSION_FORMAT_VERSION)
    expect(SESSION_FORMAT_VERSION).toBe(4)
    expect(events.filter(event => event.type === 'system/message')).toHaveLength(2)
    const [tape] = tapes(events)
    const [before] = original.filter(oldTape)
    // Only the producer name moves to its V4 kind; id, role and every text byte stay.
    expect(tape!.data.source).toEqual({ kind: HISTORY_SOURCE })
    expect({ ...tape!.data, source: null }).toEqual({ ...before!.data, source: null })
    expect(tape!.sourceEventSeqs).not.toEqual(before!.sourceEventSeqs)
    expect(tape!.surfaceOp).toMatchObject({ op: 'replace', startSeq: expect.any(Number), endSeq: expect.any(Number) })
    expect(session.surface.nodes).toContain(tape!.seq)

    const full = await execute(session, 'turn', { turn: '1', view: 'full' })
    expect(full).toContain('USER_ORIGINAL: inspect the three original results.')
    expect(full).toContain('ASSISTANT_ORIGINAL: consulted all three results.')
    const records = JSON.parse(String(full).split('## Original records (including reasoning, tool output and recorded file metadata)\n')[1]!) as SessionEvent[]
    const firstEnd = events.find(event => event.type === 'turn/end' && event.data.turn === 1)!.seq
    const relevant = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result'])
    // The full view returns the restored records themselves, not a re-rendering.
    expect(records.filter(event => relevant.has(event.type)).map(event => event.data)).toEqual(
      events.filter(event => event.seq < firstEnd && relevant.has(event.type)).map(event => event.data),
    )
    const results = records.filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
    expect(results.map(event => event.data.message.role)).toEqual(['tool', 'tool', 'tool'])
    for (let call = 1; call <= 3; call += 1) {
      expect(results[call - 1]!.data.message.content).toEqual([{ type: 'text', text: alphaBody(call) }])
      expect(fullResultAt(events, 1, 1, call)?.text).toBe(alphaBody(call))
      expect(await execute(session, 'expand', { turn: 1, step: 1, call })).toContain(alphaBody(call))
      expect(full).toContain(`EXACT_result-${call}_BODY`)
    }
    // Read preparation is side-effect free; write-open publishes an immutable
    // successor. The old artifact and its embedded seq hints remain unchanged.
    expect(await readFile(sourcePath, 'utf8')).toBe(source)
    expect(await readdir(dirname(sourcePath))).toEqual(['session.v2.jsonl'])
    const writer = await ctx.sessionPersistence.open(ALPHA2.id, 'write')
    try { expect((await writer.read()).events).toEqual(events) } finally { await writer.close() }
    expect(await readFile(sourcePath, 'utf8')).toBe(source)
    expect((await readdir(dirname(sourcePath))).filter(name => name.endsWith('.jsonl')).sort()).toEqual(['session.v2.jsonl', 'session.v4.jsonl'])
    const reopened = await ctx.sessionPersistence.open(ALPHA2.id, 'read')
    try {
      const read = await reopened.read()
      expect(read.events).toEqual(events)
      expect(textOf(tapes(read.events)[0]!)).toBe(textOf(before! as SessionEvent<'user/message'>))
    } finally { await reopened.close() }
  })

  it('rejects unqualified or old-generation seq locators instead of silently returning a different result', async () => {
    const { session, events } = await boot(ALPHA2)
    // Alpha.2 result 2 lived at seq 11. Native migration inserted two system
    // events, so the same integer now names result 1. The text is not remapped.
    expect(tapes(events)[0]!.data.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('expand_result({"seq":11})') })]))
    expect(resultBySeq(events, 11).text).toBe(alphaBody(1))
    expect(fullResultAt(events, 1, 1, 2)?.text).toBe(alphaBody(2))
    await expect(execute(session, 'expand', { seq: 11 })).rejects.toThrow(/formatVersion/)
    await expect(execute(session, 'expand', { seq: 11, formatVersion: 2 })).rejects.toThrow(/formatVersion/)
    await expect(execute(session, 'expand', { seq: 11, formatVersion: 3 })).rejects.toThrow(/formatVersion/)
    expect(await execute(session, 'expand', { seq: 13, formatVersion: SESSION_FORMAT_VERSION })).toContain(alphaBody(2))
    expect(await execute(session, 'expand', { turn: 1, step: 1, call: 2 })).toContain(alphaBody(2))
  })

  it('fresh recall and search locators identify the current generation and recover exact original bytes', async () => {
    const { session, events } = await boot(ALPHA2)
    const before = tapes(events)[0]!.data
    const dialogue = renderSealedTurn(events, 1, { view: 'dialogue' })!.rendered
    const hits = searchSessionEvents(events, 'EXACT_result-2_BODY', { kinds: ['tool_output'] })
    expect(hits).toHaveLength(1)
    const match = /^expand_result\((\{.+\})\)$/.exec(hits[0]!.locator)!
    const args = JSON.parse(match[1]!) as { seq: number; formatVersion: number }
    expect(args).toMatchObject({ seq: 13, formatVersion: SESSION_FORMAT_VERSION })
    expect(dialogue).toContain(hits[0]!.locator)
    expect(await execute(session, 'expand', args)).toContain(alphaBody(2))
    expect(tapes(session.snapshotEvents())[0]!.data).toBe(before)
  })
})

describe('0.1.5 (format 3) slice JSONL restored into session format V4', () => {
  it('renames producers and lifts tool results while every frozen entry keeps its bytes', async () => {
    const { ctx, source, sourcePath, session, events, original } = await boot(V3)
    expect(session.header.version).toBe(SESSION_FORMAT_VERSION)
    const before = original.filter(oldTape)
    const after = tapes(events)
    expect(after.map(event => event.seq)).toEqual(before.map(event => event.seq))
    after.forEach((entry, index) => {
      const old = before[index]!
      expect(entry.data.source).toEqual({ kind: HISTORY_SOURCE })
      expect({ ...entry.data, source: null }).toEqual({ ...old.data, source: null })
      expect(entry.surfaceOp).toEqual(old.surfaceOp)
      expect(entry.sourceEventSeqs).toEqual(old.sourceEventSeqs)
      expect(session.surface.nodes).toContain(entry.seq)
      // The old generation's locators stay in the frozen text; they are not relabelled.
      expect(textOf(entry)).toContain('"formatVersion":3')
      expect(textOf(entry)).not.toContain(`"formatVersion":${SESSION_FORMAT_VERSION}`)
    })
    expect(after.map(entry => textOf(entry).slice(0, TAPE_PREFIX.length + 3))).toEqual([`${TAPE_PREFIX}1-1`, `${TAPE_PREFIX}2-2`])

    // The system-prompt plugin's user-role snapshots are restored as runtime-context; its system head as system-prompt.
    const snapshots = events.filter(event => event.type === 'user/message' && event.data.source.kind === RUNTIME_CONTEXT_SOURCE)
    expect(snapshots.map(event => event.seq)).toEqual(original.filter(event => oldPlugin(event) === '@deepseek-ai/dsh-system-prompt').map(event => event.seq))
    expect(snapshots).toHaveLength(3)
    const system = events.filter(event => event.type === 'system/message')
    expect(system).toHaveLength(1)
    expect(session.surface.nodes[0]).toBe(system[0]!.seq)
    expect(system[0]!.type === 'system/message' && system[0]!.data.message.source).toEqual({ kind: 'system-prompt' })

    const results = events.filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
    expect(results.map(event => [event.seq, event.data.message.role, event.data.message.toolCallId])).toEqual([
      [11, 'tool', 'v3-call-1'], [13, 'tool', 'v3-call-2'], [29, 'tool', 'v3-call-3'],
    ])
    results.forEach((event, index) => expect(event.data.message.content).toEqual([{ type: 'text', text: v3Body(index + 1) }]))

    // The source artifact is never rewritten; write-open publishes the V4 successor next to it.
    const writer = await ctx.sessionPersistence.open(V3.id, 'write')
    try { expect((await writer.read()).events).toEqual(events) } finally { await writer.close() }
    expect(await readFile(sourcePath, 'utf8')).toBe(source)
    expect((await readdir(dirname(sourcePath))).filter(name => name.endsWith('.jsonl')).sort()).toEqual(['session.v3.jsonl', 'session.v4.jsonl'])
  })

  it('rejects the frozen format-3 locators with refresh guidance and serves fresh ones', async () => {
    const { session, events } = await boot(V3)
    const [first] = tapes(events)
    expect(textOf(first!)).toContain('expand_result({"seq":13,"formatVersion":3})')
    // The same integer still happens to name result 2 here, but only a current-format locator is accepted.
    await expect(execute(session, 'expand', { seq: 13, formatVersion: 3 })).rejects.toThrow(/formatVersion 4 from a fresh locator/)
    await expect(execute(session, 'expand', { seq: 13, formatVersion: 3 })).rejects.toThrow(/recall_turn\(\{"turn":"N","view":"dialogue"\}\)/)
    await expect(execute(session, 'expand', { seq: 13 })).rejects.toThrow(/formatVersion/)

    const hits = searchSessionEvents(events, 'EXACT_v3-result-2_BODY', { kinds: ['tool_output'] })
    expect(hits.map(hit => hit.locator)).toEqual([`expand_result({"seq":13,"formatVersion":${SESSION_FORMAT_VERSION}})`])
    const dialogue = renderSealedTurn(events, 1, { view: 'dialogue' })!.rendered
    expect(dialogue).toContain(hits[0]!.locator)
    expect(dialogue).not.toContain('"formatVersion":3')
    expect(await execute(session, 'expand', { seq: 13, formatVersion: SESSION_FORMAT_VERSION })).toContain(v3Body(2))
    expect(await execute(session, 'expand', { seq: 29, formatVersion: SESSION_FORMAT_VERSION })).toContain(v3Body(3))
    expect(await execute(session, 'expand', { turn: 1, step: 1, call: 2 })).toContain(v3Body(2))
    expect(await execute(session, 'expand', { turn: 2, step: 1, call: 1 })).toContain(v3Body(3))
    expect(tapes(session.snapshotEvents()).map(textOf)).toEqual(tapes(events).map(textOf))
  })

  it('recognizes restored entries and snapshots when the next seal runs', async () => {
    const policy = { keepRecentTurns: 0 }
    // Unchanged runtime context: the restored snapshot of turn 3 is the newest one and stays live.
    const kept = await boot(V3)
    const frozen = tapes(kept.events).map(event => ({ seq: event.seq, text: textOf(event) }))
    kept.session.append('turn/start', { turn: 4 })
    const plain = sealCompletedTurns(kept.session, [], policy)
    expect(plain.appends).toHaveLength(1)
    const written = kept.session.snapshotEvents().filter(isTape).filter(event => !frozen.some(old => old.seq === event.seq))
    expect(written).toHaveLength(1)
    expect(textOf(written[0]!).startsWith(`${TAPE_PREFIX}3-3 · 1 turn(s) sealed`)).toBe(true)
    expect(written[0]!.data.source).toEqual({ kind: HISTORY_SOURCE })
    // Only turn 3's reply: never a restored entry, the system head, a human message or the live snapshot.
    expect(written[0]!.sourceEventSeqs).toEqual([43])
    expect(kept.session.surface.nodes).toContain(41 as SessionSeq)
    for (const old of frozen) {
      expect(kept.session.surface.nodes).toContain(old.seq)
      expect(textOf(kept.session.eventAt(old.seq) as SessionEvent<'user/message'>)).toBe(old.text)
    }

    // A newer pending snapshot supersedes it, so turn 3's own entry absorbs the dead one.
    const superseded = await boot(V3)
    superseded.session.append('turn/start', { turn: 4 })
    const pending = createUserMessage({ content: [{ type: 'text', text: 'RUNTIME V3_RUNTIME_4' }], source: { kind: RUNTIME_CONTEXT_SOURCE } })
    sealCompletedTurns(superseded.session, [pending], policy)
    const absorbed = superseded.session.snapshotEvents().filter(isTape).filter(event => !frozen.some(old => old.seq === event.seq))
    expect(absorbed).toHaveLength(1)
    expect(absorbed[0]!.sourceEventSeqs).toEqual([41, 43])
    expect(superseded.session.surface.nodes).not.toContain(41 as SessionSeq)
  })

  it('resumes on the native V4 loop, seals only the new turn and leaves the restored tape frozen', async () => {
    const { root, original } = await stage(V3)
    const h = await nativeHarness([nativeText('V4_REPLY')], { persistenceRoot: root, config: { history: { keepRecentTurns: 0 } } })
    harnesses.push(h)
    const tick = 'V3_RUNTIME_3'
    h.ctx.systemPrompt.variable('v3_tick', () => tick)
    h.ctx.systemPrompt.context({ name: 'v3-runtime', order: 50, text: 'RUNTIME {{v3_tick}}' })
    const { agent } = await h.ctx.agents.resume({ resumeSessionId: V3.id, agentOptions: { provider: 'native-mock', model: 'deterministic' } })
    const restored = agent.session.snapshotEvents().length
    await nativeSend(agent, 'V4_USER_FOUR: continue after the upgrade.')

    expect(h.errors).toEqual([])
    expect(agent.session.header.version).toBe(SESSION_FORMAT_VERSION)
    const events = agent.session.snapshotEvents()
    const entries = tapes(events)
    expect(entries.map(event => event.seq).slice(0, 2)).toEqual([22, 38])
    expect(entries.slice(0, 2).map(textOf)).toEqual(original.filter(oldTape).map(event => textOf(event as SessionEvent<'user/message'>)))
    expect(entries.slice(2).map(event => textOf(event).slice(0, TAPE_PREFIX.length + 3))).toEqual([`${TAPE_PREFIX}3-3`])
    const added = entries.slice(2)
    expect(added.every(event => event.seq >= restored)).toBe(true)
    // The live restored snapshot (seq 41) and every system node stay out of the seal.
    const systemSeqs = events.filter(event => event.type === 'system/message').map(event => event.seq)
    for (const entry of added) {
      expect(entry.sourceEventSeqs).not.toContain(41)
      for (const seq of systemSeqs) expect(entry.sourceEventSeqs).not.toContain(seq)
    }
    const request = h.adapter.requests[0]!.messages
    expect(request[0]!.role).toBe('system')
    const shown = request.map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
    const positions = entries.map(entry => shown.indexOf(textOf(entry)))
    expect(positions.every(index => index > 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(shown.filter(text => text.includes('RUNTIME V3_RUNTIME_3'))).toHaveLength(1)
  })
})

/** The generator's fold policy (fixtures/slice-v3-tools-session.md); a restored fold is recognised only under it. */
const V3_TOOLS_FOLD = { history: { keepRecentTurns: 0 }, fold: { pinSteps: 0 }, digest: { minChars: 1500 } }
function resultText(event: SessionEvent | undefined): string {
  return event?.type === 'tool/result' ? event.data.message.content.map(block => block.type === 'text' ? block.text : '').join('') : ''
}

describe('0.1.5 (format 3) parallel, error, PTC and folded results restored into session format V4', () => {
  it('lifts every result kind into one tool-role message per call and keeps the fold replacement and nested dispatch', async () => {
    const { session, events } = await boot(V3_TOOLS)
    expect(session.header.version).toBe(SESSION_FORMAT_VERSION)
    const results = events.filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
    expect(results.map(event => [event.seq, event.data.message.role, event.data.message.toolCallId, event.data.message.isError === true, event.sourceEventSeqs])).toEqual([
      [11, 'tool', 'c1a', false, [10]], [13, 'tool', 'c1b', false, [12]],
      [31, 'tool', 'c2', false, [28]],
      [47, 'tool', 'c3a', false, [46]], [49, 'tool', 'c3b', true, [48]],
      [65, 'tool', 'c4a', false, [64]], [67, 'tool', 'c4a', false, [65]],
      [72, 'tool', 'c4b', false, [71]],
    ])
    for (const event of results) expect(event.data.message.source).toEqual({ kind: 'tool', callId: event.data.message.toolCallId })
    expect(resultText(events[49])).toBe('Error: V3_BOOM_SENTINEL')
    expect(resultText(events[31])).toContain('PROGRAM_SAW')
    // The fold replacement keeps its frozen V3 hint; the original stays on the log.
    expect(events[67]!.surfaceOp).toEqual({ op: 'replace', startSeq: 65, endSeq: 65 })
    expect(resultText(events[67])).toContain('expand_result({"seq": 65, "formatVersion": 3}) returns the full text]')
    expect(resultText(events[65])).toContain('END_V3_BIG')
    const dispatch = events[30]!
    expect(dispatch.type === 'tool/ptc-dispatch' && [dispatch.data.rootCallId, dispatch.data.name, dispatch.data.content]).toEqual(['c2', 'read', [{ type: 'text', text: 'V3_READ_nested.ts_BODY\nline two\n' }]])
    expect(tapes(events).map(event => event.seq)).toEqual([22, 40, 58, 81])
  })

  it('serves the original bytes of restored parallel, error, nested and folded results through every recall path', async () => {
    const { session, events } = await boot(V3_TOOLS)
    const V = SESSION_FORMAT_VERSION
    expect(await execute(session, 'expand', { turn: 1, step: 1, call: 2 })).toBe('[full result of echo · turn 1 step 1 call 2]\nV3_ECHO_OK')
    expect(await execute(session, 'expand', { seq: 49, formatVersion: V })).toBe('[full result of boom · seq 49 (turn 3 step 1 call 2)]\nError: V3_BOOM_SENTINEL')
    // The fold replacement and its original both resolve to the complete original.
    for (const args of [{ seq: 67, formatVersion: V }, { seq: 65, formatVersion: V }, { turn: 4, step: 1, call: 1 }]) {
      const full = String(await execute(session, 'expand', args))
      expect(full).toContain('tick 200 ')
      expect(full).toContain('END_V3_BIG')
    }
    await expect(execute(session, 'expand', { seq: 65, formatVersion: 3 })).rejects.toThrow(/formatVersion 4 from a fresh locator/)

    const error = searchSessionEvents(events, 'V3_BOOM_SENTINEL', { kinds: ['tool_error'] })
    expect(error.map(hit => [hit.turn, hit.locator])).toEqual([[3, `expand_result({"seq":49,"formatVersion":${V}})`]])
    expect(searchSessionEvents(events, 'tick 200 ', { kinds: ['tool_output'] }).map(hit => hit.locator)).toEqual([`expand_result({"seq":65,"formatVersion":${V}})`])
    const step = String(await recallStepToolDefinition().execute({ turn: '3', step: '1' }, { agent: { session } } as ToolRunContext))
    expect(step).toContain('## Results (verbatim)')
    expect(step).toContain('[error result]\nError: V3_BOOM_SENTINEL')
    expect(step).toContain('V3_READ_b.ts_BODY')
    const nested = String(await recallStepToolDefinition().execute({ turn: '2', step: '1' }, { agent: { session } } as ToolRunContext))
    expect(nested).toContain('→ run_code(')
    expect(nested).toContain('PROGRAM_SAW')
    for (let turn = 1; turn <= 4; turn += 1) {
      const dialogue = renderSealedTurn(events, turn, { view: 'dialogue' })!.rendered
      expect(dialogue).toContain(`V3_USER_${turn} go`)
      expect(dialogue).toContain(`V3_ANSWER_${turn}`)
      expect(dialogue).not.toContain('"formatVersion":3')
    }
    expect(renderSealedTurn(events, 4, { view: 'dialogue' })!.rendered).toContain(`expand_result({"seq":65,"formatVersion":${V}})`)
  })

  it('recognises a fold written under format 3 after resume, so its count and expansion backoff carry over', async () => {
    const { root } = await stage(V3_TOOLS)
    // The model retrieves the V3-folded result by its stable address in the first V4 turn.
    const h = await nativeHarness([nativeTool('v4-expand', EXPAND_TOOL_NAME, { turn: 4, step: 1, call: 1 }), nativeText('V4_REPLY')], {
      persistenceRoot: root, config: { ...V3_TOOLS_FOLD, fold: { ...V3_TOOLS_FOLD.fold, backoffAfterExpansions: 1 } },
    })
    harnesses.push(h)
    const { agent } = await h.ctx.agents.resume({ resumeSessionId: V3_TOOLS.id, agentOptions: { provider: 'native-mock', model: 'deterministic' } })
    await nativeSend(agent, 'V4_USER_6 retrieve the folded log')

    expect(h.errors).toEqual([])
    const expanded = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'v4-expand')
    expect(resultText(expanded)).toContain('END_V3_BIG')
    // The restored replacement at seq 67 counts as this folder's fold, and retrieving it backs off bigread.
    expect(FOLD_STATS.get(agent.session)).toMatchObject({ folded: 1, expanded: 1, backedOff: [JSON.stringify(['bigread', 'arguments', {}])] })
  })
})
