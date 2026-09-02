#!/usr/bin/env node
// 写手席全链实测:真 DSH 会话里,主 agent 从"用户一句话"走完
//   架构检查点 → emit_preset(后端)→ emit_app(scaffold 骨架)→ 写 PAGE-SPEC+页面
//   → verify_app(五门)→ deploy_app(上线)
// 这是接力棒契约的首次活体测试——S4 是旁路手工,这次是真会话。
// 用法:node bench/run-writer-seat.mjs [port] [preset-name]
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { openWireSession } from '../lib/wire.js'

const PORT = Number(process.argv[2] ?? 3097)
const NAME = process.argv[3] ?? 'note-wall'
const APPDIR = join(homedir(), 'apps', `${NAME}-ui`)

// 传输层走 lib/wire.js 共享客户端(BACKLOG 0.9:探协议定代际,两代同形)
const w = await openWireSession(PORT, { cwd: join(homedir(), 'apps'), questions: true })
const { sessionId, frames } = w
console.log('session:', sessionId, `(侧栏可旁观,host ${PORT})`)

const answerQuestion = async (q) => {
  const answers = (q.questions ?? []).map((item) => {
    const labels = (item.options ?? []).map((o) => String(o.label ?? ''))
    const pick = labels.find((l) => /推荐|Recommended|确认|按此|开始|继续|可以|是|好/.test(l)) ?? labels[0]
    return pick !== undefined
      ? { id: String(item.id), selected: [pick] }
      : { id: String(item.id), selected: [], custom: '按此装配,不用再问我。' }
  })
  const receipt = await w.answer(q, answers)
  console.log(receipt.accepted ? '  ↳ 已代答检查点(按此装配)' : `  !! 检查点应答被拒收:${receipt.detail ?? ''}`)
}

const PROMPT = `帮我装一个便签墙应用:随手贴便签(内容 + 颜色标签 红/黄/绿),能按标签筛选,便签要落库持久;要一张定制网页(便签墙形状,不是聊天框)。preset 名用 ${NAME},前端 scaffold 落在 ~/apps/${NAME}-ui。`
await w.prompt(PROMPT)
console.log('prompt 已入队;预算 30 分钟(写手要写真代码)')

const t0 = Date.now()
let scanned = 0
let lastActivity = Date.now()
let answered = 0
const seen = { emitPreset: false, emitApp: false, verifyApp: false, deployApp: false }
let finalText = ''

while (Date.now() - t0 < 30 * 60_000) {
  await new Promise((r) => setTimeout(r, 2000))
  while (scanned < frames.length) {
    const e = frames[scanned++]
    lastActivity = Date.now()
    if (e.type === '__question') { await answerQuestion(e); answered++ }
    else if (e.type === 'tool/call') {
      const n = String(e.data?.name ?? '')
      if (n === 'emit_preset') seen.emitPreset = true
      if (n === 'emit_app') seen.emitApp = true
      if (n === 'verify_app') seen.verifyApp = true
      if (n === 'deploy_app') seen.deployApp = true
      console.log(`  · 工具:${n}(t+${Math.round((Date.now() - t0) / 1000)}s)`)
    } else if (e.type === 'assistant/message') {
      const c = e.data?.message?.content
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.type === 'text' ? b.text : '').join('') : ''
      if (t) finalText = t
    } else if (e.type === 'turn/end') {
      console.log(`  ◦ turn/end(t+${Math.round((Date.now() - t0) / 1000)}s)`)
    }
  }
  // 完成判据:deploy_app 已调 且 最后一轮结束(无未归工具调用)
  const pendingTools = frames.filter((e) => e.type === 'tool/call').length - frames.filter((e) => e.type === 'tool/result').length
  const ended = frames.filter((e) => e.type === 'turn/end').length > 0 && pendingTools === 0
  if (seen.deployApp && ended && frames[frames.length - 1]?.type === 'turn/end') break
  // 停滞保释:8 分钟无事件且无未归工具
  if (Date.now() - lastActivity > 8 * 60_000 && pendingTools === 0) { console.log('!! 停滞保释'); break }
}

console.log('\n═══ 链路清单 ═══')
console.log('emit_preset:', seen.emitPreset ? '✓' : '✗', '| emit_app:', seen.emitApp ? '✓' : '✗', '| verify_app:', seen.verifyApp ? '✓' : '✗', '| deploy_app:', seen.deployApp ? '✓' : '✗', '| 检查点代答:', answered)
console.log('墙钟:', Math.round((Date.now() - t0) / 1000) + 's')
console.log('末段回复:', finalText.slice(0, 400))

// 独立复核(不信 agent 自述):页面 + 资产 + PAGE-SPEC + 面上直连
const page = await fetch(`http://127.0.0.1:${PORT}/assembler/ui/${NAME}`).catch(() => null)
const html = page?.ok ? await page.text() : ''
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
let assetsOk = refs.length > 0
for (const u of refs) {
  const ar = await fetch(new URL(u, `http://127.0.0.1:${PORT}/assembler/ui/${NAME}`)).catch(() => null)
  if (!ar?.ok) assetsOk = false
}
console.log('\n═══ 独立复核 ═══')
console.log('页面:', page?.status ?? 'DOWN', '| 资产', refs.length, '个', assetsOk ? '全通' : '有断链')
console.log('PAGE-SPEC:', existsSync(join(APPDIR, 'PAGE-SPEC.yml')) ? readFileSync(join(APPDIR, 'PAGE-SPEC.yml'), 'utf8').split('\n').filter((l) => l.includes('route:')).length + ' 个动作标注' : '缺')
console.log('selfcheck 台账:', existsSync(join(homedir(), '.dsh', '.agent-presets', NAME, 'parts.lock.yml')) ? 'preset 在' : 'preset 缺')
try { w.close() } catch { /* 已结束 */ }
process.exit(seen.deployApp && assetsOk ? 0 : 1)
