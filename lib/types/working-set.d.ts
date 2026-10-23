/**
 * Working-set retention for the session tape (opt-in: `history.workingSet`).
 *
 * When a completed turn seals, the steps that make up the model's current view
 * of each file it is working on stay raw at their own positions instead of
 * entering the entry: the step with the file's latest full view in that turn (a
 * complete `read`, or a `write`, whose arguments are the content) and every later
 * step of the turn that changed the file (`edit`, `write`, a recognised shell
 * write, a code-dispatched write/edit). A turn that changes a file without
 * viewing it again extends the file's raw view from an earlier turn, if that view
 * and every change since are still raw. "Working on" means changed by the model
 * in the sealed turn or in the `turns` turns before it. A file that is only read
 * seals as before; so does an earlier view of a file the same turn viewed again
 * (superseded), and every other step.
 *
 * The unit kept is a whole step, the assistant message that issued the calls
 * plus every result answering them, because a tool call cannot be shown without
 * its results: sibling results of a kept step stay raw too, and count toward the
 * per-turn `maxChars` cap. A step whose other results outweigh its working-set
 * content (beyond SIBLING_ALLOWANCE) is not kept: a small file read beside a
 * large log must not carry the log along. A file's steps are kept all or
 * nothing, files changed in more turns of the window first, then the most
 * recently touched; a file whose steps do not fit, or are no longer intact on the
 * surface (another producer replaced them), is sealed as today. A later view of a
 * file never retires an earlier kept one: that would rewrite a carried prefix.
 *
 * Cache safety: a kept step is protected exactly like a human message, so it
 * cuts the entry instead of being rewritten. The decision for turn N is a pure
 * function of the log through turn N and of which of those steps are still raw
 * on the surface, so every later seal makes the same decision for it: kept nodes
 * are never sealed later, sealed nodes are never thawed, and the prefix through
 * the last entry stays frozen as before.
 */
import type { Message } from '@deepseek-ai/dsh-llm';
import { type Session, type SessionEvent, type SessionSeq } from '@deepseek-ai/dsh-session';
export interface WorkingSetPolicy {
    /** Completed turns before the sealed one whose changes still put a file in the working set. */
    turns: number;
    /** Cap on the characters (visible text, reasoning, call arguments, result text) kept raw per sealed turn. */
    maxChars: number;
}
/**
 * K = 2 covers the usual pause in work on a file: an edit, then a turn that only
 * tests or reviews it, or one that asks a question, before the next edit. A
 * longer window keeps re-reads of files the model stopped changing. 48,000
 * characters (about 14K tokens at the ~3.4 characters per input token measured
 * on the 2026-10-23 logs, reasoning included) holds a full read of a ~500-line
 * source file plus a turn's edits to it: replaying the 2026-10-23 coding task
 * (lh1, 8 turns), the edited file's steps fit in 7 of 8 turns; the eighth
 * carried 27K characters of reasoning in one edit step.
 */
export declare const DEFAULT_WORKING_SET: Readonly<WorkingSetPolicy>;
/** What a sealed turn's entry says about the steps it left raw. */
export interface WorkingSetNote {
    /** Step numbers of the kept steps, ascending. */
    steps: number[];
    /** Files whose view the kept steps hold, in the order they were chosen. */
    files: string[];
}
export interface KeptSteps {
    /** Surface nodes left raw: kept assistant messages and their results. */
    seqs: Set<SessionSeq>;
    /** Turns with kept steps; only turns still being sealed render their note. */
    notes: Map<number, WorkingSetNote>;
}
export interface SurfaceNode {
    seq: SessionSeq;
    event: SessionEvent;
    message: Message | null;
}
/**
 * Characters of results outside the working set a kept step may carry beyond its own working-set
 * content: a README read beside the source file is fine, a 13K-character log beside a short notes
 * file is not (the 2026-10-23 flood session read one blob and its digest file in parallel each turn).
 */
export declare const SIBLING_ALLOWANCE = 4000;
/**
 * Decide which surface nodes of turns before `before` (the turns this seal may
 * seal, all completed) stay raw. `nodes` is the current surface in order; only
 * assistant messages and tool results are ever kept.
 */
export declare function keepWorkingSet(session: Session, nodes: readonly SurfaceNode[], before: number, policy: WorkingSetPolicy): KeptSteps;
/** Entry line for a turn that left steps raw. Labels drop the files' shared directory; locators are not needed, the steps are on the surface. */
export declare function workingSetNote(note: WorkingSetNote): string;
