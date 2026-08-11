import type { ContextBlock, ContextSelection } from "./types.js";
import { ElasticityController } from "./types.js";
export interface ChatMessage {
    role: "system" | "user";
    content: string;
}
/**
 * A list-compatible seed plus its graded, re-renderable context plan.
 * Mirrors context.SeedPlan: system + blocks + render_blocks + request_block +
 * now_block; project() emits [system, user] messages.
 */
export declare class SeedPlan {
    readonly system: string;
    readonly blocks: readonly ContextBlock[];
    readonly renderBlocks: (selection: ContextSelection) => string;
    readonly requestBlock: string;
    readonly nowBlock: string;
    readonly controller: ElasticityController;
    lastSelection: ContextSelection | null;
    lastRequestCopies: number;
    constructor(init: {
        system: string;
        blocks: Iterable<ContextBlock>;
        renderBlocks: (selection: ContextSelection) => string;
        requestBlock: string;
        nowBlock: string;
        controller?: ElasticityController;
    });
    /** Physical envelope cost for the one exact recency request presentation. */
    fixedUserChars(copies?: number): number;
    project(capacityChars?: number | null): [ChatMessage, ChatMessage];
    /** Capacity that forces at least one fidelity step below the current selection. */
    nextTighterCapacity(): number | null;
}
