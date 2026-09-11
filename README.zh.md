# dsh-slice-agent-loop

[English](README.md)

面向 **DeepSeek Harness 0.1.3-alpha.2** 的有界对话上下文策略。它与原生 agent loop 并行运行，生命周期、调度器、收件箱、持久化、请求序列与完整请求重建不变量全部保留在宿主侧。

历史保持原样。低于 `history.highWaterChars` 时插件**什么都不追加**，每次模型请求都是上一次请求的逐字节追加延伸，和原生 loop 完全一样。请求视图超过这个水位后，下一轮第一步发生一次归档事件：最旧的已完成轮被替换成**一条**冻结的 `[slice checkpoint v1 …]` `user/message` surface replacement，视图回到 `history.lowWaterChars` 以下。指令消息、当前用户输入、用户多模态消息、第 1 轮的用户消息与**最新的**运行时上下文快照（宿主本步正在追加的那个，否则是 surface 上最新的那个）保留原来的来源与位置。已被宿主取代的运行时快照在压力事件之前像原生 loop 一样留在 surface 上；归档时它们被吸收进 checkpoint（最多一行说明，绝不当成用户请求渲染），其原文仍可经 `recall_turn` 取回。原始事件留在会话日志里；归档、折叠或恢复之后由 `recall_turn` / `recall_search` 取回。

## 安装与组合

用 DSH 的插件安装器安装本仓库，并应用它的 `cordis.patch.yml` bundle。该 patch **只新增插件**。**保持 `agent-loop`、`agent-loop-invariant` 与原生 session projections 启用。** Git 包内含已生成的 `lib/` 产物。

本包已经自带一份工具结果折叠，和独立插件 [`dsh-tool-result-fold`](https://github.com/TT-Wang/dsh-tool-result-fold) 同源，也以 `./fold` 导出。**不要在同一个 profile 里再装那个独立插件**：两者都会注册 `expand_result`，第二次注册会在加载时直接失败（`tool "expand_result" is already registered`）。只有想在不装 slice 策略的原生 loop 上单独用折叠时，才单独挂 `./fold`（或那个独立插件）。

```yaml
- id: slice-agent-loop
  name: '@dsh-external/dsh-slice-agent-loop'
  config:
    maxRequestChars: 400000
    maxStepsPerTurn: 50
    defaultReasoningEffort: low
    history:
      highWaterChars: 300000
      lowWaterChars: 150000
      keepRecentChars: 60000
```

| 配置项 | 含义 |
|---|---|
| `history.highWaterChars` / `lowWaterChars` | 序列化视图超过 `highWaterChars`（默认 300,000）之前历史原样追加；超过后把最旧的已完成轮归档成冻结的 `[slice checkpoint v1 …]` 消息，直到回到 `lowWaterChars`（默认 150,000）以下。相邻两次归档之间至少间隔 `highWaterChars - lowWaterChars` 的新增历史。 |
| `history.keepRecentChars` | 原始记录累计达到这么多字符的最近若干完整轮（默认 60,000，至少一轮）保持原样；只有请求否则会超过 `maxRequestChars` 时，才作为降级步骤把它们也归档。 |
| `history.pinFirstTurn` / `pinUserChars` / `checkpointMaxChars` | 第 1 轮用户消息保持原样（默认 true）；不超过 `pinUserChars`（默认 1,200）的被归档用户消息在 checkpoint 里逐字保留；`checkpointMaxChars`（默认 8,000）是单个 checkpoint 的目标大小。 |
| `maxHistoryChars` | 渲染后历史（checkpoint 加保留的原样轮）的可选额外软上限。没有默认值，只由水位驱动归档。旧配置里的 `120000` 应删除，除非你想在 `highWaterChars` 以下就归档。 |
| `maxRequestChars` | 序列化模型 **messages** 的硬上限（默认 400,000），含受保护上下文与当前输入。它是字符上限，不是 token 估算；system prompt／工具 schema 与模型容量仍归宿主。 |
| `maxStepsPerTurn` | 超过这么多模型步就停止派发；默认 50。 |
| `defaultReasoningEffort` | `off`、`low`、`high`、`max` 或 `inherit`；宿主／模型的显式选择优先。**受模型能力门控**：只有已解析模型声明了该档位时才注入。模型未声明（或根本不声明 reasoning）时沿用适配器默认，并按路由告警一次；若能力查询本身失败，则静默沿用适配器默认（`src/effort-default.ts` 的 `declaredEfforts` 在任何异常上返回 `undefined`，只有拿到能力表时才告警）。|
| `digest` | 内容路由选项，见 `src/slice/result-digest.ts`。 |
| `fold` | 工具结果折叠选项，含 `enabled`、`pinSteps`、`pinMaxChars`、`spillPreviewMinBytes`、`backoffAfterExpansions`。 |

归档在一轮的第一步决定——轮中改写会改掉本轮已经付过钱的前缀；之后的步骤只有在请求否则会超过 `maxRequestChars` 时才作为最后手段归档。整次归档先全部规划、再追加替换，所以被拒绝的请求不会留下半归档的 surface。受保护节点永不归档；工具调用未全部配对的轮保持原样并切断归档段（走插件的 `warn` 通道打日志）。拒绝之前先做确定性降级，每一级只在上一级装不下 `maxRequestChars` 时才尝试：先归档到水位；再把最近尾部也归档；最后归档全部已完成轮并省略 checkpoint 正文（`recall_turn` 仍能取回每一轮）。降级会走 `warn` 打日志。只有受保护底座加当前输入本身就装不下时，请求构造才以 `SliceBudgetError` **明确失败**；不截断任何内容，持久记录不变，但之后每一轮都会同样失败，直到调大 `maxRequestChars`、缩小受保护上下文或开新会话。插件不会静默返回超限视图。预算拒绝前先记录当前输入。

`recall_search` 搜索原始的用户与助手文本、生成的上下文（插件产生的 user 角色消息，如运行时快照；两轮之间投影的快照归属刚结束的那一轮）、工具输入与工具错误（见 `src/recall.ts` 的 `DEFAULT_SEARCH_KINDS`）。默认 `scope: "auto"` 也收录普通工具**输出**，但只通过有界槽位（最多 `TOOL_OUTPUT_SLOTS` = 3 条、每条 `TOOL_SNIPPET_CHARS` = 600 字符），因为工具输出是会话里体量最大、信噪比最低的文本；`scope: "dialogue"` 跳过它，显式 `kinds` 优先于 scope。召回工具自己的输入与输出从不入索引。每条命中都给出后续调用。`recall_turn` 返回一整轮：`view: "full"`（默认）含原始记录与工具元数据，`view: "dialogue"` 只给每条用户与助手文本一次、工具结果以定位符表示。`recall_step` 取回某一步。`expand_result` 按 `{seq}`（折叠视图与 checkpoint 里给出的持久日志 id）或按 turn/step/call 序号精确取回工具结果，可按行或正则过滤。带 spill 定位符的工具结果用其预览里给出的定位符。

## 从 0.0.1 迁移

- 删掉旧的、停用原生 loop 与不变量的 override，改用新的增量 bundle。
- 把 `maxParallelToolCalls` 等调度配置移到原生 `agent-loop` 行。
- `mode: state`、`mode: stream`、`state`、`tape`、`inTurnSeal` 已退役，加载时报错。不安全的宿主文件快照与写入回滚实现已删除。
- 私有的 `sliceContext.contribute` 注册表已退役。改用宿主的 system-prompt／runtime-context 扩展，让来源身份与持久化归 DSH。
- 原生不变量与本包的兼容导出 `./invariant` **二选一挂载，不要都挂**。两者装的是同一套完整重建检查。
- 历史策略从逐轮 span 替换改为压力触发归档。`maxHistoryChars` 不再有默认值，只是可选的额外软上限；旧配置里的 `maxHistoryChars: 120000` 应删除，除非你想在 `history.highWaterChars` 以下就归档。旧的逐轮策略写下的会话，其 `# SESSION TAPE` 替换仍留在 surface 上；归档把它们当作普通的可归档历史。
- 旧日志里含 required `slice/*` 事件的，仍需原来的 reader 或显式迁移。本次发布不改写宿主的已知事件词汇表，也不改写旧会话文件。

文件读取是记录下来的窗口，写入／编辑元数据含 diff 片段。它们是历史观察，不能证明文件当前全文，也不能证明后端身份。完整 base／免重读指针类优化保持关闭，直到宿主提供带完整 provider 文本、目标身份与版本的持久观察通道。见 [记录式记忆](docs/recorded-memory.md)。

## 开发与验证

使用 Node `^22.19.0 || >=24.0.0` 与 pnpm 11.7.0：

```sh
pnpm install --frozen-lockfile
npm run typecheck
npm test
npm run build
```

公开的 alpha.2 依赖锁在 `pnpm-lock.yaml` 里；**不需要维护者的本地检出，也不需要任何绝对依赖路径**。CI 对着这些已发布包跑完整测试，包括原生 loop 不变量与真实 JSONL 关闭／恢复。构建会先清掉过期的生成文件再产出 Git 安装用的产物。

`npm run verify:packed` 跑一遍免密钥的标准安装器／Loader／JSONL 冒烟；`npm run verify:master -- /path/to/deepseek-harness` 对着一份准备好的上游源码检出跑。[已记录的升级验证](docs/upgrade-verification.md) 把已发布版本、源码 master、打包产物三类证据分开陈述。

`verify:packed` 的前置条件：pnpm 11.7.0（由 `packageManager` 固定，建议开启 corepack；版本不符会直接失败，除非设置 `SLICE_PACKED_ALLOW_PNPM_MISMATCH=1`）；能访问 npm registry（它会把已发布的 `@deepseek-ai/dsh` 0.1.3-alpha.2 装进一个全新的临时工作区）；以及 JSONL 持久化原生插件 `fs-ext` 构建所需的工具链（冒烟会执行它的 install 脚本）。每一步有 180 秒预算（可用 `SLICE_PACKED_STEP_TIMEOUT_MS` 覆盖），冷启动安装需要到 registry 的连接够快。运行结束会打印证据目录。

原生回归套件覆盖：运行时上下文的保留／更新／移除、不透明指令来源归属、多模态输入、重试与 steering、请求序列切换、admission 失败、卸载，以及不带插件恢复会话。另有一个测试验证：改动后续消息会被原生不变量拒绝派发。

低于 `highWaterChars` 时，每次请求的缓存前缀就是上一次请求的全部；它只在归档事件（断在第一个被替换的节点）和宿主自己的 surface 改写（例如工具结果折叠）处断开。这是结构性质，**不是普适的缓存命中或成本保证**：provider 缓存、运行时上下文的变动频率与归档频率仍决定账单。[早期自建 loop 的实测](docs/legacy-loop.zh.md) 属历史记录。本次迁移改变了策略，那些数字需要在新架构上重跑模型质量／成本实验后才能重新引用。
