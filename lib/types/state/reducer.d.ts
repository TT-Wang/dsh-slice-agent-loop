import type { Session } from '@deepseek-ai/dsh-session';
import { sealTurn } from '../continuity.js';
import type { Continuity } from '../continuity.js';
import type { RecordedEvent } from './events.js';
export type ContinuityPolicy = Omit<Parameters<typeof sealTurn>[1], 'turnId' | 'status' | 'userRequest' | 'assistantReply' | 'sessionId'> & {
    /** Retained for configuration compatibility; alpha.2 metadata cannot establish exact bases. */
    readBases?: {
        enabled: boolean;
        maxChars: number;
    };
    reasoningTape?: boolean;
};
/**
 * The sole continuity replay path. The live provider runs the same reducer over
 * its durable snapshot. Generated replacements are not additional conversation
 * facts. Tool metadata contributes historical read/touch hints, never file bases:
 * it contains neither opaque FsTarget identity nor a provably complete body.
 */
export declare function reduceContinuityEvents(input: Iterable<RecordedEvent>, sessionId: string, policy?: ContinuityPolicy): Continuity;
export declare function buildContinuity(session: Pick<Session, 'id' | 'snapshotEvents'>, policy?: ContinuityPolicy): Continuity;
