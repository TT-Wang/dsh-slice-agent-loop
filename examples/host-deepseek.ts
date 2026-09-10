/**
 * 例子共用的 DeepSeek 适配器接线。
 *
 * 两个前提，例子自己无法降级绕开：
 *  1. `@deepseek-ai/dsh-llm-deepseek` 只存在于宿主 checkout，不在本仓已发布的
 *     alpha 依赖闭包里（pnpm-lock 没有它）。先跑 `npm run link:dsh` 把宿主的
 *     peer 软链进 node_modules，再跑例子。
 *  2. API key 从 `DEEPSEEK_API_KEY` 读。以前这里是拿正则去扒
 *     `~/.sliceagent/config.toml` 里的明文 api_key —— 例子不该教人这么干。
 *
 * 适配器用「变量当 specifier」的动态 import：TypeScript 不解析非字面量
 * specifier，于是 `tsconfig.scripts.json` 能把这些例子的其余部分真正查一遍，
 * 而不必因为一个只在宿主里存在的包整体放弃门禁。
 */

const ADAPTER_MODULE = '@deepseek-ai/dsh-llm-deepseek'

export const PROVIDER = 'deepseek-official'
export const MODEL = 'deepseek-v4-flash'

export function requireApiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY
  if (key === undefined || key === '') {
    throw new Error('DEEPSEEK_API_KEY is not set. Export it before running this example.')
  }
  return key
}

interface LlmRegistry {
  registerAdapter(providers: string[], adapter: unknown): void
}

/** Register the DeepSeek adapter for {@link PROVIDER} on a booted cordis context. */
export async function registerDeepSeek(llm: LlmRegistry, apiKey: string, model = MODEL): Promise<void> {
  let mod: Record<string, any>
  try {
    mod = await import(ADAPTER_MODULE)
  } catch (cause) {
    throw new Error(
      `Cannot load ${ADAPTER_MODULE}. It ships with the DeepSeek Harness checkout, not with this repo's `
      + 'published dependencies — run `npm run link:dsh` (see scripts/link-dsh.mjs) first.',
      { cause },
    )
  }
  const { DeepSeekAdapter, PUBLIC_BASE_URL, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } = mod
  llm.registerAdapter([PROVIDER], new DeepSeekAdapter({
    options: () => ({
      baseURL: PUBLIC_BASE_URL,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaults: {},
      maxTokens: DEFAULT_MAX_TOKENS,
      defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      models: [{ id: model, name: model, contextWindow: DEFAULT_CONTEXT_WINDOW }],
      retryPolicy: { attempts: 1, initialDelayMs: 0, backoff: 1, maxDelayMs: 0 },
    }),
    resolveApiKey: async () => apiKey,
  }))
}
