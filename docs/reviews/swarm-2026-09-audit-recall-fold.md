# T2 审计：recall / fold / observations 的重取可达性与每轮实付 token

- **快照 commit**：`62db5ce2f94be74a6bdca2c1376d9e02112fe95f`（本报告的每一条 file:line 与命令都锚定该 snapshot；工作树 HEAD = 62db5ce，`git status --porcelain -- src tests scripts docs package.json tsconfig.json vitest.config.ts` 在写报告前为空）
- **任务**：`task_draft_start_6dc29acf-0a7a-41fc-b229-ee6f1cd9bf19_T2_audit_recall_fold`（attempt `attempt_a8825208-f368-4517-acbb-d064bb32a1f9`）
- **范围**：`src/recall.ts`、`src/recall-step.ts`、`src/fold/`、`src/observations/` 及其测试；为核对 locator 契约与教学点，另读了 `src/index.ts`（KERNEL）、`src/context.ts`（封存/检查点）、`src/slice/result-digest.ts`（头尾策略）与依赖 `@deepseek-ai/dsh-agent-loop` 的落盘代码。
- **零源码改动**：本任务只新增本报告；所有测量都是在内存合成 log 上调用纯函数，或只读命令。

测量标注约定：**MEASURED** = 本任务在当前快照上跑过的只读命令（附 run id 与逐字输出）；**INFERRED** = 只由代码阅读/依赖阅读得出，没有在本快照上端到端驱动。

---

## 0. 结论摘要

| # | 严重度 | 结论 | 类型 | 每请求/每轮字符影响 |
|---|---|---|---|---|
| F1 | **High（token）** | `recall_turn` 默认 `view:"full"` 会把整个 turn 的原始记录（含已折叠的工具输出全文）逐字回灌，且 recall 家族的输出被明确排除在 digest 之外 → 一次默认取回可注入 58,755 字符（≈14.7K token），而 dialogue 视图只要 460 字符 | MEASURED | 单次取回 +58,295 chars |
| F2 | **Medium（token）** | recall/fold 教学点重复陈述：KERNEL + fold affordance + 4 个工具定义共 6,969 字符是**每个请求都随前缀发送**，同一条 `expand_result({"seq":…})` / `recall_turn({...})` 规则分散在 4–5 个表面 | MEASURED | 前缀 6,969 chars；可删 ~1.5–2.5K |
| F3 | **Medium（token）** | 每个 `[slice tape v1 …]` 条目首行重复 170 字符定位手册（KERNEL 已说过同一条规则），每封存一轮就再落一份 | MEASURED | 每轮 +170 chars（未命中价），30 轮 ≈5.1K |
| F4 | **Medium（正确性风险）** | `FOLD_BODY` 承诺“data/document reads keep … **every** structured line”，实际 `digestData` 的“键新颖性 + 块上限”会丢结构行：900 行 `item: value_n` 只留 17 行；混合文档里 5 个 `Setting_5:` 只留 1 个 | MEASURED | 视图更小是对的，但模型可能因此不再 expand |
| F5 | Low（潜在正确性） | `observations/files.ts` 只读 `message.content[0]`，且只认 `block.toolCallId`；stock loop 今天一消息一块（已核），fold 却同时支持 `message.source.callId` → 其他生产者会静默丢文件证据 | MEASURED（抽取行为）+ INFERRED（影响面） | 无直接 token；丢证据会导致重复 read |
| F6 | Low（潜在） | 无 `surfaceOp` 标记的 `tool/result` 在 `files.ts:97` 被丢弃（`=== 'append'`）；stock loop 恒带标记，合成/第三方日志会丢 | MEASURED | 无 |

**反过来说也重要**：任务点名的两个“取不回”假说被实测**否定**——(1) turn 结束后的 plugin/runtime 快照，(2) 被取代（superseded）的快照 note，两者的 locator 都能真正取回（§3 C/D）。

---

## 1. 复现方法（全部只读）

1. 依赖：worktree 内 `node_modules` 用符号链接指向源 checkout 的 `node_modules`（只读依赖，不改动任何被跟踪文件）。
2. 单测（10 文件 73 例，全绿）：
   ```
   git status --porcelain -- src tests scripts docs package.json tsconfig.json vitest.config.ts   # 空
   node --version                                                                                  # v22.22.3
   # vitest 配置需写在 node_modules 之外（vite 的 .vite-temp 写入被 workspace-write 沙箱拒绝）：
   CFG=$(mktemp -d)/auditcfg && mkdir -p "$CFG" && printf "export default { root: '%s', cacheDir: '%s', test: { include: ['tests/**/*.spec.ts'], exclude: ['results/**','node_modules/**'] } }\n" "$PWD" "$CFG/vite-cache" > "$CFG/vitest.config.mjs"
   cd "$CFG" && "$OLDPWD/node_modules/.bin/vitest" run --config "$CFG/vitest.config.mjs" \
     tests/recall-views.spec.ts tests/fold-plugin.spec.ts tests/fold-resume.spec.ts tests/fold-reject-step.spec.ts \
     tests/read-digest.spec.ts tests/read-index.spec.ts tests/read-bases.spec.ts \
     tests/result-digest-headroom.spec.ts tests/result-digest-longline.spec.ts tests/native-context.spec.ts
   # → Test Files 10 passed (10) / Tests 73 passed (73)
   ```
   工具 run：`run_90657608-adb4-44f5-9fb8-25d01e96fde1`（10 files / 73 tests passed），`run_5af171d1-fea2-45c2-b102-af9954953f10`（`node --version` = v22.22.3、工作树 HEAD = 62db5ce）。
3. 探针：把**内联**脚本用 `TMPDIR=$(mktemp -d) ./node_modules/.bin/tsx <脚本>` 跑在合成内存 log 上（脚本全文见 §7；探针文件已删除，报告与工作树都不留 `.audit-*` 路径）。`TMPDIR` 只承载运行期临时目录，结论不依赖任何宿主临时状态；vitest 配置写在 `mktemp -d` 里、同一条命令内用完即弃。工作树快照本身没有 `node_modules`（§6 U4），本任务把源 checkout 的 `node_modules` 以符号链接挂进 worktree 只为解析依赖，未改动任何被跟踪文件。
   工具 run：`run_6e34cd6b-799f-4b57-8e4d-ca2d1f9dbc18`（probe1）、`run_a5880287-8738-4ee0-ae3b-9267c5468f21`（probe2）、`run_59f77c41-8978-42b3-984c-d23a5bab59f9`（probe3）。
4. **src 与 shipped artifact 交叉核对**：`lib/**` 是“`dsh plugin add github:…` 直接从 git 源安装”的产物（`.gitignore:3-4`），所以运行时行为以 `lib/**` 为准。本报告的每条运行时断言都在 `lib/**` 里复核过同样语义：`lib/slice/result-digest.js:263`（recall 家族输出不折）、`lib/observations/files.js:101`（`content[0]`）、`lib/context.js:361`（条目首行定位手册）、`lib/fold/index.js:43`（`every structured line` 措辞）与 `lib/recall.js:241-257`（dialogue/full 视图渲染）。src 与 lib 同源且本次未产生 diff（`git status --porcelain` 只见新增报告）。
5. 缓存价口径：本仓库自己的口径是“严格前缀缓存下命中价是未命中的 1/30”（`src/slice/result-digest.ts:4-5`）。下文 token 一律按 `chars/4` 粗估并明确标出是 chars 还是 token。

---

## 2. Findings

### F1 — `recall_turn` 默认 `view:"full"` 把折叠掉的内容整段买回来（High，token）

- **锚点**：`src/recall.ts:633`（`const view: RecallView = a?.view === 'dialogue' ? 'dialogue' : 'full'`）、`src/recall.ts:200`（`opts?.view ?? 'full'`）、`src/recall.ts:596-606`（工具描述把 full 写成默认）、`src/recall.ts:299-301`（full 追加 `## Original records` 全部 JSON）、`src/slice/result-digest.ts:281`（recall 家族输出 `return untouched(text, 'search')`，永不折叠）、`src/slice/result-digest.ts:274-277`（`digestText` 只走 data 规则，与 recall 无关）。
- **MEASURED**：`run_59f77c41-8978-42b3-984c-d23a5bab59f9`（内联 tsx 探针 3，见 §7）

  ```
  [H1] tool result chars 56489
  [H1] recall_turn full-view page chars 58755
  [H1] recall_turn dialogue page chars 460
  [H1] default view == full: true
  [H2] recall_turn output re-digested? false kind search
  [H2] recall_step output re-digested? false
  [H2] raw bash result digested? true 671
  [H2] expand_result output re-digested? false
  ```
- **影响**：一个 step 里 56,489 字符的 bash 结果在折进上下文时只剩 671 字符（正确做法）；模型一次 `recall_turn({"turn":1})`（省掉 `view`）就把它 58,755 字符整段拿回来，而且因为 `result-digest.ts:281` 明确跳过 recall 家族输出，这 58,755 字符**不会被再折叠**：它作为新字节落在上下文尾部（未命中价一次），此后每个请求都随前缀被重读（命中价）。粗估一次 ≈14.7K token 未命中 + 后续每请求 ≈14.7K token 命中价（1/30 口径下每请求仍 ≈0.5K token 当量）。KERNEL（`src/index.ts:58`）教的却是 dialogue 视图，模型不写 `view` 是最省字的写法，恰好踩最贵的默认值。
- **最小修复**（二选一，都不改前缀机制）：(a) 把 `view` 默认改成 `dialogue`，`full` 必须显式传；(b) 保持默认但把 `## Original records` 这一段改为“逐条 locator + 只在 `full` 下按需展开”。注意 `tests/recall-views.spec.ts:106-116` 把 `full` 是默认值钉在测试里，改默认值要同步改该测试与 KERNEL 措辞（`view "full" (default)`）。
- **预期 token/cache 效果**：修复后单次取回从 ~58.8K chars 降到 ~0.5K chars（省 ≈58.3K chars ≈14.6K token/次）；不引入任何前缀改写（recall 输出只追加）。

### F2 — recall/fold 教学点在 6 个每请求表面上重复（Medium，token）

- **锚点**：`src/index.ts:53-61`（KERNEL，`slice:kernel`，order -1200）、`src/fold/index.ts:68`（`FOLD_BODY`）、`src/fold/index.ts:71`（`RECALL_STEP_CLAUSE`）、`src/fold/index.ts:74-78`（`foldAffordance`，`fold:affordance`，order -900）、`src/recall.ts:599-606`、`src/recall.ts:546-553`、`src/recall-step.ts:79-83`、`src/fold/index.ts:373-374`（四个工具定义）。
- **MEASURED**：`run_6e34cd6b-799f-4b57-8e4d-ca2d1f9dbc18`（内联 tsx 探针 1，见 §7）

  ```
  [A1] kernel chars 1210
  [A1] recall_turn  desc 677 json 1075
  [A1] recall_search desc 623 json 1351
  [A1] recall_step  desc 491 json 800
  [A1] expand_result desc 427 json 1220
  [A1] fold affordance(slice) chars 1313 base 1139 recall_step clause 174
  [A1] system sections total 2523 | recall-family tool defs total 4446 | GRAND TOTAL per request 6969
  [A2] surfaces naming recall_turn = kernel+recall_turn+recall_search+recall_step
  [A2] surfaces naming recall_search = kernel+recall_turn
  [A2] surfaces naming recall_step = fold_affordance
  [A2] surfaces naming expand_result = kernel+recall_turn+recall_search+recall_step+fold_affordance
  [A3] occurrences of "expand_result({\"seq\"" = kernel:1 recall_turn:1 recall_search:1 recall_step:0 expand_result:0 fold_affordance:1
  [A3] occurrences of "recall_turn({\"turn\"" = kernel:2 recall_turn:0 recall_search:0 recall_step:0 expand_result:0 fold_affordance:0
  [A3] occurrences of "durable" = recall_turn:1 recall_search:1 recall_step:1 expand_result:1 fold_affordance:3
  ```
- **影响**：每个请求都要发送 6,969 字符（≈1.7K token）的 recall/fold 教程；其中同一条“谁取什么”规则在 4–5 个表面各写一遍。它躺在稳定前缀里，所以不是每轮未命中，但 (i) 占用上下文窗口、(ii) 每次前缀变更后的首读价、(iii) 每次改措辞都要在 5 处同步（`tests/fold-plugin.spec.ts:129-138` 与 `tests/fold-reject-step.spec.ts:53-60` 已把措辞钉在行为上，说明这件事已经在造成维护成本）。
- **最小修复**：给“定位契约”指定唯一 owner——KERNEL 保留一行 `recall_turn / recall_search / recall_step / expand_result` 分工；`recall_turn`/`recall_search`/`recall_step` 描述只留本工具特有语义（view、kinds、scope、limit），删掉重复的“durable / one call away / historical record”套话；`foldAffordance` 只讲折叠视图的标记与 `expand_result` 的 grep/lines 省字技巧。保守估计可省 1,500–2,500 chars 前缀。
- **预期 token/cache 效果**：前缀少 ~1.5–2.5K chars（≈0.4–0.6K token）；对每个后续请求都是一次命中价重读的减少；一次性未命中价的节省量等于删除的字节数。**不动**任何运行时行为（描述文本不进 log）。

### F3 — 每个封存条目重写一遍 170 字符定位手册（Medium，token）

- **锚点**：`src/context.ts:390`（`renderItems` 首行模板：`[slice tape v1 · turns a-b · n turn(s) sealed · recall_turn({"turn":"<n>","view":"dialogue"}) returns a turn's dialogue; expand_result({"seq":<q>}) returns a tool result]`）、`src/context.ts:392`（`[earlier checkpoint …; recall_turn for details]`）、对照 `src/index.ts:58`（KERNEL 已完整陈述同一规则）。
- **MEASURED**：`run_6e34cd6b-799f-4b57-8e4d-ca2d1f9dbc18`（内联 tsx 探针 1，6 轮封成 1 条，见 §7）

  ```
  [B1] sealed entries 1 entry chars 794 header line chars 170
  [B1] header: [slice tape v1 · turns 1-6 · 6 turn(s) sealed · recall_turn({"turn":"<n>","view":"dialogue"}) returns a turn's dialogue; expand_result({"seq":<q>}) returns a tool result]
  [B2] plan appends 1 viewChars 985 historyChars 983
  ```
- **影响**：默认 `keepRecentTurns:0` 每轮封一条新条目；每条都把这 170 字符手册重写一次。封存本身按设计只花“它写的条目”（`src/context.ts:12-16`），所以每轮多付的正是这 ~170 chars 未命中价 + 此后命中价重读。
- **最小修复**：只让**第一条**（或 KERNEL 里）带完整定位句，后续条目首行缩成 `[slice tape v1 · turns a-b · n turn(s) sealed]`；历史条目永不重渲染，因此老前缀不受影响。
- **预期 token/cache 效果**：每轮 ~170 chars（≈43 token）未命中价 → 30 轮 ≈5.1K chars（≈1.3K token）；同时每个历史条目瘦身，命中价重读量随条目数线性下降。零前缀改写（只影响新写条目）。

### F4 — `FOLD_BODY` 的“every structured line”承诺与 `digestData` 实际行为不符（Medium，正确性风险）

- **锚点**：`src/fold/index.ts:68`（`FOLD_BODY`：`Data and document reads keep their first and last lines and every structured line (key = value, key: value, headings, section markers)`）、`src/slice/result-digest.ts:187-208`（head 10 / tail 4 + `structuredBlockMin` / `structuredBlockCap` / `novel` 键新颖性；`:203` 只有 markdown 表格行豁免）、`src/slice/result-digest.ts:60-70`（`minChars 6000`、`maxKeepRatio 0.55`）、`tests/result-digest-headroom.spec.ts:70-90`（表格/短列表的既有契约）。
- **MEASURED**：`run_a5880287-8738-4ee0-ae3b-9267c5468f21`（内联 tsx 探针 2，见 §7）

  ```
  [G1] repeated-structured doc 12599 -> 266 digested true keptLines 17 / 900
  [G1] distinct kept keys 7 kept structured lines 17
  [G1] last 200 chars: "…item: value_5\nitem: value_6\nitem: value_0…item: value_5\n…[+883 lines / 12362 chars]…\nitem: value_0\nitem: value_1\nitem: value_2\nitem: value_3"
  [G2] mixed doc 15419 -> 713 digested true keptLines 26 / 460
  [G2] Setting_5 occurrences kept: 1 of 5 in input 5
  ```
  对照（原始大结果被折是设计使然，且可达）：`run_59f77c41…` 里 56,489 chars bash → 671 chars，`…[+N lines / M chars]…` 标记与首行 `expand_result(…)` 都在。
- **影响**：view 里确实有 `…[+883 lines / 12362 chars]…` 这类精确标记，所以不是“静默丢失”；但工具描述/KERNEL 级的话术让模型相信“结构行都留着”（配置、字段清单、表格），于是**不会**去 expand——而重复键的结构行（`Setting_5: 5/17/29/41/53`）只留第一条。这是一个“文档-行为不一致”导致的错误答案风险，成本不高（视图 12.6K→266 chars 是好事），修的是话术而不是折叠力度。
- **最小修复**：把 `FOLD_BODY` 里 “every structured line” 改成与实现一致的措辞（例：`keeps the first and last lines and the first occurrence of each structured key; repeated-key blocks are condensed and marked …[+N lines]…`），并保留 `src/fold/index.ts:65-67` 的“阈值可配，所以只说很多命中不写死数字”的既有原则。若反过来想把行为改成“结构行全留”，必须同步 `src/slice/result-digest.ts:192-208` 并重新测 `tests/result-digest-headroom.spec.ts:70-90`。
- **预期 token/cache 效果**：话术修复净字符≈0（可能 +20 chars 前缀）；收益是减少“模型不问就答错 → 事后返工 expand/重读”的尾部费用。若改行为（不建议在本轮做），视图会变大，需按 `maxKeepRatio` 重新评估。

### F5 — `observations/files.ts` 只取 `content[0]` 且只认 `block.toolCallId`（Low，潜在正确性）

- **锚点**：`src/observations/files.ts:97-104`（`const block = asRecord(Array.isArray(content) ? content[0] : undefined)`；`typeof block.toolCallId === 'string' ? calls.get(block.toolCallId) : undefined`）、对照 `src/fold/index.ts:217`（`block.toolCallId ?? d.message.source?.callId`）、`src/recall.ts:110-116`（recall 真地遍历所有 tool-result block）、`src/lab/state-selectors.ts:8-11` 与 `src/state/reducer.ts:40`（观察事实的下游消费者）。
- **MEASURED**：`run_6e34cd6b-799f-4b57-8e4d-ca2d1f9dbc18`

  ```
  [E1] single-block result observations: 1 paths: a.ts
  [E2] two-block result observations: 1 paths: a.ts
  [E3] no-surfaceOp tool/result observations: 0
  ```
  落盘侧核对（读依赖 `node_modules/.pnpm/@deepseek-ai+dsh-agent-loop@0.1.3-alpha.2_*/lib/index.js:426-440`，MEASURED）：`appendToolResult` 每次调用只 `createToolResultMessage({ callId: block.id, content })`、一个 `tool/result` 事件里只有一个 `tool-result` block。所以 **stock loop 今天不会触发 E2**；`E2` 是“多块消息（并行工具调用被生产者合并）会丢观察”的潜在缺陷。
- **影响**：该模块是文件证据的唯一抽取点；丢一个观察会让状态台账以为“这个文件没读过”，下游就可能重复 read（正是 `src/context.ts:330-331` 记录的 c1 现象：S1 reread 43.5% vs N 23.0%）。今天无实际损失，但它是 fold 已防御、observations 未防御的不对称。
- **最小修复**：遍历 `content` 的所有 `tool-result` block，并对每个 block 解析 `toolCallId`，回退 `data.message.source?.callId`；`meta` 是每条消息一份，多块时只对第一块有效，需按 callId 匹配后再用。
- **预期 token/cache 效果**：无直接字符成本；避免的是一次（或多次）重复 read（一次 read 的结果随后被 fold，但仍要付未命中价）。

### F6 — 无 `surfaceOp` 标记的 `tool/result` 被 `files.ts` 丢弃（Low，潜在）

- **锚点**：`src/observations/files.ts:97`（`event.surfaceOp === 'append'`）、对照 `src/recall.ts:143-145`（`isOriginalEvent`：`surfaceOp === undefined || 'append'`）、依赖 `@deepseek-ai/dsh-session` `lib/types/surface.js:46-49`（`isAppendSurfaceEvent` = `isSurfaceEvent(event) && event.surfaceOp === 'append'`，且 `isSurfaceEvent` 要求 `surfaceOp !== undefined`）。
- **MEASURED / INFERRED**：`run_6e34cd6b…` 的 `[E3] no-surfaceOp tool/result observations: 0` 是实测；`stock loop` 恒写 `surfaceOp:"append"`（`dsh-agent-loop lib/index.js:433-440`）是读代码实测；因此现实影响面为 **INFERRED（仅合成日志/第三方生产者）**。
- **影响**：与 dsh 的 `isAppendSurfaceEvent` 语义一致，所以这是“严格”而非“错误”；但它与 `recall.ts` 的宽松口径（`undefined` 也算原文）不一致：同一份合成/外部日志里 recall 能取回、observations 认不出。
- **最小修复**：改用 `isAppendSurfaceEvent(event)`（或与 `recall.ts` 同一 `isOriginalEvent` 判据）以消除两套口径。
- **预期 token/cache 效果**：无。

---

## 3. 重取可达性矩阵（MEASURED，`run_6e34cd6b-799f-4b57-8e4d-ca2d1f9dbc18`）

合成 log 上直接调用 `renderSealedTurn` / `searchSessionEvents` / `sealCompletedTurns`；`…` 为逐字输出节选。

| 内容 | 是否被封存/遮蔽 | `recall_turn` | `recall_search` | `expand_result` / `recall_step` | 实测输出 |
|---|---|---|---|---|---|
| `user/message`（`source.kind==='user'`） | 是（`src/context.ts:231-235` own 判定） | 是（`## User request`） | 是（kind `user`） | — | `recall-views.spec.ts` 全绿；`[C1] contextMessages` 一致 |
| turn 内的 plugin runtime 快照 | 被取代的会封存为 note | 是（`## Generated context…`） | 是（kind `context`） | — | `[C1] recall_turn(2) serves SNAP_2: true` |
| **turn 结束后的 plugin 快照（无开放轮）** | 是（归属刚结束的轮） | **是** | **是** | — | `[C2] search SNAP_BETWEEN hit turns 2:context`；`[C2] recall_turn(2) serves SNAP_BETWEEN: true` |
| **第一条 `turn/start` 之前的快照（无轮可归属）** | **否**（`src/context.ts:167-168,223` 保护，永不封存） | 否 | 否 | — | `[D1] SNAP_0 still raw on surface after sealing everything else: true`；`serves SNAP_0: false`；`search … : 0` |
| 被取代快照的 note 定位行 | note 不进请求正文 | locator 可解析 | locator 可解析 | — | `[C1] note line: [slice note · 2 runtime-context snapshots superseded by a later one; not repeated here · verbatim: recall_turn({"turn":"2"})]` |
| 折叠过的 `tool/result` | 是（surface replace） | 是（full/dialogue） | 是（`tool_output`，带 `seq`） | `expand_result({"seq":N})` 经 `sourceEventSeqs` 回原文 | `recall-views.spec.ts:96-103`、`fold-resume.spec.ts:84-123` 全绿；`[H2] raw bash result digested? true 671` |
| `tool/code-dispatch`（嵌套 dispatch 的调用参数） | 不占 surface | 仅 full 视图的 `## Original records` JSON | **不索引** | **不可按 seq 取**（`fold/index.ts:307-311` 对非 `tool/result` 明确报错） | INFERRED：`recall.ts:219-222` 收录、`recall.ts:405-465` 无分支、`fold/index.ts:283-295` 只扫 `tool/result` |

结论：任务点名担心的三类“取不回”里，**只有“第一条 turn 之前的无轮归属快照”确实取不回**，而它被 `context.ts` 主动保护、永远留在请求视图里（`src/context.ts:167-168` 的注释就是这个理由），所以不构成“封存后丢失”。turn 归属的三种情形（轮内、轮后、被取代）实测**双向一致**（页面与搜索索引同一 `ownerOf`，`src/recall.ts:138-141,393-399`）。

---

## 4. 教学点每轮实付字符（MEASURED）

每个请求固定发送的 recall/fold 教学字节（`run_6e34cd6b…`）：

| 表面 | 字符 | 位置 |
|---|---|---|
| `slice:kernel` 系统段 | 1,210 | `src/index.ts:53-61,144` |
| `fold:affordance`（slice loop 挂载时） | 1,313（base 1,139 + `recall_step` 句 174） | `src/fold/index.ts:68-78,437-444` |
| `recall_turn` 工具定义（name+description+parameters） | 1,075 | `src/recall.ts:596-645` |
| `recall_search` 工具定义 | 1,351 | `src/recall.ts:543-588` |
| `recall_step` 工具定义 | 800 | `src/recall-step.ts:75-103` |
| `expand_result` 工具定义 | 1,220 | `src/fold/index.ts:371-416` |
| **合计（每个请求，稳定前缀）** | **6,969 chars ≈ 1.74K token** | — |
| 另：每个新封存条目首行的定位手册 | +170 chars/轮 | `src/context.ts:390` |

`expand_result({"seq"` 这一条定位句式出现在 5 个表面（KERNEL、recall_turn、recall_search、recall_step 的“更便宜”对照句之外还有 fold affordance），`recall_turn` 出现在 4 个；`durable` 四个工具描述各一次、affordance 里 3 次。

---

## 5. 有意设计、不要改（否则会把设计意图当缺陷改掉）

1. **折叠用 surface replace 而不是改日志**（`src/fold/index.ts:7-11,265-273`）：原文按 seq 留在日志，`expand_result` 逐字取回；请求前缀只追加。别把它改成“改写落盘内容”。
2. **`shownThrough` 恢复护栏**（`src/fold/index.ts:124-131,162`）：resume/晚挂时，已经发给过模型的追加态结果不折——“折了会让整段前缀改写、缓存全失”。这与 `tests/fold-resume.spec.ts:198-244` 是同一契约。
3. **折在 `next()` 之后、且只对 `enter` 的步做**（`src/fold/index.ts:486-497`，配 `tests/fold-reject-step.spec.ts:30-42`）：被拒绝的步不产生没人看的 surface 替换。
4. **`recall` 家族不进搜索语料、其输出永不折叠**（`src/recall.ts:53-55,445,457`；`src/slice/result-digest.ts:281`）：防自匹配、防“复述即证据”。F1 修的是**默认视图**，不是这条排除规则。
5. **第一条 turn 前的快照保持保护、不封存**（`src/context.ts:158-168,218-224`）：没有 recall 页服务它，省略就是不可恢复。
6. **`tool/result` 的 `sourceEventSeqs` 指向 `tool/call` 事件**（依赖 `dsh-agent-loop lib/index.js:433-440`）：`originalResultAt` 只在替换事件上顺链（`src/fold/index.ts:303-315`），别把 append 事件的 `sourceEventSeqs` 也当替换链走，否则会把原文解析到 tool/call。
7. **recall 工具的注册方式**（全局注册 + `exec.agent`，`src/recall.ts:590-594`）：单注册服务所有 agent，不得跨会话。
8. **`pinSteps=2` / `pinMaxChars=8000` / `backoffAfterExpansions=2` 的取值**（`src/fold/index.ts:47-58,429-434`）：每个都有实测依据（规则文档 3–3.7K 不能被折、s10 的 64 次取回），调整前必须重跑 `tests/fold-plugin.spec.ts:168-239` 与 `tests/fold-resume.spec.ts:157-196`。
9. **`maxKeepRatio=0.55` 与 `minChars=6000`**（`src/slice/result-digest.ts:60-70,169`）：折了不省就别折、小文档不折，二者共同保证 F4 的视图不会比原文更大。

---

## 6. 未决 / 明确 unresolved

- **U1（INFERRED）**：`src/fold/index.ts:460-484` 的 spill 臂只更新 `spilled` 计数，不写 `foldedAt`/`perTool`（`recordFold` 未调用）。常见路径下同一结果会在下一个 pre-step 被 `foldOne` 再折一次并补记，所以退避仍然工作；但“上一进程已发过、resume 后不再折”的 spill 结果不会被计入 expand 退避。未做端到端驱动，故只报为未决，不作为 finding。
- **U2（INFERRED）**：`recall_search` 不索引 `tool/code-dispatch`（§3 表最后一行）。嵌套 dispatch 的**结果文本**是否以 `tool/result` 形式落盘未在本快照上驱动过；若没有，则嵌套输出的唯一入口是 `recall_turn` 的 full 视图（与 F1 叠加时更贵）。
- **U3（环境，已确认为预期）**：本任务声明的 checks 里 `git status --porcelain -- … docs …` 会把**本次交付物本身**（`docs/reviews/swarm-2026-09-audit-recall-fold.md`）报成 untracked，因为 worker 不能写 git 元数据（不能 commit / 不能 `git add`）。这是**预期状态**：该 untracked 条目就是本报告，除此之外**没有任何被跟踪文件被修改**（实测输出仅 `?? docs/reviews/swarm-2026-09-audit-recall-fold.md`）。owner 已确认此口径并要求在报告中写明。
- **U4（环境）**：vitest 需要把配置写在 `node_modules` 之外（vite 在 `node_modules/.vite-temp` 的写入被 workspace-write 沙箱拒绝），§1 给了可复现命令；这不影响被测代码，只影响如何跑测试。

---

## 7. 附录：自包含探针（探针文件已删除，以下为逐字留档）

用 `./node_modules/.bin/tsx` 跑在 worktree 根（合成内存 log，只读）；把下面任一段存成临时 `.mts` 后 `TMPDIR=$(mktemp -d) ./node_modules/.bin/tsx <file>`，用完删除该临时文件。三段脚本分别对应 F1/F4/F2+F3+§3。

**探针 1（F2/F3/§3/§5 的字符与可达性测量，run `run_6e34cd6b-799f-4b57-8e4d-ca2d1f9dbc18`）**

```ts
const recall = await import('./src/recall.ts')
const stepMod = await import('./src/recall-step.ts')
const fold = await import('./src/fold/index.ts')
const ctx = await import('./src/context.ts')
const obs = await import('./src/observations/files.ts')
const rd = await import('./src/slice/result-digest.ts')
const llm = await import('@deepseek-ai/dsh-llm')
const { Session, SessionId } = await import('@deepseek-ai/dsh-session')
const fs = await import('node:fs')
const n = (s: string) => Array.from(s).length

// A. 每个请求的 recall/fold 教学字节
const src = fs.readFileSync('./src/index.ts', 'utf8')
const ks = src.indexOf('const KERNEL = `') + 'const KERNEL = `'.length
const kernel = src.slice(ks, src.indexOf('`', ks))
const td = recall.recallToolDefinition(), tsrch = recall.recallSearchToolDefinition()
const tstep = stepMod.recallStepToolDefinition(), te = fold.expandResultToolDefinition()
const aff = fold.foldAffordance(true), affNo = fold.foldAffordance(false)
const toolJson = (t: any) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters })
console.log('[A1] kernel chars', n(kernel))
console.log('[A1] recall_turn  desc', n(td.description), 'json', n(toolJson(td)))
console.log('[A1] recall_search desc', n(tsrch.description), 'json', n(toolJson(tsrch)))
console.log('[A1] recall_step  desc', n(tstep.description), 'json', n(toolJson(tstep)))
console.log('[A1] expand_result desc', n(te.description), 'json', n(toolJson(te)))
console.log('[A1] fold affordance(slice) chars', n(aff), 'base', n(affNo), 'recall_step clause', n(aff) - n(affNo))
const sysChars = n(kernel) + n(aff)
const toolChars = n(toolJson(td)) + n(toolJson(tsrch)) + n(toolJson(tstep)) + n(toolJson(te))
console.log('[A1] system sections total', sysChars, '| recall-family tool defs total', toolChars, '| GRAND TOTAL per request', sysChars + toolChars)
const surfaces: Record<string, string> = { kernel, recall_turn: td.description, recall_search: tsrch.description, recall_step: tstep.description, expand_result: te.description, fold_affordance: aff }
for (const id of ['recall_turn', 'recall_search', 'recall_step', 'expand_result']) {
  console.log('[A2] surfaces naming', id, '=', Object.entries(surfaces).filter(([, v]) => v.includes(id)).map(([k]) => k).join('+'))
}
for (const p of ['expand_result({"seq"', 'recall_turn({"turn"', 'durable', 'verbatim']) {
  console.log('[A3] occurrences of', JSON.stringify(p), '=', Object.entries(surfaces).map(([k, v]) => `${k}:${v.split(p).length - 1}`).join(' '))
}

// B. 封存条目首行的重复成本
const user = (s: any, text: string) => s.append('user/message', llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
const snap = (s: any, text: string) => s.append('user/message', llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: ctx.RUNTIME_CONTEXT_SOURCE } }), { surfaceOp: 'append' })
const assistant = (s: any, turn: number, step: number, content: unknown[]) => s.append('assistant/message', { turn, step, stream: [], message: llm.createMessage({ role: 'assistant', content, source: { kind: 'model', provider: 'mock', model: 'mock' } }) }, { surfaceOp: 'append' })
const endTurn = (s: any, turn: number) => s.append('turn/end', { turn, reason: { kind: 'completed' } })
const policy = { keepRecentTurns: 0, pinFirstTurn: false, pinUserChars: 1200, entryMaxChars: 8000 }
const s1 = Session.create(SessionId('audit-b-header'))
for (let t = 1; t <= 6; t += 1) { s1.append('turn/start', { turn: t }); user(s1, `QUESTION_${t}`); assistant(s1, t, 1, [{ type: 'text', text: `ANSWER_${t}` }]); endTurn(s1, t) }
const plan = ctx.sealCompletedTurns(s1, [], policy)
const entries = s1.deriveMessages().filter((m: any) => m.role === 'user' && m.source?.kind === 'plugin' && m.source?.plugin === ctx.HISTORY_SOURCE)
const entryText: string = entries.map((m: any) => m.content.map((b: any) => b.text ?? '').join('')).join('\n@@@\n')
console.log('[B1] sealed entries', entries.length, 'entry chars', n(entryText), 'header line chars', n(entryText.split('\n')[0]!))
console.log('[B1] header:', entryText.split('\n')[0])
console.log('[B2] plan appends', plan.appends.length, 'viewChars', plan.viewChars, 'historyChars', plan.historyChars)

// C. superseded 快照 note 的 locator 是否真能取回（轮内 + 轮后）
const s2 = Session.create(SessionId('audit-b-snapshot'))
s2.append('turn/start', { turn: 1 }); snap(s2, 'SNAP_1 first snapshot'); user(s2, 'ASK_1'); assistant(s2, 1, 1, [{ type: 'text', text: 'REPLY_1' }]); endTurn(s2, 1)
s2.append('turn/start', { turn: 2 }); snap(s2, 'SNAP_2 supersedes SNAP_1'); user(s2, 'ASK_2'); assistant(s2, 2, 1, [{ type: 'text', text: 'REPLY_2' }]); endTurn(s2, 2)
snap(s2, 'SNAP_BETWEEN appended after turn 2 ended')
s2.append('turn/start', { turn: 3 }); snap(s2, 'SNAP_3 supersedes all'); user(s2, 'ASK_3'); assistant(s2, 3, 1, [{ type: 'text', text: 'REPLY_3' }]); endTurn(s2, 3)
s2.append('turn/start', { turn: 4 }); user(s2, 'ASK_4'); assistant(s2, 4, 1, [{ type: 'text', text: 'REPLY_4' }]); endTurn(s2, 4)
ctx.sealCompletedTurns(s2, [], policy)
const s2events = s2.snapshotEvents() as any[]
for (const t of [2, 3] as const) {
  const page = recall.renderSealedTurn(s2events, t, { view: 'dialogue' })
  console.log(`[C1] recall_turn(${t}) serves SNAP_${t}:`, page !== null && page.rendered.includes(`SNAP_${t}`), '| contextMessages', page?.contextMessages)
}
console.log('[C2] search SNAP_BETWEEN hit turns', recall.searchSessionEvents(s2events, 'SNAP_BETWEEN').map((h: any) => `${h.turn}:${h.kind}`).join(',') || 'NONE')
console.log('[C2] recall_turn(2) serves SNAP_BETWEEN:', recall.renderSealedTurn(s2events, 2, { view: 'dialogue' })!.rendered.includes('SNAP_BETWEEN'))

// D. 第一条 turn 之前的快照：被保护，因此取不回
const s3 = Session.create(SessionId('audit-b-preturn'))
snap(s3, 'SNAP_0 projected before the first turn')
s3.append('turn/start', { turn: 1 }); user(s3, 'ASK_1'); assistant(s3, 1, 1, [{ type: 'text', text: 'REPLY_1' }]); endTurn(s3, 1)
s3.append('turn/start', { turn: 2 }); user(s3, 'ASK_2'); assistant(s3, 2, 1, [{ type: 'text', text: 'REPLY_2' }]); endTurn(s3, 2)
ctx.sealCompletedTurns(s3, [], policy)
const s3surface = s3.deriveMessages().flatMap((m: any) => m.content.map((b: any) => b.text ?? '')).join('\n')
console.log('[D1] SNAP_0 still raw on surface after sealing everything else:', s3surface.includes('SNAP_0'))
console.log('[D1] recall_turn(1) serves SNAP_0:', recall.renderSealedTurn(s3.snapshotEvents() as any[], 1)?.rendered.includes('SNAP_0') ?? false)
console.log('[D1] recall_search finds SNAP_0:', recall.searchSessionEvents(s3.snapshotEvents() as any[], 'SNAP_0').length)

// E. observations/files.ts 的多块 / 无标记行为
const O = (events: any[]) => obs.recordedFileObservations(events as any)
const call = (seq: number, id: string, path: string) => ({ type: 'tool/call', data: { turn: 1, callId: id, name: 'read', arguments: JSON.stringify({ path }) }, seq })
const res = (seq: number, blocks: any[]) => ({ type: 'tool/result', data: { turn: 1, meta: { path: blocks[0].path, offset: 1, totalLines: 1, lines: [{ number: 1, text: 'x' }] }, message: { content: blocks.map((b) => ({ type: 'tool-result', toolCallId: b.id, isError: false })) } }, surfaceOp: 'append', seq })
const base = (seq: number) => ({ type: 'turn/start', data: { turn: 1 }, seq })
console.log('[E1] single-block result observations:', O([base(0), call(1, 'c1', 'a.ts'), call(2, 'c2', 'b.ts'), res(3, [{ id: 'c1', path: 'a.ts' }])]).length)
console.log('[E2] two-block result observations:', O([base(0), call(1, 'c1', 'a.ts'), call(2, 'c2', 'b.ts'), res(3, [{ id: 'c1', path: 'a.ts' }, { id: 'c2', path: 'b.ts' }])]).length)
console.log('[E3] no-surfaceOp tool/result observations:', O([base(0), call(1, 'c1', 'a.ts'), { ...res(3, [{ id: 'c1', path: 'a.ts' }]), surfaceOp: undefined }]).length)

// F. digest 头尾与守卫
const body = Array.from({ length: 900 }, (_, i) => (i === 450 ? 'MIDDLE UNIQUE FACT: PORT=7443' : `noise line ${i} ${'x'.repeat(30)}`)).join('\n')
const dr = rd.digestData(body)
console.log('[F1] data doc', n(body), '->', n(dr.text), 'digested', dr.digested, 'keeps middle fact:', dr.text.includes('PORT=7443'), 'markers', (dr.text.match(/…\[\+\d+ lines \/ \d+ chars\]…/g) ?? []).length)
console.log('[F3] code read digested?', rd.digestToolResult('export function f() {\n  return 1\n}\n'.repeat(400), { tool: 'read', path: 'src/x.ts' }).digested)
console.log('[F4] small doc digested?', rd.digestData('a\n'.repeat(100)).digested)
```

**探针 2（F4 的结构行承诺，run `run_a5880287-8738-4ee0-ae3b-9267c5468f21`）**

```ts
const rd = await import('./src/slice/result-digest.ts')
const n = (s: string) => Array.from(s).length
const doc = Array.from({ length: 900 }, (_, i) => `item: value_${i % 7}`).join('\n')     // 12,599 chars > minChars 6000
const r = rd.digestData(doc)
console.log('[G1] repeated-structured doc', n(doc), '->', n(r.text), 'digested', r.digested, 'keptLines', r.keptLines, '/', r.totalLines)
const prose = Array.from({ length: 200 }, (_, i) => `prose sentence number ${i} with words`).join('\n')
const cfg = Array.from({ length: 60 }, (_, i) => `Setting_${i % 12}: ${i}`).join('\n')
const m = rd.digestData(`${prose}\n${cfg}\n${prose}`)
console.log('[G2] mixed doc', n(`${prose}\n${cfg}\n${prose}`), '->', n(m.text), 'digested', m.digested, 'Setting_5 kept', (m.text.match(/Setting_5:/g) ?? []).length, 'of 5')
```

**探针 3（F1 的视图大小与再折叠，run `run_59f77c41-8978-42b3-984c-d23a5bab59f9`）**

```ts
const recall = await import('./src/recall.ts')
const rd = await import('./src/slice/result-digest.ts')
const n = (s: string) => Array.from(s).length
const big = Array.from({ length: 1200 }, (_, i) => `output line ${i} ${'y'.repeat(30)}`).join('\n')
const events: any[] = []
let seq = 0
const push = (type: string, data: unknown) => { events.push({ type, data, seq, surfaceOp: 'append' }); seq += 1 }
push('turn/start', { turn: 1 })
push('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'run it' }] })
push('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"cmd":"x"}' }] } })
push('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"cmd":"x"}' })
push('tool/result', { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: big }] }] } })
push('assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'done' }] } })
push('turn/end', { turn: 1, reason: { kind: 'completed' } })
const full = recall.renderSealedTurn(events, 1, { view: 'full' })!
const dlg = recall.renderSealedTurn(events, 1, { view: 'dialogue' })!
console.log('[H1] tool result chars', n(big), '| full page', n(full.rendered), '| dialogue page', n(dlg.rendered), '| default==full', recall.renderSealedTurn(events, 1)!.rendered === full.rendered)
console.log('[H2] recall_turn output re-digested?', rd.digestToolResult('x'.repeat(20000), { tool: 'recall_turn' }).digested)
console.log('[H2] recall_step re-digested?', rd.digestToolResult('x'.repeat(20000), { tool: 'recall_step' }).digested)
console.log('[H2] expand_result re-digested?', rd.digestToolResult('x'.repeat(20000), { tool: 'expand_result' }).digested)
console.log('[H2] raw bash result digested?', rd.digestToolResult(big, { tool: 'bash' }).digested, n(rd.digestToolResult(big, { tool: 'bash' }).text))
```

工具 run id 索引：`run_90657608-adb4-44f5-9fb8-25d01e96fde1`（10 files/73 tests passed）、`run_6e34cd6b-799f-4b57-8e4d-ca2d1f9dbc18`（探针 1）、`run_a5880287-8738-4ee0-ae3b-9267c5468f21`（探针 2）、`run_59f77c41-8978-42b3-984c-d23a5bab59f9`（探针 3）、`run_5af171d1-fea2-45c2-b102-af9954953f10`（HEAD/工作树状态）。
