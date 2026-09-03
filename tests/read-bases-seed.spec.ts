/** 读过未改的文件 → 下一轮种子里出现 [base path @sha256:…](端到端,mock adapter + 真实临时目录)。 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmService, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import apply from '../src/index.js'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.js'

const turn = (agent: { followup: (m: unknown) => void; whenIdle: () => Promise<unknown>; session: { snapshotEvents: () => ReadonlyArray<{ type: string }> } }, text: string) => {
  const before = agent.session.snapshotEvents().filter((e) => e.type === 'turn/end').length
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  return new Promise<void>((resolve) => { const tick = () => { if (agent.session.snapshotEvents().filter((e) => e.type === 'turn/end').length > before) resolve(); else setTimeout(tick, 5) }; tick() })
}

describe('read bases end to end', () => {
  it('a file read in turn 1 rides into turn 2 as a [base] entry; with readBases off it does not', async () => {
    for (const enabled of [true, false]) {
      const root = mkdtempSync(join(tmpdir(), 'rb-'))
      writeFileSync(join(root, 'README.md'), '# proj\n\nrule: keep kv_ prefix\n')
      const adapter = new MockAdapter([
        toolCallResponse('c1', 'read', { file_path: 'README.md' }), textResponse('read it'),
        toolCallResponse('c2', 'read', { file_path: 'README.md' }), textResponse('second turn done'),
      ])
      const ctx = new Context()
      await ctx.plugin(LlmService); await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRegistry); await ctx.plugin(AgentRegistry)
      await ctx.plugin(apply, enabled ? { tape: { readBases: true, readBasesMinReads: 1, readPointer: true, anchor: 'base' } } : { tape: { readBases: false } })
      ctx.llm.registerAdapter(['mock'], adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'r', parameters: { file_path: { type: 'string', required: true } }, execute: async ({ file_path }) => [{ type: 'text', text: readFileSync(join(root, file_path), 'utf8') }] }))
      const handle = await ctx.agents.create({ sessionId: SessionId(`rb-${enabled}`), meta: { cwd: root }, agentOptions: { provider: 'mock', model: 'mock' } })
      await turn(handle.agent as never, 'look at the readme')
      await turn(handle.agent as never, 'now what does it say?')
      const turn2 = JSON.stringify(adapter.requests[2]!.messages)
      const turn2b = JSON.stringify(adapter.requests[3]!.messages)   // 第 2 轮第 2 步:整读结果已被换成指针
      if (enabled) {
        expect(turn2).toContain('[base README.md @sha256:')
        expect(turn2).toContain('rule: keep kv_ prefix')
        expect(turn2).toContain('current in tape')
        expect(turn2b).toContain('[read README.md · unchanged')
        expect(handle.agent.session.snapshotEvents().filter((e) => e.type === 'slice/read-pointer')).toHaveLength(1)
      } else {
        expect(turn2).not.toContain('[base README.md')
        expect(turn2b).not.toContain('[read README.md · unchanged')
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
})
