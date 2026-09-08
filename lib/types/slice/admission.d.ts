/**
 * Admission selects a bounded request view; it never compacts durable history.
 * A caller may authorize omission only when an existing recall tool serves the
 * entry's recorded content. File paths alone are not recall sources.
 */
import { TapeEntry } from './tape.js';
export type TapeRecallSource = {
    readonly kind: 'turn';
    readonly turn: number;
} | {
    readonly kind: 'step';
    readonly turn: number;
    readonly step: number;
};
export interface TapeAdmissionOptions {
    /** Unicode code points in tapeRender(entries), including omission markers. */
    maxTapeChars: number;
    /**
     * Return a locator only after verifying that its durable recall page includes
     * this entry's content. No locator is inferred from a digest or file path.
     * This callback is read once per entry, and only on overflow.
     */
    recallForEntry?: (entry: TapeEntry, index: number) => TapeRecallSource | undefined;
}
export interface OmittedTapeEntry {
    /** Index in the original, unmodified tape passed to admitTape. */
    readonly index: number;
    readonly entry: TapeEntry;
    readonly reason: 'superseded-file-history' | 'oldest-group';
    readonly source: TapeRecallSource;
}
export type TapeAdmission = {
    readonly ok: true;
    readonly entries: readonly TapeEntry[];
    readonly omitted: readonly OmittedTapeEntry[];
    readonly renderedChars: number;
} | {
    readonly ok: false;
    readonly reason: 'unrecoverable-history' | 'budget-too-small';
    readonly maxTapeChars: number;
    /** Size of the smallest safe view found by the deterministic policy. */
    readonly requiredChars: number;
    readonly unrecoverableIndexes: readonly number[];
};
/**
 * Keep the original tape byte-for-byte when it fits. On overflow, omit obsolete
 * file history first, then oldest complete groups. A file's surviving base and
 * all later patches form one indivisible group; remaining non-file entries are
 * grouped by digest boundary. Every omission needs an explicit durable source.
 *
 * The bound applies to rendered tape only, not the assembled request or tokens.
 */
export declare function admitTape(tape: readonly TapeEntry[], options: TapeAdmissionOptions): TapeAdmission;
