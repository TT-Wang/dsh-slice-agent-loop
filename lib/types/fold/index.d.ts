/**
 * tool-result-fold — 给 dsh 默认 transcript loop 加"轮内折叠"的独立插件(2026-09-04)。
 *
 * 机制:每步开始前(`agent/pre-step`,`prepend` 挂在最外层、拿到下游的 enter 判定之后才折),把上一步
 * 刚落盘的工具结果按内容路由折成紧凑视图,以 **surface 替换事件**遮蔽原节点(`surfaceOp: replace`,
 * 引用被遮蔽的 seq)——与 dsh 自带的 compaction-tool-result-pruner 同一机制,会话不变量明确允许
 * "引用被替换事件的内容改写"。
 * pre-step 路径把原文留在日志里,spill 路径把原文留在存储里;`expand_result` 逐字取回。
 * 已经发出的历史结果保持不变;新结果只在首次请求前折叠。检索返回的原文不再折叠。
 *
 * 路由规则复用 slice 的 result-digest(Headroom 式):代码不折,grep/glob 只在巨量命中时按文件配额折,
 * 日志错误优先,文档/数据留头尾与结构行。
 * 装载:默认 loop 不装 slice loop 也能用;slice loop 则无条件挂这一份副本(折叠只在这里做,slice 自己不折)。
 * 同一个 ctx 里不要再挂独立仓库那一份——两份都会注册 `expand_result`,重名注册直接失败。
 *
 * 定位(2026-09-09):折叠视图首行同时给出 `{turn, step, call}`(步内序号)和 `{seq}`(原结果的日志 seq,跨进程稳定);
 * `expand_result({"seq": N})` 接受折叠视图自己的 seq——顺着 sourceEventSeqs[0] 回到原文。
 *
 * spill 臂(tools/post-execute)改写的是**落盘前**的内容,日志里只剩视图;所以视图首行必须带 spill locator,
 * expand_result 从 locator 读回原文。做不到(没有 spill 后端 / 存储失败)就不改写,留给 pre-step 在 surface 上折。
 * 它与 pre-step 共用同一份退避/钉住状态:已退避的工具、钉住步里的小结果,这条路同样不折。
 *
 * 恢复(resume / 插件晚挂):folder 建立时日志里最后一个 request/header、assistant/message 或 assistant/attempt 之前的追加态结果,
 * 已经原样给模型看过(上一进程发过请求),第一次 pre-step 不再折它们——折了会让整段前缀改写、缓存全失;
 * 只折之后新落盘的结果。之前进程留下的折叠替换仍按 restoreFold 逐个认领计数,退避阈值跨进程一致。
 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
export { fullResultAt, originalResultAt, resultBySeq, spillLocatorOf, originalText } from './results.js';
import { type DigestPolicy } from '../slice/result-digest.js';
export declare const name = "tool-result-fold";
export interface Config {
    /** 关掉后插件只注册 expand_result,不折任何结果。 */
    enabled?: boolean;
    /** 折叠策略(阈值、头尾行数、日志上下文行数……),见 result-digest.ts。 */
    digest?: Partial<DigestPolicy>;
    /** 每轮前这么多步的工具结果不折(默认 2):任务的规则/说明文档几乎总在开头被读,l2 实测折掉规则段就全错。 */
    pinSteps?: number;
    /** 钉住步里仍然要折的体量(默认 8000 字符):规则/说明文档只有几 K(l1 的 MANIFEST 3K、l2 的规则 3.7K),而开头两步
     *  整页抓回来的 10–14K 文档、170K 的测试输出不是规则;f9 实测模型把 6 页都放在第 2 步抓,20000 的阈值让它们全被钉住。 */
    pinMaxChars?: number;
    /** spill 预览臂(默认 50000 字节,与 dsh-base 的 spill-policy maxInlineBytes 对齐;0 = 关):结果达到这个体量时,在 tools/post-execute
     *  就把原文存进 ctx.spillStore(有 spill 后端时),模型看到的是按内容路由的折叠视图 + 文件定位,而不是 spill-policy 的头尾预览。
     *  没挂 spill 后端时此臂不生效。read 结果与 spill-policy 同样跳过(它靠 pre-step 的 surface 替换折叠,原文留日志)。 */
    spillPreviewMinBytes?: number;
    /** 展开退避(默认 2):某个工具的折叠视图被 expand_result 取回这么多次、且取回率 ≥ 一半,本会话就不再折它的结果——
     *  s10 实测模型把 64 次折叠逐一取回,折了等于白折还多走一步。 */
    backoffAfterExpansions?: number;
}
export declare const EXPAND_TOOL_NAME = "expand_result";
/** 系统提示词里的可供性说明:模型得知道视图是折过的、原文一步可取。 */
export declare function foldAffordance(hasRecallStep: boolean): string;
export declare const FOLD_AFFORDANCE: string;
/** 部分取回(2026-09-04):按正则取匹配行(±2 行上下文)或按行号区间——比整份取回便宜得多;s10 的 64 次整份取回、f9 的散文事实都是它的场景。 */
export declare function partialByGrep(text: string, pattern: string, head: string): string;
export declare function partialByLines(text: string, range: string, head: string): string;
export declare function expandResultToolDefinition(): ToolDefinition;
/** 供 runner/评测读取:某会话的折叠统计。 */
export declare const FOLD_STATS: WeakMap<Session, {
    folded: number;
    charsBefore: number;
    charsAfter: number;
    expanded: number;
    backedOff: string[];
    spilled: number;
}>;
/** cordis 插件本体:声明注入的服务(tools、systemPrompt),挂载即生效,卸载即回收(ctx.effect)。 */
export declare class ToolResultFold extends Service {
    static inject: string[];
    constructor(ctx: Context, config?: Config);
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        toolResultFold: ToolResultFold;
    }
}
export default ToolResultFold;
