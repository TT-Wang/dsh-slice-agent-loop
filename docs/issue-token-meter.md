# [bug][core] token-meter 对"请求远小于 surface"的 loop 系统性高估：偏差随轮数单调放大（第 6 轮 30×，无收敛）

## 问题现象

`ctx.tokenMeter.measure()` 报告的 `totalTokens` 在**模型请求显著小于会话 surface** 时不反映真实请求规模，而是趋近 surface 规模，且**偏差随轮数单调放大、不收敛**。

最小复现（每轮真实请求恒定 4,000 tokens，surface 每轮增长 20,000）：

```text
turn | provider 真实 | meter.totalTokens | baseline  | 偏差
  1  |     4000     |       24067       | usage     |  6.0×
  2  |     4000     |       40034       | estimated | 10.0×
  3  |     4000     |       60051       | estimated | 15.0×
  4  |     4000     |       80068       | estimated | 20.0×
  5  |     4000     |      100085       | estimated | 25.0×
  6  |     4000     |      120102       | estimated | 30.0×
```

provider 每轮如实上报 `usage.inputTokens = 4000`，`assistant/message` 事件也如实落账，但 `measure()` 的读数与它无关。

## 复现步骤

把下面的脚本存成 `repro-token-meter.mts` 放在 **harness 仓库根目录**下直接跑——workspace 的 `node_modules` 里已有 `dsh-session` / `dsh-llm` / `dsh-token-meter`，无需额外安装：

```bash
cd ~/.dsh/source/current          # 或你的 harness checkout 路径
npx tsx ./repro-token-meter.mts
```

实测于快照 `20260810T155924Z`（commit `f4efff3d`）。

```ts
import { Context } from 'cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LlmService, { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

const ctx = new Context()
await ctx.plugin(LlmService); await ctx.plugin(SessionStore); await ctx.plugin(TokenMeter)
const s = ctx.sessions.create(SessionId('m'))
s.append('request/header', { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' })

const REAL = 4_000   // 每轮真实请求恒定（有界上下文 loop 的正常状态）
for (let turn = 1; turn <= 6; turn++) {
  s.append('turn/start', { turn })
  s.append('step/start', { turn, step: 1 })
  s.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'X'.repeat(80_000) }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  s.append('assistant/message', {
    turn, step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider: 'p', model: 'm' } }),
    usage: { inputTokens: REAL, outputTokens: 50, cacheReadTokens: 0 },
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
  s.append('step/end', { turn, step: 1 })
  s.append('turn/end', { turn, reason: { kind: 'completed' } })
  const m = ctx.tokenMeter.measure(s)
  console.log(turn, REAL, m.totalTokens, m.baseline.kind)
}
```

## 预期行为 vs 实际行为

- **预期**：provider 逐轮如实上报 usage 时，`totalTokens` 应跟踪真实请求规模（或至少不随一个与请求规模无关的量单调发散）。
- **实际**：`totalTokens` 跟踪的是 surface 规模，与真实请求的比值随轮数线性增长，无上界。

## 根因

`packages/llm/token-meter/src/index.ts` 的两处，共同建立在同一条隐含假设上——**「模型请求 ≈ surface」**：

**1. `measure()` 的合成式（:126-135）**

```ts
if (anchor !== undefined && optionalHeaderEquals(anchor.header, header)) {
  baseline = anchor.baseline
  surfaceDeltaTokens = state.surfaceTokens - anchor.surfaceTokens   // ← 这里
}
```

`totalTokens = baseline + surfaceDeltaTokens`。把「上次请求的真实用量」加上「此后 surface 的增长」，等价于断言 *surface 的增长会等量进入下一次请求*。对重放全量历史的 loop 成立；对每轮重建有界上下文的 loop 不成立——那里 surface 增长与下次请求规模无关。

**2. anchor 的保守判据（:244-248）**

```ts
// Signed heuristic deltas remain conservative only from an anchor
// that is at least as large as the matching full heuristic price.
baseline: providerTokens >= estimatedAnchorTokens
  ? { kind: 'usage', tokens: providerTokens, usage: event.data.usage }
  : { kind: 'estimated', tokens: estimatedAnchorTokens },
```

这道护栏假设「真实用量小于全量启发式估算」是估算陈旧的信号，于是丢弃真实用量。但对请求本就远小于 surface 的 loop，**「真实用量远小于估算」恰恰是正确且正常的状态**——护栏因此反向误伤：请求越小（越符合设计意图），越会被判定为「估算更可信」。上表第 2 轮起 `baseline.kind` 从 `usage` 翻转为 `estimated`，正是这条判据。

两处都不是实现错误，而是**一条针对 transcript 式 loop 的语义假设被硬编码进了通用计量服务**。

## 影响

面向**任何非 transcript 架构的 agent loop**，不限于某一个插件：

1. **自动压缩阈值失真**——`packages/compact/compact-basic/src/index.ts:304`、`:312` 用 `measurement.totalTokens < spec.thresholdTokens` 决定是否压缩。读数被高估数十倍时，压缩会在完全没有必要时反复触发；而压缩本身要重写历史头部，连带打掉 prefix cache。
2. **UI 上下文占用显示失真**——同一 measurement 驱动占用环/状态条（另见 #308、#498，那两条是同一模块的*时序*问题，本条是*量值*问题，机制与文件均不同）。
3. **偏差不收敛**——不是一次性误差，而是随会话长度线性发散，长会话下读数完全失去意义。
4. 依赖 `ctx.tokenMeter` 做预算/门控的下游（如 #291 的 workflow 预算、#294 的分级预警）在这类 loop 上同样不可用。

架构上值得一提：DSH 已经把 agent loop 做成可替换插件（`ctx.agents.setFactory`），但周边计量设施仍假设 loop 是 transcript 式的。这条假设没有在任何接口上声明，替换 loop 的一方在读数明显不对之前不会察觉。

## 建议

按侵入性从小到大：

1. **让 loop 声明本次请求的真实规模。** 提供一个可选上报口（例如 `request/header` 或 `assistant/message` 上带一个由 loop 填写的 `requestTokens`，或一个 `tokenMeter.report(...)` 调用）。有上报就以上报为准，无上报保持现有启发式——对现有 loop 完全无行为变化。
2. **放宽 anchor 判据。** 当 `header` 与本次请求匹配、且 usage 来自该请求时采信真实 usage，不再要求它 ≥ 全量估算；把保守性收窄到「header 不匹配」这一真正需要防御的情形。
3. **让 `surfaceDeltaTokens` 可关闭。** 增加一个「surface 增长不进入下次请求」的模式标记（由 loop 或 deployment 声明），此模式下 `totalTokens` 直接取最近一次真实 usage。

任选其一即可解除下游失真；(1) 对现有行为最安全。

## 证据链

| # | 类型 | 层级 | 强度 | 定位 | 摘录 |
|---|------|------|------|------|------|
| E1 | 动态复现 | 组件级 | 直接 | 上文 repro-token-meter.mts（harness 根目录，快照 f4efff3d） | 6 轮，真实恒定 4,000，meter 读数 24,067→120,102，偏差 6×→30× 单调放大 |
| E2 | 源码链 | 源码级 | 直接 | `token-meter/src/index.ts:126-135` | `surfaceDeltaTokens = state.surfaceTokens − anchor.surfaceTokens`，surface 增长直接计入 total |
| E3 | 源码链 | 源码级 | 直接 | `token-meter/src/index.ts:244-248` | 保守判据丢弃 `providerTokens < estimatedAnchorTokens` 的真实 usage；注释自述意图为「保持有符号启发式增量的保守性」 |
| E4 | 下游影响 | 源码级 | 直接 | `compact/compact-basic/src/index.ts:304,312` | 压缩触发直接比较 `measurement.totalTokens` 与阈值 |
| E5 | 反证排除 | 源码级 | 负向 | token-meter README / 注释 | 未见「请求 ≈ surface」这一前提的显式声明，也未见针对非 transcript loop 的说明 |

## 备注

上报方是内测成员，正在实现一个每轮重建有界上下文的替代 agent loop（`ctx.agents.setFactory` 路径），因此撞上这条。当前只能绕过：用插件自有 durable 事件重新计量一遍自己的真实请求规模，并在文档中把 `ctx.tokenMeter` 标为该 loop 下不可用。上面的复现刻意不依赖该插件，纯用 `dsh-session` / `dsh-llm` / `dsh-token-meter` 构造，以便独立验证。
