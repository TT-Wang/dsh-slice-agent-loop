# dsh-slice-agent-loop

DSH 原生 agent loop 上的切片上下文策略：每轮第一步把已完成轮中可封存的助手／工具段替换成冻结的 tape 条目，保留原生上下文来源与原日志召回能力。本表是项目的规范词汇——输出（issue 标题、提案、测试名）用这里的词。

> 2026-09-21 校准至默认保留对话的现役实现：`src/context.ts` 的 `planSeal` / `sealCompletedTurns`、`src/context-reads.ts` 的读取观察，以及 `src/index.ts` 的 `KERNEL` 与 `history.*`。压力归档和自建渲染器均已退役。2026-09-25 校准至 DSH 0.1.7 的会话格式 V4：工具结果是 tool 角色消息，消息来源直接写 kind，system prompt 是 surface 第 0 个节点。宿主变化与旧会话续跑见 [DSH 0.1.7 兼容说明](docs/dsh-0.1.7-compatibility.md)。

## Language

**缓存前缀 (cache prefix)**：
跨请求字节稳定、可能获得 provider 缓存折扣的前缀：system 段、工具 schema 与有序 messages，直到第一个发生变化的位置。冻结条目不重渲染；封存也不回填到最后一个已有条目之前，因此旧 runtime snapshot 后来才被取代时，不会插入条目打断已有磁带前缀。但刚封存的条目及其后方的原始尾部仍可能重新计费，宿主改写和 provider 缓存策略也影响结果。不能把「字节稳定」写成「整次请求仅新增一条的账单保证」。
_Avoid_: 静态部分、system 区

**现付文本 (per-turn paid text)**：
未命中缓存、按 fresh 输入计费的文本。通常包括本轮新增消息；封存或其他 surface 改写还可能让断点后的保留内容重新计费。省缓存前缀中的字节与省 fresh 输入不是同一回事。判断改动是否省钱，先看最早发生变化的位置和其后的文本量，再以 provider usage 确认，不能由字符数直接推断账单。
_Avoid_: 动态部分、boilerplate

**教学点 (teaching site)**：
规则在插件发出文本里的陈述位置：`KERNEL`（`src/index.ts`，注册为 `slice:kernel` system 段）与工具描述（`recall_search` / `recall_turn` / `recall_step` / `expand_result`）。条目内的调用例是冻结的定位提示。「每条规则一个教学点」是设计目标，不是已经验证的模型质量保证。旧渲染器的提示实验见已 superseded 的 ADR-0001。
_Avoid_: 重复提醒、reinforcement

## 现役机制锚点

<!-- code-anchor: src/context.ts#planSeal -->
<!-- code-anchor: src/context.ts#applySeal -->
<!-- code-anchor: src/context.ts#sealCompletedTurns -->
<!-- code-anchor: src/context.ts#TAPE_PREFIX -->
<!-- code-anchor: src/context.ts#HISTORY_SOURCE -->
<!-- code-anchor: src/context.ts#RUNTIME_CONTEXT_SOURCE -->
<!-- code-anchor: src/context.ts#isRuntimeSnapshot -->
<!-- code-anchor: src/context-reads.ts#readHistory -->
<!-- code-anchor: src/index.ts#KERNEL -->

以上代码声明和本文档树中的相对链接由 `npm run check:docs` 校验。此检查验证锚点仍存在；机制含义仍需代码复核。

- **触发与封存**：只在 `agent/pre-step` 的 `step === 1`，且宿主返回 `enter` 后执行。`history.keepRecentTurns`（默认 0）之外的已完成轮按原位置生成 surface replacement；原事件通过 `sourceEventSeqs` 保留可追溯性。没有压力阈值或回落水位。当前轮、工具未配对的轮与保护节点不被强行封存；未配对段在同一 Session 实例中只告警一次。
- **冻结前缀**：surface 上截至最后一个已有 slice 条目的节点（从第 0 个节点、即 system prompt 算起）不再被本策略封存。包括旧 tape、checkpoint 和仅说明 snapshot 的条目；后来变得可封存的早期节点保持原样。这避免恢复或 runtime context 更新导致前部回填。
- **tape 条目**：`source` 为 `{ kind: 'plugin:slice:history' }`（`HISTORY_SOURCE`）的 `user/message` replacement，正文以 `[slice tape v1 · turns ` 开头。V3 会话里的条目（旧来源 `{ kind: 'plugin', plugin: 'slice:history' }`）经宿主 V3→V4 恢复后是同一个 kind，正文字节不变，按 kind 与 `[slice tape v1 · turns ` / `[slice checkpoint v1 · turns ` 前缀识别。用户原话留在原节点，不复制进条目；条目默认按原顺序完整保留段内每条可见助手文本（包括空白），并列出工具定位符。生成后不重渲染、不嵌套；保护节点可以把同轮切成多个条目（V4 下，请求之间工具集变化时宿主在下一轮追加的 developer/message 就会这样切，两个条目的头都是 `turns N-N`）。`history.entryMaxChars` 默认省略，不施加条目或助手文本上限；显式值必须是至少 256 的安全整数，才启用助手文本／索引缩减与完整召回指引兜底，始终不裁剪原始用户节点。reasoning 与工具结果正文留在原日志中召回。导航展示仍限每轮 6 条工具定位符、读索引最多 10 项／2,000 码点及有限长度标签；这些限制不截断底层记录。旧冻结条目不重写，旧摘录缺失内容也不会自动恢复到 surface；宿主压缩或其他插件已隐藏的原文不在本策略的恢复范围内。
- **保护节点**：当前轮、仍在宿主 surface 上的所有原始人类用户消息（每轮均逐字保留）、所有 system/message 与 developer/message、指令和其他非人类来源消息、多模态用户消息，以及最新 runtime snapshot（来源 kind `runtime-context`，即 `RUNTIME_CONTEXT_SOURCE`）保留原来源和位置。system prompt 是 surface 第 0 个节点，只由宿主原地替换（宿主拒绝其他覆盖第 0 个节点的替换）；system 节点永不封存，也不写进 `sourceEventSeqs`。已取代快照只在冻结前缀之后随所属轮封存；正文不渲染成人类请求。更早的原始快照可能继续留在 surface 上。
- **读取观察**：只把成功读取纳入文件索引和指纹比较；按 Session 的追加日志增量更新，重载后的新实例首次重建一次，不重复哈希旧结果。以工具、路径、读取窗口与直接/代码调用通道区分观察，使用同轮最后一次成功结果，并附 step、seq、结果块定位（V4 每个结果事件只有一条 tool 角色消息，块号恒为 1）。比较对应的更早成功观察；摘要反映返回窗口，不证明磁盘当前状态或整份文件。代码通道的结果只证明代码运行时拿到了文本，不自动证明模型看到了全文。
- **召回**：原日志是依据。人类与插件的 user-role 消息使用同一轮归属：开路轮优先，否则归属刚结束的轮；首轮前没有召回页的节点必须保持可见。空消息保留显式痕迹，完整页仍保留原始内容。数字 seq 定位符必须带当前 SESSION_FORMAT_VERSION（从 `@deepseek-ai/dsh-session` 导入，现为 4）的 formatVersion；宿主把 V2/V3 会话恢复为 V4 时不改旧正文，插入事件时还会给后续 seq 重新编号，故裸 seq 与旧版本 seq（包括旧条目里冻结的 `formatVersion:3`）在外部工具边界拒绝，并提示通过 recall_turn dialogue / recall_search 刷新。turn/step/call 坐标保持可用。工具结果按 V4 形状读取：每个 `tool/result` 是一条带 `toolCallId`、`isError` 的 tool 角色消息，包括同一步并行调用与 PTC 程序的结果；`expand_result` 的 `block` 只接受 1。检索按结果事件排除召回工具自己的输出，不吞掉同一步里的普通工具结果。生成上下文在 recall_turn 页面按来源 kind 标注（如 `[runtime-context]`），recall_search 命中统一标为 `[context]`。工具输入命中指向包含参数的记录；spill 原文通过存储定位取回，失败时明确显示预览和恢复定位，不能冒充完整原文。
- **循环与推理预算**：默认不设置 `maxStepsPerTurn`，终止由原生 loop 控制；显式正整数上限仍可启用。`defaultReasoningEffort` 默认 `inherit`，显式插件档位仍受模型能力门控且不覆盖请求的显式选择。
- **轮内折叠**：默认 `pinSteps: 0`，不按步骤位置区别保护；显式 `pinSteps` / `pinMaxChars` 仍可启用。错误结果、召回输出、识别出的源代码与已发送结果继续保留。退避只统计同一工具、同一精确路径（无路径时同一规范化参数对象）下不同折叠结果块的完整取回；局部查询与重复取回不增加退避计数，不影响其他资源。
- **容量**：请求准入字符预算已删除。`maxRequestChars` / `maxHistoryChars` 加载时报错并说明迁移方向，不再静默接受；旧 `history.highWaterChars` / `lowWaterChars` / `keepRecentChars` / `checkpointMaxChars` 加载时报错。`history.pinFirstTurn` / `pinUserChars` 已退役，加载时报错并说明所有原始人类用户消息都保留。条目随会话增长，当前轮也无插件总量上限；完整保留更长对话可能增加上下文占用与输入成本，宿主组合必须处理上下文窗口。不要称磁带「按构造有界」。当前决策见 [ADR-0003](docs/adr/0003-preserve-dialogue-defaults.md)。

## 历史渲染器词汇

`assemble.ts`、`ZONE_HEADERS`、`FILES_HDR`、`NOW_FOOTER` 与「composition == hash ⇒ 直接编辑」属于退役的自建 loop。它们不在发布入口的现役调用图上，仅供离线归因和历史测试使用。现役路径没有 NOW 尾。见 `docs/legacy-loop.md`、`docs/adr/0001-keep-header-restatements.md`。
