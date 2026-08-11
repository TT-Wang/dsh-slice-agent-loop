# 修改 Spec(综合版)— dsh-slice-agent-loop

本文合并了外部评审提出的 spec 与独立实测。**外部 spec 的位置全部准确**;两处机制需要改写,而且 A 与 B 的关系是反的。

基线:HEAD `caa4d9f`,干净树,154 门全绿(外部 spec 写 150,实测 154)。

---

## 0. 核心更正:B 是 A 的病因,不是并列工作流

外部 spec 把「turn-16 死循环」当行为病理(工作流 A),把「artifact 悬空」当取证问题(工作流 B),两者并列。**实测表明是因果关系。**

turn 16 的 35 次工具调用,逐条读出来是这样的:

```
s1  grep   history/sessions|sealed|artifactId|artifact
s2  bash   ls ~/.dsh/sessions/--Users-tongtao-code-sliceagent--/...
s3  grep   history/sessions
s5  grep   sliceagent|history/sessions|source artifact|sourceArtifact
s6  grep   @sliceagent|history/|index\.md
s7  bash   find /Users/tongtao/code/sliceagent ...
s8  bash   grep -rn "source artifact" ~/.dsh/source/current ...
...
```

**它在找那个 `recall:` 定位器承诺、而实际不存在的封存工件。** 不是循环 —— 35 次调用**零重复**(去重后仍是 35),是一个称职的 agent 被告知"文件在这里"却找不到时的正常反应:换着法子再找。

所以 workflow A 治的是 workflow B 的症状。**修 B 就移除了这次跑飞的成因。**

---

## 1. 对外部 spec 的逐条裁决

| 主张 | 裁决 | 证据 |
|---|---|---|
| turn 16 = 20 步 / 35 次调用 | ✅ **精确** | 会话日志逐轮统计 |
| `recall:` 行不在黄金夹具里 | ✅ | `expected.json` 命中 0 |
| epoch 标记被黄金钉死 | ✅ | `expected.json` 命中 2 |
| `TurnEndReasonMap` 是官方扩展点 | ✅ | dsh-session 类型声明 |
| 「150 既有门禁」 | ❌ 154 | `npx vitest run` |
| **turn 16 是死循环** | ❌ **零重复,不是循环** | 35 次调用去重后仍 35 |
| **停滞判据 4/8 阈值** | ❌ **会砍掉 31% 的步** | 全轨迹模拟,见 §2 |
| **B1 的 `sealedArtifactBase` 方案** | ❌ **有更好的底座** | 见 §3 |

判据本身**是活的**:`assistantText` 只收 `type === 'text'`,reasoning 被排除([driver.ts:982](../src/driver.ts:982))。所以 turn 16 的 20 步「可见文本为零」是真的,判据会触发。问题不在它触不触发,在**它分不清好坏**。

---

## 2. 工作流 A 修订:保留硬顶,删掉停滞启发式

### 为什么删

把外部 spec 的判据(warn=4 / terminate=8)在真实轨迹上跑一遍:

| turn | 实际步数 | 首次警告 | 强制终止 | 砍掉步数 |
|--:|--:|--:|--:|--:|
| 3 | 49 | s21 | s25 | **24** |
| 9 | 6 | s4 | — | 0 |
| 10 | 5 | s4 | — | 0 |
| 11 | 6 | s4 | — | 0 |
| 14 | 13 | s4 | s8 | 5 |
| 16 | 20 | s4 | s8 | 12 |
| 19 | 12 | s4 | s8 | 4 |

**总计砍掉 45/143 步 = 31%。** 而且在 5–6 步的普通轮(9/10/11)上就发警告。

两个更硬的理由:

1. **`editsDelta` 这一项全程零贡献** —— 整段会话 0 次编辑工具调用(分析型会话)。判据实际退化成「continuation 且无可见文本」。
2. **对推理模型,「无可见文本 + 工具调用」是常态而非异常。** 模型把叙述放进 `reasoning` 块,可见文本只在收尾时出现。turn 3(productive,74 次调用)和 turn 16(futile)在这个维度上**完全同形**,判据无法区分 —— 重复度也不能(两者都是 0%)。

真正的区分信号是「搜索的东西不存在」,那不是行为层能测的,是 B 的病。

### 保留什么

`maxStepsPerTurn` **保留**,但定位改了:它是**界**,不是**诊断**。有界轨迹本来就是这个项目的设计不变量,一个硬顶和"停滞检测"的区别在于它不假装知道模型在干什么。

| key | 默认 | 语义 |
|---|--:|---|
| `maxStepsPerTurn` | `50` | 单轮 continuation step 硬顶,达到即终止本轮 |

默认从外部 spec 的 30 改成 **50**:实测 turn 3 用了 49 步做合法工作,30 会把它砍掉 19 步。50 覆盖了这条轨迹上的全部合法轮,同时仍然给出一个界。

保留外部 spec 的这些设计,它们是对的:

- 新 durable 事件 `slice/step-budget { turn, step, budget }`,log-only
- `TurnEndReasonMap` 扩展 `'step-budget'`(官方机制)
- 预算终止**不触发** `agent/turn-stopping` seam —— 该 seam 语义是"同轮继续",与硬终止矛盾;steering 留在 inbox 由下一轮 claim
- 配置校验:非正整数抛错
- invariant 增强:同轮 `slice/request-slice` 的 step 序列单调连续(纯函数 `stepSequenceViolation`,便于单测)

**删除**:`stallWindow`、`slice/stall-warning`、`isStallStep`、以及 §A5 里 2/3 号测试。

---

## 3. 工作流 B 修订:底座已经在手,不需要新配置

外部 spec 提出加 `sealedArtifactBase` 配置,默认渲染一句"全文只在日志里"。调研推翻了这个方案的前提 —— **不是没有底座,是有三个,而且都已经在跑**:

### 已核实的事实

| 事实 | 出处 |
|---|---|
| **DSH 已经有历史检索工具** | `@deepseek-ai/dsh-tool-session-query` 注册 **5 个**工具,含 `session_search` |
| **全文已经durable,而且是两份** | `assistant/message` 事件带**完整未截断**回复(dsh Agent 契约强制,这个 loop 自己在写);外加 chunk 流 |
| **截断不是破坏性的** | 只有 `TapeEntry.rendered` 被截;对话环里的全文**无上限保留** |
| **插件能注册工具** | `ctx.tools.register(defineTool({...}))`,可撤销 |
| **虚拟路径命名空间不可能** | DSH **没有**路径拦截、没有 read 中间件、没有 resolver hook。`FileSystem.resolve` 是抽象服务方法不是钩子 |

最后一行是决定性的:**`@sliceagent/` 这类虚拟路径在 DSH 里永远无法被服务**,不管加多少配置。所以 B 的方向不是"让它可配",是**换掉它**。

### B1 — VIRTUAL 类:删除,不是配置化

三处渲染 `@sliceagent/` 路径的站点([continuity.ts:136](../src/continuity.ts:136) `recall:`、[continuity.ts:336](../src/continuity.ts:336) epoch、[tape.ts:410](../src/slice/tape.ts:410) GC 标记):

- 删掉路径,保留**截断事实**。`…[+351 chars in sealed turn]` 这个标记本身是诚实且有用的 —— 它告诉模型"这里被截了、截了多少"。
- 不要写成"全文只在日志里"这类无法行动的句子 —— 那仍然占字节且不可执行。
- 若要**恢复真取回能力**:挂 `dsh-tool-session-query`,让模型用 `session_search`。这是宿主自己的工具,不需要这个插件做任何事。**建议单独一条 README 说明,不进渲染文本。**

`recall:` 每条封存轮 106 字符;那次会话 35 条 = 3,710 字符 ≈ **927 token/会话**,删掉是净收益。

### B2 — REAL-PATH 类:去掉调用名,只留路径

[driver.ts:1196](../src/driver.ts:1196) 的 OPEN FILES 索引行(每轮 × 每个锚定文件)与 [regions.ts:634/638](../src/slice/regions.ts:634) 的定位符替代:

调研的结论很硬 —— **三个选项里选"不渲染调用名"**:

- 硬编码 `read` 会在宿主改名时腐烂,而且 `read_file("path")` **双重错**:DSH 的 read 参数是 `{file_path}`,不是位置字符串
- 运行时发现**做不到非启发式**:`ToolSchema` 只有 `{name, description, parameters}`,**没有能力标签、没有分类、没有约定名**。`ToolCallKind` 看着像标签,是个陷阱(它是展示层的)
- 所以:渲染 `### <path> — N lines · sha256:<h> · (edited this session)`,把"怎么读"留给模型 —— 它本来就看得见自己的工具 schema

### B3 — PROSE 类

[regions.ts:396/430/482](../src/slice/regions.ts:396) 三处散文常量同步:说动词不说调用(`re-read the file` 而非 `read_file(...)`)。**必须和 B2 同批改** —— 定位器和散文不一致比两者都错更糟。

### B4 — 死区,不动

`regions.ts` 里约 15 处定位符/散文站点服务 memory / findings / artifacts / audit / evidence 等分区,这些分区在移植版里**渲染为空**(README 已记载"只有三个分区有内容"),站点清单逐条标了 `UNREACHABLE`。标 **no-op**,不要花力气。

### B5 — 范围更正:是 54 处,不是 13 处

穷尽清单查出 **54 个**取回类站点。`grep read_file` 只命中 13 个,漏掉的最大一块是 **[src/system-prompt.ts:19-68](../src/system-prompt.ts) 的 13 处散文指令 —— 它们每轮都进系统前缀,且一条测试都没有**。

字节代价(实测):**10 轮切片 2,850 字符 / 100 轮 10,771 字符**。

分类小结:

| 类别 | 站点数 | 处置 |
|---|--:|---|
| REAL-PATH(路径真、调用名假) | 4 | B2:去调用名 |
| VIRTUAL(`@sliceagent/`,永不可服务) | 9 | B1:删;其中 5 处在死区 |
| PROSE(散文教模型怎么取) | 41 | B3:说动词不说调用;其中约 15 处在死区 |

**系统前缀那 13 处必须和 B2/B3 同批改** —— 它们是"权威度最高"的位置,和定位器不一致的代价最大,而且零测试覆盖意味着改动无门可依(见 §4)。

### 黄金约束

- `recall:` 行**不在**黄金里 → B1 的第一处改动**不破 parity**,不需重生成
- epoch 标记(`history/index.md`)**在**黄金里(2 处)→ 改它必须同步 `gen_goldens.py` 并 `npm run goldens`(需 sliceagent checkout,maintainer-only)。**拿不到就降级**:只改 `recall:` 与 OPEN FILES,epoch 留到能重生成时再动。这条降级路径是外部 spec 提的,正确,保留。

---

## 4. 防复发门(外部 spec 没有,必须加)

这个 bug 的根因是:**渲染器被移植了,解析器没有,而没有任何门在看两者是否一致。**只改文本不加门,它会原样复发。

加一条门:**模型可见面里出现的每一个工具调用形状,其工具名必须存在于 `ctx.tools.schemas()`。**

```ts
// tests/driver-contract.spec.ts
// 渲染出的 <name>(...) 形状,name 必须是宿主真实注册的工具
const rendered = /* 完整 seed 文本 */
const names = new Set(ctx.tools.schemas().map(s => s.name))
for (const m of rendered.matchAll(/\b([a-z_]+)\(["']/g)) {
  expect(names).toContain(m[1])   // read_file 会在这里红
}
```

B2/B3 落地后这条门恒绿;任何人再写回一个假调用名,它立刻红。

---

## 5. 执行顺序

**先 B,再 A。** B 移除这次跑飞的成因;A 是与之独立的界。

```bash
# 1. B2+B3(OPEN FILES + 散文)+ §4 防复发门 —— 不碰黄金
# 2. B1 recall 行 —— 不碰黄金
# 3. A maxStepsPerTurn(默认 50)+ step-budget 事件 + invariant 增强
# 4. epoch 标记 —— 仅在能跑 npm run goldens 时
npm run typecheck && npm test && npm run build
git add lib/   # lib/ 是提交物
```

README 两版同步:配置表加 `maxStepsPerTurn`;事件表加 `slice/step-budget`;「已知局限」的 retrieval 条目改写(默认不再广告任何假调用),并加一句"要真取回请挂 `dsh-tool-session-query`"。

---

## 6. 未决

- **A 的 50 步默认只在一条轨迹上标定过**(19 轮 / 143 步)。多跑几条会话再定,或先发 50 观察。
- **停滞检测不是永远不能做** —— 但需要一个真信号(如"连续 N 步没有新观测"),而不是"没有可见文本"。目前没有这个信号的实现,不要为了填空硬上。
- 外部 spec §E2(宿主 UI 对 `turn/end` reason 穷举 switch)仍未验证,值得在宿主侧确认一次。
