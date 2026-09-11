# dsh-slice-agent-loop

DSH 原生 agent loop 上的切片上下文策略：历史低于高水位时原样追加，超过后一次性把最旧的已完成轮归档成冻结的 checkpoint（持久化 surface replacement），同时保留原生上下文来源。本表是项目的规范词汇——输出（issue 标题、提案、测试名）用这里的词，不漂移到 _Avoid_ 列的同义词。

> 词汇锚点在 2026-09-10 从 `assemble.ts`（已退役的自建渲染器）改锚到现役实现，
> 2026-09-11 随压力归档策略再次改锚：`src/context.ts`（`planArchive` /
> `applyArchive` / `archiveUnderPressure` + checkpoint 渲染 + `maxRequestChars` 准入）
> 与 `src/index.ts` 的 `KERNEL` 段和 `history.*` 配置。旧渲染器专属词汇集中在末节「历史渲染器词汇」。

## Language

**缓存前缀 (cache prefix)**:
一次请求里跨轮字节稳定、吃 provider 缓存折扣的前缀：`slice:kernel` system 段 + 工具 schema + 有序 surface 上截至**第一个被改写的节点之前**的那一段。任何把内容挪出它或在它内部改字节的改动，都是把该内容的计费从缓存价改成全价。在压力归档策略下：序列化视图低于 `history.highWaterChars` 时插件**什么都不追加**，每次请求都是上一次请求的逐字节追加延伸，前缀就是**上一次请求的全部**（与原生 loop 相同）；前缀只在**归档事件**处断开——那一轮第一步把最旧的已完成轮换成冻结的 checkpoint 节点，断点落在第一个被替换的节点。之后 checkpoint 本身字节不变、成为新前缀的一部分。仍然**没有普适的缓存命中或成本保证**：宿主自己改写 surface（runtime context 变化、工具结果折叠）也会断前缀（README「Development and verification」末段同述）。
_Avoid_: 静态部分、system 区

**现付文本 (per-turn paid text)**:
缓存前缀之外、按全价计费的输入。常态（低于高水位）下只有本轮新追加的消息：当前用户输入、新的 runtime context 快照、本轮的助手与工具记录。归档事件那一步额外重付断点之后的全部内容：新 checkpoint 节点与保留原样的最近尾部。省它才省钱；省缓存前缀里的字节几乎不省钱。判断某项改动省不省钱，先问它是否让某一轮的请求不再是上一轮的追加延伸。
_Avoid_: 动态部分、boilerplate

**教学点 (teaching site)**:
一条规则在插件发出的文本里被陈述的位置。现役只有两类：**`KERNEL`**（`src/index.ts`，以 `slice:kernel` 注册进 system prompt，缓存价——checkpoint 的含义与 RECALL 纪律都在这里教一遍）与**工具描述**（`recall_search` / `recall_turn` / `recall_step` / `expand_result`，随工具 schema 一起进缓存前缀）。checkpoint 节点首行给出的 `recall_turn` / `expand_result` 用法是冻结在节点里的定位提示，不是第三类教学点。「每条规则恰好一个教学点」是志向而非不变式——复述可能靠语义之外的副作用挣回每轮成本（旧渲染器上的判例见 ADR-0001，**注意该 ADR 已被标记为 superseded**，其结论不适用于现役路径）。
_Avoid_: 重复提醒、reinforcement

### 现役机制锚点（不是新词汇，供上面三条定位代码）

- **触发**：常规检查只在一轮的**第一步**（`agent/pre-step`，`step === 1`）——轮中改写会改掉本轮已经付过钱的前缀。三个独立触发：最终请求视图（surface + 本轮待发消息）序列化后超过 `history.highWaterChars`（默认 300000）；设了可选的 `maxHistoryChars` 时渲染后的历史超过它；视图超过 `maxRequestChars`。第二步起只有最后一种会触发（`requestChars(...) > maxRequestChars`），作为避免拒绝的最后手段。两次归档之间至少隔 `highWaterChars - lowWaterChars` 的新增内容（视图仍装得下 `maxRequestChars` 时），免得归档不掉的底座每轮重新嵌套。
- **归档**：`planArchive`（`src/context.ts`）先把整次归档规划完，`applyArchive` 再逐条 append（`surfaceOp: { op: 'replace' }` + `sourceEventSeqs`）——一次失败的准入绝不留下半归档的 surface。从最旧的可归档轮起，一段一段替换，直到视图回到 `history.lowWaterChars`（默认 150000）以下（显式 `maxHistoryChars` 另有自己的目标）。最近尾部按 `history.keepRecentChars`（默认 60000，至少一轮）保留原样；工具调用未全部配对的轮保持原样并切断一段，同时走 `warn` 打日志（A-RT-05）。原始事件仍在会话日志里，经 recall 取回。
- **checkpoint 节点**：一条插件来源的 `user/message`（`HISTORY_SOURCE = 'slice:history'`），正文以 `CHECKPOINT_PREFIX`（`[slice checkpoint v1 · turns `）开头，列出每个被归档轮的请求、回复与工具结果定位符；`pinUserChars`（默认 1200）以内的用户消息逐字保留，更长的保留头尾；目标大小 `checkpointMaxChars`（默认 8000）。它是被替换节点的纯函数，生成后**冻结、永不重渲染**；再次归档时旧 checkpoint 被嵌套成一行。runtime context 快照的正文**不会**被渲染成用户请求，最多留一行说明，原文经 `recall_turn` 取回。
- **保护节点**：不可归档、保持原来的来源与位置的节点——当前（未完成）轮的一切、指令消息等非用户来源的消息、多模态用户消息、`history.pinFirstTurn`（默认 true）下第 1 轮的用户消息，以及**最新的那一个** runtime context 快照——宿主本步正在追加的那个，否则是 surface 上最新的那个（宿主的 `RuntimeContextProjection` 只保留一个 seq，出现在我们的 `sourceEventSeqs` 里会触发重投影，所以绝不遮蔽它）。**已被取代的**快照不受保护：低于高水位时它们像原生 loop 一样留在 surface 上（插件不为它们追加任何东西，否则追加式缓存就没了）；归档事件发生时它们和所在的轮一起被吸收进 checkpoint，也不会把一段可归档的轮切断。
- **准入**：`maxRequestChars`（默认 400000）是序列化 messages 的硬上限，按字符计，不是 token。装不下时先确定性降级，每级只在上一级装不下时才试：归档到水位 → 连最近尾部一起归档 → 归档全部已完成轮且 checkpoint 省略正文（`recall_turn` 仍取得回），降级走 `warn` 打日志。只有保护底座 + 当前输入本身就装不下时才抛 `SliceBudgetError`；拒绝发生在请求构造时（原生准入记录完用户输入之后），不留下任何 append、不截断任何内容，之后每一轮同样失败，直到调大预算、缩小保护上下文或开新会话。插件从不静默返回超限视图。

## 历史渲染器词汇（已退役，勿用于现役讨论）

自建 loop 的渲染器 `assemble.ts`（区表 `ZONE_HEADERS`、`FILES_HDR`、`NOW_FOOTER`、「合成规则 composition == hash ⇒ 直接编辑」）在 2026-09-08 原生迁移后已不在插件的现役调用图上——发布入口只 import `context` / `effort-default` / `recall` / `recall-step` / `fold`，该文件仅由离线归因模块与测试引用。当年「轮内行为纪律归 NOW 尾」这类说法描述的是那套渲染器，现役路径没有 NOW 尾。相关历史文档：`docs/legacy-loop.md`、`docs/adr/0001-keep-header-restatements.md`。
