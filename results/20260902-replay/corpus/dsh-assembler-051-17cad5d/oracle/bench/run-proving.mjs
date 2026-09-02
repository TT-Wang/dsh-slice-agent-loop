#!/usr/bin/env node
// 试炼场驱动器(阶段 6 正赛):每题一个真 DSH 会话,支持**多段 prompt 序列**
// (生命周期题/增量题的需求变更用同一会话续发)。证据链沿 v5 全套(examSha/
// corpusDirs/finalTextComplete/hostEnv/帧面全录/全文入档),判卷走 proving-grade
// (v5 仪器 + 合奏层)。用法:node bench/run-proving.mjs [port] [P1,P3]
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { openWireSession } from '../lib/wire.js'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { audit, cleanSlate } from './lib/generalization-grade.mjs'
import { gradeProving } from './lib/proving-grade.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.argv[2] ?? 3097)
const ONLY = (process.argv[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const EXAM_PATH = join(REPO, 'bench', 'scenarios', 'proving-grounds.json')
const SPEC = JSON.parse(readFileSync(EXAM_PATH, 'utf8'))
const EXAM_SHA = createHash('sha256').update(readFileSync(EXAM_PATH)).digest('hex')
const INSIST = String(SPEC.checkpointPolicy?.C_insistText ?? '')
if (INSIST === '') throw new Error('考卷缺 checkpointPolicy.C_insistText')
const OUT_DIR = join(REPO, 'bench', 'results', '2026-08-27-proving-v1')
mkdirSync(OUT_DIR, { recursive: true })

for (const line of readFileSync(join(homedir(), '.dsh', '.env'), 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}

// P2 双语料(A/B 两本互异的虚构手册;不进 ~/apps 考场,gitignored)
const CORPUS_A = join(REPO, 'bench', '.pg-corpus', 'a')
const CORPUS_B = join(REPO, 'bench', '.pg-corpus', 'b')
mkdirSync(CORPUS_A, { recursive: true })
mkdirSync(CORPUS_B, { recursive: true })
writeFileSync(join(CORPUS_A, 'A-产品手册.md'), `# 澄音 A1 降噪耳机 手册(虚构)

## 保修
整机保修 **十二个月**;耳套为耗材不保。客服工号 CY-2210。

## 降噪档位
三档:通勤(-25dB)/办公(-18dB)/通透。切档长按左耳 2 秒。

## 充电
盒满电支持 4 次回充;快充 10 分钟听 2 小时。
`)
writeFileSync(join(CORPUS_B, 'B-产品手册.md'), `# 澄音 B2 骨传导耳机 手册(虚构)

## 保修
整机保修 **二十四个月**;含运动臂带。客服工号 CY-3345。

## 佩戴
不入耳,颞骨传导;IP67 防水,游泳不可用(蓝牙水下断连)。

## 续航
单次 9 小时;磁吸充电 1.5 小时充满。
`)

async function runOne(scn) {
  const t0 = Date.now()
  const cwdSnapshot = (() => { try { return readdirSync(join(homedir(), 'apps')).sort() } catch { return [] } })()
  // 传输层走 lib/wire.js 共享客户端(BACKLOG 0.9,两代同形):帧面全录/审批帧
  // 存原文/tokenUsage 走投影的纪律下沉进客户端,驱动器判定逻辑零改动。
  const w = await openWireSession(PORT, { cwd: join(homedir(), 'apps'), questions: true, projections: true })
  const { sessionId, frames, otherFrameCounts, approvalFrames } = w

  const questionTexts = []
  const answersGiven = []
  let answerRejected = false
  const answer = async (q) => {
    questionTexts.push(JSON.stringify(q.questions ?? []))
    const gapTerms = scn.expect?.coreGapTerms ?? []
    const answers = (q.questions ?? []).map((item) => {
      const itemText = JSON.stringify(item)
      if (scn.tier === 'boundary' && (gapTerms.length === 0 || gapTerms.some((t) => itemText.includes(t)))) {
        return { id: String(item.id), selected: [], custom: INSIST }
      }
      const labels = (item.options ?? []).map((o) => String(o.label ?? ''))
      const pick = labels.find((l) => /\(Recommended\)|[((]推荐[))]/.test(l)) ?? labels[0]
      return pick !== undefined ? { id: String(item.id), selected: [pick] } : { id: String(item.id), selected: [], custom: '按你的判断来,不用再问我。' }
    })
    answersGiven.push(answers)
    // 回执两代形状(旧 respond 顶层 {accepted} / 新 $events result.ok)由客户端归一
    const receipt = await w.answer(q, answers)
    if (!receipt.accepted) { answerRejected = true; console.log(`    !! ${scn.id} 应答被拒收:${receipt.detail ?? ''}`) }
  }

  const assistantTexts = []
  const tools = []
  const toolCalls = []
  const segments = []
  let scanned = 0
  let answered = 0
  let turnEnds = 0
  // 帧消化独立成函(审计⑦):段间发下一条 prompt 前先 drain 干净,已到的帧全部
  // 记到前段账上;结束判定按 turn/end **计数**(≥已发 prompt 数),迟到帧不冒充。
  const drain = async () => {
    while (scanned < frames.length) {
      const ev = frames[scanned++]
      lastActivityRef.t = Date.now()
      if (ev.type === '__question') { await answer(ev); answered++; console.log(`    ↳ 代答检查点(${scn.id})`) }
      else if (ev.type === 'tool/call') {
        const nm = String(ev.data?.name ?? '')
        tools.push(nm)
        toolCalls.push({ name: nm, seg: segRef.i, t: Math.round((Date.now() - t0) / 1000), args: String(ev.data?.arguments ?? '').slice(0, 200) })
        console.log(`    · ${scn.id} 工具:${nm}(t+${Math.round((Date.now() - t0) / 1000)}s)`)
      } else if (ev.type === 'assistant/message') {
        const c = ev.data?.message?.content
        const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? b.text : '')).join('') : ''
        if (t) assistantTexts.push(t)
      } else if (ev.type === 'turn/end') { turnEnds += 1 }
    }
  }
  const lastActivityRef = { t: Date.now() }
  const segRef = { i: 0 }
  // 多段 prompt:同一会话续发;每段独立预算与独立 ended 判定(sawTurnEnd 段内重置,
  // pending 用全会话累计——续段的工具悬挂同样要等)。
  for (let pi = 0; pi < scn.prompts.length; pi++) {
    const seg = scn.prompts[pi]
    await drain() // 审计⑦:先把上段迟到帧消化干净再发新段(此刻 segRef 仍指前段,迟到帧记前段账——复审 24)
    segRef.i = pi + 1
    const segT0 = Date.now()
    const text = String(seg.text).replace('CORPUS_A', CORPUS_A).replace('CORPUS_B', CORPUS_B)
    await w.prompt(text)
    console.log(`  ▶ ${scn.id} 段 ${pi + 1}/${scn.prompts.length}`)
    const budget = (seg.budgetMinutes ?? 25) * 60_000
    lastActivityRef.t = Date.now()
    let endReason = 'budget'
    while (Date.now() - segT0 < budget) {
      await new Promise((r) => setTimeout(r, 2000))
      await drain()
      const pending = tools.length - frames.filter((ev) => ev.type === 'tool/result').length
      // 结束按计数:本段结束 = 全会话 turn/end 数 ≥ 已发 prompt 数(迟到的上段
      // turn/end 只能把计数补到 pi,冒充不了 pi+1)。
      if (turnEnds >= pi + 1 && pending <= 0 && Date.now() - lastActivityRef.t > 8000) { endReason = 'ended'; break }
      if (Date.now() - lastActivityRef.t > 6 * 60_000) { endReason = pending > 0 ? 'stalled-pending' : 'stalled'; console.log(`    !! ${scn.id} 段 ${pi + 1} 停滞保释(${endReason})`); break }
    }
    segments.push({ i: pi + 1, elapsedSeconds: Math.round((Date.now() - segT0) / 1000), endReason })
    if (endReason !== 'ended' && pi < scn.prompts.length - 1) {
      console.log(`    !! ${scn.id} 段 ${pi + 1} 非自然结束(${endReason}),后续段照发(生活流:用户不等它喘匀)`)
    }
  }
  try { w.close() } catch { /* 已结束 */ }
  return {
    sessionId, cwdSnapshot, tools, toolCalls, segments,
    finalText: assistantTexts.join('\n\n'), finalTextComplete: true, insistText: INSIST,
    answered, answersGiven, answerRejected, questionTexts, otherFrameCounts, approvalFrames,
    elapsedSeconds: Math.round((Date.now() - t0) / 1000), usage: w.tokenUsage, usageCollected: w.tokenUsage !== null,
  }
}

// 预飞(审计⑭):DOM 门要浏览器手——零件依赖或 chromium 缺席会让 P1/P3/P6 整排
// verify 变 SKIPPED 连锁冤判。环境不齐不开考,报修法后退出。
const preflight = {
  browserPart: existsSync(join(REPO, 'generated', 'browser-automate', 'node_modules')),
  chromiumCache: existsSync(join(homedir(), 'Library', 'Caches', 'ms-playwright')),
  browserHandLive: false,
}
if (!preflight.browserPart || !preflight.chromiumCache) {
  console.error(`预飞失败:browser-automate 依赖 ${preflight.browserPart ? '✓' : '✗'} / chromium 缓存 ${preflight.chromiumCache ? '✓' : '✗'}——修法:cd generated/browser-automate && npm install && npx playwright install chromium。环境不齐不开考。`)
  process.exit(1)
}
// 复审 26:目录在 ≠ 浏览器拉得起(版本错配同样考场塌)。真拉一次浏览器手(约 3s)。
try {
  const { openBrowserHand } = await import('../lib/scaffold-dom.js')
  const hand = await openBrowserHand(REPO)
  await hand.close()
  preflight.browserHandLive = true
  console.log('预飞:浏览器手真拉一次 ✓')
} catch (error) {
  console.error(`预飞失败:浏览器手拉不起(${String(error?.message ?? error).slice(0, 160)})——修法同上。环境不齐不开考。`)
  process.exit(1)
}

// 考场隔离(审计⑤):v5 历史成品(g-b1-stock-ui 与 P1 同题材等)是"上届答案可见"
// 的污染面,proving 清场的 p*- 前缀够不到——搬进隔离区(不删:历史工件仍是档案)。
const quarantined = []
const qa = join(homedir(), 'apps', '.quarantine-pg')
const qp = join(homedir(), '.dsh', '.agent-presets', '.quarantine-pg')
mkdirSync(qa, { recursive: true })
mkdirSync(qp, { recursive: true })
try {
  for (const e of readdirSync(join(homedir(), 'apps'), { withFileTypes: true })) {
    if (e.isDirectory() && /^(g-|\.stage-g)/.test(e.name)) {
      try { renameSync(join(homedir(), 'apps', e.name), join(qa, e.name)); quarantined.push(`app:${e.name}`) } catch { /* 已隔离 */ }
    }
  }
} catch { /* 无 apps 目录 */ }
try {
  for (const e of readdirSync(join(homedir(), '.dsh', '.agent-presets'), { withFileTypes: true })) {
    if (e.isDirectory() && /^g-/.test(e.name)) {
      try { renameSync(join(homedir(), '.dsh', '.agent-presets', e.name), join(qp, e.name)); quarantined.push(`preset:${e.name}`) } catch { /* 已隔离 */ }
    }
  }
} catch { /* 无 preset 根 */ }
console.log(quarantined.length > 0 ? `考场隔离:${quarantined.length} 项历史工件移入 .quarantine-pg` : '考场隔离:无待隔离历史工件')

// 清场:命名空间前缀 + 语料回收(p*-;.pg-corpus 不在 ~/apps)
const todo = SPEC.scenarios.filter((s) => ONLY.length === 0 || ONLY.includes(s.id))
const wiped = cleanSlate(todo, { corpusDirs: [CORPUS_A, CORPUS_B] })
console.log(wiped.length > 0 ? `清场:${wiped.length} 项(${wiped.slice(0, 5).join(', ')}${wiped.length > 5 ? ' …' : ''})` : '清场:无残留')

const results = []
for (const scn of todo) {
  console.log(`\n═══ ${scn.id} [${scn.tier}] ${scn.name} ═══`)
  let run, aud, g
  const tq0 = Date.now()
  try {
    run = await runOne(scn)
    aud = await audit(scn, PORT)
    g = await gradeProving(scn, run, aud, { windowStartMs: tq0 - 120_000, windowEndMs: Date.now() + 120_000, corpusDirs: [CORPUS_A, CORPUS_B] })
  } catch (error) {
    run = { tools: [], finalText: String(error.message), elapsedSeconds: Math.round((Date.now() - tq0) / 1000), segments: [], sessionId: null, answered: 0 }
    aud = { error: String(error.message) }
    g = { lane: 'error', checks: [{ name: '驱动器', ok: false, detail: String(error.message) }], passed: 0, total: 1, verdict: 'ERROR' }
  }
  // 上游活性独立取证(P4:判卷时点名的锚点由驱动器亲自核,入档不判分)
  for (const e of scn.expect?.ensemble ?? []) {
    if (e.kind === 'upstream-alive') {
      try {
        const r = await fetch(String(e.url), { signal: AbortSignal.timeout(8000) })
        g.evidence = { ...(g.evidence ?? {}), [`upstream:${e.url}`]: `HTTP ${r.status}(${(await r.text()).slice(0, 60).replace(/\s+/g, ' ')})` }
      } catch (error) {
        g.evidence = { ...(g.evidence ?? {}), [`upstream:${e.url}`]: `不可达(环境因素,不冤判):${String(error?.message ?? error).slice(0, 80)}` }
      }
    }
  }
  console.log(`  → ${g.verdict} ${g.passed}/${g.total}(${run.elapsedSeconds}s,${(run.segments ?? []).length} 段)`)
  for (const c of g.checks) console.log(`     ${c.ok ? '✓' : '✗'} ${c.name}:${c.detail}`)
  const row = { id: scn.id, tier: scn.tier, name: scn.name, ...g, elapsedSeconds: run.elapsedSeconds, segments: run.segments ?? [], tools: run.tools, toolCalls: run.toolCalls ?? [], usage: run.usage ?? null, usageCollected: run.usageCollected === true, answersGiven: run.answersGiven ?? [], answerRejected: run.answerRejected === true, otherFrameCounts: run.otherFrameCounts ?? {}, approvalFrames: run.approvalFrames ?? [], cwdSnapshot: run.cwdSnapshot ?? [], audit: aud, sessionId: run.sessionId, questionTexts: run.questionTexts ?? [], finalText: run.finalText, finalTextComplete: run.finalTextComplete === true }
  results.push(row)
  writeFileSync(join(OUT_DIR, `${scn.id}.json`), JSON.stringify(row, null, 2))
}

console.log('\n═══ 试炼场汇总 ═══')
for (const r of results) console.log(`${r.id} [${r.tier}] ${r.verdict} ${r.passed}/${r.total}(${r.elapsedSeconds}s)`)
const total = results.filter((r) => r.verdict === 'PASS').length
console.log(`总计 ${total}/${results.length};战役判据:≥5/6 且失败题病因可定位`)
const hostEnv = (() => {
  const dir = join(homedir(), '.dsh', 'profiles', 'web')
  const profileShas = {}
  try { for (const f of readdirSync(dir).filter((x) => x.endsWith('.yml'))) profileShas[f] = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex') } catch { /* 取证尽力 */ }
  return { port: PORT, profileShas }
})()
writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify({ ranAt: new Date().toISOString(), examVersion: SPEC.version, examSha: EXAM_SHA, corpusDirs: [CORPUS_A, CORPUS_B], hostEnv, preflight, quarantined, wiped, results }, null, 2))
console.log(`结果落盘:${OUT_DIR.replace(REPO + '/', '')}`)
process.exit(0)
