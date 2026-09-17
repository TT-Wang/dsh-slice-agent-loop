# dsh-slice-agent-loop 唯一优先化改进路线图（T9 synthesis）

- **snapshot commit**：`62db5ce2f94be74a6bdca2c1376d9e02112fe95f`（四份审计与三份 verification 都锚在此提交）。
- **输入 artifact**（全部 accepted，独立 verification 均 accept）：
  - context/tape 审计（重建）：`80d521c5e7c3303a0d061d436e93289cd26b7120` → `docs/reviews/swarm-2026-09-audit-context-tape.md`；verification T5-rebuild `task_08d3f04b`（verdict accept，F7 partly refuted，3 条硬修正见下）。
  - recall/fold 审计：`50176dc5d71cdca756706bff1b49744b50e19319` → `docs/reviews/swarm-2026-09-audit-recall-fold.md`；verification `task_3a0a88eb`（accept，F1–F6 confirmed）。
  - token/cache 审计：`97ec9f6ec9a46b227bb6f3d95f2c16f895960ddb` → 本任务发出的 T7 verdict（accept，2 处文字修正）。
  - 仓库卫生审计：`f35910c5e58b82bf90d78722858128858b0f96c5` → 本任务 T4；verification T8（accept，**HH-9 量化被 refute 并已修正**）。
- **证据标注**：`本任务` = 我在 T9 这次 attempt 内现跑的只读命令（run id 见 §7）；`转述` = 直接来自上述已 accept 的审计/verification（写明出处）。harness 端绝对值凡未自己重跑的一律标转述，并优先使用 verification 修正后的结构性结论。
- **本文是唯一交付物** `docs/reviews/swarm-2026-09-improvement-plan.md`；工作树零源码改动（唯一 git-status 行是这份新增未跟踪文件，worker 不能写 git 元数据）。

## 0. 结论摘要（≤10 行）

1. 快照的**核心承诺成立**：seal 只在下一轮第一步发生、替换原位 span，条目一经写入字节冻结；稳态每轮只重付「新条目 + 新用户消息」。
2. 但**唯一的 `lib/` 端到端门禁 `verify:packed` 当前必然失败**（fixture 用已退役键 + 断言一个没有任何代码发射的 `[slice checkpoint v1`），等于交付产物没有端到端验证。
3. **领域文档 `CONTEXT.md` 91.5% 的字节描述一个已被删除的机制**（压力归档/水位/请求预算），它已经带偏过本 mission 的任务简报。
4. 最大的**可避免 token 浪费**是 `recall_turn` 默认 `view:"full"`：一次默认取回可注入 ≈58.8K 字符（≈14.7K token），而 dialogue 视图只需 460 字符（转述 T2/T6）。
5. 第二类是教学文案重复：前缀里 7,063 字符 + 每条新条目 170 字符定位手册，可省 ≈260–400 字符/轮（≈65–100 token/轮）。
6. `entryMaxChars` **是目标不是上限**（`maxChars` 只在 `src/context.ts:431` 用于提前返回），实测条目可达 59,577 字符。
7. 无轮归属的 `user/message` 会被封存但没有任何 recall 页（`ownerOf` 返回 null）→ **静默内容丢失**。
8. 每轮 `planSeal` 做 2 次全日志扫描并对每个历史 read 结果重算 sha256（`agent/pre-step` 同步路径）——纯 CPU，0 token。
9. 仓库卫生是一组「门禁洞」而非红板：typecheck 漏 7 个 `.mjs`、lib 漂移门禁漏新增未跟踪文件、无覆盖率度量、engines 下界与 peer 范围无断言。
10. 不要为上述任何一项去动 seal 时机、条目字节或工具注册顺序——那会把缓存价变全价（§5）。

## 1. 独立复核 `docs/reviews/2026-09-deep-review.md` 的 P0/P1（本快照）

判定口径：「仍成立」= 我用本任务只读命令在 `62db5ce` 上确认了其代码状态；「需修正」= 结论方向对但表述/量化/机制有误，路线图采用修正后的形式；「已修」= 本快照内不成立（本轮无此项）。

| deep review 项 | 判定 | 本任务自己的只读证据 | 归入 |
|---|---|---|---|
| P0-1 无轮归属 `user` 消息被静默归档且不可取回 | **仍成立**（锚点复核；运行时幅度转述） | `src/recall.ts:138-141` `ownerOf` 仅当 `openTurn !== null` 或 `source.kind === 'plugin'` 才返回轮号，否则 `null`；`src/recall.ts:218/:234/:422` 全靠它做归属。我未重跑 E8 探针 → 幅度转述自 deep review E8（`page1=false page2=false searchHits=[]`） | P0-3 |
| P0-2 `entryMaxChars` 名为目标实为无界 | **仍成立，量化需修正** | `grep -n maxChars src/context.ts` → 仅 `:411` 注释（自认 target）与 `:431` `if (Array.from(text).length <= maxChars) return text`；`readIndexLine`（`:378-387`）只按条数（`READ_INDEX_PER_TURN=10`，`:70`）截断、无字节上限。deep review 的 59,577 字符来自「400 字符长路径 × 10 reads/轮」的构造；T5-rebuild 的小 fixture 给出 400/1000 → 同一条 2,060 字符 `fits=false`、8000/100000 → 3,880 `fits=true`（转述 T5） | P0-4 |
| P0-3 `verify:packed` fixture 用已退役键 | **仍成立** | 本任务 T4 HH-1：`packed-profile.patch.yml:48-51` 三键在装载期抛 `Retired history configuration highWaterChars`；`CHECKPOINT_PREFIX`（`src/context.ts:31`）无发射点，`packed-runner.mjs:64-66` 却断言 replacement 含 `[slice checkpoint v1` → `ci.yml:39` 必然失败。T8 独立复现同一结论 | P0-1 |
| P0-4 `CONTEXT.md` 把退役策略写成现役 | **仍成立** | 本任务 T4 HH-2：`CONTEXT.md` 6,856/7,491 字节（91.5%）描述压力归档；`planArchive`/`applyArchive`/`archiveUnderPressure`/`SliceBudgetError` 在 `src/`、`lib/` 0 命中；`git log` 显示 CONTEXT.md 停在 2026-09-09，`src/context.ts` 2026-09-12 | P0-2 |
| P1-1 `git diff --exit-code -- lib` 漏新增未跟踪文件 | **仍成立** | 本任务 T4 HH-4 / T7 重放：存在 `lib/__drift_probe.js` 时 `git diff --exit-code -- lib` exit 0，而 `git status --porcelain -- lib` 显示 `??`；Git 安装只拿已跟踪文件 | P1-2 |
| P1-2 typecheck 不含 7 个 `.mjs` 门禁 | **仍成立** | 本任务 T4 HH-3 / T7 重放：`tsc -p tsconfig.scripts.json --listFilesOnly | grep -c '\.mjs$'` = 0，`find scripts -name '*.mjs' | wc -l` = 7；checkJs 下 CI 真跑的 6 个脚本 32 条错误 | P1-3 |
| P1-3 `compat.yml` 的绿是假绿（`pnpm up --latest` 不动 peerDependencies） | **需修正机制表述** | 我实测：`package.json` 12 个 peer **全部**同时出现在 devDependencies（12/12），且**没有** `dependencies` 段 → `pnpm up "@deepseek-ai/*" --latest` 会更新 devDependencies 的版本（作业确实会装到最新 peer），但**不会改 peerDependencies 的范围字段**，也没有任何步骤断言解析结果满足 `^0.1.3-alpha.2`。所以「作业全程只装旧版本」不成立；成立的是「peer 范围无断言 + 声明范围会悄悄过期」 | P1-4 |
| P1-4 `readHistory` 每次 seal 重扫全日志 + 每个 `tool/result` 重算 SHA-256，且在 `agent/pre-step` 同步路径 | **仍成立（结构）** | 我实测：`src/index.ts:167` `ctx.on('agent/pre-step', …)`，`src/index.ts:180` 在其中同步调用 `sealCompletedTurns`；`src/context.ts:277` `createHash('sha256')` 在 read 指纹路径；`src/context.ts:415` `renderCheckpoint` 内 `readHistory`。耗时绝对值转述 T5（0.05/6.76/10.85/21.47 ms @ 0/50/100/200 历史 read；每 seal 2 次全日志扫描） | P1-5 |
| P1-5 无派生消息的归档节点在条目里没有痕迹 | **仍成立** | 我实测 `src/context.ts:327` `if (!node.message) continue`；`:395` `if (item.reply) lines.push(...)`，`:394` users 只在 `event.type === 'user/message'` 时 push → 空文本 user / max-tokens 空 assistant 不产出任何行，而首行仍打印 `N turn(s) sealed` | P1-7 |
| P1-6 「单轮超窗」无兜底，注释指向不存在的机制 | **需修正** | `inTurnSeal` 命中 `src/index.ts`（仅 `:179` 注释）、`src/lab/step-tape.ts`（`tsconfig.json:21-23` 排除、不 emit、不在调用图）、tests/docs。结论仍是「没有现役兜底」，但不是「仓库里完全没有」 | P1-9 |
| P1-7 插件注入的 user-role 消息永不归档 | **仍成立，修复归属需修正** | `src/context.ts:232` `own = surfaceOp==='append' && source.kind==='user' && content.every(block => block.type==='text')`，不满足即 `guarded=true`（永久保护）。T5-rebuild 修正：修复应落在各生产者插件（fold/digest 等），**绝不放宽 `own` 谓词** | P1-6 |
| P1-8 测试替身死路径（多工具调用、错误分支） | **仍成立** | 我独立 grep：`tests/mock-adapter.ts:15` `errorResponse`、`:32` `multiToolCallResponse` 在全 `tests/` 中**零使用**（`fold-plugin.spec.ts:21` 只 import `MockAdapter, textResponse, toolCallResponse`）；9 处 `new MockAdapter` 全部走 `toolCallResponse`/`textResponse` | P2-5 |
| P1-9 无覆盖率度量/门禁 | **仍成立** | 本任务 T4 HH-5：`grep -rn coverage package.json vitest.config.ts .github tests tsconfig*.json` = 0 命中；`@vitest/coverage-v8` 不在依赖闭包 | P1-8 |

**deep review 未含、本轮新增的项**：`recall_turn` 默认 `view:"full"`（T2-F1，P1-1 级 token）；未被任何 recall 页服务的节点分两类：无轮归属 user（P0-1）与「有消息但从不参与 seal 的节点」（T1-F5/T2-F6）；`observations/files.ts` 只读 `content[0]` + 只认 `block.toolCallId`（T2-F5/F6）；`results/` 已占 58.90 MiB 中 57.43 MiB（T4 HH-8 / deep P2-8）；lib 未达模块的正确量化（T4 HH-9 经 T8 修正）。

## 2. 优先化 finding 表（P0 / P1 / P2）

> 每条都给出：动作 → 锚点 → 证据（本任务 run / 转述）→ 预期 token/cache 效果 → 验证方式。

### P0（阻断发布 / 正确性 / 唯一的端到端门禁）

| ID | 动作 | 锚点 | 证据 | token/cache 效果 | 验证方式 |
|---|---|---|---|---|---|
| **P0-1** | 迁移 `packed-profile.patch.yml` 到现役键（`history: { keepRecentTurns: 0, pinUserChars: 600, entryMaxChars: 800 }`），把 `packed-runner.mjs:64-66` 的断言从 `[slice checkpoint v1` 改成 `TAPE_PREFIX`；新增**离线** `tests/packed-fixture-config.spec.ts` 把 fixture 的 `history` 逐字喂给 `nativeHarness` 断言「可装载」，让 fixture 与键集在同一 PR 内互锁 | `scripts/validation/packed-profile.patch.yml:41,48-51`；`scripts/validation/packed-runner.mjs:62,64-66,78`；`src/index.ts:40-45,114-121`；`src/context.ts:31,33`；`ci.yml:38-39`；`compat.yml:50` | 本任务 T4 HH-1（`run_4861d1f5`、`run_412d9381`：fixture 配置构造期被拒；`CHECKPOINT_PREFIX` 全仓无发射点）；T8 accept 复现 | 门禁本身 0 token；挡住的是「发行版本装载即抛错」→ 每个用户会话装载失败 | `npx vitest run tests/packed-fixture-config.spec.ts`；CI 上 `npm run verify:packed` |
| **P0-2** | 重写 `CONTEXT.md` 1-30 行为现役语义（`planSeal`/`applySeal`/`sealCompletedTurns`、`history.keepRecentTurns/pinFirstTurn/pinUserChars/entryMaxChars`、`TAPE_PREFIX`），把压力归档段落迁到 `docs/legacy-loop.md` 并标注退役；落地 §6 检查 1 的文档锚点检查防复发 | `CONTEXT.md:3,5-8,13,16-17,26-30`；`src/index.ts:40-50`；`src/context.ts:448-530`；`src/index.ts:167-181` | 本任务 T4 HH-2（doc-anchor 脚本 `run_cd5afb5f`：`planArchive` 等 0 命中；`CONTEXT.md` 6,856/7,491 = 91.5%）；T8 accept | 每次读取少 ~1.9K 错误 token；消除「照旧文档恢复压力归档」的回归诱因——那个机制每次归档重写整个前缀（`src/context.ts:8-19` 记录 ~148K fresh tokens/次、~8.6% 加权成本） | `node scripts/check-doc-anchors.mjs`（先 warning 后 blocking）；人工对照 `src/context.ts` |
| **P0-3** | 归属只留一个真源：`src/context.ts` 的 `recallAt` 改用 `src/recall.ts` 的 `ownerOf`；在 `src/context.ts:221-238` 加护栏「没有任何 recall 页服务 ⇒ 保护，不封存」；用例加在 `tests/context-policy.spec.ts` | `src/context.ts:185,232-234`；`src/recall.ts:138-141,218,234,422`；`src/context.ts:72-74`（不变量） | 本任务锚点复核（`run_bd7577ff`、`run_d0059065`：`ownerOf` 无 open turn 且非 plugin 时返回 null）；运行时幅度转述 deep review E8 | 正确性（静默内容丢失）；护栏会减少「保护但从不重付」的节点，长期减少每轮视图 | `npx vitest run tests/context-policy.spec.ts`（新增与 `:352-375` 并列的用例） |
| **P0-4** | `entryMaxChars` 要么变成真上限、要么改名：给 `readIndexLine`（`src/context.ts:378-387`）加单项/整行字节上限；在 levels 末尾追加「丢弃 read indices + tool lines」终档使 `maxChars` 可达；新增长路径 × 10 reads/轮 用例断言 `Array.from(text).length <= entryMaxChars` | `src/context.ts:411,378-387,422,424,431`；`tests/context-policy.spec.ts:406-418`（现有用例用短路径绕开） | 本任务 `grep -n maxChars src/context.ts`（`run_5dbe434c`：只有 `:431` 的提前返回；`:411` 自认 target）；结构化结论转述 T5-rebuild（400/1000 → 2,060 `fits=false`）；59,577 字符量级转述 deep review E3b | 条目写入时一次性全额计费：59.6K 字符 ≈ 15K token 一次；此后驻留窗口（cache 价）持续挤压可用窗口，可能触发宿主折叠/驱逐 | `npx vitest run tests/context-policy.spec.ts`（新用例） |

### P1（token 浪费 / 门禁与配置洞 / 每轮重复计算）

| ID | 动作 | 锚点 | 证据 | token/cache 效果 | 验证方式 |
|---|---|---|---|---|---|
| **P1-1** | `recall_turn` 默认改成 `view:"dialogue"`（或要求显式 `full`），并把 `full` 的代价写进工具描述返回帧 | `src/recall.ts:200`（`opts?.view ?? 'full'`）、`:185-191,273-275,299` | 本任务静态复核默认值（`run_bd7577ff`）；幅度转述 T2-F1（58,755 vs 460 chars；T6 复现 71,019 vs 473 on 68,080-char payload） | 单次默认取回 +58.3K 字符 ≈ **+14.6K token**（全价，一次性）；若模型在 30 轮里取回 5 次 ≈7.3 万 token | `npx vitest run tests/recall-views.spec.ts tests/context-policy.spec.ts` |
| **P1-2** | 把 `ci.yml:36-37` 的 `git diff --exit-code -- lib` 换成「构建后 `git status --porcelain --untracked-files=all -- lib` 必须为空」 | `.github/workflows/ci.yml:36-37`；`package.json:24-29` | 本任务 T4 HH-4 / `run_fd0c83f3`、`run_412d9381`；T8 accept | 0 token；防的是 Git 安装拿到缺模块的 `lib/` → 装载失败 | CI step 自证：故意加一个未跟踪 `lib/x.js` 应使门变红 |
| **P1-3** | 新增 `tsconfig.mjs.json`（`allowJs+checkJs+include:["scripts/**/*.mjs"]`）接进 `npm run typecheck`；先修 32 条中真实错误（`check-repo-size.mjs:23,44,53`；`link-dsh.mjs:69,90,110`） | `package.json:36`；`tsconfig.scripts.json:11-15`；`scripts/check-repo-size.mjs`；`scripts/link-dsh.mjs` | 本任务 T4 HH-3（`run_091aa35d`、`run_c630e346`、`run_412d9381`）；T8 accept | 0 token | `npm run typecheck` |
| **P1-4** | compat 拆成两条腿：范围内腿 `pnpm up "@deepseek-ai/*"`（不带 `--latest`）+ 断言解析结果满足 `package.json` 的 peer 范围；越界探测腿保留 `--latest` 但只记录/提示 | `compat.yml:36-37,47-50`；`package.json:44-56,73-83` | 本任务实测（`run_5dbe434c`）：12/12 peer 同时是 devDependency、无 `dependencies` 段 → `--latest` 移动 devDeps 版本但不改 peer 范围字段；`grep -rniE 'satisfies|semver' .github tests scripts package.json` = 0（T4 HH-7）；deep P1-3 的机制表述按此修正 | 0 token；恢复「声明范围真的被验证」 | `node scripts/check-peer-range.mjs`（新增，需 `semver` devDep）+ compat 作业 |
| **P1-5** | 让每 seal 的全日志扫描增量/条件化：per-session `lastSeenSeq` 水位，或 run 内无 `read` 调用时跳过 `readHistory` | `src/context.ts:289-312,415`；`src/index.ts:167,180` | 本任务静态复核（`run_5dbe434c`：pre-step 同步 + sha256 + renderCheckpoint 内 readHistory）；耗时/扫描数转述 T5-rebuild（2 次/seal；0.05/6.76/10.85/21.47 ms）与 T3-W2（10/50/100 轮 → 0.63/5.11/10.96 ms） | **0 token**（CPU/延迟）；消除随会话长度平方增长的首步延迟 | `npx vitest run tests/tape-seal.spec.ts tests/read-index.spec.ts`；对比 scan 计数 |
| **P1-6** | 对「永不参与 seal 的节点」：外部插件 appends / 非文本 user 消息 / 首轮 pin 的可见成本要么由各生产者插件自减（fold/digest 侧收敛），要么在 seal 时以一行 note 记账；**不得**放宽 `own` 谓词 | `src/context.ts:221-238,507`；`src/fold/index.ts:138-167` | 本任务静态复核（`run_5dbe434c`、`run_d0059065`：`own` 要求全 text；`!node.message`/非 sealable 节点 guarded）；结论转述 T1-F5 + T5-rebuild 硬修正 | 这些字节**每轮重付**（稳定前缀 = cache 价，但首次写入与内容增长是全价）；量化需按生产者逐项测 | 针对每个生产者加一个「是否仍出现在第 N 轮请求里」的用例 |
| **P1-7** | 归档节点里给「有轮次但无派生消息」的事件留痕迹（如 `[turn N · no derived message: <event type>]`），或把首行 `N turn(s) sealed` 改成实际落盘的计数 | `src/context.ts:327,394-395`；`:185` | 本任务静态复核（`run_5dbe434c`：`if (!node.message) continue`；users/reply 条件 push）；幅度转述 deep P1-5（E4） | 每轮多几字节（新条目写入时一次性），换来条目自述与事实一致 | `npx vitest run tests/context-policy.spec.ts`（空文本 user / 空 assistant 用例） |
| **P1-8** | 加覆盖率度量与门禁：`@vitest/coverage-v8` + `vitest.config.ts` 的 `coverage`（exclude `src/lab/**`、`results/**`）+ `test:coverage` 脚本 + CI 一步；阈值从实测值起步 | `vitest.config.ts:4-6`；`package.json:34-42`；`ci.yml:33-34` | 本任务 T4 HH-5（`run_6782c926`：0 命中；provider 不在闭包）；deep P1-9 同结论 | 0 token；让「只被测试调用的死路径」可见 | `npm run test:coverage` + CI |
| **P1-9** | 对「单轮超窗」给出明确行为：要么在插件内实现有限度的 in-turn sealing，要么在超窗时抛一个指名错误的失败并同步修正 `src/index.ts:179` 的注释；不要留一个指向 `src/lab/`（不发布）的暗示 | `src/index.ts:179,74,48-51`；`src/lab/step-tape.ts`（build 排除）；`tsconfig.json:21-23` | 本任务静态复核（`run_bd7577ff`：`inTurnSeal` 只命中 lab + 注释）；deep P1-6 的表述按此修正 | 0 token；避免会话在超窗时无定义行为 | 新增超窗用例（断言抛错或成功降级，二选一） |
| **P1-10** | 去重教学文案：把条目首行的两条 affordance 从句收短（完整语法留在已缓存的 KERNEL/工具描述里）；合并前缀里 4–5 处重复的 `expand_result({"seq":…})` 规则 | `src/context.ts:390`（170 字符 header）、`:354`；`src/index.ts:53-61`（KERNEL 1,210 字符）；`src/fold/index.ts:68-78`（`FOLD_AFFORDANCE` 1,139；`foldAffordance(true)` 1,313） | 本任务实测字符数（`run_fa7ea448`、`run_412d9381`：KERNEL 1,210；header 170；工具定义 1,220+1,351+800+1,075+5 = 4,451）；T2-F2/F3（6,969 教学子集；T6 修正为 7,063 实网前缀含 persona/分隔符）；T3-W6/R5（260–400 字符/轮 ≈65–100 token/轮） | 每条新条目少写 ~260–400 字符（写入时一次性全价）；前缀去重属**前缀变更**，只在版本批次里做一次（见 §5） | `npx vitest run tests/tape-seal.spec.ts tests/fold-plugin.spec.ts`；对比条目字符数 |

### P2（卫生 / 文档 / 配置 / 长尾）

| ID | 动作 | 锚点 | 证据 | token/cache 效果 |
|---|---|---|---|---|
| **P2-1** | `viewChars`/`historyChars` 惰性化（getter 或 opt-in），保留字段（测试断言） | `src/context.ts:451-468,515`；`src/index.ts:180`；`tests/context-policy.spec.ts:93` | 本任务 T3-W1 复现（`run_412d9381`）+ T7 accept | 0 token；省 13K–1.28M 字符 stringify/轮（转述 T3 run 5） |
| **P2-2** | `chars()` 用 `for (const _ of s) n += 1` 保 code-point 语义、去掉 `Array.from` | `src/context.ts:76-78` | 本任务 T7（`run_412d9381`：实现与语义方向复核；emoji 例子修正为 6/5） | 0 token；CPU 微优化 |
| **P2-3** | cut warning 每 session 每 key 只发一次（`WeakMap<Session, Set<string>>`）；**不要**去封存未配对轮 | `src/context.ts:476,514`；T5 硬修正 | 本任务锚点复核 + T5-rebuild 修正 | 0 token；日志噪音 |
| **P2-4** | `requestChars` 删除或加 `@internal`；死模块处理按 T8 修正后的量化（**12/25 不可达、38,363 B = 213,763 B 的 17.9%**；`src/slice/internal/*` 与 `src/slice/tape.ts` **可达**，不要动） | `src/context.ts:542`；`package.json:24-29`；`src/slice/tape.ts:8-11` | 本任务 T4 HH-9 + **T8 refutation**（`evidence_9ef90339`）；T1-F8 | 0 token/turn；tarball 瘦身 |
| **P2-5** | `tests/mock-adapter.ts` 补 `errorResponse`/`multiToolCallResponse` 的驱动用例，或删除死 helper | `tests/mock-adapter.ts:15,32`；`tests/fold-plugin.spec.ts:21` | 本任务独立 grep（`run_d0059065`：两 helper 零使用；9 处构造只走 toolCall/text） | 0 token；测试可信度 |
| **P2-6** | `observations/files.ts` 支持 `content[*]` 与 `message.source.callId`；对无 `surfaceOp` 的 `tool/result` 不要静默丢弃（至少 warn/记账） | `src/observations/files.ts:97,99-100` | 本任务静态复核（`run_bd7577ff`） | 0 token 直接；丢证据会导致重复读取（间接全价） |
| **P2-7** | `FOLD_BODY` 的「every structured line」承诺与 `digestData` 的键新颖性+块上限对齐（改承诺或改实现） | `src/fold/index.ts:68`；`src/slice/result-digest.ts:31-33,191-207` | 本任务静态复核（`run_bd7577ff`）；幅度转述 T2-F4（900 行只留 17 行） | 视图更小是收益；承诺不符会让模型重复读取（全价） |
| **P2-8** | 字节预算按事实重述：`results/` 57.43/58.90 MiB（97.5%）；打包载荷 ≈14.9 MiB，不是 58.9 MiB；决定「搬 archive 出去」或「提高上限」 | `scripts/check-repo-size.mjs:5-9,25,46-55`；`ci.yml:40-43` | 本任务 T4 HH-8 + 现跑 `node scripts/check-repo-size.mjs`（`run_d0059065`：58.90 MiB / 982 files，results 57.43） | 0 token；容量判断 |
| **P2-9** | `tests/result-digest-longline.spec.ts:7` 换固定种子 PRNG | 同锚点 | 本任务 T4 HH-10 | 0 token；可复现性 |
| **P2-10** | `engines` 下界进矩阵：`ci.yml:21` → `['22.19.0','22.22.3','24.x']`；compat 加 24.x | `package.json:97-99`；`ci.yml:20-21`；`compat.yml:31` | 本任务 T4 HH-6 | 0 token |
| **P2-11** | `plan/SEAMS.md:12-14` 横幅里那句「现役是压力归档」改成 `planSeal/applySeal/sealCompletedTurns`；`plan/MAP.md`/`SOURCING.md` 的历史横幅保留 | `plan/SEAMS.md:12-14` | 本任务 T4 HH-11 | 0 token |
| **P2-12** | `minimumReleaseAge*` 策略二选一：启用 `minimumReleaseAge` 或注明「inert unless global」 | `pnpm-workspace.yaml:5` | 本任务 grep（`run_d0059065`：有 `minimumReleaseAgeExclude`，无 `minimumReleaseAge`） | 0 token |
| **P2-13** | deep review P2-6/P2-9/P2-11/P2-12/P2-13/P2-14 的文档与链接类修复（`link:dsh` PEERS 缺包、lib 同步靠人工、master 兼容手工、triage 标签/13 处死链、`recorded-memory.md` 首段、`experiment-plan` 横幅） | 见 deep review `:95-103` | **转述** deep review（本轮未逐条重跑） | 0 token |

## 3. 「可能浪费 token 的行为」（专门章节）

按「哪些字节、在哪个事件/每轮重付多少」排序；**已扣除** deep review P1-7、T1-F5 这类「有意设计」的可见成本（它们只在 §5 说明为何不能简单删）。

1. **每次默认 `recall_turn` 把折叠内容整段买回**（P1-1）：`src/recall.ts:200` 默认 `view:'full'`。一次默认取回 +58.3K 字符（≈14.6K token）全价；dialogue 460 字符（转述 T2-F1/T6）。
2. **教学文案重复**（P1-10）：前缀 7,063 字符（含 host persona/分隔符；教学子集 6,969）每个请求都发；每条新条目再写 170 字符定位手册 → 可省 260–400 字符/轮 ≈65–100 token/轮（T3-R5，转述 T3 字节测量 + 本任务字符数复核）。
3. **`entryMaxChars` 无上限**（P0-4）：最坏一条 59,577 字符（≈15K token）在写入时全价一次，之后每轮驻留（cache 价）并挤压窗口（deep E3b 转述 + 本任务 `:431` 复核）。
4. **无轮归属 user 消息的封存+不可取回**（P0-3）：正确性问题；若模型为找回该内容重读文件，代价是整轮新后缀（实测后缀 480–797 字符/步，转述 T1/T3）。
5. **永不 seal 的节点**（P1-6）：外部插件 appends / 图片 user 消息每轮都在请求里（稳定 = cache 价，但窗口占用与增长成本真实）；修复要落在生产者而不是放宽谓词（T5 修正）。
6. **未配对 tool 调用把整轮永久钉住**（§5 有意设计）：不要为省字节去封存半对 call/result；只去重 warning（P2-3）。
7. **CPU-only，不产生 token 的行为**（不要混入 token 账）：`viewChars/historyChars` 每轮 stringify（13K 字符/空轮、20.7K/封存轮、最坏 1.28M）、每 seal 两次全日志扫描 + 历史 read 重算 sha256（T5：0.05/6.76/10.85/21.47 ms @ 0/50/100/200 reads）、`chars()` 每个 code point 生成一个字符串（T3-W1/W2/W3 转述 + T7 复核）。**口径警告**：这些是 CPU/延迟，T3 明确标注 0 re-billed tokens，roadmap 不应把它们算成 token 节省。

## 4. 提高 cache hit 的具体方法（按风险×收益）

**保持不动（已验证是 cache-safe 的设计）**：seal 只在下一轮第一步（`src/index.ts:180`）、原位 replace（`src/context.ts:523-527`）、条目冻结不重渲染（`:471`）、工具在 load 时注册（`src/index.ts:144-148`，顺序由宿主排序且跨 boot 哈希一致）、`keepRecentTurns: 0` 默认（`src/index.ts:36`；方向性结论 T1-F3/T5/T3 一致，绝对值随 fixture 变，不要引用单组数字）。

**可做的（都不触碰已计费字节）**：
1. **R-1 文案瘦身**（P1-10）：只改「未来写入的条目」与 KERNEL/工具描述版本——后者是**前缀变更**，必须与其他前缀变更合并成一次版本批次，并接受「每个活跃会话下次请求重付一次完整 view（实测前缀 7,063 字符 → 整 view ≥10.6K 字符 ≈2.6K token/会话/次编辑）」（T3 §3.3 转述）。
2. **R-2 工具结果折叠的边界**：fold 只改 open turn 的 surface（`src/fold/index.ts:138-167,486-497`），保持「log-only + open-turn-only」；任何试图 mid-turn 遮蔽 dead snapshot 的方案（T3-R8）都会把 divergence 移到已计费节点 → **不实现**。
3. **R-3 runtime 快照策略**：保持「只保护最新快照、旧快照在 seal 时折成一行 note」（`src/context.ts:205-211,221-224,361-369`）；快照每轮变化时 ~3,094 字符/轮（≈800 token/轮）是宿主新信息，不是插件可省的（转述 T3-W5/T1-F5）。
4. **R-4 条目 append 位置**：stay-at-own-position（P0 结论外的既有实现）——任何「把条目挪到尾部/重新嵌套」的改动都会把断点前移。
5. **R-5 版本化前缀**：把 KERNEL + `foldAffordance` + 4 个工具描述当成一个 versioned artifact，成批修改；单条工具描述改动同样重付整 view。
6. **R-6 取回教学**：默认 dialogue（P1-1）本身就是 cache 收益——它减少新增字节而不是改写已有前缀。

## 5. 有意设计、不要改（综合四份审计 + 三份 verification 的 do-not-change）

1. seal 只在 `step === 1`、原位 replace、条目永不重渲染/嵌套（`src/index.ts:180`；`src/context.ts:471,523-527`）。
2. 无请求预算、无插件侧上限、无拒绝（`src/index.ts:46-52`；退役键 `maxRequestChars`/`maxHistoryChars` 不要复活）。
3. 未配对 tool 调用：保留整轮原文并 warn；**永不**为了减小视图去封存半对 call/result（`src/context.ts:121-136,487-503`；T5 硬修正）。
4. 只保护最新 runtime 快照；旧快照可归档、在 seal 时折成 note（`src/context.ts:157-168,205-211`）。
5. read 指针 / read index / 6 条工具行与 10 条 read 的 caps 是为了阻止重读（`src/context.ts:68-72,330-339,368-387`）——只删教学语法，不删指针本身。
6. fold 保持 log-only + open-turn-only（`src/fold/index.ts:7-11,138-167`）。
7. 所有工具在 load 时注册，顺序交给宿主（`src/index.ts:144-148`；`src/fold/index.ts:435`）——惰性注册会改 `tools` 数组、重付前缀。
8. `declaredEfforts` 每请求重读（`src/index.ts:150-166`）以避免注入模型未声明的能力；warning 已按 route 去重。
9. `[slice checkpoint v1 …]` / `# SESSION TAPE` 旧记录按普通 sealed entry 兼容解析（`src/context.ts:32`；`README.md:83`）——`CHECKPOINT_PREFIX` 常量**不要**当死代码删（可只去掉 `export`）。
10. `src/lab/**` 不参与构建、不发布、但仍被 typecheck（`tsconfig.json:21-23`；`package.json:26-27`；实测 build program 0 个 lab 文件、test program 7 个）。
11. `examples/host-deepseek.ts:11-13` 的变量 specifier 动态 import（宿主专属包不进依赖闭包）不要「修」成静态 import。
12. `results/` 作为已提交证据档案 + 64 MiB 预算门（只修正注释/信息行，不动阈值）。
13. T5-rebuild 硬修正：不要采纳 T1-F7 的「把 `tool_output` 加进默认 kinds」修复，也不要再复述「默认 `recall_search` 找不到 tool output」——默认 scope 解析为 `auto`（`src/recall.ts:581`，schema `"auto" (default)` `:556-560`），默认调用能返回 `tool_output` 命中。
14. T8 硬修正：`src/slice/internal/{difflib,errors,pytext,safety}.ts` 经 `src/slice/tape.ts:8-11` 可达，**不要**列为删除/迁移对象；T4 HH-9 的正确量化是 12/25 不可达、38,363 B（17.9%）。

## 6. 建议的处理顺序与验收门禁

**顺序**：① P0-1（门禁）→ ② P1-2/P1-3/P1-4（其余门禁洞，可与 ①同一批）→ ③ P0-2（文档）→ ④ P0-3/P0-4（正确性）→ ⑤ P1-1、P1-10（token 大头）→ ⑥ P1-5（CPU）→ ⑦ P1-6/P1-7/P1-8/P1-9 → ⑧ P2 卫生批次。理由：门禁修好前任何修复都无法被自动验证；文档修好前后续 PR 有继续被带偏的风险。

**统一验收门禁**（每条修复都必须过）：
- `npm run typecheck`（含新的 `.mjs` program）、`npm test`（当前基线 27 files / 219 tests，本任务实测）、`npm run build`；
- `test -z "$(git status --porcelain --untracked-files=all -- lib)"`；
- `npm run verify:packed`（P0-1 后应可运行；否则修复无效）；
- `node scripts/check-repo-size.mjs`；
- 新增：`node scripts/check-doc-anchors.mjs`、`npm run test:coverage`（阈值起步）、`node scripts/check-peer-range.mjs`、超窗用例、空派生消息用例、长路径 × 10 reads 用例、`packed-fixture-config.spec.ts`。

## 7. 本任务证据 run id（T9 attempt `attempt_f4cc74b9-3d6d-478b-a47d-5cb0d6dec2fd`）

| 用途 | run id |
|---|---|
| 定位四份审计 artifact commit | `run_af1ea8f5`、`run_c39ccd7e` |
| 四份报告与 deep review 结构 | `run_d3c672b5`、`run_af38c7f7` |
| P0-2 maxChars / P0-1 own 谓词 / P1-5 无痕迹 / P1-4 pre-step+sha256 / P1-3 peers-devDeps | `run_5dbe434c` |
| P0-1 ownerOf / T2-F1 默认 full / P1-6 inTurnSeal / P1-8 mock helper / T2-F5/F6 / T2-F4 | `run_bd7577ff` |
| ownerOf null 路径 / P1-8 helper 零使用 / T1-F5 图片消息 / size gate 58.90 MiB / keepRecentTurns 0 / minimumReleaseAge inert | `run_d0059065` |
| T4/T7 自有证据（本 mission 早前 attempt，已 accept） | HH-1 `run_4861d1f5`；HH-2 `run_cd5afb5f`；HH-3/4 `run_fd0c83f3`；T7 综合重放 `run_412d9381` |
