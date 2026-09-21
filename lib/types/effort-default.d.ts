/**
 * Optional plugin reasoning default. Factory configuration inherits the host's
 * model/profile choice; context retention does not choose a reasoning budget.
 * Explicit request efforts always win. An explicitly configured plugin default
 * is injected only when the resolved model declares it (see index.ts).
 */
import type { Context } from '@deepseek-ai/cordis';
export type ReasoningEffortDefault = 'off' | 'low' | 'high' | 'max' | 'inherit';
export declare const REASONING_EFFORT_DEFAULTS: readonly ReasoningEffortDefault[];
/** Leave the reasoning budget to the host unless explicitly configured. */
export declare const DEFAULT_REASONING_EFFORT: ReasoningEffortDefault;
/**
 * 已解析模型声明的 reasoning 档位 id;返回 undefined 表示能力未知(路由未注册、
 * 适配器查询失败)。宿主 resolveCallWithInfo 对未声明的档位抛
 * UNSUPPORTED_REASONING_EFFORT,而 stock loop 只吞 NO_ADAPTER——注入前必须先问。
 * 模型不声明 reasoning 时返回空数组:任何档位都会被拒。
 */
export declare function declaredEfforts(ctx: Context, provider: string, model: string, signal?: AbortSignal): Promise<string[] | undefined>;
/** 无人显式选择 effort 时注入配置的默认档;显式值与 'inherit' 恒原样返回。 */
export declare function applyEffortDefault<T extends {
    reasoningEffort?: unknown;
}>(proposed: T, configured: ReasoningEffortDefault): T;
