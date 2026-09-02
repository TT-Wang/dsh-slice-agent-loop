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
  /** 低于此字符数不折。 */
  minChars: number
  headLines: number
  tailLines: number
  /** 折后 ≥ 原文的这个比例就放弃(不值一次省略)。 */
  maxKeepRatio: number
}

export const DEFAULT_DIGEST_POLICY: DigestPolicy = { minChars: 1500, headLines: 10, tailLines: 4, maxKeepRatio: 0.55 }

/** 结构行:`key = value`、`key: value`、markdown/注释标题、围栏。噪音正文极少长这样。 */
const STRUCTURED = /^\s*(?:[A-Za-z_][\w.\-]*\s*[=:]\s*\S|#{1,6}\s|\[[^\]]+\]\s*$|```)/

export interface DigestResult {
  text: string
  digested: boolean
  totalLines: number
  keptLines: number
}

export function digestText(text: string, recallHint: string, policy: DigestPolicy = DEFAULT_DIGEST_POLICY): DigestResult {
  if (text.length < policy.minChars) return { text, digested: false, totalLines: text.split('\n').length, keptLines: text.split('\n').length }
  const lines = text.split('\n')
  const n = lines.length
  const keep = new Set<number>()
  for (let i = 0; i < Math.min(policy.headLines, n); i += 1) keep.add(i)
  for (let i = Math.max(0, n - policy.tailLines); i < n; i += 1) keep.add(i)
  for (let i = 0; i < n; i += 1) if (STRUCTURED.test(lines[i]!)) keep.add(i)

  const out: string[] = []
  let i = 0
  while (i < n) {
    if (keep.has(i)) { out.push(lines[i]!); i += 1; continue }
    let j = i
    while (j < n && !keep.has(j)) j += 1
    const elidedChars = lines.slice(i, j).reduce((a, l) => a + l.length + 1, 0)
    out.push(`…[${j - i} lines / ${elidedChars} chars elided — ${recallHint} for the full text]…`)
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
  return p
}
