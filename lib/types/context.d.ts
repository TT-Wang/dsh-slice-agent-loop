/** Durable conversational replacement on the stock ordered surface. */
import { type Message } from '@deepseek-ai/dsh-llm';
import { type Session } from '@deepseek-ai/dsh-session';
export declare const HISTORY_SOURCE = "slice:history";
export declare const HISTORY_HEADER = "# SESSION TAPE (sealed conversational history; not current-world truth)\n";
export declare class SliceBudgetError extends Error {
    constructor(message: string);
}
/** Build a request view without reading files or changing the current turn. */
export declare function compactHistory(session: Session, maxHistoryChars: number): void;
/** Serialized message bound, deliberately distinct from tokenizer/model capacity. */
export declare function assertRequestBudget(messages: readonly Message[], maxRequestChars: number): void;
