/**
 * Pressure-triggered batch archive on the stock ordered surface.
 *
 * Steady state appends nothing: below `highWaterChars` every request is the
 * stock append-only transcript. Above it, the oldest completed turns are
 * folded into frozen `[slice checkpoint v1 …]` nodes until the view is back
 * under `lowWaterChars`. A checkpoint is a pure function of the nodes it
 * shadows and is never re-rendered; a later archive nests it as one line.
 * Consecutive archives are at least one water-mark band of new history apart,
 * so an un-archivable floor above the target never re-nests every turn.
 *
 * Superseded runtime-context snapshots are ordinary archivable history here:
 * the host projects one per change and each declares the earlier ones obsolete,
 * so protecting them all would pile up one dead protected node per turn until
 * no archive can bring the view under maxRequestChars. They are still never
 * removed between pressure events (that would break the append-only prefix);
 * an archive absorbs them with the turns around them, and one that no
 * checkpoint covers (the recent tail, or the open turn at a last-resort
 * mid-turn archive) is shadowed by a one-line note naming its recall page.
 */
import { type Message, type UserMessage } from '@deepseek-ai/dsh-llm';
import { type Session, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session';
export declare const HISTORY_SOURCE = "slice:history";
export declare const CHECKPOINT_PREFIX = "[slice checkpoint v1 \u00B7 turns ";
/** Stand-in for superseded runtime snapshots in the raw recent tail, appended only at an archive event. */
export declare const SNAPSHOT_NOTE_PREFIX = "[slice note \u00B7 ";
/** The host's runtime-context projection (dsh-agent-loop RuntimeContextProjection). */
export declare const RUNTIME_CONTEXT_SOURCE = "@deepseek-ai/dsh-system-prompt";
export declare class SliceBudgetError extends Error {
    constructor(message: string);
}
export interface HistoryPolicy {
    highWaterChars: number;
    lowWaterChars: number;
    keepRecentChars: number;
    pinFirstTurn: boolean;
    pinUserChars: number;
    checkpointMaxChars: number;
    /** Explicit extra cap on rendered history (checkpoints + retained raw turn text). */
    maxHistoryChars?: number;
    maxRequestChars: number;
}
export interface PlannedAppend {
    message: UserMessage;
    start: SessionSeq;
    end: SessionSeq;
    sources: SessionSeq[];
}
export interface ArchivePlan {
    appends: PlannedAppend[];
    /** Serialized final view (history + pending messages) after the plan. */
    viewChars: number;
    /** Serialized rendered history after the plan. */
    historyChars: number;
}
/** Operator-facing notices (the plugin wires this to ctx.logger.warn). */
export type Warn = (message: string) => void;
export declare function ours(event: SessionEvent): boolean;
/** True for a message the host's runtime-context projection just produced. */
export declare function isRuntimeSnapshot(message: Message): boolean;
interface Node {
    seq: SessionSeq;
    event: SessionEvent;
    /** Null for surface nodes that derive no message (an empty assistant reply); they still occupy the range. */
    message: Message | null;
    size: number;
    /** Turn range the node belongs to (a checkpoint spans several turns). */
    turns: [number, number];
    protected: boolean;
    /**
     * A runtime snapshot a newer one supersedes, or our own note standing in for such snapshots:
     * archivable, and rendered in a checkpoint only as a note, never as a request line.
     */
    superseded: boolean;
    /** Turns recall_turn attributes the snapshot(s) to (src/recall.ts ownerOf), 0 for none. */
    recallTurns: number[];
}
/** One line for every superseded runtime snapshot of a turn; the text stays on its recall page. */
export declare function snapshotNote(recallTurns: readonly number[]): string;
/**
 * Deterministic checkpoint text: drop tool lines first, then shrink excerpts until it fits.
 * `maxChars` is a target: the smallest level is returned as is when even it does not fit.
 * `bare` (last-resort degradation only) renders the header and a recall pointer, nothing else.
 */
export declare function renderCheckpoint(session: Session, run: readonly Node[], toolNames: Map<string, string>, pinUserChars: number, maxChars: number, bare?: boolean): string;
/**
 * Decide the whole archive before any append. Returns an empty plan when the
 * final view is under pressure thresholds and fits maxRequestChars.
 *
 * When archiving to the water marks still leaves the request above
 * maxRequestChars, it degrades deterministically before refusing: first the
 * recent tail is archived too, then checkpoints drop their turn bodies (recall
 * still serves every turn). It throws SliceBudgetError (with no appends) only
 * when the protected floor plus the current input cannot fit on their own.
 */
export declare function planArchive(session: Session, pending: readonly Message[], policy: HistoryPolicy, warn?: Warn): ArchivePlan;
export declare function applyArchive(session: Session, plan: ArchivePlan): void;
/** Plan and apply in one call; the decision is complete before the first append. */
export declare function archiveUnderPressure(session: Session, pending: readonly Message[], policy: HistoryPolicy, warn?: Warn): ArchivePlan;
/**
 * Size of the request this step will build: the current surface plus the
 * messages pre-step's decision is about to append. The loop derives its
 * messages before agent/request runs, so pre-step is the last point at which
 * the session may still be edited.
 */
export declare function requestChars(session: Session, incoming?: readonly Message[]): number;
/** Serialized message bound, deliberately distinct from tokenizer/model capacity. */
export declare function assertRequestBudget(messages: readonly Message[], maxRequestChars: number): void;
export {};
