# dsh-slice-agent-loop

DSH 原生 agent loop 上的切片上下文策略：每轮第一步把可封存的已完成轮替换成冻结的 tape 条目，保留原生上下文来源与原日志召回能力。本表是项目的规范词汇——输出（issue 标题、提案、测试名）用这里的词。

> 2026-09-13 校准至现役实现：`src/context.ts` 的 `planSeal` / `sealCompletedTurns`、`src/context-reads.ts` 的读取观察，以及 `src/index.ts` 的 `KERNEL` 与 `history.*`。压力归档和自建渲染器均已退役。

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

- **触发与封存**：只在 `agent/pre-step` 的 `step === 1`，且宿主返回 `enter` 后执行。`history.keepRecentTurns`（默认 0）之外的已完成轮按原位置生成 surface replacement；原事件通过 `sourceEventSeqs` 保留可追溯性。没有压力阈值或回落水位。当前轮、工具未配对的轮与保护节点不被强行封存；未配对轮走 `warn`。
- **冻结前缀**：surface 上截至最后一个已有 slice 条目的节点不再被本策略封存。包括旧 tape、checkpoint 和仅说明 snapshot 的条目；后来变得可封存的早期节点保持原样。这避免恢复或 runtime context 更新导致前部回填。
- **tape 条目**：`source` 为 `slice:history` 的 `user/message` replacement，正文以 `[slice tape v1 · turns ` 开头。列出用户请求、回复摘要与工具定位符，生成后不重渲染、不嵌套。保护节点可以把同轮切成多个条目。`pinUserChars` 默认 1200，`entryMaxChars` 默认 8000，后者是目标而非硬限制。
- **保护节点**：当前轮、所有 system/message、指令和其他非人类来源消息、多模态用户消息、默认固定的第 1 轮用户消息，以及最新 runtime snapshot 保留原来源和位置。已取代快照只在冻结前缀之后随所属轮封存；正文不渲染成人类请求。更早的原始快照可能继续留在 surface 上。
- **读取观察**：只把成功读取纳入文件索引和指纹比较。以工具、路径、读取窗口与直接/代码调用通道区分观察，使用同轮最后一次成功结果，并附 step、seq、结果块定位。比较对应的更早成功观察；摘要反映返回窗口，不证明磁盘当前状态或整份文件。代码通道的结果只证明代码运行时拿到了文本，不自动证明模型看到了全文。
- **召回**：原日志是依据。数字 seq 定位符必须带当前 SESSION_FORMAT_VERSION（现为 3）的 formatVersion；宿主 v2→v3 会改写 seq 元数据但不改旧正文，故裸 seq 与旧版本 seq 在外部工具边界拒绝。turn/step/call 坐标保持可用。检索按结果块排除召回工具自己的输出，不吞掉同一事件里的普通工具兄弟块。工具输入命中指向包含参数的记录；spill 原文通过存储定位取回，失败时明确显示预览和恢复定位，不能冒充完整原文。
- **容量**：请求准入字符预算已删除。`maxRequestChars` / `maxHistoryChars` 接受但无效；旧 `history.highWaterChars` / `lowWaterChars` / `keepRecentChars` / `checkpointMaxChars` 加载时报错。条目随会话增长，当前轮也无插件总量上限；宿主组合必须处理上下文窗口。不要称磁带「按构造有界」。

## 历史渲染器词汇

`assemble.ts`、`ZONE_HEADERS`、`FILES_HDR`、`NOW_FOOTER` 与「composition == hash ⇒ 直接编辑」属于退役的自建 loop。它们不在发布入口的现役调用图上，仅供离线归因和历史测试使用。现役路径没有 NOW 尾。见 `docs/legacy-loop.md`、`docs/adr/0001-keep-header-restatements.md`。
