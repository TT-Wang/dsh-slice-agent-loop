# dsh-slice-agent-loop

[English](README.md)

面向 **DeepSeek Harness 0.1.7-rc.2 / 0.1.7-rc.1**（会话格式 V4）的对话上下文保留策略。它与原生 agent loop 并行运行，生命周期、调度器、收件箱、持久化、请求序列与完整请求重建不变量全部保留在宿主侧。这个 patch 是增量的：它只新增本插件。

## 历史模型：只追加的磁带

每轮的**第一步**，把超出 `history.keepRecentTurns`（默认 0）的已完成轮中可封存的助手／工具段，在原位置封成冻结的 `[slice tape v1 …]` `user/message` surface replacement，来源 kind 为 `plugin:slice:history`。已有条目永不重渲染或嵌套；截至最后一个已有条目的 surface 前缀保持不动。更早的节点即使后来变得可封存，也留在原位置，不回填到已有条目前方。保护节点可能把同一轮切成多个条目。

每一轮仍在宿主 surface 上的原始人类用户消息都逐字保留在原节点，不再复制到 tape 中。system prompt（surface 第 0 个节点，只由宿主原地替换）以及其他所有 `system/message`、`developer/message` 节点永不封存、也不被引用。指令消息、多模态输入与**最新的**运行时上下文快照（来源 kind 为 `runtime-context`）也保留原来源与位置。被取代的快照只有位于冻结前缀之后时才可随所属轮封存；较早的快照如果后来才被取代，就留在原位置。快照正文不会被写成人类请求。原始事件仍在日志里，封存、折叠与恢复后都可召回。

冻结只保证已有条目的字节不变，**不保证每次只为一个新条目付费**：封存位置之后的所有文本（包括保留的原始尾部）仍可能缓存失效。见下方「前缀行为」。

### 条目内容

一条条目按顺序渲染：

- 头部标明跨度：`[slice tape v1 · turns N-M · K turn(s) sealed · recall_turn({"turn":"<n>","view":"dialogue"}) returns a turn's dialogue; expand_result({"seq":<q>,"formatVersion":4}) returns a tool result]`；
- 每个被封存的轮：`[turn N]`，然后按原顺序保留该段内每条可见助手文本，各有回复包装与来源定位；默认保留全文和空白，包括调用工具之前的助手消息；
- 该轮的**读索引**行（见下）；
- 该轮的工具行——`[tool turn N step S seq Q · <name> · <size> chars · expand_result({"seq":Q,"formatVersion":4})]`，每轮最多 6 条，每条指向持久日志记录，而不是重复正文。

**默认不设条目或助手文本上限。** reasoning 与工具结果正文留在原日志中，通过召回访问；导航元数据仍有展示限制。用户消息位于条目之外，不会被条目渲染器缩短。

`history.entryMaxChars` 是**显式启用的新条目 Unicode 码点硬上限**，必须是至少 256 的正安全整数。设置后，渲染器可丢弃工具行、缩短助手文本和索引，最终退到含完整逐轮召回指引的跨度标记。省略此项则完整保留助手文本。该上限不会改动原始用户节点或旧冻结条目，也不是请求总量上限。未配对工具调用所在段保留原样，在同一 Session 实例中每段只告警一次。

### 读索引与读指纹

成功读取过文本的已封存轮会带一行索引：

```
[files read this turn: src/context.ts (544 lines, ce9f9f98, step 1, seq 12 block 1, read window default, logged result)]
```

- 计入 `read`、`read_section`、`read_file`，包括嵌套的 `tool/ptc-dispatch`。失败读取不进入成功索引和比较历史；成功重试可以更新之前的成功观察。
- 每个「工具、路径、参数窗口、直接/代码通道」选择同轮**最后一次成功读取**。导航行在 2,000 码点内最多显示 10 项，单项标签也有限长；省略项标出数量与完整轮召回提示。这些展示限制不截断底层读取记录。
- 指纹是返回文本的 `sha256` 前 8 位；比较同样规则选出的更早成功观察，标出其 turn、step、seq 与结果块（会话格式 V4 下每个结果事件只有一条 tool 角色消息，所以总是 `block 1`）。不同窗口或通道之间不声称文件发生变化。
- 直接读取定位到日志结果；嵌套读取定位到 dispatch，明确标注 `code log; model visibility not implied`：代码拿到文本，不代表模型看到了全文。
- 条目不复制文件正文。这是历史返回窗口，不证明整份文件，也不证明当前状态。

## 召回与展开工具

`recall_turn` 返回一整轮：`view: "dialogue"`（默认）只给每条用户与助手文本一次、工具结果以定位符表示；`view: "full"` 另附全部原始记录（reasoning、工具元数据、每一条原始工具输出），在有工作量的一轮里要大两个数量级，只在需要工具输入或原始 reasoning 时才要。`recall_step` 取回某一步，并在存储可用时恢复 spill 原文；不可用时明确标成预览，并给出精确展开定位符。`expand_result` 按 `{seq, formatVersion: 4}`（每条条目的工具行里给出的持久日志 id）或按 turn/step/call 序号精确取回工具结果，可按行或正则过滤。会话格式 V4 中每个工具结果都是独立的 tool 角色消息，同一步里的并行调用各自产生带独立 seq 的结果事件；可选的 `block` 参数只接受 `1`。每个 spill 文本部分单独恢复。

`recall_search` 搜索原始的用户与助手文本、生成的上下文（不是人类写的 user 角色消息，如运行时快照，命中里统一标注为 `[context]`；`recall_turn` 页面按来源 kind 标注，例如 `[runtime-context]`；两轮之间投影的快照归属刚结束的那一轮）、工具输入与工具错误（见 `src/recall.ts` 的 `DEFAULT_SEARCH_KINDS`）。默认 `scope: "auto"` 也收录普通工具**输出**，但只通过有界槽位（最多 `TOOL_OUTPUT_SLOTS` = 3 条、每条 `TOOL_SNIPPET_CHARS` = 600 字符），因为工具输出是会话里体量最大、信噪比最低的文本；`scope: "dialogue"` 跳过它，显式 `kinds` 优先于 scope。召回工具自己的输入与结果不入索引，但不会连带丢掉同一步里的普通结果。工具输入命中指向含参数的完整轮记录，结果命中指向精确的结果事件。每条命中都给出后续调用。

可见历史里的缺席意味着"未知"或"未被选中"——**绝不是假**，也绝不是"这件事没发生过"。否认某事说过之前，先召回。

数字定位符必须注明当前会话格式（`SESSION_FORMAT_VERSION`，现为 4）：`expand_result({"seq":42,"formatVersion":4})`。缺少版本或版本不符的 `seq` 调用会在查找前拒绝，0.1.5 版本写下的磁带里冻结的 `formatVersion:3` 提示也一样。宿主把旧会话恢复成 V4 时不改旧磁带文本，而迁移一旦插入事件就会给后面的 seq 重新编号，因此旧数字可能指向另一条结果。可用 `recall_turn` 的 dialogue 视图或 `recall_search` 获取新定位符，也可使用稳定的 `turn`/`step`/`call` 坐标。见 [DSH 0.1.7 兼容与 V3 会话续跑](docs/dsh-0.1.7-compatibility.md)；[0.1.5 说明](docs/dsh-0.1.5-compatibility.md) 作为历史保留。

## 配置

```yaml
- id: slice-agent-loop
  name: '@dsh-external/dsh-slice-agent-loop'
  config:
    defaultReasoningEffort: inherit
    fold:
      pinSteps: 0
    history:
      keepRecentTurns: 0
```

| 配置项 | 含义 |
|---|---|
| `history.keepRecentTurns` | 尾部保留原始助手／工具段的已完成轮数（默认 0：下一轮第一步就封存）。无论设置多少，所有原始人类用户消息始终保持原样。调大它会保留更多原始助手／工具结构；未变动的原始轮仍可能命中缓存，但封存更早的轮可能使其后的尾部重新计费。没有压力阈值或回落目标。 |
| `history.entryMaxChars` | 可选的新条目 Unicode 码点上限，默认省略。显式值必须是至少 256 的安全整数；启用后允许缩短助手文本／索引并保留召回提示。不会缩短原始用户节点，也不限制整个 tape。 |
| `maxStepsPerTurn` | 可选的正整数步数上限。默认不设上限，由原生 loop 控制终止；显式设置后，超过该步数就停止派发。 |
| `defaultReasoningEffort` | `off`、`low`、`high`、`max` 或 `inherit`（默认）。默认由宿主／模型选择推理预算；请求中的显式选择始终优先。**受模型能力门控**：只有已解析模型声明了该档位时才注入（`src/effort-default.ts` 的 `declaredEfforts`）；能力未知时沿用适配器默认；已声明能力但不含请求档位时，按路由告警一次。 |
| `digest` | 内容路由选项，见 `src/slice/result-digest.ts`。 |
| `fold` | 工具结果折叠选项：`enabled`、`pinSteps`、`pinMaxChars`、`spillPreviewMinBytes`、`backoffAfterExpansions`。 |
| `fold.pinSteps` / `pinMaxChars` | 位置保护须显式启用（`pinSteps` 默认 0）。启用后，前若干步里小于 `pinMaxChars`（默认 8,000）的结果保留原文。内容保护在所有步骤都生效。 |
| `fold.backoffAfterExpansions` | 默认同一工具／资源下至少 2 个不同折叠结果块被完整取回，且完整取回率至少 50%，就在该会话中停止折叠该资源。资源标识为精确的 `file_path`／`path`；没有路径时，使用对象键排序后的完整参数。局部 `grep`／`lines` 查询和同块重复取回不累计退避，其他资源继续按原规则折叠；spill 路径遵循同一规则。 |

### 升级现有 profile

更新插件不会删除 profile 中已经显式写入的配置。采用当前默认行为时：

1. 删除 `maxStepsPerTurn: 50`（或已有的其他步数上限），由原生 loop 控制终止。只有需要明确限步时才保留正整数；`0` 和 `null` 都不是合法的关闭方式。
2. 删除 `defaultReasoningEffort: low`，或改成 `inherit`，沿用宿主／模型选择。请求中的显式档位仍然优先。
3. 删除 `fold.pinSteps: 2`，或改成 `0`，从第一步就按内容决定是否折叠。识别出的源代码、错误结果与召回原文继续受保护；按资源区分的退避规则自动生效。
4. 删除 `history.pinFirstTurn` 和 `history.pinUserChars`；两项已退役，加载时会报错并给出迁移说明。所有原始人类用户节点都保留，不再需要首轮开关或用户摘录预算。
5. 删除 `history.entryMaxChars: 8000`（或其他显式上限），让今后的条目完整保留助手文本；只有有意接受条目裁剪与按需召回时，才保留合法值。
6. 删除 `maxRequestChars` 和 `maxHistoryChars`；这两个退役键现在会阻止插件加载。

有意保留的合法配置仍可继续使用。已有冻结条目不会重写：过去被裁掉的内容仍可召回，但升级不会自动把它们恢复到 surface；新的保留规则只作用于后续封存时仍在宿主 surface 上的文本，也不会恢复已被宿主压缩或其他插件替换隐藏的内容。

**请求预算已经删除。** 条目把工具结果／reasoning 正文换成可召回的记录，默认保留可见对话，但仍随会话累积；本插件不对总历史或当前轮提供硬上限。需要在宿主组合中配置上下文窗口处理，保留更长对话可能增加上下文占用与输入成本，单靠磁带不能避免溢出。插件不会按请求字符数拒绝请求，也不会通过重写已有条目来缩小磁带。

- **退役用户保留键现在加载时报错**：删除 `history.pinFirstTurn` 与 `history.pinUserChars`。所有原始人类用户消息都留在原位置，没有替代的用户文本预算。
- **退役预算键现在加载时报错**：请删除 `maxRequestChars` 与 `maxHistoryChars`。它们此前虽能通过解析，却不施加任何上限；继续静默接受会让人误以为存在保护。上下文窗口处理应在宿主中配置。
- **加载时报错，并说明各自去向**：`history.highWaterChars`、`history.lowWaterChars`、`history.keepRecentChars`、`history.checkpointMaxChars`（`Retired history configuration <key>: …`——替代项是 `history.keepRecentTurns`（按轮计数）与 `history.entryMaxChars`；两个水位没有对应项，因为已经没有要跨过的压力阈值了），以及已退役的驱动键 `maxParallelToolCalls`、`inTurnSeal`、`tape`、`state`（`Retired slice configuration <key>: …`）。
- `mode` 只接受 `slice`；`state` 与 `stream` 在加载时报错。两个小节里出现别的不认识键，同样报错并给出合法键列表。

条目头是 `[slice tape v1 …]`，`warn` 前缀是 `slice tape:`；已退役的 `[slice checkpoint v1 …]` / `# SESSION TAPE` 替换仍可解析：更早版本写下的会话续跑时，它们作为普通的已封存条目留在 surface 上。格式 3 会话里的条目经宿主 V3→V4 恢复后，来源 kind 变为 `plugin:slice:history`，正文不变，仍保持冻结。

## 组合方式

用 DSH 的插件安装器安装本仓库，并应用它的 `cordis.patch.yml` bundle。**保持 `agent-loop`、`agent-loop-invariant` 与原生 session projections 启用。** Git 包内含已生成的 `lib/` 产物。

本包已经自带一份工具结果折叠，和独立插件 [`dsh-tool-result-fold`](https://github.com/TT-Wang/dsh-tool-result-fold) 最初同源，也以 `./fold` 导出。**不要在同一个 profile 里再装那个独立插件**：两者都会注册 `expand_result`，第二次注册会在加载时直接失败（`tool "expand_result" is already registered`）。只有想在不装 slice 策略的原生 loop 上单独用折叠时，才单独挂 `./fold`（或那个独立插件）。

## 与 Agent Swarm 配合

[Agent Swarm](https://github.com/TT-Wang/dsh-agent-swarm)（`@dsh-external/dsh-agent-swarm`）是 DSH 的**任务层（mission layer）**：一条指令变成一次 mission——owner 规划任务图，member 各自在独立 worktree 与沙箱里以原生会话运行，每件产物都由**另一个**成员独立复核并验证。本插件是这些 worker 运行的**会话层（session layer）**，两者通常一起挂载：

- Agent Swarm 把工作扇出，本策略把每个 worker 会话的历史工具／reasoning 正文换成召回定位符，保留冻结条目与召回定位符；磁带总大小仍随会话增长。
- 召回面保留 mission 中对原记录的访问：`recall_turn`、`recall_search`、`expand_result` 能把封存、折叠或恢复替换掉的任何内容取回，所以需要早先某次文件读取或工具结果的 worker 不必重读、更不必猜。
- 在同一个 profile 里挂两行即可——swarm 的 bundle（或插件包）加上本 patch。两者都是增量 patch、都不 fork Harness 核心，工具面也不重叠（那边是 `swarm_*`，这边是 `recall_turn` / `recall_search` / `recall_step` / `expand_result`）。

## 前缀行为

可复用前缀截至最早发生变化的序列化消息。封存不会插入到已有磁带条目之前；旧运行时快照后来才被取代时，也不会触发前部回填。这保护了已封存字节，但新条目、封存点之后的原始消息、宿主的 surface 改写与工具折叠仍可能增加 fresh 输入。最终计费取决于 provider 缓存；代码上的稳定性不等于已测得的成本或准确率收益。

文件读取是记录下来的窗口，写入／编辑元数据含 diff 片段。它们是历史观察，不能证明文件当前全文，也不能证明后端身份；完整 base／免重读指针类优化保持关闭，直到宿主提供带完整 provider 文本、目标身份与版本的持久观察通道。见 [记录式记忆](docs/recorded-memory.md)。

实现修复及验证范围见 [2026-09-13 评审修复](docs/review-fixes-2026-09-13.md)。

## 验证与兼容范围

本次变更通过 **38 个文件中的 342 个测试**、覆盖率门槛、类型检查，以及 DSH **0.1.7-rc.1、0.1.7-rc.2** 打包安装／召回／恢复。peer 范围是 `0.1.7-rc.1 || 0.1.7-rc.2`；本版本不支持 0.1.5 宿主，包括 2026-09-25 时 npm `latest` 指向的 0.1.5-rc.3。0.1.5 版本写下的格式 3 会话经宿主 V3→V4 恢复后可以续跑，这条路径由两份 provider 实际写出的 0.1.5 会话夹具覆盖，含并行、失败、PTC 嵌套与已折叠的结果。CI 覆盖 Node 22.19.0、22.22.3 和 24.x。本次没有新增付费模型评测；内容保留测试不能直接证明成本收益或任务准确率。宿主变化、迁移行为与验证记录见 [DSH 0.1.7 兼容说明](docs/dsh-0.1.7-compatibility.md)。

当前历史策略与迁移见 [默认保留对话](docs/adr/0003-preserve-dialogue-defaults.md)；此前循环／折叠策略变更及其已记录验证结果见 [2026-09-21 上下文策略默认值](docs/context-policy-defaults-2026-09-21.md)。
