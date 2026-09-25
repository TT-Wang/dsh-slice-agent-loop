/** Original result lookup shared by narrow expansion and whole-step recall. */
import { readFile } from 'node:fs/promises'
import { isAppendSurfaceEvent, type SessionEvent, type ToolResultMessage } from '@deepseek-ai/dsh-session'

/** Session format V4: a tool/result event carries one tool-role message, so its only block is the message itself. */
type ResultBlock = ToolResultMessage
export type ResultLocator = { seq: number } | { turn: number; step: number; call: number }

function noteCalls(names: Map<string, string>, event: SessionEvent): void {
  if (event.type === 'tool/call') names.set(event.data.callId, event.data.name)
  if (event.type === 'assistant/message') {
    for (const block of event.data.message.content) if (block.type === 'tool-call') names.set(block.id, block.name)
  }
}

function blocksOf(message: ToolResultMessage, block?: number): readonly ResultBlock[] {
  const blocks = [message]
  if (block === undefined) return blocks
  if (!Number.isInteger(block) || block < 1) throw new Error('expand_result: "block" must be a positive integer')
  const selected = blocks[block - 1]
  if (selected === undefined) throw new Error(`expand_result: no result block ${block} (result has ${blocks.length} blocks)`)
  return [selected]
}

function textOf(block: ResultBlock): string {
  return block.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
}

function describeResult(calls: ReadonlyMap<string, string>, message: ToolResultMessage, block?: number): { name: string; text: string } {
  const blocks = blocksOf(message, block)
  const names = [...new Set(blocks.map((item) => calls.get(String(item.toolCallId)) ?? 'tool'))]
  return { name: names.join(', ') || 'tool', text: blocks.map(textOf).join('\n') }
}

function resultEventAt(events: readonly SessionEvent[], turn: number, step: number, call: number): SessionEvent<'tool/result'> | undefined {
  let ordinal = 0
  for (const event of events) {
    if (event.type !== 'tool/result' || !isAppendSurfaceEvent(event)) continue
    if (event.data.turn === turn && event.data.step === step && ++ordinal === call) return event
  }
  return undefined
}

/** The ordinal counts original result events (one per call in V4), never replacement copies. */
export function fullResultAt(events: readonly SessionEvent[], turn: number, step: number, call: number, block?: number): { name: string; text: string } | null {
  const result = resultEventAt(events, turn, step, call)
  if (result === undefined) return null
  const calls = new Map<string, string>()
  for (const event of events) {
    if (event.seq > result.seq) break
    noteCalls(calls, event)
  }
  return describeResult(calls, result.data.message, block)
}

/** A replacement locator resolves to its durable original tool/result. */
export function originalResultAt(events: readonly SessionEvent[], seq: number): SessionEvent<'tool/result'> {
  const seen = new Set<number>()
  for (let at = seq; ;) {
    const direct = events[at]
    const event = direct?.seq === at ? direct : events.find((item) => item.seq === at)
    if (event === undefined) throw new Error(`expand_result: no session event at seq ${at}`)
    if (event.type !== 'tool/result') throw new Error(`expand_result: seq ${at} is a ${event.type} event, not a tool result`)
    if (isAppendSurfaceEvent(event)) return event
    const source = event.sourceEventSeqs?.[0]
    if (source === undefined || seen.has(source)) throw new Error(`expand_result: the replacement at seq ${at} names no original tool result`)
    seen.add(at)
    at = source
  }
}

export function resultBySeq(events: readonly SessionEvent[], seq: number, block?: number): { name: string; text: string; seq: number; turn: number; step: number; call: number } {
  const original = originalResultAt(events, seq)
  const calls = new Map<string, string>()
  let call = 0
  for (const event of events) {
    if (event.seq > original.seq) break
    noteCalls(calls, event)
    if (event.type === 'tool/result' && isAppendSurfaceEvent(event)
      && event.data.turn === original.data.turn && event.data.step === original.data.step) call += 1
  }
  return { ...describeResult(calls, original.data.message, block), seq: original.seq, turn: original.data.turn, step: original.data.step, call }
}

/** A durable spill preview names the stored bytes on its first line. */
export function spillLocatorOf(text: string): { bytes: number; locator: string } | undefined {
  const first = text.split('\n', 1)[0]!
  const match = /^\[.* · full text \((\d+) bytes\) stored at (.+?) — .*\]$/.exec(first)
  return match ? { bytes: Number(match[1]), locator: match[2]! } : undefined
}

/** The native spill-policy notice: `(Omitted N bytes.[ Omitted M images.] Full formatted result stored at: …)`. */
function nativeSpillLocatorOf(logged: string): { locator: string } | undefined {
  // The local backend's complete notice has fixed retrieval guidance; match
  // that suffix so a period inside a path cannot truncate the locator. DSH
  // 0.1.7 adds an image count when whole images were omitted as well.
  const native = /(?:^|\n\n)\(Omitted \d+ bytes\.(?: Omitted \d+ images\.)? Full formatted result stored at: ([^\n]+)\. Use read with offset\/limit, or grep this path to search within it\.\)$/.exec(logged)
  return native ? { locator: native[1]! } : undefined
}

export function storedTextLocatorOf(logged: string): { locator: string; bytes?: number } | undefined {
  return spillLocatorOf(logged) ?? nativeSpillLocatorOf(logged)
}

type StoredLocator = { locator: string; bytes?: number }
/** One text part of a logged result, and the stored original it previews, if any. */
export type LoggedTextPart = { text: string; preview?: StoredLocator }

/**
 * The text parts of one logged result content. Native spill-policy stores the
 * whole formatted content (every text part in order, images as descriptors)
 * and ends the retained [head, image…, tail] copy with its notice, so that
 * notice on the last text part previews all of them: they form one preview
 * part. A fold spill preview identifies only its own part.
 */
export function loggedTextParts(content: ReadonlyArray<{ type: string; text?: unknown }>): LoggedTextPart[] {
  const texts = content.flatMap((part) => part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])
  const native = texts.length > 1 && spillLocatorOf(texts.at(-1)!) === undefined ? nativeSpillLocatorOf(texts.at(-1)!) : undefined
  if (native !== undefined) return [{ text: texts.join('\n'), preview: native }]
  return texts.map((text) => {
    const preview = storedTextLocatorOf(text)
    return preview === undefined ? { text } : { text, preview }
  })
}

async function readStored(spill: StoredLocator, where: string): Promise<string> {
  try { return await readFile(spill.locator, 'utf8') } catch (error) {
    throw new Error(`expand_result: the full text of ${where} (${spill.bytes ?? 'unknown'} bytes) was stored at ${spill.locator} and cannot be read from here (${String(error)}); read that locator with the file tools instead`)
  }
}

export async function originalText(logged: string, where: string): Promise<string> {
  const spill = storedTextLocatorOf(logged)
  return spill === undefined ? logged : await readStored(spill, where)
}

/** The stored original of one logged text part, or its own text when it previews nothing. */
export async function originalPartText(part: LoggedTextPart, where: string): Promise<string> {
  return part.preview === undefined ? part.text : await readStored(part.preview, where)
}

/** Hydrate each original text part before joining the parts; see {@link loggedTextParts}. */
export async function originalResultText(events: readonly SessionEvent[], locator: ResultLocator, where: string, block?: number): Promise<string> {
  const event = 'seq' in locator ? originalResultAt(events, locator.seq)
    : resultEventAt(events, locator.turn, locator.step, locator.call)
  if (event === undefined) throw new Error(`expand_result: no tool result recorded at ${where}`)
  return (await Promise.all(blocksOf(event.data.message, block).map(async (item, index) => (
    await Promise.all(loggedTextParts(item.content).map((part, partIndex) =>
      originalPartText(part, `${where} block ${block ?? index + 1} text part ${partIndex + 1}`)))
  ).join('\n')))).join('\n')
}
