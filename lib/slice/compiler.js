import { buildContextBlocks, renderContextSelection, renderCurrentRequest, renderNow } from "./regions.js";
import { SeedPlan } from "./buildSlice.js";
export { renderRegions } from "./regions.js";
/**
 * One-turn assembly, mirroring seed.make_build_slice's build():
 * ctx regions -> build_context_blocks -> SeedPlan.project(capacity).
 * The system prefix is host-owned and byte-stable; this function never mutates it.
 */
export function assembleSlice(ctx, opts) {
    const blocks = buildContextBlocks(ctx);
    const plan = new SeedPlan({
        system: opts.systemPrefix,
        blocks,
        renderBlocks: renderContextSelection,
        requestBlock: renderCurrentRequest(opts.request),
        nowBlock: renderNow(opts.hints ?? ""),
    });
    const messages = plan.project(opts.capacityChars ?? null);
    return {
        systemPrefix: opts.systemPrefix,
        userString: messages[1].content,
        blocks,
        plan,
        messages,
    };
}
