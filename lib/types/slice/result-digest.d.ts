/**
 * result-digest.ts — 注入时摘要(insertion-time digest)。
 *
 * v3「追加流」模式的核心杠杆:成本由每步**新增字节**决定(严格前缀缓存下命中价是
 * 未命中的 1/30),所以大工具结果在进入上下文之前就折成紧凑视图;全文原样留在会话
 * 日志(recall_step 逐字取回);上下文里从此只有紧凑视图,且永不重写——append-only。
 *
 * 2026-09-03 按内容类型分路由(抄自 Headroom 的 ContentRouter / LogCompressor 思路):
 *   code   → 不折(代码是混合文本,残缺函数体会让模型编错;Headroom 同样把 Read/Edit 排除在外)
 *   search → 不折(grep/glob 的每一行都是命中,头尾视图会藏掉匹配)
 *   log    → 错误优先:ERROR/FAIL/WARN 行 + 前后 contextLines 行 + 紧随的栈帧 + 摘要行,
 *            相似行去重(保留消息前缀,归一化数字/十六进制/路径),头 3 尾 6;512 字节起折
 *   data   → 头/尾 + 结构行(`key = value` / `key: value` / 标题 / 段标记);头部区外的
 *            结构块按"键的新颖性"自适应保留(同形附录块只留前几行),1500 字符起折
 *
 * 守卫:小结果不折;折后体量 ≥ 原文 × maxKeepRatio 也不折(折了不省就别折)。
 */
export type ContentKind = 'code' | 'search' | 'log' | 'data';
export interface DigestPolicy {
    /** 轮内折叠开关(slice / stream 模式默认开;state 模式不用)。 */
    enabled: boolean;
    /** data 类低于此字符数不折。 */
    minChars: number;
    headLines: number;
    tailLines: number;
    /** 折后 ≥ 原文的这个比例就放弃(不值一次省略)。 */
    maxKeepRatio: number;
    /** 头部区之外,每个连续结构行块最多保留几行(自适应保留的上限)。Infinity = 不限。 */
    structuredBlockCap: number;
    /** 每个结构块至少保留几行(自适应保留的下限)。 */
    structuredBlockMin: number;
    /** log 类低于此字符数不折(Headroom:512 B)。 */
    logMinChars: number;
    /** log 类最多保留多少条错误/失败行(首条与末条必留)。 */
    logMaxErrors: number;
    /** log 类每条保留行前后带的上下文行数。 */
    logContextLines: number;
    /** data 类超过这么多字符的单行按字符头尾截断(压缩 JSON / base64 / 长 CSV 行 / 无换行的 blob;
     *  2026-09-03 s13 的 9K 字符 3 行 blob 按行判全被留下)。Infinity = 不截。 */
    maxLineChars: number;
    /** 超长行保留的头部 / 尾部字符数。 */
    lineHeadChars: number;
    lineTailChars: number;
}
export declare const DEFAULT_DIGEST_POLICY: DigestPolicy;
export declare function looksLikeCodePath(path: string | undefined): boolean;
export declare function looksLikeCode(text: string): boolean;
export declare function detectContentKind(text: string, path?: string): ContentKind;
export interface DigestResult {
    text: string;
    digested: boolean;
    totalLines: number;
    keptLines: number;
    kind: ContentKind;
}
export declare function digestData(text: string, policy?: DigestPolicy): DigestResult;
export declare function digestLog(text: string, policy?: DigestPolicy): DigestResult;
/** 兼容入口:按 data 规则折(旧调用方与测试)。 */
export declare function digestText(text: string, _recallHint: string, policy?: DigestPolicy): DigestResult;
/** 工具结果入口:按工具名与内容类型路由。 */
export declare function digestToolResult(text: string, source: {
    tool: string;
    path?: string;
}, policy?: DigestPolicy): DigestResult;
export declare function resolveDigestPolicy(input: Partial<DigestPolicy> | undefined): DigestPolicy;
