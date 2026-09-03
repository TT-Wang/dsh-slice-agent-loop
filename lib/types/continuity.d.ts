import { TapeEntry, type ReplyCaps } from './slice/tape.js';
export interface ConversationRow {
    user: string;
    assistant: string;
    /** Owning turn number (surface-replacement retargeting); absent for legacy rows. */
    turn?: number;
}
export interface TapeFileState {
    hash: string;
    content: string;
    /** 自上一次完整基线以来累积的 patch 数(rebaseAfterPatches 用)。 */
    patches?: number;
}
export interface Continuity {
    /** 首条 prompt 即话题 goal（system 侧渲染，跨轮不变直到换题）。 */
    goal: string;
    /**
     * 写入 goal 的那一轮轮号。表面替换（compaction）据此定位要改写的 goal——
     * 绝不靠对话环反查：环有 12 行硬顶，老轮滑出后就再也找不到，被声明已遮蔽的
     * 原始用户文本会永久留在 task_objective（USER 权级、mandatory）里逐轮发出。
     */
    goalTurn?: number;
    conversation: ConversationRow[];
    sessionTape: TapeEntry[];
    tapeFiles: Record<string, TapeFileState>;
    /** 本轮编辑过的文件（成功 tool/result 边界快照后态，seal 时锚定后清空）。 */
    pendingEdits: Array<{
        path: string;
        body: string;
    }>;
    /** 本轮读过(未必改过)的文件盘态——轮末也锚定为 base(2026-09-03 重读税实验)。 */
    pendingReads: Array<{
        path: string;
        body: string;
    }>;
    /** 各路径被读过的轮数(readBasesMinReads 用:只锚定跨轮重复读到的只读文件)。 */
    readCount: Record<string, number>;
    /** 本轮最后一次测试/检查命令及其结果摘要(checkInDigest 用;seal 时写进轮摘要后清空)。 */
    pendingCheck?: {
        command: string;
        summary: string;
    };
    /**
     * 本轮**最后一个** tool/result 的错误正文（成功结果清空）。轮内的失败模型
     * 本来就在轨迹里看得见；这里攒的是"这一轮结束时还挂着一个失败调用"，
     * seal 时转成 {@link Continuity.lastError} 供下一轮的 CURRENT ERROR 段用。
     */
    pendingError: string;
    /** 本轮各步的推理链原文(实时与重放同源累积),seal 时整段上带后清空。 */
    pendingReasoning: string[];
    /** 上一轮结束时未解决的工具错误原文，渲染为 CURRENT ERROR 段。 */
    lastError: string;
    /** 每轮封存的元数据（turnId → status/files），表面替换重写 digest 时按原样再渲染。 */
    sealMeta: Record<string, {
        status: string;
        files: string[];
    }>;
    turns: number;
}
export declare function createContinuity(): Continuity;
/** record_user：用户请求进环 + 计轮 + 环修剪（pfc.py:398-442 语义）。 */
export declare function recordUser(c: Continuity, text: string, turn?: number): void;
/** reducer 的 AssistantText 守卫：只有 final 且环非空才落助手侧。 */
export declare function fillAssistant(c: Continuity, text: string): void;
/** render_turn_digest 的 TS 移植（spine.py:35-87，无 segment 变体）。 */
export declare function renderTurnDigest(opts: {
    artifactId: string;
    taskId?: string;
    status: string;
    userRequest: string;
    sessionId: string;
    files?: readonly string[];
    /** The sealed reply exceeded REPLY_CAP_CHARS — sealTurn computes it with the tape's own predicate. */
    replyTruncated?: boolean;
    /** 本轮最后一次检查(测试命令 → 结果摘要),写成 `check:` 行。 */
    check?: string;
}): string;
/**
 * tape_seal_update 的 MVP 子集（tape.py:426 起）：digest + 文件锚定（patch/base
 * 取渲染更短者）+ 答复冻结 + compactTape GC。
 * 未含（与 sidecar 同级）：finding/knowledge 条目、spine digest、journal 落盘、
 * 离带漂移检测（dsh-tools 的工具结果不带文件后态，漂移检测待 dsh 侧钩子）。
 */
export declare function sealTurn(c: Continuity, opts: {
    turnId: string;
    status: string;
    userRequest: string;
    assistantReply: string;
    sessionId: string;
    /** 'auto'(现状:patch/base 取渲染更短者)或 'base'(永远完整基线——模型不必在脑中合成 patch)。 */
    anchorMode?: 'auto' | 'base';
    /** auto 模式下,同一文件累积到这么多 patch 就重落一份完整基线(默认 Infinity)。 */
    rebaseAfterPatches?: number;
    /** 回复截断上限(默认 cap 2000 / head 1400 / tail 500)。 */
    replyCaps?: ReplyCaps;
    /** 把本轮最后一次检查写进轮摘要。 */
    checkInDigest?: boolean;
    /** 同一轮内对同一文件的多次成功编辑只锚定末态(默认 false:每次编辑各落一条,保留"已执行的 patch"序列)。 */
    collapseEdits?: boolean;
    /** 只读文件要在至少这么多轮里被读到才锚定(默认 1 = 读一次就锚)。2026-09-03:s13/s14b 里只读一次的
     *  大文件被全部锚进磁带,封存 miss 从 17K 涨到 84–95K token,成本翻倍;跨轮重复读才值得占磁带。 */
    readBasesMinReads?: number;
}): {
    entries: number;
    gcRemoved: number;
    epochFolds: number;
    anchored: Array<{
        path: string;
        body: string;
    }>;
};
/**
 * 编辑后态快照（driver 在成功 tool/result 边界调用）：立即读取盘态并做
 * codeFile 脱敏后留存——tape 永远只锚定脱敏字节，hash 也落在脱敏字节上
 * （seed.py HASH SEAM 同构），且一轮内多次成功编辑各自保留自己的后态。
 */
export declare function trackEdit(c: Continuity, path: string, body: string): void;
/** 检查结果快照(driver 在测试类 bash 命令的 tool/result 边界调用):只留本轮最后一次。 */
export declare function trackCheck(c: Continuity, command: string, resultText: string): void;
/** 读取后态快照(driver 在成功的 read tool/result 边界调用):同一路径只留最后一次。 */
export declare function trackRead(c: Continuity, path: string, body: string): void;
/**
 * 工具结果结算（driver 在每个 tool/result 边界调用，实时与重放两条路都要走）。
 * 最后一个结果说了算：失败留下正文，成功清空。正文过 redactText —— CURRENT
 * ERROR 段直接进上下文，和 tape 走同一条安全边界（SEAMS S1 Trust）。
 */
export declare function trackToolOutcome(c: Continuity, isError: boolean, text: string): void;
/** 本轮一步的推理链(模型自产,与 reply 同级——原样,不脱敏不截断)。 */
export declare function trackReasoning(c: Continuity, text: string): void;
/** 观测用：当前携带态的切片体积（tape 字符数 + 环行数）。 */
export declare function continuityStats(c: Continuity): {
    tapeChars: number;
    ringRows: number;
    files: number;
};
/**
 * 表面替换（canonical surface compaction）落实到携带态——按组件粒度：
 * patch.user 重写该轮的话题 goal（若出自该轮）、环行用户侧、以及 tape
 * digest 的 ask（按 sealMeta 原样再渲染）；patch.assistant 重写环行助手侧
 * 与 tape reply。未遮蔽的组件原样保留（用户侧替换不丢助手答复，反之亦然）；
 * 文件锚点（base/patch）不受影响。摘要停留在 HISTORICAL/CLAIM 权级的
 * tape 呈现层，绝不进入 CURRENT REQUEST 槽。
 */
export interface TurnCompaction {
    user?: string;
    assistant?: string;
}
/**
 * 一次表面替换遮蔽多轮时的塌缩（评审 #17）。
 *
 * 逐轮重渲会把同一段摘要复制 N 份 digest + N 份 reply——压缩本该缩小上下文，
 * 实测反而把 tape 撑大 9 倍（20 轮 × 800 字符摘要：3.4k → 31.7k）。这里把被
 * 遮蔽那批 digest/reply 整体移除，替换为一条 epoch 区间条目（复用 compactTape
 * 的 ref..refEnd 形状），摘要只出现一次。文件锚点（base/patch）不受影响——
 * 它们承载的是盘态而不是对话历史。
 *
 * 单轮遮蔽仍走 {@link compactTurn} 的逐条重渲：那时没有放大，且逐条重渲能保留
 * 该轮的 digest 元数据（status/files）。
 */
export declare function compactTurnSpan(c: Continuity, turns: readonly number[], summary: string, sessionId: string): void;
export declare function compactTurn(c: Continuity, turn: number, patch: TurnCompaction, sessionId: string): void;
