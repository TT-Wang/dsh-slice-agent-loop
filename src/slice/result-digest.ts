/**
 * result-digest.ts — 注入时摘要(insertion-time digest)。
 *
 * v3「追加流」模式的核心杠杆:成本由每步**新增字节**决定(严格前缀缓存下命中价是
 * 未命中的 1/30),所以大工具结果在进入上下文之前就折成紧凑视图——头/尾若干行 +
 * 全部结构行(`key = value` / `key: value` / 标题行)+ 精确省略标记与召回指针。
 * 全文原样留在会话日志(recall_step 逐字取回);上下文里从此只有紧凑视图,且永不
 * 重写——append-only,缓存完美。
 *
 * 守卫:小结果不折;折后体量 ≥ 原文 × maxKeepRatio 也不折(折了不省就别折)。
 */

export interface DigestPolicy {
  /** 轮内折叠开关(slice / stream 模式默认开;state 模式不用)。 */
  enabled: boolean
  /** 低于此字符数不折。 */
  minChars: number
  headLines: number
  tailLines: number
  /** 折后 ≥ 原文的这个比例就放弃(不值一次省略)。 */
  maxKeepRatio: number
  /**
   * 头部区之外,每个连续结构行块最多保留几行(其余并入省略)。Infinity = 不限。
   * 依据:字段型文件的"正文字段"在头部;深处成块出现的 key: value 多是附录表
   * (l2 记录里的 [prior-reconciliation] 块占了折后视图的一半),需要时一步可召回。
   */
  structuredBlockCap: number
}

export const DEFAULT_DIGEST_POLICY: DigestPolicy = { enabled: true, minChars: 1500, headLines: 10, tailLines: 4, maxKeepRatio: 0.55, structuredBlockCap: 4 }

/** 结构行:`key = value`、`key: value`、markdown/注释标题、围栏。噪音正文极少长这样。 */
const STRUCTURED = /^\s*(?:[A-Za-z_][\w.\-]*\s*[=:]\s*\S|#{1,6}\s|\[[^\]]+\]\s*$|```)/
/** read 工具按 OpenCode 风格给每行加 `N: ` 前缀(grep 是 `N|`/`N:`);判结构前先剥掉。 */
const LINE_NUMBER_PREFIX = /^\s*\d+[:|]\s?/

function isStructured(line: string): boolean {
  return STRUCTURED.test(line.replace(LINE_NUMBER_PREFIX, ''))
}

export interface DigestResult {
  text: string
  digested: boolean
  totalLines: number
  keptLines: number
}

export function digestText(text: string, _recallHint: string, policy: DigestPolicy = DEFAULT_DIGEST_POLICY): DigestResult {
  if (text.length < policy.minChars) return { text, digested: false, totalLines: text.split('\n').length, keptLines: text.split('\n').length }
  const lines = text.split('\n')
  const n = lines.length
  const keep = new Set<number>()
  for (let i = 0; i < Math.min(policy.headLines, n); i += 1) keep.add(i)
  for (let i = Math.max(0, n - policy.tailLines); i < n; i += 1) keep.add(i)
  // 结构块上限只针对"噪音正文里夹着附录表"的混合文件;结构行占比 ≥ 80% 的文件(配置、
  // 数据表、多数代码)视为整体结构化,不设上限——留给 maxKeepRatio 守卫决定折不折。
  const structuredCount = lines.reduce((a, l) => a + (isStructured(l) ? 1 : 0), 0)
  const cap = structuredCount >= n * 0.8 ? Infinity : policy.structuredBlockCap
  let run = 0
  for (let i = 0; i < n; i += 1) {
    if (!isStructured(lines[i]!)) { run = 0; continue }
    if (i < policy.headLines || run < cap) keep.add(i)
    run += 1
  }

  const out: string[] = []
  let i = 0
  while (i < n) {
    if (keep.has(i)) { out.push(lines[i]!); i += 1; continue }
    let j = i
    while (j < n && !keep.has(j)) j += 1
    const run = lines.slice(i, j)
    // 纯空白行的间隔不值一个省略标记(标记比空行还长):折成一个空行。
    if (run.every((l) => l.replace(LINE_NUMBER_PREFIX, '').trim() === '')) { out.push(run[0]!); i = j; continue }
    const elidedChars = run.reduce((a, l) => a + l.length + 1, 0)
    // 精简标记:召回指针只在视图头行给一次(digestForTrajectory 的 `[read … · recall_step(t, s)
    // returns the full text]`),每个标记不再重复——一个文件十几个标记时,标记曾占折后视图近半。
    out.push(`…[+${j - i} lines / ${elidedChars} chars]…`)
    i = j
  }
  const rendered = out.join('\n')
  if (rendered.length >= text.length * policy.maxKeepRatio) {
    return { text, digested: false, totalLines: n, keptLines: n }
  }
  return { text: rendered, digested: true, totalLines: n, keptLines: keep.size }
}

export function resolveDigestPolicy(input: Partial<DigestPolicy> | undefined): DigestPolicy {
  const p = { ...DEFAULT_DIGEST_POLICY, ...(input ?? {}) }
  if (!Number.isInteger(p.minChars) || p.minChars < 0) throw new Error('digest.minChars must be a non-negative integer')
  if (!Number.isInteger(p.headLines) || p.headLines < 0 || !Number.isInteger(p.tailLines) || p.tailLines < 0) throw new Error('digest.headLines/tailLines must be non-negative integers')
  if (!(p.maxKeepRatio > 0 && p.maxKeepRatio <= 1)) throw new Error('digest.maxKeepRatio must be in (0, 1]')
  if (!(p.structuredBlockCap >= 1)) throw new Error('digest.structuredBlockCap must be >= 1 (Infinity = no cap)')
  if (typeof p.enabled !== 'boolean') throw new Error('digest.enabled must be a boolean')
  return p
}
