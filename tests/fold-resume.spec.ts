/**
 * fold batch 3 on the stock loop (native harness + mock adapter):
 *   ① expand_result accepts a durable `seq` locator — the original's seq or the fold view's own seq — and turn/step/call still works;
 *   ② a result rewritten by the post-execute spill arm keeps a locator in the log and expand_result(seq) returns the original through it;
 *   ③ the post-execute spill arm honors the same back-off / pin state as the pre-step fold;
 *   ④ after resume (seed from snapshotEvents) results already shown raw are not folded, new large results are, and fold counts survive;
 *      a result left unshown by a blocked turn is folded when the tape's keep window still holds that turn raw, and sealed with it otherwise.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { isAppendSurfaceEvent, isReplacementSurfaceEvent, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SpillLocal from '@deepseek-ai/dsh-spill-local'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { EXPAND_TOOL_NAME, FOLD_STATS, resultBySeq, spillLocatorOf, ToolResultFold } from '../src/fold/index.js'
import { nativeHarness, nativeSend, nativeText, nativeTool, type NativeHarness } from './native-harness.js'

const BIG = Array.from({ length: 120 }, (_, i) => (i % 10 === 0 ? `section_${i / 10}: header` : `row ${i} payload ${'x'.repeat(30)} ${i * 7}`)).join('\n')
const LOG = Array.from({ length: 1200 }, (_, i) => (i === 700 ? '2026-09-04 10:00:00 ERROR worker 7 failed: boom' : `2026-09-04 10:00:00 INFO tick ${i} ${'x'.repeat(30)}`)).join('\n')
const MID = Array.from({ length: 80 }, (_, i) => (i === 40 ? '2026-09-04 10:00:00 ERROR flaky: boom' : `2026-09-04 10:00:00 INFO mid ${i} ${'y'.repeat(20)}`)).join('\n')

const live: NativeHarness[] = []
const roots: string[] = []
afterEach(async () => {
  for (const h of live.splice(0).reverse()) await h.ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function boot(responses: StreamChunk[][], config: Parameters<typeof nativeHarness>[1] = {}): Promise<NativeHarness & { responses: StreamChunk[][] }> {
  const h = await nativeHarness(responses, config)
  live.push(h)
  return Object.assign(h, { responses })
}
async function create(h: NativeHarness, id: string, seed?: readonly SessionEvent[]) {
  return h.ctx.agents.create({ sessionId: SessionId(id), ...(seed ? { seed } : {}), agentOptions: { provider: 'native-mock', model: 'deterministic' } })
}
function tool(h: NativeHarness, name: string, text: () => string): void {
  h.ctx.tools.register(defineContentToolFixture({ name, description: name, parameters: { file_path: { type: 'string' } }, execute: async () => [{ type: 'text', text: text() }] }))
}
async function spillStore(h: NativeHarness): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'fold-resume-spill-'))
  roots.push(root)
  await h.ctx.plugin(SpillLocal, { root } as never)
}
const requestText = (h: NativeHarness, i: number): string => JSON.stringify(h.adapter.requests[i]?.messages ?? [])
const events = (agent: Agent) => agent.session.snapshotEvents()
const replacements = (agent: Agent) => events(agent).filter((e) => e.type === 'tool/result' && isReplacementSurfaceEvent(e))
const originals = (agent: Agent) => events(agent).filter((e) => e.type === 'tool/result' && isAppendSurfaceEvent(e))
function resultTextOf(e: SessionEvent): string {
  if (e.type !== 'tool/result') return ''
  return e.data.message.content.flatMap((b) => b.content.flatMap((x) => x.type === 'text' ? [x.text] : [])).join('\n')
}
/** The model reads the fold view like a model would: at step `at` it decides its next call from the log so far.
 *  Registered `prepend` so it is outermost: the fold itself runs after the inner step decision (it only folds an entered
 *  step), so the decision must be taken once every pre-step handler — the fold included — has finished, as the request is. */
function scriptAt(agent: Agent, at: number, decide: () => StreamChunk[], responses: StreamChunk[][]): void {
  agent.ctx.on('agent/pre-step', async ({ step }, next) => {
    const decision = await next()
    if (step === at) responses.push(decide())
    return decision
  }, { prepend: true })
}
/** A session whose previous process stopped between the tool result and the next request (an outer pre-step
 *  rejected step 2 before the fold could run): nothing after the last request/header was shown, so the result
 *  reaches the next process raw and unfolded. */
async function unshownSeed(id: string): Promise<readonly SessionEvent[]> {
  const first = await boot([nativeTool('c1', 'read', { file_path: 'a.txt' })], { config: { fold: { pinSteps: 0 }, digest: { minChars: 1500 } } })
  tool(first, 'read', () => BIG)
  const one = await create(first, id)
  one.agent.ctx.on('agent/pre-step', async ({ step }, next) => step === 2 ? { kind: 'reject' as const } : next(), { prepend: true })
  await nativeSend(one.agent, 'read a.txt')
  expect([...events(one.agent)].reverse().find((e) => e.type === 'turn/end')?.data.reason.kind).toBe('blocked')
  const seed = structuredClone(events(one.agent))
  expect(seed.some((e) => e.type === 'tool/result')).toBe(true)
  expect(seed.some(isReplacementSurfaceEvent)).toBe(false)
  await first.ctx.fiber.dispose()
  live.pop()
  return seed
}

describe('expand_result by durable seq', () => {
  it('returns the original for a folded result through the view\'s own seq, and turn/step/call still works', async () => {
    const h = await boot([nativeTool('c1', 'read', { file_path: 'notes.md' })], { config: { fold: { pinSteps: 0 }, digest: { minChars: 1500 } } })
    tool(h, 'read', () => BIG)
    const { agent } = await create(h, 'seq-folded')
    let viewSeq = -1
    scriptAt(agent, 2, () => {
      viewSeq = replacements(agent)[0]!.seq
      return nativeTool('c2', EXPAND_TOOL_NAME, { seq: viewSeq })
    }, h.responses)
    scriptAt(agent, 3, () => nativeTool('c3', EXPAND_TOOL_NAME, { turn: 1, step: 1, call: 1, lines: '2-3' }), h.responses)
    scriptAt(agent, 4, () => nativeTool('c4', EXPAND_TOOL_NAME, { seq: 4 }), h.responses)   // seq 4 is the user/message
    scriptAt(agent, 5, () => nativeText('done'), h.responses)
    await nativeSend(agent, 'summarize notes.md')

    expect(h.errors).toEqual([])
    const original = originals(agent)[0]!
    // the view names both locators
    expect(requestText(h, 1)).toContain(`${EXPAND_TOOL_NAME}({\\"turn\\": 1, \\"step\\": 1, \\"call\\": 1}) or ${EXPAND_TOOL_NAME}({\\"seq\\": ${original.seq}})`)
    expect(requestText(h, 1)).not.toContain('row 55 payload')
    // seq of the replacement resolves to the original through sourceEventSeqs[0]
    expect(viewSeq).toBeGreaterThan(original.seq)
    expect(requestText(h, 2)).toContain(`[full result of read · seq ${original.seq} (turn 1 step 1 call 1)]`)
    expect(requestText(h, 2)).toContain('row 55 payload')
    expect(resultBySeq(events(agent), viewSeq)).toEqual({ name: 'read', text: BIG, seq: original.seq, turn: 1, step: 1, call: 1 })
    // the old locator keeps working, filters included
    expect(requestText(h, 3)).toContain('[read · turn 1 step 1 call 1 · lines 2-3 of 120]')
    expect(requestText(h, 3)).toContain('2: row 1 payload')
    // a seq that is not a tool result is a clear error, not a silent miss
    const bad = originals(agent).find((e) => e.type === 'tool/result' && e.data.message.content[0]?.toolCallId === 'c4')!
    expect(resultTextOf(bad)).toContain('seq 4 is a user/message event, not a tool result')
    expect(bad.type === 'tool/result' && bad.data.message.content[0]?.isError).toBe(true)
    // both expansions count against the folded read (seq and turn/step/call name the same fold)
    const stats = FOLD_STATS.get(agent.session)!
    expect(stats.folded).toBe(1)
    expect(stats.expanded).toBe(2)
    expect(stats.backedOff).toEqual(['read'])
  })
})

describe('post-execute spill arm', () => {
  it('logs a locator with the rewritten result and expand_result(seq) returns the original through it', async () => {
    const h = await boot([nativeTool('c1', 'bash', { file_path: 'run' })], { config: { fold: { pinSteps: 0, spillPreviewMinBytes: 50_000 } } })
    await spillStore(h)
    tool(h, 'bash', () => LOG)
    const { agent } = await create(h, 'seq-spilled')
    scriptAt(agent, 2, () => nativeTool('c2', EXPAND_TOOL_NAME, { seq: replacements(agent)[0]!.seq }), h.responses)
    scriptAt(agent, 3, () => nativeTool('c3', EXPAND_TOOL_NAME, { seq: originals(agent)[0]!.seq, grep: 'worker 7' }), h.responses)
    scriptAt(agent, 4, () => nativeText('done'), h.responses)
    await nativeSend(agent, 'run it')

    expect(h.errors).toEqual([])
    const logged = originals(agent)[0]!
    // the durable log holds the view, not the original — but the view carries the locator
    expect(resultTextOf(logged)).not.toContain('tick 300 ')
    expect(spillLocatorOf(resultTextOf(logged))).toMatchObject({ bytes: Buffer.byteLength(LOG, 'utf8') })
    // pre-step adds both expand_result locators to the spilled view before it is first sent; that is not counted as a fold
    expect(requestText(h, 1)).toContain(`stored at`)
    expect(requestText(h, 1)).toContain(`or ${EXPAND_TOOL_NAME}({\\"seq\\": ${logged.seq}}) returns the full text]`)
    expect(requestText(h, 1)).toContain('ERROR worker 7 failed')
    expect(requestText(h, 1)).not.toContain('tick 300 ')
    // the original comes back from the locator, whole or filtered
    expect(requestText(h, 2)).toContain(`[full result of bash · seq ${logged.seq} (turn 1 step 1 call 1)]`)
    expect(requestText(h, 2)).toContain('tick 300 ')
    expect(requestText(h, 3)).toContain('1 of 1200 lines match /worker 7/i')
    expect(requestText(h, 3)).toContain('701: 2026-09-04 10:00:00 ERROR worker 7 failed')
    const stats = FOLD_STATS.get(agent.session)!
    expect(stats.spilled).toBe(1)
    expect(stats.folded).toBe(0)
    expect(stats.expanded).toBe(2)
    expect(stats.backedOff).toEqual(['bash'])
  })

  it('stops spilling a tool once the pre-step fold has backed off from it', async () => {
    let calls = 0
    const h = await boot([nativeTool('c1', 'bash', { file_path: 'run' })], { config: { fold: { pinSteps: 0, spillPreviewMinBytes: 50_000 }, digest: { minChars: 1500 } } })
    await spillStore(h)
    tool(h, 'bash', () => (calls += 1) <= 2 ? MID : LOG)
    const { agent } = await create(h, 'spill-backoff')
    scriptAt(agent, 2, () => nativeTool('c2', EXPAND_TOOL_NAME, { seq: originals(agent)[0]!.seq }), h.responses)
    scriptAt(agent, 3, () => nativeTool('c3', 'bash', { file_path: 'run' }), h.responses)
    scriptAt(agent, 4, () => nativeTool('c4', EXPAND_TOOL_NAME, { turn: 1, step: 3, call: 1 }), h.responses)
    scriptAt(agent, 5, () => nativeTool('c5', 'bash', { file_path: 'run' }), h.responses)   // 60K after back-off
    scriptAt(agent, 6, () => nativeText('done'), h.responses)
    await nativeSend(agent, 'run until it fails')

    expect(h.errors).toEqual([])
    const stats = FOLD_STATS.get(agent.session)!
    expect(stats.folded).toBe(2)
    expect(stats.expanded).toBe(2)
    expect(stats.backedOff).toEqual(['bash'])
    expect(stats.spilled).toBe(0)
    const last = originals(agent).at(-1)!
    expect(resultTextOf(last)).toContain('tick 300 ')            // logged raw: neither path rewrote it
    expect(spillLocatorOf(resultTextOf(last))).toBeUndefined()
    expect(requestText(h, 5)).toContain('tick 300 ')             // and sent raw
    expect(replacements(agent)).toHaveLength(2)
  })

  it('honors pinned steps like the pre-step fold', async () => {
    const h = await boot([nativeTool('c1', 'bash', { file_path: 'run' }), nativeText('done')], { config: { fold: { pinSteps: 1, pinMaxChars: 1_000_000, spillPreviewMinBytes: 50_000 } } })
    await spillStore(h)
    tool(h, 'bash', () => LOG)
    const { agent } = await create(h, 'spill-pinned')
    await nativeSend(agent, 'run it')

    expect(h.errors).toEqual([])
    expect(FOLD_STATS.get(agent.session)!.spilled).toBe(0)
    expect(resultTextOf(originals(agent)[0]!)).toContain('tick 300 ')
    expect(requestText(h, 1)).toContain('tick 300 ')
  })
})

describe('resume from snapshotEvents', () => {
  it('does not fold results already shown raw before resume, folds a new large result', async () => {
    // process 1: pinSteps 2 keeps the step-1 read raw (BIG < pinMaxChars) — the model saw it verbatim
    const first = await boot([nativeTool('c1', 'read', { file_path: 'a.txt' }), nativeText('done')], { config: { fold: { pinSteps: 2 }, digest: { minChars: 1500 } } })
    tool(first, 'read', () => BIG)
    const one = await create(first, 'resume-shown')
    await nativeSend(one.agent, 'read a.txt')
    expect(first.errors).toEqual([])
    expect(replacements(one.agent)).toHaveLength(0)
    const shown = originals(one.agent)[0]!
    expect(requestText(first, 1)).toContain('row 55 payload')
    const seed = structuredClone(events(one.agent))
    await first.ctx.fiber.dispose()
    live.pop()

    // process 2: a stricter policy (pinSteps 0) must not reach back and fold what was already shown
    const second = await boot([nativeTool('c2', 'read', { file_path: 'b.txt' }), nativeText('done again')], { config: { fold: { pinSteps: 0 }, digest: { minChars: 1500 } } })
    tool(second, 'read', () => BIG)
    const two = await create(second, 'resume-shown', seed)
    expect(events(two.agent).slice(0, seed.length)).toEqual(seed)
    await nativeSend(two.agent, 'read b.txt')

    expect(second.errors).toEqual([])
    const folds = replacements(two.agent)
    expect(folds.map((e) => (e as { sourceEventSeqs?: number[] }).sourceEventSeqs)).not.toContainEqual([shown.seq])
    const fresh = originals(two.agent).at(-1)!
    expect(fresh.seq).toBeGreaterThan(seed.length - 1)
    expect(folds.map((e) => (e as { sourceEventSeqs?: number[] }).sourceEventSeqs)).toEqual([[fresh.seq]])
    expect(requestText(second, 1)).toContain(`${EXPAND_TOOL_NAME}({\\"turn\\": 2, \\"step\\": 1, \\"call\\": 1}) or ${EXPAND_TOOL_NAME}({\\"seq\\": ${fresh.seq}})`)
    expect(FOLD_STATS.get(two.agent.session)).toMatchObject({ folded: 1, expanded: 0, backedOff: [] })
  })

  it.each(['error', 'aborted'] as const)('does not refold raw evidence sent in a failed %s continuation', async (kind) => {
    const failure: StreamChunk[] = [{ type: 'finish', reason: { kind, failure: { code: 'SERVER', message: 'failed continuation fixture' } } }]
    const first = await boot([nativeTool('old-read', 'read', { file_path: 'a.txt' }), failure], { slice: false })
    await first.ctx.plugin(ToolResultFold, { pinSteps: 2, digest: { minChars: 1500 }, spillPreviewMinBytes: 0 })
    tool(first, 'read', () => BIG)
    const one = await create(first, `resume-attempt-${kind}`)
    await nativeSend(one.agent, 'read a.txt')
    const shown = originals(one.agent)[0]!
    expect(requestText(first, 1)).toContain('row 55 payload')
    const seed = structuredClone(events(one.agent))
    expect(seed.some((event) => event.type === 'assistant/attempt' && event.seq > shown.seq)).toBe(true)
    expect(seed.some((event) => event.type === 'request/header' && event.seq > shown.seq)).toBe(false)

    const second = await boot([nativeTool('new-read', 'read', { file_path: 'b.txt' }), nativeText('done')], { slice: false })
    await second.ctx.plugin(ToolResultFold, { pinSteps: 0, digest: { minChars: 1500 }, spillPreviewMinBytes: 0 })
    tool(second, 'read', () => BIG)
    const two = await create(second, `resume-attempt-${kind}`, seed)
    await nativeSend(two.agent, 'continue')
    expect(second.errors).toEqual([])
    expect(requestText(second, 0)).toContain('row 55 payload')
    expect(replacements(two.agent).some((event) => event.type === 'tool/result' && event.sourceEventSeqs?.includes(shown.seq))).toBe(false)
    const fresh = originals(two.agent).at(-1)!
    expect(replacements(two.agent).map((event) => event.type === 'tool/result' ? event.sourceEventSeqs : undefined)).toEqual([[fresh.seq]])
  })

  it('folds a result that landed after the last request in the previous process', async () => {
    const seed = await unshownSeed('resume-unshown')

    // keepRecentTurns 1 holds the blocked turn raw at the tail, so the tape seal at step 1 does not absorb the
    // unfolded result before the fold reaches it: this case is about fold-on-resume, not about sealing.
    const second = await boot([nativeText('done')], { config: { fold: { pinSteps: 0 }, digest: { minChars: 1500 }, history: { keepRecentTurns: 1 } } })
    tool(second, 'read', () => BIG)
    const two = await create(second, 'resume-unshown', seed)
    const unshown = originals(two.agent)[0]!
    await nativeSend(two.agent, 'continue')

    expect(second.errors).toEqual([])
    expect(replacements(two.agent).map((e) => (e as { sourceEventSeqs?: number[] }).sourceEventSeqs)).toEqual([[unshown.seq]])
    expect(FOLD_STATS.get(two.agent.session)!.folded).toBe(1)
  })

  it('or seals that result with its turn under the default window, still reachable by the same seq', async () => {
    const seed = await unshownSeed('resume-sealed')

    // the other side of the same interaction: with the default window the blocked turn seals at step 1 and absorbs
    // the result before the fold sees it — nothing is lost, the entry names the locator the fold view would have.
    const second = await boot([nativeText('done')], { config: { fold: { pinSteps: 0 }, digest: { minChars: 1500 } } })
    tool(second, 'read', () => BIG)
    const two = await create(second, 'resume-sealed', seed)
    const unshown = originals(two.agent)[0]!
    await nativeSend(two.agent, 'continue')

    expect(second.errors).toEqual([])
    expect(requestText(second, 0)).toContain(`${EXPAND_TOOL_NAME}({\\"seq\\":${unshown.seq}})`)
    expect(requestText(second, 0)).not.toContain('row 55 payload')
  })

  it('keeps fold and expansion counts, so back-off is consistent across the resume', async () => {
    const first = await boot([nativeTool('c1', 'read', { file_path: 'a.txt' })], { config: { fold: { pinSteps: 0 }, digest: { minChars: 1500 } } })
    tool(first, 'read', () => BIG)
    const one = await create(first, 'resume-counts')
    scriptAt(one.agent, 2, () => nativeTool('c2', EXPAND_TOOL_NAME, { turn: 1, step: 1, call: 1 }), first.responses)
    scriptAt(one.agent, 3, () => nativeTool('c3', 'read', { file_path: 'b.txt' }), first.responses)
    scriptAt(one.agent, 4, () => nativeTool('c4', EXPAND_TOOL_NAME, { seq: replacements(one.agent)[1]!.seq }), first.responses)
    scriptAt(one.agent, 5, () => nativeText('done'), first.responses)
    await nativeSend(one.agent, 'read twice')
    expect(first.errors).toEqual([])
    const before = structuredClone(FOLD_STATS.get(one.agent.session)!)
    expect(before).toMatchObject({ folded: 2, expanded: 2, backedOff: ['read'] })
    const seed = structuredClone(events(one.agent))
    await first.ctx.fiber.dispose()
    live.pop()

    const second = await boot([nativeTool('c5', 'read', { file_path: 'c.txt' }), nativeText('done again')], { config: { fold: { pinSteps: 0 }, digest: { minChars: 1500 } } })
    tool(second, 'read', () => BIG)
    const two = await create(second, 'resume-counts', seed)
    await nativeSend(two.agent, 'read once more')

    expect(second.errors).toEqual([])
    const after = FOLD_STATS.get(two.agent.session)!
    expect(after).toEqual(before)                                   // replayed, and the backed-off read was not folded again
    expect(replacements(two.agent)).toHaveLength(2)
    expect(requestText(second, 1)).toContain('row 55 payload')      // new read sent raw: back-off survived the resume
  })
})
