/**
 * tool-result-fold — 给 dsh 默认 transcript loop 加"轮内折叠"的独立插件(2026-09-04)。
 *
 * 正式家在独立仓库 https://github.com/TT-Wang/dsh-tool-result-fold(`dsh plugin add github:TT-Wang/dsh-tool-result-fold`);
 * 这里的副本供本仓库的 runner(`--arm transcript-fold`)与契约测试使用,两边源码同源,改动请先改那边。
 *
 * 机制:每步开始前(`agent/pre-step`),把上一步刚落盘的工具结果按内容路由折成紧凑视图,以
 * **surface 替换事件**遮蔽原节点(`surfaceOp: replace`,引用被遮蔽的 seq)——与 dsh 自带的
 * compaction-tool-result-pruner 同一机制,会话不变量明确允许"引用被替换事件的内容改写"。
 * 原文原样留在日志里,`expand_result` 逐字取回;模型看到的上下文只追加不改写,前缀缓存不受影响。
 *
 * 路由规则复用 slice 的 result-digest(Headroom 式):代码与 grep/glob 不折,日志错误优先,
 * 文档/数据留头尾与结构行。默认 loop 不装 slice loop 也能用;两者不要同时挂(slice 自己折)。
 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
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
export declare const FOLD_AFFORDANCE = "<fold>\nYour context is append-only: nothing already in it is rewritten or dropped. Large tool results are condensed by the host as they enter. Data and document reads keep their first and last lines and every structured line (key = value, key: value, headings, section markers); build/test/log output keeps every error, failure and warning line with surrounding context, stack traces and summary lines; source code and grep/glob results are never condensed. Everything else is replaced by exact markers `\u2026[+N lines / M chars]\u2026`, and the view's first line names the call that returns the full result: expand_result({\"turn\": t, \"step\": s, \"call\": n}), durable and one call away; add \"grep\": <regex> or \"lines\": \"a-b\" to get just the part you need, which is far cheaper than the whole result. So read a whole file in one call rather than paging it with offset/limit \u2014 a full read costs no more context than its condensed view, while every page costs a step.\n</fold>";
/** 从日志取某步第 n 个追加态工具结果的原文(替换事件不算)。 */
export declare function fullResultAt(events: readonly SessionEvent[], turn: number, step: number, call: number): {
    name: string;
    text: string;
} | null;
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
