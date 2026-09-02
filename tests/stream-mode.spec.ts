/**
 * v3 追加流:注入时摘要(纯函数)+ 契约测试(mock adapter,真实临时目录)。
 * 大结果进轨迹被折成紧凑视图且保留结构行;日志里全文可召回;宪法在钉住后作为
 * 追加消息进流,之后请求只增不改(前缀性);契约照常拦截。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmService, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import apply from '../src/index.js'
import { DEFAULT_DIGEST_POLICY, digestText } from '../src/slice/result-digest.js'
import { renderSealedStepPage } from '../src/recall-step.js'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.js'

const NOISE = Array.from({ length: 120 }, (_, i) => `INFO ${10000 + i} alpha bravo charlie delta echo foxtrot golf hotel india`).join('\n')
const NODE = `name = alpha\ntier = gold\nnext = beta.txt\n\n# LEGACY SERVICE DOSSIER\n${NOISE}\nowner: ops-team\n${NOISE}\n`

describe('digestText', () => {
  it('keeps head/tail/structured lines, elides noise with exact markers, and skips small or incompressible text', () => {
    const d = digestText(NODE, 'recall_step(1, 2)')
    expect(d.digested).toBe(true)
    expect(d.text).toContain('name = alpha')
    expect(d.text).toContain('next = beta.txt')
    expect(d.text).toContain('owner: ops-team')
    expect(d.text).toMatch(/…\[\+\d+ lines \/ \d+ chars\]…/)
    expect(d.text.length).toBeLessThan(NODE.length * 0.55)
    expect(digestText('short', 'x').digested).toBe(false)
    // 全是结构行:折不省 → 原样
    const allKv = Array.from({ length: 200 }, (_, i) => `k${i} = v${i}`).join('\n')
    expect(digestText(allKv, 'x').digested).toBe(false)
    // read 工具的 `N: ` 行号前缀不影响结构判定;行号原样保留;纯空行的间隔不出省略标记。
    const numbered = NODE.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n') + '\n\n(End of file - total 250 lines)'
    const dn = digestText(numbered, 'recall_step(1, 2)')
    expect(dn.digested).toBe(true)
    expect(dn.text).toMatch(/^1: name = alpha\n2: tier = gold\n3: next = beta.txt\n/)
    expect(dn.text).toContain('owner: ops-team')
    expect(dn.text).toContain('(End of file - total 250 lines)')
    expect(dn.text).not.toMatch(/\[\+1 lines \/ \d chars\]/)
    // 结构块上限:头部区外的连续结构行块只保留前 cap 行;头部区不受限。
    const block = Array.from({ length: 12 }, (_, i) => `  k${i}: v${i}`).join('\n')
    const withBlocks = `a = 1\nb = 2\n\n${NOISE}\n[appendix]\n${block}\n${NOISE}\nend = yes\n`
    const capped = digestText(withBlocks, 'x', { ...DEFAULT_DIGEST_POLICY, structuredBlockCap: 3 })
    expect(capped.text).toContain('[appendix]')          // 块首标记行是块的第 1 行
    expect(capped.text).toContain('  k1: v1')            // 第 3 行(cap 3)
    expect(capped.text).not.toContain('  k2: v2')        // 第 4 行起并入省略
    expect(capped.text).toContain('end = yes')
    const uncapped = digestText(withBlocks, 'x')
    expect(uncapped.text).toContain('  k11: v11')
  })
})

describe('stream mode', () => {
  it('digests large tool results in the trajectory, keeps full text recallable, appends the constitution once, enforces the contract', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stream-'))
    writeFileSync(join(root, 'MANIFEST.txt'), 'Rules:\n1. tier must be one of p1, p3, p7\n')
    mkdirSync(join(root, 'nodes')); writeFileSync(join(root, 'nodes/alpha.txt'), NODE)
    const RULES = JSON.stringify([{ id: 'R1', text: 'tier ∈ {p1,p3,p7}', predicate: { kind: 'field-enum', glob: 'out/*.svc', field: 'tier', values: ['p1', 'p3', 'p7'] } }])
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: 'MANIFEST.txt' }),                       // step 1(钉住,原样进流)
      textResponse(RULES),                                                                  // step 2 前的旁路提取
      toolCallResponse('c2', 'read', { file_path: 'nodes/alpha.txt' }),                    // step 2(非钉住,大结果被摘要)
      toolCallResponse('c3', 'write', { file_path: 'out/alpha.svc', content: 'tier = gold\n' }),  // step 3 → 弹回
      toolCallResponse('c4', 'write', { file_path: 'out/alpha.svc', content: 'tier = p3\n' }),    // step 4 → 通过
      textResponse('done'),
    ])
    const ctx = new Context()
    await ctx.plugin(LlmService); await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRegistry); await ctx.plugin(AgentRegistry)
    // 只钉住 step 1(MANIFEST):钉住步的读取原样进流,step 2 的大结果才会被摘要。
    await ctx.plugin(apply, { mode: 'stream', state: { pinSteps: 1, extractAtStep: 2, enforceFromStep: 1, extractRules: true, pushHits: 0, hotWindowSteps: 3 } })
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'r', parameters: { file_path: { type: 'string', required: true } }, execute: async ({ file_path }) => [{ type: 'text', text: readFileSync(join(root, file_path), 'utf8') }] }))
    ctx.tools.register(defineContentToolFixture({ name: 'write', description: 'w', parameters: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } }, execute: async ({ file_path, content }) => { mkdirSync(dirname(join(root, file_path)), { recursive: true }); writeFileSync(join(root, file_path), content); return [{ type: 'text', text: `wrote ${file_path}` }] } }))
    const handle = await ctx.agents.create({ sessionId: SessionId('stream-contract'), meta: { cwd: root }, agentOptions: { provider: 'mock', model: 'mock' } })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'migrate nodes/alpha.txt into out/ per MANIFEST.txt' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()

    expect(adapter.requests).toHaveLength(6)
    const msgs = (i: number) => JSON.stringify(adapter.requests[i]!.messages)
    // step 3 请求:alpha.txt 的结果已是摘要(噪音被省略,结构行保留),全文不在上下文里。
    expect(msgs(3)).toMatch(/…\[\+\d+ lines \/ \d+ chars\]…/)
    expect(msgs(3)).toContain('recall_step(1, 2) returns the full text')
    expect(msgs(3)).toContain('next = beta.txt')
    expect(msgs(3)).not.toContain('INFO 10050 alpha bravo')
    // 宪法作为追加消息出现,且含已提取规则。
    expect(msgs(3)).toContain('# CONSTITUTION')
    expect(msgs(3)).toContain('R1 [enforced]')
    // 前缀性:step 4 的请求以 step 3 的请求(去掉末尾新增)为前缀——消息只增不改。
    const m3 = adapter.requests[3]!.messages, m4 = adapter.requests[4]!.messages
    expect(m4.length).toBeGreaterThan(m3.length)
    expect(JSON.stringify(m4.slice(0, m3.length))).toBe(JSON.stringify(m3))
    // 契约:违规写入被回滚,最终为合规内容;日志里全文可召回。
    expect(readFileSync(join(root, 'out/alpha.svc'), 'utf8')).toBe('tier = p3\n')
    expect(handle.agent.session.snapshotEvents().filter((e) => e.type === 'slice/contract-bounce')).toHaveLength(1)
    const page = renderSealedStepPage(handle.agent.session.snapshotEvents(), 1, 2)
    expect(page).toContain('INFO 10050 alpha bravo')
    expect(handle.agent.session.snapshotEvents().filter((e) => e.type === 'slice/digest')).toHaveLength(1)
    rmSync(root, { recursive: true, force: true })
  })

  it('suspends a rule whose predicate overrules the model beyond the bounce budget, keeping the write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stream-budget-'))
    writeFileSync(join(root, 'MANIFEST.txt'), 'Rules:\n1. tier must be one of p1, p3, p7\n')
    // 提取错了:谓词只认 p1(规则原文允许 p3)。模型两次写 p3 → 第一次回滚,第二次放行 + 停用。
    const WRONG = JSON.stringify([{ id: 'R1', text: 'tier ∈ {p1,p3,p7}', predicate: { kind: 'field-enum', glob: 'out/*.svc', field: 'tier', values: ['p1'] } }])
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: 'MANIFEST.txt' }),
      textResponse(WRONG),
      toolCallResponse('c2', 'write', { file_path: 'out/a.svc', content: 'tier = p3\n' }),   // 弹回(预算 1)
      toolCallResponse('c3', 'write', { file_path: 'out/a.svc', content: 'tier = p3\n' }),   // 放行 + R1 停用
      toolCallResponse('c4', 'write', { file_path: 'out/b.svc', content: 'tier = p3\n' }),   // 谓词已移除:直接通过
      textResponse('done'),
    ])
    const ctx = new Context()
    await ctx.plugin(LlmService); await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRegistry); await ctx.plugin(AgentRegistry)
    await ctx.plugin(apply, { mode: 'stream', state: { pinSteps: 1, extractAtStep: 2, enforceFromStep: 1, extractRules: true, pushHits: 0, contractBounceBudget: 1 } })
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'r', parameters: { file_path: { type: 'string', required: true } }, execute: async ({ file_path }) => [{ type: 'text', text: readFileSync(join(root, file_path), 'utf8') }] }))
    ctx.tools.register(defineContentToolFixture({ name: 'write', description: 'w', parameters: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } }, execute: async ({ file_path, content }) => { mkdirSync(dirname(join(root, file_path)), { recursive: true }); writeFileSync(join(root, file_path), content); return [{ type: 'text', text: `wrote ${file_path}` }] } }))
    const handle = await ctx.agents.create({ sessionId: SessionId('stream-budget'), meta: { cwd: root }, agentOptions: { provider: 'mock', model: 'mock' } })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'migrate per MANIFEST.txt' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()

    const events = handle.agent.session.snapshotEvents()
    expect(events.filter((e) => e.type === 'slice/contract-bounce')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'slice/contract-suspend')).toHaveLength(1)
    expect(readFileSync(join(root, 'out/a.svc'), 'utf8')).toBe('tier = p3\n')
    expect(readFileSync(join(root, 'out/b.svc'), 'utf8')).toBe('tier = p3\n')
    // 放行的那次结果带宿主提示;第三次写入无任何提示(谓词已移除)。
    const m4 = JSON.stringify(adapter.requests[4]!.messages)
    expect(m4).toContain('rule check SUSPENDED for R1')
    const m5 = JSON.stringify(adapter.requests[5]!.messages)
    expect(m5.split('SUSPENDED').length).toBe(2)
    rmSync(root, { recursive: true, force: true })
  })
})
