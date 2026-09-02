#!/usr/bin/env node
// app 三档泛化战役驱动器:每题一个真 DSH 会话,模拟用户发一句话需求、代答架构
// 检查点、跟到底,然后**独立复核**(不信 agent 自述)。判据全部机器可查,与
// bench/scenarios/generalization-9.json 的预注册预期比对。
// 用法:node bench/run-generalization.mjs [port] [只跑某几题,如 A1,B3]
//
// 复核与判卷**一律来自 bench/lib/generalization-grade.mjs**,本文件不留私有副本。
// 病史(2026-08-25 第二次):第一次修"判卷器按目录名猜实例"时只改了离线重判器,
// 驱动器里那份原样留着,文档却写了"两者共用一份实现"——于是现场判分继续跑旧代码,
// 而我据此又报了一轮结论。**"两份实现必然走偏"这句话,我是在自己身上验的第二遍。**
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { openWireSession } from '../lib/wire.js'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { audit, cleanSlate, grade, hardenChecks } from './lib/generalization-grade.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.argv[2] ?? 3097)
const ONLY = (process.argv[3] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const EXAM_PATH = join(REPO, 'bench', 'scenarios', 'generalization-9.json')
const SPEC = JSON.parse(readFileSync(EXAM_PATH, 'utf8'))
// 考卷内容指纹(必修 8 后半):版本号闸挡不住"同版号改判据"——重判用 sha 双闸。
const EXAM_SHA = createHash('sha256').update(readFileSync(EXAM_PATH)).digest('hex')
// C 档坚持文案与考卷一份(记档项 19:驱动器私有文案会与考卷 checkpointPolicy 走偏)。
const INSIST = String(SPEC.checkpointPolicy?.C_insistText ?? '')
if (INSIST === '') throw new Error('考卷缺 checkpointPolicy.C_insistText——INSIST 文案必须以考卷为一份实现')
const OUT_DIR = join(REPO, 'bench', 'results', '2026-08-27-generalization-v5')
mkdirSync(OUT_DIR, { recursive: true })

// 凭证借读(值不打印)
for (const line of readFileSync(join(homedir(), '.dsh', '.env'), 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}

// A1 的语料:准备一份虚构手册(真语料,可核事实)。放 repo 内 gitignored 目录,
// **不进 ~/apps 考场**(建议修 10:语料躺考场里会进 cwdSnapshot/残留取证面,还赌
// 清场前缀闸永远绕开它;工具执行在 host 进程侧,读 repo 路径不受 agent 沙箱限制)。
const CORPUS = join(REPO, 'bench', '.g-corpus')
// 必修 21(差量复审):语料迁出考场时旧副本 ~/apps/g-corpus 留在了盘上——它不在
// 任何 artifactName 命名空间,清场前缀闸永远删不到;下轮 agent 撞见同内容语料从
// 它入库,docsDir 绑不上新 corpusDirs → 诚实交付被 kbBound 冤判。每轮无条件清除
// (幂等;也防其他会话把它写回来)。
rmSync(join(homedir(), 'apps', 'g-corpus'), { recursive: true, force: true })
mkdirSync(CORPUS, { recursive: true })
writeFileSync(join(CORPUS, '产品手册.md'), `# 星轨 X1 净水器 用户手册(虚构样例)

## 保修

星轨 X1 整机保修期为 **十八个月**,滤芯为消耗件不在保修范围。
保修需提供购买凭证,联系客服工号 SX-4471。

## 换芯周期

前置 PP 棉建议每 3 个月更换;RO 反渗透膜建议每 24 个月更换。
换芯后需长按机身「冲洗」键 5 秒复位计数器。

## 常见故障

- 出水变慢:多为 PP 棉堵塞,先换前置滤芯。
- 持续报警红灯:水压不足,检查进水阀是否全开。
`)

/** 跑一题:开会话 → 发需求 → 代答检查点 → 跟到静默 → 收集轨迹。 */
async function runOne(scn) {
  const t0 = Date.now()
  // 考场快照(混杂变量入档,审计发现 11:cwd 是生活环境——判卷不用,复盘要查)
  const cwdSnapshot = (() => { try { return readdirSync(join(homedir(), 'apps')).sort() } catch { return [] } })()
  // 传输层走 lib/wire.js 共享客户端(BACKLOG 0.9):探协议定代际,新 wire 走
  // cookie + session/follow + $events,旧 wire 走点号端点 + events.mux。帧面全录、
  // 审批帧存原文(建议修 14)、tokenUsage 走投影不走会话事件(假零 13 连教训)——
  // 这些纪律全部下沉进客户端,两代同形,本驱动器判定逻辑零改动。
  const w = await openWireSession(PORT, { cwd: join(homedir(), 'apps'), questions: true, projections: true })
  const { sessionId, frames, otherFrameCounts, approvalFrames } = w

  const questionTexts = []
  const answersGiven = []
  let answerRejected = false
  const answer = async (q) => {
    // 检查点问题原文 = 缺口是否被暴露的证据(判卷要用);**全文入档,不截断**
    // (审计发现 13:截断咬掉过 C 档档案,重判证据劣于现场)。
    questionTexts.push(JSON.stringify(q.questions ?? []))
    const gapTerms = scn.expect?.coreGapTerms ?? []
    const answers = (q.questions ?? []).map((item) => {
      const itemText = JSON.stringify(item)
      // C 档 INSIST 只投缺口题;治理/命名类子问题走常规策略(审计发现 2:一刀切答非所问)。
      if (scn.tier === 'C' && (gapTerms.length === 0 || gapTerms.some((t) => itemText.includes(t)))) {
        return { id: String(item.id), selected: [], custom: INSIST }
      }
      const labels = (item.options ?? []).map((o) => String(o.label ?? ''))
      // 显式推荐标记 > 首选项;旧关键词正则会把「砍掉此需求(推荐)」当推荐、把「是/好」
      // 当同意(审计发现 1:约等于带噪声的选第一项)——只认整词推荐标签。
      // 必修 7:旧式 `(推荐)` 右支是捕获组=裸词命中,「不推荐」也算推荐;真实标签是
      // 全角括号。只认整词括号推荐(两种括号皆认)。
      const pick = labels.find((l) => /\(Recommended\)|[((]推荐[))]/.test(l)) ?? labels[0]
      return pick !== undefined ? { id: String(item.id), selected: [pick] } : { id: String(item.id), selected: [], custom: '按你的判断来,不用再问我。' }
    })
    answersGiven.push(answers)
    // 回执核验(审计发现 5:host 对无效应答**静默拒收**——驱动器故障与 agent 失败
    // 必须分开记账,否则死锁被记成"agent 慢")。两代回执形状差异(旧 respond 顶层
    // {accepted} / 新 $events 的 result.ok)由客户端归一成 {accepted, detail}。
    const receipt = await w.answer(q, answers)
    if (!receipt.accepted) { answerRejected = true; console.log(`    !! ${scn.id} 检查点应答被拒收:${receipt.detail ?? ''}`) }
  }

  const prompt = scn.prompt.replace('CORPUS_DIR', CORPUS)
  await w.prompt(prompt)

  const budget = (scn.budgetMinutes ?? 25) * 60_000
  let scanned = 0, lastActivity = Date.now(), answered = 0, sawTurnEnd = false
  const assistantTexts = []
  const tools = []
  const toolCalls = []
  let endReason = 'budget'
  // usage:host 无 token_usage/usage 会话事件(协议挖掘证实,旧采集是死代码,
  // 13 题假零)。诚实记 null;真计量走 session/projection 的 tokenUsage(v5)。
  while (Date.now() - t0 < budget) {
    await new Promise((r) => setTimeout(r, 2000))
    while (scanned < frames.length) {
      const e = frames[scanned++]
      lastActivity = Date.now()
      if (e.type === '__question') { await answer(e); answered++; console.log(`    ↳ 代答检查点(${scn.id})`) }
      else if (e.type === 'tool/call') {
        const name = String(e.data?.name ?? '')
        tools.push(name)
        toolCalls.push({ name, t: Math.round((Date.now() - t0) / 1000), args: String(e.data?.arguments ?? '').slice(0, 200) })
        console.log(`    · ${scn.id} 工具:${name}(t+${Math.round((Date.now() - t0) / 1000)}s)`)
      } else if (e.type === 'assistant/message') {
        const c = e.data?.message?.content
        const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? b.text : '')).join('') : ''
        if (t) assistantTexts.push(t)
      } else if (e.type === 'turn/end') { sawTurnEnd = true }
    }
    const pending = tools.length - frames.filter((e) => e.type === 'tool/result').length
    // 结束判定不再依赖"最后一帧是 turn/end"(log-only 事件会垫尾,审计发现 4/协议挖掘)。
    const ended = sawTurnEnd && pending <= 0
    if (ended && Date.now() - lastActivity > 8000) { endReason = 'ended'; break }
    // 保释与 pending 解耦:真停滞即保释(工具悬挂时旧逻辑把保释自己锁死,必烧满预算)。
    if (Date.now() - lastActivity > 6 * 60_000) { endReason = pending > 0 ? 'stalled-pending' : 'stalled'; console.log(`    !! ${scn.id} 停滞保释(${endReason})`); break }
  }
  try { w.close() } catch { /* 已结束 */ }
  // finalText = 全部 assistant 文本按序拼接,**全文,不截断**(审计发现 13:只留
  // 末条 + 截 1200 已实际咬掉 C 档档案;边界声明常写在倒数第二条)。
  // finalTextComplete(必修 8):聚合不设上限,如实打"全文完整"戳——重判器凭它
  // 免除 1200 字截断时代的降级推定(旧推定在 v5 全文档案上恒真,等于永不复算)。
  return { sessionId, cwdSnapshot, tools, toolCalls, finalText: assistantTexts.join('\n\n'), finalTextComplete: true, insistText: INSIST, answered, answersGiven, answerRejected, questionTexts, otherFrameCounts, approvalFrames, endReason, elapsedSeconds: Math.round((Date.now() - t0) / 1000), usage: w.tokenUsage, usageCollected: w.tokenUsage !== null }
}


// 每轮开跑前清场:上轮残留的同名 preset/app 会触发"同名复用"(正常特性),让这轮
// 零重建、也不再验收——实录:A2 二轮 132s 未验收,就是被上轮残留复用了。
//
// **只清这轮真要跑的题**(2026-08-25 实录:只跑 A 档时清场把 B/C 的工件一起抹了,
// 而离线重判是照盘上现状重算的——于是 B1/B2 被重判成"什么都没交",凭空多出两条
// 假回归。清场的作用域必须跟着 ONLY 走)。
const todo = SPEC.scenarios.filter((s) => ONLY.length === 0 || ONLY.includes(s.id))
const wiped = cleanSlate(todo, { corpusDirs: [CORPUS] })
console.log(wiped.length > 0 ? `清场:删除 ${wiped.length} 个上轮残留(${wiped.slice(0, 4).join(', ')}${wiped.length > 4 ? ' …' : ''})` : '清场:无残留')

// ── 主循环 ────────────────────────────────────────────────────────────────────
const results = []
for (const scn of todo) {
  console.log(`\n═══ ${scn.id} [${scn.tier}] ${scn.name} ═══`)
  let run, aud, g
  try {
    const tq0 = Date.now()
    run = await runOne(scn)
    aud = await audit(scn, PORT)
    const hard = hardenChecks(scn, aud, { windowStartMs: tq0 - 120_000, windowEndMs: Date.now() + 120_000, corpusDirs: [CORPUS] })
    g = grade(scn, run, aud, hard)
    g.hardEvidence = hard.evidence
  } catch (error) {
    run = { tools: [], finalText: String(error.message), elapsedSeconds: 0, usage: {}, sessionId: null, answered: 0 }
    aud = { error: String(error.message) }
    g = { lane: 'error', checks: [{ name: '驱动器', ok: false, detail: String(error.message) }], passed: 0, total: 1, verdict: 'ERROR' }
  }
  console.log(`  → ${g.verdict} ${g.passed}/${g.total}(${run.elapsedSeconds}s)`)
  for (const c of g.checks) console.log(`     ${c.ok ? '✓' : '✗'} ${c.name}:${c.detail}`)
  const row = { id: scn.id, tier: scn.tier, name: scn.name, ...g, elapsedSeconds: run.elapsedSeconds, tools: run.tools, toolCalls: run.toolCalls ?? [], usage: run.usage ?? null, usageCollected: run.usageCollected === true, endReason: run.endReason ?? null, answersGiven: run.answersGiven ?? [], answerRejected: run.answerRejected === true, otherFrameCounts: run.otherFrameCounts ?? {}, approvalFrames: run.approvalFrames ?? [], cwdSnapshot: run.cwdSnapshot ?? [], audit: aud, sessionId: run.sessionId, questionTexts: run.questionTexts ?? [], finalText: run.finalText, finalTextComplete: run.finalTextComplete === true }
  results.push(row)
  writeFileSync(join(OUT_DIR, `${scn.id}.json`), JSON.stringify(row, null, 2))
}

// ── 汇总 ──────────────────────────────────────────────────────────────────────
const byTier = results.reduce((m, r) => { (m[r.tier] ??= []).push(r); return m }, {})
console.log('\n═══ 三档汇总 ═══')
for (const [tier, list] of Object.entries(byTier)) {
  console.log(`${tier} 档:${list.filter((r) => r.verdict === 'PASS').length}/${list.length} PASS — ${list.map((r) => `${r.id}:${r.verdict}`).join(' ')}`)
}
const total = results.filter((r) => r.verdict === 'PASS').length
console.log(`\n总计 ${total}/${results.length};Σ墙钟 ${results.reduce((n, r) => n + r.elapsedSeconds, 0)}s`)
// 战役级序数断言(A 档命题"更快贴形"的非 Goodhart 量纲:档间排序,不设单题门槛)
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length === 0 ? null : a[Math.floor(a.length / 2)] }
const mA = median(results.filter((r) => r.tier === 'A').map((r) => r.elapsedSeconds))
const mB = median(results.filter((r) => r.tier === 'B').map((r) => r.elapsedSeconds))
const ordinal = mA !== null && mB !== null ? { medianA: mA, medianB: mB, pass: mA < mB } : null
if (ordinal !== null) console.log(`档间序数(A<B 墙钟中位数):${ordinal.pass ? '✓' : '✗'} A=${mA}s B=${mB}s`)
// hostEnv(建议修 9 的诚实版):沙箱模式无法从驱动器侧直接断言——如实记 profile
// 字节指纹与端口,复盘时凭 sha 回指"当时 host 是哪份配置",不假装断言了沙箱。
const hostEnv = (() => {
  const dir = join(homedir(), '.dsh', 'profiles', 'web')
  const profileShas = {}
  try { for (const f of readdirSync(dir).filter((x) => x.endsWith('.yml'))) profileShas[f] = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex') } catch { /* 取证尽力 */ }
  return { port: PORT, profileShas }
})()
writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify({ ranAt: new Date().toISOString(), examVersion: SPEC.version, examSha: EXAM_SHA, corpusDirs: [CORPUS], hostEnv, wiped, ordinal, results }, null, 2))
console.log(`结果落盘:${OUT_DIR.replace(REPO + '/', '')}`)
process.exit(0)
