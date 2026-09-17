import { describe, expect, it } from 'vitest'
import { admitTape, type TapeRecallSource } from '../src/lab/tape-admission.js'
import {
  baseEntry, digestEntry, patchEntry, renderTapeReply, replyEntry,
  tapeChars, tapeRender, type TapeEntry,
} from '../src/slice/tape.js'

const recordedTurn = (_entry: TapeEntry, index: number): TapeRecallSource => ({ kind: 'turn', turn: index + 1 })

describe('request tape admission', () => {
  it('preserves the exact cache prefix and entry identities while the tape fits', () => {
    const entries = Object.freeze([baseEntry('file.txt', 'first\n'), baseEntry('file.txt', 'second\n')])
    const before = tapeRender(entries)
    const result = admitTape(entries, {
      maxTapeChars: tapeChars(entries),
      recallForEntry: () => { throw new Error('fitting tape must not need recall provenance') },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.entries).toBe(entries)
    expect(tapeRender(result.entries)).toBe(before)
    expect(result.omitted).toEqual([])
  })

  it('admits ten 60,000-character file bodies within 120,000 characters without rewriting history', () => {
    const entries = Object.freeze(Array.from({ length: 10 }, (_, i) =>
      Object.freeze(baseEntry(`file-${i}.txt`, String(i).repeat(60_000)))))
    const records = entries.map((entry) => entry.toRecord())
    const result = admitTape(entries, { maxTapeChars: 120_000, recallForEntry: recordedTurn })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.renderedChars).toBeLessThanOrEqual(120_000)
    expect(result.renderedChars).toBe(Array.from(tapeRender(result.entries)).length)
    expect(result.omitted).toHaveLength(9)
    expect(result.entries.at(-1)).toBe(entries[9])
    expect(result.omitted.map(({ index }) => index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    for (const { index, entry, source } of result.omitted) {
      expect(entry).toBe(entries[index])
      expect(source).toEqual({ kind: 'turn', turn: index + 1 })
      expect(tapeRender(result.entries)).toContain(`recall_turn({"turn":"${index + 1}"})`)
    }
    expect(entries.map((entry) => entry.toRecord())).toEqual(records)
    expect(admitTape(entries, { maxTapeChars: 120_000, recallForEntry: recordedTurn })).toEqual(result)
  })

  it('removes obsolete file chains before current file content or complete turn groups', () => {
    const old = baseEntry('file.txt', 'old\n'.repeat(500))
    const delta = patchEntry('file.txt', old.payload, `${old.payload}more\n`)
    const digest = digestEntry('earlier turn\n', 'slice-turn-1')
    const current = baseEntry('file.txt', 'current\n')
    const entries = [old, digest, delta, current]
    const result = admitTape(entries, { maxTapeChars: 500, recallForEntry: recordedTurn })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.omitted.map(({ index, reason }) => [index, reason])).toEqual([
      [0, 'superseded-file-history'], [2, 'superseded-file-history'],
    ])
    expect(result.entries.slice(1)).toEqual([digest, current])
  })

  it('never retains an orphan patch when file histories cross turn boundaries', () => {
    const original = 'old\n'.repeat(1000)
    const updated = `${original}new\n`
    const entries = [
      digestEntry('turn one\n', 'slice-turn-1'),
      baseEntry('large.txt', original),
      baseEntry('keep.txt', 'small\n'),
      digestEntry('turn two\n', 'slice-turn-2'),
      patchEntry('large.txt', original, updated),
      patchEntry('keep.txt', 'small\n', 'small update\n'),
    ]
    const result = admitTape(entries, { maxTapeChars: 900, recallForEntry: recordedTurn })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.entries.some((entry) => entry.path === 'large.txt')).toBe(false)
    const bases = new Set<string>()
    for (const entry of result.entries) {
      if (entry.kind === 'base') bases.add(entry.path)
      if (entry.kind === 'patch') expect(bases.has(entry.path)).toBe(true)
    }
  })

  it('keeps a turn digest and its reply together and deduplicates their recall pointer', () => {
    const entries = [
      digestEntry('first turn\n'.repeat(100), 'slice-turn-1'),
      replyEntry('slice-turn-1', 'first response')!,
      digestEntry('second turn\n', 'slice-turn-2'),
      replyEntry('slice-turn-2', 'second response')!,
    ]
    const result = admitTape(entries, {
      maxTapeChars: 450,
      recallForEntry: (_entry, index) => ({ kind: 'turn', turn: index < 2 ? 1 : 2 }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.omitted.map(({ index }) => index)).toEqual([0, 1])
    expect(result.entries.slice(1)).toEqual(entries.slice(2))
    expect(tapeRender(result.entries).match(/recall_turn/g)).toHaveLength(1)
  })

  it('uses verified step locators without claiming that a file re-read restores historical bytes', () => {
    const entry = baseEntry('remote/file.txt', 'remote historical bytes\n'.repeat(100))
    const result = admitTape([entry], {
      maxTapeChars: 250,
      recallForEntry: () => ({ kind: 'step', turn: 7, step: 3 }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(tapeRender(result.entries)).toContain('recall_step({"turn":"7","step":"3"})')
    expect(tapeRender(result.entries)).not.toContain('read_file')
    expect(tapeRender(result.entries)).not.toContain('current on-disk')
  })

  it('refuses to omit a file body without verified durable provenance', () => {
    const entry = baseEntry('file.txt', 'historical bytes\n'.repeat(100))
    const result = admitTape([entry], { maxTapeChars: 250 })
    expect(result).toEqual({
      ok: false,
      reason: 'unrecoverable-history',
      maxTapeChars: 250,
      requiredChars: tapeChars([entry]),
      unrecoverableIndexes: [0],
    })
  })

  it('does not strand an unrecallable patch by removing its obsolete base', () => {
    const original = 'old\n'.repeat(1000)
    const entries = [
      baseEntry('file.txt', original),
      patchEntry('file.txt', original, `${original}new\n`),
      baseEntry('file.txt', 'current\n'),
    ]
    const result = admitTape(entries, {
      maxTapeChars: 500,
      recallForEntry: (entry, index) => entry.kind === 'patch' ? undefined : recordedTurn(entry, index),
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unsafe omission was admitted')
    expect(result.reason).toBe('unrecoverable-history')
    expect(result.unrecoverableIndexes).toEqual([1])
  })

  it('counts Unicode code points, including the marker, and accepts the exact boundary', () => {
    const entries = [baseEntry('💾.txt', '😀'.repeat(1000))]
    const first = admitTape(entries, { maxTapeChars: 500, recallForEntry: recordedTurn })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error(first.reason)
    expect(first.renderedChars).toBe(Array.from(tapeRender(first.entries)).length)
    expect(admitTape(entries, { maxTapeChars: first.renderedChars, recallForEntry: recordedTurn }).ok).toBe(true)
    const below = admitTape(entries, { maxTapeChars: first.renderedChars - 1, recallForEntry: recordedTurn })
    expect(below.ok).toBe(false)
    if (below.ok) throw new Error('above-cap marker was admitted')
    expect(below.reason).toBe('budget-too-small')
  })

  it('accepts an empty zero-cap view and fails explicitly when a nonempty view cannot fit its marker', () => {
    expect(admitTape([], { maxTapeChars: 0 })).toEqual({ ok: true, entries: [], omitted: [], renderedChars: 0 })
    const result = admitTape([baseEntry('file.txt', 'contents')], {
      maxTapeChars: 0, recallForEntry: recordedTurn,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('zero-cap omission marker was admitted')
    expect(result.reason).toBe('budget-too-small')
    expect(result.requiredChars).toBeGreaterThan(0)
  })

  it.each([-1, 0.5, Infinity, NaN])('rejects an invalid tape character cap: %s', (maxTapeChars) => {
    expect(() => admitTape([], { maxTapeChars })).toThrow(RangeError)
  })
})

describe('zero reply caps', () => {
  it('retains the configured head and no tail when tail is zero', () => {
    const rendered = renderTapeReply('slice-turn-1', `HEAD${'m'.repeat(992)}TAIL`, { cap: 20, head: 10, tail: 0 })
    expect(rendered).toContain('HEADmmmmmm …[+990 chars in sealed turn]… ')
    expect(rendered).not.toContain('TAIL')
    expect(rendered.length).toBeLessThan(150)
  })

  it('retains no reply bytes when head and tail are both zero', () => {
    const rendered = renderTapeReply('slice-turn-1', 'unretained reply', { cap: 0, head: 0, tail: 0 })
    expect(rendered).toContain('…[+16 chars in sealed turn]…')
    expect(rendered).not.toContain('unretained reply')
    expect(renderTapeReply('slice-turn-1', '', { cap: 0, head: 0, tail: 0 })).toBe('')
  })
})
