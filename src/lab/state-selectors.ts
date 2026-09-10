// offline/experimental — not on the runtime path. Nothing under src/lab is reachable
// from the published entry points (src/index.ts, src/fold/index.ts, src/invariant.ts);
// tsconfig.json excludes this directory, so it never reaches lib/ or the package.
import { recordedFileObservations } from '../observations/files.js'
import type { RecordedEvent, RecordedFileObservation } from '../state/events.js'

/** Display-path hints only: neither alias equivalence nor world identity is inferred. */
export function fileObservationsByPath(events: Iterable<RecordedEvent>): Map<string, RecordedFileObservation> {
  const paths = new Map<string, RecordedFileObservation>()
  for (const observation of recordedFileObservations(events)) paths.set(observation.address.path, observation)
  return paths
}
