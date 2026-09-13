# dsh-slice-agent-loop

[English](README.md)

面向 **DeepSeek Harness 0.1.3-alpha.2** 的有界对话上下文策略。它与原生 agent loop 并行运行，生命周期、调度器、收件箱、持久化、请求序列与完整请求重建不变量全部保留在宿主侧。这个 patch 是增量的：它只新增本插件。

## 历史模型：只追加的磁带

每轮的**第一步**，把超出 `history.keepRecentTurns`（默认 0，也就是刚结束的那一轮）的每个已完成轮**在它自己的位置上**封成**一条**冻结的 `[slice tape v1 …]` `user/message` surface replacement。已经在 surface 上的条目**永不重渲染、也不会被套进新条目里**，所以封存总是落在已写内容之后：**每次请求都保住上一次请求的前缀，只为刚写下的那一条重新计费，而不是它背后的整个视图。** 这正是这套策略的全部理由——在前面改写一次，后面每个字节都要重新计费。

指令消息、当前用户输入、用户多模态消息、第 1 轮的用户消息与**最新的**运行时上下文快照（宿主本步正在追加的那个，否则是 surface 上最新的那个）保留原来的来源与位置。已被宿主取代的运行时快照，在它所属的那一轮封存时被一起吸收——最多一行 `[slice note · …]`，绝不当成用户请求渲染——其原文仍可经 `recall_turn` 取回。原始事件留在会话日志里；封存、折叠或恢复之后由 `recall_turn` / `recall_search` 取回。

### 条目内容

一条条目按顺序渲染：

- 头部标明跨度：`[slice tape v1 · turns N-M · K turn(s) sealed · recall_turn({"turn":"<n>","view":"dialogue"}) returns a turn's dialogue; expand_result({"seq":<q>}) returns a tool result]`；
- 每个被封存的轮：`[turn N]`、该轮用户消息（不超过 `history.pinUserChars`（默认 1,200）时逐字保留，超过的保留头 600 / 尾 300，中间留一个 `recall_turn` 标记），然后是回复，包在 `[reply slice-turn-N @sha256:…] … [end reply @sha256:…]` 里；
- 该轮的**读索引**行（见下）；
- 该轮的工具行——`[tool turn N step S seq Q · <name> · <size> chars · expand_result({"seq":Q})]`，每轮最多 6 条，每条指向持久日志记录，而不是重复正文。

`history.entryMaxChars`（默认 8,000）是单条条目文本的**目标**：渲染器先丢工具行、再逐级收窄摘录；许多短轮合成的一段仍可能超过它。工具调用未全部配对的轮保持原样并切断封存段（不丢配对），走插件的 `warn` 通道打日志。

### 读索引与读指纹

每个打开过文件的已封存轮会带一行，好让后续的轮判断"再读一次值不值"：

```
[files read this turn: src/context.ts (544 lines, ce9f9f98, step 1), tests/read-digest.spec.ts (104 lines, 705e051d, step 4, = turn 2)]
```

- 计入的工具：`read`、`read_section`、`read_file`。每个目标只记一条（保留首次 step），每轮最多 10 条，多出的用 `+N more` 收尾；没有读过文件的轮不产生这一行。
- 摘要是那次读取**返回文本**的 `sha256` 前 8 位十六进制——也就是模型当时看到的内容，不是磁盘上的文件。
- 变化标注把该摘要与本次会话中同一目标**更早的最后一次**读取比较：`= turn N`（字节相同）或 `≠ turn N`（已变）。它由只追加日志推导，所以跨封存仍然有效。
- 它始终是指针：条目里不复制任何文件正文。这一行是提示而非证明——摘要覆盖的是被返回的窗口，不是整份文件。

## 召回与展开工具

`recall_turn` 返回一整轮：`view: "full"`（默认）含原始记录与工具元数据，`view: "dialogue"` 只给每条用户与助手文本一次、工具结果以定位符表示。`recall_step` 取回某一步。`expand_result` 按 `{seq}`（每条条目的工具行里给出的持久日志 id）或按 turn/step/call 序号精确取回工具结果，可按行或正则过滤；带 spill 定位符的结果用其预览里给出的定位符。

`recall_search` 搜索原始的用户与助手文本、生成的上下文（插件产生的 user 角色消息，如运行时快照；两轮之间投影的快照归属刚结束的那一轮）、工具输入与工具错误（见 `src/recall.ts` 的 `DEFAULT_SEARCH_KINDS`）。默认 `scope: "auto"` 也收录普通工具**输出**，但只通过有界槽位（最多 `TOOL_OUTPUT_SLOTS` = 3 条、每条 `TOOL_SNIPPET_CHARS` = 600 字符），因为工具输出是会话里体量最大、信噪比最低的文本；`scope: "dialogue"` 跳过它，显式 `kinds` 优先于 scope。召回工具自己的输入与输出从不入索引。每条命中都给出后续调用。

可见历史里的缺席意味着"未知"或"未被选中"——**绝不是假**，也绝不是"这件事没发生过"。否认某事说过之前，先召回。

## 配置

```yaml
- id: slice-agent-loop
  name: '@dsh-external/dsh-slice-agent-loop'
  config:
    maxStepsPerTurn: 50
    defaultReasoningEffort: low
    history:
      keepRecentTurns: 0
      pinFirstTurn: true
      pinUserChars: 1200
      entryMaxChars: 8000
```

| 配置项 | 含义 |
|---|---|
| `history.keepRecentTurns` | 尾部保持原样的已完成轮数（默认 0：一轮在下一轮第一步就被封存）。调大它，是用「前缀稳定的字节」换「逐字的新近内容」——被保留的轮在封存之前每次请求都要整段重读，封存时又一次性合成一段。封存是无条件的：没有要跨过的阈值，也没有要回落到的目标大小。 |
| `history.pinFirstTurn` / `pinUserChars` / `entryMaxChars` | 第 1 轮的用户消息保持为未经改动的追加节点（默认 true；该轮的 assistant／工具运行仍可封存）。`pinUserChars`（默认 1,200）是被封存用户消息的逐字预算。`entryMaxChars`（默认 8,000）是单条条目的文本目标。 |
| `maxStepsPerTurn` | 超过这么多模型步就停止派发；默认 50。 |
| `defaultReasoningEffort` | `off`、`low`、`high`、`max` 或 `inherit`；宿主／模型的显式选择优先。**受模型能力门控**：只有已解析模型声明了该档位时才注入（`src/effort-default.ts` 的 `declaredEfforts`）；能力未知时沿用适配器默认，并按路由告警一次。 |
| `digest` | 内容路由选项，见 `src/slice/result-digest.ts`。 |
| `fold` | 工具结果折叠选项：`enabled`、`pinSteps`、`pinMaxChars`、`spillPreviewMinBytes`、`backoffAfterExpansions`。 |

**请求预算已经删除。** 磁带按构造就有界——每完成一轮一条条目，工具结果在开放回合内折叠——所以唯一的硬上限是模型上下文窗口，那是宿主的职责。插件侧没有上限、没有拒绝，也没有任何"重写条目"的降级层级。

- **接受但无效**：`maxRequestChars` 与 `maxHistoryChars` 仍能作为合法键通过解析，但已经没有任何代码读取它们——它们过去施加的字符上限与历史上限都不存在了。迁移配置时请删除；留着不会改变行为，也不会告警。
- **加载时报错，并说明各自去向**：`history.highWaterChars`、`history.lowWaterChars`、`history.keepRecentChars`、`history.checkpointMaxChars`（`Retired history configuration <key>: …`——替代项是 `history.keepRecentTurns`（按轮计数）与 `history.entryMaxChars`；两个水位没有对应项，因为已经没有要跨过的压力阈值了），以及已退役的驱动键 `maxParallelToolCalls`、`inTurnSeal`、`tape`、`state`（`Retired slice configuration <key>: …`）。
- `mode` 只接受 `slice`；`state` 与 `stream` 在加载时报错。两个小节里出现别的不认识键，同样报错并给出合法键列表。

条目头是 `[slice tape v1 …]`，`warn` 前缀是 `slice tape:`；已退役的 `[slice checkpoint v1 …]` / `# SESSION TAPE` 替换仍可解析：更早版本写下的会话续跑时，它们作为普通的已封存条目留在 surface 上。

## 组合方式

用 DSH 的插件安装器安装本仓库，并应用它的 `cordis.patch.yml` bundle。**保持 `agent-loop`、`agent-loop-invariant` 与原生 session projections 启用。** Git 包内含已生成的 `lib/` 产物。

本包已经自带一份工具结果折叠，和独立插件 [`dsh-tool-result-fold`](https://github.com/TT-Wang/dsh-tool-result-fold) 同源，也以 `./fold` 导出。**不要在同一个 profile 里再装那个独立插件**：两者都会注册 `expand_result`，第二次注册会在加载时直接失败（`tool "expand_result" is already registered`）。只有想在不装 slice 策略的原生 loop 上单独用折叠时，才单独挂 `./fold`（或那个独立插件）。

## 前缀行为

每次请求的缓存前缀，就是上一次请求直到刚写下的那条封存为止的全部内容：封存落在尾部，只花掉它新写的那一条，之前的字节一个都不动。前缀只在两处断开：宿主自己的 surface 改写（例如工具结果折叠），以及被未配对工具调用切断的轮。这是结构性质，**不是普适的缓存命中或成本保证**：provider 缓存与运行时上下文的变动频率仍决定账单。

文件读取是记录下来的窗口，写入／编辑元数据含 diff 片段。它们是历史观察，不能证明文件当前全文，也不能证明后端身份；完整 base／免重读指针类优化保持关闭，直到宿主提供带完整 provider 文本、目标身份与版本的持久观察通道。见 [记录式记忆](docs/recorded-memory.md)。
