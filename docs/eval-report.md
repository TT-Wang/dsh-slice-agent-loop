> ⚠️ **2026-08-31 勘误/后续**:本报告 flash 轮 **default 臂**的 s10 数字已**作废**
> (压缩因配置名漂移未真正生效,"零丢失"是无效对照;修正标定后 flash default 同样
> FAIL)。schema 已重写(四档保真度 / kernel:'ported' 等机制随之移除,文中相关描述
> 为历史记录)。修正结论与新系列见 README「Results update — 2026-08」与
> results/20260826-retention · 20260827-cost1m · 20260831-reasoning-ab 档案。

# dsh-slice-agent-loop 评测报告（slice vs transcript default）

日期：2026-08-10 · 双臂同模型（deepseek-v4-flash）· 官方计价（输入 $0.14/M · 缓存命中 $0.0028/M · 输出 $0.28/M，api-docs.deepseek.com 2026-08-09 抓取）

## 1. 结论总览

| 测试 | 场景数/轮数 | default | slice-ts | Δ 价格 | 峰值轨迹（default → slice） |
|---|---|---|---|---|---|
| s1 长链路调试 | 6 轮 | PASS | PASS | +8.3% | 21K→109K 棘轮 · 16K→18K 振荡回落 |
| s2 任务图编排 | 10 轮 | PASS | PASS | +29.4% | 18K→92K · 18K→27K |
| s3i 区间集代数 | 10 轮 | PASS | PASS | +66.3% | 15K→74K · 20K→34K |
| s3m 多文件重构 | — | PASS | PASS | +9.8% | — |
| st1 栈追踪 | 1 轮 | PASS | PASS | **-11.8%** | — |
| **s13 失忆** | 16 轮 | PASS | PASS | **-3.9%** | 8.5K→59K · **平顶 ~15K** |
| **s10 洪水** | 76 轮 | PASS | PASS | **-37.9%** | 8.8K→**217K** · **~27K（13%）** |
| **CB50 检索** | 50 题 | 完赛（5 超时） | 完赛（1 超时） | +41.4% | **召回反超：fileR +12.4% · spanR +9.9%** |

**全部通过 verifier（能力无损）。** 价格结论分两类：编码任务组 slice-ts 贵 8%~66%（集成保真税，见 §4）；压力/记忆组 slice-ts 便宜 4%~38% 且峰值有界——对话越长、上下文越大，slice 优势越大；检索组 slice 召回反超（见 §5）。

## 2. 计量口径

- **freshIn**（新鲜输入）= `usage.inputTokens`（DISJOINT 语义，不含缓存命中）
- **cacheIn**（缓存命中输入）= `usage.cacheReadTokens`
- **out** = `usage.outputTokens`
- **price** = freshIn×$0.14/M + cacheIn×$0.0028/M + out×$0.28/M
- **峰值输入** = 单次请求最大 (inputTokens + cacheReadTokens)
- dsh 原生计量：`ctx.tokenMeter`（usage/pressure/breakdown 投影，session/event 驱动）已调研；本报告计量与其同词汇，后续可切换为投影直读

## 3. 压力组详表（slice 主场）

### s10_compactloss（76 轮上下文洪水）

| 指标 | default | slice-ts |
|---|---|---|
| verdict | PASS（零丢失） | PASS（零丢失） |
| freshIn | 373,892 | 490,015 |
| cacheIn | 40,171,776 | 7,777,664（**-80.6%**） |
| out | 18,313 | 54,073 |
| **price** | **$0.169953** | **$0.105520（-37.9%）** |
| 峰值 | 217K（t45 仍在涨） | ~27K（平顶） |

default 的输入费 $0.1648 中 $0.1125 是**缓存重读**（40M token 的历史重发）——transcript 成本结构的实锤。

### s13_compact_amnesia（16 轮：埋点事实 + 洪水 + 回忆测验）

| 指标 | default | slice-ts |
|---|---|---|
| verdict | PASS | PASS（TOML 回忆、诚实声明、回忆路径说明全对） |
| price | $0.014722 | $0.014155（-3.9%） |
| 峰值 | 59K 棘轮 | **平顶 ~15K（1/4）** |

## 4. 编码组成本分析（集成保真税）

slice-ts 在 5 个编码场景贵 8%~66%（freshIn 2~3×），字节解剖定位的构成：

1. **workspace baseline 重组合**：每次文件编辑后 workspace-context 重新生成基线（KB 级），进入请求 → 每轮新鲜
2. **dsh 全量工具 schema**（26K chars）+ system 节（4.7K chars）——byte-stable 可缓存，但首充与变更加新鲜
3. **verbose 输出**：slice-ts 的 out 普遍更高（s2: 96K vs 72K）——思考更啰嗦是模型行为差异，非架构项

Python sidecar 臂（历史对照）同场景便宜 13%~66%——它工具 schema 更瘦、无 dsh 节。这是"as integrated as default loop"的诚实代价：保真度换成本。**峰值有界性不受影响**（slice 振荡回落 vs default 棘轮），长任务下价格优势开始反超（s13 平、s10 -38%）。

## 5. CB50（ContextBench-50 精准检索）

双臂各 50 题完赛（本地评分器，gold_context 后缀对齐；pulled 账本含 bash/read/grep/git-show 读取姿势）：

| 指标 | default | slice-ts | Δ |
|---|---|---|---|
| **fileRecall** | 0.677 | **0.761** | **+12.4%** |
| **spanRecall** | 0.684 | **0.752** | **+9.9%** |
| filePrecision | 0.186 | **0.208** | +11.8% |
| 超时题数（20min 上限） | 5 | **1** | — |
| price（合计） | $0.7746 | $1.0957 | +41.4% |
| freshIn | 1,662,997 | 3,997,844 | — |
| cacheIn | 93,080,320 | 97,326,080 | — |
| out | 1,004,015 | 940,971 | — |

**要点**：评测前提"transcript 是检索主场"被证伪——slice-ts 召回**全面领先**（文件 +12%、span +10%、精度 +12%）且超时仅 1/5。bounded slice 强迫的"每轮重读纪律"在检索任务上是优势而非劣势。代价仍是价格（+41%），与编码组同因（集成保真税）。

## 6. 运行方法

```bash
# 双臂：default = web profile:3082；slice = slice-ts profile:3083（dsh-slice-agent-loop 取代 agent-loop）
node scripts/dsh-h2h.mjs <scenario> both              # 5 场景（evals/h2h 格式）
H2H_SCENARIOS_DIR=.../multiturn_coding node scripts/dsh-h2h.mjs s10_compactloss both
node scripts/cb50-dsh.mjs default 50                  # CB50（双臂并行各一进程）
```

原始数据：`/tmp/dsh-h2h-*.json`、`/tmp/cb50-{default,slice}.json`。
