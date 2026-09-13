# dsh-slice-agent-loop

[English](README.md)

面向 **DeepSeek Harness 0.1.3-alpha.2** 的有界对话上下文策略。它与原生 agent loop 并行运行，生命周期、调度器、收件箱、持久化、请求序列与完整请求重建不变量全部保留在宿主侧。

历史是一条只追加的磁带。每轮的**第一步**，把超出 `history.keepRecentTurns`（默认 0，也就是刚结束的那一轮）的每个已完成轮**在它自己的位置上**封成**一条**冻结的 `[slice tape v1 …]` `user/message` surface replacement。已经在 surface 上的条目**永不重渲染、也不会被套进新条目里**，所以封存总是落在已写内容之后：每次请求都保住上一次请求的前缀，只为新写的那一条重新计费，而不是整个视图。这正是这套策略的全部理由——在前面改写一次，后面每个字节都要重新计费。指令消息、当前用户输入、用户多模态消息、第 1 轮的用户消息与**最新的**运行时上下文快照（宿主本步正在追加的那个，否则是 surface 上最新的那个）保留原来的来源与位置。已被宿主取代的运行时快照，在它所属的那一轮封存时被一起吸收（最多一行说明，绝不当成用户请求渲染），其原文仍可经 `recall_turn` 取回。原始事件留在会话日志里；封存、折叠或恢复之后由 `recall_turn` / `recall_search` 取回。

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
      keepRecentTurns: 0
      pinFirstTurn: true
      entryMaxChars: 8000
```

| 配置项 | 含义 |
|---|---|
| `history.keepRecentTurns` | 尾部保持原样的已完成轮数（默认 0：一轮在下一轮第一步就被封存）。调大它，是用「前缀稳定的字节」换「逐字的新近内容」——被保留的轮在封存之前每次请求都要整段重读，封存时又一次性合成一段。这里没有要跨过的水位，也没有要回落到的目标大小：封存是无条件的，一次封存只花掉它新写的那一条——只有下面的降级层级会更贵。 |
| `history.pinFirstTurn` / `pinUserChars` / `entryMaxChars` | 第 1 轮的用户消息保持为未经改动的追加节点（默认 true；该轮的 assistant／工具运行仍可封存）。不超过 `pinUserChars`（默认 1,200）的被封存用户消息在条目里逐字保留，超过的保留头 600 / 尾 300，中间留一个 `recall_turn` 标记。`entryMaxChars`（默认 8,000）是单条条目文本的**目标**：渲染器先丢工具行、再逐级收窄摘录，许多短轮合成的一段仍可能超过它。 |
| `maxHistoryChars` | 渲染后历史（条目加保留的原样轮文本）的可选额外上限。没有默认值。封存本身从不改写已写条目，所以要满足这个上限只能把它们**全部重写**——超过它会直接落到下面最后一级降级，下一次请求整段前缀失效，并走 plugin logger 告警。除非硬性的历史上限比缓存更重要，否则不要设它（旧配置里的 `120000` 应删除）。 |
| `maxRequestChars` | 序列化模型 **messages** 的硬上限（默认 400,000），含受保护上下文与当前输入。它是字符上限，不是 token 估算；system prompt／工具 schema 与模型容量仍归宿主。 |
| `maxStepsPerTurn` | 超过这么多模型步就停止派发；默认 50。 |
| `defaultReasoningEffort` | `off`、`low`、`high`、`max` 或 `inherit`；宿主／模型的显式选择优先。**受模型能力门控**：只有已解析模型声明了该档位时才注入。模型未声明（或根本不声明 reasoning）时沿用适配器默认，并按路由告警一次；若能力查询本身失败，则静默沿用适配器默认（`src/effort-default.ts` 的 `declaredEfforts` 在任何异常上返回 `undefined`，只有拿到能力表时才告警）。|
| `digest` | 内容路由选项，见 `src/slice/result-digest.ts`。 |
| `fold` | 工具结果折叠选项，含 `enabled`、`pinSteps`、`pinMaxChars`、`spillPreviewMinBytes`、`backoffAfterExpansions`。 |

封存在一轮的第一步决定——轮中改写会改掉本轮已经付过钱的前缀；之后的步骤只有在请求否则会超过 `maxRequestChars` 时才作为最后手段封存（轮中通常没有新的可封存内容，而单独一轮自己就撑爆预算时仍然拒绝）。整次封存先全部规划、再追加替换，所以被拒绝的请求不会留下半封存的 surface。受保护节点永不封存；工具调用未全部配对的轮保持原样并切断封存段（走插件的 `warn` 通道打日志）。拒绝之前先做确定性降级，每一级只在上一级装不下 `maxRequestChars` 时才尝试：先封存保留窗口之外的全部已完成轮；再把保留的最近几轮也封存；最后重写全部条目、省略轮正文，并遮蔽没有被任何条目覆盖的、已被取代的运行时快照（`recall_turn` 仍能取回每一轮）。只有最后这一级会改写条目、因而改写前缀，它会在 `warn` 里说明。只有受保护底座加当前输入本身就装不下时，请求构造才以 `SliceBudgetError` **明确失败**；不截断任何内容，持久记录不变，但之后每一轮都会同样失败，直到调大 `maxRequestChars`、缩小受保护上下文或开新会话。插件不会静默返回超限视图。预算拒绝前先记录当前输入。

`recall_search` 搜索原始的用户与助手文本、生成的上下文（插件产生的 user 角色消息，如运行时快照；两轮之间投影的快照归属刚结束的那一轮）、工具输入与工具错误（见 `src/recall.ts` 的 `DEFAULT_SEARCH_KINDS`）。默认 `scope: "auto"` 也收录普通工具**输出**，但只通过有界槽位（最多 `TOOL_OUTPUT_SLOTS` = 3 条、每条 `TOOL_SNIPPET_CHARS` = 600 字符），因为工具输出是会话里体量最大、信噪比最低的文本；`scope: "dialogue"` 跳过它，显式 `kinds` 优先于 scope。召回工具自己的输入与输出从不入索引。每条命中都给出后续调用。`recall_turn` 返回一整轮：`view: "full"`（默认）含原始记录与工具元数据，`view: "dialogue"` 只给每条用户与助手文本一次、工具结果以定位符表示。`recall_step` 取回某一步。`expand_result` 按 `{seq}`（折叠视图与每条条目的工具行里给出的持久日志 id）或按 turn/step/call 序号精确取回工具结果，可按行或正则过滤。带 spill 定位符的工具结果用其预览里给出的定位符。

## 从 0.0.1 迁移

- 删掉旧的、停用原生 loop 与不变量的 override，改用新的增量 bundle。
- 把 `maxParallelToolCalls` 等调度配置移到原生 `agent-loop` 行。
- `mode: state`、`mode: stream`、`state`、`tape`、`inTurnSeal` 已退役，加载时报错。不安全的宿主文件快照与写入回滚实现已删除。
- 私有的 `sliceContext.contribute` 注册表已退役。改用宿主的 system-prompt／runtime-context 扩展，让来源身份与持久化归 DSH。
- 原生不变量与本包的兼容导出 `./invariant` **二选一挂载，不要都挂**。两者装的是同一套完整重建检查。
- 历史策略现在是只追加的磁带：每个已完成轮在它自己的位置上封存，而不是等视图越过水位再归档最旧的几轮。`history.highWaterChars`、`history.lowWaterChars`、`history.keepRecentChars`、`history.checkpointMaxChars` 已退役，加载时报错并说明各自的去向（`Retired history configuration <key>: …`）；小节里出现别的键则报 `Unknown history configuration <key>; valid keys: …`。`keepRecentChars` 的窗口改用按轮计数的 `history.keepRecentTurns`，`checkpointMaxChars` 改名为 `history.entryMaxChars`；两个水位没有对应项——已经没有要跨过的压力阈值了。`maxHistoryChars` 仍然可用，但它现在会直接触发「重写全部条目」那一级降级；旧配置里的 `maxHistoryChars: 120000` 除非你就是要这个效果，否则应删除。
- 条目头从 `[slice checkpoint v1 …]` 改为 `[slice tape v1 …]`，插件 `warn` 的前缀从 `slice archive:` 改为 `slice tape:`。两种头都仍可解析，所以压力归档那版写下的会话可以直接续跑，旧的 checkpoint 作为普通的已封存条目留在 surface 上。更早的逐轮策略写下的 `# SESSION TAPE` 替换同样保留，磁带把它们当作普通的可封存历史。
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

每次请求的缓存前缀，就是上一次请求直到新追加条目为止的全部内容：封存落在尾部，只花掉它新写的那一条，之前的字节一个都不动。前缀只在三处断开：宿主自己的 surface 改写（例如工具结果折叠）、被未配对工具调用切断的轮，以及「重写全部条目」那一级降级。这是结构性质，**不是普适的缓存命中或成本保证**：provider 缓存与运行时上下文的变动频率仍决定账单，而本仓库**尚未**对磁带策略做过成本实测。[早期自建 loop 的实测](docs/legacy-loop.zh.md) 属历史记录，且测自另一套架构；在新架构上重跑模型质量／成本实验之前，那些数字都不应拿来说明当前这版。
