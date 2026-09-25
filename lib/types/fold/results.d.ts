import { type SessionEvent } from '@deepseek-ai/dsh-session';
export type ResultLocator = {
    seq: number;
} | {
    turn: number;
    step: number;
    call: number;
};
/** The ordinal counts original result events (one per call in V4), never replacement copies. */
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
type StoredLocator = {
    locator: string;
    bytes?: number;
};
/** One text part of a logged result, and the stored original it previews, if any. */
export type LoggedTextPart = {
    text: string;
    preview?: StoredLocator;
};
/**
 * The text parts of one logged result content. Native spill-policy stores the
 * whole formatted content (every text part in order, images as descriptors)
 * and ends the retained [head, image…, tail] copy with its notice, so that
 * notice on the last text part previews all of them: they form one preview
 * part. A fold spill preview identifies only its own part.
 */
export declare function loggedTextParts(content: ReadonlyArray<{
    type: string;
    text?: unknown;
}>): LoggedTextPart[];
export declare function originalText(logged: string, where: string): Promise<string>;
/** The stored original of one logged text part, or its own text when it previews nothing. */
export declare function originalPartText(part: LoggedTextPart, where: string): Promise<string>;
/** Hydrate each original text part before joining the parts; see {@link loggedTextParts}. */
export declare function originalResultText(events: readonly SessionEvent[], locator: ResultLocator, where: string, block?: number): Promise<string>;
export {};
