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
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath, dirname } from 'node:path';
import { harnessUniverse } from './universe.js';
import { BlockAssembler, createAssistantMessage, createToolResultMessage, createUserMessage, errorChain, } from '@deepseek-ai/dsh-llm';
// rc8: assertNever/deepFreeze 从 dsh-llm 迁至独立的 util 包(运行时已不再从
// dsh-llm 导出——CJS 拿到 undefined,调用即炸)。
import { assertNever, deepFreeze } from '@deepseek-ai/dsh-util-values';
import { canonicalHeader, headerEquals, isReplacementSurfaceEvent, isSurfaceEvent } from '@deepseek-ai/dsh-session';
import { renderPrompt, joinContextSections, renderContextSections } from '@deepseek-ai/dsh-system-prompt';
import { TOOL_ABORTED_BEFORE_DISPATCH, } from '@deepseek-ai/dsh-tools';
import { InboxLedger } from './inbox-ledger.js';
import { recordSeedEvent, recordCallEvent } from './call-ledger.js';
import { applyEffortDefault } from './effort-default.js';
import { renderSealedStep, renderStepTape, sealSavesEnough, stepsToSeal } from './slice/step-tape.js';
import { addFact, checkPredicates, createLedger, parseRulesJson, recordFile, renderConstitution, renderLedger, rulesExtractionPrompt, } from './slice/state-ledger.js';
import { searchSessionEvents } from './recall.js';
import { digestToolResult } from './slice/result-digest.js';
import { writeFileSync as fsWriteFileSync, unlinkSync as fsUnlinkSync, mkdirSync as fsMkdirSync } from 'node:fs';
import { RuntimeContextProjection, isRuntimeContextMessage } from './runtime-context.js';
import { assembleSlice } from './slice/assemble.js';
import { pySplitlines } from './slice/internal/pytext.js';
import { redactText } from './slice/internal/safety.js';
import { _h } from './slice/tape.js';
import { compactTurn, compactTurnSpan, createContinuity, fillAssistant, recordUser, sealTurn, trackEdit, trackRead, trackReasoning, trackToolOutcome, } from './continuity.js';
/** Full-width digest for the request audit trail (`_h` truncates to 12 for tape locators). */
export function sliceDigest(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}
/** The text a request's slice seed carries, or '' when the request has no seed. */
export function seedTextOf(messages) {
    const seed = messages[0];
    if (seed === undefined || seed.role !== 'user')
        return '';
    return seed.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
}
/** 默认关:s2/s3 实测只在 anchor 'base' 下才划算(否则模型在脑中合成 patch,推理翻倍)。 */
export const DEFAULT_READ_BASES = { enabled: false, maxChars: 40_000 };
export const DEFAULT_STATE_POLICY = { hotWindowSteps: 3, pinSteps: 2, pushHits: 3, extractRules: true, sideEffort: 'off', contractBounceBudget: 1, extractAtStep: 3, enforceFromStep: 8 };
/** 单条插件贡献的字符上限。超出即截断并留标记 —— 与 tape 截 ask/reply 同一哲学。 */
const CONTRIBUTION_CAP_CHARS = 4000;
/** 全体贡献者的收集时限。慢的当没说话，绝不拖垮轮次。 */
const CONTRIBUTION_TIMEOUT_MS = 5000;
/**
 * 每轮向登记簿收贡献。四条防线：报错=空串、超时=空串、超长截断留标记、
 * 空串不出场。排序按声明的 order（缺省 50），同序按名字 —— 稳定可复现。
 */
async function collectContributions(contributors, facts) {
    if (contributors.length === 0)
        return [];
    const timeout = new Promise((resolve) => setTimeout(() => resolve(''), CONTRIBUTION_TIMEOUT_MS));
    const settled = await Promise.all(contributors.map(async (c) => {
        let text = '';
        try {
            text = await Promise.race([Promise.resolve(c.render(facts)), timeout]);
        }
        catch { /* 失败即沉默（SEAMS S1 Failure）。 */ }
        if (typeof text !== 'string')
            text = '';
        if (text.length > CONTRIBUTION_CAP_CHARS) {
            text = text.slice(0, CONTRIBUTION_CAP_CHARS) + ` …[+${text.length - CONTRIBUTION_CAP_CHARS} chars truncated by the loop]`;
        }
        return { name: c.name, order: c.order ?? 50, text };
    }));
    return settled
        .filter((c) => c.text.trim() !== '')
        .sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map(({ name, text }) => ({ name, text }));
}
export class SliceLoopAgent {
    id;
    options;
    session;
    ctx;
    scope;
    loopCtx;
    dispatch;
    ledger;
    maxParallelToolCalls;
    maxStepsPerTurn;
    defaultReasoningEffort;
    inTurnSeal;
    mode;
    readBases;
    readPointer;
    anchorMode;
    digestPolicy;
    statePolicy;
    /** 世界状态账本:跨轮持久(会话级),append-only。 */
    worldState = createLedger();
    /** 本轮宪法;轮起始重置。 */
    constitution = null;
    rulesExtracted = false;
    /** 契约执行的写前磁盘快照(每步重置)。 */
    preWrite = new Map();
    contractBounces = 0;
    /** 每条规则的打回次数(弹回预算)。 */
    ruleBounces = new Map();
    currentSystemPrefix = '';
    /** 与 turnTrajectory 平行:每条消息所属的步号(封存按步切)。 */
    turnTrajectorySteps = [];
    /** 本轮已封存的步条目(append-only)与其渲染消息;sealedThrough = 已封存的最大步号。 */
    stepTapeEntries = [];
    stepTapeMessage;
    sealedThrough = 0;
    /** 已「评估过是否封存」的最大步号:含实际封存 + 因体量守卫跳过的。 */
    sealConsideredThrough = 0;
    contributors;
    phase;
    activityDone = Promise.resolve();
    requestHeaderLogged = false;
    /** 跨轮携带态（continuity.ts：对话环 + SESSION TAPE + 文件锚点）。 */
    cont = createContinuity();
    /** 轮内轨迹（sliceagent 轮内原生累积语义）：首轮种子 + 本轮助手/工具消息。 */
    turnSeedUser;
    turnTrajectory = [];
    /** 动态运行时上下文投影（stock agent-loop 同构）：快照变化才落 durable 消息。 */
    runtimeContext;
    constructor(loopCtx, id, options, session, config) {
        this.loopCtx = loopCtx;
        this.id = id;
        this.options = options;
        this.session = session;
        this.maxParallelToolCalls = config.maxParallelToolCalls;
        this.maxStepsPerTurn = config.maxStepsPerTurn;
        this.contributors = config.contributors;
        this.defaultReasoningEffort = config.defaultReasoningEffort;
        this.inTurnSeal = config.inTurnSeal;
        this.mode = config.mode;
        this.statePolicy = config.state;
        this.digestPolicy = config.digest;
        this.readBases = config.readBases;
        this.readPointer = config.readPointer;
        this.anchorMode = config.anchorMode;
        this.scope = harnessUniverse().scope.createScope(loopCtx, this);
        this.ctx = this.scope.ctx.extend({ agent: this });
        this.dispatch = harnessUniverse().agent.agentEvents(this.ctx, this);
        this.ledger = new InboxLedger(session, this.dispatch, {
            signal: () => (this.phase.kind === 'idle' ? undefined : this.phase.abort.signal),
            // 必须透传 wakeAfterAbort：丢掉它 latch 永不武装（取消收敛期的消息被吞）。
            wake: (wakeAfterAbort) => this.wakeDriver(wakeAfterAbort),
        });
        this.runtimeContext = new RuntimeContextProjection(this.ctx, session);
        // 文件锚定挂在 EXECUTION 平面，不是呈现平面。
        //
        // `tools/result` 在 scheduler 的 finish 阶段发出，而顶层调度
        // (agent-loop tool-calls.ts) 与 Code Mode 的 run_code 桥
        // (tools/src/code-mode.ts) 调用的是**同一个** scheduler.finish——所以这一个
        // seam 同时覆盖两个平面，`exec.name` 永远是真实执行的工具名。
        //
        // 之前锚定挂在顶层 tool/result 的 `block.name` 上，那是模型看见的名字：
        // Code Mode 下 `wireSchemas` 把工具面收敛成 `[run_code]`，真实的 write/edit
        // 变成 run_code 程序里的子调用，顶层永远看不到 ⇒ tape 恒空、OPEN FILES 恒空、
        // 护城河静默失效。用执行平面的事实就不需要任何 Code Mode 感知。
        //
        // 事件是 emit 语义（观察者抛错只 warn，不会打死 turn），且按 exec.agent 做
        // scope 过滤，别的 agent 的执行不会串到这里。
        this.ctx.on('tools/result', (exec, result) => {
            if (result.isError)
                return;
            const path = editedPath(exec.name, exec.arguments);
            if (path !== undefined) {
                const disk = readDiskStatus(this.sessionCwd(), path);
                if (disk.kind === 'ok')
                    trackEdit(this.cont, path, disk.body);
                return;
            }
            // 读过的文件:盘态快照进 pendingReads,轮末锚定为 base(readBases 策略)。
            const rp = readToolPath(exec.name, exec.arguments);
            if (rp !== undefined && this.readBases.enabled && this.mode !== 'state') {
                const disk = readDiskStatus(this.sessionCwd(), rp);
                if (disk.kind === 'ok' && disk.body.length <= this.readBases.maxChars)
                    trackRead(this.cont, rp, disk.body);
            }
        });
        // The driver keeps its own incremental ordered surface fold: canonical
        // replacements compact their positional span the moment they commit —
        // live and rebuilt agents agree, and surface order (not seq order) rules.
        this.ctx.on('session/event', (subject, event) => {
            if (subject !== session || !isSurfaceEvent(event))
                return;
            this.foldSurfaceEvent(event);
        });
        // Agent recreation/resume: rebuild the bounded conversation ring from the
        // seeded log so the prior exchanges reach the next slice (the tape itself
        // is not yet durable — documented parity gap).
        this.restoreContinuity(session);
        // Resume: turn numbering continues from the seeded session's last turn.
        let lastTurn = 0;
        for (let index = session.snapshotEvents().length - 1; index >= 0; index -= 1) {
            const event = session.snapshotEvents()[index];
            if (event.type === 'turn/start') {
                lastTurn = event.data.turn;
                break;
            }
        }
        this.phase = { kind: 'idle', lastTurn };
    }
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
    restoreContinuity(session) {
        let step = 0;
        let openTurn = null;
        let pendingFirstStep = [];
        let pendingAnchors = [];
        let recordedThisTurn = false;
        const flushFirstStep = () => {
            const text = pendingFirstStep.filter(Boolean).join('\n');
            pendingFirstStep = [];
            if (!text)
                return;
            if (!this.cont.goal) {
                this.cont.goal = text;
                if (openTurn !== null)
                    this.cont.goalTurn = openTurn;
            }
            recordUser(this.cont, text, openTurn ?? undefined);
            recordedThisTurn = true;
        };
        for (const event of session.snapshotEvents()) {
            if (event.type === 'turn/start') {
                openTurn = event.data.turn;
            }
            else if (event.type === 'step/start') {
                flushFirstStep();
                step = event.data.step;
            }
            else if (event.type === 'user/message') {
                // Canonical surface replacement: rewrite the shadowed component(s) to
                // the replacement text instead of replaying the shadowed originals.
                if (isReplacementSurfaceEvent(event)) {
                    this.foldSurfaceEvent(event);
                    continue;
                }
                if (isSurfaceEvent(event))
                    this.foldSurfaceEvent(event);
                if (step !== 1 || isRuntimeContextMessage(event.data))
                    continue;
                const text = blockText(event.data);
                if (text && openTurn !== null) {
                    pendingFirstStep.push(text);
                    // Ownership mirrors the ring rule: only step-1 non-runtime input.
                    this.nodeText.set(event.seq, text);
                    this.nodeOwner.set(event.seq, [{ turn: openTurn, component: 'user' }]);
                }
            }
            else if (event.type === 'assistant/message') {
                // Assistant replacements, like user replacements, are handled once by
                // the surface fold — never promoted through the ordinary reducer.
                if (isReplacementSurfaceEvent(event)) {
                    this.foldSurfaceEvent(event);
                    continue;
                }
                if (isSurfaceEvent(event))
                    this.foldSurfaceEvent(event);
                flushFirstStep();
                const text = event.data.message.content
                    .filter((block) => block.type === 'text')
                    .map((block) => block.text).join('');
                fillAssistant(this.cont, text);
                if (process.env.SLICE_REASONING_TAPE === '1')
                    trackReasoning(this.cont, reasoningText(event.data.message));
                this.ownAssistant(event.data.turn, event.seq, text);
            }
            else if (event.type === 'tool/result') {
                if (isSurfaceEvent(event))
                    this.foldSurfaceEvent(event);
                // 未解决错误的重放：和实时路径同一个结算规则（最后一个结果说了算），
                // 否则重建出来的 CURRENT ERROR 会和活会话不一致。
                const block = event.data.message.content[0];
                trackToolOutcome(this.cont, block?.isError === true, toolResultText(event.data.message));
            }
            else if (event.type === 'slice/file-anchor') {
                // 插件拥有的轮界完整性（核心 invariant 把插件事件关系委托给所属插件）：
                // 锚点只在它声明的轮仍处于开轮状态时被接受——轮外孤儿或轮号不符的
                // 事件绝不并入后续封存。
                if (openTurn !== null && event.data.turn === openTurn) {
                    pendingAnchors.push({ path: event.data.path, body: event.data.body });
                }
            }
            else if (event.type === 'turn/end') {
                flushFirstStep();
                if (recordedThisTurn) {
                    this.cont.pendingEdits = pendingAnchors;
                    const last = this.cont.conversation[this.cont.conversation.length - 1];
                    sealTurn(this.cont, {
                        turnId: `slice-turn-${event.data.turn}`,
                        status: event.data.reason.kind,
                        userRequest: last?.user ?? '',
                        assistantReply: last?.assistant ?? '',
                        sessionId: this.session.id,
                        anchorMode: this.anchorMode,
                    });
                }
                pendingAnchors = [];
                recordedThisTurn = false;
                openTurn = null;
                step = 0;
            }
        }
        flushFirstStep();
    }
    /**
     * The driver's incremental ordered surface fold: seqs of the live surface
     * nodes in surface order. Replacement spans are POSITIONAL — a compacted
     * summary can sit before nodes with larger seqs — so shadow membership is
     * resolved against this fold, never by numeric seq comparison.
     */
    surfaceFold = [];
    /** Replacement-node/current text per owned fold node. */
    nodeText = new Map();
    /** Fold node → the continuity components (turn + user/assistant side) it currently owns. */
    nodeOwner = new Map();
    /** Per-turn latest assistant-owner seq (fillAssistant semantics: latest assistant message wins). */
    assistantOwnerByTurn = new Map();
    /**
     * Fold one surface event. A replacement transfers component ownership from
     * the shadowed nodes to itself, swaps the positional span in the fold, and
     * recomputes each affected component from fold-ordered owners — so partial,
     * nested, and role-changing spans all rewrite exactly what they shadow, and
     * nodes that never fed the continuity row (runtime-context snapshots,
     * same-turn steering, tool results) own nothing and rewrite nothing.
     */
    foldSurfaceEvent(event) {
        if (isReplacementSurfaceEvent(event)) {
            const text = event.type === 'user/message'
                ? blockText(event.data)
                : event.type === 'assistant/message'
                    ? event.data.message.content
                        .filter((block) => block.type === 'text')
                        .map((block) => block.text).join('')
                    : '';
            const startIndex = this.surfaceFold.indexOf(event.surfaceOp.start);
            const endIndex = this.surfaceFold.indexOf(event.surfaceOp.end);
            if (startIndex !== -1 && endIndex !== -1) {
                const lo = Math.min(startIndex, endIndex);
                const hi = Math.max(startIndex, endIndex);
                const owners = new Map();
                const spanSeqs = this.surfaceFold.slice(lo, hi + 1);
                for (const seq of spanSeqs) {
                    const owned = this.nodeOwner.get(seq);
                    if (owned !== undefined) {
                        for (const o of owned)
                            owners.set(`${o.turn}:${o.component}`, o);
                    }
                    this.nodeOwner.delete(seq);
                    this.nodeText.delete(seq);
                }
                if (owners.size > 0) {
                    this.nodeOwner.set(event.seq, [...owners.values()]);
                    this.nodeText.set(event.seq, text);
                    // Keep each turn's latest-assistant cursor on the live owner: when a
                    // replacement inherits the current owner, the cursor moves to the
                    // replacement; a replacement that inherited nothing moves nothing.
                    for (const o of owners.values()) {
                        if (o.component === 'assistant'
                            && spanSeqs.includes(this.assistantOwnerByTurn.get(o.turn) ?? -1)) {
                            this.assistantOwnerByTurn.set(o.turn, event.seq);
                        }
                    }
                }
                this.surfaceFold.splice(lo, hi - lo + 1, event.seq);
                // 一次替换遮蔽多轮时整体塌缩成一条区间条目：逐轮重渲会把同一段摘要
                // 复制 2N 份，把本该缩小上下文的 compaction 变成放大器（评审 #17）。
                const shadowedTurns = [...new Set([...owners.values()].map((o) => o.turn))];
                if (shadowedTurns.length > 1) {
                    compactTurnSpan(this.cont, shadowedTurns, text, this.session.id);
                }
                else {
                    for (const o of owners.values()) {
                        const recomputed = this.componentText(o.turn, o.component);
                        compactTurn(this.cont, o.turn, o.component === 'user' ? { user: recomputed } : { assistant: recomputed }, this.session.id);
                    }
                }
                return;
            }
            // Endpoints not on the fold: nothing shadowed; treat as an append.
            this.surfaceFold.push(event.seq);
            return;
        }
        this.surfaceFold.push(event.seq);
    }
    /** The current text of one continuity component: fold-ordered join over its owner nodes. */
    componentText(turn, component) {
        const parts = [];
        for (const seq of this.surfaceFold) {
            const owned = this.nodeOwner.get(seq);
            if (owned?.some((o) => o.turn === turn && o.component === component)) {
                const text = this.nodeText.get(seq);
                if (text)
                    parts.push(text);
            }
        }
        return parts.join('\n');
    }
    /** Transfer a turn's assistant-component ownership to its latest assistant message. */
    ownAssistant(turn, seq, text) {
        const previous = this.assistantOwnerByTurn.get(turn);
        if (previous !== undefined) {
            this.nodeOwner.delete(previous);
            this.nodeText.delete(previous);
        }
        this.nodeOwner.set(seq, [{ turn, component: 'assistant' }]);
        this.nodeText.set(seq, text);
        this.assistantOwnerByTurn.set(turn, seq);
    }
    get status() {
        return this.phase.kind === 'running' ? 'running' : 'idle';
    }
    get inbox() {
        return this.ledger.inbox;
    }
    // ------------------------------------------------------------------ input
    send(message, target, wakeup) {
        this.ledger.send(message, target, wakeup);
    }
    followup(message) {
        this.ledger.followup(message);
    }
    steer(message) {
        this.ledger.steer(message);
    }
    inject(message) {
        this.ledger.inject(message);
    }
    /**
     * Start one driver, or latch the wake behind active work.
     *
     * Non-idle phases latch instead of dropping (stock semantics): maintenance
     * always latches, and a running turn latches a wake that arrived during its
     * cancel-convergence window. A `disposed` cancel never latches — teardown
     * must not wait on a model turn.
     */
    wakeDriver(wakeAfterAbort = false) {
        const phase = this.phase;
        if (phase.kind !== 'idle') {
            const reason = phase.abort.signal.reason;
            const disposing = phase.abort.signal.aborted && reason?.kind === 'disposed';
            if (!disposing && (phase.kind === 'maintenance' || wakeAfterAbort)) {
                phase.wakeRequested = true;
            }
            return;
        }
        let resolveDriver;
        let rejectDriver;
        this.activityDone = new Promise((resolve, reject) => {
            resolveDriver = resolve;
            rejectDriver = reject;
        });
        this.setPhase({ kind: 'running', abort: new AbortController(), turn: phase.lastTurn, step: 0, wakeRequested: false });
        // The complete request lifetime runs inside this agent's initiator scope.
        void this.loopCtx.agents.withInitiator(this, () => this.kick())
            .then(resolveDriver, rejectDriver);
    }
    // ---------------------------------------------------------------- control
    cancel(cause, options = {}) {
        if (!options.keepInbox) {
            this.ledger.clear();
            // Clearing the queue also clears any latch it armed — in BOTH phases.
            if (this.phase.kind !== 'idle')
                this.phase.wakeRequested = false;
        }
        if (this.phase.kind !== 'idle')
            this.phase.abort.abort(cause);
    }
    /** Settles only when no activity remains, following replacement work started at a retiring idle edge. */
    async whenIdle() {
        let activity;
        do {
            await (activity = this.activityDone);
        } while (activity !== this.activityDone);
    }
    /**
     * Run one maintenance task behind the idle boundary. A task rejection stays
     * with the caller; agent quiescence observed via whenIdle still fulfills.
     */
    runMaintenance(task) {
        if (this.phase.kind !== 'idle') {
            throw new Error(`agent "${this.id}" already has active work`);
        }
        let resolveDone;
        const done = new Promise((resolve) => { resolveDone = resolve; });
        const maintenance = {
            kind: 'maintenance',
            abort: new AbortController(),
            lastTurn: this.phase.lastTurn,
            wakeRequested: false,
        };
        this.setPhase(maintenance);
        this.activityDone = done;
        return (async () => {
            try {
                return await task(maintenance.abort.signal);
            }
            finally {
                this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn });
                // `hasPending` mirrors stock: a latch whose message was removed
                // meanwhile must not open an empty durable turn (评审 #13/#15/#24).
                if (maintenance.wakeRequested && this.ledger.hasPending)
                    this.wakeDriver();
                resolveDone();
            }
        })();
    }
    // ------------------------------------------------------------------ turns
    setPhase(next) {
        const before = this.status;
        this.phase = next;
        if (before !== this.status) {
            this.dispatch.emit('agent/status', { status: this.status });
        }
    }
    /** Report one failure at its live boundary with the verbatim thrown value, then rethrow. */
    throwError(error) {
        const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn;
        const step = this.phase.kind === 'running' ? this.phase.step : 0;
        this.dispatch.emit('agent/error', { turn, step, error });
        throw error;
    }
    async kick() {
        let latched = false;
        try {
            while (await this.turn()) { /* queued followups close as distinct balanced turns */ }
        }
        catch {
            // Reported failures and cancellation are contained at the driver boundary.
        }
        finally {
            if (this.phase.kind === 'running') {
                latched = this.phase.wakeRequested;
                this.setPhase({ kind: 'idle', lastTurn: this.phase.turn });
            }
        }
        // Cancel-convergence replay (DSH 0810): a wake latched while this turn was
        // unwinding starts the next driver now. `hasPending` suppresses the replay
        // when the latched message was removed meanwhile — a latch must never open
        // an empty durable turn.
        if (latched && this.ledger.hasPending)
            this.wakeDriver();
    }
    /** Claim the boundary's batch, assemble the scoped prompt, then run pre-step before any durable step opens. */
    async preStep(target, position) {
        if (this.phase.kind !== 'running')
            throw new Error(`agent "${this.id}": pre-step outside running phase`);
        const signal = this.phase.abort.signal;
        const claimed = target === 'next-turn'
            ? this.ledger.claimFirstStep(position.turn)
            : this.ledger.claimNextStep(position.turn);
        const assembly = await this.loopCtx.systemPrompt.assemble(harnessUniverse().agent.assembleContextFor(this, signal));
        signal.throwIfAborted();
        // 动态运行时上下文投影（stock agent.ts:211 同构）：快照变化时作为
        // plugin/@deepseek-ai/dsh-system-prompt 的 durable 消息并入批。
        const sections = renderContextSections(assembly);
        const context = this.runtimeContext.project(joinContextSections(sections), sections);
        const decision = await this.dispatch.waterfall('agent/pre-step', { messages: claimed, ...position, signal }, async () => ({
            kind: 'enter',
            messages: context === undefined ? claimed : [...claimed, context],
        }));
        signal.throwIfAborted();
        return decision.kind === 'reject' ? decision : { ...decision, assembly };
    }
    /** Open one turn before claiming its first proposed step; returns true when queued work owns a later turn. */
    async turn() {
        if (this.phase.kind !== 'running') {
            this.throwError(new Error(`agent "${this.id}": turn without driver reservation`));
        }
        const phase = this.phase;
        const { signal } = phase.abort;
        signal.throwIfAborted();
        const turn = phase.turn + 1;
        try {
            this.session.append('turn/start', { turn });
        }
        catch (error) {
            this.throwError(error);
        }
        phase.turn = turn;
        this.turnSeedUser = undefined;
        this.turnTrajectory = [];
        this.turnTrajectorySteps = [];
        this.stepTapeEntries = [];
        this.stepTapeMessage = undefined;
        this.sealedThrough = 0;
        this.sealConsideredThrough = 0;
        this.constitution = null;
        this.rulesExtracted = false;
        let recordedThisTurn = false;
        let turnEnds = null;
        let target = 'next-turn';
        try {
            while (true) {
                signal.throwIfAborted();
                const step = phase.step + 1;
                const decision = await this.preStep(target, { turn, step });
                if (decision.kind === 'reject') {
                    // No durable step opens; the claimed batch is gone (never re-queued).
                    turnEnds = { kind: 'blocked' };
                    return false;
                }
                if (turnEnds && decision.messages.length === 0)
                    break;
                // An empty first batch still owns the turn boundary but spends no model call.
                if (phase.step === 0 && decision.messages.length === 0) {
                    turnEnds = { kind: 'completed' };
                    return false;
                }
                // record_user（continuity.ts）：首轮用户请求进对话环 + 话题 goal 落首条。
                // 运行时上下文快照不是用户请求——不进环、不落 goal（指令权级分离）。
                if (phase.step === 0 && target === 'next-turn' && decision.messages.length > 0) {
                    const text = decision.messages
                        .filter((m) => !isRuntimeContextMessage(m))
                        .map((m) => blockText(m)).filter(Boolean).join('\n');
                    if (text) {
                        if (!this.cont.goal) {
                            this.cont.goal = text;
                            this.cont.goalTurn = turn;
                        }
                        recordUser(this.cont, text, turn);
                        recordedThisTurn = true;
                    }
                }
                signal.throwIfAborted();
                this.session.append('step/start', { turn, step });
                phase.step = step;
                try {
                    // Component ownership mirrors the ring rule exactly: only the
                    // first-step (next-turn boundary) non-runtime batch owns the turn's
                    // user component; steering and runtime snapshots own nothing.
                    const ownsUserComponent = step === 1 && target === 'next-turn';
                    for (const message of decision.messages) {
                        const appended = this.session.append('user/message', message, { surfaceOp: 'append' });
                        if (ownsUserComponent && !isRuntimeContextMessage(message)) {
                            const text = blockText(message);
                            if (text) {
                                this.nodeText.set(appended.seq, text);
                                this.nodeOwner.set(appended.seq, [{ turn, component: 'user' }]);
                            }
                        }
                    }
                    const stepEnd = await this.step(decision.messages, decision.assembly);
                    // max-tokens is sticky: a later completed step must not downgrade it.
                    if (turnEnds === null || turnEnds.kind !== 'max-tokens')
                        turnEnds = stepEnd;
                }
                finally {
                    this.session.append('step/end', { turn, step });
                }
                signal.throwIfAborted();
                if (turnEnds && this.inbox.nextStep.length === 0) {
                    // turn-stopping: serial seam — a listener objects by steering new input,
                    // and that steering continues in the SAME turn as a later step.
                    await this.dispatch.serial('agent/turn-stopping', { turn, signal });
                    signal.throwIfAborted();
                }
                if (turnEnds && this.inbox.nextStep.length === 0)
                    break;
                // Trajectory bound. Reached only on a continuation (turnEnds === null,
                // or steering kept the turn open), so a turn that finishes on its own
                // never sees it. Deliberately does NOT run the `agent/turn-stopping`
                // seam above: that seam's contract is "object by steering, and the
                // steering continues in the SAME turn", which is the opposite of a
                // hard stop. Steering that arrives now stays in the inbox and is
                // claimed by the next turn — the same disposition as the error path.
                if (step >= this.maxStepsPerTurn) {
                    turnEnds = { kind: 'step-budget' };
                    this.session.append('slice/step-budget', { turn, step, budget: this.maxStepsPerTurn });
                    break;
                }
                target = 'next-step';
            }
        }
        catch (error) {
            if (signal.aborted) {
                turnEnds = { kind: 'aborted', reason: signal.reason };
                throw error;
            }
            // Every failure is structured: an LlmError keeps its facts, anything else
            // flattens to errorChain text under the UNKNOWN code.
            turnEnds = {
                kind: 'error',
                error: error instanceof harnessUniverse().llm.LlmError
                    ? error.failure
                    : { message: errorChain(error), code: 'UNKNOWN' },
            };
            this.throwError(error);
        }
        finally {
            // 轮末封存（continuity.ts sealTurn）：digest + 文件锚点 + 答复冻结进
            // SESSION TAPE + GC。只封存本轮真正记录了输入的轮：无 step 的被拒/空轮
            // 不把上一轮的陈旧答复再次冻结。锚定的后态作为 durable
            // `slice/file-anchor` 事件落账（在开轮内、turn/end 之前），重建据此恢复。
            if (recordedThisTurn) {
                try {
                    const last = this.cont.conversation[this.cont.conversation.length - 1];
                    const sealed = sealTurn(this.cont, {
                        // 确定性封存身份：轮号在会话日志内单调唯一，重建产出同一 ID——
                        // recall locator 永不指向伪造工件。
                        turnId: `slice-turn-${turn}`,
                        status: turnEnds?.kind ?? 'error',
                        userRequest: last?.user ?? '',
                        assistantReply: last?.assistant ?? '',
                        sessionId: this.session.id,
                        anchorMode: this.anchorMode,
                    });
                    for (const anchor of sealed.anchored) {
                        this.session.append('slice/file-anchor', { turn, path: anchor.path, body: anchor.body });
                    }
                }
                catch {
                    // 封存失败不反转已完成的轮（与 sidecar 同级容错）。
                }
            }
            try {
                this.session.append('turn/end', { turn, reason: turnEnds });
            }
            catch (error) {
                this.throwError(error);
            }
        }
        if (!this.inbox.hasPending)
            return false;
        // A later turn gets a fresh abort scope: a cancel that killed this turn must
        // not poison queued work, and an idle-edge wake must see an unaborted signal.
        // The stale convergence latch clears with it — this live driver claims the
        // queued work itself, so replaying at the idle edge would double-run it.
        phase.abort = new AbortController();
        phase.step = 0;
        phase.wakeRequested = false;
        return true;
    }
    /**
     * Execute one model request and the tool calls it asks for.
     * Returns null when tool results require a continuation step in this turn.
     */
    async step(claimed, assembly) {
        if (this.phase.kind !== 'running')
            throw new Error(`agent "${this.id}": step outside running phase`);
        const { turn, step, abort: { signal } } = this.phase;
        signal.throwIfAborted();
        // Assemble the bounded slice for this step. The byte-stable system prefix
        // is the 1.9k slice kernel registered as the `slice:kernel` prompt section
        // (cache-stable across turns), with any dsh-scoped sections after it; the
        // slice engine owns the volatile user-side context. 携带态（this.cont）经
        // 每轮重建——bounded slice ≠ 从零开始（continuity.ts）。
        // 指令权级：运行时上下文快照绝不进 CURRENT REQUEST 槽——请求文本只取真实
        // 输入，快照作为独立的低权级上下文块随种子消息发出（durable 落账不变）。
        const requestText = claimed
            .filter((m) => !isRuntimeContextMessage(m))
            .map((m) => blockText(m)).filter(Boolean).join('\n');
        const contextText = claimed
            .filter((m) => isRuntimeContextMessage(m))
            .map((m) => blockText(m)).filter(Boolean).join('\n\n');
        // The sliceagent kernel is a registered section ('slice:kernel', order
        // -1000, src/index.ts), so the registry's own render IS the full prefix —
        // byte-identical to the old manual `RESOLVED + '\n\n' + scoped` prepend in
        // the ordinary case (renderPrompt joins with '\n\n'), and correctly ABSENT
        // when a host section declares `complete: true` (new in 20260811) and
        // assembly restores it as the sole prompt. A driver-side prepend silently
        // voided that host guarantee.
        const systemPrefix = renderPrompt(assembly);
        this.currentSystemPrefix = systemPrefix;
        // OPEN FILES hash index（seed.py build_open_files_index 同构）：每个驻留文件
        // 一行 locator——path · 行数 · 当前盘态 sha256(12) · 精确 read 调用——模型据此
        // 做 tape-hash 信任检查（hash 匹配才从 tape 组装，否则重读）。
        const assembled = assembleSlice({
            request: requestText,
            goal: this.cont.goal,
            tape: this.cont.sessionTape,
            openFiles: this.openFilesIndex(),
            lastError: this.cont.lastError,
            contributions: await collectContributions(this.contributors, {
                request: requestText,
                turn: this.cont.turns,
                tapePaths: Object.keys(this.cont.tapeFiles).sort(),
                cwd: this.sessionCwd(),
            }),
        }, systemPrefix);
        const tools = assembly.tools;
        while (true) {
            // 冻结请求提案（stock requestProposal 同构）：首轮 = agent options（冻结）；
            // 之后 = 持久 epoch header 的 config 派生（去掉 adapterDefaults 标记键，
            // 冻结）——后续轮次的提案以日志为准，不再回退到启动选项。
            const baselineHeader = this.session.requestHeader();
            const seed = baselineHeader !== undefined
                ? deepFreeze(requestProposal(baselineHeader))
                : deepFreeze({
                    ...(this.options.provider !== undefined ? { provider: this.options.provider } : {}),
                    ...(this.options.model !== undefined ? { model: this.options.model } : {}),
                    ...(this.options.maxTokens !== undefined ? { maxTokens: this.options.maxTokens } : {}),
                });
            const proposed = await this.dispatch.waterfall('agent/request', { turn, step, signal }, async () => seed);
            signal.throwIfAborted();
            if (!proposed.provider || !proposed.model) {
                throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`);
            }
            let config;
            let preparedCall;
            try {
                preparedCall = await this.loopCtx.llm.prepareCall(proposed, signal);
                config = preparedCall.config;
                // Q4-b:effort 由适配器默认填充(adapterDefaults.reasoningEffort === true,
                // 即无人显式选择)时,尝试注入插件默认档。显式值恒不覆盖。适配器不声明
                // 该档(mock / 无 reasoning 能力的模型)→ UNSUPPORTED_REASONING_EFFORT →
                // 保留适配器默认。注入经 prepareCall 重新解析,header 如实记录生效值——
                // logged ⟺ sent 审计不变式不破。
                if (preparedCall.adapterDefaults.reasoningEffort === true) {
                    const injected = applyEffortDefault({ ...proposed, reasoningEffort: undefined }, this.defaultReasoningEffort);
                    if (injected.reasoningEffort !== undefined) {
                        try {
                            const retried = await this.loopCtx.llm.prepareCall(injected, signal);
                            preparedCall = retried;
                            config = retried.config;
                        }
                        catch (error) {
                            if (!(error instanceof harnessUniverse().llm.LlmError) || error.code !== 'UNSUPPORTED_REASONING_EFFORT')
                                throw error;
                        }
                    }
                }
            }
            catch (error) {
                // Middleware may serve an unregistered route; terminal dispatch still requires an adapter.
                if (!(error instanceof harnessUniverse().llm.LlmError) || error.code !== 'NO_ADAPTER')
                    throw error;
                config = proposed;
            }
            signal.throwIfAborted();
            // Canonical epoch header: appended on initial/resume/change only, so
            // identical same-turn requests share one durable epoch and context.
            const header = canonicalHeader({
                config,
                ...(preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults }),
                ...(assembled.system ? { system: assembled.system } : {}),
                ...(tools.length > 0 ? { tools } : {}),
            });
            const baseline = this.session.requestHeader();
            if (!this.requestHeaderLogged) {
                this.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' });
                this.requestHeaderLogged = true;
            }
            else if (baseline === undefined || !headerEquals(baseline, header)) {
                this.session.append('request/header', { header, reason: 'change' });
            }
            const contextWindow = preparedCall?.context?.contextWindow;
            const requestContext = {
                provider: config.provider,
                model: config.model,
                ...(contextWindow === undefined ? {} : { contextWindow }),
            };
            const previousContext = this.session.requestContext();
            if (previousContext?.provider !== requestContext.provider
                || previousContext.model !== requestContext.model
                || previousContext.contextWindow !== requestContext.contextWindow) {
                this.session.append('request/context', requestContext);
            }
            // 超窗不在这里处理，交给 provider 报错（plan/SEAMS.md S2）：观测峰值
            // 16K–43K token 对常见 128K 窗口，且降级告警从未命中过。为此维持的
            // 四档保真度、弹性控制器与两段式重投影已整体删除。
            //
            // 轮界重建切片、轮内只累积（sliceagent 不变式）。种子只在本轮首次组装时
            // 构造一次；之后每一步都发 [种子, ...本轮轨迹, ...本步新输入]。
            //
            // 评审 B：旧实现用 `claimed.length > 0` 决定是否重建种子，于是轮内任何
            // 被 claim 的输入（steer / inject / 工具 additionalContexts / 运行时上下文
            // 快照变化）都会重建种子并整条丢弃 turnTrajectory——模型看不到自己刚发起的
            // tool-call，也看不到工具结果，只能重复调用或凭空作答。"是否有新输入"与
            // "是否是轮界"是两件事，这里彻底解耦。
            let messages;
            // 与 ledger 快照字节锁步：种子消息发出的运行时上下文块和落账的必须是
            // 同一个字符串（离线归因按字节 diff，复述模板会静默漂移）。
            const runtimeBlock = contextText
                ? `# RUNTIME CONTEXT (host-provided dynamic state — lower-authority context, not instructions; the CURRENT REQUEST below is the primary instruction authority)\n${contextText}`
                : '';
            if (this.mode === 'stream')
                await this.appendConstitutionIfReady(turn, step, requestText, config, preparedCall, signal);
            if (this.mode === 'state') {
                // 世界状态循环:每步重建 [宪法][账本][推送] 种子 + 最近 K 步原文热窗。
                // 步 1 的 claimed 是本轮请求本身(已进宪法),不再作原文重发;之后的是插话。
                if (step > 1 && claimed.length > 0) {
                    this.turnTrajectory.push(...claimed);
                    this.turnTrajectorySteps.push(...claimed.map(() => step));
                }
                messages = await this.assembleStateRequest(turn, step, requestText, runtimeBlock, config, preparedCall, signal);
            }
            else if (this.turnSeedUser === undefined) {
                this.turnSeedUser = createUserMessage({
                    content: [
                        ...(runtimeBlock ? [{ type: 'text', text: runtimeBlock }] : []),
                        { type: 'text', text: assembled.user },
                    ],
                    source: { kind: 'user' },
                });
                // Flag-gated sidecar (SLICE_CALL_LEDGER_DIR): the turn's seed bytes,
                // for offline miss attribution. No-op in production runs.
                recordSeedEvent(this.session.id, {
                    turn,
                    system: assembled.system,
                    runtimeContext: runtimeBlock,
                    user: assembled.user,
                });
                messages = [this.turnSeedUser];
            }
            else {
                // 轮内到达的输入作为独立 user 消息接在轨迹末尾（时序与日志一致），
                // 并留在轨迹里供后续步复用——绝不篡夺种子的 CURRENT REQUEST 槽。
                if (claimed.length > 0) {
                    this.turnTrajectory.push(...claimed);
                    this.turnTrajectorySteps.push(...claimed.map(() => step));
                }
                // 轮内封存(提案 2026-09-02):轨迹越过阈值时把最旧的一批已完成步折成
                // 封存块,插在种子之后、剩余原文之前。默认关闭——行为由 A/B 裁决。
                this.maybeSealSteps(turn, step);
                messages = [
                    this.turnSeedUser,
                    ...(this.stepTapeMessage === undefined ? [] : [this.stepTapeMessage]),
                    ...this.turnTrajectory,
                ];
            }
            // 审计记录（评审 D）：这个 loop 发的是重建切片而不是 deriveMessages()，
            // 所以 DSH 的 model-visible ⟺ logged 断言对它不成立。落一条摘要事件把
            // 「本轮这一步到底发了什么」变成可事后验证的日志事实——代价是几十字节，
            // 而不是把整份切片再写一遍。dsh-slice-agent-loop/invariant 据此校验。
            this.session.append('slice/request-slice', {
                turn, step,
                seedDigest: sliceDigest(seedTextOf(messages)),
                messageCount: messages.length,
                ...(this.sealedThrough > 0
                    ? { sealedThrough: this.sealedThrough, stepTapeDigest: sliceDigest(renderStepTape(this.stepTapeEntries)) }
                    : {}),
            });
            const request = harnessUniverse().llm.markAgentLoopRequest(deepFreeze({
                ...header.config,
                messages,
                ...(header.system !== undefined ? { system: header.system } : {}),
                ...(header.tools !== undefined ? { tools: header.tools } : {}),
                sessionId: this.session.id,
                signal,
            }));
            const assembler = new BlockAssembler();
            const chunkSeqs = [];
            const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request);
            signal.throwIfAborted();
            for await (const chunk of stream) {
                signal.throwIfAborted();
                chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq);
                assembler.push(chunk);
            }
            signal.throwIfAborted();
            const finish = assembler.finish;
            if (finish.kind === 'error' || finish.kind === 'aborted') {
                // agent/request-error fires BEFORE any retry decision (contract).
                const action = await this.dispatch.waterfall('agent/request-error', { turn, step, provider: request.provider, failure: finish.failure, retryPolicy: preparedCall?.retryPolicy, signal }, async () => undefined);
                signal.throwIfAborted();
                if (action?.kind !== 'retry') {
                    throw new (harnessUniverse().llm.LlmError)(finish.failure.message, finish.failure.code, finish.failure);
                }
                continue;
            }
            const message = createAssistantMessage({
                content: assembler.blocks(),
                source: {
                    provider: request.provider,
                    model: request.model,
                    ...(assembler.replayState !== undefined ? { replayState: assembler.replayState } : {}),
                },
            });
            const assistantEvent = this.session.append('assistant/message', { turn, step, message, ...(assembler.usage === undefined ? {} : { usage: assembler.usage }) }, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs });
            // Sidecar mirror of this call's usage (raw + normalized) — pairs with the
            // seed record above so attribution can compare expected vs actual miss.
            recordCallEvent(this.session.id, {
                turn,
                step,
                provider: requestContext.provider,
                model: requestContext.model,
                usage: assembler.usage,
                tools: message.content.filter((b) => b.type === 'tool-call').map((b) => b.name),
            });
            // 轮内轨迹 + 对话环助手侧（continuity.ts fillAssistant）。
            this.turnTrajectory.push(message);
            this.turnTrajectorySteps.push(step);
            const assistantText = message.content
                .filter((b) => b.type === 'text')
                .map((b) => b.text).join('');
            fillAssistant(this.cont, assistantText);
            if (this.mode === 'state')
                this.harvestProposedFacts(step, assistantText);
            // 推理链上带:默认关。两侧实验同判(2026-08-31,archives 20260831-reasoning-ab):
            // slice 塞入旧推理 → 生成 +42%;default 剪掉原生回传 → 生成 −25%——
            // 旧推理在上下文里是纯成本,default 的省思考来自轻信叙事,与召回无关。
            // SLICE_REASONING_TAPE=1 重新启用,供未来通道级实验。
            if (process.env.SLICE_REASONING_TAPE === '1')
                trackReasoning(this.cont, reasoningText(message));
            // 助手组件所有权 = 本轮最新一条 assistant/message（与 fillAssistant 同义）。
            this.ownAssistant(turn, assistantEvent.seq, assistantText);
            if (finish.kind === 'max-tokens')
                return { kind: 'max-tokens' };
            const toolCalls = message.content.filter((block) => block.type === 'tool-call');
            if (toolCalls.length === 0)
                return { kind: 'completed' };
            const { concluded } = await this.executeToolCalls(turn, step, toolCalls, signal);
            return concluded ? { kind: 'completed' } : null;
        }
    }
    // ------------------------------------------------------------------ tools
    /**
     * Execute one step's tool calls through the dsh-tools scheduler, mirroring
     * the stock driver's scheduler: exclusive calls form barriers, parallel-safe
     * calls overlap in a bounded rolling pool (the plugin-owned
     * maxParallelToolCalls cap), results and result contexts commit in model
     * order, and abort stops replenishment, drains started calls, and records
     * synthetic error results for skipped calls so replay stays valid.
     */
    async executeToolCalls(turn, step, toolCalls, signal) {
        const planned = toolCalls.map((block) => ({
            block,
            exec: {
                callId: block.id,
                name: block.name,
                arguments: parseArguments(block.arguments),
                agent: this,
                signal,
            },
        }));
        if (this.mode === 'state' || this.mode === 'stream') {
            // 契约执行的写前快照:该步每个写类调用的目标文件当前磁盘态。
            this.preWrite.clear();
            for (const p of planned) {
                const path = editedPath(p.block.name, p.exec.arguments);
                if (path === undefined)
                    continue;
                const d = readDiskStatus(this.sessionCwd(), path);
                this.preWrite.set(path, d.kind === 'ok' ? { existed: true, body: d.body } : { existed: false, body: '' });
            }
        }
        let next = 0;
        let concluded = false;
        while (next < planned.length) {
            // Commit before classifying again so registry changes affect unstarted calls.
            const first = planned[next];
            const mode = this.loopCtx.tools.executionMode(first.exec).kind;
            const group = mode === 'parallel' ? planned.slice(next) : [first];
            const outcome = await this.runToolGroup(turn, step, group, mode, signal);
            next += outcome.consumed;
            concluded ||= outcome.concluded;
            if (outcome.aborted) {
                for (const call of planned.slice(next))
                    this.appendSkippedToolCall(turn, step, call.block);
                return { concluded };
            }
        }
        return { concluded };
    }
    /** Run one exclusive barrier or parallel pool; results commit in model order. */
    async runToolGroup(turn, step, group, mode, signal) {
        // rc.2 renamed TOOL_REGISTRY_SCHEDULER -> TOOL_RUNTIME_SCHEDULER; accept either
        const toolsMod = harnessUniverse().tools;
        const schedulerKey = (toolsMod.TOOL_RUNTIME_SCHEDULER ?? toolsMod.TOOL_REGISTRY_SCHEDULER);
        const scheduler = this.loopCtx.tools[schedulerKey];
        const slots = group.map(() => undefined);
        // Started slots retain their tool/call seq for result provenance.
        const callSeqs = group.map(() => -1); // sentinel, overwritten before use
        let nextToStart = 0;
        let committed = 0;
        let started = 0;
        let aborted = signal.aborted;
        let concluded = false;
        let schedulerFailure;
        const throwSchedulerFailure = () => {
            if (schedulerFailure !== undefined)
                throw schedulerFailure.error;
        };
        // `committed` advances only across contiguous model-order slots.
        const commitReady = async () => {
            while (committed < group.length) {
                const slot = slots[committed];
                if (slot === undefined)
                    break;
                const call = group[committed];
                const result = slot.needsPost
                    ? await scheduler.finalize(slot.exec, slot.result)
                    : scheduler.finish(slot.exec, slot.result);
                this.appendToolResult(turn, step, call.block, result, callSeqs[committed]);
                for (const context of result.additionalContexts ?? []) {
                    this.ledger.inbox.append('next-step', context);
                }
                concluded ||= result.concludesTurn === true;
                committed += 1;
            }
        };
        const inFlight = new Map();
        const startCall = async (index) => {
            const call = group[index];
            callSeqs[index] = this.appendToolCall(turn, step, call.block);
            started += 1;
            const prepared = await scheduler.prepare(call.exec);
            throwSchedulerFailure();
            switch (prepared.kind) {
                case 'dispatch': {
                    const promise = scheduler.dispatch(prepared.exec).then((outcome) => {
                        slots[index] = { exec: prepared.exec, result: outcome.result, needsPost: outcome.kind === 'post-result' };
                        return index;
                    }, (error) => {
                        schedulerFailure ??= { error };
                        return index;
                    });
                    inFlight.set(index, promise);
                    break;
                }
                case 'post-result':
                    slots[index] = { exec: prepared.exec, result: prepared.result, needsPost: true };
                    break;
                case 'final-result':
                    slots[index] = { exec: prepared.exec, result: prepared.result, needsPost: false };
                    break;
                /* v8 ignore next -- closed-union exhaustiveness guard (stock tool-calls.ts:192 同构) */
                default:
                    // 没有这一支时，DSH 将来给 ScheduledToolPreparation 加一个 kind 会让这里
                    // 静默不填 slot，最终以 "uncommitted settled calls" 这种无信息量的错冒出来。
                    assertNever(prepared, 'tool-call scheduler prepare result');
            }
        };
        const fillPool = async () => {
            while (!aborted && nextToStart < group.length && inFlight.size < this.maxParallelToolCalls) {
                // Re-read later modes after ordered commits so registry changes can create a barrier.
                const nextCall = group[nextToStart];
                if (nextToStart > 0 && mode === 'parallel'
                    && this.loopCtx.tools.executionMode(nextCall.exec).kind !== 'parallel')
                    break;
                await startCall(nextToStart);
                nextToStart += 1;
                throwSchedulerFailure();
                await commitReady();
                throwSchedulerFailure();
                // Abort may arrive while pre-execute awaits.
                if (signal.aborted)
                    aborted = true;
            }
        };
        // Ordered pre-execute may await; only dispatch/body overlaps. A scheduler
        // failure stops new dispatches, drains started ones, and rejects with the
        // first failure without fabricating tool results.
        try {
            await fillPool();
            while (inFlight.size > 0) {
                const settledIndex = await Promise.race(inFlight.values());
                inFlight.delete(settledIndex);
                throwSchedulerFailure();
                await commitReady();
                throwSchedulerFailure();
                // Abort may arrive while a tool or ordered commit awaits.
                if (signal.aborted)
                    aborted = true;
                await fillPool();
            }
        }
        catch (error) {
            schedulerFailure ??= { error };
            await Promise.allSettled(inFlight.values());
            throw schedulerFailure.error;
        }
        if (aborted) {
            // Started calls and accepted context settle first; every remaining model
            // call then receives an ordered synthetic result before the turn aborts.
            for (const call of group.slice(started))
                this.appendSkippedToolCall(turn, step, call.block);
            return { consumed: group.length, aborted: true, concluded };
        }
        if (committed !== started)
            throw new Error('tool-call scheduler: uncommitted settled calls');
        return { consumed: started, aborted: false, concluded };
    }
    /** Append a started call and return its provenance sequence. */
    appendToolCall(turn, step, block) {
        const event = this.session.append('tool/call', {
            turn, step, callId: block.id, name: block.name, arguments: block.arguments,
        });
        return event.seq;
    }
    /** 会话工作目录（session.header.cwd 为权威，同 WP6 教训）。 */
    sessionCwd() {
        return this.session.header?.cwd ?? process.cwd();
    }
    /**
     * OPEN FILES locator index（seed.py:190-233 的 MVP 移植）：每个驻留文件一行
     * path · 行数 · 当前盘态 sha256(12) · 精确 read 调用。hash 落在脱敏字节上
     * （HASH SEAM：与 tape 锚定同一 redactText(codeFile) 域，否则永不命中）。
     * 盘态缺失/不可读只发布状态行，绝不把 seal 时的陈旧字节冒充为当前盘态。
     */
    openFilesIndex() {
        const paths = Object.keys(this.cont.tapeFiles).sort();
        if (paths.length === 0)
            return '';
        const cwd = this.sessionCwd();
        return paths.map((p) => {
            const disk = readDiskStatus(cwd, p);
            if (disk.kind === 'missing')
                return `### ${p} (not created yet)`;
            if (disk.kind === 'unreadable')
                return `### ${p} (exists but not shown: ${disk.reason})`;
            const body = redactText(disk.body, { codeFile: true });
            // Path + line count + hash, and no call name. `read_file("...")` was
            // wrong twice over here: DSH registers its reader as `read`, and that
            // tool takes {file_path}, not a positional string. Hardcoding `read`
            // instead would rot on any host rename, and discovering the name at
            // runtime cannot be done without guessing — ToolSchema is
            // {name, description, parameters} with no capability tag, category, or
            // well-known name to match on. The model can already see its own tool
            // schemas; it only needs to be told WHICH file to re-read.
            // 结论直接写在索引上:模型不会自己去对哈希(s2 实测每轮开头照样重读 tape 里已有的文件)。
            const hash = _h(body);
            // tapeFiles 里存的是完整 sha256(continuity.sealTurn),索引展示的是短哈希——按完整值比。
            const full = createHash('sha256').update(body, 'utf8').digest('hex');
            // 只有完整基线模式才把"不必重读"写进索引:patch 模式下模型会照做,然后在脑中合成
            // base+patch,推理翻倍(s2 实测 76K → 126K)。
            if (this.anchorMode !== 'base')
                return `### ${p} — ${pySplitlines(body).length} lines · sha256:${hash} · (edited this session)`;
            const verdict = this.cont.tapeFiles[p]?.hash === full ? 'current in tape — edit from the tape, do not read it again' : 'changed on disk — read before editing';
            return `### ${p} — ${pySplitlines(body).length} lines · sha256:${hash} · ${verdict}`;
        }).join('\n');
    }
    // ------------------------------------------------------------ stream mode (v3)
    /** 工具结果进轨迹前的整形:磁带现行文件的整读 → 指针;然后(若开)注入时摘要。 */
    shapeForTrajectory(turn, step, block, message) {
        const pointed = this.readPointer ? this.pointerForTapeCurrentRead(turn, step, block, message) : undefined;
        if (pointed !== undefined)
            return pointed;
        return this.digestPolicy.enabled ? this.digestForTrajectory(turn, step, block, message) : message;
    }
    /**
     * 读取指针(2026-09-03):整读一个"磁带里已有且与盘态同 hash"的文件时,结果换成一句指回
     * 磁带的话——全文本来就在上下文里,重发它只是付一次未命中价加一步输出。全文仍进会话
     * 日志(recall_step 可取)。带 offset/limit 的部分读、不在磁带里或已变化的文件原样返回。
     */
    pointerForTapeCurrentRead(turn, step, block, message) {
        const first = message.content[0];
        if (!first || first.type !== 'tool-result' || first.isError)
            return undefined;
        const args = parseArguments(block.arguments);
        const rp = readToolPath(block.name, args);
        if (rp === undefined || args?.offset !== undefined || args?.limit !== undefined)
            return undefined;
        const state = this.cont.tapeFiles[rp];
        if (state === undefined)
            return undefined;
        const disk = readDiskStatus(this.sessionCwd(), rp);
        if (disk.kind !== 'ok' || createHash('sha256').update(redactText(disk.body, { codeFile: true }), 'utf8').digest('hex') !== state.hash)
            return undefined;
        this.session.append('slice/read-pointer', { turn, step, path: rp });
        const text = `[read ${rp} · unchanged: the current content is already in your SESSION TAPE above (latest [base ${rp} …] plus its patches, sha256:${state.hash.slice(0, 12)}) — edit from the tape instead of re-reading; recall_step(${turn}, ${step}) returns this read verbatim]`;
        return createToolResultMessage({ callId: first.toolCallId, content: [{ type: 'text', text }], isError: false });
    }
    /** 注入时摘要:工具结果的文本块折成紧凑视图;不折的原样返回同一消息对象。 */
    digestForTrajectory(turn, step, block, message) {
        // 钉住步(前 pinSteps 步)的读取是本轮的规则来源:stream 模式不在宪法里重发全文,
        // 所以这里必须原样进流——折了规则,模型就只剩旁路提取的摘要版规则。
        if (step <= this.statePolicy.pinSteps)
            return message;
        const first = message.content[0];
        if (!first || first.type !== 'tool-result' || first.isError || !first.content)
            return message;
        // 源代码不折(见 result-digest.ts looksLikeCodePath / looksLikeCode)。
        const readPath = editedPath(block.name, parseArguments(block.arguments)) ?? parseArguments(block.arguments)?.file_path ?? parseArguments(block.arguments)?.path;
        let changed = false;
        let before = 0;
        let after = 0;
        const hint = `recall_step(${turn}, ${step})`;
        const content = first.content.map((b) => {
            if (b.type !== 'text' || typeof b.text !== 'string')
                return b;
            before += b.text.length;
            // 按工具名与内容类型路由:code/search 不折,log 错误优先,data 头尾 + 结构行。
            const d = digestToolResult(b.text, { tool: block.name, path: readPath }, this.digestPolicy);
            after += d.text.length;
            if (!d.digested)
                return b;
            changed = true;
            const path = editedPath(block.name, parseArguments(block.arguments)) ?? parseArguments(block.arguments)?.file_path;
            return { ...b, text: `[${block.name}${path ? ' ' + path : ''} · ${d.kind} · ${d.totalLines} lines, ${d.keptLines} kept · ${hint} returns the full text]\n${d.text}` };
        });
        if (!changed)
            return message;
        this.session.append('slice/digest', { turn, step, tool: block.name, charsBefore: before, charsAfter: after });
        return createToolResultMessage({ callId: first.toolCallId, content: content, isError: false });
    }
    /** 宪法成形(钉住 + 规则提取)后作为一条用户消息追加进流——只追加一次,永不重建。 */
    async appendConstitutionIfReady(turn, step, requestText, config, preparedCall, signal) {
        if (this.constitution === null)
            this.constitution = { request: requestText, pinned: [], rules: [] };
        const c = this.constitution;
        // 提取时机 extractAtStep(默认 3 = 钉住后立刻):l2 三次运行里唯一成功的是宪法在第 3 步
        // 就位的那次——路径决定发生在第 3 步,推迟到第 8 步(惰性提取试验)模型把 ledger/ 当根,
        // 45 个 posting 全写错目录。宪法文本便宜(旁路 effort off ≈ 700 out),短轮的税不在
        // 这里,而在错谓词弹回——那由 enforceFromStep 管。
        if (this.rulesExtracted || step < Math.max(this.statePolicy.pinSteps + 1, this.statePolicy.extractAtStep) || c.pinned.length === 0)
            return;
        this.rulesExtracted = true;
        if (this.statePolicy.extractRules) {
            try {
                const raw = await this.sideCompletion(turn, step, 'rules', rulesExtractionPrompt(c), config, preparedCall, signal);
                c.rules = parseRulesJson(raw);
                this.session.append('slice/state-rules', { turn, step, rules: c.rules.length, enforced: c.rules.filter((r) => r.predicate !== undefined).length, list: c.rules.map((r) => `${r.id}${r.predicate ? ` [${r.predicate.kind}]` : ''}: ${r.text}`), raw: raw.slice(0, 400) });
            }
            catch (error) {
                this.session.append('slice/state-rules', { turn, step, rules: 0, enforced: 0, error: error instanceof Error ? error.message : String(error) });
            }
        }
        // 只追加规则与钉住清单(钉住文件全文已在轨迹里的原始读取结果中——stream 模式不重复发)。
        const text = renderConstitution({ request: c.request, pinned: c.pinned.map((p) => ({ path: p.path, text: '(read above; pinned as the rule source for this turn)' })), rules: c.rules });
        this.turnTrajectory.push(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
        this.turnTrajectorySteps.push(step);
    }
    // ------------------------------------------------------------ world-state mode
    /**
     * 世界状态循环的请求组装(每步):
     *   [runtime-context?][宪法 + 账本 + 相关推送](单条 user 种子) + 最近 K 步原文
     * 宪法在轮内逐字不变(规则提取只发生一次);账本 append-only;推送与热窗每步变。
     */
    async assembleStateRequest(turn, step, requestText, runtimeBlock, config, preparedCall, signal) {
        if (this.constitution === null)
            this.constitution = { request: requestText, pinned: [], rules: [] };
        const c = this.constitution;
        if (!this.rulesExtracted && step > this.statePolicy.pinSteps && this.statePolicy.extractRules && c.pinned.length > 0) {
            this.rulesExtracted = true;
            try {
                const raw = await this.sideCompletion(turn, step, 'rules', rulesExtractionPrompt(c), config, preparedCall, signal);
                c.rules = parseRulesJson(raw);
                for (const r of c.rules)
                    addFact(this.worldState, { kind: 'rule', text: `${r.id}: ${r.text}`, sourceDigest: 'host:rules', step });
                this.session.append('slice/state-rules', { turn, step, rules: c.rules.length, enforced: c.rules.filter((r) => r.predicate !== undefined).length, list: c.rules.map((r) => `${r.id}${r.predicate ? ` [${r.predicate.kind}]` : ''}: ${r.text}`), raw: raw.slice(0, 400) });
            }
            catch (error) {
                // 提取失败:规则只以原文(钉住文件)形态存在,契约不执行。落账,不打断。
                this.session.append('slice/state-rules', { turn, step, rules: 0, enforced: 0, error: error instanceof Error ? error.message : String(error) });
            }
        }
        const push = this.statePolicy.pushHits > 0 ? this.renderRelevancePush(turn, step, requestText) : '';
        const seedText = renderConstitution(c) + '\n' + renderLedger(this.worldState) + (push ? '\n' + push : '');
        const seed = createUserMessage({
            content: [
                ...(runtimeBlock ? [{ type: 'text', text: runtimeBlock }] : []),
                { type: 'text', text: seedText },
            ],
            source: { kind: 'user' },
        });
        if (step === 1)
            recordSeedEvent(this.session.id, { turn, system: this.currentSystemPrefix, runtimeContext: runtimeBlock, user: seedText });
        this.session.append('slice/state-seed', { turn, step, seedDigest: sliceDigest(seedText), files: this.worldState.fileLog.length, facts: this.worldState.facts.length, pinned: c.pinned.length, rules: c.rules.length });
        const K = this.statePolicy.hotWindowSteps;
        const hot = this.turnTrajectory.filter((_, i) => (this.turnTrajectorySteps[i] ?? step) >= step - K);
        return [seed, ...hot];
    }
    /** 旁路模型调用(不带工具、不标 agent-loop、不入会话轨迹):规则提取用。 */
    async sideCompletion(turn, step, label, prompt, config, _preparedCall, signal) {
        // 配置必须与 prepareCall 解析出的完全一致(prepared 句柄校验"config changed
        // before dispatch"),所以不改 maxTokens/effort——提取输出本身就短。
        const request = deepFreeze({
            ...config,
            messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })],
            sessionId: this.session.id,
            signal,
        });
        // PreparedLlmCall 是一次性句柄:不能借用主调用的——旁路调用自己 prepare 一次,
        // 主调用的句柄留给主请求。旁路可以用自己的 effort 档(sideEffort):单独 prepare
        // 一份注入后的 config,请求体与之一致即可;适配器不认该档就退回主调用的档。
        let own;
        let sideRequest = request;
        const injected = this.statePolicy.sideEffort === 'inherit' ? undefined : applyEffortDefault({ ...config, reasoningEffort: undefined }, this.statePolicy.sideEffort);
        if (injected?.reasoningEffort !== undefined) {
            try {
                own = await this.loopCtx.llm.prepareCall(injected, signal);
                sideRequest = deepFreeze({ ...request, ...own.config });
            }
            catch {
                own = undefined;
            }
        }
        if (own === undefined) {
            try {
                own = await this.loopCtx.llm.prepareCall(config, signal);
            }
            catch {
                own = undefined;
            }
        }
        const assembler = new BlockAssembler();
        const stream = own?.stream(sideRequest) ?? this.loopCtx.llm.stream(sideRequest);
        for await (const chunk of stream)
            assembler.push(chunk);
        const finish = assembler.finish;
        // 旁路调用不进对话轨迹,但必须进账:会话事件供 runner 汇总,sidecar 供归因。
        this.session.append('slice/side-call', { turn, step, label, ...(assembler.usage === undefined ? {} : { usage: assembler.usage }) });
        recordCallEvent(this.session.id, { turn, step, side: label, provider: config.provider, model: config.model, usage: assembler.usage });
        if (finish.kind === 'error' || finish.kind === 'aborted')
            throw new Error(`rules extraction ${finish.kind}`);
        return assembler.blocks()
            .filter((b) => b.type === 'text')
            .map((b) => b.text).join('');
    }
    /** 相关性推送:按当前请求 + 最近工具调用参数检索会话日志,推热窗之外的相关片段。 */
    renderRelevancePush(turn, step, requestText) {
        const lastAssistant = [...this.turnTrajectory].reverse().find((m) => m.role === 'assistant');
        const argText = lastAssistant
            ? lastAssistant.content.filter((b) => b.type === 'tool-call').map((b) => b.arguments ?? '').join(' ')
            : '';
        const query = `${argText} ${requestText}`.trim();
        if (!query)
            return '';
        const K = this.statePolicy.hotWindowSteps;
        const hits = searchSessionEvents(this.session.snapshotEvents(), query, { kinds: ['tool_output', 'assistant', 'user'], limit: this.statePolicy.pushHits + 6 })
            .filter((h) => h.turn < turn || (h.step ?? 0) < step - K)
            .slice(0, this.statePolicy.pushHits);
        if (hits.length === 0)
            return '';
        const lines = ['# RELEVANT FROM LOG (host-retrieved for this step; historical, verify before relying; recall_step(turn, step) for full text)'];
        for (const h of hits)
            lines.push(`- [turn ${h.turn}${h.step !== undefined ? ` step ${h.step}` : ''} · ${h.kind}] ${h.snippet.replace(/\s+/g, ' ').slice(0, 300)}`);
        return lines.join('\n') + '\n';
    }
    /** 契约执行:写类工具成功后按宪法谓词校验磁盘内容;违反则回滚并改写结果为错误。 */
    enforceContract(turn, step, block, result) {
        const rules = this.constitution?.rules ?? [];
        if (result.isError || !rules.some((r) => r.predicate !== undefined))
            return result;
        // stream 模式:短轮不执行契约——n2 交叉验证里一条错谓词在第 3 轮第 3 步打回了正确的
        // edit(+8 步、+4.6K out);长任务的早期写入本来就有钉住原文与宪法兜着。
        if (this.mode === 'stream' && step < this.statePolicy.enforceFromStep)
            return result;
        const path = editedPath(block.name, parseArguments(block.arguments));
        if (path === undefined)
            return result;
        const cwd = this.sessionCwd();
        const disk = readDiskStatus(cwd, path);
        if (disk.kind !== 'ok')
            return result;
        const all = checkPredicates(rules, path, disk.body);
        if (all.length === 0)
            return result;
        // 弹回预算:谓词来自一次廉价的旁路提取,可能是错的。同一规则超出预算(默认:打回
        // 一次)仍被违反,更可能是谓词错而不是模型错——该规则降级为纯文本(谓词移除),
        // 本次写入放行并附宿主提示,由模型自己对照规则原文核实。没有预算,一条错谓词就
        // 能把正确的写入无限打回(v3.1 首跑:9 步 4 次写入全部回滚,migrated/ 为空)。
        const budget = this.statePolicy.contractBounceBudget;
        const violations = [];
        const suspended = [];
        for (const v of all) {
            const id = v.split(': ')[0];
            const n = (this.ruleBounces.get(id) ?? 0) + 1;
            this.ruleBounces.set(id, n);
            if (n > budget) {
                suspended.push(id);
                const r = rules.find((x) => x.id === id);
                if (r)
                    delete r.predicate;
            }
            else
                violations.push(v);
        }
        if (violations.length === 0) {
            this.session.append('slice/contract-suspend', { turn, step, path, rules: suspended });
            const note = `[host] rule check SUSPENDED for ${suspended.join(', ')}: the host predicate overruled you ${budget + 1} times on this path, so it is likely mis-extracted. The write above was KEPT. Verify the content against the rule text in the CONSTITUTION yourself.`;
            return { ...result, content: [...result.content, { type: 'text', text: note }] };
        }
        const pre = this.preWrite.get(path);
        const abs = isAbsolute(path) ? path : resolvePath(cwd, path);
        try {
            if (pre === undefined || !pre.existed)
                fsUnlinkSync(abs);
            else {
                fsMkdirSync(dirname(abs), { recursive: true });
                fsWriteFileSync(abs, pre.body, 'utf8');
            }
        }
        catch { /* 回滚失败也要打回模型;账本记 reverted 让它知道状态可疑 */ }
        this.contractBounces += 1;
        this.session.append('slice/contract-bounce', { turn, step, path, violations });
        recordFile(this.worldState, { path, sha: pre?.existed ? _h(pre.body) : '-', action: 'reverted', step });
        const text = `CONTRACT VIOLATION — the write to ${path} was REVERTED (file restored to its previous state). Violations:\n- ${violations.join('\n- ')}\nFix the content so it satisfies the CONSTITUTION rules, then write again. If you are certain the content already satisfies the rule as written, write it again unchanged: a rule that overrules you twice is suspended.`;
        return { isError: true, error: { message: text }, content: [{ type: 'text', text }] };
    }
    /** 账本更新(宿主确定性提取)+ 早期读取即宪法。 */
    observeToolForState(turn, step, block, result, callSeq) {
        const args = parseArguments(block.arguments);
        const cwd = this.sessionCwd();
        const readPath = block.name === 'read' || block.name === 'read_file' || block.name === 'read_section'
            ? String((args?.file_path ?? args?.path) ?? '')
            : '';
        if (readPath && !result.isError) {
            const disk = readDiskStatus(cwd, readPath);
            recordFile(this.worldState, { path: readPath, sha: disk.kind === 'ok' ? _h(disk.body) : '-', action: 'read', step });
            const c = this.constitution;
            if (c && step <= this.statePolicy.pinSteps && disk.kind === 'ok' && disk.body.length <= 60_000 && !c.pinned.some((p) => p.path === readPath)) {
                c.pinned.push({ path: readPath, text: disk.body });
            }
            return;
        }
        const edited = editedPath(block.name, args);
        if (edited !== undefined && !result.isError) {
            const disk = readDiskStatus(cwd, edited);
            recordFile(this.worldState, { path: edited, sha: disk.kind === 'ok' ? _h(disk.body) : '-', action: block.name === 'write' || block.name === 'write_file' ? 'write' : 'edit', step });
            return;
        }
        if (result.isError) {
            const head = toolResultText({ content: [{ content: result.content }] }).replace(/\s+/g, ' ').slice(0, 160);
            addFact(this.worldState, { kind: 'fact', text: `tool ${block.name} failed: ${head}`, sourceDigest: `host:${callSeq}`, step });
        }
    }
    /** 模型提议的事实:助手正文里 `decision:` / `obligation:` / `fact:` 开头的行。出处 = 该消息摘要。 */
    harvestProposedFacts(step, assistantText) {
        const digest = sliceDigest(assistantText).slice(0, 12);
        for (const line of assistantText.split('\n')) {
            const m = line.match(/^\s*(decision|obligation|fact)\s*:\s*(.{4,400})$/i);
            if (!m)
                continue;
            addFact(this.worldState, { kind: m[1].toLowerCase(), text: m[2].trim(), sourceDigest: `asst:${digest}`, step });
        }
    }
    /**
     * 轮内封存:请求组装前,若轨迹越过阈值,把最旧的一批已完成步折成封存条目
     * (step-tape.ts),从轨迹里移除其原文,并重建封存块消息。条目 append-only;
     * 封存点只前进。原文仍在会话日志,recall_step 可逐字取回。
     */
    maybeSealSteps(turn, step) {
        const completed = step - 1;
        const unsealed = completed - this.sealConsideredThrough;
        const before = trajectoryChars(this.turnTrajectory);
        const n = stepsToSeal(this.inTurnSeal, before, unsealed, this.sealConsideredThrough);
        if (n <= 0)
            return;
        // 宪法保护:封存起点不早于 protectEarlySteps(前 N 步的规则/清单永不折叠)。
        const sealFrom = Math.max(this.sealConsideredThrough, this.inTurnSeal.protectEarlySteps);
        const upTo = sealFrom + n;
        const groups = new Map();
        const keepMsgs = [];
        const keepSteps = [];
        for (let i = 0; i < this.turnTrajectory.length; i += 1) {
            const m = this.turnTrajectory[i];
            const s = this.turnTrajectorySteps[i] ?? completed;
            // 保护步(≤ protectEarlySteps)与窗口外步(> upTo)都留作原文。
            if (s > upTo || s <= this.inTurnSeal.protectEarlySteps) {
                keepMsgs.push(m);
                keepSteps.push(s);
                continue;
            }
            let g = groups.get(s);
            if (g === undefined) {
                g = { assistantText: '', calls: [], byId: new Map(), interjections: [] };
                groups.set(s, g);
            }
            const role = m.role;
            if (role === 'assistant') {
                for (const block of m.content) {
                    if (block.type === 'text' && block.text)
                        g.assistantText += block.text;
                    else if (block.type === 'tool-call') {
                        const c = { name: block.name ?? '?', arguments: block.arguments ?? '', resultText: '', isError: false };
                        g.calls.push(c);
                        if (block.id)
                            g.byId.set(block.id, c);
                    }
                }
            }
            else if (m.source?.kind === 'tool') {
                const block = m.content[0];
                const c = block?.toolCallId ? g.byId.get(block.toolCallId) : undefined;
                const text = toolResultText(m);
                if (c !== undefined) {
                    c.resultText = text;
                    c.isError = block?.isError === true;
                }
                else
                    g.calls.push({ name: '?', arguments: '', resultText: text, isError: block?.isError === true });
            }
            else {
                g.interjections.push(blockText(m));
            }
        }
        const newEntries = [];
        for (const st of [...groups.keys()].sort((a, b) => a - b)) {
            const g = groups.get(st);
            newEntries.push(renderSealedStep(turn, { step: st, assistantText: g.assistantText, calls: g.calls, interjections: g.interjections }));
        }
        // 体量守卫:被移除原文的字节 vs 新封存条目的字节。折叠比这批原文省不下
        // (1-ratio)就不划算——小结果折叠只多付一次缓存重建。跳过并把这批标为
        // 「已评估」(consideredThrough),避免下一步重算同一批;它们留在轨迹里作原文。
        const removedChars = keepMsgs.length < this.turnTrajectory.length
            ? this.turnTrajectory.reduce((n, m, i) => n + (this.turnTrajectorySteps[i] <= upTo ? JSON.stringify(m.content).length : 0), 0)
            : 0;
        const sealedChars = newEntries.reduce((n, e) => n + e.length, 0);
        if (!sealSavesEnough(removedChars, sealedChars)) {
            this.sealConsideredThrough = upTo;
            this.session.append('slice/step-seal', {
                turn, step, sealedThrough: this.sealedThrough, sealedSteps: 0,
                entries: this.stepTapeEntries.length, trajectoryCharsBefore: before, trajectoryCharsAfter: before,
            });
            return;
        }
        this.stepTapeEntries.push(...newEntries);
        this.turnTrajectory = keepMsgs;
        this.turnTrajectorySteps = keepSteps;
        this.sealedThrough = upTo;
        this.sealConsideredThrough = upTo;
        this.stepTapeMessage = createUserMessage({
            content: [{ type: 'text', text: renderStepTape(this.stepTapeEntries) }],
            source: { kind: 'user' },
        });
        this.session.append('slice/step-seal', {
            turn, step,
            sealedThrough: upTo,
            sealedSteps: n,
            entries: this.stepTapeEntries.length,
            trajectoryCharsBefore: before,
            trajectoryCharsAfter: trajectoryChars(this.turnTrajectory),
        });
    }
    /** Append a model-ordered result linked to its call event. */
    appendToolResult(turn, step, block, resultIn, callSeq) {
        // 世界状态:契约执行——写后校验,违反即回滚磁盘并把结果改成错误打回模型。
        const result = this.mode === 'state' || this.mode === 'stream' ? this.enforceContract(turn, step, block, resultIn) : resultIn;
        const message = createToolResultMessage({
            callId: block.id,
            content: result.content,
            isError: result.isError,
        });
        this.session.append('tool/result', {
            turn, step,
            message,
            ...result.error?.info ? { error: result.error.info } : {},
            // The tool's private presentation payload, persisted for replay.
            ...result.meta !== undefined ? { meta: result.meta } : {},
        }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
        trackToolOutcome(this.cont, result.isError === true, toolResultText(message));
        // v3 追加流:大结果进上下文前折成紧凑视图(全文已落日志,recall_step 取回)。
        // 轮内折叠:slice 与 stream 共用(默认开);state 模式保持自己的热窗设计。
        this.turnTrajectory.push(this.mode !== 'state' ? this.shapeForTrajectory(turn, step, block, message) : message);
        this.turnTrajectorySteps.push(step);
        if (this.mode === 'state' || this.mode === 'stream')
            this.observeToolForState(turn, step, block, result, callSeq);
        // 文件锚定不在这里——它挂在 `tools/result` 上（见构造函数）。这里的
        // `block.name` 是模型看见的名字（呈现平面）；code 模式下它恒为 `run_code`，
        // 真实的 write/edit 是 run_code 程序里的子调用，顶层永远看不到。
    }
    /** Append the durable call/result pair for a model call skipped after cancellation. */
    appendSkippedToolCall(turn, step, block) {
        const callSeq = this.appendToolCall(turn, step, block);
        const message = createToolResultMessage({
            callId: block.id,
            content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
            isError: true,
        });
        this.session.append('tool/result', {
            turn, step,
            message,
            error: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
        }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
    }
}
/** Parse model arguments, preserving invalid JSON as text and mapping empty input to `{}`. */
function parseArguments(raw) {
    try {
        return raw ? JSON.parse(raw) : {};
    }
    catch {
        return raw;
    }
}
/** 一条助手消息里的推理链原文(各 reasoning 块按序拼接)。 */
function reasoningText(message) {
    return message.content
        .filter((b) => b.type === 'reasoning')
        .map((b) => b.text ?? '')
        .join('');
}
/** 轨迹的序列化体量(封存阈值用;近似请求字节)。 */
function trajectoryChars(messages) {
    let n = 0;
    for (const m of messages)
        n += JSON.stringify(m.content).length;
    return n;
}
function blockText(message) {
    return message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
}
/**
 * A tool result's model-facing text. The message carries exactly one
 * `tool-result` block whose own `content` holds the blocks the model reads —
 * one level deeper than {@link blockText}'s user-message shape.
 */
function toolResultText(message) {
    const blocks = message.content[0]?.content ?? [];
    return blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
}
// ------------------------------------------------------------------ seal helpers
/** stock agent-loop 的 requestProposal（agent.ts:55 同构）：从持久 epoch header
 * 派生下一次请求提案——adapterDefaults 标记为 true 的键是适配器默认值，丢弃后
 * 让适配器重新解析，显式设置保留。 */
function requestProposal(header) {
    if (header.adapterDefaults === undefined)
        return header.config;
    const proposal = { ...header.config };
    for (const key of ['reasoningEffort', 'maxTokens']) {
        if (header.adapterDefaults[key] === true)
            delete proposal[key];
    }
    return proposal;
}
/**
 * 编辑族工具，seal 时锚定文件后态。**必须匹配宿主真实注册的工具名**：DSH 0810
 * 的 tool-fs 注册 `write`/`edit`（参数键 file_path），str_replace_editor 注册
 * `str_replace_editor`（参数键 path，且仅 create/str_replace/insert 才写盘——view
 * 是只读，绝不锚定）。sliceagent 原生命名一并保留，供 golden/Python parity 与测试
 * fixture 使用。tests/driver-contract.spec.ts 的接线门断言本集合与 dsh-tool-fs
 * 真实注册名有交集——名字漂移会大声失败，不再静默地让 tape 恒空（评审 A）。
 */
export const EDIT_TOOL_NAMES = new Set([
    // DSH 0810 真实工具名
    'write', 'edit', 'str_replace_editor',
    // sliceagent 原生命名（fixture + Python parity）
    'edit_file', 'write_file', 'str_replace', 'append_to_file', 'create_file',
]);
/** str_replace_editor 仅这些 command 会写盘；view 是只读，不锚定（只读文件不进 tape）。 */
const STR_REPLACE_MUTATIONS = new Set(['create', 'str_replace', 'insert']);
/**
 * 一次成功工具执行写入的文件路径，若该工具不是编辑族或本次未写盘则返回 undefined。
 * str_replace_editor 额外按 command 门控，避免把 view（只读）也锚进 tape。
 *
 * 参数来自 `ToolExecution.arguments`——registry 已解析好的值，不是 JSON 串。
 * 宽容处理 unknown：模型可以发任何东西，非对象一律当作"没有路径"。
 */
/** read 工具的目标路径(tool-fs `read` / `read_file`)。 */
export function readToolPath(name, args) {
    if (typeof args !== 'object' || args === null)
        return undefined;
    const bag = args;
    if (name === 'read' || name === 'read_file')
        return typeof bag.file_path === 'string' ? bag.file_path : typeof bag.path === 'string' ? bag.path : undefined;
    // str_replace_editor 的 view 保持不锚定(driver-contract 既有契约;本部署挂的是 tool-fs)。
    return undefined;
}
export function editedPath(name, args) {
    if (!EDIT_TOOL_NAMES.has(name))
        return undefined;
    if (typeof args !== 'object' || args === null)
        return undefined;
    const bag = args;
    if (name === 'str_replace_editor') {
        const command = bag.command;
        if (typeof command !== 'string' || !STR_REPLACE_MUTATIONS.has(command))
            return undefined;
    }
    // 覆盖 tool-fs（file_path）与 str_replace_editor（path）两套键名。
    const p = bag.file_path ?? bag.path ?? bag.filePath;
    return typeof p === 'string' && p.trim() ? p : undefined;
}
function readDiskStatus(cwd, relOrAbs) {
    try {
        const abs = isAbsolute(relOrAbs) ? relOrAbs : resolvePath(cwd, relOrAbs);
        const body = readFileSync(abs, 'utf8');
        if (body.includes('\0'))
            return { kind: 'unreadable', reason: 'binary file' };
        return { kind: 'ok', body };
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT' || code === 'ENOTDIR')
            return { kind: 'missing' };
        const message = error instanceof Error ? error.message : String(error);
        return { kind: 'unreadable', reason: message.split('\n')[0].slice(0, 120) };
    }
}
