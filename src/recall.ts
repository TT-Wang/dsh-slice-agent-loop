/**
 * recall_turn and recall_search read original events from the durable DSH log.
 * The current tape policy (src/context.ts) may shorten requests, replies and
 * read indexes to fit a new entry. Its recall locators resolve to these events;
 * no second archive or virtual context filesystem is involved.
 *
 * Full pages preserve original records as JSON; dialogue pages show user and
 * assistant text once, with tool-result locators. Both distinguish generated
 * context from human input and work after session recreation.
 *
 * Assistant messages carry their turn explicitly. User-role messages share
 * userMessageTurn with surface sealing: the open turn owns step-1 input and
 * mid-turn steering; the last ended turn owns between-turn messages. Before
 * the first turn there is no recall page, so the surface policy retains the
 * original message. Recall records what was said, not present world state.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { RECALL_STEP_TOOL_NAME } from './recall-step.js'
import { userMessageTurn } from './turn-ownership.js'

export const RECALL_TOOL_NAME = 'recall_turn'
export const RECALL_SEARCH_TOOL_NAME = 'recall_search'
/** Owned by src/fold/index.ts (EXPAND_TOOL_NAME); spelled here so recall does not load the fold plugin. */
const EXPAND_RESULT_TOOL_NAME = 'expand_result'

/**
 * The recall family: tools whose inputs are queries ABOUT history and whose
 * outputs are copies OF history. Neither is evidence — indexing them makes a
 * search self-match its own argument string, and re-surfaces already-recalled
 * text as if it had been said a second time.
 */
export const RECALL_FAMILY: ReadonlySet<string> = new Set([
  RECALL_TOOL_NAME, RECALL_SEARCH_TOOL_NAME, RECALL_STEP_TOOL_NAME, EXPAND_RESULT_TOOL_NAME,
])

/**
 * Event kinds recall_search scans, and the flood guard that shapes them.
 *
 * Ordinary tool OUTPUT is excluded from the dialogue kinds — it is the
 * session's highest-volume, lowest-signal text (file dumps, listings), and
 * letting it into the corpus unbounded buries the sentence the model actually
 * said under kilobytes of cat. Tool INPUT (what was asked of a tool) and tool
 * ERRORS stay in: both are short and load-bearing. scope "auto" admits tool
 * output through bounded slots (TOOL_OUTPUT_SLOTS hits, TOOL_SNIPPET_CHARS
 * each); kinds: ['tool_output'] searches it unbounded.
 *
 * CONTEXT is user-role text a plugin produced rather than the human: runtime-
 * context snapshots and injected notices. It is searched by default because
 * the history policy archives superseded snapshots out of the request view
 * and points at these tools for them (src/context.ts) — an omission is only
 * legal when a recall tool actually serves the omitted content.
 */
export const DEFAULT_SEARCH_KINDS = ['user', 'assistant', 'context', 'tool_input', 'tool_error'] as const
export type SearchKind = (typeof DEFAULT_SEARCH_KINDS)[number] | 'tool_output'
export type SearchScope = 'dialogue' | 'auto'
export const TOOL_OUTPUT_SLOTS = 3
export const TOOL_SNIPPET_CHARS = 600

export type RecallView = 'full' | 'dialogue'

/** `slice-turn-7`, `7`, or 7 → 7; null when unparseable. */
export function parseTurnId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value
  if (typeof value !== 'string') return null
  const match = /^(?:slice-turn-)?([0-9]+)$/.exec(value.trim())
  if (match === null) return null
  const turn = Number(match[1])
  return Number.isInteger(turn) && turn >= 1 ? turn : null
}

type LogEvent = { type: string; data: unknown; surfaceOp?: unknown; seq?: unknown }

interface ToolResultBlock { type: string; toolCallId?: string; isError?: boolean; content?: ReadonlyArray<{ type: string; text?: string }> }
interface ToolResultData { turn: number; step: number; message: { content: ReadonlyArray<ToolResultBlock>; source?: { callId?: string } } }

/** Join a message's text blocks; non-text blocks (images, tool results) contribute nothing. */
function textOf(message: UserMessage | { content: ReadonlyArray<{ type: string }> }): string {
  return (message.content as ReadonlyArray<{ type: string; text?: string }>)
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

/** Text of a tool/result's tool-result blocks; isError read from the block field, never from a substring. */
function resultTextOf(message: ToolResultData['message']): { text: string; isError: boolean; callIds: string[] } {
  let isError = false
  const parts: string[] = []
  const callIds: string[] = []
  for (const block of message.content) {
    if (block.type !== 'tool-result') continue
    if (block.isError === true) isError = true
    if (block.toolCallId !== undefined) callIds.push(String(block.toolCallId))
    for (const inner of block.content ?? []) if (inner.type === 'text' && inner.text) parts.push(inner.text)
  }
  return { text: parts.join('\n'), isError, callIds }
}

/** User-role runtime snapshots and generated context are not user requests. */
function isUserInput(data: Record<string, unknown>): boolean {
  const source = data.source as { kind?: unknown } | undefined
  return source?.kind === 'user'
}

/** Names the producer of a user-role message the human did not write. */
function contextSource(data: Record<string, unknown>): string {
  const source = data.source as { kind?: unknown; plugin?: unknown } | undefined
  return typeof source?.plugin === 'string' ? source.plugin : String(source?.kind ?? 'generated')
}

function isOriginalEvent(event: { surfaceOp?: unknown }): boolean {
  return event.surfaceOp === undefined || event.surfaceOp === 'append'
}

/** Durable seq of a logged event; synthetic event lists without one fall back to their position. */
function seqOf(event: LogEvent, index: number): number {
  return typeof event.seq === 'number' ? event.seq : index
}

/**
 * callId → tool name, from tool/call events (the durable pairing) and from
 * assistant tool-call blocks (the same pairing, visible even in synthetic logs).
 */
function noteCalls(names: Map<string, string>, event: LogEvent): void {
  const data = event.data as Record<string, unknown>
  if (event.type === 'tool/call') {
    if (typeof data.callId === 'string' && typeof data.name === 'string') names.set(data.callId, data.name)
  } else if (event.type === 'assistant/message') {
    const message = data.message as { content?: ReadonlyArray<{ type: string; id?: string; name?: string }> } | undefined
    for (const block of message?.content ?? []) {
      if (block.type === 'tool-call' && typeof block.id === 'string' && typeof block.name === 'string') names.set(block.id, block.name)
    }
  }
}

function expandLocator(seq: number, block?: number): string {
  return `${EXPAND_RESULT_TOOL_NAME}({"seq":${seq},"formatVersion":${SESSION_FORMAT_VERSION}${block === undefined ? '' : `,"block":${block}`}})`
}

interface SealedTurnPage {
  rendered: string
  userMessages: number
  assistantSteps: number
  /** User-role messages a plugin produced: runtime snapshots, injected notices. */
  contextMessages: number
}

/**
 * Render one turn's verbatim page from durable session events. Pure so the
 * gate suite can drive it without an agent. Returns null when the log holds
 * nothing for that turn.
 *
 * view "dialogue" (default): user text and assistant text, each exactly once,
 * with every tool result reduced to one locator line — the cheap page for
 * "what was said", with the tool output one expand_result call away.
 * view "full": the same text, then every original record of the turn as JSON
 * (reasoning, tool calls, tool output, metadata). Two orders of magnitude
 * larger on a working turn, so it is served only when asked for by name.
 *
 * Both views serve generated context (runtime snapshots, injected notices) in
 * its own section, never folded into the human's request: an archived or
 * superseded snapshot must stay reachable from the page its locator names.
 */
export function renderSealedTurn(
  events: Iterable<LogEvent>,
  turn: number,
  opts?: { view?: RecallView },
): SealedTurnPage | null {
  const view: RecallView = opts?.view ?? 'dialogue'
  const users: string[] = []
  const contexts: string[] = []
  const originalRecords: unknown[] = []
  // Assistant section in log order: a step's text, then the tool-result lines that followed it.
  const items: Array<{ kind: 'step'; step: number; text: string } | { kind: 'tool'; line: string }> = []
  const names = new Map<string, string>()
  let status = 'open'
  let openTurn: number | null = null
  let lastEnded: number | null = null
  let seen = false
  let steps = 0
  let index = -1

  for (const event of events) {
    index += 1
    if (!isOriginalEvent(event)) continue
    const data = event.data as Record<string, unknown>
    const attributedTurn: unknown = event.type === 'user/message' ? userMessageTurn(openTurn, lastEnded) : data.turn
    if (attributedTurn === turn
      && ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'tool/ptc-dispatch'].includes(event.type)) {
      originalRecords.push({ type: event.type, data: event.data })
    }
    switch (event.type) {
      case 'turn/start':
        openTurn = data.turn as number
        if (openTurn === turn) seen = true
        break
      case 'turn/end':
        if ((data.turn as number) === turn) status = (data.reason as { kind: string }).kind
        if (openTurn === (data.turn as number)) openTurn = null
        lastEnded = data.turn as number
        break
      case 'user/message': {
        // data IS the UserMessage; the surface policy shares this ownership.
        if (attributedTurn !== turn) break
        seen = true
        const text = textOf(data as unknown as UserMessage)
        // Generated context is never folded into the human's request, but it is
        // still served: the history policy archives superseded runtime
        // snapshots out of the request view naming exactly this page as their
        // locator.
        if (isUserInput(data)) users.push(text)
        else contexts.push(`[${contextSource(data)}]\n${text}`)
        break
      }
      case 'assistant/message':
        noteCalls(names, event)
        if ((data.turn as number) === turn) {
          seen = true
          const text = textOf((data as { message: { content: ReadonlyArray<{ type: string }> } }).message)
          if (text.length > 0) { steps += 1; items.push({ kind: 'step', step: data.step as number, text }) }
          else if (!(data as { message: { content: ReadonlyArray<{ type: string }> } }).message.content.some(block => block.type === 'tool-call')) {
            items.push({ kind: 'step', step: data.step as number, text: '' })
          }
        }
        break
      case 'tool/call':
        noteCalls(names, event)
        break
      case 'tool/result':
        if (view === 'dialogue' && (data.turn as number) === turn) {
          const d = data as unknown as ToolResultData
          const seq = seqOf(event, index)
          const blocks = d.message.content.filter((block) => block.type === 'tool-result')
          for (const [blockIndex, block] of blocks.entries()) {
            const { text } = resultTextOf({ content: [block] })
            const name = names.get(block.toolCallId ?? d.message.source?.callId ?? '') ?? 'tool'
            const ordinal = blocks.length > 1 ? blockIndex + 1 : undefined
            items.push({ kind: 'tool', line: `[tool step ${d.step} seq ${seq}${ordinal === undefined ? '' : ` block ${ordinal}`} · ${name} · ${Array.from(text).length} chars · ${expandLocator(seq, ordinal)}]` })
          }
        }
        break
      default:
        break
    }
  }

  if (!seen) return null

  const frame = view === 'dialogue'
    ? `view dialogue (default: text once, tool results as locators; full record with reasoning and tool output: ${RECALL_TOOL_NAME}({"turn":"${turn}","view":"full"}))`
    : 'view full (text plus every original record; the default text-only page is view "dialogue")'
  const lines = [
    // Epistemic frame, aligned with the kernel's evidence tiers: a sealed turn
    // establishes what was SAID, never current world state. Verbatim, but old.
    `[sealed turn slice-turn-${turn} · status ${status} · ${users.length} user message(s)`
    + `${contexts.length > 0 ? ` · ${contexts.length} generated context message(s)` : ''}`
    + ` · ${steps} assistant step(s) with text · ${frame} · historical record: establishes what was said, not current world state]`,
    '',
    '## User request (verbatim)',
    users.length > 0 ? users.map(text => text.length > 0 ? text : '(no user text recorded in this message)').join('\n\n') : '(no user text recorded for this turn)',
    '',
    '## Assistant response (verbatim)',
  ]
  if (items.length === 0) {
    lines.push('(no assistant text recorded for this turn)')
  } else {
    for (const item of items) {
      if (item.kind === 'step') lines.push(`[step ${item.step}]`, item.text.length > 0 ? item.text : '(no assistant text recorded for this step)', '')
      else lines.push(item.line)
    }
  }
  if (contexts.length > 0) {
    lines.push('', '## Generated context recorded during this turn (verbatim)', ...contexts)
  }
  if (view === 'full') {
    lines.push('', '## Original records (including reasoning, tool output and recorded file metadata)', JSON.stringify(originalRecords))
  }
  return {
    rendered: lines.join('\n').replace(/\n+$/, '\n'),
    userMessages: users.length,
    assistantSteps: steps,
    contextMessages: contexts.length,
  }
}

/** Sealed turn numbers present in the log, for the not-found error message. */
function sealedTurns(events: Iterable<LogEvent>): number[] {
  const turns = new Set<number>()
  for (const event of events) {
    if (event.type === 'turn/end') turns.add((event.data as { turn: number }).turn)
  }
  return [...turns].sort((a, b) => a - b)
}


// ---------------------------------------------------------------- search tier

/** One scored hit: enough to decide, plus the exact follow-up call that returns the original. */
export interface RecallHit {
  turn: number
  step?: number
  kind: SearchKind
  score: number
  snippet: string
  /** Durable tool/result event seq (tool_output / tool_error hits only). */
  seq?: number
  /** 1-based original tool-result sibling when the event contains multiple blocks. */
  block?: number
  /** Copy-paste follow-up: dialogue for said text, full for tool inputs, expansion for result blocks. */
  locator: string
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter((t) => t.length > 1)
}

/** Snippet centred on the first query-term match, at most maxChars code points. */
function snippetAround(text: string, terms: readonly string[], maxChars = 180): string {
  const lower = text.toLowerCase()
  let at = -1
  for (const term of terms) {
    const i = lower.indexOf(term)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) at = 0
  const chars = Array.from(text)
  const window = Math.floor(maxChars / 2)
  const from = Math.max(0, at - window)
  const to = Math.min(chars.length, from + maxChars)
  return (from > 0 ? '…' : '') + chars.slice(from, to).join('').replace(/\s+/g, ' ').trim() + (to < chars.length ? '…' : '')
}

function turnLocator(turn: number, view: RecallView = 'dialogue'): string {
  return `${RECALL_TOOL_NAME}({"turn":"${turn}","view":"${view}"})`
}

/** Resolve the searched kinds: explicit kinds win; otherwise the scope (dialogue kinds, "auto" adds bounded tool output). */
export function resolveSearchKinds(opts?: { kinds?: readonly SearchKind[]; scope?: SearchScope }): readonly SearchKind[] {
  if (opts?.kinds !== undefined && opts.kinds.length > 0) return opts.kinds
  return opts?.scope === 'auto' ? [...DEFAULT_SEARCH_KINDS, 'tool_output'] : DEFAULT_SEARCH_KINDS
}

/**
 * Scored search over the durable session log. Pure so the gate suite can
 * drive it without an agent.
 *
 * Scoring is deliberately simple — term-frequency with a short-document
 * boost and a recency tiebreak — and deliberately not called BM25: at
 * session scale (hundreds of events, all in memory) ranking subtlety buys
 * nothing, while the KIND filter does all the real work (see
 * DEFAULT_SEARCH_KINDS: ordinary tool output is the flood, and it is out
 * unless asked for).
 *
 * Without kinds or scope the corpus is the dialogue kinds (the tool defaults
 * scope to "auto"). scope "auto" adds tool output through bounded slots: at
 * most TOOL_OUTPUT_SLOTS tool-output hits per query, each snippet at most
 * TOOL_SNIPPET_CHARS; explicit kinds are unbounded beyond `limit`.
 */
export function searchSessionEvents(
  events: Iterable<LogEvent>,
  query: string,
  opts?: { kinds?: readonly SearchKind[]; scope?: SearchScope; limit?: number },
): RecallHit[] {
  const explicit = opts?.kinds !== undefined && opts.kinds.length > 0
  const kinds = new Set(resolveSearchKinds(opts))
  const slotted = !explicit && kinds.has('tool_output')
  const limit = Math.min(Math.max(opts?.limit ?? 5, 1), 20)
  const terms = tokenize(query)
  if (terms.length === 0) return []

  // The surface policy and both recall tools share userMessageTurn, including
  // human input and generated context appended between turns. Their locators
  // must resolve to the page containing the exact original event.
  const docs: Array<{ turn: number; step?: number; kind: SearchKind; text: string; seq: number; block?: number }> = []
  const names = new Map<string, string>()
  let openTurn: number | null = null
  let lastEnded: number | null = null
  let index = -1
  for (const event of events) {
    index += 1
    if (!isOriginalEvent(event)) continue
    const seq = seqOf(event, index)
    const data = event.data as Record<string, unknown>
    switch (event.type) {
      case 'turn/start':
        openTurn = data.turn as number
        break
      case 'turn/end':
        if (openTurn === (data.turn as number)) openTurn = null
        lastEnded = data.turn as number
        break
      case 'tool/call':
        noteCalls(names, event)
        break
      case 'user/message': {
        const owner = userMessageTurn(openTurn, lastEnded)
        if (owner === null) break
        const kind: SearchKind = isUserInput(data) ? 'user' : 'context'
        if (!kinds.has(kind)) break
        const text = textOf(data as unknown as UserMessage)
        if (text.trim()) docs.push({ turn: owner, kind, text, seq })
        break
      }
      case 'assistant/message': {
        noteCalls(names, event)
        const turn = data.turn as number
        const step = data.step as number
        const message = (data as { message: { content: ReadonlyArray<{ type: string }> } }).message
        if (kinds.has('assistant')) {
          const text = textOf(message)
          if (text.trim()) docs.push({ turn, step, kind: 'assistant', text, seq })
        }
        if (kinds.has('tool_input')) {
          for (const block of message.content as ReadonlyArray<{ type: string; name?: string; arguments?: string }>) {
            if (block.type === 'tool-call') {
              // The recall family's own calls are queries ABOUT history, not
              // history: indexing them makes every search self-match its own
              // argument string (review repro #1).
              if (block.name !== undefined && RECALL_FAMILY.has(block.name)) continue
              const text = `${block.name ?? ''} ${block.arguments ?? ''}`
              if (text.trim()) docs.push({ turn, step, kind: 'tool_input', text, seq })
            }
          }
        }
        break
      }
      case 'tool/result': {
        const d = data as unknown as ToolResultData
        const blocks = d.message.content.filter((block) => block.type === 'tool-result')
        for (const [blockIndex, block] of blocks.entries()) {
          // A copied recall sibling cannot suppress independent original evidence.
          const callId = block.toolCallId ?? d.message.source?.callId ?? ''
          if (RECALL_FAMILY.has(names.get(callId) ?? '')) continue
          const { text, isError } = resultTextOf({ content: [block] })
          const kind: SearchKind = isError ? 'tool_error' : 'tool_output'
          if (kinds.has(kind) && text.trim()) docs.push({
            turn: d.turn, step: d.step, kind, text, seq,
            ...(blocks.length > 1 ? { block: blockIndex + 1 } : {}),
          })
        }
        break
      }
      default:
        break
    }
  }

  // The still-open turn is NOT history: its content already sits in front of
  // the model, and its events include the very search being executed. Serving
  // it back is pure self-noise (review repro #1), so the open turn at scan
  // end is excluded from the corpus.
  const sealedDocs = openTurn === null ? docs : docs.filter((doc) => doc.turn !== openTurn)

  const hits: RecallHit[] = []
  for (const doc of sealedDocs) {
    const lower = doc.text.toLowerCase()
    let tf = 0
    let matched = 0
    for (const term of terms) {
      let i = lower.indexOf(term)
      if (i < 0) continue
      matched += 1
      while (i >= 0) { tf += 1; i = lower.indexOf(term, i + term.length) }
    }
    if (matched === 0) continue
    // All-terms coverage dominates LEXICOGRAPHICALLY (x1000 over a capped
    // term-frequency term): a short document containing every query term must
    // outrank a flood that repeats one term 300 times. tf is capped at 10 —
    // beyond that repetition carries no extra evidence, only volume.
    const coverage = matched / terms.length
    const brevity = 1 / Math.log2(4 + Array.from(doc.text).length / 200)
    const score = coverage * 1000 + Math.min(tf, 10) * brevity
    const isTool = doc.kind === 'tool_output' || doc.kind === 'tool_error'
    hits.push({
      turn: doc.turn,
      ...(doc.step === undefined ? {} : { step: doc.step }),
      kind: doc.kind,
      score,
      snippet: snippetAround(doc.text, terms, isTool ? TOOL_SNIPPET_CHARS : 180),
      ...(isTool ? { seq: doc.seq } : {}),
      ...(doc.block === undefined ? {} : { block: doc.block }),
      locator: isTool ? expandLocator(doc.seq, doc.block) : turnLocator(doc.turn, doc.kind === 'tool_input' ? 'full' : 'dialogue'),
    })
  }
  hits.sort((a, b) => b.score - a.score || b.turn - a.turn)
  if (!slotted) return hits.slice(0, limit)
  // scope "auto": dialogue hits keep the limit; raw tool output gets its own bounded slots.
  let dialogue = 0
  let tool = 0
  return hits.filter((hit) => {
    if (hit.kind === 'tool_output') return tool++ < TOOL_OUTPUT_SLOTS
    return dialogue++ < limit
  })
}

/** Render hits as a compact, actionable page: every hit names its exact follow-up call. */
export function renderSearchHits(
  query: string,
  hits: readonly RecallHit[],
  searchedKinds: readonly SearchKind[] = DEFAULT_SEARCH_KINDS,
): string {
  if (hits.length === 0) {
    // Say what was ACTUALLY searched. The first version hardcoded the default
    // kind list and suggested kinds: ["tool_output"] even to a caller who had
    // just searched exactly that (review repro #3).
    const searched = searchedKinds.join('/')
    const hint = searchedKinds.includes('tool_output')
      ? 'broaden the query, or check earlier sealed turns with recall_turn'
      : 'retry with kinds: ["tool_output"] if the fact was tool-born, or broaden the query'
    return `[recall_search "${query}" · 0 hits over kinds ${searched} — ${hint}]`
  }
  const lines = [
    `[recall_search "${query}" · ${hits.length} hit(s) · historical record — each hit ends with the exact call that returns `
    + `its original: recall_turn({"turn": "slice-turn-N"}) (view "dialogue" is the default: the cheap text-only page) for said text, `
    + `recall_turn view "full" for tool inputs, expand_result({"seq": Q,"formatVersion": ${SESSION_FORMAT_VERSION},"block": B}) for tool output (block only for multi-result events)]`,
  ]
  for (const hit of hits) {
    const where = `slice-turn-${hit.turn}${hit.step === undefined ? '' : ` step ${hit.step}`}${hit.seq === undefined ? '' : ` seq ${hit.seq}`}${hit.block === undefined ? '' : ` block ${hit.block}`}`
    lines.push(`- ${where} [${hit.kind}] ${hit.snippet} → ${hit.locator}`)
  }
  return lines.join('\n')
}

/** The search tool: tier 1 of the two-tier recall (search → recall_turn / expand_result verbatim fetch). */
export function recallSearchToolDefinition(): ToolDefinition {
  return defineTool({
    name: RECALL_SEARCH_TOOL_NAME,
    description:
      'Search THIS session\'s durable history when you need something said or done earlier but do not know '
      + 'which turn. Returns scored hits, each with a bounded original snippet and the exact follow-up call: '
      + 'recall_turn view "dialogue" (its default) for said text, view "full" for tool inputs, '
      + `expand_result({"seq": Q,"formatVersion": ${SESSION_FORMAT_VERSION},"block": B}) for tool output (block only for multi-result events). scope "auto" (default) `
      + 'searches user/assistant text, generated context (runtime snapshots and injected notices), tool inputs '
      + 'and tool errors plus raw tool output through bounded slots '
      + `(at most ${TOOL_OUTPUT_SLOTS} tool-output hits, ${TOOL_SNIPPET_CHARS} chars each); scope "dialogue" `
      + 'skips raw tool output. Explicit kinds override scope. Recall tool inputs and outputs are never indexed.',
    parameters: {
      query: { type: 'string', required: true, description: 'Terms to search for (matched case-insensitively).' },
      scope: {
        type: 'string',
        enum: ['dialogue', 'auto'],
        description: '"auto" (default): dialogue kinds plus bounded raw tool output. "dialogue": dialogue kinds only.',
      },
      kinds: {
        type: 'array',
        description: 'Override the searched kinds (takes precedence over scope). Any of: user, assistant, context, tool_input, tool_error, tool_output.',
        items: { type: 'string', enum: ['user', 'assistant', 'context', 'tool_input', 'tool_error', 'tool_output'] },
      },
      limit: { type: 'number', description: 'Max dialogue hits, 1-20. Default 5.' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown, exec: ToolRunContext): Promise<string> => {
      const agent = exec.agent as Agent | undefined
      if (agent === undefined) {
        throw new Error('recall_search runs only inside an agent loop (no owning agent on this execution)')
      }
      const a = args as { query?: unknown; scope?: unknown; kinds?: unknown; limit?: unknown }
      const query = typeof a?.query === 'string' ? a.query : ''
      if (!query.trim()) throw new Error('recall_search needs {"query": "..."}')
      const kinds = Array.isArray(a.kinds) && a.kinds.length > 0 ? a.kinds as SearchKind[] : undefined
      const scope: SearchScope = a.scope === 'dialogue' ? 'dialogue' : 'auto'
      const limit = typeof a.limit === 'number' ? a.limit : undefined
      const opts = { scope, ...(kinds ? { kinds } : {}), ...(limit ? { limit } : {}) }
      const hits = searchSessionEvents(agent.session.snapshotEvents(), query, opts)
      return renderSearchHits(query, hits, resolveSearchKinds(opts))
    },
  })
}

/**
 * The registered tool. One global registration serves every agent: the
 * scheduler stamps `exec.agent` on each execution (driver.ts sets `agent:
 * this` when building the ToolExecutionInput), so the handler reads the
 * calling agent's own session log and cannot cross sessions.
 */
export function recallToolDefinition(): ToolDefinition {
  return defineTool({
    name: RECALL_TOOL_NAME,
    description:
      'Retrieve the verbatim text of an earlier turn in THIS session: the complete user request and '
      + 'every assistant step, exactly as delivered, plus any generated context (runtime snapshots, injected '
      + 'notices) recorded during it. Use it when a [slice tape v1 …] entry (or legacy checkpoint) names a turn or cuts its text '
      + '(`…[+N chars, recall_turn]…`), or when a recall_search hit names a turn. view "dialogue" (default) returns the said '
      + `text once with each tool result reduced to a one-line expand_result({"seq": Q,"formatVersion": ${SESSION_FORMAT_VERSION}}) locator (cheap); `
      + 'view "full" additionally appends every original record as JSON — reasoning and every original tool '
      + 'output included — which on a working turn is two orders of magnitude larger (tens of thousands of '
      + 'characters against a few hundred), so ask for it only when you need the tool inputs or the raw '
      + 'reasoning. Serves from the durable session log, so it works after agent recreation too.',
    parameters: {
      turn: {
        type: 'string',
        required: true,
        description: 'The turn to recall, as history names it: "slice-turn-3" (or just "3").',
      },
      view: {
        type: 'string',
        enum: ['dialogue', 'full'],
        description: '"dialogue" (default): text once, tool results as locators. "full": text plus all original records (reasoning and every tool output; can be ~100x larger).',
      },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args: unknown, exec: ToolRunContext): Promise<string> => {
      const agent = exec.agent as Agent | undefined
      if (agent === undefined) {
        throw new Error('recall_turn runs only inside an agent loop (no owning agent on this execution)')
      }
      const a = args as { turn?: unknown; view?: unknown } | null
      const turn = parseTurnId(a?.turn)
      if (turn === null) {
        throw new Error('recall_turn needs {"turn": "slice-turn-N"} (or just "N")')
      }
      const view: RecallView = a?.view === 'full' ? 'full' : 'dialogue'
      const page = renderSealedTurn(agent.session.snapshotEvents(), turn, { view })
      if (page === null) {
        const known = sealedTurns(agent.session.snapshotEvents())
        throw new Error(
          `no recorded turn ${turn} in this session`
          + (known.length > 0 ? ` (sealed turns: ${known.slice(0, 20).join(', ')})` : ' (no sealed turns yet)'),
        )
      }
      return page.rendered
    },
  })
}
