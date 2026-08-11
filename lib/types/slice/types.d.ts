export declare enum InstructionClass {
    SYSTEM = "system",
    USER = "user",
    TASK_STATE = "task_state",
    DATA = "data"
}
export declare enum FreshnessClass {
    LIVE = "live",
    REVISION_BOUND = "revision_bound",
    DERIVED = "derived",
    HISTORICAL = "historical"
}
export declare enum EpistemicRole {
    DIRECTIVE = "directive",
    OBSERVATION = "observation",
    CLAIM = "claim",
    PROCEDURE = "procedure",
    CONTROL_STATE = "control_state",
    LOCATOR = "locator"
}
export declare enum ResourceKind {
    WORKSPACE_FILE = "workspace_file",
    ARTIFACT = "artifact",
    HISTORY = "history",
    SUBAGENT = "subagent",
    ROSTER = "roster",
    SKILL = "skill",
    INTERNAL_CONTEXT = "internal_context"
}
export interface ResourceRef {
    readonly kind: ResourceKind;
    readonly handle: string;
}
export declare function resourceRefVirtual(ref: ResourceRef): boolean;
export interface SourceRef {
    readonly kind: string;
    readonly handle: string;
    readonly revision: string;
}
export declare function makeSourceRef(kind: string, handle: string, revision?: string): SourceRef;
/** Classify a model-visible handle without touching the filesystem. */
export declare function reservedResourceRef(path: string): ResourceRef;
export declare enum Fidelity {
    FULL = "full",
    EXCERPT = "excerpt",
    DIGEST = "digest",
    LOCATOR = "locator"
}
export declare enum RepresentationLoss {
    NONE = "none",
    SELECTION = "selection",
    SUMMARY = "summary",
    POINTER_ONLY = "pointer_only"
}
export declare enum PressureLevel {
    ROOMY = "roomy",
    ELEVATED = "elevated",
    TIGHT = "tight",
    CRITICAL = "critical",
    UNFIT = "unfit"
}
export interface ContextBlockInit {
    blockId: string;
    itemId: string;
    alternativeGroup: string;
    priority: number;
    instructionClass: InstructionClass;
    freshness: FreshnessClass;
    fidelity: Fidelity;
    representationLoss: RepresentationLoss;
    content: string;
    handles?: readonly string[];
    mandatory?: boolean;
    reobservable?: boolean;
    order?: number;
    /** TAIL by default (placement law); only context_block() may rely on the derived zone. */
    slot?: number;
    epistemicRole?: EpistemicRole;
    scope?: readonly string[];
    sourceRefs?: readonly SourceRef[];
    resourceRefs?: readonly ResourceRef[];
}
export declare class ContextBlock {
    readonly blockId: string;
    readonly itemId: string;
    readonly alternativeGroup: string;
    readonly priority: number;
    readonly instructionClass: InstructionClass;
    readonly freshness: FreshnessClass;
    readonly fidelity: Fidelity;
    readonly representationLoss: RepresentationLoss;
    readonly content: string;
    readonly handles: readonly string[];
    readonly mandatory: boolean;
    readonly reobservable: boolean;
    readonly order: number;
    readonly slot: number;
    readonly epistemicRole: EpistemicRole;
    readonly scope: readonly string[];
    readonly sourceRefs: readonly SourceRef[];
    readonly resourceRefs: readonly ResourceRef[];
    constructor(init: ContextBlockInit);
}
export declare class ContextSelection {
    readonly blocks: readonly ContextBlock[];
    readonly pressure: PressureLevel;
    readonly usedChars: number;
    readonly capacityChars: number | null;
    constructor(blocks: readonly ContextBlock[], pressure: PressureLevel, usedChars: number, capacityChars: number | null);
    bySlot(): Map<number, readonly ContextBlock[]>;
}
/** Python sorted(blocks, key=(order, block_id)) — stable, tuple compare. */
export declare function sortBlocks(blocks: readonly ContextBlock[]): ContextBlock[];
/**
 * Select one graded alternative per semantic item under a global capacity.
 * Mirrors ElasticityController.select exactly, including error precedence:
 * duplicate-id and group-shape checks run before the capacity check.
 */
export declare class ElasticityController {
    select(blocks: Iterable<ContextBlock>, opts?: {
        capacityChars?: number | null;
    }): ContextSelection;
}
export { ContextUnfitError } from "./internal/errors.js";
