/**
 * The renderer context (`ctx`) and Slice state model. Mirrors the attribute
 * surface the Python renderers read via getattr-with-defaults, and the
 * SimpleNamespace construction in tests/golden/gen_goldens.py — both sides
 * build from the same cases.json so the shapes are identical by contract.
 */
import type { TapeEntry } from "./tape.js";
export interface IntentEntry {
    verbatimClause: string;
    status: string;
    authority: string;
    kind: string;
    sourceArtifact: string;
    sourceRange: readonly [number, number] | null;
}
export interface NamedLabel {
    label: string;
    source?: string;
}
export interface EvidenceQuery {
    source: string;
    family: string;
    predicate: string;
    scope: string;
}
export interface QualityQuery {
    scope: string;
    purpose: string;
    prospectiveRequested: boolean;
}
export interface DelegationRequirement {
    agent: string;
    count: number | null;
    parallel: boolean;
    targets: readonly string[];
}
export interface EffectGrant {
    operation: string;
    tools: readonly string[];
    target: string;
}
export interface ReferentAnchor {
    artifactId: string;
    collection: string;
    ordinal: number;
    excerpt: string;
}
export type Referent = Record<string, unknown> & {
    kind: string;
};
export interface TurnContract {
    grounding: string;
    sourceNeeds: readonly string[];
    evidenceQuery: EvidenceQuery | null;
    qualityEvidenceQuery: QualityQuery | null;
    delegationRequirement: DelegationRequirement | null;
    requestedModes: readonly string[];
    actor: NamedLabel | null;
    target: NamedLabel | null;
    evidenceContinuation: boolean;
    focusRepairs: readonly {
        field?: string;
        replacement?: NamedLabel | null;
    }[];
    effectGrants: readonly EffectGrant[];
    authoritySpans: readonly (readonly [number, number])[];
    attributedSpans: readonly (readonly [number, number])[];
    referents: readonly Referent[];
    effectAuthority: string;
}
export interface IntentState {
    entries: IntentEntry[];
    currentRequest: string;
    currentSource: string;
    turnContract: TurnContract | null;
}
export interface ProgressSignal {
    kind: string;
    detail: string;
    count: number;
}
export interface TaskState {
    goal: string;
    goalSource: string;
    objectiveStatus: string;
    progressSignals: ProgressSignal[];
    deliverableRequirement: {
        kind?: string;
    } | null;
}
export interface ContinuityState {
    tapeFindingHashes: Set<string>;
    tapeKnowledgeHashes: Set<string>;
    tapeTaskId: string;
    lastKnowledgeRender: string;
}
export interface ActiveWorkState {
    items: readonly unknown[];
}
export interface SliceState {
    intent: IntentState | null;
    task: TaskState;
    findings: string[];
    findingSource: Record<string, string>;
    sessionTape: TapeEntry[];
    activeFiles: string[];
    activeSkills: {
        name: string;
        body: string;
    }[];
    world: Record<string, unknown>;
    openReport: string;
    lastError: string;
    reconciliationRequired: string;
    reconciliationTargets: readonly string[];
    continuity: ContinuityState;
    activeWork: ActiveWorkState | null;
    conversation: Record<string, unknown>[];
}
export interface SliceCtx {
    s: SliceState;
    artifacts: string;
    discovery: string;
    memory: string;
    threads: string;
    worktree: string;
    focus: string;
    repoMap: string;
    openFilePaths: readonly string[];
    maxFindings: number;
    /** memo slot for _graph_trim_selected (false = graph inactive / trim nothing) */
    _graphNeeds?: false | ReadonlySet<string>;
    graphSourceTexts?: Record<string, string>;
    graphLogicalId?: string;
    graphWorkspaceEpoch?: number | null;
}
type Json = Record<string, unknown>;
/** Key for the (task_id, hash) tuple sets — one helper so writes and lookups can't drift. */
export declare const hashPairKey: (taskId: string, hash: string) => string;
export declare function normalizeSliceState(spec: Json, topSpec?: Json): SliceState;
/**
 * Build the renderer ctx from a cases.json-shaped spec. `freeze_findings` /
 * `freeze_knowledge` mirror gen_goldens: the hash registries are computed with
 * the PORTED hash functions, so suppression parity exercises the same chain.
 */
export declare function normalizeCtx(spec: Json, renderFindingsLine: (text: string, sources: Record<string, string>) => string): SliceCtx;
export {};
