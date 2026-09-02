#!/usr/bin/env node
/**
 * 索引流水线 CLI —— 把"收录一个新开源库"压成命令序列。
 *
 * 设计给 agent 调用:CLI 只做确定性环节(取源、出工单、装依赖、质检、登记),
 * "切分能力点 + 写适配代码"这一智能环节留给调用方(调用方本来就是 LLM)。
 * 每个子命令最后一行输出一个 JSON 判定,机器可判读;质检门在流水线里:
 * verify 不过,register 直接拒绝。
 *
 * 用法:
 *   node scripts/index-add.mjs scaffold <owner/repo> --pkg <npm包名> [--id <零件id>]
 *       取 npm 元数据(版本/许可证)、浅取上游源码到 .cache/upstream/<id>、
 *       生成 generated/<id>/{package.json,.index-meta.json,WORK-ORDER.md} 骨架。
 *       然后由调用方按工单写 index.js + smoke.mjs。
 *   node scripts/index-add.mjs verify <id>
 *       npm install → 跑 smoke.mjs(exit 0 必须)→ 独立 listTools 实探 →
 *       写 index/reports/<id>.json。
 *   node scripts/index-add.mjs register <id>
 *       verify 报告必须存在且通过;幂等登记 index/catalog.yml +
 *       capabilities.yml 的 mcp-servers 段。
 *   node scripts/index-add.mjs check-all
 *       全量复检:跑每个 generated/<id>/smoke.mjs,任一失败退出非零。
 */
import { execSync, spawnSync } from 'node:child_process'
import yaml from 'js-yaml'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openWireSession } from '../lib/wire.js'
import { inventoryEndpoints, specBaseUrl } from './spec-intake.mjs'
import { assertYaml, s } from './yaml-write.mjs'

const yamlParse = (t) => yaml.load(t)

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const [cmd, target, ...rest] = process.argv.slice(2)
const flags = {}
for (let i = 0; i < rest.length; i += 2) {
  if (rest[i]?.startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1]
}

/**
 * Env for spawned part processes and smokes.
 *
 * Node's global `fetch` ignores HTTP(S)_PROXY unless NODE_USE_ENV_PROXY=1, so
 * behind a proxy a healthy service part fails with a bare "fetch failed"
 * while curl from the same shell succeeds. Forcing the flag here fixes every
 * network part's smoke at once (the runtime side is handled in scrubbedEnv).
 */
function partEnv() {
  const env = { ...process.env }
  const proxied = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((k) => env[k])
  if (proxied && env.NODE_USE_ENV_PROXY === undefined) env.NODE_USE_ENV_PROXY = '1'
  // Silence the experimental-proxy warning: it lands on stderr of every part
  // we spawn, where it reads as part output and can trip a smoke that checks
  // its own process's stderr (observed: rss-parse).
  if (env.NODE_USE_ENV_PROXY === '1' && env.NODE_NO_WARNINGS === undefined) env.NODE_NO_WARNINGS = '1'
  // Local, gitignored .env supplies deployment contact facts some services
  // demand (SEC's UA, Crossref/OpenAlex polite-pool mailtos). Not credentials
  // — no permissions attach — but still per-deployment, so they live outside
  // the source. Ambient values win: an explicit export beats the file.
  const envFile = join(REPO, '.env')
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (m === null || line.trimStart().startsWith('#')) continue
      const key = m[1]
      if (env[key] !== undefined) continue
      env[key] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return env
}

const die = (msg) => {
  console.log(JSON.stringify({ ok: false, error: msg }))
  process.exit(1)
}
const out = (obj) => {
  console.log(JSON.stringify({ ok: true, ...obj }))
}

/**
 * Parse `--requires-secret "ENV:purpose; ENV2:purpose"`.
 *
 * Entries split on SEMICOLONS, not commas: a purpose is prose written for a
 * human operator and prose contains commas ("可选,匿名亦可用" produced a
 * bogus variable named 匿名亦可用 the first time this ran). An entry with no
 * colon is a bare variable name. Only strings that look like env vars are
 * accepted, so a malformed line is dropped loudly rather than registered as
 * a credential nobody can ever configure.
 */
function parseRequiredSecrets(raw) {
  return String(raw ?? '')
    .split(';')
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .map((x) => {
      const i = x.indexOf(':')
      return i === -1 ? { env: x.trim() } : { env: x.slice(0, i).trim(), purpose: x.slice(i + 1).trim() }
    })
    .filter((x) => {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(x.env)) return true
      console.error(`[index-add] 忽略非法凭证声明(变量名不合法):${JSON.stringify(x.env)}——条目用分号分隔,用途里可以带逗号`)
      return false
    })
}

/**
 * Roots for one catalog: the public one, or a client's private one.
 *
 * A client's parts live in catalogs/<client>/ with their own generated/,
 * index/ and capabilities.yml. Isolation is the point — ACME's internal API
 * part must never surface in a different client's assembly — and it comes
 * from separate FILES rather than a filter, so there is no flag anyone can
 * forget that would leak one client's surface into another's.
 */
function catalogRoot(client) {
  return client === undefined || client === '' ? REPO : join(REPO, 'catalogs', client)
}

// ── dedup gate ─────────────────────────────────────────────────────────────
// 目录是能力目录不是库目录:同一上游库/同一 npm 包不允许收两次。这里挡的是
// 机械重复(同库换个 id 再收);能力级重叠(不同库、同能力点)由调用方对着
// `coverage` 子命令的覆盖图判定——那是语义判断,属于智能环节。
function dedupGate({ id, pkg, repoSlug }) {
  const gen = join(REPO, 'generated')
  if (existsSync(join(gen, id, '.index-meta.json'))) return `id "${id}" 已存在(generated/${id})`
  for (const d of existsSync(gen) ? readdirSync(gen) : []) {
    const pj = join(gen, d, 'package.json')
    if (!existsSync(pj)) continue
    const deps = JSON.parse(readFileSync(pj, 'utf8')).dependencies ?? {}
    if (pkg in deps) return `npm 包 "${pkg}" 已被零件 "${d}" 收录`
  }
  // Parse, don't grep: catalog.yml quotes its scalars, so `^  repo: owner/name$`
  // matched the entries written before quoting and silently missed every one
  // written after — a dedup gate that only guards history is not a gate.
  if (loadCatalogEntries().some((e) => e.repo === repoSlug || e.service === repoSlug)) {
    return `上游 repo/服务 "${repoSlug}" 已在 index/catalog.yml`
  }
  return null
}

/** index/catalog.yml as data. Missing file is normal (a fresh catalog). */
function loadCatalogEntries(root = REPO) {
  const path = join(root, 'index', 'catalog.yml')
  if (!existsSync(path)) return []
  const parsed = yaml.load(readFileSync(path, 'utf8'))
  return Array.isArray(parsed) ? parsed : []
}

// ── coverage ───────────────────────────────────────────────────────────────
// 现有能力覆盖图:每个 server 一行(工具名 + tags 并集),给调用方做语义判重
// ——候选库先对着这张图判 NEW / OVERLAP,重叠能力点不收。
function coverage() {
  // Parse, don't grep. The hand-rolled regex here has now cost twice: once a
  // trailing full-width paren hid a tool and led to a wrong diagnosis about a
  // missing capability, and once an escaped quote inside a description made the
  // `"[^"]*"` branch stop early and under-count. The file is YAML; read it as
  // YAML and the whole class goes away.
  const map = loadCatalogEntries().map((e) => ({
    id: e.id,
    tools: (e.tools ?? []).map((t) => `${t.name}(${String(t.description ?? '').slice(0, 36)})`),
  }))
  for (const row of map) console.error(`${row.id}: ${row.tools.join(' | ')}`)
  console.log(JSON.stringify({ ok: true, servers: map.length, tools: map.reduce((n, row) => n + row.tools.length, 0) }))
}

// ── scaffold ───────────────────────────────────────────────────────────────
function scaffold() {
  out(scaffoldCore(target, flags))
}

/**
 * Skeleton + work order for a SERVICE part (a public HTTP API).
 *
 * No package to pin and nothing to clone: the recorded facts are the base URL,
 * the terms/licence the data comes under, and the rate limit the part must
 * respect. Dependencies stay at the MCP SDK + zod — a service part calls the
 * API with `fetch`, so there is no third-party client to audit.
 */
function scaffoldService(id, opts) {
  const dir = join(REPO, 'generated', id)
  mkdirSync(dir, { recursive: true })
  if (!existsSync(join(dir, 'package.json'))) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: `@dsh-index/${id}`,
      version: '0.0.1',
      type: 'module',
      private: true,
      description: `MCP stdio server exposing the ${id} public API`,
      dependencies: { '@modelcontextprotocol/sdk': '^1.0.0', zod: '^3.23.0' },
    }, null, 2) + '\n')
  }
  // requiredSecrets: "ENV:用途,ENV2:用途" — declared here, valued nowhere.
  const requiredSecrets = parseRequiredSecrets(opts['requires-secret'])
  const meta = {
    id,
    kind: 'service',
    service: opts.service,
    ...(requiredSecrets.length > 0 ? { requiredSecrets } : {}),
    provider: opts.provider ?? '(未填)',
    license: opts.license ?? 'UNKNOWN',
    terms: opts.terms ?? '(未填:服务条款 URL)',
    rateLimit: opts['rate-limit'] ?? '(未填)',
    network: true,
    scaffoldedAt: new Date().toISOString(),
  }
  writeFileSync(join(dir, '.index-meta.json'), JSON.stringify(meta, null, 2) + '\n')
  writeFileSync(join(dir, 'WORK-ORDER.md'), `# 收录工单(服务型):${id}

服务:${meta.service}
提供方:${meta.provider} — 数据许可:${meta.license} — 条款:${meta.terms}
速率限制:${meta.rateLimit}

## 要写的两个文件(户型规范,参照 generated/text-diff/ 与 generated/http-request/)

1. **index.js** — MCP stdio 适配服务器,用内置 fetch 调上述服务(不引第三方 HTTP 客户端)
   - 切 2~4 个能力点:选这个服务最有业务价值、一轮内可完成的操作
   - **网络零件铁律**:
     * 每次请求带超时(AbortSignal.timeout,建议 15s)与明确 User-Agent
       \`dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)\`——
       Nominatim/SEC 等服务强制要求 UA,缺了会被封
     * 非 2xx、超时、JSON 解析失败一律返回 { isError: true, ... } 且**说明是哪个服务出了什么问题**,绝不抛裸异常
     * 尊重速率限制(${meta.rateLimit});不做并发扇出
     * **传输层韧性(两条)**:① 瞬时抖动(socket 重置/DNS/TLS 打嗝)先原路重试一次
       (约 400ms 退避)——实测网络零件会偶发单次失败、单跑三次全过,不重试就是假红;
       ② 仍失败则显式绕开代理再试一次
       —— 同一机器上不同域名对代理的要求可能相反(实测:www.sec.gov 必须走代理,
       data.sec.gov 走代理会断 TLS)。写法参照 generated/sec-filings/index.js 的
       fetchWithProxyFallback;HTTP 错误码不重试(403 是答复,不是断路)
     * 只读:不调用任何写端点
   - 返回体裁剪成 agent 用得上的字段(别把整个 JSON 倒回上下文)
   - **需要凭证时的零凭证降级(硬规范)**:凭证从**自己进程的环境变量**读(如
     process.env.FEISHU_APP_ID),绝不写进代码、绝不接受工具参数传入。未配置时:
     * listTools 必须照常成功(接口先就位,key 后补——FDE 交付的常态)
     * 调用返回 isError 且**说清缺哪个变量、去哪配**,不崩溃、不静默假装成功
     * 冒烟必须覆盖这条路径:未配凭证时断言"能启动 + listTools 成功 + 调用给出可行动错误"
2. **smoke.mjs** — 冒烟(check() 计数,最后 process.exit(failures))
   - listTools 数量断言 → 每个工具**真实网络调用**并断言内容型结果 → 至少一条错误路径(非法参数或不存在的资源)
   - 断言要抗数据漂移:天气/汇率/行情这类值天天变,断言**结构与量纲**(字段存在、数值在合理区间、单位正确),不断言具体数值
   - **必须把代理环境显式传给零件子进程**:MCP SDK 的 StdioClientTransport 默认只透传
     白名单 env(HOME/PATH/USER…),HTTPS_PROXY / NODE_USE_ENV_PROXY 都不在其中。
     不传的话零件在代理网络下只报 "fetch failed",看着像零件坏了、其实是网络路径断了。
     写法:构造一个 NETWORK_ENV = { ...process.env },当检测到 HTTPS_PROXY/HTTP_PROXY
     而 NODE_USE_ENV_PROXY 未设时补上 NODE_USE_ENV_PROXY='1',再传给
     new StdioClientTransport({ command, args, env: NETWORK_ENV })。
     参照 generated/geocode/smoke.mjs 顶部的现成写法照抄。
`)
  return { id, kind: 'service', service: meta.service, license: meta.license, workOrder: `generated/${id}/WORK-ORDER.md`, next: `写 generated/${id}/{index.js,smoke.mjs},然后 verify` }
}

/**
 * Fetch metadata, shallow-clone upstream, write the skeleton + work order.
 * Returns the result rather than printing it, so `auto` can chain on it.
 */
function scaffoldCore(repoSlugArg, opts) {
  // Two part shapes share this pipeline:
  //   library part  — wraps an npm package (version+license from the registry,
  //                   upstream shallow-cloned for the author to read);
  //   service part  — wraps a PUBLIC HTTP API (`--service <base-url>`): there is
  //                   no package to pin, so the pinned facts are the service's
  //                   TERMS and rate limit instead. FDE delivery needs those on
  //                   record: a client's compliance desk asks what the agent
  //                   calls and under whose licence before it asks anything else.
  const isService = typeof opts.service === 'string' && opts.service !== ''
  const repoSlug = repoSlugArg
  if (!isService && !repoSlug?.includes('/')) die('scaffold 需要 <owner/repo>,如 kpdecker/jsdiff(服务型零件用 --service <base-url>)')
  const pkg = opts.pkg ?? (isService ? (opts.id ?? '') : repoSlug.split('/')[1])
  const id = (opts.id ?? pkg).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  const dup = dedupGate({ id, pkg: isService ? `service:${id}` : pkg, repoSlug: isService ? opts.service : repoSlug })
  if (dup !== null && opts.force !== 'yes') die(`去重门:${dup}(确认要重复收录用 --force yes)`)

  if (isService) return scaffoldService(id, opts)

  let meta
  try {
    meta = JSON.parse(execSync(`npm view ${pkg} version license description --json`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  } catch (error) {
    // 过堂:曾吞掉 npm 的真实 stderr(404?网络?),只剩猜测句。
    die(`npm view ${pkg} 失败:${String(error?.stderr ?? error?.message ?? error).trim().slice(-200)}——包名不对就用 --pkg 指定 npm 包名`)
  }

  const upstream = join(REPO, '.cache', 'upstream', id)
  if (!existsSync(upstream)) {
    try {
      execSync(`git clone --depth 1 https://github.com/${repoSlug}.git "${upstream}"`, { stdio: 'pipe' })
    } catch {
      // 上游读不到不拦骨架:调用方还能从 npm README/类型定义读 API
    }
  }
  const upstreamFiles = existsSync(upstream)
    ? readdirSync(upstream).filter((f) => !f.startsWith('.')).slice(0, 40)
    : []

  const dir = join(REPO, 'generated', id)
  mkdirSync(dir, { recursive: true })
  const pkgJsonPath = join(dir, 'package.json')
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(pkgJsonPath, JSON.stringify({
      name: `@dsh-index/${id}`,
      version: '0.0.1',
      type: 'module',
      private: true,
      description: `MCP stdio server exposing ${pkg} tools`,
      dependencies: {
        '@modelcontextprotocol/sdk': '^1.0.0',
        zod: '^3.23.0',
        [pkg]: meta.version,
      },
    }, null, 2) + '\n')
  }
  writeFileSync(join(dir, '.index-meta.json'), JSON.stringify({
    id, pkg, version: meta.version, repo: repoSlug,
    license: meta.license ?? 'UNKNOWN',
    scaffoldedAt: new Date().toISOString(),
  }, null, 2) + '\n')

  writeFileSync(join(dir, 'WORK-ORDER.md'), `# 收录工单:${id}(${pkg}@${meta.version})

上游:https://github.com/${repoSlug}(${meta.license ?? '许可证未知'})
${meta.description ? `简介:${meta.description}` : ''}
源码副本:${existsSync(upstream) ? `.cache/upstream/${id}/(顶层:${upstreamFiles.join(', ')})` : '克隆失败,读 npm 文档'}

## 要写的两个文件(户型规范,参照 generated/binary-write/)

1. **index.js** — MCP stdio 适配服务器
   - McpServer({ name: '${id}', version: '0.0.1' }) + StdioServerTransport
   - 切 2~4 个"工具级能力点":选这个库最常用、一轮对话内可完成的操作
   - registerTool:inputSchema 用 zod;description 中文、说清输入输出与边界
   - 错误路径返回 { isError: true, content: [{type:'text', text: ...}] },不抛裸异常
   - 只 import 锁定版本的 ${pkg}(package.json 已精确锁 ${meta.version}),不访问网络除非能力本身是网络
2. **smoke.mjs** — 冒烟(check() 计数模式,最后 process.exit(failures))
   - listTools 数量断言 → 每个工具至少一次**真实调用**并断言内容结果 → 至少一条错误路径被拒

## 完成后
   node scripts/index-add.mjs verify ${id}     # 质检(不过不入库)
   node scripts/index-add.mjs register ${id}   # 登记两个目录文件
`)
  return { id, pkg, version: meta.version, license: meta.license ?? 'UNKNOWN', workOrder: `generated/${id}/WORK-ORDER.md`, upstream: existsSync(upstream) ? `.cache/upstream/${id}` : null, next: `写 generated/${id}/{index.js,smoke.mjs},然后 verify` }
}

// ── verify ─────────────────────────────────────────────────────────────────
async function verify() {
  out(await verifyCore(target, flags.client))
}

/**
 * The quality gate: install, smoke (exit 0 required), independent listTools
 * probe, report. Throws with the smoke output on failure — `auto` feeds that
 * text back to the agent so it can repair its own part.
 */
async function verifyCore(idArg, clientName) {
  const id = idArg
  const root = catalogRoot(clientName)
  const dir = join(root, 'generated', id ?? '')
  if (!id || !existsSync(dir)) die(`generated/${id} 不存在——先 scaffold`)
  for (const f of ['index.js', 'smoke.mjs', 'package.json']) {
    if (!existsSync(join(dir, f))) die(`缺 ${f}——按 WORK-ORDER.md 补齐`)
  }
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8', timeout: 300_000 })
  if (install.status !== 0) die(`npm install 失败:${(install.stderr ?? '').slice(-400)}`)
  const smoke = spawnSync('node', ['smoke.mjs'], { cwd: dir, encoding: 'utf8', timeout: 180_000, env: partEnv() })
  process.stderr.write(smoke.stdout ?? '')
  if (smoke.status !== 0) {
    const err = new Error(`smoke.mjs 退出码 ${smoke.status}——冒烟未过,不入库`)
    err.smokeOutput = `${smoke.stdout ?? ''}\n${smoke.stderr ?? ''}`.slice(-1500)
    throw err
  }

  // 独立实探:不信 smoke 自报,从装配器自身依赖直接 listTools
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const client = new Client({ name: 'index-add-verify', version: '0.0.1' })
  await client.connect(new StdioClientTransport({ command: 'node', args: [join(dir, 'index.js')], env: partEnv() }))
  const tools = (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description ?? '' }))
  await client.close()
  if (tools.length === 0) die('listTools 为空——server 起了但没注册任何工具:检查 index.js 是否真调了 registerTool/setRequestHandler,有无条件分支跳过了注册')

  mkdirSync(join(root, 'index', 'reports'), { recursive: true })
  writeFileSync(join(root, 'index', 'reports', `${id}.json`), JSON.stringify({
    id, verifiedAt: new Date().toISOString(), node: process.version,
    smoke: 'pass', tools,
  }, null, 2) + '\n')
  return { id, tools: tools.map((t) => t.name), report: `index/reports/${id}.json`, next: `register ${id}` }
}

// ── register ───────────────────────────────────────────────────────────────
function register() {
  out(registerCore(target, flags.client))
}

/**
 * Write a catalog file only if it still parses as YAML afterwards.
 * See scripts/yaml-write.mjs for why both halves of this exist.
 */
function writeYaml(path, text, label) {
  try {
    assertYaml(text, label)
  } catch (error) {
    die(`拒绝写入 ${label}:${error.message}。这是 index-add 的 bug,请连同 .index-meta.json 一起报告,文件未被改动。`)
  }
  writeFileSync(path, text)
}

/** Idempotent catalog registration; refuses without a passing verify report. */
function registerCore(idArg, client) {
  const id = idArg
  const root = catalogRoot(client)
  const dir = join(root, 'generated', id ?? '')
  const metaPath = join(dir, '.index-meta.json')
  const reportPath = join(root, 'index', 'reports', `${id}.json`)
  if (!existsSync(metaPath)) die('缺 .index-meta.json——先 scaffold')
  if (!existsSync(reportPath)) die('缺 verify 报告——质检门:先 verify 且必须通过')
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  if (report.smoke !== 'pass') die('verify 报告非 pass,拒绝登记')

  const changed = []
  // catalog.yml:追加条目(幂等)
  const catalogPath = join(root, 'index', 'catalog.yml')
  if (!existsSync(catalogPath)) {
    mkdirSync(dirname(catalogPath), { recursive: true })
    writeFileSync(catalogPath, `# ${client ?? 'public'} 零件索引(由 index-add 维护)\n`)
  }
  const catalog = readFileSync(catalogPath, 'utf8')
  if (!new RegExp(`^- id: ${id}$`, 'm').test(catalog)) {
    const toolLines = report.tools
      .map((t) => `    - { name: ${s(t.name)}, description: ${s(t.description.replace(/\n[\s\S]*/, '').slice(0, 80))} }`)
      .join('\n')
    // A service part pins terms + rate limit where a library part pins a rev:
    // that IS its supply-chain provenance, and the BOM carries it to the client.
    const secretRows = Array.isArray(meta.requiredSecrets) && meta.requiredSecrets.length > 0
      ? `  requiredSecrets:\n${meta.requiredSecrets.map((x) => `    - { env: ${s(x.env)}, purpose: ${s(x.purpose ?? '')} }`).join('\n')}\n`
      : ''
    const provenance = meta.kind === 'service'
      ? `  kind: service\n  service: ${s(meta.service)}\n  provider: ${s(meta.provider ?? '')}\n  license: ${s(meta.license)}\n  terms: ${s(meta.terms ?? '')}\n  rateLimit: ${s(meta.rateLimit ?? '')}\n  network: true\n${secretRows}`
      : meta.adopted === true
        ? `  adopted: true\n  pkg: ${s(meta.pkg)}\n  rev: ${s(`v${meta.version}`)}\n  repo: ${s(meta.repo)}\n  license: ${s(meta.license)}\n${secretRows}`
        : `  repo: ${s(meta.repo)}\n${meta.version === undefined || meta.version === null || meta.version === '' ? '' : `  rev: ${s(`v${meta.version}`)}\n`}  license: ${s(meta.license)}\n${secretRows}`
    writeYaml(catalogPath, catalog.replace(/\n*$/, '\n') + `
- id: ${id}
${provenance}  tools:
${toolLines}
`, 'index/catalog.yml')
    changed.push('index/catalog.yml')
  }
  // capabilities.yml:mcp-servers 段插入连接配置(段尾 = capabilities: 键之前;幂等)
  const capsPath = join(root, 'capabilities.yml')
  if (!existsSync(capsPath)) {
    // `capabilities:` must be its OWN line: the insertion point below anchors
    // on /^capabilities:$/ (a fresh client catalog written as `capabilities: []`
    // silently failed every register).
    writeFileSync(capsPath, `# ${client ?? 'public'} 能力目录(由 index-add 维护)\nmcp-servers:\n\ncapabilities:\n`)
  }
  const caps = readFileSync(capsPath, 'utf8')
  if (!new RegExp(`^  ${id}:$`, 'm').test(caps)) {
    // requiredSecrets travels into capabilities.yml too: that is where the
    // assembler reads it to tell an operator what still needs configuring.
    // Names only — a value never appears in either catalog file.
    const secretDecl = Array.isArray(meta.requiredSecrets) && meta.requiredSecrets.length > 0
      ? `    requiredSecrets:\n${meta.requiredSecrets.map((x) => `      - { env: ${s(x.env)}, purpose: ${s(x.purpose ?? '')} }`).join('\n')}\n`
      : ''
    // 收编件(adopt)的入口在包内 bin;自造件是 generated/<id>/index.js。
    const entryJs = typeof meta.entry === 'string' && meta.entry !== ''
      ? join(root, 'generated', id, meta.entry)
      : join(root, 'generated', id, 'index.js')
    const entryArgsYaml = Array.isArray(meta.entryArgs) && meta.entryArgs.length > 0
      ? meta.entryArgs.map((x) => `, ${s(String(x))}`).join('')
      : ''
    const entry = `  ${id}:\n    transport: stdio\n    command: node\n    args: [${s(entryJs)}${entryArgsYaml}]\n${secretDecl}\n`
    if (!/^capabilities:$/m.test(caps)) die('capabilities.yml 缺 capabilities: 键,无法定位 mcp-servers 段尾')
    writeYaml(capsPath, caps.replace(/^capabilities:$/m, entry + 'capabilities:'), 'capabilities.yml')
    changed.push('capabilities.yml')
  }
  return { id, registered: changed, note: changed.length > 0 ? 'git diff 后提交即完成收录;联邦缓存无此 server 键,下次装配自动实探' : '已登记过,无改动' }
}

// ── knowledge ──────────────────────────────────────────────────────────────
// 知识包:客户的手册/SOP/产品目录/法规,作为**静态教材**进目录。
// 它不是"能力"而是"装备",但走同一条供应链纪律:有出处、有版本、过门、
// 进 BOM。质检门对它的形式是**检索命中**——给定问题必须检出预期片段,
// 否则这包知识对 agent 就是不可用的。

/** Collect readable documents under a directory (flat, extension-filtered). */
function collectDocs(dir, exts) {
  const out = []
  const walk = (d, depth) => {
    if (depth > 4) return
    for (const name of readdirSync(d)) {
      if (name.startsWith('.')) continue
      const full = join(d, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full, depth + 1)
      else if (exts.some((e) => name.toLowerCase().endsWith(e))) out.push({ path: full, bytes: st.size })
    }
  }
  walk(dir, 0)
  return out
}

function knowledgeScaffold() {
  const src = target
  if (src === undefined || !existsSync(src)) die('用法:index-add.mjs knowledge <文档目录> --id <包id> [--client <客户名>] [--source <来源说明>] [--version <版本>]')
  const id = (flags.id ?? basename(src)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  const root = catalogRoot(flags.client)
  const dir = join(root, 'knowledge', id)
  if (existsSync(join(dir, '.knowledge-meta.json')) && flags.force !== 'yes') die(`去重门:知识包 ${id} 已存在(${dir})`)

  const exts = (flags.ext ?? '.md,.txt,.markdown').split(',').map((x) => x.trim())
  const docs = collectDocs(src, exts)
  if (docs.length === 0) die(`目录里没有找到 ${exts.join('/')} 文档:${src}`)

  mkdirSync(join(dir, 'docs'), { recursive: true })
  let totalBytes = 0
  for (const d of docs) {
    const rel = d.path.slice(src.replace(/\/$/, '').length + 1).replace(/[\/\\]/g, '__')
    writeFileSync(join(dir, 'docs', rel), readFileSync(d.path))
    totalBytes += d.bytes
  }
  const meta = {
    id,
    kind: 'knowledge',
    client: flags.client ?? null,
    source: flags.source ?? src,
    version: flags.version ?? new Date().toISOString().slice(0, 10),
    license: flags.license ?? '(客户资料:以合同为准)',
    docCount: docs.length,
    totalBytes,
    scaffoldedAt: new Date().toISOString(),
  }
  writeFileSync(join(dir, '.knowledge-meta.json'), JSON.stringify(meta, null, 2) + '\n')
  writeFileSync(join(dir, 'PROBES.example.json'), JSON.stringify({
    probes: [
      { question: '（换成一个这份资料能回答的问题）', mustInclude: ['（答案里必然出现的逐字片段）'] },
      { question: '（第二个问题）', mustInclude: ['（片段）'] },
    ],
  }, null, 2) + '\n')
  out({
    id, kind: 'knowledge', client: flags.client ?? null,
    dir: dir.replace(REPO + '/', ''),
    docs: docs.length, totalBytes,
    next: `把 PROBES.example.json 改成真实检索探针存为 probes.json,然后 knowledge-verify ${id}`,
  })
}

/**
 * The knowledge gate: every declared probe question must retrieve its
 * expected snippet from the pack's documents.
 *
 * Retrieval here is deliberately the same crude thing an agent's search tool
 * does — case-insensitive substring over the documents — because the gate
 * answers "is this knowledge REACHABLE", not "is our ranking clever". A pack
 * whose answers cannot be found by a plain search is not usable by an agent
 * either, no matter how good the source document is.
 */
function knowledgeVerify() {
  const id = target
  const root = catalogRoot(flags.client)
  const dir = join(root, 'knowledge', id ?? '')
  if (!existsSync(join(dir, '.knowledge-meta.json'))) die(`知识包不存在:${dir}`)
  const probesPath = join(dir, 'probes.json')
  if (!existsSync(probesPath)) die(`缺 probes.json(检索探针)——参照 ${join(dir, 'PROBES.example.json')} 写真实问题与预期片段`)
  const probes = JSON.parse(readFileSync(probesPath, 'utf8')).probes
  if (!Array.isArray(probes) || probes.length === 0) die('probes.json 里没有探针')

  const docsDir = join(dir, 'docs')
  const corpus = readdirSync(docsDir).map((f) => ({ name: f, text: readFileSync(join(docsDir, f), 'utf8').toLowerCase() }))
  const results = probes.map((p) => {
    const marks = Array.isArray(p.mustInclude) ? p.mustInclude : []
    const hits = marks.map((m) => {
      const needle = String(m).toLowerCase()
      const doc = corpus.find((c) => c.text.includes(needle))
      return { mark: m, found: doc !== undefined, in: doc?.name ?? null }
    })
    const pass = marks.length > 0 && hits.every((h) => h.found)
    console.error(`${pass ? '  ✓' : '  ✗ FAIL'} ${String(p.question).slice(0, 50)} — ${hits.map((h) => `${h.mark}${h.found ? `@${h.in}` : '(未找到)'}`).join(', ')}`)
    return { question: p.question, marks, hits, pass }
  })
  const failed = results.filter((r) => !r.pass)
  if (failed.length > 0) {
    die(`知识门未过:${failed.length}/${results.length} 条探针检不出预期片段——这包知识对 agent 不可用`)
  }
  mkdirSync(join(root, 'index', 'reports'), { recursive: true })
  writeFileSync(join(root, 'index', 'reports', `knowledge-${id}.json`), JSON.stringify({
    id, kind: 'knowledge', verifiedAt: new Date().toISOString(), probes: results,
  }, null, 2) + '\n')
  out({ id, kind: 'knowledge', probes: results.length, passed: results.length, report: `index/reports/knowledge-${id}.json` })
}

// ── from-spec ──────────────────────────────────────────────────────────────
// FDE 的日常动作不是收录 npm 包,是接客户的系统。客户手里通常有一份
// OpenAPI/Swagger(或者只有一段接口说明),这里把它变成零件骨架 + 工单:
// CLI 做确定性的部分(取回 spec、清点端点、按 tag 归组、写工单),
// "挑哪几个能力点、怎么映射参数"仍然留给调用方(agent)。
//
// 客户私有目录:--client <name> 把零件写进 catalogs/<client>/,与公共目录
// 隔离 —— A 客户的接口零件不该出现在 B 客户的装配里。

/** Fetch or read an OpenAPI document (JSON or YAML). */
async function loadSpec(src) {
  let text
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)' } })
    if (!res.ok) die(`取 spec 失败:HTTP ${res.status} ${src}`)
    text = await res.text()
  } else {
    if (!existsSync(src)) die(`spec 文件不存在:${src}`)
    text = readFileSync(src, 'utf8')
  }
  try {
    return text.trimStart().startsWith('{') ? JSON.parse(text) : yamlParse(text)
  } catch (error) {
    die(`spec 解析失败(既不是合法 JSON 也不是合法 YAML):${error.message.slice(0, 200)}`)
  }
}

function fromSpec() {
  const src = target
  if (src === undefined || src === '') die('用法:index-add.mjs from-spec <spec-url|spec-file> --id <零件id> [--client <客户名>] [--requires-secret ENV:用途]')
  return (async () => {
    const spec = await loadSpec(src)
    const id = (flags.id ?? spec.info?.title ?? 'client-api').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
    const client = flags.client
    const root = client === undefined ? REPO : join(REPO, 'catalogs', client)
    const dir = join(root, 'generated', id)
    if (existsSync(join(dir, '.index-meta.json')) && flags.force !== 'yes') die(`去重门:${id} 已存在(${dir})`)

    const groups = inventoryEndpoints(spec)
    const total = [...groups.values()].reduce((n, g) => n + g.length, 0)
    if (total === 0) die('spec 里没有找到任何端点(paths 为空?)')
    const baseUrl = flags['base-url'] ?? specBaseUrl(spec) ?? '(spec 未声明 base URL,需手工确认)'

    const requiredSecrets = parseRequiredSecrets(flags['requires-secret'])

    mkdirSync(dir, { recursive: true })
    if (!existsSync(join(dir, 'package.json'))) {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: `@dsh-index/${id}`, version: '0.0.1', type: 'module', private: true,
        description: `MCP stdio server for ${spec.info?.title ?? id}`,
        dependencies: { '@modelcontextprotocol/sdk': '^1.0.0', zod: '^3.23.0' },
      }, null, 2) + '\n')
    }
    writeFileSync(join(dir, '.index-meta.json'), JSON.stringify({
      id, kind: 'service', client: client ?? null,
      service: baseUrl,
      provider: spec.info?.title ?? id,
      license: flags.license ?? spec.info?.license?.name ?? 'UNKNOWN',
      terms: flags.terms ?? spec.info?.termsOfService ?? '(客户自有接口:条款以合同为准)',
      rateLimit: flags['rate-limit'] ?? '(未声明)',
      specSource: src,
      specVersion: spec.info?.version ?? null,
      network: true,
      ...(requiredSecrets.length > 0 ? { requiredSecrets } : {}),
      scaffoldedAt: new Date().toISOString(),
    }, null, 2) + '\n')

    const inventory = [...groups.entries()].map(([tag, eps]) => {
      const lines = eps.slice(0, 25).map((e) => `  - ${e.method} ${e.path}${e.params.length > 0 ? ` [${e.params.join(', ')}]` : ''}${e.hasBody ? ' +body' : ''}${e.summary !== '' ? ` — ${e.summary}` : ''}`)
      const more = eps.length > 25 ? `  - …另有 ${eps.length - 25} 个端点` : ''
      return `### ${tag}(${eps.length} 个端点)\n${lines.join('\n')}${more === '' ? '' : '\n' + more}`
    }).join('\n\n')

    writeFileSync(join(dir, 'WORK-ORDER.md'), `# 收录工单(客户接口):${id}

来源 spec:${src}
接口标题:${spec.info?.title ?? '(未声明)'} ${spec.info?.version ?? ''}
Base URL:${baseUrl}
${client === undefined ? '' : `客户:${client}(零件写入 catalogs/${client}/,与公共目录隔离)\n`}${requiredSecrets.length > 0 ? `所需凭证:${requiredSecrets.map((x) => `${x.env}${x.purpose ? `(${x.purpose})` : ''}`).join('、')}\n` : ''}
## 端点清单(共 ${total} 个,已按 tag 归组)

${inventory}

## 要写的两个文件

1. **index.js** — MCP stdio 适配服务器(照抄 generated/geocode/index.js 的户型)
   - **从上面清单里挑 2~5 个最有业务价值的端点**做成工具:一个工具 = 一个 agent 说得清楚的完整动作,不要把端点一对一翻译成工具
   - 用内置 fetch;超时 AbortSignal.timeout(15000);明确 User-Agent;返回体裁剪
   - 非 2xx / 超时 / 解析失败一律 { isError: true, ... } 并说清是哪个接口什么问题
   - 传输层失败重试一次并绕开代理(参照 generated/sec-filings/index.js 的 fetchWithProxyFallback)
   - **凭证从自己进程的环境变量读**,绝不写进代码、绝不当工具参数;未配时 listTools 照常成功、调用给出可行动错误
   - **写操作**(POST/PUT/DELETE)的 description 必须以【写操作,会真实修改客户系统】开头
2. **smoke.mjs** — 冒烟(check() 计数,process.exit(failures))
   - listTools 断言 + 每个工具真实调用(或零凭证降级路径)+ 错误路径
   - 用 NETWORK_ENV 写法把代理环境传给子进程(见 generated/geocode/smoke.mjs)
   - 断言结构与量纲,不断言易变的具体值
`)
    out({
      id, client: client ?? null, dir: dir.replace(REPO + '/', ''),
      endpoints: total, tags: [...groups.keys()],
      baseUrl, requiredSecrets: requiredSecrets.map((x) => x.env),
      workOrder: join(dir, 'WORK-ORDER.md').replace(REPO + '/', ''),
      next: `写 ${id} 的 index.js + smoke.mjs,然后 verify${client === undefined ? '' : ` --client ${client}`}`,
    })
  })()
}

// ── auto ───────────────────────────────────────────────────────────────────
// 全自动收录:CLI 调 agent(不内嵌 LLM——调用方本来就是 LLM 的这条设计在
// 这里推到极致:让 harness 里的真 agent 拿文件工具照工单写零件),写完过同
// 一道质检门;冒烟不过就把输出喂回同一会话让它自己修(零件自愈),仍不过则
// 拒绝入库。产出依旧是静态零件 + 目录条目,收录完 CLI 退出——过三判据。

/** One prompt to a fresh-or-existing session; resolves with the turn's reply. */
async function agentTurn(port, session, text, timeoutMs = 900_000) {
  const endsBefore = session.frames.filter((e) => e.type === 'turn/end').length
  const start = session.frames.length
  await session.prompt(text)
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (session.frames.filter((e) => e.type === 'turn/end').length > endsBefore) {
      return session.frames.slice(start)
        .filter((e) => e.type === 'assistant/message')
        .map((e) => {
          const c = e.data?.message?.content ?? e.data?.content
          return Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? b.text : '')).join('') : String(c ?? '')
        }).join('\n')
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return null
}

async function openSession(port, cwd) {
  // 传输层走 lib/wire.js 共享客户端(BACKLOG 0.9,探协议定代际、两代同形)。
  // auto 收尾只断流不掐会话(detach):agent 写件的会话留在侧栏可复查。
  const w = await openWireSession(port, { cwd })
  return { sessionId: w.sessionId, frames: w.frames, prompt: w.prompt, close: w.detach }
}

async function auto() {
  const port = Number(flags.port ?? 3096)
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/`)
    if (!probe.ok) throw new Error(String(probe.status))
  } catch {
    die(`auto 需要一个在跑的 DSH web profile(端口 ${port});先启动:dsh --profile web`)
  }

  const sc = scaffoldCore(target, flags)
  console.error(`[auto] scaffold ok: ${sc.id} (${sc.pkg}@${sc.version}, ${sc.license})`)
  // The work order ends with the operator's own next steps (verify / register).
  // Handing those lines to the agent invites it to run the gates itself —
  // observed live: it did, and the pipeline's own run then hit the idempotent
  // no-op, making the report read as "nothing registered". The pipeline owns
  // the gates; the agent owns the two files.
  const workOrder = readFileSync(join(REPO, 'generated', sc.id, 'WORK-ORDER.md'), 'utf8')
    .replace(/\n## 完成后[\s\S]*$/, '\n')
  const session = await openSession(port, REPO)
  try {
    const brief = [
      `请按下面的工单,为零件 ${sc.id} 写两个文件:generated/${sc.id}/index.js 和 generated/${sc.id}/smoke.mjs。`,
      '写之前先读 generated/text-diff/{index.js,smoke.mjs} 学户型规范,再读上游源码/README 确认真实 API 与 ESM/CJS 导入方式(不要凭记忆写 API)。',
      '只写这两个文件,不要运行 npm install、不要跑 verify/register(质检与登记由流水线负责)、不要改其他文件。写完用 node --check 做语法检查。',
      '',
      '=== 工单 ===',
      workOrder,
    ].join('\n')
    const first = await agentTurn(port, session, brief)
    if (first === null) die('agent 写零件超时')
    console.error('[auto] agent 交付,进质检门…')

    let report
    try {
      report = await verifyCore(sc.id)
    } catch (error) {
      // 零件自愈:把冒烟原文喂回同一会话,让它自己定位并修,再过一次门。
      console.error('[auto] 冒烟未过,喂回失败输出让 agent 修复…')
      const repair = await agentTurn(port, session, [
        `质检未过:${error.message}`,
        '冒烟输出如下,请定位并修复(可以改 index.js 或 smoke.mjs,以真实行为为准;不要放宽断言来掩盖真实缺陷):',
        '```',
        error.smokeOutput ?? '(无输出)',
        '```',
        '修完只回复"已修复"。',
      ].join('\n'))
      if (repair === null) die('agent 修复超时')
      report = await verifyCore(sc.id)
    }
    const reg = registerCore(sc.id)
    // Report the catalog's STATE, not just what this call happened to write:
    // registration is idempotent, so an empty `wroteNow` means "already there",
    // which reads like failure unless the state is reported beside it.
    const inCatalog = new RegExp(`^- id: ${sc.id}$`, 'm').test(readFileSync(join(REPO, 'index', 'catalog.yml'), 'utf8'))
    out({
      id: sc.id, pkg: sc.pkg, version: sc.version, license: sc.license,
      tools: report.tools,
      catalogued: inCatalog,
      wroteNow: reg.registered,
      note: '全自动收录完成;git diff 后提交',
    })
  } finally {
    session.close()
  }
}

// ── check-all ──────────────────────────────────────────────────────────────
async function checkAll() {
  // Public parts plus every client catalog: a client's parts are isolated
  // from other clients' assemblies, not from the regression gate.
  const roots = [REPO]
  const catalogsDir = join(REPO, 'catalogs')
  if (existsSync(catalogsDir)) {
    for (const c of readdirSync(catalogsDir)) {
      if (existsSync(join(catalogsDir, c, 'generated'))) roots.push(join(catalogsDir, c))
    }
  }
  const ids = []
  const genOf = new Map()
  for (const r of roots) {
    const g = join(r, 'generated')
    if (!existsSync(g)) continue
    for (const d of readdirSync(g)) {
      if (!existsSync(join(g, d, 'smoke.mjs'))) continue
      const label = r === REPO ? d : `${basename(r)}/${d}`
      ids.push(label)
      genOf.set(label, join(g, d))
    }
  }
  const gen = join(REPO, 'generated')
  // A network part's smoke makes real calls, so an offline run would report
  // failures that say nothing about the part. Those are SKIPPED and counted
  // separately — never folded into the pass count, because "did not run" and
  // "ran and passed" are different facts and the ledger must keep them apart.
  // Connectivity probe with the same resilience the parts have: a single
  // endpoint on a single path is not evidence of being offline — one flaky
  // host or a proxy that covers some domains and not others would silently
  // convert the whole network suite into SKIPPED, and a run that skips
  // everything looks green while proving nothing.
  const online = await (async () => {
    const targets = [
      'https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR',
      'https://registry.npmjs.org/diff/latest',
      'https://date.nager.at/api/v3/AvailableCountries',
    ]
    const { Agent } = await import('undici').catch(() => ({ Agent: null }))
    for (const url of targets) {
      for (const dispatcher of [undefined, Agent === null ? undefined : new Agent()]) {
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(8000), ...(dispatcher === undefined ? {} : { dispatcher }) })
          if (r.ok) return true
        } catch { /* try the next path/target */ }
      }
    }
    return false
  })()
  const results = []
  for (const id of ids) {
    const partDir = genOf.get(id) ?? join(gen, id)
    let networkPart = false
    try {
      networkPart = JSON.parse(readFileSync(join(partDir, '.index-meta.json'), 'utf8')).network === true
    } catch { /* library part or pre-metadata part */ }
    if (networkPart && !online) {
      results.push({ id, skipped: true })
      console.error(`  ↷ SKIP ${id}(网络零件,当前离线)`)
      continue
    }
    const r = spawnSync('node', ['smoke.mjs'], { cwd: partDir, encoding: 'utf8', timeout: 180_000, env: partEnv() })
    results.push({ id, pass: r.status === 0 })
    console.error(`${r.status === 0 ? '  ✓' : '  ✗ FAIL'} ${id}`)
  }
  const failed = results.filter((r) => r.skipped !== true && !r.pass)
  const skipped = results.filter((r) => r.skipped === true)
  console.log(JSON.stringify({
    ok: failed.length === 0,
    total: results.length,
    ran: results.length - skipped.length,
    skipped: skipped.map((r) => r.id),
    failed: failed.map((r) => r.id),
    online,
  }))
  process.exit(failed.length === 0 ? 0 : 1)
}


// ── scaffold:app 底盘出厂门(宪法第九条执行后,app 车道唯一底盘)──────────────
// 门 = 底盘自证:用自带 sample 实例化到临时目录,由同一台 app 考官黑盒考
// (lib/scaffold.js 的 runScaffoldGate——与 verify_app 完全同一段代码,双岗)。
// 改 template/ 任何字节必须升 scaffold.yml 的 version 并重过此门。scaffold 是
// 装配器装备(与 frontends/ 同性质),不进零件目录——过门只出报告,不登记条目。
// AI 半边的凭证从 ~/.dsh/.env 借读(只进本进程环境,不打印不落盘);没有 key
// 时行为考的 ai-thin 项以接口模式 SKIPPED,报告里如实记录。
async function scaffoldGate() {
  // 借读 ~/.dsh/.env 的凭证(与 ai-call smoke 同款纪律:值不打印)
  const dshEnv = join(process.env.HOME ?? '', '.dsh', '.env')
  if (existsSync(dshEnv)) {
    for (const line of readFileSync(dshEnv, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (m !== null && !line.trimStart().startsWith('#') && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
      }
    }
  }
  const libPath = join(REPO, 'lib', 'scaffold.js')
  if (!existsSync(libPath)) die('缺 lib/scaffold.js——先 npm run build')
  const { runScaffoldGate } = await import(libPath)
  let gate
  try {
    gate = await runScaffoldGate({ onPhase: (l) => console.error(`· ${l}`) })
  } catch (error) {
    die(`scaffold 门失败:${error.message}`)
  }
  const ok = gate.selftest.status === 'PASS' || gate.selftest.status === 'SKIPPED'
  const reportPath = join(REPO, 'index', 'reports', 'scaffold.json')
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, JSON.stringify({
    id: 'scaffold', kind: 'scaffold', scaffold: gate.scaffold, version: gate.version,
    templateHash: gate.materialize.templateHash,
    selftest: gate.selftest.status.toLowerCase(),
    checks: gate.selftest.checks,
    verifiedAt: new Date().toISOString(),
  }, null, 2) + '\n')
  if (!ok) die(`scaffold 自证 FAIL,拒绝出厂(报告:index/reports/scaffold.json):${gate.selftest.checks.map((c) => `${c.check}=${c.status}`).join(',')}`)
  out({ id: 'scaffold', scaffold: gate.scaffold, version: gate.version, selftest: gate.selftest.status, templateHash: gate.materialize.templateHash, report: 'index/reports/scaffold.json' })
}

// ── adopt:收编现成的 MCP server(三级采购的"采",省写胶水)────────────────────
// 生态里已有 2-3 万个 MCP server(注册表数据见 docs/research/parts-sourcing-map.md)。
// 我们不进货、只按需收编:装包锁版本 → 独立实探 listTools → 真调一发无副作用工具
// → 凭证声明(names only)→ 供应链登记。与自造件同一条纪律,省掉的只是写适配器。
// 用法:
//   node scripts/index-add.mjs adopt <npm-package> [--id <id>] [--probe <tool>[:<jsonArgs>]]
//        [--bin-args "<args>"] [--requires-secret ENV:用途] [--license <spdx>] [--client <客户名>]
// --bin-args:bin 需要子命令/参数才进 MCP 形态的采件(首例 stock-sdk 要 `cli.js mcp`;
//   裸跑只打印 help)。参数记进 .index-meta.json 的 entryArgs,register 原样带进挂载行。
async function adopt() {
  const pkg = target
  if (pkg === undefined || pkg === '') die('用法:index-add.mjs adopt <npm-package> [--id <id>] [--probe <tool>[:<json>]] [--bin-args "<args>"] [--requires-secret ENV:用途]')
  const binArgs = typeof flags['bin-args'] === 'string' && flags['bin-args'].trim() !== '' ? flags['bin-args'].trim().split(/\s+/) : []
  const id = (flags.id ?? pkg.replace(/^@[^/]+\//, '').replace(/[^a-z0-9-]+/gi, '-')).toLowerCase().slice(0, 48)
  const client = flags.client
  const root = catalogRoot(client)
  const dir = join(root, 'generated', id)
  if (existsSync(join(dir, '.index-meta.json')) && flags.force !== 'yes') die(`去重门:${id} 已存在(${dir})——换 --id 或 --force yes`)

  // 1) 装包锁版本(独立目录,与自造件同构:一个零件一个 node_modules)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `@dsh-index/${id}`, version: '0.0.1', type: 'module', private: true,
    description: `Adopted MCP server: ${pkg}`,
    dependencies: { [pkg]: 'latest' },
  }, null, 2) + '\n')
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8', timeout: 300_000 })
  if (install.status !== 0) die(`npm install ${pkg} 失败:${(install.stderr ?? '').slice(-400)}`)
  const lockPkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const installed = JSON.parse(readFileSync(join(dir, 'node_modules', pkg, 'package.json'), 'utf8'))
  lockPkg.dependencies[pkg] = installed.version  // latest → 实际版本,锁死
  writeFileSync(join(dir, 'package.json'), JSON.stringify(lockPkg, null, 2) + '\n')

  // 2) 找可执行入口:bin 优先(MCP server 的常规形态)
  const binField = installed.bin
  const binRel = typeof binField === 'string' ? binField : (binField && Object.values(binField)[0])
  if (binRel === undefined || binRel === null) die(`${pkg} 没有 bin 入口——不像可执行的 MCP server(它是库?那走 scaffold 造件)`)
  const binPath = join(dir, 'node_modules', pkg, binRel)
  if (!existsSync(binPath)) die(`bin 入口不存在:${binPath}`)

  // 3) 独立实探(不信 README,直接 listTools)+ 可选真调一发
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const c = new Client({ name: 'index-add-adopt', version: '0.0.1' })
  let tools = []
  let probeResult = null
  try {
    await c.connect(new StdioClientTransport({ command: 'node', args: [binPath, ...binArgs], env: partEnv() }))
    tools = (await c.listTools()).tools.map((t) => ({ name: t.name, description: (t.description ?? '').replace(/\n[\s\S]*/, '').slice(0, 200) }))
    if (typeof flags.probe === 'string' && flags.probe !== '') {
      const [pName, ...rest] = flags.probe.split(':')
      const pArgs = rest.length > 0 ? JSON.parse(rest.join(':')) : {}
      const r = await c.callTool({ name: pName, arguments: pArgs })
      const text = (r.content ?? []).map((b) => b.text ?? '').join('').slice(0, 300)
      if (r.isError === true) die(`探针工具 ${pName} 报错(收编门不放行报错的件):${text}`)
      probeResult = { tool: pName, ok: true, sample: text }
    }
  } catch (error) {
    die(`收编门失败(实探 ${pkg}):${String(error.message).slice(0, 300)}`)
  } finally {
    try { await c.close() } catch { /* 已断 */ }
  }
  if (tools.length === 0) die('listTools 为空——不是可用的 MCP server')

  // 4) 供应链档案 + 报告(与自造件同格式,register 直接可用)
  const requiredSecrets = parseRequiredSecrets(flags['requires-secret'])
  writeFileSync(join(dir, '.index-meta.json'), JSON.stringify({
    id, pkg, version: installed.version, client: client ?? null,
    repo: installed.repository?.url ?? installed.homepage ?? `npm:${pkg}`,
    license: flags.license ?? installed.license ?? 'UNKNOWN',
    adopted: true, entry: `node_modules/${pkg}/${binRel}`,
    ...(binArgs.length > 0 ? { entryArgs: binArgs } : {}),
    ...(requiredSecrets.length > 0 ? { requiredSecrets } : {}),
    scaffoldedAt: new Date().toISOString(),
  }, null, 2) + '\n')
  mkdirSync(join(root, 'index', 'reports'), { recursive: true })
  writeFileSync(join(root, 'index', 'reports', `${id}.json`), JSON.stringify({
    id, adopted: pkg, verifiedAt: new Date().toISOString(), node: process.version,
    smoke: 'pass', smokeKind: 'adopt-probe', tools, ...(probeResult !== null ? { probe: probeResult } : {}),
  }, null, 2) + '\n')
  out({
    id, pkg, version: installed.version, tools: tools.map((t) => t.name),
    probe: probeResult?.tool ?? null,
    report: `index/reports/${id}.json`,
    next: `register ${id}(收编件的 args 指向 node_modules 里的 bin)`,
  })
}

if (cmd === 'scaffold') scaffold()
else if (cmd === 'verify') await verify()
else if (cmd === 'register') register()
else if (cmd === 'check-all') await checkAll()
else if (cmd === 'coverage') coverage()
else if (cmd === 'auto') await auto()
else if (cmd === 'from-spec') await fromSpec()
else if (cmd === 'knowledge') knowledgeScaffold()
else if (cmd === 'knowledge-verify') knowledgeVerify()
else if (cmd === 'scaffold-gate') await scaffoldGate()
else if (cmd === 'adopt') await adopt()
else die('用法:index-add.mjs scaffold <owner/repo> --pkg <npm名> | adopt <npm-mcp-package> [--probe <tool>[:<json>]] | scaffold-gate | verify <id> | register <id> | check-all | coverage | auto <owner/repo> --pkg <npm名> [--id <id>] [--port 3096]')
