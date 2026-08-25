# SEAMS — slice schema（DSH 原生重构）

一句话：**把每轮该带的东西按固定顺序拼成一个字符串。**

必须为真的假设：
1. 前缀缓存靠 tape 只追加、且排在最前 —— 一旦 tape 不在最前或被改写，整个成本模型垮掉。
2. 空区不该存在 —— 私有模块，不为将来可能的功能留槽。
3. ~~超窗会发生~~ —— **已证伪**（S2）。降级机制整体删除。

具体形状见 [schema.ts](schema.ts)：一个 `SliceCtx` 接口 + 一个 `assemble()` 函数，结构部分约 25 行。**没有区表、没有 `Region` 类型、没有 `zone` 字段** —— 私有模块、固定 4 项、不动态注册、除渲染外无第二种遍历，那张表不承重，数组字面量就是它。

范围：`src/slice/`。不含 `tape.ts` 内部逻辑（独立模块，只在 S3 交界）。

---

| # | seam | 状态 |
|---|---|---|
| S1 | driver → SliceCtx | **pinned** |
| S2 | 装不下时怎么办 | **pinned**（决定：不管） |
| S3 | tape → assemble | **pinned** |
| S4 | assemble → 模型（数组顺序 = 缓存边界） | **pinned** |
| S5 | assemble 的纯性 | 低不确定，见下 |
| S6 | 迁移 | **OPEN** |

---

## S1 · driver → SliceCtx（生产者缝）

**这是坏掉的那个。** 19 区里 16 个恒空，因为 `toSliceCtx` 硬编码空值、driver 只覆盖 `artifacts` 一个字段。

**Control** — 决策：`SliceCtx` 由 driver 每轮**全量构造**，字段无默认值。
理由：`discovery: ''` 能潜伏这么久，正是因为默认值让"没接线"和"这轮没有"长得一样。全量构造下，加一项就必须在 driver 里显式写一行。
证伪：driver 侧因此出现大段 `field: ''` 样板 —— 回去砍项，不要加默认值。

**Data** — 决策：`SliceCtx` 只含**已有生产者的字段**：`request` / `goal` / `tape` / `openFiles` / `lastError`。需要 I/O 或 hash 的项由 driver **渲染成串**再交（`openFiles` 即如此）。
理由：字段存在即承诺，而编译器不会催你兑现。让 driver 交串而非结构体，是因为它本来就要读盘、算 hash、脱敏 —— 再顺手格式化不增加耦合，反倒省掉一层类型。
证伪：某一项的渲染需要 ctx 里的**其他**字段才能决定 —— 那它必须交结构体，由 assemble 渲染。

**Time** — 决策：`SliceCtx` **无状态**，每轮现算，不缓存、不跨轮持有。
理由：跨轮状态的唯一归属是 `Continuity`（含 tape）。ctx 能存东西就会有两个真相源。
证伪：出现"要用上一轮算过的派生值"且重算昂贵 —— 那个值该进 `Continuity`。

**Failure** — 决策：任一项生产失败 → 交空串 → 该段消失。不抛，不填占位符。
理由：`openFilesIndex` 已是这个语义（盘态读不到只发状态行，绝不拿陈旧字节冒充当前）。统一到全部。
证伪：出现"某段消失了但模型不知道它本该存在"导致的错误行为 —— 见 S2 证伪。

**Trust** — 决策：外部字节（文件正文、工具输出、用户文本）在 **driver 侧**过 `redactText`，schema 侧不做安全处理。
理由：现状如此，且 hash 必须和 tape 锚在同一脱敏域，否则永不命中。安全边界只能有一条。
证伪：`assemble` 里出现任何 `redactText` 调用 —— 边界漏了。

---

## S2 · 装不下时怎么办

**决策：不管。超窗交给 provider 报错。**

理由：观测到的 slice 峰值 16K–43K token，常见窗口 128K+；且历史日志中 `slice does not fit the model context window` **从未命中**（由仓库所有者确认，非本文档作者实测）。为一个未发生的问题维持的成本是：`Fidelity` 四档、`RepresentationLoss` 四档、`ContextBlock` 类及其 5 个只写不读的字段、`ElasticityController`、`ContextUnfitError`、`SeedPlan` 投影、driver 侧两段式重投影、`locatorRegion` 全部 13 个分支。全删。

**放弃了什么**（明写，因为这是这次重构唯一有实质损失的决定）：旧 schema 有一条不变量 —— *有损表示必须携带恢复路标*（`representationLoss ≠ NONE ⇒ handles 非空或 reobservable`）。新形态里每段只有"渲染"或"消失"两态，**某段消失时模型不会被告知它本该存在**。

证伪（任一成立就要把机制加回来）：
- 小窗口模型（≤32K）上出现 provider 侧超窗报错 —— tape 有 120K 字符预算，理论上够顶穿 32K 窗口；
- 出现模型行为错误，事后归因于"某段静默消失且模型不知情"。

加回来的最小形态：交空串的地方改成交一句"这里本来有 X，用 Y 去看"。**不要**重新引入 `Fidelity` 四档、`ContextBlock` 类或弹性控制器。

---

## S3 · tape → assemble

**Control** — 决策：`assemble` 只消费 tape，`tape.ts` 不因本次重构改动。
理由：tape 是独立的跨轮账本，schema 只是它的渲染出口。两者生命周期不同。
证伪：重构需要改 `tape.ts` 的任何导出 —— 边界画错了。

**Data** — 决策：只读 `TapeEntry.rendered`，不碰 `payload` / `postHash` / `kind`。
理由：条目渲染在构造时冻结，这正是它能进缓存前缀的原因。
证伪：需要按 `kind` 过滤 tape 条目 —— 那是 `tape.ts` 的职责。

**Time** — 决策：tape 的裁剪只归 `compactTape`，`assemble` 绝不裁剪 tape。
理由：`compactTape` 的折叠不可逆；装配不该有能力因一次临时压力永久毁掉历史。（S2 之后 `assemble` 已无裁剪能力，此条为防回归。）
证伪：出现"tape 太长装不下"的真实案例 —— 需要 tape 侧的、可逆的分页机制，不是让装配动手。

**Failure / Trust** — N/A —— `assemble` 无失败路径；tape 内容已在写入时脱敏（S1 Trust）。

---

## S4 · assemble → 模型（数组顺序 = 缓存边界）

**Control** — 决策：输出顺序**只由 `assemble` 里那个数组字面量的顺序决定**。没有第二个排序轴，没有运行期排序。
理由：S2 删掉降级后，"降级顺序"这个轴消失，只剩输出位置。一个轴不需要一张表来表达。
证伪：需要按运行期条件改变顺序 —— 那需要重新引入显式序号。

**Data** — 决策：数组第一项恒为 tape，且永远排在所有内容之前。
理由：缓存命中边界 = `system + 上一轮结束时的 tape`；tape 之后的一切每轮必然 miss。这不是优化，是成本模型的地基。
证伪：观测到缓存命中率与 tape 长度不成正比 —— 边界假设错了，重新量。

**Time** — 决策：顺序在源码里写死，不允许运行期重排。
理由：任何重排都会让缓存从重排点起全部作废。
证伪：出现"某段在特定条件下必须提前"的需求 —— 它该有自己的固定位置，不是动态挪位。

**Failure / Trust** — N/A —— 纯字符串拼接，无失败路径；输出只送模型。

---

## S5 · assemble 的纯性（低不确定）

`assemble(ctx, systemPrefix, hints) => { system, user }`，纯函数，无副作用。只读 ctx —— 不读文件系统、不调 DSH、不算 hash。所有 I/O 在 driver 侧发生（S1）。

## S6 · 迁移（**OPEN**）

44 个 golden case 退役、改行为测试 —— 已决。未决见本会话结尾的待议清单。
