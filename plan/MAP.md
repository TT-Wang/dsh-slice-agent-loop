# MAP — slice schema

> 给人看的。不被 guard 检查 —— 分组随时会过时，别拿它当契约。契约在 [SEAMS.md](SEAMS.md)，实现在 [src/slice/assemble.ts](../src/slice/assemble.ts)（提案稿 plan/schema.ts 已被它取代，删除）。

## 目标形态

一个接口 + 一个函数。**没有区表、没有 `Region` 类型、没有 `zone` 字段、没有降级。**

```ts
interface SliceCtx { request; goal; tape; openFiles; lastError }

assemble(ctx, systemPrefix, hints) =>
  system + <context>{ tape, goal, openFiles, error }</context> + CURRENT REQUEST + NOW
```

结构约 25 行，其余是 header 文本 —— 那是 prompt，不是 schema。

那张表不承重：私有模块、固定 4 项、不动态注册、除渲染外无第二种遍历。数组字面量就是它。

## 一轮完整发出去的东西

```
┌─ system 前缀（DSH PromptSection 注册表，字节不变，永久命中）
│    slice:kernel  order -1000  = SLICE_SYSTEM_PROMPT (1.9k)
│    host 自己的 sections · tool schemas
├─ runtime-context 快照消息（DSH 投影，变了才发一条 durable 消息）
├─ ────────── 以上不归 slice schema 管 ──────────
│  <context>
│    # SESSION TAPE            ← 必须第一项，缓存边界到此为止
│    # STABLE TASK OBJECTIVE
│    # OPEN FILES
│    # CURRENT ERROR           ← 最急的放最后，紧邻请求
│  </context>
│  # CURRENT REQUEST           ← 固定槽，不参与排序
│  # NOW                       ← 固定槽
└─ 本轮轨迹（工具调用/结果、轮内注入）—— 跟在切片后面的独立消息
```

## 部件

| 部件 | 现在 → 目标 |
|---|---|
| `SliceCtx` | `state.ts` 353 行 → 5 个字段 |
| 装配 + 段 | `types.ts` 339 + `regions.ts` 966 + `compiler.ts` 55 + `buildSlice.ts` 94 → 一个函数 |
| `tape.ts` | 523 行，**不变** |

## 删除清单

**schema 侧**

| 删 | 原因 |
|---|---|
| `ContextBlock` 类（15 字段） | 无区表即无 block |
| `Region` / `zone` / `priority` / `order` / `slot` / `mandatory` / `alternativeGroup` / `itemId` / `blockId` | 数组顺序即全部 |
| `InstructionClass` / `FreshnessClass` / `EpistemicRole` / `ResourceKind` | 只写不读，零决策参与 |
| `SourceRef` / `ResourceRef` / `reservedResourceRef` / 虚拟挂载表 | 同上 |
| `Fidelity` / `FIDELITY_RANK` / `RepresentationLoss` / `PressureLevel` | 无降级即无保真度概念 |
| `ContextSelection` / `ElasticityController` / `SeedPlan` / `ContextUnfitError` | 同上 |
| `handles` / `reobservable` / `scope` | 同上（不变量的损失记在 SEAMS S2） |
| `locatorRegion`（13 分支，其中 2 个本就不可达） | 无替代表示 |
| `REGION_ORDER` / `REGION_META` / `REGION_ROLES` | Python legacy 派生视图 |
| `internal/placement.ts` | 零解析器注册表，为破一个新结构里不存在的循环依赖而生 |
| `SliceCtx.repoMap` / `.conversation` / `.activeFiles` | 无人读；ring 留在 `Continuity` |
| 15 个空区 | 私有模块，不留槽 |

**driver 侧连带**

| 删 | 位置 |
|---|---|
| 两段式重投影 | [driver.ts:900–919](../src/driver.ts:900) |
| `sliceCapacityChars` + `CHARS_PER_TOKEN` / `CAPACITY_SAFETY` / `MIN_SLICE_CAPACITY_CHARS` | driver.ts |
| `ContextUnfitError` 导入与兜底分支 | driver.ts |

保留 `internal/` 下的 `difflib` / `safety` / `pytext` / `textUtils` —— 它们服务 `tape.ts` 和 driver，不是 schema 的一部分。

## 两个悬空 header（重构时顺手修）

| 位置 | 问题 |
|---|---|
| OPEN FILES header | 承诺一个 `· read call` 列，而 `openFilesIndex` 早就不发了（[driver.ts:1216](../src/driver.ts:1216) 注释解释了原因） |
| task objective header | 引用 `RETAINED USER CORRECTIONS section`，那个区本方案删除；其第二分支依赖无生产者的 `objectiveStatus` |

## 生产者现状

driver 现在只写一个字段。这是 16 个空区的**唯一**原因 —— 区表本身完整，没人喂它。

| 段 | 生产者 | 状态 |
|---|---|---|
| tape | `Continuity.sessionTape` | ✅ |
| goal | `Continuity.goal` | ✅ |
| openFiles | `driver.openFilesIndex()` | ✅ |
| **lastError** | `ToolExecutionResult.error.info` —— **driver 手上已有，只是没写进去** | ❌ 一行 |
| discovery（第二批） | 需新生产者：roadmap / import 一跳邻居 | ❌ |
| findings（第二批） | 需移植 `record_note`，且要连带改 kernel prompt | ❌ |

移交 DSH，不做段：`focus` / `world` / `worktree`（`PromptSection`，全会话不变）、`memory` / `skills`（runtime-context，偶尔变）。

## 进度

已完成：

1. ✅ 接 `lastError` —— `trackToolOutcome` + `Continuity.pendingError/lastError`，实时与重放两条路都走
2. ✅ cap 定为 1000 / 2000（ASK / REPLY），driver-contract 与 tape.spec 的 fixture 改为从常量派生
3. ✅ 行为测试：`tests/assemble.spec.ts`（5 条）+ `tests/tape.spec.ts`（7 条，从 golden 移植）
4. ✅ 换 schema：`src/slice/assemble.ts`；driver 改线；两段式重投影与 `sliceCapacityChars` 删除
5. ✅ 退役 golden 套件、删旧 schema 六个文件、删 `kernel: 'ported'`

净 −3437 / +87 行。`src/slice/` 现共 1289 行，其中 schema 本体 143 行
（`assemble.ts` 123 + `index.ts` 20），其余是不动的 `tape.ts` 523 与 internal 助手 623。

未做（第二批）：`discovery`（RELATED CODE）与 `findings`。各需一个新生产者；
`findings` 还要连带改 kernel prompt。
