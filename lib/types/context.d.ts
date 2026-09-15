/**
 * Append-only session tape on the stock ordered surface.
 *
 * Every completed turn beyond `keepRecentTurns` is sealed into one frozen
 * `[slice tape v1 …]` entry at that turn's own position, at the first step of
 * the next turn (protected nodes can split one turn into multiple entries).
 * An entry is rendered once from logged evidence and NEVER re-rendered or
 * nested. Sealing only touches the unsealed tail after
 * existing entries. It preserves that established message prefix; it does not
 * guarantee provider cache hits or an append-only relationship between every
 * request. The rewritten suffix can include previously shown tool messages and
 * recent turns kept raw by the policy.
 *
 * That is the one property this module exists to protect. The alternative it
 * replaced — leave history raw, then collapse the OLDEST turns under pressure —
 * kept more verbatim text but rewrote the prefix at its first replaced message.
 * The current policy trades some recent detail for a stable older tape prefix.
 *
 * Superseded runtime-context snapshots are absorbed only while they remain in
 * the unsealed tail. Snapshots ahead of an existing entry keep their position:
 * the host's newest projection already declares earlier snapshots obsolete.
 * Existing entries, including snapshot-only entries from older builds, freeze
 * the whole prefix through their position and are never rewritten here.
 */
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
/** Enough space for the range header and an intact recall command. */
export declare const MIN_ENTRY_MAX_CHARS = 256;
export interface HistoryPolicy {
    /** Completed turns kept raw at the tail; 0 seals a turn as soon as the next one starts. */
    keepRecentTurns: number;
    pinFirstTurn: boolean;
    pinUserChars: number;
    /** Hard character limit for one new sealed entry; at least MIN_ENTRY_MAX_CHARS. */
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
    /** Lazily measured serialized final view (history + pending messages) after the plan. */
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
    /** Turn range the node belongs to (a checkpoint spans several turns). */
    turns: [number, number];
    protected: boolean;
    /** A superseded runtime snapshot still in the unsealed tail. Render only as a note. */
    superseded: boolean;
    /** Turns recall_turn attributes the snapshot(s) to (userMessageTurn), 0 for none. */
    recallTurns: number[];
}
/** One line for every superseded runtime snapshot of a turn; the text stays on its recall page. */
export declare function snapshotNote(recallTurns: readonly number[]): string;
/**
 * Deterministic entry text: drop tool lines first, then shrink indexes and
 * excerpts. A very large backlog falls back to a complete range/recall marker;
 * never cut JSON locators or rewrite a previously sealed entry to make it fit.
 */
export declare function renderCheckpoint(session: Session, run: readonly Node[], toolNames: Map<string, string>, pinUserChars: number, maxChars: number): string;
/**
 * Decide the whole seal before any append. Returns an empty plan when every
 * completed turn beyond the keep window is already sealed.
 *
 * The seal lands after every existing entry, so the prefix before it is
 * byte-identical to the previous request. There is no request budget and no
 * refusal: entries accumulate with completed turns, and the only hard limit is
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
