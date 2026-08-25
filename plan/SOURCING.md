# SOURCING — 借 vs 造

**这一节大部分是 N/A，这是真话不是省事。** slice schema 是插件内部的一个纯函数模块：输入 ctx，输出字符串。它不调网络、不落盘、不依赖任何第三方库。可借的东西本来就少。

---

## 唯一的真决策：还当不当 Python 引擎的移植

| 字段 | 内容 |
|---|---|
| **Verdict** | **build**（走独立演化） |
| **现状** | `src/slice/` 是 `sliceagent` Python 引擎 @ `tape-graduation-w1` 的字节级移植，44 golden case 逐字节钉住 |
| **借的代价** | 19 区里 16 个恒空、7 个 mandatory 区活 1 个、5 个 `ContextBlock` 字段只写不读、4 档 Fidelity 用 2 档、2 个 `locatorRegion` 分支被 `mandatory` 挡死不可达。**全部是"照抄了渲染层但没抄生产层"的直接后果**（见 [PORT-REPORT.md](../PORT-REPORT.md) §4） |
| **Precedent** | 无可引 —— 上游是私有引擎，没有公开的生产案例可查。**按默认怀疑规则，这本来就不该按 borrow 计价** |
| **Counter-example** | 不适用（不是第三方库） |
| **Exit condition** | 如果将来需要与 Python 引擎双向对齐（例如共享 golden、或把 TS 侧改动回灌），独立演化就是错的 —— 但那需要上游先有这个诉求 |
| **Build cost** | 远低于初估。降级机制删除（[SEAMS.md](SEAMS.md) S2）、区表塌成数组字面量之后，新 schema 的**结构部分约 25 行**（见 [schema.ts](schema.ts)），其余是原样搬过来的 header 文本。真正的工作量在别处：从 parity 改成行为测试（S6 未决），以及 driver 侧连带删除 |

---

## 已锁定、不在本次决策范围

| 外部 | 状态 |
|---|---|
| `@deepseek-ai/dsh-*`（session / agent / llm / tools / system-prompt / token-meter / scope） | **既定依赖**。整个插件的存在前提就是跑在 DSH 上，不是可选项 |
| `tape.ts` | 本仓自有模块，S4 已画清边界，本次不动 |

---

## 明确不借

| 候选 | 判断 |
|---|---|
| 任何模板引擎 / 序列化库 | 装配就是「渲染 → 丢空 → 按 zone 拼」，约 25 行。引一个依赖来省 25 行是负收益 |
| 外部代码索引服务（SourceIndex 一类） | 闭源、托管、源码需过第三方后端、且无公开的 per-task CLI。形态可参考，不可作为路径上的依赖。**与本次 schema 重构无关，记在此仅为封死这条路** |

---

## 搜索说明

本页没有做外部检索：唯一的 build 决策的证据全部来自本仓代码与 `PORT-REPORT.md`，不依赖外部先例。若将来把 schema 抽成独立包（当前定位＝私有模块，已排除），届时需要重做这一页。
