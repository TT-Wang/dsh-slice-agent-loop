import { recordedFileObservations } from '../observations/files.js';
/** Display-path hints only: neither alias equivalence nor world identity is inferred. */
export function fileObservationsByPath(events) {
    const paths = new Map();
    for (const observation of recordedFileObservations(events))
        paths.set(observation.address.path, observation);
    return paths;
}
