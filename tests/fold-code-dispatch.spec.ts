/** Real code-dispatch bridge and spill middleware; only program execution/model are deterministic. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import CodeRuntime, { type CodeRunRequest, type CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import SpillLocal from '@deepseek-ai/dsh-spill-local'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { isAppendSurfaceEvent, isReplacementSurfaceEvent, SessionId } from '@deepseek-ai/dsh-session'
import { FOLD_STATS } from '../src/fold/index.js'
import { nativeHarness, nativeSend, nativeText, nativeTool, type NativeHarness } from './native-harness.js'

const BIG = Array.from({ length: 120 }, (_, i) => i % 10 === 0 ? `section_${i / 10}: heading` : `row ${i} payload ${'x'.repeat(30)}`).join('\n')
const LOG = Array.from({ length: 1200 }, (_, i) => `2026-09-13 10:00:00 INFO tick ${i} ${'x'.repeat(30)}`).join('\n')
const OTHER = LOG.replaceAll('tick', 'unrelated')
const ROOT = { turn: 1, step: 1, call: 1 }

class RetrievalRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    const tools = request.bindings.find((binding) => binding.global === 'tools')!.functions
    if (request.program === 'unrelated') return { value: OTHER, logs: [] }
    if (request.program === 'failure') {
      try { await tools.expand_result({ ...ROOT, grep: '(' }) } catch { /* a valid locator but failed retrieval */ }
      return { value: OTHER, logs: [] }
    }
    const locator = request.program === 'second-turn' ? { ...ROOT, turn: 2 } : ROOT
    const first = await tools.expand_result(locator)
    if (request.program === 'mixed') {
      try { await tools.expand_result({ ...ROOT, grep: '(' }) } catch { /* only the successful retrieval counts */ }
      return { value: first, logs: [] }
    }
    if (request.program === 'discard') return { value: OTHER, logs: [] }
    if (request.program === 'json') return { value: { evidence: first }, logs: [] }
    const second = await tools.expand_result(locator)
    return { value: first, logs: [] }
  }
}
const live: NativeHarness[] = []
const roots: string[] = []
afterEach(async () => {
  for (const h of live.splice(0)) await h.ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const code = (id: string, program: string) => nativeTool(id, 'run_code', { code: program, description: 'Retrieve evidence' })
async function boot(program: string, spill: boolean, body = BIG) {
  const h = await nativeHarness([
    nativeTool('read-first', 'read', { file_path: 'data.txt' }), code('outer', program),
    nativeTool('read-after', 'read', { file_path: 'next.txt' }), code('other-outer', 'unrelated'), nativeText('done'),
  ], { config: { fold: { pinSteps: 0, spillPreviewMinBytes: spill ? 50_000 : 0 }, digest: { minChars: 1500 } } })
  live.push(h)
  await h.ctx.plugin(RetrievalRuntime)
  if (spill) {
    const root = await mkdtemp(join(tmpdir(), 'fold-code-'))
    roots.push(root)
    await h.ctx.plugin(SpillLocal, { root } as never)
    await h.ctx.plugin(SpillPolicy, { maxInlineBytes: 50_000 })
  }
  h.ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'read', parameters: { file_path: { type: 'string' } }, execute: async () => [{ type: 'text', text: body }] }))
  const { agent } = await h.ctx.agents.create({ sessionId: SessionId(`code-${program}-${spill}`), agentOptions: { provider: 'native-mock', model: 'deterministic' } })
  agent.ctx.tools.presentAs('both')
  await nativeSend(agent, 'read then recover its omitted evidence')
  expect(h.errors).toEqual([])
  const textsAt = (request: number, id: string) => h.adapter.requests[request]!.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool-result' && b.toolCallId === id).flatMap((b) => b.type === 'tool-result' ? b.content.filter((p) => p.type === 'text').map((p) => p.type === 'text' ? p.text : '') : []).join('\n')
  return { h, agent, textsAt }
}

describe('nested recovery preserves only forwarded evidence', () => {
  it('counts two successful code-dispatch expansions and preserves the returned result before the next request', async () => {
    const { h, agent, textsAt } = await boot('twice', false)
    expect(textsAt(1, 'read-first')).not.toContain('row 55 payload')
    expect(textsAt(2, 'outer')).toContain('row 55 payload')
    expect(textsAt(3, 'read-after')).toContain('row 55 payload')
    expect(textsAt(4, 'other-outer')).not.toContain('unrelated 300 ')
    expect(FOLD_STATS.get(agent.session)).toMatchObject({ expanded: 2, backedOff: ['read'], folded: 2 })
    expect(agent.session.snapshotEvents().filter((event) => event.type === 'tool/code-dispatch' && event.data.name === 'expand_result')).toHaveLength(2)
  })

  it('preserves a JSON-wrapped retrieval through both the fold spill arm and native spill-policy', async () => {
    const { agent, textsAt } = await boot('json', true, LOG)
    expect(textsAt(2, 'outer')).toContain('tick 300 ')
    expect(textsAt(2, 'outer')).toContain('evidence')
    expect(textsAt(2, 'outer')).not.toContain('Full formatted result stored at:')
    expect(textsAt(4, 'other-outer')).not.toContain('unrelated 300 ')
    const original = agent.session.snapshotEvents().find((event) => event.type === 'tool/result' && isAppendSurfaceEvent(event) && event.data.message.source?.callId === 'outer')
    expect(original && JSON.stringify(original)).toContain('tick 300 ')
    expect(agent.session.snapshotEvents().some((event) => isReplacementSurfaceEvent(event) && event.sourceEventSeqs?.includes(original!.seq))).toBe(false)
  })

  it('counts only the success when one code scope mixes successful and failed expansions', async () => {
    const { agent, textsAt } = await boot('mixed', false)
    expect(textsAt(2, 'outer')).toContain('row 55 payload')
    expect(textsAt(3, 'read-after')).not.toContain('row 55 payload')
    expect(FOLD_STATS.get(agent.session)).toMatchObject({ expanded: 1, backedOff: [] })
  })

  it('replays successful nested expansion backoff, including a natively spilled dispatch log', async () => {
    const { agent } = await boot('twice', true, LOG)
    const seed = structuredClone(agent.session.snapshotEvents())
    expect(seed.some((event) => event.type === 'tool/code-dispatch' && JSON.stringify(event.data.content).includes('Full formatted result stored at:'))).toBe(true)
    const h = await nativeHarness([nativeTool('read-resumed', 'read', { file_path: 'again.txt' }), nativeText('done')], { config: { fold: { pinSteps: 0, spillPreviewMinBytes: 0 }, digest: { minChars: 1500 } } })
    live.push(h)
    h.ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'read', parameters: { file_path: { type: 'string' } }, execute: async () => [{ type: 'text', text: LOG }] }))
    const resumed = await h.ctx.agents.create({ sessionId: SessionId('replayed-code'), seed, agentOptions: { provider: 'native-mock', model: 'deterministic' } })
    await nativeSend(resumed.agent, 'read once more')
    expect(h.errors).toEqual([])
    expect(FOLD_STATS.get(resumed.agent.session)).toMatchObject({ expanded: 2, backedOff: ['read'] })
    const last = [...resumed.agent.session.snapshotEvents()].reverse().find((event) => event.type === 'tool/result' && isAppendSurfaceEvent(event))!
    expect(resumed.agent.session.snapshotEvents().some((event) => isReplacementSurfaceEvent(event) && event.sourceEventSeqs?.includes(last.seq))).toBe(false)
    expect(JSON.stringify(h.adapter.requests[1]!.messages)).toContain('tick 300 ')
  })

  it('scopes reused model call ids and nested sub-call ids to their durable call event', async () => {
    const h = await nativeHarness([
      nativeTool('read', 'read', { file_path: 'a.txt' }), code('outer', 'twice'), nativeText('done'),
      nativeTool('read', 'read', { file_path: 'b.txt' }), code('outer', 'second-turn'), nativeText('done'),
      code('outer', 'echo'), nativeText('done'),
    ], { config: { history: { keepRecentTurns: 3 }, fold: { pinSteps: 0, spillPreviewMinBytes: 0, backoffAfterExpansions: 10 }, digest: { minChars: 1500 } } })
    live.push(h)
    class ReusedRuntime extends RetrievalRuntime {
      async run(request: CodeRunRequest): Promise<CodeRunResult> {
        // This later unrelated result happens to equal the old retrieved bytes.
        if (request.program === 'echo') return { value: `[full result of read · turn 1 step 1 call 1]\n${BIG}`, logs: [] }
        return super.run(request)
      }
    }
    await h.ctx.plugin(ReusedRuntime)
    h.ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'read', parameters: { file_path: { type: 'string' } }, execute: async () => [{ type: 'text', text: BIG }] }))
    const { agent } = await h.ctx.agents.create({ sessionId: SessionId('reused-ids'), agentOptions: { provider: 'native-mock', model: 'deterministic' } })
    agent.ctx.tools.presentAs('both')
    await nativeSend(agent, 'first')
    await nativeSend(agent, 'second')
    expect(FOLD_STATS.get(agent.session)).toMatchObject({ expanded: 4, backedOff: [] })
    await nativeSend(agent, 'third')
    expect(h.errors).toEqual([])
    const latest = [...agent.session.snapshotEvents()].reverse().find((event) => event.type === 'tool/result' && isAppendSurfaceEvent(event))!
    expect(agent.session.snapshotEvents().some((event) => isReplacementSurfaceEvent(event) && event.sourceEventSeqs?.includes(latest.seq))).toBe(true)
  })

  it('does not grant a code result an exemption when successful retrieval was discarded', async () => {
    const { agent, textsAt } = await boot('discard', true, LOG)
    expect(textsAt(2, 'outer')).not.toContain('unrelated 300 ')
    expect(FOLD_STATS.get(agent.session)).toMatchObject({ expanded: 1, backedOff: [] })
  })

  it('does not count a failed expansion or exempt unrelated output from the same enclosing call', async () => {
    const { agent, textsAt } = await boot('failure', false)
    expect(textsAt(2, 'outer')).not.toContain('unrelated 300 ')
    expect(textsAt(3, 'read-after')).not.toContain('row 55 payload')
    expect(FOLD_STATS.get(agent.session)).toMatchObject({ expanded: 0, backedOff: [] })
  })
})
