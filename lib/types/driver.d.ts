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
import { type ReasoningEffortDefault } from './effort-default.js';
import { type SealPolicy } from './slice/step-tape.js';
import { type DigestPolicy } from './slice/result-digest.js';
import type { SliceContributor } from './index.js';
import type { ReplyCaps } from './slice/tape.js';
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
            sealedThrough?: number;
            stepTapeDigest?: string;
        };
        'slice/step-budget': {
            turn: number;
            step: number;
            budget: number;
        };
        /** 轮内封存审计(step-tape.ts):本步请求前折叠了哪些步、轨迹体量前后。 */
        'slice/step-seal': {
            turn: number;
            step: number;
            sealedThrough: number;
            sealedSteps: number;
            entries: number;
            trajectoryCharsBefore: number;
            trajectoryCharsAfter: number;
        };
        /** 世界状态循环审计。 */
        'slice/state-seed': {
            turn: number;
            step: number;
            seedDigest: string;
            files: number;
            facts: number;
            pinned: number;
            rules: number;
        };
        'slice/state-rules': {
            turn: number;
            step: number;
            rules: number;
            enforced: number;
            list?: string[];
            raw?: string;
            error?: string;
        };
        'slice/side-call': {
            turn: number;
            step: number;
            label: string;
            usage?: unknown;
        };
        'slice/read-pointer': {
            turn: number;
            step: number;
            path: string;
        };
        'slice/contract-bounce': {
            turn: number;
            step: number;
            path: string;
            violations: string[];
        };
        'slice/contract-suspend': {
            turn: number;
            step: number;
            path: string;
            rules: string[];
        };
        'slice/digest': {
            turn: number;
            step: number;
            tool: string;
            charsBefore: number;
            charsAfter: number;
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
    /** 贡献登记簿（index.ts 持有同一个数组的引用，插件随时登记/注销）。 */
    contributors: readonly SliceContributor[];
    /** 无人显式选择时注入的 reasoningEffort 默认档；'inherit' 退出注入。 */
    defaultReasoningEffort: ReasoningEffortDefault;
    /** 轮内封存策略(step-tape.ts)。enabled=false 时轨迹行为与从前完全一致。 */
    inTurnSeal: SealPolicy;
    /** 'slice'(现状)、'state'(世界状态循环:每步重建种子)或 'stream'(v3 追加流:
     *  append-only + 注入时摘要 + 宪法追加 + 契约)。 */
    mode: 'slice' | 'state' | 'stream';
    state: StatePolicy;
    digest: DigestPolicy;
    /** 读过未改的文件在轮末锚定为 base(见 continuity.ts sealTurn)。 */
    readBases: ReadBasesPolicy;
    /** 磁带现行文件的整读 → 指回磁带的指针(默认开)。 */
    readPointer: boolean;
    /** 文件锚定方式:'auto' = patch/base 取短;'base' = 永远完整基线。 */
    anchorMode: 'auto' | 'base';
    /** auto 模式下同一文件累积到这么多 patch 就重落完整基线。 */
    rebaseAfterPatches: number;
    /** 回复截断上限。 */
    replyCaps: ReplyCaps;
    /** 本轮最后一次测试结果写进轮摘要。 */
    checkInDigest: boolean;
    collapseEdits: boolean;
    readBasesMinReads: number;
}
export interface ReadBasesPolicy {
    enabled: boolean;
    /** 超过此字符数的文件不锚定(磁带体量守卫)。 */
    maxChars: number;
}
/** 默认关:s2/s3 实测只在 anchor 'base' 下才划算(否则模型在脑中合成 patch,推理翻倍)。 */
export declare const DEFAULT_READ_BASES: ReadBasesPolicy;
/** 世界状态循环的策略(提案 2026-09-02)。 */
export interface StatePolicy {
    /** 热窗:保留原文的最近步数。 */
    hotWindowSteps: number;
    /** 早期读取即宪法:前 N 步读取的文件全文钉进宪法。 */
    pinSteps: number;
    /** 相关性推送的最大条数(0 关闭)。 */
    pushHits: number;
    /** 钉住文件后是否用一次旁路模型调用提取可执行规则(契约)。 */
    extractRules: boolean;
    /** 旁路调用(规则提取)的 effort 档:提取是抄写型任务,默认关掉思考——首跑里
     *  一次提取思考了 8.9K token,占整轮成本 17%。'inherit' = 与主调用同档。 */
    sideEffort: ReasoningEffortDefault;
    /** 同一规则最多打回几次;再违反即该规则谓词停用、写入放行(见 enforceContract)。 */
    contractBounceBudget: number;
    /** stream 模式:一轮走到这一步(且钉住已完成)就提取规则、追加宪法。 */
    extractAtStep: number;
    /** stream 模式:契约从这一步起才执行(回滚 + 打回);短轮永远不被错谓词打回。 */
    enforceFromStep: number;
}
export declare const DEFAULT_STATE_POLICY: StatePolicy;
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
    private readonly defaultReasoningEffort;
    private readonly inTurnSeal;
    private readonly mode;
    private readonly readBases;
    private readonly readPointer;
    private readonly anchorMode;
    private readonly rebaseAfterPatches;
    private readonly replyCaps;
    private readonly checkInDigest;
    private readonly collapseEdits;
    private readonly readBasesMinReads;
    private readonly digestPolicy;
    private readonly statePolicy;
    /** 世界状态账本:跨轮持久(会话级),append-only。 */
    private readonly worldState;
    /** 本轮宪法;轮起始重置。 */
    private constitution;
    private rulesExtracted;
    /** 契约执行的写前磁盘快照(每步重置)。 */
    private preWrite;
    private contractBounces;
    /** 每条规则的打回次数(弹回预算)。 */
    private readonly ruleBounces;
    private currentSystemPrefix;
    /** 与 turnTrajectory 平行:每条消息所属的步号(封存按步切)。 */
    private turnTrajectorySteps;
    /** 本轮已封存的步条目(append-only)与其渲染消息;sealedThrough = 已封存的最大步号。 */
    private stepTapeEntries;
    private stepTapeMessage;
    private sealedThrough;
    /** 已「评估过是否封存」的最大步号:含实际封存 + 因体量守卫跳过的。 */
    private sealConsideredThrough;
    private readonly contributors;
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
    /** 工具结果进轨迹前的整形:磁带现行文件的整读 → 指针;然后(若开)注入时摘要。 */
    private shapeForTrajectory;
    /**
     * 读取指针(2026-09-03):整读一个"磁带里已有且与盘态同 hash"的文件时,结果换成一句指回
     * 磁带的话——全文本来就在上下文里,重发它只是付一次未命中价加一步输出。全文仍进会话
     * 日志(recall_step 可取)。带 offset/limit 的部分读、不在磁带里或已变化的文件原样返回。
     */
    private pointerForTapeCurrentRead;
    /** 注入时摘要:工具结果的文本块折成紧凑视图;不折的原样返回同一消息对象。 */
    private digestForTrajectory;
    /** 宪法成形(钉住 + 规则提取)后作为一条用户消息追加进流——只追加一次,永不重建。 */
    private appendConstitutionIfReady;
    /**
     * 世界状态循环的请求组装(每步):
     *   [runtime-context?][宪法 + 账本 + 相关推送](单条 user 种子) + 最近 K 步原文
     * 宪法在轮内逐字不变(规则提取只发生一次);账本 append-only;推送与热窗每步变。
     */
    private assembleStateRequest;
    /** 旁路模型调用(不带工具、不标 agent-loop、不入会话轨迹):规则提取用。 */
    private sideCompletion;
    /** 相关性推送:按当前请求 + 最近工具调用参数检索会话日志,推热窗之外的相关片段。 */
    private renderRelevancePush;
    /** 契约执行:写类工具成功后按宪法谓词校验磁盘内容;违反则回滚并改写结果为错误。 */
    private enforceContract;
    /** 账本更新(宿主确定性提取)+ 早期读取即宪法。 */
    private observeToolForState;
    /** 模型提议的事实:助手正文里 `decision:` / `obligation:` / `fact:` 开头的行。出处 = 该消息摘要。 */
    private harvestProposedFacts;
    /**
     * 轮内封存:请求组装前,若轨迹越过阈值,把最旧的一批已完成步折成封存条目
     * (step-tape.ts),从轨迹里移除其原文,并重建封存块消息。条目 append-only;
     * 封存点只前进。原文仍在会话日志,recall_step 可逐字取回。
     */
    private maybeSealSteps;
    /** Append a model-ordered result linked to its call event. */
    private appendToolResult;
    /** Append the durable call/result pair for a model call skipped after cancellation. */
    private appendSkippedToolCall;
}
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
/** read 工具的目标路径(tool-fs `read` / `read_file`)。 */
export declare function readToolPath(name: string, args: unknown): string | undefined;
export declare function editedPath(name: string, args: unknown): string | undefined;
