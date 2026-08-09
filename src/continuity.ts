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
 * toSliceCtx() 重建有界切片——bounded slice ≠ 每轮从零开始。
 */
import { createHash } from 'node:crypto'
import {
  TapeEntry,
  baseEntry,
  patchEntry,
  externalEntry,
  replyEntry,
  digestEntry,
  compactTape,
  tapeChars,
} from './slice/tape.js'
import type { SliceCtx, SliceState } from './slice/state.js'

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
}

export interface TapeFileState {
  hash: string
  content: string
}

export interface Continuity {
  /** 首条 prompt 即话题 goal（system 侧渲染，跨轮不变直到换题）。 */
  goal: string
  conversation: ConversationRow[]
  sessionTape: TapeEntry[]
  tapeFiles: Record<string, TapeFileState>
  /** 本轮编辑过的文件（executeToolCalls 记录，seal 时锚定后清空）。 */
  pendingEdits: Array<{ path: string; read: () => string | null }>
  turns: number
}

export function createContinuity(): Continuity {
  return {
    goal: '',
    conversation: [],
    sessionTape: [],
    tapeFiles: {},
    pendingEdits: [],
    turns: 0,
  }
}

// ---------------------------------------------------------------- ring write

/** record_user：用户请求进环 + 计轮 + 环修剪（pfc.py:398-442 语义）。 */
export function recordUser(c: Continuity, text: string): void {
  c.turns += 1
  c.conversation.push({ user: text, assistant: '' })
  c.conversation = c.conversation.slice(-ringKeep(c.conversation))
}

/** reducer 的 AssistantText 守卫：只有 final 且环非空才落助手侧。 */
export function fillAssistant(c: Continuity, text: string): void {
  if (c.conversation.length === 0 || !text.trim()) return
  c.conversation[c.conversation.length - 1].assistant = text
}

// ---------------------------------------------------------------- turn digest

const ASK_CAP_CHARS = 600

/** render_turn_digest 的 TS 移植（spine.py:35-87，无 segment 变体）。 */
export function renderTurnDigest(opts: {
  artifactId: string
  taskId?: string
  status: string
  userRequest: string
  sessionId: string
  files?: readonly string[]
}): string {
  const aid = opts.artifactId || 'unknown'
  const head = `[turn ${aid} · task ${opts.taskId || 'unknown'} · ${opts.status || 'unknown'}]`
  const raw = opts.userRequest.trim()
  const ask = raw.length > ASK_CAP_CHARS
    ? `${raw.slice(0, ASK_CAP_CHARS)} …[+${raw.length - ASK_CAP_CHARS} chars in sealed turn]`
    : raw || '(empty request)'
  const lines = [head, `ask: ${ask}`]
  const fs = [...new Set((opts.files ?? []).filter((f) => f.trim()))].sort()
  if (fs.length > 0) {
    const shown = fs.slice(0, 8).join(', ')
    lines.push(`files: ${shown}${fs.length > 8 ? ` (+${fs.length - 8} more)` : ''}`)
  }
  lines.push(`recall: read_file("@sliceagent/history/sessions/${opts.sessionId}/${aid}.md")`)
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
): { entries: number; gcRemoved: number; epochFolds: number } {
  const tape = c.sessionTape
  const files = c.tapeFiles

  tape.push(digestEntry(renderTurnDigest({
    artifactId: opts.turnId,
    status: opts.status,
    userRequest: opts.userRequest,
    sessionId: opts.sessionId,
    files: opts.status === 'completed' ? c.pendingEdits.map((e) => e.path) : [],
  }), opts.turnId))

  // 文件锚定：编辑后态 → base/patch 取渲染更短者（tape.py:_anchor 语义）。
  for (const { path, read } of c.pendingEdits) {
    const body = read()
    if (body === null) continue
    const state = files[path]
    const hash = sha256(body)
    if (state !== undefined && state.hash === hash) continue // 幂等编辑
    const base = baseEntry(path, body)
    if (state === undefined) {
      tape.push(base)
    } else {
      const patch = patchEntry(path, state.content, body)
      tape.push(patch.rendered.length < base.rendered.length ? patch : base)
    }
    files[path] = { hash, content: body }
  }
  c.pendingEdits = []

  const rep = replyEntry(opts.turnId, opts.assistantReply)
  if (rep !== null) tape.push(rep)

  const info = compactTape(tape, files)
  return { entries: tape.length, gcRemoved: info.gc_removed, epochFolds: info.epoch_folds }
}

/** 编辑族工具调用记录（driver 在 tool/call 时调用，seal 时读取后态）。 */
export function trackEdit(c: Continuity, path: string, read: () => string | null): void {
  if (path.trim()) c.pendingEdits.push({ path, read })
}

// ---------------------------------------------------------------- slice 重建

/**
 * 携带态 → SliceCtx：每轮重建有界切片的输入。直接构造（绕过 JSON normalize——
 * 我们手里就是活对象）。findings/activeWork 等 PFC 区域随移植深入逐块点亮；
 * 引擎对非空 activeWork 会大声抛错（PORT-REPORT §3），所以这里保持 null。
 */
export function toSliceCtx(c: Continuity): SliceCtx {
  const s: SliceState = {
    intent: null,
    task: {
      goal: c.goal,
      goalSource: 'conversation',
      objectiveStatus: '',
      progressSignals: [],
      deliverableRequirement: null,
    },
    findings: [],
    findingSource: {},
    sessionTape: c.sessionTape,
    activeFiles: Object.keys(c.tapeFiles).sort(),
    activeSkills: [],
    world: {},
    openReport: '',
    lastError: '',
    reconciliationRequired: '',
    reconciliationTargets: [],
    continuity: {
      tapeFindingHashes: new Set(),
      tapeKnowledgeHashes: new Set(),
      tapeTaskId: '',
      lastKnowledgeRender: '',
    },
    activeWork: null,
    conversation: c.conversation.map((r) => ({ ...r })),
  }
  return {
    s,
    artifacts: '',
    discovery: '',
    memory: '',
    threads: '',
    worktree: '',
    focus: '',
    repoMap: '',
    openFilePaths: Object.keys(c.tapeFiles).sort(),
    maxFindings: 20,
  }
}

/** 观测用：当前携带态的切片体积（tape 字符数 + 环行数）。 */
export function continuityStats(c: Continuity): { tapeChars: number; ringRows: number; files: number } {
  return { tapeChars: tapeChars(c.sessionTape), ringRows: c.conversation.length, files: Object.keys(c.tapeFiles).length }
}
