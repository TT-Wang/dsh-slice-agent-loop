/**
 * continuity.ts — sliceagent 跨轮连续性语义（record_user + 对话环 + tape 封存）
 * 的 TS 实现，移植自 sliceagent-core（pfc.record_user / tape.tape_seal_update /
 * regions.reserve_keep），语义参考实现：dsh-slice sidecar server.py（实战验证）。
 *
 * 三件套：
 *   1. recordUser   — 每轮用户请求进对话环（环是 tape 的输入底料，有界）
 *   2. fillAssistant — 轮内助手答复落环的助手侧（reducer 守卫：环空则弃）
 *   3. sealTurn     — 轮末把本轮 digest + 文件锚点 + 答复冻结进 SESSION TAPE，
 *                     并跑 compactTape GC。下一轮 slice 的近期交换呈现层。
 *
 * PFC 携带 = 本模块的 Continuity 对象随 agent 存活（每会话一份），每轮
 * assembleSlice() 重建有界切片——bounded slice ≠ 每轮从零开始。
 */
import { createHash } from 'node:crypto'
import {
  TapeEntry,
  baseEntry,
  patchEntry,
  externalEntry,
  replyEntry,
  reasoningEntry,
  digestEntry,
  compactTape,
  tapeChars,
  REPLY_CAP_CHARS,
} from './slice/tape.js'
import { pyStrip } from './slice/internal/pytext.js'
import { redactText } from './slice/internal/safety.js'

// ---------------------------------------------------------------- ring bounds

/** 环行数下限（regions.py:46 MAX_CONVERSATION）。 */
const RING_FLOOR = 4
/** 用户侧逐字预算（token 粗估 chars/4）：下限行数外按预算放宽。 */
const RING_USER_BUDGET_TOKENS = 2000
/** 行数硬顶（RESERVE_ROWS_CEILING 的 MVP 值）。 */
const RING_ROWS_CEILING = 12

function ringKeep(rows: readonly unknown[]): number {
  // 简化版 reserve_keep：floor 4；用户字符预算内放宽；硬顶 12。
  let keep = RING_FLOOR
  let chars = 0
  for (let i = rows.length - 1; i >= 0 && keep < RING_ROWS_CEILING; i--) {
    const u = String((rows[i] as { user?: unknown })?.user ?? '')
    if (i < rows.length - RING_FLOOR && chars + u.length > RING_USER_BUDGET_TOKENS * 4) break
    chars += u.length
    keep = rows.length - i
  }
  return Math.min(Math.max(keep, RING_FLOOR), rows.length)
}

// ---------------------------------------------------------------- state

export interface ConversationRow {
  user: string
  assistant: string
  /** Owning turn number (surface-replacement retargeting); absent for legacy rows. */
  turn?: number
}

export interface TapeFileState {
  hash: string
  content: string
}

export interface Continuity {
  /** 首条 prompt 即话题 goal（system 侧渲染，跨轮不变直到换题）。 */
  goal: string
  /**
   * 写入 goal 的那一轮轮号。表面替换（compaction）据此定位要改写的 goal——
   * 绝不靠对话环反查：环有 12 行硬顶，老轮滑出后就再也找不到，被声明已遮蔽的
   * 原始用户文本会永久留在 task_objective（USER 权级、mandatory）里逐轮发出。
   */
  goalTurn?: number
  conversation: ConversationRow[]
  sessionTape: TapeEntry[]
  tapeFiles: Record<string, TapeFileState>
  /** 本轮编辑过的文件（成功 tool/result 边界快照后态，seal 时锚定后清空）。 */
  pendingEdits: Array<{ path: string; body: string }>
  /**
   * 本轮**最后一个** tool/result 的错误正文（成功结果清空）。轮内的失败模型
   * 本来就在轨迹里看得见；这里攒的是"这一轮结束时还挂着一个失败调用"，
   * seal 时转成 {@link Continuity.lastError} 供下一轮的 CURRENT ERROR 段用。
   */
  pendingError: string
  /** 本轮各步的推理链原文(实时与重放同源累积),seal 时整段上带后清空。 */
  pendingReasoning: string[]
  /** 上一轮结束时未解决的工具错误原文，渲染为 CURRENT ERROR 段。 */
  lastError: string
  /** 每轮封存的元数据（turnId → status/files），表面替换重写 digest 时按原样再渲染。 */
  sealMeta: Record<string, { status: string; files: string[] }>
  turns: number
}

export function createContinuity(): Continuity {
  return {
    goal: '',
    conversation: [],
    sessionTape: [],
    tapeFiles: {},
    pendingEdits: [],
    pendingError: '',
    pendingReasoning: [],
    lastError: '',
    sealMeta: {},
    turns: 0,
  }
}

// ---------------------------------------------------------------- ring write

/** record_user：用户请求进环 + 计轮 + 环修剪（pfc.py:398-442 语义）。 */
export function recordUser(c: Continuity, text: string, turn?: number): void {
  c.turns += 1
  c.conversation.push(turn === undefined ? { user: text, assistant: '' } : { user: text, assistant: '', turn })
  c.conversation = c.conversation.slice(-ringKeep(c.conversation))
}

/** reducer 的 AssistantText 守卫：只有 final 且环非空才落助手侧。 */
export function fillAssistant(c: Continuity, text: string): void {
  if (c.conversation.length === 0 || !text.trim()) return
  c.conversation[c.conversation.length - 1].assistant = text
}

// ---------------------------------------------------------------- turn digest

const ASK_CAP_CHARS = 1000
/** 截断保留的头/尾配比。尾部单独保留:长 ask 的**结尾**往往是真正的动作要求
 * ("只写值本身"/"回复 X 即可"/正文最后几条),只留头会把它们全部切掉——
 * 头+尾在同等预算下严格多信息(n1/n3 场景的 ask 形状实测)。 */
const ASK_HEAD_CHARS = 700
const ASK_TAIL_CHARS = 250

/** render_turn_digest 的 TS 移植（spine.py:35-87，无 segment 变体）。 */
export function renderTurnDigest(opts: {
  artifactId: string
  taskId?: string
  status: string
  userRequest: string
  sessionId: string
  files?: readonly string[]
  /** The sealed reply exceeded REPLY_CAP_CHARS — sealTurn computes it with the tape's own predicate. */
  replyTruncated?: boolean
}): string {
  const aid = opts.artifactId || 'unknown'
  const head = `[turn ${aid} · task ${opts.taskId || 'unknown'} · ${opts.status || 'unknown'}]`
  const raw = opts.userRequest.trim()
  const ask = raw.length > ASK_CAP_CHARS
    ? `${raw.slice(0, ASK_HEAD_CHARS)} …[+${raw.length - ASK_HEAD_CHARS - ASK_TAIL_CHARS} chars in sealed turn]… ${raw.slice(-ASK_TAIL_CHARS)}`
    : raw || '(empty request)'
  // 防伪:ask 的续行缩进两格。digest 不是字节锚定物(原文靠 recall_turn),
  // 缩进无损语义,却让用户文本永远无法顶格冒充段头或条目标记。
  const lines = [head, `ask: ${ask.replace(/\n/g, '\n  ')}`]
  const fs = [...new Set((opts.files ?? []).filter((f) => f.trim()))].sort()
  if (fs.length > 0) {
    const shown = fs.slice(0, 8).join(', ')
    lines.push(`files: ${shown}${fs.length > 8 ? ` (+${fs.length - 8} more)` : ''}`)
  }
  // The recall line renders ONLY when something was actually cut — the ask at
  // ASK_CAP_CHARS or the reply at REPLY_CAP_CHARS. An uncut turn advertises
  // nothing: the tool's own catalog description covers discovery, and a
  // per-digest line on every turn was measured at ~106 chars x 35 sealed turns
  // of pure waste in one session.
  //
  // Unlike the locator this replaces (@sliceagent/history/..., a route into
  // the Python engine's virtual filesystem that nothing in DSH can serve —
  // docs/modification-spec.md records the 20-step search spiral it caused),
  // recall_turn is a REAL registered tool: src/recall.ts serves the verbatim
  // text from the durable session log, the same source agent recreation
  // rebuilds from. The rendered shape names the tool and its exact argument,
  // and the call-name gate in driver-contract.spec.ts holds the pair honest.
  const askTruncated = raw.length > ASK_CAP_CHARS
  if (askTruncated || opts.replyTruncated === true) {
    lines.push(`recall: recall_turn({"turn": "${aid}"}) for the verbatim record`)
  }
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------- seal

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * tape_seal_update 的 MVP 子集（tape.py:426 起）：digest + 文件锚定（patch/base
 * 取渲染更短者）+ 答复冻结 + compactTape GC。
 * 未含（与 sidecar 同级）：finding/knowledge 条目、spine digest、journal 落盘、
 * 离带漂移检测（dsh-tools 的工具结果不带文件后态，漂移检测待 dsh 侧钩子）。
 */
export function sealTurn(
  c: Continuity,
  opts: {
    turnId: string
    status: string
    userRequest: string
    assistantReply: string
    sessionId: string
  },
): { entries: number; gcRemoved: number; epochFolds: number; anchored: Array<{ path: string; body: string }> } {
  const tape = c.sessionTape
  const files = c.tapeFiles

  tape.push(digestEntry(renderTurnDigest({
    artifactId: opts.turnId,
    status: opts.status,
    userRequest: opts.userRequest,
    sessionId: opts.sessionId,
    files: opts.status === 'completed' ? c.pendingEdits.map((e) => e.path) : [],
    // The tape's own cut predicate (renderTapeReply: pyStrip, then code
    // points), so the line and the marker can never disagree about whether a
    // cut happened. Computed here because both the live seal and the
    // restoreContinuity replay route through sealTurn with the ring's full
    // reply — the rebuilt digest is byte-identical by construction.
    replyTruncated: Array.from(pyStrip(opts.assistantReply)).length > REPLY_CAP_CHARS,
  }), opts.turnId))
  c.sealMeta[opts.turnId] = {
    status: opts.status,
    files: opts.status === 'completed' ? c.pendingEdits.map((e) => e.path) : [],
  }

  // 文件锚定：编辑后态 → base/patch 取渲染更短者（tape.py:_anchor 语义）。
  // 后态在成功 tool/result 边界即已快照 + 脱敏（redactText codeFile 模式）——
  // 一轮内对同一文件的多次成功编辑各自锚定，不塌缩为最终盘态。
  // anchored 返回给 driver 落 durable 事件，供重建恢复（tape 耐久性）。
  const anchored: Array<{ path: string; body: string }> = []
  for (const { path, body } of c.pendingEdits) {
    const state = files[path]
    const hash = sha256(body)
    if (state !== undefined && state.hash === hash) continue // 幂等编辑
    const base = baseEntry(path, body)
    if (state === undefined) {
      tape.push(base)
    } else {
      // 不是"谁短用谁":base 可被 GC(后续 base 一出现,它之前的历史整段可删),
      // patch 只能等 fold。近似平手时选 patch 是拿永久占位换几个字节——patch
      // 必须省出实质空间才值得。0.9 在真实会话里不改变任何选择(有价值的
      // patch 远小于 base 的 10%),只铲掉 |patch−base| 落在标记字节量级内时
      // 的抖动:曾因 end 标记 +26B 把选型翻成 patch 流,折叠 4 次 → 39 次。
      const patch = patchEntry(path, state.content, body)
      tape.push(patch.rendered.length < base.rendered.length * 0.9 ? patch : base)
    }
    files[path] = { hash, content: body }
    anchored.push({ path, body })
  }
  c.pendingEdits = []

  // 轮末结算未解决的工具错误。本轮最后一个 tool/result 失败 ⇒ 下一轮的
  // CURRENT ERROR 段带上它；成功或本轮没有工具调用 ⇒ 清空。错误正文不进
  // tape——tape 是已封存的历史，CURRENT ERROR 是"现在还没解决的症状"。
  c.lastError = c.pendingError
  c.pendingError = ''

  // 推理链上带:think → answer 的顺序(reasoning 在 reply 前)。空则不占位。
  const rsn = reasoningEntry(opts.turnId, c.pendingReasoning.join('\n'))
  if (rsn !== null) tape.push(rsn)
  c.pendingReasoning = []

  const rep = replyEntry(opts.turnId, opts.assistantReply)
  if (rep !== null) tape.push(rep)

  const info = compactTape(tape, files)
  return { entries: tape.length, gcRemoved: info.gc_removed, epochFolds: info.epoch_folds, anchored }
}

/**
 * 编辑后态快照（driver 在成功 tool/result 边界调用）：立即读取盘态并做
 * codeFile 脱敏后留存——tape 永远只锚定脱敏字节，hash 也落在脱敏字节上
 * （seed.py HASH SEAM 同构），且一轮内多次成功编辑各自保留自己的后态。
 */
export function trackEdit(c: Continuity, path: string, body: string): void {
  if (path.trim()) c.pendingEdits.push({ path, body: redactText(body, { codeFile: true }) })
}

/**
 * 工具结果结算（driver 在每个 tool/result 边界调用，实时与重放两条路都要走）。
 * 最后一个结果说了算：失败留下正文，成功清空。正文过 redactText —— CURRENT
 * ERROR 段直接进上下文，和 tape 走同一条安全边界（SEAMS S1 Trust）。
 */
export function trackToolOutcome(c: Continuity, isError: boolean, text: string): void {
  c.pendingError = isError ? redactText(text.trim()) : ''
}

/** 本轮一步的推理链(模型自产,与 reply 同级——原样,不脱敏不截断)。 */
export function trackReasoning(c: Continuity, text: string): void {
  if (text) c.pendingReasoning.push(text)
}

/** 观测用：当前携带态的切片体积（tape 字符数 + 环行数）。 */
export function continuityStats(c: Continuity): { tapeChars: number; ringRows: number; files: number } {
  return { tapeChars: tapeChars(c.sessionTape), ringRows: c.conversation.length, files: Object.keys(c.tapeFiles).length }
}

/**
 * 表面替换（canonical surface compaction）落实到携带态——按组件粒度：
 * patch.user 重写该轮的话题 goal（若出自该轮）、环行用户侧、以及 tape
 * digest 的 ask（按 sealMeta 原样再渲染）；patch.assistant 重写环行助手侧
 * 与 tape reply。未遮蔽的组件原样保留（用户侧替换不丢助手答复，反之亦然）；
 * 文件锚点（base/patch）不受影响。摘要停留在 HISTORICAL/CLAIM 权级的
 * tape 呈现层，绝不进入 CURRENT REQUEST 槽。
 */
export interface TurnCompaction {
  user?: string
  assistant?: string
}

/**
 * 一次表面替换遮蔽多轮时的塌缩（评审 #17）。
 *
 * 逐轮重渲会把同一段摘要复制 N 份 digest + N 份 reply——压缩本该缩小上下文，
 * 实测反而把 tape 撑大 9 倍（20 轮 × 800 字符摘要：3.4k → 31.7k）。这里把被
 * 遮蔽那批 digest/reply 整体移除，替换为一条 epoch 区间条目（复用 compactTape
 * 的 ref..refEnd 形状），摘要只出现一次。文件锚点（base/patch）不受影响——
 * 它们承载的是盘态而不是对话历史。
 *
 * 单轮遮蔽仍走 {@link compactTurn} 的逐条重渲：那时没有放大，且逐条重渲能保留
 * 该轮的 digest 元数据（status/files）。
 */
export function compactTurnSpan(
  c: Continuity,
  turns: readonly number[],
  summary: string,
  sessionId: string,
): void {
  const unique = [...new Set(turns)].sort((a, b) => a - b)
  if (unique.length < 2) {
    const only = unique[0]
    if (only !== undefined) compactTurn(c, only, { user: summary, assistant: summary }, sessionId)
    return
  }
  // goal 若出自被遮蔽的任一轮，一并改写（按轮号，与对话环无关）。
  if (c.goalTurn !== undefined && unique.includes(c.goalTurn)) c.goal = summary
  for (const turn of unique) {
    const row = c.conversation.find((r) => r.turn === turn)
    if (row !== undefined) {
      row.user = summary
      row.assistant = summary
    }
  }
  const shadowed = new Set(unique.map((turn) => `slice-turn-${turn}`))
  const first = `slice-turn-${unique[0]}`
  const last = `slice-turn-${unique[unique.length - 1]}`
  let insertAt = -1
  const kept: TapeEntry[] = []
  for (const entry of c.sessionTape) {
    // 只塌缩对话历史条目；文件锚点原样保留。
    if ((entry.kind === 'digest' || entry.kind === 'reply') && shadowed.has(entry.ref)) {
      if (insertAt === -1) insertAt = kept.length
      continue
    }
    kept.push(entry)
  }
  if (insertAt === -1) return
  const marker = new TapeEntry({
    kind: 'epoch',
    ref: first,
    refEnd: last,
    // No retrieval pointer, for the same reason renderTurnDigest emits none:
    // the @sliceagent/ namespace has nothing serving it here. The GC marker in
    // slice/tape.ts used to keep the Python spelling because the golden suite
    // pinned it byte for byte; that suite retired with the old schema, and the
    // marker now names recall_turn/recall_search like everything else. The fact
    // that N turns collapsed into one summary is worth stating; a call that
    // cannot run is not.
    rendered:
      `[turns compacted: ${first}..${last} — ${unique.length} turns replaced by one summary]`
      + `\n${summary}\n`,
  })
  kept.splice(insertAt, 0, marker)
  c.sessionTape.length = 0
  c.sessionTape.push(...kept)
}

export function compactTurn(c: Continuity, turn: number, patch: TurnCompaction, sessionId: string): void {
  const turnId = `slice-turn-${turn}`
  // goal 按轮号定位，与对话环无关——环裁掉老轮不影响遮蔽（评审 #18）。
  if (patch.user !== undefined && c.goalTurn === turn) c.goal = patch.user
  const row = c.conversation.find((r) => r.turn === turn)
  if (row !== undefined) {
    if (patch.user !== undefined) row.user = patch.user
    if (patch.assistant !== undefined) row.assistant = patch.assistant
  }
  const meta = c.sealMeta[turnId]
  let replySeen = false
  for (let index = 0; index < c.sessionTape.length; index += 1) {
    const entry = c.sessionTape[index]!
    if (entry.ref !== turnId) continue
    if (entry.kind === 'digest' && patch.user !== undefined) {
      c.sessionTape[index] = digestEntry(renderTurnDigest({
        artifactId: turnId,
        status: meta?.status ?? 'completed',
        userRequest: patch.user,
        sessionId,
        files: meta?.files ?? [],
      }), turnId)
    } else if (entry.kind === 'reply' && patch.assistant !== undefined) {
      replySeen = true
      const rep = replyEntry(turnId, patch.assistant)
      if (rep !== null) {
        c.sessionTape[index] = rep
      } else {
        // An explicitly empty assistant patch is a canonical removal: the
        // turn's reply entry leaves the tape (undefined would mean preserve).
        c.sessionTape.splice(index, 1)
        index -= 1
      }
    }
  }
  // Upsert: a non-empty assistant patch for a turn whose original reply was
  // empty (no entry sealed) inserts one — after that turn's digest/file
  // segment, before the next turn's digest, never blindly at the tail.
  if (patch.assistant !== undefined && patch.assistant !== '' && !replySeen) {
    const rep = replyEntry(turnId, patch.assistant)
    if (rep !== null) {
      let insertAt = -1
      for (let index = 0; index < c.sessionTape.length; index += 1) {
        const entry = c.sessionTape[index]!
        if (entry.kind === 'digest' && entry.ref === turnId) {
          insertAt = index + 1
          while (insertAt < c.sessionTape.length && c.sessionTape[insertAt]!.ref === '') insertAt += 1
          break
        }
      }
      if (insertAt === -1) c.sessionTape.push(rep)
      else c.sessionTape.splice(insertAt, 0, rep)
    }
  }
}
