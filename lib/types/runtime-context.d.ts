/**
 * Durable projection state for dynamic runtime context.
 *
 * Byte-faithful port of the stock dsh-agent-loop RuntimeContextProjection:
 * tracks the last retained `@deepseek-ai/dsh-system-prompt` snapshot from the
 * durable log, projects a new snapshot message only on change, and emits the
 * cleared marker when every contribution vanishes. The driver commits the
 * projected message through its normal user/message path, so the snapshot is
 * both durable and model-visible.
 */
import type { ContextSnapshotSection } from '@deepseek-ai/dsh-llm';
import type { Session, UserMessage } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
/** Whether a user-surface message is a runtime-context snapshot owned by dsh-system-prompt. */
export declare function isRuntimeContextMessage(message: UserMessage): boolean;
/** Tracks the last retained runtime-context snapshot without owning its commit. */
export declare class RuntimeContextProjection {
    /** `undefined` means no snapshot ever existed; `null` means none is retained. */
    private retained;
    /**
     * Restore projection state once, then follow authoritative session events.
     * @param ctx - agent-scoped event context.
     * @param session - session receiving projected messages.
     */
    constructor(ctx: Context, session: Session);
    /**
     * Create an uncommitted snapshot only when the retained value differs.
     * @param current - fully rendered dynamic context.
     * @param sections - named contributions that formed the current snapshot.
     * @returns a candidate user message, or `undefined` when no update is needed.
     */
    project(current: string, sections: readonly ContextSnapshotSection[]): UserMessage | undefined;
}
