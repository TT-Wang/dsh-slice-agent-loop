// Harness-owned per-turn step cap (slice-vs-stock, docs/slice-vs-stock-2026-10-23.md §2.4).
//
// The stock host has no step limit and the slice plugin's own `maxStepsPerTurn` exists only in the slice arm,
// so a cap taken from either would differ between arms. This row is mounted identically in EVERY arm through
// the per-batch steps patch (run_ab.py writes `- insert: - id: ab-step-cap, name: <AB/plugins/step-cap.mjs>`),
// and the slice plugin's own cap stays at its default (none). It does what the slice cap does: when step N+1 of
// a turn would start, the pre-step decision becomes a rejection, so the turn ends with turn_end kind `blocked`
// and exit 1, which the harness classifies as model-attributable.
//
// run_ab.py copies this file to AB/plugins/ next to a package.json whose peers admit the host (the host
// attributes a path row to the nearest package.json above it).

export const name = 'ab-step-cap'

/**
 * @param {any} ctx
 * @param {{ maxStepsPerTurn?: number }} config
 */
export function apply(ctx, config) {
  const cap = config?.maxStepsPerTurn
  if (!Number.isSafeInteger(cap) || /** @type {number} */ (cap) < 1) {
    throw new Error('ab-step-cap: maxStepsPerTurn must be a positive safe integer')
  }
  ctx.on('agent/pre-step', async (/** @type {any} */ { step, signal }, /** @type {() => Promise<any>} */ next) => {
    const decision = await next()
    signal?.throwIfAborted?.()
    if (decision?.kind !== 'enter') return decision
    if (step > /** @type {number} */ (cap)) {
      ctx.logger.warn(`ab-step-cap maxStepsPerTurn=${cap} reached`)
      return { kind: 'reject' }
    }
    return decision
  })
}
