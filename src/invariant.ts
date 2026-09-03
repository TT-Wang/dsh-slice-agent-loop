/**
 * @module dsh-slice-agent-loop/invariant
 *
 * The companion runtime check for this loop — the honest replacement for
 * `@deepseek-ai/dsh-agent-loop/invariant`.
 *
 * The stock companion asserts `model-visible ⟺ logged`: the request's messages
 * must equal `session.deriveMessages()` byte for byte. A bounded-slice loop
 * cannot satisfy that by construction — it sends a REBUILT slice sized to the
 * current task, not the accumulated history. That is the whole point, not a
 * defect, so mounting the stock companion beside this loop kills every turn
 * (the plugin refuses to load in that configuration, see src/index.ts).
 *
 * What IS true, and what this asserts instead: every request the loop dispatches
 * was recorded first. The driver appends `slice/request-slice` with the digest
 * of the slice seed immediately before dispatch, so the request is auditable
 * after the fact — you can prove what turn N step M actually sent — without
 * duplicating the whole slice into the log.
 *
 * Mount it exactly like the stock one:
 *   - id: slice-agent-loop-invariant
 *     name: 'dsh-slice-agent-loop/invariant'
 */

import type { Context } from '@deepseek-ai/cordis'
// Side-effect import: brings the `ctx.invariants` Context augmentation into scope.
import type {} from '@deepseek-ai/dsh-invariants'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { sliceDigest, seedTextOf } from './driver.js'
import { maybeHarnessUniverse } from './universe.js'

const PACKAGE_NAME = 'dsh-slice-agent-loop'

/**
 * Assert that one dispatched request matches its audit record.
 * @param ctx - child context owned by this invariant registration.
 * @param fail - reporter bound to this package name.
 */
const install = (ctx: Context, fail: (message: string) => never): void => {
  ctx.on('llm/stream', (options: GenerateOptions, next) => {
    // Only this loop's own requests carry the mark; anything else (title
    // generation, summarizers, host tools) is none of our business. The mark
    // lives in the HOST universe's WeakSet (markAgentLoopRequest in the
    // driver goes through the same adapter); before the universe resolves no
    // driver has run, so nothing can be marked yet.
    const universe = maybeHarnessUniverse()
    if (universe === undefined) return next()
    if (!universe.llm.isAgentLoopRequest(options) || options.sessionId === undefined) return next()
    const session = ctx.sessions.get(options.sessionId)
    if (session === undefined) return next()

    const recorded = [...session.snapshotEvents()].reverse()
      .find(event => event.type === 'slice/request-slice')
    if (recorded === undefined) {
      return fail(`dispatched a marked request for session "${String(options.sessionId)}" with no slice/request-slice audit record`)
    }
    const actual = sliceDigest(seedTextOf(options.messages))
    if (actual !== recorded.data.seedDigest) {
      return fail(
        `slice seed for session "${String(options.sessionId)}" turn ${recorded.data.turn} step ${recorded.data.step} `
        + `diverges from its audit record (recorded ${recorded.data.seedDigest.slice(0, 12)}, dispatched ${actual.slice(0, 12)})`,
      )
    }
    if (options.messages.length !== recorded.data.messageCount) {
      return fail(
        `slice message count for session "${String(options.sessionId)}" turn ${recorded.data.turn} step ${recorded.data.step} `
        + `diverges from its audit record (recorded ${recorded.data.messageCount}, dispatched ${options.messages.length})`,
      )
    }
    return next()
  }, { global: true, prepend: true })
}

install.inject = ['sessions']

/**
 * Register this package's runtime checks.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

export const inject = ['invariants']
export const name = 'dsh-slice-agent-loop/invariant'
