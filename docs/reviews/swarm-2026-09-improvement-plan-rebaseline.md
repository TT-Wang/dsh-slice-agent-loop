# swarm-2026-09 改进计划 · 对 main f5fc4b1 的重新基线

`docs/reviews/swarm-2026-09-improvement-plan.md` 的 27 条 finding 是对着快照 `62db5ce2`（= `db72621` 加上 deep-review 文档）写的。本文件把这 27 条逐条放到当前 main 上重验：

- 验证基线：`f5fc4b1` = `db72621` + PR #8（`2b55782`、`023385f`、`059687a`）。
- 方法：8 名分领域 verifier 逐条取现场证据，每组再配一名 skeptic 专门找反例；27 条判定**零条被推翻**。
- 计划原文保持冻结。凡行号锚点、字符数、字节数与本文件不一致，**以本文件为准**。
- **2026-09-27 复核**：PR #10–#12 合并后，对 main `ba12a5b` 重新核对了下文「仍需决策的条目」里的四条，结论与处理见文末[「2026-09-27 复核」](#2026-09-27-复核)，与上文冲突处以该节为准。

## 计数

| 状态 | 条数 | ID |
|---|---|---|
| 已修复 | 17 | P0-1~P0-4、P1-2~P1-5、P1-7~P1-9、P2-1~P2-3、P2-5、P2-9、P2-11 |
| 仍成立 | 7 | P1-1、P1-6、P1-10、P2-4、P2-6、P2-7、P2-8 |
| 部分修复 | 2 | P2-10、P2-13 |
| 前提不成立 | 1 | P2-12 |

> 复核（2026-09-17，本分支）：P2-12 的「前提不成立」曾被一条代码评审意见反驳（称 pnpm 11 没有内置默认值、`ageCheckActive` 不存在）。实跑探针后该反驳不成立，本表维持原判，证据见下方勘误。

## 逐条重验（按计划顺序）

| ID | 问题（一句话） | 状态 | 修复提交 / 现在的锚点 | 说明 |
|---|---|---|---|---|
| P0-1 | packed fixture 用已退役的 `history` 键，发行版装载即抛错 | 已修复 | `2b55782`、`059687a`；`scripts/validation/packed-profile.patch.yml`、`packed-runner.mjs:85`、`tests/gates-packed-fixture.spec.ts` | fixture 改用打包默认值，runner 断言换成 `[slice tape v1`；离线互锁测试文件名与计划不同，作用相同 |
| P0-2 | `CONTEXT.md` 仍按压力归档描述，与现役封存不符 | 已修复 | `2b55782`/`023385f`/`059687a`；`CONTEXT.md:5,27-42`、`scripts/check-doc-anchors.mjs` | 锚点检查直接就是阻断门禁（`ci.yml:35`、`compat.yml:39`）；旧段落未迁入 `docs/legacy-loop.md`，只留一句“已退役” |
| P0-3 | 轮次归属有两个真源，无 recall 页时可能静默丢内容 | 已修复 | `059687a`；`src/turn-ownership.ts:11-13`、`src/context.ts:186,220`、`src/recall.ts:190,399` | 归属统一到 `userMessageTurn`，`turns[0] < 1` 即保护；用例在 `tests/recall-ownership.spec.ts` |
| P0-4 | `entryMaxChars` 不是真上限 | 已修复 | `059687a`；`src/context.ts:341-369`、`src/context-reads.ts:200-213`、`tests/context-costs.spec.ts:44-87` | 多档收缩加固定兜底，按构造成立；75 组对抗探针 0 超限 |
| P1-1 | `recall_turn` 默认 `view:"full"`，单次取回约 +14.6K token | 仍成立 | 无；`src/recall.ts:172,619,589-592` | PR #8 只改了定位符与归属，默认视图未动，描述里也没写 full 的代价 |
| P1-2 | `lib` 漂移门禁用 `git diff`，漏掉未跟踪文件 | 已修复 | `059687a`；`ci.yml:38-39`、`scripts/check-build.mjs:10`、`tests/gates.spec.ts:39-51` | 改成 `check:build`，连 ignored 文件也拦；五种漂移都有真实 git 用例 |
| P1-3 | `scripts/*.mjs` 不参与 typecheck | 已修复 | `059687a`；`tsconfig.gates.json`、`package.json:36` | 覆盖 10 个 `.mjs`（多于计划写的 7 个），当前 0 错误 |
| P1-4 | compat 只跑 `--latest`，peer 范围从未被验证 | 已修复 | `059687a`、`023385f`；`compat.yml:35-38`、`scripts/check-peer-ranges.mjs` | 改为越界即失败的单腿，未按计划拆两腿；效果等价 |
| P1-5 | 每次 seal 全量重扫日志并重算哈希 | 已修复 | `2b55782`、`059687a`；`src/context-reads.ts:54,106-173` | 按 Session 缓存加 `nextSeq` 水位；400 轮实测单次 seal 0.24-0.58 ms |
| P1-6 | 受保护的原始节点每轮重付，条目里毫无记账 | 仍成立 | 无；`src/context.ts:223,231-235,300-326`、`src/fold/index.ts` | `own` 谓词未改，fold 不处理 user 消息；探针确认首轮 pin、多模态、插件 append 三类仍每轮重发 |
| P1-7 | 无派生消息的事件不留痕迹，首行计数对不上 | 已修复 | `059687a`；`src/context.ts:270-326`、`tests/context-costs.spec.ts:149-161` | 空 user 与空 assistant 都有占位行，首行计数取自 `covered.size` |
| P1-8 | 没有覆盖率度量，死路径不可见 | 已修复 | `059687a`；`vitest.config.ts:7-15`、`package.json:45`、`ci.yml:37` | 阈值 85/78/86/90，实测 87.07/79.8/88.32/91.22，余量仅 1-2 个百分点 |
| P1-9 | 单轮超窗行为未定义，注释指向不发布的 `src/lab` | 已修复 | `2b55782`、`059687a`；`src/index.ts:178-182`、`tests/native-overflow.spec.ts` | 明确划给宿主；用例断言抛出 `CONTEXT_WINDOW_EXCEEDED`、surface 不被改写、之后仍可 recall |
| P1-10 | 教学文案在前缀与每条条目里重复 | 仍成立 | 无（`023385f` 加 `formatVersion` 后更长）；`src/context.ts:287,307-309`、`src/index.ts:54-63`、`src/fold/index.ts:67-78` | 条目 header 瘦身不改前缀；KERNEL/fold/工具描述去重属前缀变更，按 ADR-0001 必须先 A/B |
| P2-1 | `viewChars`/`historyChars` 每轮强制 stringify | 已修复 | `059687a`；`src/context.ts:58-64,466-468` | 改成惰性 getter 且只算一次；实跑 seal 全程 `JSON.stringify` 0 次 |
| P2-2 | `chars()` 用 `Array.from` 分配数组 | 已修复 | `059687a`；`src/context.ts:73-84` | 改为正则扣代理对，与 `Array.from` 语义逐例一致；5MB ASCII 由 38.4 ms 降到约 0 ms |
| P2-3 | 未配对 cut 警告每轮重复刷屏 | 已修复 | `059687a`；`src/context.ts:371,422-458`、`tests/context-costs.spec.ts:164-174` | 每 session 每 key 只发一次；未配对轮仍不封存 |
| P2-4 | `requestChars` 与死模块随 `lib/**` 发布 | 仍成立 | 无；`src/context.ts:490`、`package.json:8-30` | 现值：5 个不可达模块、38,361 B / 232,690 B（16.5%）；这些模块仍被 5 个测试文件（`read-bases`、`recorded-memory`、`tape-admission`、`tape-knobs`、`unit`）和 `src/lab/state-selectors.ts` 引用 |
| P2-5 | `mock-adapter` 里两个 helper 零使用 | 已修复 | `059687a`；`tests/mock-adapter.ts:27-52`、`tests/native-context.spec.ts:337-339` | `multiToolCallResponse` 补了真用例，`errorResponse` 删除 |
| P2-6 | `observations/files.ts` 只读 `content[0]`、漏 `source.callId`、静默丢结果 | 仍成立 | 无（`2b55782` 仅改事件名）；`src/observations/files.ts:97-101` | `recall.ts:235-241,432-435` 已按多块与 `callId` 回退处理，两处行为不一致 |
| P2-7 | `FOLD_BODY` 承诺保留 “every structured line”，实现会丢 | 仍成立 | 无（`src/slice/result-digest.ts` 无改动）；`src/fold/index.ts:68`、`src/slice/result-digest.ts:63-64,191-207` | 键新颖性加块上限是有意省 token；应改承诺而非改实现 |
| P2-8 | `results/` 撑大 Git 安装体积 | 仍成立 | 无；`scripts/check-repo-size.mjs:25,47-58` | 现值见勘误；余量约 5 MiB，再加一两个实验目录就触发门禁 |
| P2-9 | 摘要用例依赖 `Math.random` | 已修复 | `059687a`；`tests/result-digest-longline.spec.ts:7` | 直接改成序号生成，比固定种子 PRNG 更简单；全 `tests` 无随机源 |
| P2-10 | Node 矩阵不覆盖 `engines` 下界 | 部分修复 | `059687a`；`ci.yml:21`、`compat.yml:30` | CI 已是 `['22.19.0','22.22.3','24.x']`；compat 仍写死单一 `22.22.3` |
| P2-11 | `plan/SEAMS.md` 横幅把压力归档说成现役 | 已修复 | `059687a`；`plan/SEAMS.md:12-15` | 已改为 `planSeal`/`applySeal`/`sealCompletedTurns`，并写明“没有压力阈值” |
| P2-12 | `minimumReleaseAgeExclude` 无对应策略 | 前提不成立 | `059687a`（注释内容有误）；`pnpm-workspace.yaml:5-18`、`package.json:116` | pnpm 11.7.0 内置默认 1440 分钟，exclude 本来就生效；PR #8 新加的注释是错误信息，本分支已改写并附实测 |
| P2-13 | deep review 六个文档/链接类子项 | 部分修复 | `059687a`；`scripts/link-dsh.mjs:16-21`、`docs/agents/triage-labels.md:3,13`、`docs/upgrade-verification.md:3-6` | 四项已修；仍缺四个 GitHub 标签，master 兼容仍是手动 |

## 对计划原文的勘误

- 多数行号已随 PR #8 移动，逐条修正见上表“现在的锚点”一列。
- **P2-8 的“打包载荷 ≈14.9 MiB”是错的。** `f5fc4b1` 上 `npm pack --dry-run`：47 个条目、打包约 0.10 MiB、解包约 0.30 MiB。真正的负担是 `dsh plugin add github:` 走的 Git 克隆，已跟踪内容 58.95 MiB，其中 `results/` 占 57.43 MiB（97.4%、809 个文件），距 `check-repo-size` 的 64 MiB 上限余约 5 MiB。
- **P2-12 的前提不成立。** 仓库锁定 `pnpm@11.7.0`，其内置默认 `minimum-release-age` 为 1440 分钟，安装路径上的 `ageCheckActive = Boolean(opts.minimumReleaseAge)` 会读到这个默认值。因此计划的选项 B 本身是错的，`059687a` 据此写进 `pnpm-workspace.yaml` 的注释（“only take effect when … enabled by a user/global pnpm configuration”）同样是错误信息，需要纠正。
  **2026-09-17 复核（起因是一条反方评审意见，称没有内置默认值）**：判定维持不变，反方意见被下面三条证据推翻。①活体探针：空目录、无任何 pnpm 配置、只有一份依赖 `typescript@7.1.0-dev.20260917.1`（一小时前发布）的 `package.json`，`pnpm install --lockfile-only` 直接对它套用年限策略，并自动把 8 个条目（含 7 个传递依赖）写进新建的 `minimumReleaseAgeExclude`。②`pnpm@11.7.0` 的 dist 默认配置表里就是 `"minimum-release-age": 24 * 60, // 1 day`，`ageCheckActive` 在该文件中出现 3 次。③`pnpm config get minimum-release-age` 输出 `undefined` 只说明没有显式设置——`config get` 从不回显内置默认值，不能当作“没有策略”的证据。
  连带纠正两点：显式写上 `minimumReleaseAge: 1440` 确实**不改行为**（同一份 lockfile，加与不加 `pnpm install --frozen-lockfile --lockfile-only` 都是 rc=0）；策略作用于传递依赖这点属实，但 `minimumReleaseAgeStrict` 关闭时 pnpm 会自己把它们补进 exclude 列表，所以不是“CI 必挂”，`compat.yml` 的 `--latest` 腿同理（它在有无该键时受同一道门，与本分支改动无关）。`scratchpad/rebaseline-27.keep.json` 里 P2-12 的记录与本条一致，无需更正。
- **P2-4 的量化按当前重算**：不是计划写的 12/25、38,363 B / 213,763 B（17.9%），而是 21 个非 lab 模块里 5 个不可达，38,361 B / 232,690 B（16.5%）。`src/slice/internal/*` 与 `src/slice/tape.ts` 仍可达，不要动。
- **P1-10 的字符数按当前重测**：条目首行 header 188（原 170）、`KERNEL` 1,270（原 1,210）、`FOLD_AFFORDANCE` 1,188 / `foldAffordance(true)` 1,405（原 1,139 / 1,313）、四个工具定义合计 5,204（原 4,451）。加上定位语法里的 `formatVersion` 后文案反而变长了。
  **这些数字只对基线 `f5fc4b1` 成立**：本分支的 P1-1、P2-7 改的正是这些串，已经把它们推翻——实测本工作树 `KERNEL` 1,270 → 1,399（`src/index.ts:59` 的 RECALL 段），`FOLD_AFFORDANCE` 1,188 → 1,351 / `foldAffordance(true)` 1,405 → 1,568（`src/fold/index.ts` 的 P2-7 改写），四个工具定义的合计也随 `src/recall.ts`、`src/recall-step.ts` 的描述改写而变。要引用量化就以 `f5fc4b1` 为准并注明基线，或在本分支上重测。

## 本分支处理方式（`fix/roadmap-rebaseline-2026-09-17`）

以下是本分支打算落地的改动，供集成者复核，不是已验证结论。

- **P1-1**：`recall_turn` 默认视图改为 `dialogue`，只有显式传 `view:"full"` 才返回原始 JSON 记录；工具描述同步说明 full 的量级。磁带条目里的 recall 指针一并改为默认视图——包括 compact 档 header 与 `renderCheckpoint` 的兜底行（`src/context.ts:310,366`），它们原先仍写 `view:"full"`，恰好只在积压最大时出现，等于让模型对范围内每一轮都取 100× 的页面。
- **P2-7**：改 `FOLD_BODY` 的措辞使其如实（首尾行、结构行与标题保留；连续结构块只留前几行与新键行，**且每块最多十几行**——`structuredBlockCap` 对散文夹结构块的混合文档同样生效，键全新也照丢；省略处有标记，可用 `expand_result` 取回），不改 `digestData` 的实现。`tests/fold-plugin.spec.ts` 对 `cap = Infinity`（整份结构化）与 cap 生效（混合文档）两条路径各有一例。
- **P2-4**：删除无调用方的 `requestChars`；五个死模块用 `git mv` 迁到 `src/lab`（已被 `files` 排除，不随包发布）。
- **P2-6**：**本分支不修**。`src/observations/files.ts` 正是上述死模块之一，迁入 `src/lab` 后不在发布路径上；修法（按块遍历、`block.toolCallId ?? message.source?.callId` 回退、与 `recall.ts` 共用原始事件判定、匹配不到时记账）记在该文件头部注释里，供将来重新接线时使用。
- **P2-12**：在 `pnpm-workspace.yaml` 里显式写出 `minimumReleaseAge: 1440`（与 pnpm 11 的内置默认同值，不改行为），注释改成“pnpm 11 默认 1440 分钟，下列包需要豁免”，并把上面那三条实测证据一并写进注释——这条结论已经被误读过一次，注释里必须自带反驳材料，同时写明策略覆盖传递依赖、非 strict 模式下由 pnpm 自动补列。
- **P2-10**：`compat.yml` 的 node 由单值改为矩阵，与 CI 对齐。

## 仍需决策的条目

- **P1-6（受保护原始节点的记账）**：二选一或并用——(a) 各生产者插件自己限制注入的 user-role 内容；(b) 封存时对同一轮中仍被保护的节点写一行说明，例如 `[turn N · k message(s) kept raw at original position]`。**不得**放宽 `own` 谓词。
- **P1-10（教学文案去重）**：注意本分支的 P1-1 与 P2-7 已经改动了 `KERNEL` 与 `FOLD_AFFORDANCE`，也就是缓存前缀本身，集成者需与下条 ADR-0001 的决策一并权衡。条目 header 瘦身只影响今后写入的条目，可以先做；`KERNEL`、`FOLD_AFFORDANCE` 与工具描述的去重会改动缓存前缀，按 ADR-0001 必须在 native 路径上重做门禁 A/B（同轮重复读取率、recall 准确率、成本），不能沿用退役渲染器的结论。
- **P2-8（仓库体积）**：把 `results/` 移出主仓库（独立 archive 仓库、release 资产或 LFS），或者明确提高 `check-repo-size` 的上限。
- **P2-13（triage 标签与 master 兼容）**：远端仍缺 `needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`。要么由维护者确认后用 `gh label create` 创建（属仓库设置变更），要么把 `docs/agents/triage-labels.md` 重新映射到现有标签（如 `question`、`help wanted`）。另需决定 master 兼容是否自动化（新增每周的 `verify:master` 作业，或维持文档已标注的 manual-only）。

### 已判为修复、但值得继续跟踪的残留

- **compat 作业**：`check:peers`、`check:build`、node 矩阵都是修复后接进去的，定时作业尚未在修复版本上实跑过一次；已在 `f5fc4b1` 上手动触发一次 run `35201824220`，需确认结果。
- **P0-4 降级过陡**：13 轮、每轮 10 个长路径 read 加 10 个工具、cap 2000 时，整条条目会从逐轮摘要直接掉到约 153 字符的范围标记（内容仍可 `recall_turn` 取回）。可考虑按轮分配预算，但不得改写已封存条目。
- **P1-5 残留线性扫描**：`src/context.ts:182` 的 `inspectSurface` 每次 seal 仍全量遍历一次日志（不算哈希，且只在 `step === 1` 触发，实测 1 ms 内）。优化前先量长会话实际耗时。
- **P1-9 依赖宿主**：插件内没有轮内 seal，超窗完全交给宿主；现有用例用的是模拟 provider，尚无真实 compaction 组合的集成验证。

## 2026-09-27 复核

方法：四条各派一名 verifier 在 `ba12a5b`（PR #10 `63c928c`、#11 `406f513`、#12 `ba12a5b` 之后）上取现场证据并实测，再各配一名 skeptic 找反例，分歧由第三人逐点实查裁定。四条的状态判定无一被推翻，数字与说法按下表更正。量化用到两份真实 V4 会话（Raft 外部 agent `slicey-dsh`，2026-09-25，`raft-slicey-dsh-1`/`-2`，360/408 次请求）。

| ID | 复核状态 | 结论 | 处理 |
|---|---|---|---|
| P1-6 | 前提已变，结项 | PR #11 删除了 `own` 谓词与 `pinFirstTurn`：所有非 slice 的 `user/message` 一律原样保留（`src/context.ts` 的通用保护分支），这是 ADR-0003 有意接受的成本；KERNEL 用一句全局声明（人类消息逐字留在原节点）代替了逐条记账。PR #12 起 `system/message`、`developer/message` 一律保护。唯一随轮数线性增长的非人类来源是插件注入的 `[Raft wake]` 提示：`raft-slicey-dsh-2` 末次请求 94 条、12,502 字符（surface 文本的 7.9%），全会话累计约占输入 token 的 4.0–5.3%，其中 97.5% 是 cacheRead。 | 放弃原方案 (b)：每个条目一行“kept raw”记账约 54 字符，不提供 KERNEL 之外的信息。上文 P1-6 行与本节之前对 `own` 的引用均已失效。可选跟进（低优先级）：在 dsh-raft-channel 里缩短唤醒提示。 |
| P1-10 | 仍成立，数字更正 | `ba12a5b` 上：条目首行 188 字符（教学从句 142）、`KERNEL` 1,543、`FOLD_AFFORDANCE` 1,351 / `foldAffordance(true)` 1,568、四个工具定义 JSON 5,436。真实会话里首行教学从句约占 cacheRead 的 2.7–4.7%；工具行的 `expand_result` 定位符累计更大（322 万 / 257 万字符）；前缀去重每请求约 305 token，只有首行收益的五分之一左右，而一次前缀变更让跨部署的活跃会话各整请求未命中一次（实测 8.7K–59K token）。 | **更正上文方向**：ADR-0001 要求 A/B 的对象正是按轮付费的条目 header 瘦身，上文“条目 header 瘦身可以先做”说反了；“前缀变更先 A/B”也从未执行过（PR #9/#11/#12 都改过前缀）。决定：做一次 native A/B（对照 = main；实验臂 1 = 首行短图例 + 前缀每条规则只讲一处；实验臂 2 = 臂 1 + 工具行短定位符），通过后搭下一次本来就要改前缀的版本发布。实验设计与结果见 `docs/p110-native-ab.md`（实验分支 `exp/p110-ab-harness`）。 |
| P2-8 | 已处理 | 上文“Git 克隆 58.95 MiB”的口径也不对：`dsh plugin add github:` 由 pnpm 下载该 commit 的 codeload tarball（约 12.5 MiB，95% 是 `results/`），不带历史，再按 `files` 只装约 0.27 MiB。 | PR #13：`results/` 的数据移到 release [`archive-legacy-results-2026-09-04`](https://github.com/TT-Wang/dsh-slice-agent-loop/releases/tag/archive-legacy-results-2026-09-04)，`results/*` 改为忽略（保留 `results/README.md`），`check:size` 上限 64 → 8 MiB；不改写历史。安装 tarball 由 13.1 MB 降到约 0.64 MB。 |
| P2-13 | 已处理 | 缺的标签实际是 9 个（4 个 triage + 5 个 `/wayfinder`）；手动源码验证在 0.1.7 上已跑不通（全新 rc.2 检出 335/342）；compat 周任务跟踪的 npm `latest` 仍是 0.1.5-rc.3，只是在重测 rc.2。 | 2026-09-27 由维护者建了 4 个 triage 标签（`/wayfinder` 的 5 个待首次使用前再建）。PR #14：`verify:master` 在全新 `dsh-v0.1.7-rc.2` 检出上 342/342，并写进“升级宿主前”步骤；compat 周任务改为跟踪 `@deepseek-ai/dsh*` 的 `next` dist-tag（cordis 仍用 `latest`），合并后手动触发一次通过。 |

复核中顺带发现、不属于这四条的事项：

- 真实会话里，系统提示在会话中途变化会让宿主原位替换 surface 第 0 个节点，下一请求整请求未命中；`raft-slicey-dsh-1`/`-2` 各发生 2/4 次，全部由开发期间修改 Raft orientation 文本引起。
- 唤醒提示用 source kind `user`，`recall.ts` 的 `isUserInput` 会把它当成人类输入，稀释 `recall_search` 的 user 类命中。
- `dsh-tool-skill` 的替换 skill 目录、在已有条目之前被取代的 runtime-context 快照等节点永久保留，数量随“变更次数”而不是轮数增长；raft 会话里各 0–1 份，频繁切换技能或权限的交互会话未测。

