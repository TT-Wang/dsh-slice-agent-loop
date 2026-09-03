/**
 * step-tape.ts — 轮内封存(in-turn sealing)的纯函数层。
 *
 * 把 slice 在轮界做的事下沉到步级:一轮走到阈值后,最旧的一批步被折叠成
 * 封存条目——调用摘要 + 结果头尾 + 精确切口——原文留在会话日志,
 * `recall_step` 逐字取回。与 tape.ts 同一哲学:折叠但不丢失,构造即冻结。
 *
 * 本模块不做 I/O、不认识 driver;driver 负责"什么时候封、封哪些步、怎么把
 * 折叠后的消息拼回请求"。阈值经济学见 stepsToSeal。
 */
/** 每个工具结果在封存条目里保留的头/尾字符数(码点计,与 tape.ts 同口径)。 */
export declare const STEP_RESULT_HEAD_CHARS = 500;
export declare const STEP_RESULT_TAIL_CHARS = 160;
/** 封存步里助手可见文本的头部保留。 */
export declare const STEP_ASSISTANT_HEAD_CHARS = 320;
/** 调用参数预览的单行上限。 */
export declare const STEP_ARGS_PREVIEW_CHARS = 160;
/** 头 + 精确切口标记 + 尾;不超长则原样。标记里的 N 是被切掉的码点数。 */
export declare function cutHeadTail(text: string, head: number, tail: number, unit: string): string;
/** 参数原文压成单行预览(JSON 原样,只折行与截尾)。 */
export declare function argsPreview(raw: string, cap?: number): string;
export interface SealedCall {
    name: string;
    /** 模型产出的原始 JSON 参数串。 */
    arguments: string;
    resultText: string;
    isError: boolean;
}
export interface SealedStepInput {
    step: number;
    /** 该步助手消息的可见文本(不含推理)。 */
    assistantText: string;
    calls: readonly SealedCall[];
    /** 该步期间到达的轮内用户插话(steer / inject),按序。 */
    interjections: readonly string[];
}
/** 一步的封存条目。首行固定为 `[step N]`,便于 recall_step 对应。 */
export declare function renderSealedStep(turn: number, s: SealedStepInput): string;
export declare const STEP_TAPE_HDR: string;
/** 封存块正文:标题 + 条目按序拼接。条目 append-only,拼接结果对同输入字节稳定。 */
export declare function renderStepTape(entries: readonly string[]): string;
export interface SealPolicy {
    enabled: boolean;
    /** 轨迹估算 tokens 达到此值才考虑封存(缓存里的旧字节按命中价近乎免费,低于此值封存是亏本买卖)。 */
    sealTokens: number;
    /** 每次封存的步数(批量摊销一次性的轨迹重建 miss)。 */
    batchSteps: number;
    /** 始终保留原文的最近步数。 */
    keepSteps: number;
    /** 轮内「宪法」保护:前 N 步(规则确立/清单读取)永不折叠。跨轮 seed 永不
     *  折叠的步内类比。v2 重载荷 A/B 实证:折叠 manifest 步 → 模型丢规则
     *  (l1 42/45、l2 0/45),即使 recall_step 可用也补不回。 */
    protectEarlySteps: number;
}
export declare const DEFAULT_SEAL_POLICY: SealPolicy;
/** 封存批次的渲染体量必须 ≤ 原文的这个比例才值得(否则折叠只多付一次缓存重建
 *  而不省上下文——l1 长链病态:结果比 head+tail 保留窗还短)。 */
export declare const SEAL_MIN_SAVE_RATIO = 0.6;
/** 这批封存是否划算:sealedChars 相对被移除的 rawChars 至少省下 (1-ratio)。 */
export declare function sealSavesEnough(rawChars: number, sealedChars: number, ratio?: number): boolean;
/** 轨迹字符 → token 的保守估算(代码 + CJK 混合;归因实测 2.5–4.2)。 */
export declare const SEAL_CHARS_PER_TOKEN = 3.2;
/**
 * 本次请求前应封存的步数。0 = 不动。
 * 条件:启用 && 轨迹 ≥ 阈值 && 未封存的已完成步 ≥ batch + keep;
 * 封 batch 步,且封完仍保留 ≥ keep 步原文。
 */
export declare function stepsToSeal(policy: SealPolicy, trajectoryChars: number, unsealedCompletedSteps: number, consideredThrough: number): number;
export declare function resolveSealPolicy(input: Partial<SealPolicy> | undefined): SealPolicy;
