import type { RecordedEvent, RecordedFileObservation } from './events.js';
/** Display-path hints only: neither alias equivalence nor world identity is inferred. */
export declare function fileObservationsByPath(events: Iterable<RecordedEvent>): Map<string, RecordedFileObservation>;
