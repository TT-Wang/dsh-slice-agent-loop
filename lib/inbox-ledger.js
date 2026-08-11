/**
 * Driver adapter around dsh's durable Inbox projection.
 *
 * Plan v2.1, phase 2: the dsh Inbox remains the single owner of replay,
 * normalized durable splices, pending-message identity, and claim deletion.
 * This adapter owns only the loop-facing routing and wakeup rules.
 */
import { Inbox } from '@deepseek-ai/dsh-agent';
/**
 * Exact dsh inbox semantics for a SliceAgent-backed driver.
 *
 * The public {@link inbox} is the dsh-owned projection required by the Agent
 * interface. Claims are permanent pure deletions: a later pre-step rejection
 * must not requeue or discard them.
 */
export class InboxLedger {
    activity;
    inbox;
    constructor(session, dispatch, activity) {
        this.activity = activity;
        this.inbox = new Inbox(session, {
            inserted: message => { dispatch.emit('agent/inbox/inserted', { message }); },
            discarded: message => { dispatch.emit('agent/inbox/discarded', { message }); },
            claimed: (message, turn) => { dispatch.emit('agent/inbox/claimed', { message, turn }); },
        });
    }
    /** Whether any turn or step input remains pending. */
    get hasPending() {
        return this.inbox.hasPending;
    }
    /**
     * Durably insert one message, then optionally wake the driver.
     *
     * A waking message cannot join an activity whose signal is already aborted;
     * it is rerouted to the next-turn list. A non-waking injection retains its
     * requested next-step target even during cancellation.
     */
    send(message, target, wakeup) {
        const signal = wakeup ? this.activity.signal() : undefined;
        // Classify BEFORE the durable insert: a splice observer may re-enter cancel
        // and abort the signal, which would otherwise reclassify this message.
        const wakeAfterAbort = signal?.aborted === true;
        const resolvedTarget = wakeAfterAbort ? 'next-turn' : target;
        this.inbox.append(resolvedTarget, message);
        if (wakeup)
            this.activity.wake(wakeAfterAbort);
    }
    /** Queue one ordinary prompt as its own turn and wake the driver. */
    followup(message) {
        this.send(message, 'next-turn', true);
    }
    /** Queue steering for the nearest eligible step and wake the driver. */
    steer(message) {
        this.send(message, 'next-step', true);
    }
    /** Queue step context without waking an idle driver. */
    inject(message) {
        this.send(message, 'next-step', false);
    }
    /**
     * Claim a turn's first batch: all next-step input, then exactly one
     * next-turn message. The durable mutations are pure deletions.
     */
    claimFirstStep(turn) {
        return this.inbox.claim('next-turn', turn);
    }
    /** Claim all next-step input at a later boundary without consuming a turn. */
    claimNextStep(turn) {
        return this.inbox.claim('next-step', turn);
    }
    /** Durably cancel every still-pending item. Already claimed input is absent. */
    clear() {
        this.inbox.clear();
    }
}
