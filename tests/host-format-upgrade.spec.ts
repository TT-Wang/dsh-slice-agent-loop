/** Real published JSONL migration; frozen alpha.2 tape is never rewritten. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { expandResultToolDefinition, fullResultAt, resultBySeq } from '../src/fold/index.js'
import { recallToolDefinition, renderSealedTurn, searchSessionEvents } from '../src/recall.js'

const id = SessionId('slice-alpha2-migration')
const fixtureUrl = new URL('./fixtures/slice-alpha2-session.v2.jsonl', import.meta.url)
const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function tape(events: readonly SessionEvent[]): SessionEvent<'user/message'> {
  const event = events.find(event => event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === 'slice:history')
  if (event?.type !== 'user/message') throw new Error('fixture lost its immutable slice tape')
  return event
}
function body(call: number): string { return `EXACT_result-${call}_BODY="saved"\nline two\n` }

async function boot() {
  const root = await mkdtemp(join(tmpdir(), 'slice-format-upgrade-'))
  roots.push(root)
  const sourcePath = join(root, '_no-cwd', id, 'session.v2.jsonl')
  const source = await readFile(fixtureUrl, 'utf8')
  await mkdir(dirname(sourcePath), { recursive: true })
  await writeFile(sourcePath, source)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  const reader = await ctx.sessionPersistence.open(id, 'read')
  try {
    const read = await reader.read()
    const session = Session.fromRestore(id, read.events, reader.header, reader.inheritedEventCount, read.eventState)
    return { ctx, sourcePath, source, session, events: read.events }
  } finally { await reader.close() }
}

function execute(session: Session, name: 'expand' | 'turn', args: object) {
  const definition = name === 'expand' ? expandResultToolDefinition() : recallToolDefinition()
  // The handlers read only their owning Session. Migration and restoration use
  // the actual published persistence/provider and Session implementations.
  return definition.execute(args, { agent: { session } } as ToolRunContext)
}

describe('alpha.2 JSONL through the current native format migration', () => {
  it('remaps native references while preserving original dialogue, results and frozen tape bytes', async () => {
    const { ctx, source, sourcePath, session, events } = await boot()
    const original = source.trimEnd().split('\n').slice(1).map(line => JSON.parse(line)) as SessionEvent[]
    expect(session.header.version).toBe(SESSION_FORMAT_VERSION)
    expect(SESSION_FORMAT_VERSION).toBe(3)
    expect(events.filter(event => event.type === 'system/message')).toHaveLength(2)
    expect(tape(events).data).toEqual(tape(original).data)
    expect(tape(events).sourceEventSeqs).not.toEqual(tape(original).sourceEventSeqs)
    expect(tape(events).surfaceOp).toMatchObject({ op: 'replace', startSeq: expect.any(Number), endSeq: expect.any(Number) })
    expect(session.surface.nodes).toContain(tape(events).seq)

    const full = await execute(session, 'turn', { turn: '1', view: 'full' })
    expect(full).toContain('USER_ORIGINAL: inspect the three original results.')
    expect(full).toContain('ASSISTANT_ORIGINAL: consulted all three results.')
    const records = JSON.parse(String(full).split('## Original records (including reasoning, tool output and recorded file metadata)\n')[1]!) as SessionEvent[]
    const firstEnd = original.find(event => event.type === 'turn/end' && event.data.turn === 1)!.seq
    const relevant = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result'])
    expect(records.filter(event => relevant.has(event.type)).map(event => event.data)).toEqual(
      original.filter(event => event.seq < firstEnd && relevant.has(event.type)).map(event => event.data),
    )
    for (let call = 1; call <= 3; call += 1) {
      expect(fullResultAt(events, 1, 1, call)?.text).toBe(body(call))
      expect(await execute(session, 'expand', { turn: 1, step: 1, call })).toContain(body(call))
      expect(full).toContain(`EXACT_result-${call}_BODY`)
    }
    // Read preparation is side-effect free; write-open publishes an immutable
    // successor. The old artifact and its embedded seq hints remain unchanged.
    expect(await readFile(sourcePath, 'utf8')).toBe(source)
    expect(await readdir(dirname(sourcePath))).toEqual(['session.v2.jsonl'])
    const writer = await ctx.sessionPersistence.open(id, 'write')
    try { expect((await writer.read()).events).toEqual(events) } finally { await writer.close() }
    expect(await readFile(sourcePath, 'utf8')).toBe(source)
    expect((await readdir(dirname(sourcePath))).filter(name => name.endsWith('.jsonl')).sort()).toEqual(['session.v2.jsonl', 'session.v3.jsonl'])
    const reopened = await ctx.sessionPersistence.open(id, 'read')
    try {
      const read = await reopened.read()
      expect(read.events).toEqual(events)
      expect(tape(read.events).data).toEqual(tape(original).data)
    } finally { await reopened.close() }
  })

  it('rejects unqualified or old-generation seq locators instead of silently returning a different result', async () => {
    const { session, events } = await boot()
    // Alpha.2 result 2 lived at seq 11. Native migration inserted two system
    // events, so the same integer now names result 1. The text is not remapped.
    expect(tape(events).data.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('expand_result({"seq":11})') })]))
    expect(resultBySeq(events, 11).text).toBe(body(1))
    expect(fullResultAt(events, 1, 1, 2)?.text).toBe(body(2))
    await expect(execute(session, 'expand', { seq: 11 })).rejects.toThrow(/formatVersion/)
    await expect(execute(session, 'expand', { seq: 11, formatVersion: 2 })).rejects.toThrow(/formatVersion/)
    expect(await execute(session, 'expand', { seq: 13, formatVersion: SESSION_FORMAT_VERSION })).toContain(body(2))
    expect(await execute(session, 'expand', { turn: 1, step: 1, call: 2 })).toContain(body(2))
  })

  it('fresh recall and search locators identify the current generation and recover exact original bytes', async () => {
    const { session, events } = await boot()
    const before = tape(events).data
    const dialogue = renderSealedTurn(events, 1, { view: 'dialogue' })!.rendered
    const hits = searchSessionEvents(events, 'EXACT_result-2_BODY', { kinds: ['tool_output'] })
    expect(hits).toHaveLength(1)
    const match = /^expand_result\((\{.+\})\)$/.exec(hits[0]!.locator)!
    const args = JSON.parse(match[1]!) as { seq: number; formatVersion: number }
    expect(args).toMatchObject({ seq: 13, formatVersion: SESSION_FORMAT_VERSION })
    expect(dialogue).toContain(hits[0]!.locator)
    expect(await execute(session, 'expand', args)).toContain(body(2))
    expect(tape(session.snapshotEvents()).data).toBe(before)
  })
})
