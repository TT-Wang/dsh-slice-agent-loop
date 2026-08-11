import { ContextBlock, ContextSelection, EpistemicRole, FreshnessClass, InstructionClass } from "./types.js";
import type { SliceCtx, SliceState } from "./state.js";
export declare function renderSkills(activeSkills: readonly {
    name: string;
    body: string;
}[]): string;
export declare function renderFindings(findings: readonly string[], sources?: Record<string, string> | null): string;
export declare function unfrozenFindings(s: SliceState, cap: number): string[];
export declare function knowledgeFrozen(s: SliceState, memoryText: string): boolean;
export declare function renderWorld(world: Record<string, unknown>): string;
export declare function renderIntent(intent: SliceState["intent"], opts?: {
    authorities?: readonly string[];
    kinds?: readonly string[];
}): string;
export declare function renderCorrections(intent: SliceState["intent"]): string;
export declare function renderTurnContract(s: SliceState): string;
export declare function renderTaskObjective(s: SliceState): string;
export declare function renderReconciliation(s: SliceState): string;
export declare function renderProgressSignals(signals: readonly {
    kind: string;
    detail: string;
    count: number;
}[]): string;
export declare const CURRENT_REQUEST_HDR: string;
export declare const NOW_FOOTER: string;
/** The live user ask, rendered once OUTSIDE the context fence at the salient tail. */
export declare function renderCurrentRequest(goal: string): string;
/** The intent-aware NOW footer — the OUTERMOST tail. */
export declare function renderNow(hints?: string): string;
export interface RegionSpec {
    readonly name: string;
    readonly render: (ctx: SliceCtx) => string;
    readonly zone: number;
    readonly priority: number;
    readonly instructionClass: InstructionClass;
    readonly freshness: FreshnessClass;
    readonly mandatory: boolean;
    readonly role: EpistemicRole;
}
export declare const REGIONS: readonly RegionSpec[];
export declare const REGION_ORDER: (readonly [string, number, (ctx: SliceCtx) => string, number])[];
export declare const REGION_META: ReadonlyMap<string, readonly [number, InstructionClass, FreshnessClass, boolean]>;
export declare const REGION_ROLES: ReadonlyMap<string, EpistemicRole>;
export declare function renderRegions(ctx: SliceCtx): string;
export declare const HEAD_ZONE = 0;
export declare const TAPE_ZONE = 1;
export declare const TAIL_ZONE = 2;
export declare function regionZone(name: string): number;
/** THE block factory — the one door into the model-visible stream. */
export declare function contextBlock(item: string, kw: Omit<ConstructorParameters<typeof ContextBlock>[0], "itemId" | "slot"> & {
    slot?: number;
}): ContextBlock;
/** Assembly-seam validator: EVERY block must sit at the zone its item declares. */
export declare function assertPlacementLaw(blocks: readonly ContextBlock[]): void;
export declare function buildContextBlocks(ctx: SliceCtx): ContextBlock[];
export declare function renderContextSelection(selection: ContextSelection): string;
