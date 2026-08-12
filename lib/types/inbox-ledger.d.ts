/**
 * Driver adapter around dsh's durable Inbox projection.
 *
 * Plan v2.1, phase 2: the dsh Inbox remains the single owner of replay,
 * normalized durable splices, pending-message identity, and claim deletion.
 * This adapter owns only the loop-facing routing and wakeup rules.
 */
import type { AgentEventDispatch, Inbox, InboxTarget } from '@deepseek-ai/dsh-agent';
import type { Session, UserMessage } from '@deepseek-ai/dsh-session';
/** Driver state needed to route waking input without coupling to its phase type. */
export interface InboxLedgerActivity {
    /** Active activity signal, or undefined while the driver is truly idle. */
    signal(): AbortSignal | undefined;
    /**
     * Reserve or wake the driver after a durable insertion commits.
     *
     * `wakeAfterAbort` reports that this waking message arrived while the active
     * signal was ALREADY aborted — i.e. during a cancel's convergence window. The
     * classification is computed before the durable insert (a re-entrant cancel
     * inside a splice observer must not reclassify it) and passed through so the
     * driver can latch the wake and replay it at the idle edge instead of
     * stranding the message in the inbox (DSH 0810 cancel-convergence latch).
     */
    wake(wakeAfterAbort: boolean): void;
}
/**
 * Exact dsh inbox semantics for a SliceAgent-backed driver.
 *
 * The public {@link inbox} is the dsh-owned projection required by the Agent
 * interface. Claims are permanent pure deletions: a later pre-step rejection
 * must not requeue or discard them.
 */
export declare class InboxLedger {
    private readonly activity;
    readonly inbox: Inbox;
    constructor(session: Session, dispatch: AgentEventDispatch, activity: InboxLedgerActivity);
    /** Whether any turn or step input remains pending. */
    get hasPending(): boolean;
    /**
     * Durably insert one message, then optionally wake the driver.
     *
     * A waking message cannot join an activity whose signal is already aborted;
     * it is rerouted to the next-turn list. A non-waking injection retains its
     * requested next-step target even during cancellation.
     */
    send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;
    /** Queue one ordinary prompt as its own turn and wake the driver. */
    followup(message: UserMessage): void;
    /** Queue steering for the nearest eligible step and wake the driver. */
    steer(message: UserMessage): void;
    /** Queue step context without waking an idle driver. */
    inject(message: UserMessage): void;
    /**
     * Claim a turn's first batch: all next-step input, then exactly one
     * next-turn message. The durable mutations are pure deletions.
     */
    claimFirstStep(turn: number): UserMessage[];
    /** Claim all next-step input at a later boundary without consuming a turn. */
    claimNextStep(turn: number): UserMessage[];
    /** Durably cancel every still-pending item. Already claimed input is absent. */
    clear(): void;
}
