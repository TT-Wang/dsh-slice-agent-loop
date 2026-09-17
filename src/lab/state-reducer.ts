// offline/experimental — not on the runtime path. Nothing under src/lab is reachable
// from the published entry points (src/index.ts, src/fold/index.ts, src/invariant.ts);
// tsconfig.json excludes this directory, so it never reaches lib/ or the package.
import type { Session } from '@deepseek-ai/dsh-session'
import {
  createContinuity, fillAssistant, recordUser, sealTurn, trackCheck, trackReasoning, trackToolOutcome,
} from './continuity.js'
import type { Continuity } from './continuity.js'
import { recordedFileObservations } from './observations-files.js'
import { asRecord } from './state-events.js'
import type { RecordedEvent } from './state-events.js'

export type ContinuityPolicy = Omit<Parameters<typeof sealTurn>[1],
  'turnId' | 'status' | 'userRequest' | 'assistantReply' | 'sessionId'> & {
  /** Retained for configuration compatibility; alpha.2 metadata cannot establish exact bases. */
  readBases?: { enabled: boolean; maxChars: number }
  reasoningTape?: boolean
}

function textOf(value: unknown): string {
  const content = asRecord(value).content
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    const item = asRecord(block)
    return item.type === 'text' && typeof item.text === 'string' ? item.text : ''
  }).join('')
}

/**
 * The sole continuity replay path. The live provider runs the same reducer over
 * its durable snapshot. Generated replacements are not additional conversation
 * facts. Tool metadata contributes historical read/touch hints, never file bases:
 * it contains neither opaque FsTarget identity nor a provably complete body.
 */
export function reduceContinuityEvents(
  input: Iterable<RecordedEvent>, sessionId: string, policy: ContinuityPolicy = {},
): Continuity {
  const events = Array.from(input)
  const c = createContinuity()
  // A remote display path may literally be "__proto__".
  c.readCount = Object.create(null) as Continuity['readCount']
  c.touchCount = Object.create(null) as Continuity['touchCount']
  const observations = recordedFileObservations(events)
  const readsByTurn = new Map<number, Set<string>>()
  const touchesByTurn = new Map<number, Set<string>>()
  for (const observation of observations) {
    let touches = touchesByTurn.get(observation.turn)
    if (touches === undefined) touchesByTurn.set(observation.turn, touches = new Set())
    touches.add(observation.address.path)
    if (observation.operation === 'read') {
      let reads = readsByTurn.get(observation.turn)
      if (reads === undefined) readsByTurn.set(observation.turn, reads = new Set())
      reads.add(observation.address.path)
    }
  }
  let turn: number | undefined
  let hasUser = false
  let userText = ''
  let assistantText = ''
  const calls = new Map<string, { name: string; arguments: unknown }>()

  for (const event of events) {
    const data = asRecord(event.data)
    if (event.type === 'turn/start') {
      turn = typeof data.turn === 'number' ? data.turn : undefined
      hasUser = false
      userText = ''
      assistantText = ''
      calls.clear()
      continue
    }
    if (turn === undefined) continue
    if (event.type === 'user/message' && event.surfaceOp === 'append' && asRecord(data.source).kind === 'user') {
      const text = textOf(data)
      userText += userText && text ? `\n${text}` : text
      if (!hasUser) {
        recordUser(c, userText, turn)
        hasUser = true
      } else {
        c.conversation[c.conversation.length - 1]!.user = userText
      }
      if (!c.goal && userText) {
        c.goal = userText
        c.goalTurn = turn
      }
    } else if (event.type === 'assistant/message' && event.surfaceOp === 'append' && data.turn === turn) {
      const text = textOf(data.message)
      if (text.trim()) assistantText = text
      if (hasUser) fillAssistant(c, text)
      if (policy.reasoningTape) {
        const content = asRecord(data.message).content
        if (Array.isArray(content)) {
          for (const block of content) {
            const value = asRecord(block)
            if (value.type === 'reasoning' && typeof value.text === 'string') trackReasoning(c, value.text)
          }
        }
      }
    } else if (event.type === 'tool/call' && data.turn === turn && typeof data.callId === 'string') {
      let args: unknown
      try { args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments } catch { args = undefined }
      calls.set(data.callId, { name: String(data.name), arguments: args })
    } else if (event.type === 'tool/result' && event.surfaceOp === 'append' && data.turn === turn) {
      const content = asRecord(data.message).content
      const block = asRecord(Array.isArray(content) ? content[0] : undefined)
      const resultText = textOf(block)
      trackToolOutcome(c, block.isError === true, resultText)
      const call = typeof block.toolCallId === 'string' ? calls.get(block.toolCallId) : undefined
      const command = asRecord(call?.arguments).command
      if (policy.checkInDigest && !block.isError && call?.name === 'bash' && typeof command === 'string'
        && /pytest|python -m|unittest|npm test|npm run test|cargo test|go test|vitest|jest/.test(command)) {
        trackCheck(c, command, resultText)
      }
    } else if (event.type === 'turn/end' && data.turn === turn) {
      // Observations are counted once per displayed address per turn, including
      // repeated reads and nested dispatches. No counters depend on admission.
      for (const path of readsByTurn.get(turn) ?? []) c.readCount[path] = (c.readCount[path] ?? 0) + 1
      for (const path of touchesByTurn.get(turn) ?? []) c.touchCount[path] = (c.touchCount[path] ?? 0) + 1
      if (hasUser) {
        sealTurn(c, {
          ...policy, turnId: `slice-turn-${turn}`, status: String(asRecord(data.reason).kind ?? 'unknown'),
          userRequest: userText, assistantReply: assistantText, sessionId,
        })
      } else {
        // A rejected/no-user turn must not leak pending state into its successor.
        c.pendingError = ''
        c.pendingReasoning = []
        c.pendingCheck = undefined
      }
      turn = undefined
    }
  }
  return c
}

export function buildContinuity(session: Pick<Session, 'id' | 'snapshotEvents'>, policy: ContinuityPolicy = {}): Continuity {
  return reduceContinuityEvents(session.snapshotEvents(), session.id, policy)
}
