/** Durable conversational replacement on the stock ordered surface. */
import { type Message } from '@deepseek-ai/dsh-llm';
import { type Session } from '@deepseek-ai/dsh-session';
export declare const HISTORY_SOURCE = "slice:history";
export declare const HISTORY_HEADER = "# SESSION TAPE (sealed conversational history; not current-world truth)\n";
/** The host's runtime-context projection (dsh-agent-loop RuntimeContextProjection). */
export declare const RUNTIME_CONTEXT_SOURCE = "@deepseek-ai/dsh-system-prompt";
export declare class SliceBudgetError extends Error {
    constructor(message: string);
}
/** True for a message the host's runtime-context projection just produced. */
export declare function isRuntimeSnapshot(message: Message): boolean;
/**
 * Build a request view without reading files or changing the current turn.
 *
 * `runtimeSuperseded` says a freshly projected runtime-context snapshot is
 * about to be appended, so the one still on the surface is already dead. Left
 * protected it would double the cost of a large runtime context in every
 * request. Shadowing it is safe even if this step never dispatches: the host's
 * RuntimeContextProjection drops its retained node when a replacement event
 * names it (dsh-agent-loop RuntimeContextProjection constructor), and reprojects
 * on the next pre-step.
 */
export declare function compactHistory(session: Session, maxHistoryChars: number, warn?: (message: string) => void, runtimeSuperseded?: boolean): void;
/** Serialized message bound, deliberately distinct from tokenizer/model capacity. */
export declare function assertRequestBudget(messages: readonly Message[], maxRequestChars: number): void;
/**
 * Size of the request this step will build: the current surface plus the
 * messages the loop is about to append. The loop derives its messages before
 * the agent/request waterfall runs (dsh-agent-loop step() passes
 * session.deriveMessages() into buildRequest), so pre-step is the last point
 * at which the session may still be edited -- and `incoming` is exactly what
 * pre-step's decision will append, so this is a measurement, not an estimate.
 */
export declare function requestChars(session: Session, incoming?: readonly Message[]): number;
/**
 * Give history budget back until the serialized request fits maxRequestChars.
 *
 * compactHistory spends the whole fixed maxHistoryChars regardless of the
 * request bound, so a session can die on maxRequestChars while the plugin is
 * still holding history it is free to trim -- a permanent refusal (every later
 * turn throws identically, with no dispatch, until the session is abandoned)
 * in exchange for history nobody asked it to keep. Each pass re-plans from the
 * same originals rather than trimming an already-trimmed view, so shrinking is
 * not cumulative loss. When even the bounded markers do not fit, compactHistory
 * refuses atomically and assertRequestBudget reports the real overflow: at that
 * point the protected floor alone is over budget and no history remains to give.
 */
export declare function fitRequestBudget(session: Session, incoming: readonly Message[], maxHistoryChars: number, maxRequestChars: number, warn?: (message: string) => void, runtimeSuperseded?: boolean): void;
