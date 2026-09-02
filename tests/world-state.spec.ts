/**
 * 世界状态循环的契约测试(mock adapter,真实临时目录,零 API):
 * 早期读取即宪法 → 旁路提取规则 → 账本记文件 → 违规写入被契约回滚并打回 → 修正后接受;
 * 请求形状 = [宪法+账本 种子] + 热窗 K 步原文。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmService, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import apply from '../src/index.js'
import { CONSTITUTION_HDR, STATE_HDR } from '../src/slice/state-ledger.js'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.js'

const RULES_JSON = JSON.stringify([
  { id: 'R1', text: 'tier must be one of p1, p3, p7', predicate: { kind: 'field-enum', glob: 'out/*.svc', field: 'tier', values: ['p1', 'p3', 'p7'] } },
  { id: 'R2', text: 'every svc starts with the migrated-by header', predicate: { kind: 'content-includes', glob: 'out/*.svc', needle: '# migrated-by: kestrel-v3' } },
  { id: 'R3', text: 'keep the tone formal' },
])
const BAD = 'name = alpha\ntier = gold\n'
const GOOD = '# migrated-by: kestrel-v3\nname = alpha\ntier = p1\n'

describe('world-state loop', () => {
  it('pins early reads, extracts rules, enforces the contract with revert, and keeps a bounded hot window', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'))
    writeFileSync(join(root, 'MANIFEST.txt'), 'Rules:\n1. tier must be one of p1, p3, p7\n2. every .svc file starts with "# migrated-by: kestrel-v3"\n')
    mkdirSync(join(root, 'nodes'))
    writeFileSync(join(root, 'nodes/a.txt'), 'name = alpha\ntier = gold\nnext = none\n')

    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: 'MANIFEST.txt' }),   // step 1 → 钉住
      toolCallResponse('c2', 'read', { file_path: 'nodes/a.txt' }),    // step 2 → 钉住(pinSteps=2)
      textResponse(RULES_JSON),                                        // step 3 组装前的旁路提取调用
      toolCallResponse('c3', 'write', { file_path: 'out/alpha.svc', content: BAD }),   // step 3 → 违规 → 回滚
      toolCallResponse('c4', 'write', { file_path: 'out/alpha.svc', content: GOOD }),  // step 4 → 通过
      textResponse('done'),                                            // step 5
    ])
    const ctx = new Context()
    await ctx.plugin(LlmService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(apply, { mode: 'state', state: { hotWindowSteps: 3, pinSteps: 2, pushHits: 0, extractRules: true } })
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'read',
      description: 'read a file',
      parameters: { file_path: { type: 'string', required: true } },
      execute: async ({ file_path }) => [{ type: 'text', text: readFileSync(join(root, file_path), 'utf8') }],
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'write',
      description: 'write a file',
      parameters: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } },
      execute: async ({ file_path, content }) => {
        mkdirSync(dirname(join(root, file_path)), { recursive: true })
        writeFileSync(join(root, file_path), content)
        return [{ type: 'text', text: `wrote ${file_path}` }]
      },
    }))
    const handle = await ctx.agents.create({
      sessionId: SessionId('world-state-contract'),
      meta: { cwd: root },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'migrate nodes/a.txt into out/ following MANIFEST.txt' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()

    // 旁路提取不得失败——失败原因会随断言消息浮出。
    const rulesEvEarly = handle.agent.session.snapshotEvents().find((e) => e.type === 'slice/state-rules')
    expect((rulesEvEarly?.data as { error?: string } | undefined)?.error).toBeUndefined()
    // 6 次调用:5 步主调用 + 1 次旁路提取。
    expect(adapter.requests).toHaveLength(6)
    const seedText = (i: number) => JSON.stringify(adapter.requests[i]!.messages[0])
    // step 3 的种子:宪法(含钉住的 MANIFEST 与已提取规则)+ 账本(含文件行)。
    expect(seedText(3)).toContain(CONSTITUTION_HDR.slice(0, 16))
    expect(seedText(3)).toContain('## pinned: MANIFEST.txt')
    expect(seedText(3)).toContain('R1 [enforced]')
    expect(seedText(3)).toContain('R3: keep the tone formal')
    expect(seedText(3)).toContain(STATE_HDR.slice(0, 13))
    expect(seedText(3)).toMatch(/MANIFEST\.txt · [0-9a-f]{12} · read @1/)
    // 旁路提取调用不带工具。
    expect(adapter.requests[2]!.tools ?? []).toHaveLength(0)

    // 契约:违规写入被回滚(文件最终是 GOOD),模型收到 CONTRACT VIOLATION。
    expect(readFileSync(join(root, 'out/alpha.svc'), 'utf8')).toBe(GOOD)
    const bounces = handle.agent.session.snapshotEvents().filter((e) => e.type === 'slice/contract-bounce')
    expect(bounces).toHaveLength(1)
    const v = (bounces[0]!.data as { violations: string[] }).violations.join(' ')
    expect(v).toContain('R1')
    expect(v).toContain('R2')
    expect(JSON.stringify(adapter.requests[4]!.messages)).toContain('CONTRACT VIOLATION')
    const rulesEv = handle.agent.session.snapshotEvents().find((e) => e.type === 'slice/state-rules')!
    expect((rulesEv.data as { enforced: number }).enforced).toBe(2)

    // 热窗:step 5 的请求 = 种子 + 步 2..4 的原文(各一条助手 + 一条结果)= 7 条;step 2 的 = 1 + 2。
    expect(adapter.requests[5]!.messages).toHaveLength(7)
    expect(adapter.requests[1]!.messages).toHaveLength(3)
    // 账本记下了回滚与最终写入。
    expect(seedText(5)).toMatch(/out\/alpha\.svc · - · reverted @3/)
    expect(seedText(5)).toMatch(/out\/alpha\.svc · [0-9a-f]{12} · write @4/)

    rmSync(root, { recursive: true, force: true })
    expect(existsSync(root)).toBe(false)
  })
})
