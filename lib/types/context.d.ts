import { type Message, type UserMessage } from '@deepseek-ai/dsh-llm';
import { type Session, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session';
export declare const HISTORY_SOURCE = "slice:history";
export declare const CHECKPOINT_PREFIX = "[slice checkpoint v1 \u00B7 turns ";
/** Header of a sealed entry. Sessions written by the pressure-archive build carry CHECKPOINT_PREFIX; both parse. */
export declare const TAPE_PREFIX = "[slice tape v1 \u00B7 turns ";
/** Stand-in for a superseded runtime snapshot inside the entry that seals its turn. */
export declare const SNAPSHOT_NOTE_PREFIX = "[slice note \u00B7 ";
/** The host's runtime-context projection (dsh-agent-loop RuntimeContextProjection). */
export declare const RUNTIME_CONTEXT_SOURCE = "@deepseek-ai/dsh-system-prompt";
export interface HistoryPolicy {
    /** Completed turns kept raw at the tail; 0 seals a turn as soon as the next one starts. */
    keepRecentTurns: number;
    pinFirstTurn: boolean;
    pinUserChars: number;
    /** Target for one sealed entry's text; a span of many short turns may exceed it. */
    entryMaxChars: number;
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
 * Deterministic entry text: drop tool lines first, then shrink excerpts until it fits.
 * `maxChars` is a target: the smallest level is returned as is when even it does not fit.
 */
export declare function renderCheckpoint(session: Session, run: readonly Node[], toolNames: Map<string, string>, pinUserChars: number, maxChars: number): string;
/**
 * Decide the whole seal before any append. Returns an empty plan when every
 * completed turn beyond the keep window is already sealed.
 *
 * The seal lands after every existing entry, so the prefix before it is
 * byte-identical to the previous request. There is no request budget and no
 * refusal: this policy bounds the view by construction (one entry per completed
 * turn, tool results folded within the open turn), and the only hard limit is
 * the model's own context window, which belongs to the host. A budget that
 * refused instead — and poisoned every later turn of the session — arrived with
 * the 2026-09-08 refactor and is gone again.
 */
export declare function planSeal(session: Session, pending: readonly Message[], policy: HistoryPolicy, warn?: Warn): ArchivePlan;
export declare function applySeal(session: Session, plan: ArchivePlan): void;
/** Plan and apply in one call; the decision is complete before the first append. */
export declare function sealCompletedTurns(session: Session, pending: readonly Message[], policy: HistoryPolicy, warn?: Warn): ArchivePlan;
/**
 * Size of the request this step will build: the current surface plus the
 * messages pre-step's decision is about to append. The loop derives its
 * messages before agent/request runs, so pre-step is the last point at which
 * the session may still be edited.
 */
export declare function requestChars(session: Session, incoming?: readonly Message[]): number;
export {};
