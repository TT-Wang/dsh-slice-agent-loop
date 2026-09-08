/**
 * Admission selects a bounded request view; it never compacts durable history.
 * A caller may authorize omission only when an existing recall tool serves the
 * entry's recorded content. File paths alone are not recall sources.
 */
import { TapeEntry, tapeChars } from './tape.js'

export type TapeRecallSource =
  | { readonly kind: 'turn'; readonly turn: number }
  | { readonly kind: 'step'; readonly turn: number; readonly step: number }

export interface TapeAdmissionOptions {
  /** Unicode code points in tapeRender(entries), including omission markers. */
  maxTapeChars: number
  /**
   * Return a locator only after verifying that its durable recall page includes
   * this entry's content. No locator is inferred from a digest or file path.
   * This callback is read once per entry, and only on overflow.
   */
  recallForEntry?: (entry: TapeEntry, index: number) => TapeRecallSource | undefined
}

export interface OmittedTapeEntry {
  /** Index in the original, unmodified tape passed to admitTape. */
  readonly index: number
  readonly entry: TapeEntry
  readonly reason: 'superseded-file-history' | 'oldest-group'
  readonly source: TapeRecallSource
}

export type TapeAdmission =
  | {
      readonly ok: true
      readonly entries: readonly TapeEntry[]
      readonly omitted: readonly OmittedTapeEntry[]
      readonly renderedChars: number
    }
  | {
      readonly ok: false
      readonly reason: 'unrecoverable-history' | 'budget-too-small'
      readonly maxTapeChars: number
      /** Size of the smallest safe view found by the deterministic policy. */
      readonly requiredChars: number
      readonly unrecoverableIndexes: readonly number[]
    }

const FILE_KINDS = new Set(['base', 'patch', 'external'])

function validSource(source: TapeRecallSource | undefined): source is TapeRecallSource {
  return source !== undefined
    && Number.isSafeInteger(source.turn) && source.turn > 0
    && (source.kind === 'turn'
      || (source.kind === 'step' && Number.isSafeInteger(source.step) && source.step > 0))
}

function recallCall(source: TapeRecallSource): string {
  return source.kind === 'turn'
    ? `recall_turn(${JSON.stringify({ turn: String(source.turn) })})`
    : `recall_step(${JSON.stringify({ turn: String(source.turn), step: String(source.step) })})`
}

function omissionMarker(omitted: readonly OmittedTapeEntry[]): TapeEntry {
  const calls = [...new Set(omitted.map(({ source }) => recallCall(source)))]
  return new TapeEntry({
    kind: 'admission',
    rendered: `[tape admission: ${omitted.length} entries omitted from this request view; `
      + `recorded history is unchanged. Recall the historical content: ${calls.join('; ')}]\n`,
  })
}

/**
 * Keep the original tape byte-for-byte when it fits. On overflow, omit obsolete
 * file history first, then oldest complete groups. A file's surviving base and
 * all later patches form one indivisible group; remaining non-file entries are
 * grouped by digest boundary. Every omission needs an explicit durable source.
 *
 * The bound applies to rendered tape only, not the assembled request or tokens.
 */
export function admitTape(
  tape: readonly TapeEntry[],
  options: TapeAdmissionOptions,
): TapeAdmission {
  const { maxTapeChars } = options
  if (!Number.isSafeInteger(maxTapeChars) || maxTapeChars < 0) {
    throw new RangeError('maxTapeChars must be a non-negative safe integer')
  }
  const initialChars = tapeChars(tape)
  if (initialChars <= maxTapeChars) {
    return { ok: true, entries: tape, omitted: [], renderedChars: initialChars }
  }

  const sources = tape.map((entry, index) => options.recallForEntry?.(entry, index))
  const omitted = new Map<number, OmittedTapeEntry>()
  const unrecoverable = new Set<number>()
  let smallestChars = initialChars

  function view(): Extract<TapeAdmission, { ok: true }> {
    const records = [...omitted.values()].sort((a, b) => a.index - b.index)
    const entries = tape.filter((_entry, index) => !omitted.has(index))
    if (records.length > 0) entries.unshift(omissionMarker(records))
    const renderedChars = tapeChars(entries)
    smallestChars = Math.min(smallestChars, renderedChars)
    return { ok: true, entries, omitted: records, renderedChars }
  }

  function omit(indexes: readonly number[], reason: OmittedTapeEntry['reason']): boolean {
    const missing = indexes.filter((index) => !validSource(sources[index]))
    if (missing.length > 0) {
      missing.forEach((index) => unrecoverable.add(index))
      return false
    }
    for (const index of indexes) {
      omitted.set(index, { index, entry: tape[index], reason, source: sources[index]! })
    }
    return true
  }

  const latestBase = new Map<string, number>()
  tape.forEach((entry, index) => {
    if (entry.kind === 'base' && entry.path) latestBase.set(entry.path, index)
  })
  // Remove an obsolete chain as a whole. Dropping one base alone could strand
  // a later patch if another entry in that chain has no durable locator.
  for (const [path, latest] of latestBase) {
    const history: number[] = []
    tape.forEach((entry, index) => {
      if (index < latest && entry.path === path && FILE_KINDS.has(entry.kind)) history.push(index)
    })
    if (history.length === 0 || !omit(history, 'superseded-file-history')) continue
    const candidate = view()
    if (candidate.renderedChars <= maxTapeChars) return candidate
  }

  const groups: number[][] = []
  const files = new Map<string, number[]>()
  let turnGroup: number[] = []
  tape.forEach((entry, index) => {
    if (omitted.has(index)) return
    if (entry.path && FILE_KINDS.has(entry.kind)) {
      let group = files.get(entry.path)
      if (!group) {
        group = []
        files.set(entry.path, group)
        groups.push(group)
      }
      group.push(index)
    } else {
      if (entry.kind === 'digest' || turnGroup.length === 0) {
        turnGroup = []
        groups.push(turnGroup)
      }
      turnGroup.push(index)
    }
  })
  groups.sort((a, b) => a[0] - b[0])
  for (const group of groups) {
    if (!omit(group, 'oldest-group')) continue
    const candidate = view()
    if (candidate.renderedChars <= maxTapeChars) return candidate
  }

  // A marker itself may exceed tiny caps. Do not silently return an empty
  // request view or an above-budget partial success in either failure case.
  return {
    ok: false,
    reason: unrecoverable.size > 0 ? 'unrecoverable-history' : 'budget-too-small',
    maxTapeChars,
    requiredChars: smallestChars,
    unrecoverableIndexes: [...unrecoverable].sort((a, b) => a - b),
  }
}
