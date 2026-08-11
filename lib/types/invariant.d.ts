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
import type { Context } from '@deepseek-ai/cordis';
/**
 * Register this package's runtime checks.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
export declare const inject: string[];
export declare const name = "dsh-slice-agent-loop/invariant";
