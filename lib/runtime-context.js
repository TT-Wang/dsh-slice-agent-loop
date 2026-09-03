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
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session';
const SOURCE = '@deepseek-ai/dsh-system-prompt';
const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.';
/** Whether a user-surface message is a runtime-context snapshot owned by dsh-system-prompt. */
export function isRuntimeContextMessage(message) {
    return message.source.kind === 'plugin' && message.source.plugin === SOURCE;
}
function isOwned(message) {
    return isRuntimeContextMessage(message);
}
function textOf(message) {
    const [block] = message.content;
    return message.content.length === 1 && block?.type === 'text' ? block.text : undefined;
}
/** Tracks the last retained runtime-context snapshot without owning its commit. */
export class RuntimeContextProjection {
    /** `undefined` means no snapshot ever existed; `null` means none is retained. */
    retained;
    /**
     * Restore projection state once, then follow authoritative session events.
     * @param ctx - agent-scoped event context.
     * @param session - session receiving projected messages.
     */
    constructor(ctx, session) {
        const surface = new Set(session.surface.nodes);
        for (let index = session.snapshotEvents().length - 1; index >= 0; index -= 1) {
            const event = session.snapshotEvents()[index];
            if (event?.type !== 'user/message' || !isOwned(event.data)) {
                continue;
            }
            this.retained ??= null;
            if (surface.has(event.seq)) {
                this.retained = { seq: event.seq, text: textOf(event.data) };
                break;
            }
        }
        ctx.on('session/event', (subject, event) => {
            if (subject !== session)
                return;
            if (event.type === 'user/message' && isOwned(event.data)) {
                this.retained = { seq: event.seq, text: textOf(event.data) };
            }
            else if (this.retained
                && isReplacementSurfaceEvent(event)
                && event.sourceEventSeqs?.includes(this.retained.seq) === true) {
                this.retained = null;
            }
        });
    }
    /**
     * Create an uncommitted snapshot only when the retained value differs.
     * @param current - fully rendered dynamic context.
     * @param sections - named contributions that formed the current snapshot.
     * @returns a candidate user message, or `undefined` when no update is needed.
     */
    project(current, sections) {
        if (this.retained === undefined && current.length === 0)
            return;
        const snapshot = current.length === 0 ? CLEARED : current;
        if (this.retained?.text === snapshot)
            return;
        return createUserMessage({
            content: [{ type: 'text', text: snapshot }],
            // The cleared marker has no contributions left to attribute.
            source: sections.length === 0
                ? { kind: 'plugin', plugin: SOURCE }
                : { kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections },
        });
    }
}
