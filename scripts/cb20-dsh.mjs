/**
 * cb20-dsh.mjs — ContextBench 20 题子集(与 2026-08-12 CB-20 同一组题)对一个跑着的 dsh
 * web profile 计量:召回 / 精度 / 用量。沿用旧 cb50-dsh.mjs 的方法论与评分(dsh-slice
 * 工作区 scripts/cb50-dsh.mjs),只改:题目由 id 清单选定、单臂、价目表更新、输出到
 * results/。判分与旧账本可比:同一评分函数、同一提示词、同一 20 分钟上限。
 *
 *   node scripts/cb20-dsh.mjs --base http://127.0.0.1:3084 --arm slice-fold \
 *        --ids results/20260902-cb20/cb20-ids.json --out results/20260902-cb20/cb20-slice-fold.json
 *
 *   pulled = 模型显式 FETCH 的文件与行区间(read/grep + bash 里的 sed/head/tail/cat/grep/git show)
 *   fileRecall = 命中的 gold 文件数 / gold 文件数
 *   spanRecall = 被任一读 span 覆盖的 gold 行数 / gold 总行数
 *   filePrecision = 命中文件数 / 读取文件总数
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
// a4 web 宿主要 cookie 认证:GET /?token=<launch token> 换 cookie,之后每个请求带 Cookie。

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i !== -1 ? args[i + 1] : d }
const BASE = opt('--base', 'http://127.0.0.1:3084')
const ARM = opt('--arm', 'slice-fold')
const IDS = JSON.parse(fs.readFileSync(opt('--ids', 'results/20260902-cb20/cb20-ids.json'), 'utf8'))
const OUT = opt('--out', `results/20260902-cb20/cb20-${ARM}.json`)
const LIMIT = Number(opt('--n', IDS.length))
const PY = opt('--py', '/private/tmp/claude-501/-Users-tongtao-Desktop/6984c665-bf21-4387-81ac-9e23eb47bc85/scratchpad/cbvenv/bin/python')
const CACHE = '/Users/tongtao/.cache/contextbench-repos'
const TURN_TIMEOUT_MS = 20 * 60 * 1000
// flash 谷时刊例(与 ab-summary 同口径)
const PRICE = { freshIn: 0.22 / 1e6, cacheIn: 0.007 / 1e6, out: 0.66 / 1e6 }
const TOKEN = opt('--token', process.env.DSH_LAUNCH_TOKEN ?? '')
let COOKIE = ''

async function mintCookie(base, token) {
  const res = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const sc = res.headers.get('set-cookie')
  if (!sc) throw new Error(`cookie mint failed: HTTP ${res.status}`)
  COOKIE = sc.split(';')[0]
}

// ---------------------------------------------------------------- dataset

function loadTasks(ids) {
  const code = `
import pyarrow.parquet as pq, json, sys
want = set(json.loads(sys.argv[1]))
rows = pq.read_table('${CACHE}/cb_verified.parquet').to_pylist()
by = {r['instance_id']: r for r in rows if r['instance_id'] in want}
out = []
for i in json.loads(sys.argv[1]):
    r = by.get(i)
    if r is None: continue
    out.append({'instance_id': r['instance_id'], 'repo': r['repo'], 'repo_url': r.get('repo_url'),
                'base_commit': r['base_commit'], 'problem': r['problem_statement'],
                'gold': json.loads(r['gold_context']) if isinstance(r['gold_context'], str) else r['gold_context']})
print(json.dumps(out))
`
  const out = execFileSync(PY, ['-c', code, JSON.stringify(ids)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(out.trim().split('\n').pop())
}

function workdirFor(task) {
  const key = `${task.repo.replace('/', '__')}@${task.base_commit.slice(0, 12)}`
  const dest = `${CACHE}/${key}`
  if (fs.existsSync(`${dest}/.git`)) return dest
  const mirror = `${CACHE}/_mirrors/${task.repo.replace('/', '__')}.git`
  if (!fs.existsSync(mirror)) {
    execFileSync('git', ['clone', '--bare', task.repo_url ?? `https://github.com/${task.repo}`, mirror], { stdio: 'pipe', timeout: 2400000 })
  }
  fs.mkdirSync(dest, { recursive: true })
  execFileSync('git', ['clone', '--shared', '--no-checkout', mirror, dest], { stdio: 'pipe', timeout: 900000 })
  execFileSync('git', ['-C', dest, 'checkout', '--detach', task.base_commit], { stdio: 'pipe', timeout: 900000 })
  const missing = execFileSync('git', ['-C', dest, 'status', '--porcelain'], { encoding: 'utf8', timeout: 300000 })
  const deleted = missing.split('\n').filter((l) => l.startsWith(' D') || l.startsWith('D ')).length
  if (deleted > 0) throw new Error(`incomplete checkout: ${deleted} files missing`)
  return dest
}

// ---------------------------------------------------------------- dsh driver

async function rpc(base, method, payload, rpcId) {
  const res = await fetch(`${base}/api/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: COOKIE },
    // typert 载荷契约:{ args: { <参数名>: 值 } };session/* 的参数名都是 request。
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request: payload } } }),
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 200)}`) }
  if (!body.result?.ok) throw new Error(`${method}: ${JSON.stringify(body.result?.error ?? body).slice(0, 300)}`)
  return body.result.value
}

async function runInstance(base, task, workdir) {
  // a4 typert 远程:端点 = namespace/method,POST /api/<endpoint>,body.method 必须与端点一致。
  const { sessionId } = await rpc(base, 'session/create', { cwd: workdir }, `c-${task.instance_id.slice(-8)}`)
  console.error(`  session ${sessionId} created`)
  const t0 = Date.now()
  await rpc(base, 'session/prompt', {
    requestId: `p-${task.instance_id.slice(-8)}-${t0}`,
    sessionId, mode: 'queue',
    content: [{ type: 'text', text: `${task.problem}\n\nFix this issue in the current repository. Read only what you need, make the minimal correct change, and verify it.` }],
  }, `p-${task.instance_id.slice(-8)}`)
  console.error(`  prompt accepted; polling session log`)
  // 事件:直接轮询磁盘上的会话日志(~/.dsh/sessions/<cwd 编码>/session-<id>/session.jsonl.zstd,
  // 宿主实时追加)。session/page 对已结束的会话报 not-found,不可靠。
  const deadline = t0 + TURN_TIMEOUT_MS
  let frames = []
  let logPath
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    if (!logPath) {
      try {
        // sessionId 本身已带 session- 前缀(a4);目录名就是它。
        const dirName = String(sessionId).startsWith('session-') ? String(sessionId) : `session-${sessionId}`
        const out = execFileSync('find', [`${process.env.HOME}/.dsh/sessions`, '-maxdepth', '2', '-type', 'd', '-name', dirName], { encoding: 'utf8' }).trim()
        if (out) { logPath = `${out.split('\n')[0]}/session.jsonl.zstd`; console.error(`  log: ${logPath}`) }
      } catch { /* not yet */ }
      if (!logPath) continue
    }
    if (!fs.existsSync(logPath)) continue
    let text
    try { text = execFileSync('zstd', ['-dc', logPath], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }) } catch { continue }
    frames = []
    for (const line of text.split('\n')) {
      if (!line) continue
      try { const e = JSON.parse(line); if (e && typeof e.type === 'string') frames.push(e) } catch { /* partial line */ }
    }
    if (frames.some((e) => e.type === 'turn/end')) break
  }
  if (!frames.some((e) => e.type === 'turn/end')) throw new Error('turn timeout')
  return { frames, wallMs: Date.now() - t0, sessionId }
}

// ---------------------------------------------------------------- trajectory extraction

const READ_TOOLS = new Set(['read_file', 'read', 'grep', 'search', 'code_grep'])
const EDIT_TOOLS = new Set(['edit', 'edit_file', 'write_file', 'str_replace', 'append_to_file', 'create_file', 'write'])

function bashReadSpans(command) {
  const spans = []
  const c = String(command ?? '')
  for (const m of c.matchAll(/sed\s+(?:-n\s*)?'?(\d+)\s*,\s*(\d+)?\s*p'?\s+(\S+)/g)) spans.push({ path: m[3], from: Number(m[1]), to: Number(m[2] ?? m[1]) })
  for (const m of c.matchAll(/head\s+(?:-n?\s*(\d+))\s+(\S+)/g)) spans.push({ path: m[2], from: 1, to: Number(m[1]) })
  for (const m of c.matchAll(/tail\s+-n\s+\+(\d+)\s+(\S+)/g)) spans.push({ path: m[2], from: Number(m[1]), to: Infinity })
  for (const m of c.matchAll(/(?:^|&&|\|\||;|\|)\s*(?:cat|nl|tac)\s+(?:-\S+\s+)*(\S+\.[a-zA-Z0-9]+)/g)) spans.push({ path: m[1], from: 1, to: Infinity })
  for (const m of c.matchAll(/(?:grep|rg)\s+(?:-\w+\s+)*-?n?\w*\s+['"][^'"]+['"]\s+(\S+\.[a-zA-Z0-9]+)/g)) spans.push({ path: m[1], from: 1, to: Infinity, grepHits: true })
  for (const m of c.matchAll(/git\s+show\s+[\w.-]+:(\S+\.[a-zA-Z0-9]+)/g)) spans.push({ path: m[1], from: 1, to: Infinity })
  return spans
}

function extractTrajectory(frames, workdir) {
  const pulled = new Map()
  const edited = new Set()
  let input = 0, output = 0, cacheRead = 0, reasoning = 0, steps = 0
  const rel = (p) => { p = String(p ?? ''); if (p.startsWith(workdir)) p = p.slice(workdir.length); return p.replace(/^\//, '') }
  const tools = {}
  for (const e of frames) {
    if (e.type === 'step/start') steps++
    if (e.type === 'assistant/message' && e.data?.usage) {
      input += e.data.usage.inputTokens ?? 0
      output += e.data.usage.outputTokens ?? 0
      cacheRead += e.data.usage.cacheReadTokens ?? 0
      reasoning += e.data.usage.reasoningTokens ?? 0
    }
    if (e.type !== 'tool/call') continue
    const d = e.data ?? {}
    const call = d.call ?? d
    const name = String(call.name ?? d.name ?? '')
    tools[name] = (tools[name] ?? 0) + 1
    let args = {}
    try { args = JSON.parse(call.arguments ?? d.arguments ?? '{}') } catch { /* non-json */ }
    const path = args.path ?? args.file_path ?? args.filePath
    if (READ_TOOLS.has(name) && path) {
      const p = rel(path)
      if (!pulled.has(p)) pulled.set(p, new Set())
      const offset = Number(args.offset ?? args.start_line ?? 1)
      const limit = Number(args.limit ?? args.count ?? 0)
      if (limit > 0) for (let i = offset; i < offset + limit; i++) pulled.get(p).add(i)
      else pulled.get(p).add(-1)
    }
    if (name === 'bash' && typeof args.command === 'string') {
      for (const span of bashReadSpans(args.command)) {
        const p = rel(span.path)
        if (!p || p.includes('*')) continue
        if (!pulled.has(p)) pulled.set(p, new Set())
        if (span.to === Infinity) {
          if (span.from === 1 && !span.grepHits) pulled.get(p).add(-1)
          else for (let i = span.from; i < span.from + 2000; i++) pulled.get(p).add(i)
        } else for (let i = span.from; i <= span.to; i++) pulled.get(p).add(i)
      }
    }
    if (EDIT_TOOLS.has(name) && path) edited.add(rel(path))
  }
  // steps:以 assistant/message 计(step/start 在新宿主里可能不落事件)
  const assistantSteps = frames.filter((e) => e.type === 'assistant/message').length
  return { pulled, edited: [...edited], usage: { input, output, cacheRead, reasoning }, steps: Math.max(steps, assistantSteps), tools }
}

// ---------------------------------------------------------------- scoring(与旧 runner 逐字相同的数学)

function score(traj, gold) {
  const pulledKeys = [...traj.pulled.keys()]
  const matchPulled = (goldFile) => pulledKeys.find((k) => goldFile.endsWith('/' + k) || goldFile === k)
  const goldFiles = new Set(gold.map((g) => g.file))
  const goldLines = gold.reduce((a, g) => a + (g.end_line - g.start_line + 1), 0)
  const matchedGoldFiles = new Set()
  let coveredLines = 0
  for (const g of gold) {
    const key = matchPulled(g.file)
    if (key === undefined) continue
    const spans = traj.pulled.get(key)
    matchedGoldFiles.add(g.file)
    if (spans.has(-1)) { coveredLines += g.end_line - g.start_line + 1; continue }
    for (let line = g.start_line; line <= g.end_line; line++) if (spans.has(line)) coveredLines++
  }
  const hitFiles = matchedGoldFiles.size
  const totalRead = traj.pulled.size || 1
  return { fileRecall: hitFiles / (goldFiles.size || 1), spanRecall: goldLines ? coveredLines / goldLines : 0, filePrecision: hitFiles / totalRead, filesRead: traj.pulled.size, goldFiles: goldFiles.size }
}

// ---------------------------------------------------------------- main

if (!TOKEN) throw new Error('--token <launch token> required (see host log: dsh web: http://…/?token=…)')
await mintCookie(BASE, TOKEN)
const tasks = loadTasks(IDS).slice(0, LIMIT)
console.error(`cb20 · ${tasks.length} tasks · arm ${ARM} · ${BASE}`)
const rows = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : []
const done = new Set(rows.filter((r) => !r.error).map((r) => r.id))
for (let i = 0; i < tasks.length; i++) {
  const task = tasks[i]
  if (done.has(task.instance_id)) { console.error(`[${ARM}] ${i + 1}/${tasks.length} skip (done)`); continue }
  let workdir
  try { workdir = workdirFor(task) } catch (e) { rows.push({ id: task.instance_id, error: `workdir: ${String(e).slice(0, 120)}` }); continue }
  try {
    const { frames, wallMs, sessionId } = await runInstance(BASE, task, workdir)
    const traj = extractTrajectory(frames, workdir)
    const s = score(traj, task.gold)
    const price = traj.usage.input * PRICE.freshIn + traj.usage.cacheRead * PRICE.cacheIn + traj.usage.output * PRICE.out
    const row = { id: task.instance_id, ...s, ...traj.usage, price, steps: traj.steps, wallMs, tools: traj.tools, edited: traj.edited, sessionId }
    const idx = rows.findIndex((r) => r.id === task.instance_id)
    if (idx >= 0) rows[idx] = row; else rows.push(row)
    console.error(`[${ARM}] ${i + 1}/${tasks.length} ${task.instance_id.slice(-12)} fileR=${s.fileRecall.toFixed(2)} spanR=${s.spanRecall.toFixed(2)} prec=${s.filePrecision.toFixed(2)} steps=${traj.steps} $${price.toFixed(4)} ${(wallMs / 1000).toFixed(0)}s`)
  } catch (e) {
    rows.push({ id: task.instance_id, error: String(e).slice(0, 160) })
    console.error(`[${ARM}] ${i + 1}/${tasks.length} ERROR: ${String(e).slice(0, 120)}`)
  }
  fs.writeFileSync(OUT, JSON.stringify(rows, null, 2))
}
const ok = rows.filter((r) => !r.error)
const avg = (k) => ok.reduce((a, r) => a + r[k], 0) / (ok.length || 1)
console.log(`\n=== CB20 · ${ARM} · ok ${ok.length}/${rows.length} ===`)
console.log(`fileRecall=${avg('fileRecall').toFixed(3)} spanRecall=${avg('spanRecall').toFixed(3)} precision=${avg('filePrecision').toFixed(3)}`)
console.log(`freshIn=${ok.reduce((a, r) => a + r.input, 0)} cacheIn=${ok.reduce((a, r) => a + r.cacheRead, 0)} out=${ok.reduce((a, r) => a + r.output, 0)} price=$${ok.reduce((a, r) => a + r.price, 0).toFixed(4)}`)
