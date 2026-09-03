/**
 * result-digest.ts — 注入时摘要(insertion-time digest)。
 *
 * v3「追加流」模式的核心杠杆:成本由每步**新增字节**决定(严格前缀缓存下命中价是
 * 未命中的 1/30),所以大工具结果在进入上下文之前就折成紧凑视图;全文原样留在会话
 * 日志(recall_step 逐字取回);上下文里从此只有紧凑视图,且永不重写——append-only。
 *
 * 2026-09-03 按内容类型分路由(抄自 Headroom 的 ContentRouter / LogCompressor 思路):
 *   code   → 不折(代码是混合文本,残缺函数体会让模型编错;Headroom 同样把 Read/Edit 排除在外)
 *   search → 不折(grep/glob 的每一行都是命中,头尾视图会藏掉匹配)
 *   log    → 错误优先:ERROR/FAIL/WARN 行 + 前后 contextLines 行 + 紧随的栈帧 + 摘要行,
 *            相似行去重(保留消息前缀,归一化数字/十六进制/路径),头 3 尾 6;512 字节起折
 *   data   → 头/尾 + 结构行(`key = value` / `key: value` / 标题 / 段标记);头部区外的
 *            结构块按"键的新颖性"自适应保留(同形附录块只留前几行),1500 字符起折
 *
 * 守卫:小结果不折;折后体量 ≥ 原文 × maxKeepRatio 也不折(折了不省就别折)。
 */

export type ContentKind = 'code' | 'search' | 'log' | 'data'

export interface DigestPolicy {
  /** 轮内折叠开关(slice / stream 模式默认开;state 模式不用)。 */
  enabled: boolean
  /** data 类低于此字符数不折。 */
  minChars: number
  headLines: number
  tailLines: number
  /** 折后 ≥ 原文的这个比例就放弃(不值一次省略)。 */
  maxKeepRatio: number
  /** 头部区之外,每个连续结构行块最多保留几行(自适应保留的上限)。Infinity = 不限。 */
  structuredBlockCap: number
  /** 每个结构块至少保留几行(自适应保留的下限)。 */
  structuredBlockMin: number
  /** log 类低于此字符数不折(Headroom:512 B)。 */
  logMinChars: number
  /** log 类最多保留多少条错误/失败行(首条与末条必留)。 */
  logMaxErrors: number
  /** log 类每条保留行前后带的上下文行数。 */
  logContextLines: number
  /** data 类超过这么多字符的单行按字符头尾截断(压缩 JSON / base64 / 长 CSV 行 / 无换行的 blob;
   *  2026-09-03 s13 的 9K 字符 3 行 blob 按行判全被留下)。Infinity = 不截。 */
  maxLineChars: number
  /** 超长行保留的头部 / 尾部字符数。 */
  lineHeadChars: number
  lineTailChars: number
}

export const DEFAULT_DIGEST_POLICY: DigestPolicy = {
  // minChars 1500 → 6000(2026-09-03):l2 的 3.7K 规则文档被折掉整段 R1–R9,45 个 posting 全写错目录。小文档折了
  // 省不了几个 token(3K 字符 ≈ 750 token 一次未命中)却可能丢规则;收益只在大结果上(l1 每条 18K、s13 9K)。
  enabled: true, minChars: 6000, headLines: 10, tailLines: 4, maxKeepRatio: 0.55,
  structuredBlockCap: 12, structuredBlockMin: 3,
  logMinChars: 512, logMaxErrors: 10, logContextLines: 3,
  maxLineChars: 1500, lineHeadChars: 700, lineTailChars: 300,
}

/** 结构行:`key = value`、`key: value`、markdown/注释标题、围栏。噪音正文极少长这样。 */
// 键允许一个内部空格(`R1 path:`、`Opening balance:`):规则/说明文档的条目通常长这样。
const STRUCTURED = /^\s*(?:[A-Za-z_][\w.\-/]*(?: [\w.\-/]+)?\s*[=:]\s*\S|#{1,6}\s|\[[^\]]+\]\s*$|```)/
/** read 工具按 OpenCode 风格给每行加 `N: ` 前缀(grep 是 `N|`/`N:`);判结构前先剥掉。 */
const LINE_NUMBER_PREFIX = /^\s*\d+[:|]\s?/
const strip = (line: string): string => line.replace(LINE_NUMBER_PREFIX, '')

function isStructured(line: string): boolean {
  return STRUCTURED.test(strip(line))
}

/** 结构行的键(`key = value` / `key: value` 的 key;标题/段标记整行作键)。 */
function structuredKey(line: string): string {
  const s = strip(line).trim()
  const m = /^([A-Za-z_][\w.\-]*)\s*[=:]/.exec(s)
  return m ? m[1]! : s
}

// ---------------------------------------------------------------- content kinds

/**
 * 源代码不折:代码文件是混合文本(赋值行像结构行,逻辑行不像),折后视图会让模型对着
 * 残缺的函数体编辑——s1 复验里 store.py 折了 3 次,模型把 delete 方法编没了。按扩展名
 * 判 read 的路径;无路径的文本(bash 输出)按内容密度判:代码特征行占比 ≥ 15% 视为代码。
 */
const CODE_EXT = /\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rs|c|h|cc|cpp|hpp|cs|java|kt|scala|rb|php|swift|m|mm|sh|bash|zsh|fish|ps1|sql|lua|pl|r|jl|ex|exs|erl|hs|ml|clj|scm|lisp|el|vim|dart|zig|nim|v|sv|vhd|proto|thrift|tf|hcl|gradle|cmake|make|mk)$/i
const CODE_LINE = /^\s*(?:def |class |function\b|func |fn |import |from .+ import |#include|package |return\b|if\b.*[:{]\s*$|for\b.*[:{]\s*$|while\b.*[:{]\s*$|else\b|try\b|except\b|catch\b|\}\s*$|\{\s*$|export |const |let |var |public |private |static |@\w+)/

export function looksLikeCodePath(path: string | undefined): boolean {
  return path !== undefined && CODE_EXT.test(path)
}

export function looksLikeCode(text: string): boolean {
  const lines = text.split('\n').map(strip).filter((l) => l.trim() !== '')
  if (lines.length < 8) return false
  const hits = lines.reduce((a, l) => a + (CODE_LINE.test(l) ? 1 : 0), 0)
  return hits >= lines.length * 0.15
}

/** grep -n / rg 风格:`path:line:` 或 `path:line|` 开头。 */
const SEARCH_LINE = /^(?:[\w.\-~]+\/)*[\w.\-]+\.\w{1,8}:\d+[:|]|^(?:[\w.\-~]+\/)+[\w.\-]+:\d+[:|]/
/** 日志/构建/测试输出的特征:时间戳、级别词、测试框架的行。 */
const LOG_LINE = /^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|^\s*\[?\d{2}:\d{2}:\d{2}|\b(?:ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL|PANIC|CRITICAL)\b|\b(?:PASSED|FAILED|SKIPPED|passed|failed|error\[E\d+\]|Traceback|Exception|npm (?:ERR|WARN)!|Compiling|warning:|error:)\b|^\s+at \S+ \(|^\s+File "|^(?:ok|not ok) \d|^\s*[✓✗]/

export function detectContentKind(text: string, path?: string): ContentKind {
  if (looksLikeCodePath(path) || looksLikeCode(text)) return 'code'
  const lines = text.split('\n').map(strip).filter((l) => l.trim() !== '')
  if (lines.length < 4) return 'data'
  const search = lines.reduce((a, l) => a + (SEARCH_LINE.test(l) ? 1 : 0), 0)
  if (search >= lines.length * 0.6) return 'search'
  const log = lines.reduce((a, l) => a + (LOG_LINE.test(l) ? 1 : 0), 0)
  if (log >= lines.length * 0.3) return 'log'
  return 'data'
}

// ---------------------------------------------------------------- shared renderer

export interface DigestResult {
  text: string
  digested: boolean
  totalLines: number
  keptLines: number
  kind: ContentKind
}

function render(lines: readonly string[], keep: ReadonlySet<number>): string {
  const n = lines.length
  const out: string[] = []
  let i = 0
  while (i < n) {
    if (keep.has(i)) { out.push(lines[i]!); i += 1; continue }
    let j = i
    while (j < n && !keep.has(j)) j += 1
    const run = lines.slice(i, j)
    // 纯空白行的间隔不值一个省略标记(标记比空行还长):折成一个空行。
    if (run.every((l) => strip(l).trim() === '')) { out.push(run[0]!); i = j; continue }
    const elidedChars = run.reduce((a, l) => a + l.length + 1, 0)
    // 精简标记:召回指针只在视图头行给一次(digestForTrajectory 的 `[read … · recall_step(t, s)
    // returns the full text]`),每个标记不再重复——一个文件十几个标记时,标记曾占折后视图近半。
    out.push(`…[+${j - i} lines / ${elidedChars} chars]…`)
    i = j
  }
  return out.join('\n')
}

function cutLongLine(line: string, policy: DigestPolicy): string {
  if (!(line.length > policy.maxLineChars)) return line
  const head = Math.max(0, policy.lineHeadChars)
  const tail = Math.max(0, policy.lineTailChars)
  if (head + tail >= line.length) return line
  return `${line.slice(0, head)} …[+${line.length - head - tail} chars]… ${tail > 0 ? line.slice(-tail) : ''}`
}

function finish(text: string, lines: readonly string[], keep: ReadonlySet<number>, kind: ContentKind, ratio: number): DigestResult {
  const rendered = render(lines, keep)
  if (rendered.length >= text.length * ratio) return { text, digested: false, totalLines: lines.length, keptLines: lines.length, kind }
  return { text: rendered, digested: true, totalLines: lines.length, keptLines: keep.size, kind }
}

const untouched = (text: string, kind: ContentKind): DigestResult => {
  const n = text.split('\n').length
  return { text, digested: false, totalLines: n, keptLines: n, kind }
}

// ---------------------------------------------------------------- data digest(头/尾 + 结构行,自适应块)

export function digestData(text: string, policy: DigestPolicy = DEFAULT_DIGEST_POLICY): DigestResult {
  if (text.length < policy.minChars) return untouched(text, 'data')
  // 超长行先按字符截断(头 + 标记 + 尾),再走按行的头尾/结构行逻辑;finish 用原文长度算保留比,
  // 所以只截了行也算折叠。
  const lines = text.split('\n').map((l) => cutLongLine(l, policy))
  const n = lines.length
  const keep = new Set<number>()
  for (let i = 0; i < Math.min(policy.headLines, n); i += 1) keep.add(i)
  for (let i = Math.max(0, n - policy.tailLines); i < n; i += 1) keep.add(i)
  // 结构块上限只针对"噪音正文里夹着附录表"的混合文件;结构行占比 ≥ 80% 的文件(配置、
  // 数据表)视为整体结构化,不设上限——留给 maxKeepRatio 守卫决定折不折。
  const structuredCount = lines.reduce((a, l) => a + (isStructured(l) ? 1 : 0), 0)
  const cap = structuredCount >= n * 0.8 ? Infinity : policy.structuredBlockCap
  // 自适应保留(Headroom 的 anchor + dedup 思路的简化版):头部区外的结构块,每块至少留
  // structuredBlockMin 行,之后只留"键此前没出现过"的行——同形的附录块(l2 的四个
  // [prior-reconciliation])第二次起只剩前几行。上限 structuredBlockCap。
  const seenKeys = new Set<string>()
  for (let i = 0; i < Math.min(policy.headLines, n); i += 1) if (isStructured(lines[i]!)) seenKeys.add(structuredKey(lines[i]!))
  let kept = 0
  for (let i = 0; i < n; i += 1) {
    if (!isStructured(lines[i]!)) { kept = 0; continue }
    if (i < policy.headLines) continue
    const key = structuredKey(lines[i]!)
    const novel = !seenKeys.has(key)
    seenKeys.add(key)
    if (kept < cap && (kept < policy.structuredBlockMin || novel)) { keep.add(i); kept += 1 }
  }
  return finish(text, lines, keep, 'data', policy.maxKeepRatio)
}

// ---------------------------------------------------------------- log digest(错误优先)

const ERROR_LINE = /\b(?:ERROR|FATAL|PANIC|CRITICAL|FAIL(?:ED|URE|S)?|Traceback|Exception|AssertionError|Segmentation fault|panicked at|npm ERR!|error(?:\[E\d+\]| TS\d+)?:)\b|^\s*(?:✗|not ok|E\s{2,})|\berror\b.*\bexit code\b/i
const WARN_LINE = /\b(?:WARN(?:ING)?|warning:|deprecat(?:ed|ion))\b/i
const SUMMARY_LINE = /^(?:=+ .* =+|-{3,}.*-{3,}|\d+ (?:passed|failed|errors?|warnings?|tests?)\b|Tests?:|Test Suites:|FAILED \(|Ran \d+ tests?|.*\b(?:passed|failed)\b.* in \d|BUILD (?:SUCCESS|FAILED)|Finished\b|test result:|error: could not compile|\d+ problems?\b)/i
const STACK_LINE = /^\s+(?:at \S+|File "|\.{3}|#\d+ |\w+(?:\.\w+)*\(.*\)\s*$|\S+:\d+:\d+)/

/** 相似行去重的键:保留消息前缀(第一个 `:` / `=` 之前),其余归一化数字、十六进制、路径。 */
function dedupeKey(line: string): string {
  const s = strip(line).trim()
  const cut = s.search(/[:=]/)
  const prefix = cut > 0 ? s.slice(0, cut) : ''
  const rest = (cut > 0 ? s.slice(cut) : s)
    .replace(/0x[0-9a-f]+/gi, 'H').replace(/\b[0-9a-f]{7,}\b/gi, 'H').replace(/\S*\/\S+/g, 'P').replace(/\d+/g, '0')
  return `${prefix.replace(/\d+/g, '0')}|${rest}`
}

export function digestLog(text: string, policy: DigestPolicy = DEFAULT_DIGEST_POLICY): DigestResult {
  if (text.length < policy.logMinChars) return untouched(text, 'log')
  const lines = text.split('\n')
  const n = lines.length
  const level = lines.map((l) => (ERROR_LINE.test(strip(l)) ? 3 : WARN_LINE.test(strip(l)) || SUMMARY_LINE.test(strip(l)) ? 2 : 0))
  const seen = new Set<string>()
  const errors: number[] = []
  const warns: number[] = []
  for (let i = 0; i < n; i += 1) {
    if (level[i] === 0) continue
    const key = dedupeKey(lines[i]!)
    if (seen.has(key)) continue
    seen.add(key)
    if (level[i] === 3) errors.push(i); else warns.push(i)
  }
  // Headroom LogCompressor 的选择:错误取首条 + 末条 + 前 maxErrors 条;警告/摘要取前一半配额。
  const pick = new Set<number>()
  const first = errors.slice(0, policy.logMaxErrors)
  for (const i of first) pick.add(i)
  if (errors.length > 0) pick.add(errors[errors.length - 1]!)
  for (const i of warns.slice(0, Math.max(2, Math.floor(policy.logMaxErrors / 2)))) pick.add(i)
  if (warns.length > 0) pick.add(warns[warns.length - 1]!)
  const keep = new Set<number>()
  for (let i = 0; i < Math.min(3, n); i += 1) keep.add(i)
  for (let i = Math.max(0, n - 6); i < n; i += 1) keep.add(i)
  for (const i of pick) {
    for (let k = Math.max(0, i - policy.logContextLines); k <= Math.min(n - 1, i + policy.logContextLines); k += 1) keep.add(k)
    // 紧随错误行的栈帧整段保留(链式异常里的空行不终止)。
    if (level[i] === 3) {
      let k = i + 1
      while (k < n && (STACK_LINE.test(lines[k]!) || strip(lines[k]!).trim() === '')) { keep.add(k); k += 1 }
    }
  }
  return finish(text, lines, keep, 'log', policy.maxKeepRatio)
}

// ---------------------------------------------------------------- entry points

/** 兼容入口:按 data 规则折(旧调用方与测试)。 */
export function digestText(text: string, _recallHint: string, policy: DigestPolicy = DEFAULT_DIGEST_POLICY): DigestResult {
  return digestData(text, policy)
}

/** 工具结果入口:按工具名与内容类型路由。 */
export function digestToolResult(text: string, source: { tool: string; path?: string }, policy: DigestPolicy = DEFAULT_DIGEST_POLICY): DigestResult {
  if (source.tool === 'grep' || source.tool === 'glob' || source.tool === 'recall_step' || source.tool === 'recall_turn' || source.tool === 'recall_search') return untouched(text, 'search')
  // 文件读取按"文档"处理:文件里夹着的部署日志/历史记录不改变它是文档的事实(l1 节点
  // 的字段在头部,走 log 规则会把它们折掉);只有 bash 等命令输出才按内容判 log/search。
  const isFileRead = source.tool === 'read' || source.tool === 'read_file' || source.tool === 'read_section'
  const kind: ContentKind = isFileRead
    ? (looksLikeCodePath(source.path) || looksLikeCode(text) ? 'code' : 'data')
    : detectContentKind(text, source.path)
  if (kind === 'code' || kind === 'search') return untouched(text, kind)
  if (kind === 'log') return digestLog(text, policy)
  return digestData(text, policy)
}

export function resolveDigestPolicy(input: Partial<DigestPolicy> | undefined): DigestPolicy {
  const p = { ...DEFAULT_DIGEST_POLICY, ...(input ?? {}) }
  if (!Number.isInteger(p.minChars) || p.minChars < 0) throw new Error('digest.minChars must be a non-negative integer')
  if (!Number.isInteger(p.logMinChars) || p.logMinChars < 0) throw new Error('digest.logMinChars must be a non-negative integer')
  if (!(p.maxLineChars > 0)) throw new Error('digest.maxLineChars must be > 0 (Infinity = never cut)')
  if (!Number.isInteger(p.lineHeadChars) || p.lineHeadChars < 0 || !Number.isInteger(p.lineTailChars) || p.lineTailChars < 0) throw new Error('digest.lineHeadChars/lineTailChars must be non-negative integers')
  if (!Number.isInteger(p.headLines) || p.headLines < 0 || !Number.isInteger(p.tailLines) || p.tailLines < 0) throw new Error('digest.headLines/tailLines must be non-negative integers')
  if (!(p.maxKeepRatio > 0 && p.maxKeepRatio <= 1)) throw new Error('digest.maxKeepRatio must be in (0, 1]')
  if (!(p.structuredBlockCap >= 1)) throw new Error('digest.structuredBlockCap must be >= 1 (Infinity = no cap)')
  if (!Number.isInteger(p.structuredBlockMin) || p.structuredBlockMin < 0) throw new Error('digest.structuredBlockMin must be a non-negative integer')
  if (!Number.isInteger(p.logMaxErrors) || p.logMaxErrors < 1 || !Number.isInteger(p.logContextLines) || p.logContextLines < 0) throw new Error('digest.logMaxErrors/logContextLines invalid')
  if (typeof p.enabled !== 'boolean') throw new Error('digest.enabled must be a boolean')
  return p
}
