# dsh-slice-agent-loop

DSH 原生 agent loop 上的切片上下文策略：通过持久化 surface replacement 压缩已完成对话，同时保留原生上下文来源。本表是项目的规范词汇——输出（issue 标题、提案、测试名）用这里的词，不漂移到 _Avoid_ 列的同义词。

> 词汇锚点在 2026-09-10 从 `assemble.ts`（已退役的自建渲染器）改锚到现役实现：
> `src/context.ts`（`HISTORY_HEADER` + 预算/admission + surface replacement）与
> `src/index.ts` 的 `KERNEL` 段。旧渲染器专属词汇集中在末节「历史渲染器词汇」。

## Language

**缓存前缀 (cache prefix)**:
一次请求里跨轮字节稳定、吃 provider 缓存折扣的前缀：`slice:kernel` system 段 + 工具 schema + 有序 surface 上截至**本轮第一个被改写的节点之前**的那一段。任何把内容挪出它或在它内部改字节的改动，都是把该内容的计费从缓存价改成全价。注意它在本策略里不是固定长度：`compactHistory` 每次把一个 span 替换成新的 `# SESSION TAPE` 消息，前缀就在那个位置断掉——所以**没有普适的缓存命中或成本保证**，前缀有多长取决于这一轮哪些 span 变了（README「Development and verification」末段同述）。
_Avoid_: 静态部分、system 区

**现付文本 (per-turn paid text)**:
缓存前缀之外、每轮按全价重付的输入：被改写的 span 及其之后的全部消息、`HISTORY_HEADER`、召回标记、本轮 runtime context 与当前用户输入。省它才省钱；省缓存前缀里的字节几乎不省钱。判断某项改动省不省钱，先问它落在断点之前还是之后。
_Avoid_: 动态部分、boilerplate

**教学点 (teaching site)**:
一条规则在插件发出的文本里被陈述的位置。现役只有两类：**`KERNEL`**（`src/index.ts`，以 `slice:kernel` 注册进 system prompt，缓存价——TAPE / FILES / RECALL 三段的机制纪律都在这里教一遍）与**工具描述**（`recall_search` / `recall_turn` / `recall_step` / `expand_result`，随工具 schema 一起进缓存前缀）。「每条规则恰好一个教学点」是志向而非不变式——复述可能靠语义之外的副作用挣回每轮成本（旧渲染器上的判例见 ADR-0001，**注意该 ADR 已被标记为 superseded**，其结论不适用于现役路径）。
_Avoid_: 重复提醒、reinforcement

### 现役机制锚点（不是新词汇，供上面三条定位代码）

- **封存**：`src/context.ts` 的 `compactHistory` 把一段已完成的对话节点换成一条插件来源的 `user/message`（`HISTORY_SOURCE = 'slice:history'`，正文以 `HISTORY_HEADER` 开头）。它**先把全部替换规划完再逐条 append**（`surfaceOp: { op: 'replace' }` + `sourceEventSeqs`）——一次失败的 admission 绝不留下半压缩的 surface。原始事件仍在会话日志里，只能经 recall 取回。
- **准入**：每个 span 的字符预算 = `Math.floor(maxHistoryChars / spans.length) - Array.from(HISTORY_HEADER).length`；`admitTape`（`src/slice/admission.ts`）在这个上限内自最旧起丢弃轮组，并给丢弃项留下 `recall_turn` 标记。预算装不下标记就抛 `SliceBudgetError`，不静默超限。
- **保护节点**：`conversational()`（`src/context.ts`）决定哪些事件可以被封存。当前用户输入、指令消息、多模态用户消息、**当前生效的** runtime snapshot 保持原来的来源与位置。已被取代的 runtime snapshot 不再受保护：它按其 `recall_turn` 轮号留下一条省略标记后被移出视图（无法归属到某一轮、因而 recall 取不回的快照仍然保持原位）。

## 历史渲染器词汇（已退役，勿用于现役讨论）

自建 loop 的渲染器 `assemble.ts`（区表 `ZONE_HEADERS`、`FILES_HDR`、`NOW_FOOTER`、「合成规则 composition == hash ⇒ 直接编辑」）在 2026-09-08 原生迁移后已不在插件的现役调用图上——发布入口只 import `context` / `effort-default` / `recall` / `recall-step` / `fold`，该文件仅由离线归因模块与测试引用。当年「轮内行为纪律归 NOW 尾」这类说法描述的是那套渲染器，现役路径没有 NOW 尾。相关历史文档：`docs/legacy-loop.md`、`docs/adr/0001-keep-header-restatements.md`。
