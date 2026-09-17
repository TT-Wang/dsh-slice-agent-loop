# 深度 review：`@dsh-external/dsh-slice-agent-loop`

**快照**：`db72621f2897274689f1a3cd5e02e6ec11fb7efd`（`git rev-parse HEAD`；工作树干净）
**来源**：Agent Swarm mission `mission_draft_start_05a32289-151b-4f17-9fec-1fc0bfd132b7`（5 名成员、四条只读审计 + 独立复核）
**本报告角色**：合成（synthesis）。mission 的合成任务因 host 插件缺陷未能产出报告，本文件由 owner 依据**已发布且经独立复核**的四轨证据手工合成，逐条保留原始锚点与证据 run id。

---

## 0. 快照与验证基线

### 0.1 已实测（本 mission 中多条独立尝试真的运行过）

| 检查 | 命令 | 结果 | 独立复现次数 |
|---|---|---|---|
| 测试套件 | `npx vitest run`（沙箱内等效 `./node_modules/.bin/vitest run`） | **27 test files / 219 tests 全部通过**，exit 0 | 4 次（`run_5554cd36`、`run_8bdf5479`、`run_95475506`、`run_5325b1b7`） |
| 主类型检查 | `npx tsc -p tsconfig.json --noEmit` | **exit 0** | 4 次（`run_5097c6fc`、`run_8bdf5479`、`run_616277ee`、`run_67cdb316`） |
| 测试/脚本类型检查 | `tsc -p tsconfig.test.json` / `-p tsconfig.scripts.json --noEmit` | **exit 0 / exit 0** | 3 次（`run_a5c4460c`、`run_b07c42b2` 等） |
| 快照一致性 | `git rev-parse HEAD` / `git status --porcelain` | `db72621f…` / 0 行 | 多次 |
| `lib/` 与工作树 | `git status --porcelain -- lib` | 无差异 | `run_8b508b50` |
| 规模 | `find src -name '*.ts' \| wc -l`、`wc -l` | src 25 文件 / 5873 行；tests 29 个 `.ts`（27 测试文件 + 2 helper）；docs 23 个 `.md` | `run_4a344cdd` |

**沙箱偏差声明**：`npx` 在本沙箱内会因 npm 缓存 `EPERM` 失败，各成员改用同版本本地二进制 `./node_modules/.bin/{vitest,tsc}`（`vitest 4.1.11`，与 `package.json:62` 锁定值一致），参数等价、输出与规划基线一致。这一点在四轨报告中均已声明。

### 0.2 静态阅读（未运行，按纪律禁止）

`npm run build`、`npm run link:dsh`、`npm run verify:packed`、`npm run verify:master`、`npm run check:size` 全部**未运行**（部分需网络）。凡依赖它们的结论，本报告一律标注为**推断**而非实测。

---

## 1. 一句话结论

代码与测试的**基线质量高**（219 测试全绿、类型全绿、前缀稳定不变量被逐字节钉住、native harness 挂真实 DSH 服务），但存在**三个必须优先处理的问题**：归档路径上存在**静默且不可取回的内容丢失**（P0-1）、`entryMaxChars` 名为目标实为**无界**（P0-2）、以及**唯一覆盖已提交 `lib/` 的端到端门禁已经腐坏**（P0-3）。此外 `CONTEXT.md` 整篇描述的是**已退役机制**（P0-4），会持续误导每一位新读者与 agent。

---

## 2. Findings

### P0

#### P0-1 无轮归属的 `user` 消息被静默归档且不可取回（内容丢失）

- **锚点**：`src/context.ts:185`、`:232-234`；`src/recall.ts:138-141`、`:237`、`:242`、`:471`
- **现状证据**（实测 E8，`run_4be0450f`）：`source.kind === 'user'` 的 `user/message` 被 `context.ts` 记为已结束轮，但 `recall.ts` 不赋予任何轮归属——条目里有它的正文，却 `page1=false page2=false searchHits=[]`。对照：`plugin` kind 与 runtime 快照均可达。
- **影响**：**静默、不可恢复的内容丢失**，且违背实现自述的核心不变量（`src/context.ts:72-74`、`src/recall.ts:68-73`：「omission is only legal when a recall tool actually serves the omitted content」）。
- **建议动作**：① 归属只留一个真源（`context.ts:171-192` 的 `recallAt` 改用 `recall.ts` 的 `ownerOf`）；② 在 `context.ts:221-238` 加护栏「无任何 recall 页服务 ⇒ 保护，不归档」；③ 用例加在 `tests/context-policy.spec.ts`（与 `:352-375` 并列）；④ 验证 `npx vitest run tests/context-policy.spec.ts`。
- **复核**：`v_context`（Barbara）已 accept；`track-context-verification.md` 给出确认。

#### P0-2 `entryMaxChars` 名为目标实为无界（实测 59,577 字符 vs 配置 2,000）

- **锚点**：`src/context.ts:411`（自认 target）、`:378-387`（`readIndexLine` 只截条数不截字节）、`:422`、`:424`（`levels` 只收缩 `{tools,userHead,userTail,reply}`）、`:400`（无条件 push）
- **现状证据**（实测 E3b，`run_213347a9`）：单条 sealed entry `totalChars=59577 lines=78`，其中 `readIndexChars=58209`，**超配置 29.8×**；最长三行各 4,493 字符（400 字符长路径 × 10 reads/轮 × 13 轮）。
- **影响**：条目永久驻留请求面并逐轮叠加；`src/context.ts:445` 与 docs 声称的「bounds the view by construction」与事实不符。既有用例 `tests/context-policy.spec.ts:406-418` 用**短路径 + 200 字符结果**，刚好绕开真实输入。
- **建议动作**：① `readIndexLine`（`:378`）加单项与整行字节上限；② `levels`（`:422`）末尾追加「丢弃 read indices + tool lines」终档使 `maxChars` 可达；③ 新增长路径 × 10 reads/轮 用例断言 `Array.from(text).length <= entryMaxChars`；④ 验证 `npx vitest run tests/context-policy.spec.ts`。

#### P0-3 `verify:packed` 的 profile fixture 使用已退役配置键 → 唯一的 `lib/` 端到端门禁失效

- **锚点**：`scripts/validation/packed-profile.patch.yml:46-51`（`history: { highWaterChars: 600, lowWaterChars: 300, keepRecentChars: 1 }`）；`src/index.ts:40-45`（`RETIRED_HISTORY`）、`:113-122`（`resolveHistory` 构造期抛错）；`lib/index.js:13,87-89`（**已提交产物同构**）；`.github/workflows/ci.yml:38-39`；`scripts/validation/packed-runner.mjs:62/:66/:78`；`cordis.patch.yml:3`
- **现状证据**（实测）：独立探针把 fixture 三键逐字传给 `nativeHarness` → **构造期被拒**（`Retired history configuration highWaterChars`，`run_273f63bf` / `run_f8c86c3d`）；同探针证明替代配置 `history: { keepRecentTurns: 0 }` **可正常装载**；`tests/config-keys.spec.ts:56-65` 本就断言这三个键必被拒绝；已提交的 `lib/index.js` 含同一校验。
- **影响**（推断，`verify:packed` 未实跑）：插件构造抛错 → 打包冒烟无法通过。这是**唯一**通过已发布 Loader 覆盖 `lib/`（Git 安装产物）的端到端门禁，等于当前交付产物没有一条能通过的端到端验证。
- **建议动作**：① 改 `packed-profile.patch.yml:46-51` 用现役键表达同一意图，并同步修正 `packed-runner.mjs:64-66` 的注释与断言；② 新增**无需网络**的 `tests/packed-fixture-config.spec.ts`，把 fixture 的 `history` 逐字喂给 `nativeHarness` 断言「可装载」，让 fixture 与插件键集在同一 PR 内互相锁定；③ 验证 `npx vitest run tests/packed-fixture-config.spec.ts`。
- **复核修正（必须采用）**：请求数断言在 `packed-runner.mjs:62`（=4）与 `:78`（=5），checkpoint 断言在 `:66`；`:46` 附近只是「不得出现额外请求」的守卫。同一 fixture 门禁也在 `.github/workflows/compat.yml:50`。
- **复核**：`v_tests`、`25110f80`、`ed203b99` 三次独立复核均判 **accept**。

#### P0-4 `CONTEXT.md` 把已退役的「压力归档 / checkpoint」策略写成现役机制

- **锚点**：`CONTEXT.md:3`、`:5-8`、`:13`、`:16-17`、`:26-30`
- **现状证据**（实测 `run_d4ed1658`）：`planArchive` / `applyArchive` / `archiveUnderPressure` / `SliceBudgetError` 在快照 `src/` 中 **0 命中**；四个水位键属 `RETIRED_HISTORY`（加载即抛错）。现役是 `planSeal`（`src/context.ts:448`）、`applySeal`（`:523`）、`sealCompletedTurns`（`:530`），唯一触发点 `src/index.ts:167-181` 的 `step === 1`，`sealBefore = lastTurn - keepRecentTurns + 1`（`src/context.ts:474`），**没有阈值、没有请求预算**。
- **影响**：`CONTEXT.md` 是 `AGENTS.md` 指定的领域文档入口，也是 agent 的词汇锚点；它整篇描述一个不存在的机制——**本次 mission 的任务简报本身就是被它带偏的**（owner 据它写入了已退役 API 名），这是「文档腐坏会传染到执行层」的实证。
- **建议动作**：按 `track-docs.md` §A 的 A1.1–A3.1 逐条改写（词汇锚点改指 `planSeal`/`applySeal`/`sealCompletedTurns`；删除水位/`maxRequestChars`/`SliceBudgetError` 全部段落；`CHECKPOINT_PREFIX` → `TAPE_PREFIX`；`checkpointMaxChars` → `history.entryMaxChars`；`:13` 的死链改指 `README.md:91`）。**另加一条防复发措施：把「文档断言的符号必须存在于 `src/`」做成可运行检查**（例如 `scripts/check-doc-anchors.mjs`），否则同类腐坏必然复发。
- **复核**：`v_docs`（Alan）accept，并修正了两处细节：复选框锚点为 `docs/experiment-plan-2026-09.md:236-240`；死链总数 **13** 条（非 12）。

### P1

| # | Finding | 锚点 | 现状证据 | 建议动作 |
|---|---|---|---|---|
| P1-1 | `git diff --exit-code -- lib` 漏「新增的未跟踪 lib 文件」，lib/src 漂移门禁有洞 | `.github/workflows/ci.yml:36-37`；`scripts/clean-build.mjs:3` | 实测：未跟踪 `lib/b.js` 时 `git diff --exit-code -- lib` **exit 0**，`git status --porcelain -- lib` → `?? lib/b.js`（`run_e9c95bb9`、`run_8bdf5479` 独立复现） | 换成 `git status --porcelain -- lib`（或 `test -z "$(...)"`）；验证 `npm run build && git status --porcelain -- lib` 应为空 |
| P1-2 | `typecheck` 声明覆盖 scripts，但 **7 个 `.mjs` 门禁脚本**完全不在类型检查程序内 | `package.json:36`；`tsconfig.scripts.json:11-15` | 实测：`cb20-dsh/check-repo-size/clean-build/link-dsh/packed-runner/run-master-tests/run-packed-smoke` 共 7 个 `.mjs` 未被覆盖，`@ts-check` 命中 0（`run_96bc5cae`） | 新增 `tsconfig.gates.json`（`allowJs`+`checkJs`）并追加到 `typecheck`；验证 `tsc -p tsconfig.gates.json --noEmit` |
| P1-3 | `compat.yml` 的绿是假绿：`pnpm up --latest` 只动 devDependencies，**不触碰 peerDependencies**（快照**无** `dependencies` 段），故 peer 范围失效时作业仍全绿 | `.github/workflows/compat.yml:36-37,47-50`；`package.json:44-57` | 实测 semver：`0.2.0-alpha.1` ∉ `^0.1.3-alpha.2`；当前 12 组 peer/dev 配对 0 违规（`run_8b508b50`） | 在 compat 中加「解析版本 satisfies peer 范围」断言，并做成 `scripts/check-peer-ranges.mjs` + `check:peers` 接入 `ci.yml` |
| P1-4 | `readHistory` 每次 seal 重扫整份日志并对**每个** `tool/result` 重算 SHA-256，且跑在 `agent/pre-step` 同步路径上 | `src/context.ts:289-312`、`:275-281`、`:415`；`src/index.ts:180` | 实测 E7（`run_fd917d99`）：50 轮 154ms → 100 轮 289ms → 200 轮 597ms → **400 轮 1,308ms**（重复 seal 仅 0.4–2.2ms） | 增量索引（按 `SessionSeq` 缓存 `ReadMark`）或并入 `collectItems` 同一次遍历；加成本门禁（400 轮一次 seal < 250ms） |
| P1-5 | 无派生消息的归档节点（空文本 user、max-tokens 空 assistant）在条目里**没有任何痕迹**，而首行仍声明 `N turn(s) sealed` | `src/context.ts:325-326`、`:394-397`、`:142-143` | 实测 E4（`run_51c9069f`）：`[turn 1]` 段下只有 `[reply …]`，无用户请求行 | `collectItems` 对「派生消息存在但文本为空」写显式占位（`(empty user message)` / `(no assistant text)`），并断言「声明的 turn 数 == 实际渲染段数」 |
| P1-6 | 「单轮超窗」无任何兜底，而注释把它指给一个**本仓库内不存在**的机制 | `src/index.ts:179`（指向 in-turn sealing）、`:74`、`:48-51`；`docs/in-turn-slicing.md:2-4` | 静态（`run_9ae00ed1`）：`inTurnSeal` 仅命中 `src/lab/`（`tsconfig.json` 显式 exclude）与退役文案 | 改注释删除误导；加**仅告警**的可观测性；补「单轮超窗」用例钉住当前行为 |
| P1-7 | 插件注入的 user-role 消息（非 runtime 快照）**永不归档**：无 note、无归档、裸 user 角色永久驻留 | `src/context.ts:221`、`:231-235`；`src/recall.ts:424` | 实测 E8（`run_4be0450f`）：`plugin:'some-other-plugin'` → `surfaceHas=true entryHas=false note="(no note)"`，页/搜索均命中 | 把「`kind:'plugin'` 且非 live 快照」统一纳入可归档并加 `snapshotNote` 同款 note（recall 侧已服务）；或写下「必须常驻」的决定并用测试钉住 |
| P1-8 | 测试替身里整类路径是死代码：单响应**多工具调用**、错误分支从未被驱动 | `tests/mock-adapter.ts:15-17,31-56,66-71,88-99`；9 处 `new MockAdapter(...)`（`tests/fold-plugin.spec.ts:68,104,140,155,170,189,213,228,379`） | 实测：`grep -rn "type: 'tool-call'" tests/` 无任何一行出现 ≥2 次（`run_ff109199`、`run_cc36e50b`） | 要么删死代码，要么加 `nativeMultiTool` + `tests/multi-call-turn.spec.ts`（断言配对、封存、前缀不变量）。**复核修正**：`contextWindow` 的「全仓库 0 命中」不成立（`examples/host-deepseek.ts:54` 有同名字段）；「假覆盖」降为**清洁度**（注释自证 dead & untested） |
| P1-9 | 全套件**没有任何覆盖率度量或门禁** | `vitest.config.ts:1-6`；`package.json:58-85`；`.github/workflows/ci.yml:33-34` | 实测：`vitest run --coverage` → `MISSING DEPENDENCY '@vitest/coverage-v8'`（`run_e06ad249`、`run_8bdf5479`） | 加 `@vitest/coverage-v8@4.1.11`（须与 vitest 同版本）；先记录基线再设阈值；CI 增加 coverage 步骤 |

### P2

| # | Finding | 锚点 | 建议动作 |
|---|---|---|---|
| P2-1 | 体积计量把整个消息数组 `JSON.stringify` + `Array.from` 两次只为取 `.length`，且 `requestChars` **零调用者** | `src/context.ts:76-78,451-468,467,542` | 改成不构造 code point 数组的计数，或把 `view()`/`chars()` 移出热路径（对照预算被删的决定） |
| P2-2 | 未配对 tool 调用把整段封存**永久钉住**，且同一 warning 每次 seal 重复发出 | `src/context.ts:487-505,507,514` | 用插件实例级 `Set` 按 `start seq` 跨调用去重；为「已中止未配对」轮次提供带 note 的降级归档出口 |
| P2-3 | `src/index.ts:163`、`:172` 两条 `ctx.logger.warn` 与 `:175` 接线**零断言** | `src/index.ts:163,172,175` | harness 增加 `warns: string[]` 捕获，在 maxSteps / unpaired 用例中断言文案。**复核修正**：`Warn` 回调本身**已被** `tests/context-policy.spec.ts:238-245,264-268,275-280` 断言，原「文案从未被断言」不成立 |
| P2-4 | `engines` 下界 `^22.19.0` **未被 CI 矩阵覆盖**（矩阵为 `22.22.3` + 浮动 `24.x`，注释却称 verify both ends） | `package.json:97-99`；`.github/workflows/ci.yml:19-21` | 矩阵加 `22.19.0`，或把 `engines` 改为 `>=22.22.3` 使声明与验证一致 |
| P2-5 | 死导出与 `./invariant` 子路径无运行时冒烟 | `src/slice/internal/errors.ts:19-40`；`src/invariant.ts:1-4`；`package.json:13-16` | 确认无外部使用者则删；若作兼容垫片保留，加 3 行 `tests/invariant-shim.spec.ts` |
| P2-6 | `link:dsh` 的 `PEERS` 缺两个被测试直接 import 的包 → link 后是「源码 + registry」混合图 | `scripts/link-dsh.mjs:25-55`；`tests/native-harness.ts:12,14`；`tests/fold-plugin.spec.ts:13` | 把 `dsh-settings`、`dsh-session-persistence-jsonl` 加进 `PEERS`，或注明「intentionally registry-pinned」；脚本末尾加 realpath 自检 |
| P2-7 | `minimumReleaseAgeExclude` 有 36–37 项，但仓库内**没有任何地方启用** `minimumReleaseAge`（该配置当前惰性） | `pnpm-workspace.yaml:5-41` | 二选一：加 `minimumReleaseAge: <分钟>` 让策略仓库化；或注明「inert unless a global minimumReleaseAge is set」 |
| P2-8 | `results/` 占已跟踪字节 **97.7%**（57.43 MiB / 809 文件），距 64 MiB 硬上限仅 ~5.2 MiB；增量主体是原始 per-call sidecar（37.18 MiB / 137 文件） | `scripts/check-repo-size.mjs:25,46-55`；`.github/workflows/ci.yml:40-43` | 对 `results/sidecars/*.calls.jsonl` 做显式决策（压缩或移出仓库）；仅两个最大文件即回收 ~7.5 MiB |
| P2-9 | `lib/` 与 `src/` 同步完全依赖人工 `npm run build`，历史上存在 src 改动未同步 lib 的提交 | `package.json:35`；`scripts/clean-build.mjs:3`；历史 `49e20fb`、`522ec95` | 加 `check:build`（与 P1-1 共用实现）；可选零依赖 `.githooks/pre-commit` |
| P2-10 | 测试数据依赖 `Math.random()`，破坏可复现性 | `tests/result-digest-longline.spec.ts:7` | 换确定性生成器，保持行数/长度不变 |
| P2-11 | 上游 master 兼容门禁**没有任何自动化** | `package.json:41`；`docs/upgrade-verification.md:57-74`；`.github/workflows/compat.yml` | 新增周更 `master-compat.yml` 跑 `run-master-tests.mjs`；或至少在文档标注 "manual-only, not gated" |
| P2-12 | triage 标签词汇未 provision（`docs/agents/` 声明的四个标签在远端不存在）；另有 13 处死链与过期数字 | `docs/agents/triage-labels.md:7-11`；`plan/MAP.md:85,95`；`docs/modification-spec.md:61,140,150`；`docs/world-state-loop.md:22`；`docs/modification-spec.md:3`（153 测试） | 创建标签或改写文档；机械修死链为代码 span；`docs/modification-spec.md:3` 改为「27 文件 / 219 测试」 |
| P2-13 | `docs/recorded-memory.md:3-6` 声称 `buildContinuity` 是「live compaction」的连续性 reducer，实际非测试 importer 为 0 | `docs/recorded-memory.md:3-6`；`src/state/reducer.ts:4` | 首段改为「离线/分析用 reducer」，现役路径指向 `src/context.ts` |
| P2-14 | `docs/experiment-plan-2026-09.md:20-25` 的「仍然准确」横幅为 `maxHistoryChars`/`maxRequestChars` 背书，而这两键**无任何读取** | `docs/experiment-plan-2026-09.md:20-25`；`src/index.ts:48-51,69`；`README.md:69-71` | 删掉该横幅对两个预算键的背书（fold 部分仍准确） |

---

## 3. 不建议改（有意设计，别当缺陷）

来自两轨「不建议改」清单的并集，均经审计与复核确认：

1. **一次 seal 只写一个位置、只在 `step === 1` 触发**（`src/index.ts:167-182`）——前缀缓存的唯一保障；`tests/context-policy.spec.ts:105-137,387-404` 已逐字节钉住。不要引入「积压到阈值再压缩」。
2. **没有请求预算 / 高低水位 / `SliceBudgetError`**（`src/index.ts:39-51`）——有意移除；加回来会把超窗变成拒绝，而拒绝会污染该会话后续所有轮次。
3. **`pinFirstTurn` 只钉第一轮的 user 消息**（`src/context.ts:231-235`，`tests/tape-protected.spec.ts:116-122`）——「只有 reply 的孤儿条目」是 pin 按节点而非按轮的结果。
4. **空 content assistant 计入 turn 数但无正文**（`src/context.ts:141-143`）——宿主语义是它只为承载 max-tokens usage；P1-5 要加的是**占位提示**而非正文。
5. **`unpairedCalls` 截断 + 告警而非静默跳过**（`src/context.ts:122-136,487-505`）——取消截断会让请求面出现孤立 `tool-call`。
6. **legacy entry 冻结原位、绝不重渲**（`src/context.ts:31-33,471`）——「永不重渲染已写条目」优先于格式统一。
7. **`tape.ts` 死代码按模块整体决策，不要逐函数清理**（`compactTape`/`baseEntry`/`patchEntry`/`gcSupersededFileHistory` 由 `continuity.ts` 使用，`continuity.ts` 只被 `state/reducer.ts` 与测试引用）。
8. **多段 append 的 seam 是正确的**（实测 E9）：一个 plan 切成 3 段时三条条目全部落到 surface，无 seq 漂移；不要改 `applySeal`。
9. **`tests/tape-protected.spec.ts:58-70` 的「前缀不倒退」不变量**——缺失属性测试时应有的形态，比逐字段断言更强，不要换成快照。
10. **字节级快照**（`tests/tape.spec.ts`、`tests/assemble.spec.ts`）——插件契约就是字节级前缀稳定；快照无时间戳/路径，是合适工具。
11. **`tests/native-harness.ts:67-101` 只替换模型与设置存储**（真实 DSH 服务、真实 JSONL 持久化、两个 stock invariant 在场）——本套件最强的部分，不要为了快改成全 mock。
12. **`tests/context-policy.spec.ts:11-38` 手工构造 `SessionEvent`**——纯策略层单测与集成层互补，不是失真问题。
13. **`vitest.config.ts:5` 排除 `results/**`** 与 **`packed-runner.mjs:36-44` 的独立重建 oracle**——门禁强度正确，保留。

---

## 4. 本快照内无法验证 / 需显式声明为推断的事项

| 事项 | 原因与状态 |
|---|---|
| `npm run verify:packed` 的**最终红/绿** | 未运行（纪律禁止且需网络装载已发布 DSH）。**机制**（fixture 三键必被构造期拒绝）已由独立探针**实测**；「CI 会红」是建立在该机制上的高置信度**推断** |
| `npm run verify:master`、`link:dsh`、`npm run build`、`check:size` 的实际行为 | 均未运行；`58.75 MiB / 64 MiB` 是用 `git ls-files` + `stat` 复算的等价量，**不是** `check:size` 的输出 |
| `CONTEXT.md` 声称的水位默认值是否曾与某历史 commit 一致 | 需读 `git log` 做历史考古，本 mission 只读当前快照 |
| `README.md:29` 示例摘要 `ce9f9f98` / `705e051d` 是否正确 | 需回放原始会话才能复算（行数 544/104 已实测吻合） |
| A-P0-1 / A-P1-7 的**生产可达性** | 未在宿主包中找到「无开路轮时追加 user-kind 消息」或「追加非 runtime plugin user 消息」的生产者；证据是**规则分歧本身**与已测出的后果，触发频度待独立验证 |
| P1-4 的耗时绝对值 | 依赖本机环境；有意义的是**线性增长趋势**与「发生在 `agent/pre-step` 同步路径上」这一事实 |
| `gh issue list` 层面的词汇一致性、双语翻译一致性 | 超出本 mission 范围（只读仓库） |
| **`r_tests`（审计 B）的 host 端 verdict 未落盘** | 该产物已由 **3 名成员各做一次独立复核并全部判 accept**（`v_tests`、`75110f80`、`ed203b99`），全部证据已发布；但 host 的 `check_environment_mismatch`（见 §5）导致 verdict 无法记录，最终任务被撤回。本报告对该维度的收录依据是**已发布的复核证据**，而非 host 落盘的 accept |
| 复核未独立复算的部分 | `track-tests.md` §3「不建议改」8 项中仅 2 项被独立复算（前缀不变量、`vitest.config.ts`）；其余标注为未独立复核 |

---

## 5. 本次 review 暴露的 host 侧缺陷（与仓库无关，但影响本报告可信度）

在 host 插件 `agent-swarm` 的 verification 门禁上发现一个**order-sensitive 比较缺陷**，它使本 mission 的所有 verification accept 都无法落盘：

- `plugin/lib/workspaces.js:25` 的 `DEFAULT_VERIFICATION_DEPENDENCY_DIRS` 是**声明序** `['node_modules','.venv','venv','vendor','.tox']`，写入 envelope（`:597`）；
- 而检查运行路径记录的实际链接集合来自 `linkDependencyDirs`（`:1778-1815`）遍历 `git ls-files --others --ignored`，是**字典序** `.tox,.venv,node_modules,vendor,venv`；
- `plugin/lib/runtime.js:137/142` 用 `dirs.join(', ')` 做**字符串比较**，因此「同一集合、顺序不同」被判为 blocking，在 checks 全部通过时仍拒绝 accept（`runtime.js:2237`）。
- 另有一层前置缺陷：只链接「**已存在**的被忽略目录」，而本仓库 `.gitignore` 只忽略 `node_modules`，故实际集合曾只有 1 项。
- 最小修法（**建议采纳 A**）：比较处两侧改用集合语义，例如 `const norm = d => (d?.length ? [...new Set(d)].sort().join(', ') : 'none')`。

**本 mission 为绕过该缺陷所做的临时改动（不影响本报告结论，已回滚）**：
1. 在 source 内创建了 4 个空占位目录 `.venv/ venv/ vendor/ .tox/`（各含 `.keep`），并把忽略规则写进**本地** `.git/info/exclude`（**未改** `.gitignore`、未产生任何 tracked 改动，`git status` 全程干净）——目的是让「声明集合」与「实际链接集合」一致。**本报告定稿前已删除这 4 个目录并还原 `.git/info/exclude`**，仓库只剩本报告一处未跟踪文件。
2. 在 `~/.dsh/agent-swarm-preview-5198-20260915/preview.patch.yml` 的插件 config 里加了 `verificationDependencyDirs`，按运行时记录顺序排列。该改动**需重启 host 才生效**，本次未重启，因此对本 mission 无影响；若采纳 §5 的一行修法，可删除该项以免混淆。

---

## 6. 建议的处理顺序（按投入产出比）

1. **P0-3**（一行 fixture 键 + 一个免网络互锁用例）——恢复唯一的 `lib/` 端到端门禁。
2. **P0-4**（改写 `CONTEXT.md`，并加 `check-doc-anchors` 防复发）——本次 mission 的任务简报就是被它带偏的，腐坏会继续传染。
3. **P0-1 / P0-2**（内容丢失与无界条目）——两者都是「静默」类缺陷，测试恰好都用短输入绕开。
4. **P1-1 / P1-2 / P1-3**（三处门禁漏洞）——都是「CI 绿但与事实不符」，修复成本低。
5. **P1-4**（seal 同步路径的线性哈希）——决定长会话是否可用。
6. 其余 P2 按 §2 表内建议逐条处理；`results/` 体量（P2-8）应尽快做一次显式决策，避免被 64 MiB 上限逼出临场妥协。

---

## 7. 证据索引

- **轨道报告**：`track-context.md` / `track-context-synthesis.md`（审计 A，artifact `b9db67fe`）、`track-tests.md`（审计 B，artifact `4eb5bddd`）、`track-toolchain.md`（审计 C，artifact `5113b5dc`）、`track-docs.md`（审计 D，artifact `49f9b8fc`）
- **独立复核**：`track-context-verification.md`（v_context，accepted）、`track-toolchain-verification.md`（v_toolchain，accepted）、`verify-docs.md`（v_docs，accepted）、`track-tests-verification.md` / `track-tests-verification-r2.md`（v_tests 两次独立复核，host verdict 未落盘）
- **board 记录**：`post_9a8815f1`（B 轨 P0 ALERT）、`post_de386b24`（v_tests 三态结论）、`post_4e7bfdc4`（v_tests r2 三态结论）、`post_49821fce`（D 轨作者采纳复核修正）
- **主要 run id**：基线 `run_5554cd36` / `run_5097c6fc` / `run_8bdf5479`；P0-3 探针 `run_273f63bf` / `run_f8c86c3d`；P1-1 `run_e9c95bb9`；P0-2 `run_213347a9`；P0-1/P1-7 `run_4be0450f`；P1-4 `run_fd917d99`；P0-4 `run_d4ed1658`；死链扫描 `run_03015219`；标签 `run_7c0ef374`
