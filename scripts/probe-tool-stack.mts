/** 只引导完整工具栈(fs + search + bash 级联 + slice),不调模型:验证插件能挂、列出注册工具。 */
import { Context } from '@deepseek-ai/cordis'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import apply from '../src/index.ts'
const H = join(homedir(), '.dsh', 'source', 'current')
const pkg = (p: string) => import(join(H, 'packages', ...p.split('/'), 'src', 'index.ts'))
const workdir = mkdtempSync(join(tmpdir(), 'stack-'))
const ctx = new Context()
await ctx.plugin(LlmService); await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRegistry); await ctx.plugin(AgentRegistry)
const step = async (label: string, fn: () => Promise<unknown>) => { try { await fn(); console.log('ok  ', label) } catch (e) { console.log('FAIL', label, '→', (e as Error).message.split('\n')[0]) } }
await step('fs-local', async () => ctx.plugin((await pkg('fs/fs-local')).default, { cwd: workdir }))
await step('tool-fs', async () => ctx.plugin(await pkg('fs/tool-fs'), {}))
await step('subprocess', async () => ctx.plugin((await pkg('subprocess/subprocess')).default))
await step('tool-fs-search', async () => ctx.plugin(await pkg('fs/tool-fs-search'), { sampleOverCapGlobResults: false }))
await step('bash-local', async () => ctx.plugin((await pkg('shell/bash-local')).default, { cwd: workdir }))
await step('shell-env', async () => ctx.plugin(await pkg('shell/shell-env'), {}))
await step('tool-bash', async () => ctx.plugin(await pkg('shell/tool-bash'), { enableRunInBackground: false }))
await step('slice plugin (state)', async () => ctx.plugin(apply, { mode: 'state' }))
const names = (ctx.tools as unknown as { list?: () => Array<{ name: string }>; names?: () => string[] })
let listed: string[] = []
try { listed = (names.list?.() ?? []).map((t) => t.name) } catch {}
if (listed.length === 0) { try { listed = names.names?.() ?? [] } catch {} }
console.log('registered tools:', listed.length ? listed.join(', ') : '(registry has no list API — see below)')
process.exit(0)
