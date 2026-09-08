import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { writeFile, mkdir } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
const host = createRequire(realpathSync(new URL('./node_modules/@deepseek-ai/dsh/package.json', import.meta.url)))
const llm = await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-llm')).href)
const sessions = await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-session')).href)
export const name = 'slice-packed-validation-runner'
export const inject = ['llm', 'agents', 'sessions', 'systemPrompt', 'tools']
const text = value => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: value },
  { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
  { type: 'finish', reason: { kind: 'stop' } },
]
const tool = (id, name, args) => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: llm.ToolCallId(id), name, arguments: JSON.stringify(args) } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]
export function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('dsh launcher appExit is required')
  const requests = []
  const errors = []
  const responses = [text('PACKED_FIRST_ANSWER'), tool('packed-recall', 'recall_turn', { turn: '1' }), text('PACKED_SECOND_ANSWER'), text('PACKED_THIRD_ANSWER'), text('PACKED_RESUMED_ANSWER')]
  class Adapter extends llm.LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ['text', 'image'], reasoning: { efforts: [{ id: llm.ReasoningEffortId('low'), name: 'Low' }], defaultEffort: llm.ReasoningEffortId('low') } } }
    async *stream(request) {
      const session = ctx.sessions.get(request.sessionId)
      assert.ok(session)
      assert.deepEqual(request.messages, session.deriveMessages())
      const events = structuredClone(session.snapshotEvents())
      const nodes = sessions.foldSurface(events).nodes
      assert.deepEqual(request.messages, nodes.map(seq => sessions.deriveEventMessage(events[seq])).filter(Boolean))
      const header = sessions.foldRequestHeader(events)
      assert.equal(request.system, header.system)
      assert.deepEqual(request.tools ?? [], header.tools ?? [])
      const joined = request.messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
      assert.equal(joined.split('PACKED_RUNTIME_SENTINEL').length, 2)
      requests.push({ request: structuredClone({ ...request, signal: undefined }), events })
      const response = responses.shift()
      assert.ok(response, 'unexpected extra model request')
      for (const chunk of response) yield chunk
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['packed-mock'], new Adapter()))
  ctx.effect(() => ctx.systemPrompt.context({ name: 'packed-runtime', order: 50, text: 'PACKED_RUNTIME_SENTINEL' }))
  ctx.on('agent/error', ({ error }) => { errors.push(String(error)) })
  async function run() {
    await ctx.get('loader')?.await()
    const handle = await ctx.agents.create({ sessionId: sessions.SessionId('packed-loader-session'), meta: { cwd: process.cwd() }, agentOptions: { provider: 'packed-mock', model: 'deterministic' } })
    for (const value of ['First packed request', 'Recall the first turn', 'Third packed request']) {
      handle.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
    }
    assert.deepEqual(errors, [])
    assert.equal(requests.length, 4)
    const before = structuredClone(handle.agent.session.snapshotEvents())
    assert.ok(before.some(sessions.isReplacementSurfaceEvent), 'the packed context plugin must compact history')
    assert.ok(before.every(event => sessions.KNOWN_SESSION_EVENT_TYPES.has(event.type)), 'no unknown required plugin events')
    const recallResult = before.find(event => event.type === 'tool/result' && event.data.message.content[0].toolCallId === 'packed-recall')
    assert.ok(recallResult && recallResult.data.message.content[0].isError !== true)
    assert.ok(JSON.stringify(recallResult).includes('First packed request'))
    await ctx.sessions.flush(handle.agent.session)
    await handle.dispose()
    const resumed = await ctx.agents.resume({ resumeSessionId: sessions.SessionId('packed-loader-session'), agentOptions: { provider: 'packed-mock', model: 'deterministic' } })
    assert.deepEqual(resumed.agent.session.snapshotEvents().slice(0, before.length), before)
    resumed.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Resume packed request' }], source: { kind: 'user' } }))
    await resumed.agent.whenIdle()
    await ctx.sessions.flush(resumed.agent.session)
    assert.equal(requests.length, 5)
    assert.deepEqual(errors, [])
    const finalEvents = structuredClone(resumed.agent.session.snapshotEvents())
    const summary = { status: 'passed', dsh: host('@deepseek-ai/dsh/package.json').version, requests: requests.length, turns: 4, persistenceReload: true, replacements: finalEvents.filter(sessions.isReplacementSurfaceEvent).length, errors }
    await mkdir(config.outputDir, { recursive: true })
    await writeFile(join(config.outputDir, 'requests.json'), JSON.stringify(requests, null, 2) + '\n')
    await writeFile(join(config.outputDir, 'events.json'), JSON.stringify(finalEvents, null, 2) + '\n')
    await writeFile(join(config.outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
    process.stdout.write(JSON.stringify(summary) + '\n')
    exit(0)
  }
  void run().catch(async error => {
    process.stderr.write((error.stack ?? String(error)) + '\n')
    await writeFile(join(config.outputDir, 'failure.txt'), error.stack ?? String(error)).catch(() => {})
    exit(1)
  })
}
