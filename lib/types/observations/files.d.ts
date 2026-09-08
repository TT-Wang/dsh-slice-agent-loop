import type { RecordedEvent, RecordedFileObservation } from '../state/events.js';
interface Call {
    name: string;
    arguments: unknown;
    callId: string;
    rootCallId: string;
    nested: boolean;
}
/** Full-looking windows still omit trailing-newline identity and can truncate individual lines. */
export declare function observationFromToolResult(call: Call, result: {
    isError?: unknown;
    meta?: unknown;
}, turn: number, eventSeq?: number): RecordedFileObservation | undefined;
/** Native calls and nested code dispatches share this deterministic extraction path. */
export declare function recordedFileObservations(events: Iterable<RecordedEvent>): RecordedFileObservation[];
export {};
