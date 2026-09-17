# dsh-slice-agent-loop

[English](README.md)

面向 **DeepSeek Harness 0.1.5-rc.2 / 0.1.5-rc.1** 的对话上下文保留策略。它与原生 agent loop 并行运行，生命周期、调度器、收件箱、持久化、请求序列与完整请求重建不变量全部保留在宿主侧。这个 patch 是增量的：它只新增本插件。

## 历史模型：只追加的磁带

每轮的**第一步**，把超出 `history.keepRecentTurns`（默认 0）的已完成轮在原位置封成冻结的 `[slice tape v1 …]` `user/message` surface replacement。已有条目永不重渲染或嵌套；截至最后一个已有条目的 surface 前缀保持不动。更早的节点即使后来变得可封存，也留在原位置，不回填到已有条目前方。保护节点可能把同一轮切成多个条目。

指令消息、当前用户输入、用户多模态消息、第 1 轮的用户消息与**最新的**运行时上下文快照保留原来源与位置。被取代的快照只有位于冻结前缀之后时才可随所属轮封存；较早的快照如果后来才被取代，就留在原位置。快照正文不会被写成人类请求。原始事件仍在日志里，封存、折叠与恢复后都可召回。

冻结只保证已有条目的字节不变，**不保证每次只为一个新条目付费**：封存位置之后的所有文本（包括保留的原始尾部）仍可能缓存失效。见下方「前缀行为」。

### 条目内容

一条条目按顺序渲染：

- 头部标明跨度：`[slice tape v1 · turns N-M · K turn(s) sealed · recall_turn({"turn":"<n>","view":"dialogue"}) returns a turn's dialogue; expand_result({"seq":<q>,"formatVersion":3}) returns a tool result]`；
- 每个被封存的轮：`[turn N]`、该轮用户消息（不超过 `history.pinUserChars`（默认 1,200）时逐字保留，超过的保留头 600 / 尾 300，中间留一个 `recall_turn` 标记），然后是回复，包在 `[reply slice-turn-N @sha256:…] … [end reply @sha256:…]` 里；
- 该轮的**读索引**行（见下）；
- 该轮的工具行——`[tool turn N step S seq Q · <name> · <size> chars · expand_result({"seq":Q,"formatVersion":3})]`，每轮最多 6 条，每条指向持久日志记录，而不是重复正文。

`history.entryMaxChars`（默认 8,000，最小 256）是**新封存条目文本的 Unicode 码点硬上限**：限制读索引标签及整行长度，先丢工具行，再收窄摘录与索引；积压仍装不下时，用完整的逐轮召回指引代替正文，不截断定位符。旧冻结条目与受保护的原始消息保持不变，这不是请求总量上限。未配对工具调用所在段保留原样，在同一 Session 实例中每段只告警一次。

### 读索引与读指纹

成功读取过文本的已封存轮会带一行索引：

```
[files read this turn: src/context.ts (544 lines, ce9f9f98, step 1, seq 12 block 1, read window default, logged result)]
```

- 计入 `read`、`read_section`、`read_file`，包括嵌套的 `tool/ptc-dispatch`。失败读取不进入成功索引和比较历史；成功重试可以更新之前的成功观察。
- 每个「工具、路径、参数窗口、直接/代码通道」选择同轮**最后一次成功读取**，最多显示 10 条，多出的用 `+N more` 收尾。
- 指纹是返回文本的 `sha256` 前 8 位；比较同样规则选出的更早成功观察，标出其 turn、step、seq 与结果块。不同窗口或通道之间不声称文件发生变化。
- 直接读取定位到日志结果；嵌套读取定位到 dispatch，明确标注 `code log; model visibility not implied`：代码拿到文本，不代表模型看到了全文。
- 条目不复制文件正文。这是历史返回窗口，不证明整份文件，也不证明当前状态。

## 召回与展开工具

`recall_turn` 返回一整轮：`view: "dialogue"`（默认）只给每条用户与助手文本一次、工具结果以定位符表示；`view: "full"` 另附全部原始记录（reasoning、工具元数据、每一条原始工具输出），在有工作量的一轮里要大两个数量级，只在需要工具输入或原始 reasoning 时才要。`recall_step` 取回某一步，并在存储可用时恢复 spill 原文；不可用时明确标成预览，并给出精确展开定位符。`expand_result` 按 `{seq, formatVersion: 3}`（每条条目的工具行里给出的持久日志 id）或按 turn/step/call 序号精确取回工具结果，可按行或正则过滤。多结果事件支持从 1 起算的 `block` 选择；省略则取全部兄弟结果，逐块恢复 spill。

`recall_search` 搜索原始的用户与助手文本、生成的上下文（插件产生的 user 角色消息，如运行时快照；两轮之间投影的快照归属刚结束的那一轮）、工具输入与工具错误（见 `src/recall.ts` 的 `DEFAULT_SEARCH_KINDS`）。默认 `scope: "auto"` 也收录普通工具**输出**，但只通过有界槽位（最多 `TOOL_OUTPUT_SLOTS` = 3 条、每条 `TOOL_SNIPPET_CHARS` = 600 字符），因为工具输出是会话里体量最大、信噪比最低的文本；`scope: "dialogue"` 跳过它，显式 `kinds` 优先于 scope。召回工具自己的输入与输出块不入索引，但不会连带丢掉同一事件里的普通兄弟结果。工具输入命中指向含参数的完整轮记录，结果命中指向精确事件与结果块。每条命中都给出后续调用。

可见历史里的缺席意味着"未知"或"未被选中"——**绝不是假**，也绝不是"这件事没发生过"。否认某事说过之前，先召回。

数字定位符必须注明当前会话格式：`expand_result({"seq":42,"formatVersion":3})`。缺少版本或版本不符的 `seq` 调用会在查找前拒绝。宿主 v2→v3 迁移会插入事件，却保留旧磁带文本，因此旧数字可能指向另一条结果。可用 `recall_turn` 的 dialogue 视图或 `recall_search` 获取新定位符，也可使用稳定的 `turn`/`step`/`call` 坐标。见 [宿主兼容与迁移](docs/dsh-0.1.5-compatibility.md)。

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
| `history.keepRecentTurns` | 尾部保持原样的已完成轮数（默认 0：一轮在下一轮第一步就被封存）。调大它会保留更多逐字历史。未变动的原始轮仍可能命中缓存；封存更早的轮会改变该尾部之前的前缀，使尾部重新计费。封存是无条件的：没有要跨过的阈值，也没有要回落到的目标大小。 |
| `history.pinFirstTurn` / `pinUserChars` / `entryMaxChars` | 第 1 轮的用户消息保持为未经改动的追加节点（默认 true；该轮的 assistant／工具运行仍可封存）。`pinUserChars`（默认 1,200）是被封存用户消息的逐字预算。`entryMaxChars`（默认 8,000，最小 256）限制新条目的文本，不限制整个 tape。 |
| `maxStepsPerTurn` | 超过这么多模型步就停止派发；默认 50。 |
| `defaultReasoningEffort` | `off`、`low`、`high`、`max` 或 `inherit`；宿主／模型的显式选择优先。**受模型能力门控**：只有已解析模型声明了该档位时才注入（`src/effort-default.ts` 的 `declaredEfforts`）；能力未知时沿用适配器默认；已声明能力但不含请求档位时，按路由告警一次。 |
| `digest` | 内容路由选项，见 `src/slice/result-digest.ts`。 |
| `fold` | 工具结果折叠选项：`enabled`、`pinSteps`、`pinMaxChars`、`spillPreviewMinBytes`、`backoffAfterExpansions`。 |

**请求预算已经删除。** 条目减少历史细节，但会随会话累积；本插件不对总历史或当前轮提供硬上限。需要在宿主组合中配置上下文窗口处理，单靠磁带不能避免溢出。插件侧没有上限、没有拒绝，也没有任何"重写条目"的降级层级。

- **接受但无效**：`maxRequestChars` 与 `maxHistoryChars` 仍能作为合法键通过解析，但已经没有任何代码读取它们——它们过去施加的字符上限与历史上限都不存在了。迁移配置时请删除；留着不会改变行为，也不会告警。
- **加载时报错，并说明各自去向**：`history.highWaterChars`、`history.lowWaterChars`、`history.keepRecentChars`、`history.checkpointMaxChars`（`Retired history configuration <key>: …`——替代项是 `history.keepRecentTurns`（按轮计数）与 `history.entryMaxChars`；两个水位没有对应项，因为已经没有要跨过的压力阈值了），以及已退役的驱动键 `maxParallelToolCalls`、`inTurnSeal`、`tape`、`state`（`Retired slice configuration <key>: …`）。
- `mode` 只接受 `slice`；`state` 与 `stream` 在加载时报错。两个小节里出现别的不认识键，同样报错并给出合法键列表。

条目头是 `[slice tape v1 …]`，`warn` 前缀是 `slice tape:`；已退役的 `[slice checkpoint v1 …]` / `# SESSION TAPE` 替换仍可解析：更早版本写下的会话续跑时，它们作为普通的已封存条目留在 surface 上。

## 组合方式

用 DSH 的插件安装器安装本仓库，并应用它的 `cordis.patch.yml` bundle。**保持 `agent-loop`、`agent-loop-invariant` 与原生 session projections 启用。** Git 包内含已生成的 `lib/` 产物。

本包已经自带一份工具结果折叠，和独立插件 [`dsh-tool-result-fold`](https://github.com/TT-Wang/dsh-tool-result-fold) 最初同源，也以 `./fold` 导出。**不要在同一个 profile 里再装那个独立插件**：两者都会注册 `expand_result`，第二次注册会在加载时直接失败（`tool "expand_result" is already registered`）。只有想在不装 slice 策略的原生 loop 上单独用折叠时，才单独挂 `./fold`（或那个独立插件）。

## 与 Agent Swarm 配合

[Agent Swarm](https://github.com/TT-Wang/dsh-agent-swarm)（`@dsh-external/dsh-agent-swarm`）是 DSH 的**任务层（mission layer）**：一条指令变成一次 mission——owner 规划任务图，member 各自在独立 worktree 与沙箱里以原生会话运行，每件产物都由**另一个**成员独立复核并验证。本插件是这些 worker 运行的**会话层（session layer）**，两者通常一起挂载：

- Agent Swarm 把工作扇出，本策略减少每个 worker 会话的历史细节，保留冻结条目与召回定位符；磁带总大小仍随会话增长。
- 召回面保留 mission 中对原记录的访问：`recall_turn`、`recall_search`、`expand_result` 能把封存、折叠或恢复替换掉的任何内容取回，所以需要早先某次文件读取或工具结果的 worker 不必重读、更不必猜。
- 在同一个 profile 里挂两行即可——swarm 的 bundle（或插件包）加上本 patch。两者都是增量 patch、都不 fork Harness 核心，工具面也不重叠（那边是 `swarm_*`，这边是 `recall_turn` / `recall_search` / `recall_step` / `expand_result`）。

## 前缀行为

可复用前缀截至最早发生变化的序列化消息。封存不会插入到已有磁带条目之前；旧运行时快照后来才被取代时，也不会触发前部回填。这保护了已封存字节，但新条目、封存点之后的原始消息、宿主的 surface 改写与工具折叠仍可能增加 fresh 输入。最终计费取决于 provider 缓存；代码上的稳定性不等于已测得的成本或准确率收益。

文件读取是记录下来的窗口，写入／编辑元数据含 diff 片段。它们是历史观察，不能证明文件当前全文，也不能证明后端身份；完整 base／免重读指针类优化保持关闭，直到宿主提供带完整 provider 文本、目标身份与版本的持久观察通道。见 [记录式记忆](docs/recorded-memory.md)。

实现修复及验证范围见 [2026-09-13 评审修复](docs/review-fixes-2026-09-13.md)。
