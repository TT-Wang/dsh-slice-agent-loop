/**
 * effort-default.ts — 插件级 reasoningEffort 默认注入(20260901 effort 阶梯实验落地)。
 *
 * 实验结论(docs/effort-ladder.md):low 档砍约一半输出 token,n1/n2 判卷全绿,
 * 且召回可及性探针证明 low 档在召回真必需时仍主动伸手 recall_turn(探索未塌缩);
 * max 档观测到一次 19.7K 输出爆炸(比 high 贵 65%,判卷无提升)。
 *
 * 注入语义(共识 Q4-b,镜像宿主 adapterDefaults 设计):
 *  - proposed.reasoningEffort 已定义 = 有人显式选择(AgentOptions / 恢复的 epoch
 *    header 中非默认标记的值 / agent-request waterfall 上的其他插件)——永不覆盖。
 *  - undefined = 无人选择(适配器默认在 requestProposal 已剥离)——注入插件默认。
 *  - 配置 'inherit' = 完全退出注入,回到适配器默认(high)。
 */
export const REASONING_EFFORT_DEFAULTS = ['off', 'low', 'high', 'max', 'inherit'];
/** 实验裁决的出厂默认:low。 */
export const DEFAULT_REASONING_EFFORT = 'low';
/**
 * 已解析模型声明的 reasoning 档位 id;返回 undefined 表示能力未知(路由未注册、
 * 适配器查询失败)。宿主 resolveCallWithInfo 对未声明的档位抛
 * UNSUPPORTED_REASONING_EFFORT,而 stock loop 只吞 NO_ADAPTER——注入前必须先问。
 * 模型不声明 reasoning 时返回空数组:任何档位都会被拒。
 */
export async function declaredEfforts(ctx, provider, model, signal) {
    try {
        const info = await ctx.llm.resolveModelInfo(provider, model, signal);
        return (info.reasoning?.efforts ?? []).map(item => String(item.id));
    }
    catch {
        return undefined;
    }
}
/** 无人显式选择 effort 时注入配置的默认档;显式值与 'inherit' 恒原样返回。 */
export function applyEffortDefault(proposed, configured) {
    if (configured === 'inherit')
        return proposed;
    if (proposed.reasoningEffort !== undefined)
        return proposed;
    return { ...proposed, reasoningEffort: configured };
}
