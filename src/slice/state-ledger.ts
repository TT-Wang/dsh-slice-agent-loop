/**
 * state-ledger.ts — 世界状态循环(World-State Loop)的纯函数层。
 *
 * 上下文是状态,不是历史。本模块定义三样东西并负责它们的字节稳定渲染:
 *  - 宪法(Constitution):本轮用户请求原文 + 早期读取即钉住的文件 + 规则
 *    (原文 并且 可执行谓词)。一整轮逐字不变。
 *  - 世界状态账本(StateLedger):append-only。文件日志(每次读/写追加一行,
 *    "当前态" = 每路径最后一行)与事实账本(修正 = 追加新条目 + 旧条目打
 *    supersededBy 标记)。字节只增不改 → 前缀缓存友好。
 *  - 契约(Predicate):宿主在写文件后校验,违反即回滚并打回模型。
 *
 * 不做 I/O、不认识 driver。driver 负责从会话事件提取、组装请求、执行契约。
 */

// ───────────────────────────────────────────────────────────── 文件日志

export type FileAction = 'read' | 'write' | 'edit' | 'external' | 'reverted'

export interface FileRow {
  path: string
  /** sha256 前 12 位;读取失败/不存在时为 '-'。 */
  sha: string
  action: FileAction
  step: number
}

// ───────────────────────────────────────────────────────────── 事实账本

export type FactKind = 'rule' | 'fact' | 'decision' | 'file-state' | 'obligation'

export interface Fact {
  id: number
  kind: FactKind
  text: string
  /** 出处摘要:绑定一条会话事件或一个文件区间。宿主提取的事实用 'host:<seq>'。 */
  sourceDigest: string
  step: number
  supersededBy?: number
}

export interface StateLedger {
  /** append-only 文件事件日志。 */
  fileLog: FileRow[]
  /** append-only 事实。 */
  facts: Fact[]
  nextFactId: number
}

export function createLedger(): StateLedger {
  return { fileLog: [], facts: [], nextFactId: 1 }
}

export function recordFile(ledger: StateLedger, row: FileRow): void {
  // 同路径同 sha 同动作的重复读取不再追加(读 5 次同一文件只记一次)。
  const last = [...ledger.fileLog].reverse().find((r) => r.path === row.path)
  if (last && last.sha === row.sha && last.action === row.action) return
  ledger.fileLog.push(row)
}

/** 每路径的当前态(最后一行)。 */
export function currentFiles(ledger: StateLedger): Map<string, FileRow> {
  const m = new Map<string, FileRow>()
  for (const r of ledger.fileLog) m.set(r.path, r)
  return m
}

export function addFact(ledger: StateLedger, input: Omit<Fact, 'id' | 'supersededBy'>): Fact {
  const fact: Fact = { id: ledger.nextFactId, ...input }
  ledger.nextFactId += 1
  ledger.facts.push(fact)
  return fact
}

/** 修正:追加新条目,旧条目打标。旧条目字节不变(只在其行尾追加 ⇒ 标记会改字节,
 *  所以标记渲染在新条目一侧:"#new supersedes #old")。 */
export function supersedeFact(ledger: StateLedger, oldId: number, input: Omit<Fact, 'id' | 'supersededBy'>): Fact {
  const old = ledger.facts.find((f) => f.id === oldId)
  const fact = addFact(ledger, input)
  if (old) old.supersededBy = fact.id
  return fact
}

/** 未被取代的事实。 */
export function liveFacts(ledger: StateLedger): Fact[] {
  return ledger.facts.filter((f) => f.supersededBy === undefined)
}

// ───────────────────────────────────────────────────────────── 渲染

export const STATE_HDR =
  '# WORLD STATE (host-maintained, append-only. FILES: one line per observed read/write, the LAST line '
  + 'per path is the current on-disk truth (sha256:12). FACTS: numbered; a later "#n supersedes #m" line '
  + 'retires #m — read the latest. Nothing here is a transcript; it is what is currently true and what '
  + 'is still owed. Full tool history stays in the session log: recall_step(turn, step) returns it verbatim)\n'

/**
 * 字节稳定渲染:文件日志与事实账本都只在尾部追加。同一账本状态两次渲染同字节;
 * 账本追加后,新渲染以旧渲染为前缀(不含结尾的分节空行以外的差异)。
 */
export function renderLedger(ledger: StateLedger): string {
  const lines: string[] = [STATE_HDR, '## files']
  for (const r of ledger.fileLog) lines.push(`${r.path} · ${r.sha} · ${r.action} @${r.step}`)
  lines.push('## facts')
  for (const f of ledger.facts) {
    const sup = f.supersededBy === undefined ? '' : ''
    lines.push(`#${f.id} [${f.kind}] ${f.text}  (src:${f.sourceDigest} @${f.step})${sup}`)
    // 取代关系渲染在新条目行之后,作为独立行追加——旧行字节不动。
  }
  // 取代标记:按新条目顺序追加(append-only)。
  for (const f of ledger.facts) {
    if (f.supersededBy !== undefined) {
      // 由被取代方指向取代方——但要 append-only,所以按取代方 id 排序输出
    }
  }
  const sup = ledger.facts
    .filter((f) => f.supersededBy !== undefined)
    .sort((a, b) => a.supersededBy! - b.supersededBy!)
    .map((f) => `#${f.supersededBy} supersedes #${f.id}`)
  if (sup.length > 0) lines.push(...sup)
  return lines.join('\n') + '\n'
}

// ───────────────────────────────────────────────────────────── 宪法与契约

export type Predicate =
  | { kind: 'path-regex'; glob: string; pattern: string }
  | { kind: 'content-includes'; glob: string; needle: string }
  | { kind: 'content-excludes'; glob: string; needle: string }
  | { kind: 'line-max'; glob: string; max: number }
  | { kind: 'line-regex'; glob: string; pattern: string; every: boolean }
  | { kind: 'field-enum'; glob: string; field: string; values: string[] }

export interface Rule {
  id: string
  text: string
  predicate?: Predicate
}

export interface Constitution {
  request: string
  /** 早期读取即钉住:前 N 步读取的文件全文。 */
  pinned: { path: string; text: string }[]
  rules: Rule[]
}

export const CONSTITUTION_HDR =
  '# CONSTITUTION (fixed for this whole turn. The user request verbatim, the files read at the very start '
  + '(pinned in full — they usually carry the rules), and the extracted rules. Rules marked [enforced] are '
  + 'checked by the host on every write: a violating write is reverted and returned to you as an error)\n'

export function renderConstitution(c: Constitution): string {
  const parts: string[] = [CONSTITUTION_HDR, '## request', c.request.trim(), '']
  for (const p of c.pinned) parts.push(`## pinned: ${p.path}`, p.text.replace(/\n+$/, ''), '')
  if (c.rules.length > 0) {
    parts.push('## rules')
    for (const r of c.rules) parts.push(`${r.id}${r.predicate ? ' [enforced]' : ''}: ${r.text}`)
    parts.push('')
  }
  return parts.join('\n')
}

/** 极简 glob → RegExp:`**` 任意路径,`*` 单段,`?` 单字符。相对路径匹配。 */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!
    if (ch === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i += 1 } else re += '[^/]*'
    } else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

function matchesGlob(glob: string, path: string): boolean {
  const norm = path.replace(/^\.\//, '')
  return globToRegExp(glob).test(norm) || globToRegExp(glob).test(norm.split('/').pop() ?? norm)
}

/** 返回违反项说明;空数组 = 通过。谓词的 glob 不匹配该路径则跳过。 */
export function checkPredicates(rules: readonly Rule[], path: string, content: string): string[] {
  const out: string[] = []
  const lines = content.split('\n')
  for (const r of rules) {
    const p = r.predicate
    if (!p || !matchesGlob(p.glob, path)) continue
    switch (p.kind) {
      case 'path-regex':
        if (!new RegExp(p.pattern).test(path.split('/').pop() ?? path)) out.push(`${r.id}: path "${path}" does not match /${p.pattern}/`)
        break
      case 'content-includes':
        if (!content.includes(p.needle)) out.push(`${r.id}: content must include ${JSON.stringify(p.needle)}`)
        break
      case 'content-excludes':
        if (content.includes(p.needle)) out.push(`${r.id}: content must not include ${JSON.stringify(p.needle)}`)
        break
      case 'line-max': {
        const bad = lines.findIndex((l) => Array.from(l).length > p.max)
        if (bad !== -1) out.push(`${r.id}: line ${bad + 1} exceeds ${p.max} chars`)
        break
      }
      case 'line-regex': {
        const re = new RegExp(p.pattern)
        const hits = lines.filter((l) => re.test(l))
        if (p.every ? hits.length !== lines.filter((l) => l.trim() !== '').length : hits.length === 0)
          out.push(`${r.id}: ${p.every ? 'every non-empty line' : 'at least one line'} must match /${p.pattern}/`)
        break
      }
      case 'field-enum': {
        const re = new RegExp(`^\\s*${p.field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[=:]\\s*(.+?)\\s*$`)
        for (const l of lines) {
          const m = l.match(re)
          if (m && !p.values.includes(m[1]!)) out.push(`${r.id}: ${p.field} = ${JSON.stringify(m[1])} not in {${p.values.join(', ')}}`)
        }
        break
      }
    }
  }
  return out
}

/** 防御式解析模型产出的规则 JSON:非法条目降级为纯文本规则(无谓词);整体非法返回 []。 */
export function parseRulesJson(text: string): Rule[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return []
  let arr: unknown
  try { arr = JSON.parse(text.slice(start, end + 1)) } catch { return [] }
  if (!Array.isArray(arr)) return []
  const KINDS = new Set(['path-regex', 'content-includes', 'content-excludes', 'line-max', 'line-regex', 'field-enum'])
  const rules: Rule[] = []
  arr.forEach((item, i) => {
    if (!item || typeof item !== 'object') return
    const o = item as Record<string, unknown>
    const textVal = typeof o.text === 'string' ? o.text.trim() : ''
    if (!textVal) return
    const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : `R${i + 1}`
    let predicate: Predicate | undefined
    const p = o.predicate as Record<string, unknown> | undefined
    if (p && typeof p === 'object' && KINDS.has(String(p.kind)) && typeof p.glob === 'string') {
      try {
        switch (p.kind) {
          case 'path-regex': if (typeof p.pattern === 'string') { new RegExp(p.pattern); predicate = { kind: 'path-regex', glob: p.glob, pattern: p.pattern } } break
          case 'content-includes': if (typeof p.needle === 'string') predicate = { kind: 'content-includes', glob: p.glob, needle: p.needle }; break
          case 'content-excludes': if (typeof p.needle === 'string') predicate = { kind: 'content-excludes', glob: p.glob, needle: p.needle }; break
          case 'line-max': if (Number.isInteger(p.max) && (p.max as number) > 0) predicate = { kind: 'line-max', glob: p.glob, max: p.max as number }; break
          case 'line-regex': if (typeof p.pattern === 'string') { new RegExp(p.pattern); predicate = { kind: 'line-regex', glob: p.glob, pattern: p.pattern, every: p.every === true } } break
          case 'field-enum': if (typeof p.field === 'string' && Array.isArray(p.values)) predicate = { kind: 'field-enum', glob: p.glob, field: p.field, values: (p.values as unknown[]).map(String) }; break
        }
      } catch { predicate = undefined }
    }
    rules.push(predicate ? { id, text: textVal, predicate } : { id, text: textVal })
  })
  return rules
}

/** 规则提取提示:给一次廉价模型调用。输出严格 JSON 数组。 */
export function rulesExtractionPrompt(c: Constitution): string {
  return [
    'Extract every concrete, checkable rule the agent must obey when producing output files, from the REQUEST and the PINNED files below.',
    'Return ONLY a JSON array. Each item: {"id":"R1","text":"<rule in one sentence, keep exact values>","predicate":<optional>}.',
    'predicate (only when the rule is mechanically checkable on a written file) is one of:',
    '  {"kind":"path-regex","glob":"<which files>","pattern":"<regex the FILENAME must match>"}',
    '  {"kind":"content-includes","glob":"<which files>","needle":"<exact literal that must appear>"}',
    '  {"kind":"content-excludes","glob":"<which files>","needle":"<exact literal that must NOT appear>"}',
    '  {"kind":"line-max","glob":"<which files>","max":<int>}',
    '  {"kind":"line-regex","glob":"<which files>","pattern":"<regex>","every":true|false}',
    '  {"kind":"field-enum","glob":"<which files>","field":"<key>","values":["v1","v2"]}',
    'glob is relative to the working directory (e.g. "out/*.svc", "**/*.md"). Omit predicate for rules you cannot express with these kinds — keep the text anyway.',
    'Do not invent rules. Keep exact literals, numbers and enumerations from the source.',
    '',
    '=== REQUEST ===',
    c.request.trim(),
    ...c.pinned.flatMap((p) => ['', `=== PINNED: ${p.path} ===`, p.text.replace(/\n+$/, '')]),
  ].join('\n')
}
