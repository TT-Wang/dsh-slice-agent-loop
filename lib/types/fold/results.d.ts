import { type SessionEvent } from '@deepseek-ai/dsh-session';
export type ResultLocator = {
    seq: number;
} | {
    turn: number;
    step: number;
    call: number;
};
/** The ordinal counts original result events, never replacement copies or sibling blocks. */
export declare function fullResultAt(events: readonly SessionEvent[], turn: number, step: number, call: number, block?: number): {
    name: string;
    text: string;
} | null;
/** A replacement locator resolves to its durable original tool/result. */
export declare function originalResultAt(events: readonly SessionEvent[], seq: number): SessionEvent<'tool/result'>;
export declare function resultBySeq(events: readonly SessionEvent[], seq: number, block?: number): {
    name: string;
    text: string;
    seq: number;
    turn: number;
    step: number;
    call: number;
};
/** A durable spill preview names the stored bytes on its first line. */
export declare function spillLocatorOf(text: string): {
    bytes: number;
    locator: string;
} | undefined;
export declare function storedTextLocatorOf(logged: string): {
    locator: string;
    bytes?: number;
} | undefined;
export declare function originalText(logged: string, where: string): Promise<string>;
/** Hydrate each original text part before joining siblings or parts. A spill
 * preview identifies only its own part, never the text that follows it. */
export declare function originalResultText(events: readonly SessionEvent[], locator: ResultLocator, where: string, block?: number): Promise<string>;
