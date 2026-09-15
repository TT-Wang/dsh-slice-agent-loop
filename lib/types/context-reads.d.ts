import { type Session, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session';
export interface ReadRef {
    key: string;
    target: string;
    window: string;
    tool: string;
    turn: number;
    step: number;
    seq: SessionSeq;
    /** One-based original result block, absent for log-only code dispatches. */
    block?: number;
    rootCallId?: string;
    digest: string;
    lines: number;
}
export interface ReadHistory {
    reads: ReadRef[];
    /** Same representative as the visible index: last successful read per window and turn. */
    prior: Map<string, ReadRef[]>;
    /** Original outer result seq → its own blocks and enclosed code reads. */
    results: Map<SessionSeq, ReadRef[]>;
}
/** Errors never enter the successful index or comparison history. A successful
 * retry replaces earlier success for that window; a later error does not. */
export declare function readHistory(session: Session): ReadHistory;
/** A code dispatch is log-only. Associate it with its enclosing outer result,
 * but never imply that returning a value to code exposed those bytes to the model. */
export declare function readsForResult(history: ReadHistory, event: SessionEvent<'tool/result'>): ReadRef[];
export declare function readIndexLine(reads: readonly ReadRef[], turn: number, history: ReadHistory, maxChars?: number): string;
