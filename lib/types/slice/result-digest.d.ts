/**
 * result-digest.ts — 注入时摘要(insertion-time digest)。
 *
 * v3「追加流」模式的核心杠杆:成本由每步**新增字节**决定(严格前缀缓存下命中价是
 * 未命中的 1/30),所以大工具结果在进入上下文之前就折成紧凑视图——头/尾若干行 +
 * 全部结构行(`key = value` / `key: value` / 标题行)+ 精确省略标记与召回指针。
 * 全文原样留在会话日志(recall_step 逐字取回);上下文里从此只有紧凑视图,且永不
 * 重写——append-only,缓存完美。
 *
 * 守卫:小结果不折;折后体量 ≥ 原文 × maxKeepRatio 也不折(折了不省就别折)。
 */
export interface DigestPolicy {
    /** 轮内折叠开关(slice / stream 模式默认开;state 模式不用)。 */
    enabled: boolean;
    /** 低于此字符数不折。 */
    minChars: number;
    headLines: number;
    tailLines: number;
    /** 折后 ≥ 原文的这个比例就放弃(不值一次省略)。 */
    maxKeepRatio: number;
    /**
     * 头部区之外,每个连续结构行块最多保留几行(其余并入省略)。Infinity = 不限。
     * 依据:字段型文件的"正文字段"在头部;深处成块出现的 key: value 多是附录表
     * (l2 记录里的 [prior-reconciliation] 块占了折后视图的一半),需要时一步可召回。
     */
    structuredBlockCap: number;
}
export declare const DEFAULT_DIGEST_POLICY: DigestPolicy;
export declare function looksLikeCodePath(path: string | undefined): boolean;
export declare function looksLikeCode(text: string): boolean;
export interface DigestResult {
    text: string;
    digested: boolean;
    totalLines: number;
    keptLines: number;
}
export declare function digestText(text: string, _recallHint: string, policy?: DigestPolicy): DigestResult;
export declare function resolveDigestPolicy(input: Partial<DigestPolicy> | undefined): DigestPolicy;
