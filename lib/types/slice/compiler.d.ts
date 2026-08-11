/**
 * The moat user-string assembly: renderRegions (the compiler entry) and
 * assembleSlice (the make_build_slice-shaped splice: byte-stable system prefix
 * + <context> envelope + CURRENT REQUEST + NOW footer).
 */
import type { SliceCtx } from "./state.js";
import type { ContextBlock } from "./types.js";
import { SeedPlan, type ChatMessage } from "./buildSlice.js";
export { renderRegions } from "./regions.js";
export interface AssembledSlice {
    /** The byte-stable system prefix, passed through untouched. */
    systemPrefix: string;
    /** The moat user string (volatile slice). */
    userString: string;
    /** The region blocks the elasticity controller projected from. */
    blocks: readonly ContextBlock[];
    /** The plan for re-projection as trajectory pressure changes. */
    plan: SeedPlan;
    messages: [ChatMessage, ChatMessage];
}
/**
 * One-turn assembly, mirroring seed.make_build_slice's build():
 * ctx regions -> build_context_blocks -> SeedPlan.project(capacity).
 * The system prefix is host-owned and byte-stable; this function never mutates it.
 */
export declare function assembleSlice(ctx: SliceCtx, opts: {
    systemPrefix: string;
    request: string;
    hints?: string;
    capacityChars?: number | null;
}): AssembledSlice;
