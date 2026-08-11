/**
 * SliceLoopAgent — the SliceAgent concrete agent driver for the DeepSeek Harness.
 *
 * The dsh `Agent` contract over the ported bounded-slice engine: claim input at
 * turn/step boundaries, assemble the bounded context via src/slice, stream one
 * model request through dsh-llm, and append the durable session events the
 * contract requires. Plan v2.1 phases 2–4 (driver core).
 *
 * Contract behavior mirrors the stock dsh-agent-loop driver:
 * turn/steps stay balanced (new turns open only from next-turn claims),
 * pre-step runs BEFORE step/start and a rejection closes the turn blocked,
 * claimed user input is appended as durable `user/message` surface events,
 * agent/error carries the verbatim thrown value, provider finish-errors route
 * through agent/request-error before any retry, turn-stopping steering stays
 * in the same turn, the whole request lifetime runs inside the agent's
 * initiator scope, whenIdle follows replacement work started at the retiring
 * idle edge, the active abort signal reaches every model request, scoped
 * system sections and registered tool schemas ride the request and its
 * canonical epoch header (deduplicated across same-turn steps), turn
 * numbering recovers from a seeded session, maintenance-task rejection stays
 * with its caller (agent quiescence still fulfills), and model tool calls
 * execute through the dsh-tools scheduler with durable tool/call +
 * tool/result pairing — parallel-safe bodies overlap up to the plugin-owned
 * maxParallelToolCalls cap before a continuation step replays derived history
 * for exact callId pairing.
 *
 * Plan gates honored here: wake-after-abort reroute is owned by the inbox
 * ledger; status flips only on real transitions; a rejected step's claimed
 * batch is gone (never re-queued); cancel is first-cause-wins and never arms
 * future work when idle; agent/request-error fires BEFORE any retry.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentCancelCause, AgentOptions, AgentStatus, CancelOptions } from '@deepseek-ai/dsh-agent';
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm';
import type { Scope } from '@deepseek-ai/dsh-scope';
import type { Session, SessionId } from '@deepseek-ai/dsh-session';
/**
 * The slice driver's plugin-owned durable events.
 *
 * `slice/file-anchor` — one successful edit's redacted post-state, appended by
 * the turn-end seal so agent recreation can rebuild the tape's file anchors from
 * the log alone (never an inferred disk re-anchor).
 *
 * `slice/request-slice` — the audit record for one model request: the digest of
 * the bounded slice actually sent, plus how many messages rode with it. This
 * loop cannot satisfy DSH's `model-visible ⟺ logged` invariant by construction
 * (it sends a REBUILT slice, not `deriveMessages()`), so it logs what it did
 * send instead. `dsh-slice-agent-loop/invariant` checks the weaker property that
 * IS true: every request's seed matches the digest recorded for it (评审 D).
 */
declare module '@deepseek-ai/dsh-session' {
    interface SessionEventMap {
        'slice/file-anchor': {
            turn: number;
            path: string;
            body: string;
        };
        'slice/request-slice': {
            turn: number;
            step: number;
            seedDigest: string;
            messageCount: number;
        };
        'slice/step-budget': {
            turn: number;
            step: number;
            budget: number;
        };
    }
    interface TurnEndReasonMap {
        'step-budget': {
            kind: 'step-budget';
        };
    }
}
/** Full-width digest for the request audit trail (`_h` truncates to 12 for tape locators). */
export declare function sliceDigest(text: string): string;
/** The text a request's slice seed carries, or '' when the request has no seed. */
export declare function seedTextOf(messages: readonly Message[]): string;
/** Plugin-owned scheduler settings, validated by SliceLoopPlugin before construction. */
export interface SliceLoopDriverConfig {
    /** Maximum in-flight parallel-safe tool calls per step. */
    maxParallelToolCalls: number;
    /** Hard ceiling on continuation steps in one turn. A bound, not a diagnosis. */
    maxStepsPerTurn: number;
}
export declare class SliceLoopAgent implements Agent {
    readonly id: SessionId;
    readonly options: AgentOptions;
    readonly session: Session;
    readonly ctx: Context;
    readonly scope: Scope;
    private readonly loopCtx;
    private readonly dispatch;
    private readonly ledger;
    private readonly maxParallelToolCalls;
    private readonly maxStepsPerTurn;
    private phase;
    private activityDone;
    private requestHeaderLogged;
    /** 跨轮携带态（continuity.ts：对话环 + SESSION TAPE + 文件锚点）。 */
    private readonly cont;
    /** 轮内轨迹（sliceagent 轮内原生累积语义）：首轮种子 + 本轮助手/工具消息。 */
    private turnSeedUser?;
    private turnTrajectory;
    /** 动态运行时上下文投影（stock agent-loop 同构）：快照变化才落 durable 消息。 */
    private readonly runtimeContext;
    constructor(loopCtx: Context, id: SessionId, options: AgentOptions, session: Session, config: SliceLoopDriverConfig);
    /**
     * Replay the durable log into the carried continuity state with the SAME
     * grouping as live execution: only each turn's first-step (next-turn
     * boundary) input batch joins the conversation ring, merged into one row;
     * same-turn steering (later steps) never becomes a new row. Each turn that
     * recorded input is re-sealed at its turn/end under the SAME deterministic
     * turn ID live used (`slice-turn-N` — turn numbers are unique within a
     * session log), with that turn's durable `slice/file-anchor` post-states
     * restored as its pending edits, so the resumed agent's SESSION TAPE
     * reproduces the live tape: digests, file anchors, and replies with
     * identical sealed identity. Turns with no recorded input (rejected/empty)
     * seal nothing. Runtime-context snapshots are re-projected live, never
     * replayed.
     */
    private restoreContinuity;
    /**
     * The driver's incremental ordered surface fold: seqs of the live surface
     * nodes in surface order. Replacement spans are POSITIONAL — a compacted
     * summary can sit before nodes with larger seqs — so shadow membership is
     * resolved against this fold, never by numeric seq comparison.
     */
    private readonly surfaceFold;
    /** Replacement-node/current text per owned fold node. */
    private readonly nodeText;
    /** Fold node → the continuity components (turn + user/assistant side) it currently owns. */
    private readonly nodeOwner;
    /** Per-turn latest assistant-owner seq (fillAssistant semantics: latest assistant message wins). */
    private readonly assistantOwnerByTurn;
    /**
     * Fold one surface event. A replacement transfers component ownership from
     * the shadowed nodes to itself, swaps the positional span in the fold, and
     * recomputes each affected component from fold-ordered owners — so partial,
     * nested, and role-changing spans all rewrite exactly what they shadow, and
     * nodes that never fed the continuity row (runtime-context snapshots,
     * same-turn steering, tool results) own nothing and rewrite nothing.
     */
    private foldSurfaceEvent;
    /** The current text of one continuity component: fold-ordered join over its owner nodes. */
    private componentText;
    /** Transfer a turn's assistant-component ownership to its latest assistant message. */
    private ownAssistant;
    get status(): AgentStatus;
    get inbox(): import("@deepseek-ai/dsh-agent").Inbox;
    send(message: UserMessage, target: 'next-turn' | 'next-step', wakeup: boolean): void;
    followup(message: UserMessage): void;
    steer(message: UserMessage): void;
    inject(message: UserMessage): void;
    /**
     * Start one driver, or latch the wake behind active work.
     *
     * Non-idle phases latch instead of dropping (stock semantics): maintenance
     * always latches, and a running turn latches a wake that arrived during its
     * cancel-convergence window. A `disposed` cancel never latches — teardown
     * must not wait on a model turn.
     */
    wakeDriver(wakeAfterAbort?: boolean): void;
    cancel(cause: AgentCancelCause, options?: CancelOptions): void;
    /** Settles only when no activity remains, following replacement work started at a retiring idle edge. */
    whenIdle(): Promise<void>;
    /**
     * Run one maintenance task behind the idle boundary. A task rejection stays
     * with the caller; agent quiescence observed via whenIdle still fulfills.
     */
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
    private setPhase;
    /** Report one failure at its live boundary with the verbatim thrown value, then rethrow. */
    private throwError;
    private kick;
    /** Claim the boundary's batch, assemble the scoped prompt, then run pre-step before any durable step opens. */
    private preStep;
    /** Open one turn before claiming its first proposed step; returns true when queued work owns a later turn. */
    private turn;
    /**
     * Execute one model request and the tool calls it asks for.
     * Returns null when tool results require a continuation step in this turn.
     */
    private step;
    /**
     * Execute one step's tool calls through the dsh-tools scheduler, mirroring
     * the stock driver's scheduler: exclusive calls form barriers, parallel-safe
     * calls overlap in a bounded rolling pool (the plugin-owned
     * maxParallelToolCalls cap), results and result contexts commit in model
     * order, and abort stops replenishment, drains started calls, and records
     * synthetic error results for skipped calls so replay stays valid.
     */
    private executeToolCalls;
    /** Run one exclusive barrier or parallel pool; results commit in model order. */
    private runToolGroup;
    /** Append a started call and return its provenance sequence. */
    private appendToolCall;
    /** 会话工作目录（session.header.cwd 为权威，同 WP6 教训）。 */
    private sessionCwd;
    /**
     * OPEN FILES locator index（seed.py:190-233 的 MVP 移植）：每个驻留文件一行
     * path · 行数 · 当前盘态 sha256(12) · 精确 read 调用。hash 落在脱敏字节上
     * （HASH SEAM：与 tape 锚定同一 redactText(codeFile) 域，否则永不命中）。
     * 盘态缺失/不可读只发布状态行，绝不把 seal 时的陈旧字节冒充为当前盘态。
     */
    private openFilesIndex;
    /** Append a model-ordered result linked to its call event. */
    private appendToolResult;
    /** Append the durable call/result pair for a model call skipped after cancellation. */
    private appendSkippedToolCall;
}
/**
 * 本步切片可用的字符预算，或 null（窗口未知时不施加约束，行为同修复前）。
 *
 * 从模型窗口出发，扣掉 system prefix 与工具 schema 的实际字符，再乘安全系数
 * 给轮内轨迹和模型输出留位置。粗估即可——它的作用是给 ElasticityController
 * 一个上界去做 locator 降级，而不是精确配额（评审 E）。
 */
export declare function sliceCapacityChars(contextWindow: number | undefined, systemPrefix: string, tools: readonly unknown[]): number | null;
/**
 * 编辑族工具，seal 时锚定文件后态。**必须匹配宿主真实注册的工具名**：DSH 0810
 * 的 tool-fs 注册 `write`/`edit`（参数键 file_path），str_replace_editor 注册
 * `str_replace_editor`（参数键 path，且仅 create/str_replace/insert 才写盘——view
 * 是只读，绝不锚定）。sliceagent 原生命名一并保留，供 golden/Python parity 与测试
 * fixture 使用。tests/driver-contract.spec.ts 的接线门断言本集合与 dsh-tool-fs
 * 真实注册名有交集——名字漂移会大声失败，不再静默地让 tape 恒空（评审 A）。
 */
export declare const EDIT_TOOL_NAMES: Set<string>;
/**
 * 一次成功工具执行写入的文件路径，若该工具不是编辑族或本次未写盘则返回 undefined。
 * str_replace_editor 额外按 command 门控，避免把 view（只读）也锚进 tape。
 *
 * 参数来自 `ToolExecution.arguments`——registry 已解析好的值，不是 JSON 串。
 * 宽容处理 unknown：模型可以发任何东西，非对象一律当作"没有路径"。
 */
export declare function editedPath(name: string, args: unknown): string | undefined;
