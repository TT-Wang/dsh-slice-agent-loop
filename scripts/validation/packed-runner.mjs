import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { writeFile, mkdir } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
/** @typedef {import('@deepseek-ai/dsh-agent').Agent} HostAgent */
/** @typedef {import('@deepseek-ai/dsh-system-prompt').default} HostSystemPrompt */
const host = createRequire(realpathSync(new URL('./node_modules/@deepseek-ai/dsh/package.json', import.meta.url)))
/** @type {typeof import('@deepseek-ai/dsh-llm')} */
const llm = await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-llm')).href)
/** @type {typeof import('@deepseek-ai/dsh-session')} */
const sessions = await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-session')).href)
export const name = 'slice-packed-validation-runner'
export const inject = ['llm', 'agents', 'sessions', 'systemPrompt', 'tools']
/** @param {string} value @returns {import('@deepseek-ai/dsh-llm').StreamChunk[]} */
const text = value => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: value },
  { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
  { type: 'finish', reason: { kind: 'stop' } },
]
/** @param {string} id @param {string} name @param {object} args @returns {import('@deepseek-ai/dsh-llm').StreamChunk[]} */
const tool = (id, name, args) => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: llm.ToolCallId(id), name, arguments: JSON.stringify(args) } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]
/** @param {import('@deepseek-ai/cordis').Context} ctx @param {{outputDir:string}} config */
export function apply(ctx, config) {
  const appExit = /** @type {((code:number)=>void)|undefined} */ (ctx.get('appExit'))
  if (appExit === undefined) throw new Error('dsh launcher appExit is required')
  const exit = appExit
  /** @type {{request: Omit<import('@deepseek-ai/dsh-llm').GenerateOptions,'signal'> & {signal:undefined}, events:readonly import('@deepseek-ai/dsh-session').SessionEvent[]}[]} */
  const requests = []
  /** @type {string[]} */
  const errors = []
  const responses = [text('PACKED_FIRST_ANSWER'), tool('packed-recall', 'recall_turn', { turn: '1' }), text('PACKED_SECOND_ANSWER'), text('PACKED_THIRD_ANSWER'), text('PACKED_RESUMED_ANSWER')]
  class Adapter extends llm.LlmAdapter {
    /** @param {string} provider @param {string} model @returns {Promise<import('@deepseek-ai/dsh-llm').LlmResolvedModelInfo>} */
    async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ['text', 'image'], reasoning: { efforts: [{ id: llm.ReasoningEffortId('high'), name: 'High' }, { id: llm.ReasoningEffortId('low'), name: 'Low' }], defaultEffort: llm.ReasoningEffortId('high') } } }
    /** @param {import('@deepseek-ai/dsh-llm').GenerateOptions} request */
    async *stream(request) {
      const session = request.sessionId === undefined ? undefined : ctx.sessions.get(request.sessionId)
      assert.ok(session)
      assert.equal(request.reasoningEffort, 'high', 'the shipped default must inherit the adapter effort, including after resume')
      assert.deepEqual(request.messages, session.deriveMessages())
      const events = structuredClone(session.snapshotEvents())
      const nodes = sessions.foldSurface(events).nodes
      assert.deepEqual(request.messages, nodes.map(seq => sessions.deriveEventMessage(events[seq])).filter(Boolean))
      const header = sessions.foldRequestHeader(events)
      assert.ok(header, 'every dispatched request must have a native header')
      assert.deepEqual(request.tools ?? [], header.tools ?? [])
      assert.equal(request.messages[0]?.role, 'system', 'the native system prompt must remain at the surface head')
      assert.equal(request.messages.filter(message => message.role === 'system').length, 1)
      const system = request.messages[0].content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      assert.ok(system.includes('Packed plugin validation fixture.'))
      assert.ok(system.includes('<slice>'))
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
    await (/** @type {{await(): Promise<void>}|undefined} */ (ctx.get('loader')))?.await()
    const handle = await ctx.agents.create({ sessionId: sessions.SessionId('packed-loader-session'), meta: { cwd: process.cwd() }, agentOptions: { provider: 'packed-mock', model: 'deterministic' } })
    for (const value of ['First packed request', 'Recall the first turn', 'Third packed request']) {
      handle.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
    }
    assert.deepEqual(errors, [])
    assert.equal(requests.length, 4)
    const before = structuredClone(handle.agent.session.snapshotEvents())
    /** @param {readonly import('@deepseek-ai/dsh-session').SessionEvent[]} events */
    const tapeNodes = events => sessions.foldSurface(events).nodes.filter(seq => {
      const event = events[seq]
      return sessions.isReplacementSurfaceEvent(event)
        && sessions.deriveEventMessage(event)?.content.some(block => block.type === 'text' && block.text.startsWith('[slice tape v1'))
    })
    // Default keepRecentTurns=0 seals turn 1 before turn 2's first request.
    // Check actual retained content and provenance, not just a marker anywhere
    // in the log: the same entry must remain visible through turn 3 and resume.
    const firstTape = tapeNodes(requests[1].events)
    assert.equal(firstTape.length, 1, 'the shipped default must seal the first completed turn')
    const firstEntrySeq = firstTape[0]
    const firstEntry = requests[1].events[firstEntrySeq]
    assert.ok(JSON.stringify(sessions.deriveEventMessage(firstEntry)).includes('PACKED_FIRST_ANSWER'))
    for (const { events } of requests.slice(1)) {
      assert.ok(tapeNodes(events).includes(firstEntrySeq), 'a sealed entry must remain on the surface')
      assert.deepEqual(events[firstEntrySeq], firstEntry, 'a sealed entry must remain frozen')
    }
    assert.equal(tapeNodes(before).length, 2, 'turn 2 must also seal before turn 3')
    assert.ok(before.every(event => sessions.KNOWN_SESSION_EVENT_TYPES.has(event.type)), 'no unknown required plugin events')
    const recallResult = before.find(event => event.type === 'tool/result' && event.data.message.content.some(block => block.type === 'tool-result' && block.toolCallId === 'packed-recall'))
    assert.ok(recallResult?.type === 'tool/result' && recallResult.data.message.content.some(block => block.type === 'tool-result' && block.toolCallId === 'packed-recall' && block.isError !== true))
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
    assert.ok(tapeNodes(finalEvents).includes(firstEntrySeq), 'resume must retain the original sealed entry')
    assert.deepEqual(finalEvents[firstEntrySeq], firstEntry)
    assert.equal(tapeNodes(finalEvents).length, 3, 'resume must seal the previous completed turn')
    const shim = await import(pathToFileURL(createRequire(new URL('./home/profiles/slice-packed/package.json', import.meta.url)).resolve('@dsh-external/dsh-slice-agent-loop/invariant')).href)
    assert.equal(typeof shim.apply, 'function', 'the exported invariant compatibility shim must load')
    const summary = { invariantSubpathLoaded: true, status: 'passed', dsh: host('@deepseek-ai/dsh/package.json').version, requests: requests.length, turns: 4, persistenceReload: true, adapterEffortInherited: true, nativeSystemMessageRetained: true, frozenTapeRetained: true, tapeEntries: tapeNodes(finalEvents).length, replacements: finalEvents.filter(sessions.isReplacementSurfaceEvent).length, errors }
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
