/**
 * state-ledger.ts — 世界状态循环(World-State Loop)的纯函数层。
 *
 * 上下文是状态,不是历史。本模块定义三样东西并负责它们的字节稳定渲染:
 *  - 宪法(Constitution):本轮用户请求原文 + 早期读取即钉住的文件 + 规则
 *    (原文 并且 可执行谓词)。一整轮逐字不变。
 *  - 世界状态账本(StateLedger):append-only。文件日志(每次读/写追加一行,
 *    "当前态" = 每路径最后一行)与事实账本(修正 = 追加新条目 + 旧条目打
 *    supersededBy 标记)。字节只增不改 → 前缀缓存友好。
 *  - 契约(Predicate):宿主在写文件后校验,违反即回滚并打回模型。
 *
 * 不做 I/O、不认识 driver。driver 负责从会话事件提取、组装请求、执行契约。
 */
export type FileAction = 'read' | 'write' | 'edit' | 'external' | 'reverted';
export interface FileRow {
    path: string;
    /** sha256 前 12 位;读取失败/不存在时为 '-'。 */
    sha: string;
    action: FileAction;
    step: number;
}
export type FactKind = 'rule' | 'fact' | 'decision' | 'file-state' | 'obligation';
export interface Fact {
    id: number;
    kind: FactKind;
    text: string;
    /** 出处摘要:绑定一条会话事件或一个文件区间。宿主提取的事实用 'host:<seq>'。 */
    sourceDigest: string;
    step: number;
    supersededBy?: number;
}
export interface StateLedger {
    /** append-only 文件事件日志。 */
    fileLog: FileRow[];
    /** append-only 事实。 */
    facts: Fact[];
    nextFactId: number;
}
export declare function createLedger(): StateLedger;
export declare function recordFile(ledger: StateLedger, row: FileRow): void;
/** 每路径的当前态(最后一行)。 */
export declare function currentFiles(ledger: StateLedger): Map<string, FileRow>;
export declare function addFact(ledger: StateLedger, input: Omit<Fact, 'id' | 'supersededBy'>): Fact;
/** 修正:追加新条目,旧条目打标。旧条目字节不变(只在其行尾追加 ⇒ 标记会改字节,
 *  所以标记渲染在新条目一侧:"#new supersedes #old")。 */
export declare function supersedeFact(ledger: StateLedger, oldId: number, input: Omit<Fact, 'id' | 'supersededBy'>): Fact;
/** 未被取代的事实。 */
export declare function liveFacts(ledger: StateLedger): Fact[];
export declare const STATE_HDR: string;
/**
 * 字节稳定渲染:文件日志与事实账本都只在尾部追加。同一账本状态两次渲染同字节;
 * 账本追加后,新渲染以旧渲染为前缀(不含结尾的分节空行以外的差异)。
 */
export declare function renderLedger(ledger: StateLedger): string;
export type Predicate = {
    kind: 'path-regex';
    glob: string;
    pattern: string;
} | {
    kind: 'content-includes';
    glob: string;
    needle: string;
} | {
    kind: 'content-excludes';
    glob: string;
    needle: string;
} | {
    kind: 'line-max';
    glob: string;
    max: number;
} | {
    kind: 'line-regex';
    glob: string;
    pattern: string;
    every: boolean;
} | {
    kind: 'field-enum';
    glob: string;
    field: string;
    values: string[];
};
export interface Rule {
    id: string;
    text: string;
    predicate?: Predicate;
}
export interface Constitution {
    request: string;
    /** 早期读取即钉住:前 N 步读取的文件全文。 */
    pinned: {
        path: string;
        text: string;
    }[];
    rules: Rule[];
}
export declare const CONSTITUTION_HDR: string;
export declare function renderConstitution(c: Constitution): string;
/** 极简 glob → RegExp:`**` 任意路径,`*` 单段,`?` 单字符。相对路径匹配。 */
export declare function globToRegExp(glob: string): RegExp;
/** 返回违反项说明;空数组 = 通过。谓词的 glob 不匹配该路径则跳过。 */
export declare function checkPredicates(rules: readonly Rule[], path: string, content: string): string[];
/** 防御式解析模型产出的规则 JSON:非法条目降级为纯文本规则(无谓词);整体非法返回 []。 */
export declare function parseRulesJson(text: string): Rule[];
/** 规则提取提示:给一次廉价模型调用。输出严格 JSON 数组。 */
export declare function rulesExtractionPrompt(c: Constitution): string;
