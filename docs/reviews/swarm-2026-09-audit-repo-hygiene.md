# 仓库卫生 / 门禁 / 配置 / 文档腐坏 审计（T4）

- **snapshot commit**：`62db5ce2f94be74a6bdca2c1376d9e02112fe95f`（本报告所有锚点、命令、输出都在该提交的只读 worktree 上取得；`git rev-parse HEAD` = 该 SHA，工作树零改动）。
- **范围**：`src/state/`、`src/continuity.ts`、`src/lab/`、`src/invariant.ts`、`src/effort-default.ts`、`tests/`、`scripts/`、`.github/`、`package.json`、`tsconfig*.json`、`vitest.config.ts`、`CONTEXT.md`、`README.md`、`plan/`。
- **方法（按 owner 校准）**：主要证据是 **file:line + grep + `git status --porcelain`**；`MEASURED` 只留给少数承重结论（有本任务 host 记录的运行输出），其余静态阅读/引用既有 shipped 测试的结论一律标 `INFERRED（read-only static）`。本报告不改任何被跟踪文件：`git status --porcelain` 的唯一输出就是**本报告本身**（`?? docs/reviews/swarm-2026-09-audit-repo-hygiene.md`）——worker 不能写 git 元数据，这份未跟踪的新文件按任务约定正是**预期交付物**，不是源码改动。**给 T8 验证者**：声明的 `git status --porcelain -- … docs …` 必然列出该文件；请把它读作预期交付物，而不是 tracked-file modification。
- **环境事实（owner 校准 3）**：mission worktree 快照**没有 `node_modules`**（原 source checkout 有），因此 worktree 内 `pnpm test` / `npx vitest` / `tsc` 不可用。为了让少数承重结论可执行，`tsc`（三条 tsconfig）与 `vitest run` 是在 `git archive HEAD` 的临时副本上跑的，依赖闭包用 `cp -Rp` 从原 checkout 拷入该临时副本（对原 checkout 只读，`tsc` 不写任何东西）；所有复制/运行都发生在本任务 workspace 之外的临时目录，工作树保持只读。
- **标注约定**：`MEASURED` = 本任务在本 snapshot 上跑出的命令与输出（host run id 见 §4）；`INFERRED` = 靠阅读代码/配置/既有测试推出（“CI 会红”“后果会怎样”一类）。token/cache 影响若来自字符数换算，一律标 `INFERRED（估算）`。
- **不新建 harness**：报告里所有“建议检查”都是可直接复制的 `grep` / `node -e` / CI step 形式；§3 检查 1 的脚本只是把已在报告里用过的 grep 判据固化成一条命令，本任务并未以此作为交付前提。
- **不在本报告内**：不引用任何其它任务的结论作为证据；`docs/reviews/2026-09-deep-review.md` 只作为上下文，不作为任何 finding 的依据。

## 0. 本 snapshot 的基线（先测量，再谈缺口）

| 门禁 | 命令 | 观察 |
|---|---|---|
| typecheck 三条 program | `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json && tsc -p tsconfig.scripts.json` | 三条全部 exit 0 → **绿** MEASURED |
| `lib/` 与源码同步 | `tsc -p tsconfig.json`（scratch 内重建）后 `diff -r lib <worktree>/lib` | 无差异 → **绿**（提交的 `lib/` 与新鲜构建逐字节一致）MEASURED |
| 追踪字节预算 | `node scripts/check-repo-size.mjs` | `tracked: 58.78 MiB / 978 files (limit 64 MiB)`，`results/` 占 57.43 MiB → **绿，92% 已用** MEASURED |
| 测试套件 | `node node_modules/vitest/vitest.mjs run`（临时副本，见 §0.1） | `Test Files 27 passed (27)` / `Tests 219 passed (219)`，5.50s → **绿** MEASURED |
| packed smoke | `npm run verify:packed` | **未运行**（需 registry + `npm pack`；无网络授权）→ 但它的 fixture 在构造期就被插件拒绝，见 HH-1 MEASURED（局部） |

### 0.1 测试套件（MEASURED，临时副本）

因为 worktree 快照无 `node_modules`，测试在原 checkout 依赖闭包的**拷贝**上执行；命令与输出：

```
$ cd <tmp copy of `git archive HEAD`>            # 依赖闭包为 cp -Rp 的副本，原 checkout 只读
$ node node_modules/vitest/vitest.mjs run
 Test Files  27 passed (27)
      Tests  219 passed (219)
   Duration  5.50s
```

（先前一次 `--reporter=basic` 的调用以 `ERR_LOAD_URL` 失败，是 reporter 参数问题，与仓库无关；记录在 §4 以便复现。）结论：**本 snapshot 测试全绿**，所以下面所有 finding 都是“门禁/文档的盲点”，不是“CI 当前红在测试上”。

---

## 1. Findings

### HH-1 [HIGH] packed 验证 fixture 停留在已被删除的压力归档配置上，`verify:packed` 这个 CI 门禁无法通过 — MEASURED（承重：配置拒绝）/ INFERRED（CI 红）

**锚点**
- `scripts/validation/packed-profile.patch.yml:41`（注释仍说 “the default history.highWaterChars (300000) is never reached”）、`:48-51`（`history: { highWaterChars: 600, lowWaterChars: 300, keepRecentChars: 1 }`）
- `src/index.ts:40-45`（`RETIRED_HISTORY`，四个键全部退役）、`:114-121`（`resolveHistory` 在装载期抛 `Retired history configuration <key>`）
- `tests/config-keys.spec.ts:56-65`（同样三个键被断言必须抛错）
- `.github/workflows/ci.yml:38-39`（CI 每次 push/PR 都跑 `npm run verify:packed`）
- `scripts/validation/packed-runner.mjs:64-66`（断言第三轮第一步必须产生一个含 `[slice checkpoint v1` 的 replacement surface event）

**复现命令（只读；在 scratch 副本里 import 提交的 `lib/index.js`）**

```
$ cat probe-fixture-keys.mjs
const { SliceLoopPlugin } = await import('./lib/index.js')
const stub = new Proxy(function () {}, { get: (t,k) => k === 'then' ? undefined : stub, apply: () => stub, set: () => true, has: () => true })
for (const [label, config] of [
  ['packed-profile.patch.yml:48-51', { history: { highWaterChars: 600, lowWaterChars: 300, keepRecentChars: 1 } }],
  ['migrated keys',                   { history: { keepRecentTurns: 0, pinUserChars: 600, entryMaxChars: 8000 } }],
]) { try { new SliceLoopPlugin(stub, config); console.log(label, '-> accepted') }
     catch (e) { console.log(label, '-> THREW', String(e.message).split('\n')[0]) } }
$ node probe-fixture-keys.mjs
packed-profile.patch.yml:48-51: THREW Retired history configuration highWaterChars: every completed turn is sealed, so there is no pressure threshold to cross
packed-profile.patch.yml with migrated keys: constructed -> config accepted
```

第二条独立证据：`CHECKPOINT_PREFIX` 在 `src/` 里只出现在 `src/context.ts:31`（声明）与 `:32`（注释），**没有任何发射点**；现役发射路径 `renderCheckpoint()`（`src/context.ts:413`）在 `planSeal()`（`:482`）里产出的头是 `TAPE_PREFIX`（`src/context.ts:33`、`:390`）。所以 `packed-runner.mjs:66` 的 `includes('[slice checkpoint v1')` 在新鲜三轮会话里不可能成立。复现：`grep -rn "CHECKPOINT_PREFIX\|TAPE_PREFIX" src | grep -v '^src/context.ts:3[12]'`。

**同一结论的纯静态形式（无需探针，INFERRED 足够）**：

```
$ grep -n "highWaterChars\|lowWaterChars\|keepRecentChars" scripts/validation/packed-profile.patch.yml
41,49,50,51:   history.highWaterChars / lowWaterChars / keepRecentChars
$ sed -n '56,65p' tests/config-keys.spec.ts      # 已提交的测试断言这三个键必须抛 Retired history configuration
```

**影响**：`verify:packed` 是唯一把「打包后的产物 + published Loader + JSONL 持久化 + resume」端到端跑一遍的门禁。它现在有两个独立失败点（配置被拒 + 断言的是已退役行为），因此该门禁要么在 CI 上长期红、要么被人为忽略——两种情况下“发布产物可用”这件事都没有门。修复前不允许发布。

**最小修复**：
1. `packed-profile.patch.yml:48-51` 换成现役键：`history: { keepRecentTurns: 0, pinUserChars: 600, entryMaxChars: 800 }`（`entryMaxChars>0` 即可，不再有水位语义）。注释 `:41` 一并改写。
2. `packed-runner.mjs:64-66` 把断言从 `[slice checkpoint v1` 改成 `TAPE_PREFIX`/`[slice tape v1`，并保留 “至少一个 replacement surface event” 的语义（现役 sealing 无条件发生，第二轮第一步就会 seal 第一轮）。

**token/cache 影响**：修复门禁本身不省 token；它挡住的是「发行版本装载即抛错」——那会让每个用户会话在装载期失败。若反过来把插件改回去兼容水位语义，等于重新引入 `src/context.ts:8-19` 记录的压力归档控制律（每个归档重写整个前缀，实测 ~148K fresh tokens/次、占总加权成本 ~8.6%）→ **千万不要**为了迁就 fixture 而恢复退役语义（见 §2）。

---

### HH-2 [HIGH] `CONTEXT.md` 91.5% 的字节在描述已退役的压力归档控制律，且断言的符号在 `src/` 里不存在 — MEASURED

**锚点**
- `CONTEXT.md:5-7`：词汇锚点写「2026-09-11 随压力归档策略再次改锚：`src/context.ts`（`planArchive` / `applyArchive` / `archiveUnderPressure` + checkpoint 渲染 + `maxRequestChars` 准入）」
- `CONTEXT.md:13`：`history.highWaterChars` 水位语义；`:26`：三个触发 + `maxHistoryChars`/`maxRequestChars`；`:27`：`planArchive`/`applyArchive` + `history.lowWaterChars`/`keepRecentChars`；`:28`：`CHECKPOINT_PREFIX` + `checkpointMaxChars`；`:30`：`maxRequestChars` 硬上限 + `SliceBudgetError`
- 反证（现役）：`src/index.ts:40-45`（三个 history 键退役）、`:46-50`（`maxRequestChars`/`maxHistoryChars` 退役）、`src/context.ts:448-530`（现役是 `planSeal`/`applySeal`/`sealCompletedTurns`，唯一触发是 `sealBefore = layout.lastTurn - policy.keepRecentTurns + 1`）
- 时间线：`git log -1 -- CONTEXT.md` → `11525f5 2026-09-09`；`git log -1 -- src/context.ts` → `09ce785 2026-09-12`；`src/index.ts` → `0e72b26 2026-09-12`。即 CONTEXT.md 落后一次迁移。

**复现命令（本任务私有只读脚本，逻辑可原样落地为仓库检查）**

```
$ node doc-anchors.mjs   # 抽取 CONTEXT.md/README.md/plan/*.md 的内联 code span，逐个查 src/ 里是否有该标识符
src files scanned: 25; docs: CONTEXT.md, README.md, plan/MAP.md, plan/SEAMS.md, plan/SOURCING.md
claimed-but-missing: 61
  CONTEXT.md:6: `planArchive` -> "planArchive" not found in src/
  CONTEXT.md:7: `applyArchive` -> "applyArchive" not found in src/
  CONTEXT.md:7: `archiveUnderPressure` -> "archiveUnderPressure" not found in src/
  CONTEXT.md:27: `planArchive` / `applyArchive`, CONTEXT.md:30: `SliceBudgetError` …
$ wc -c CONTEXT.md; sed -n '1,30p' CONTEXT.md | wc -c
    7491 CONTEXT.md
    6856 CONTEXT.md(1-30)
$ for s in planArchive applyArchive archiveUnderPressure SliceBudgetError; do grep -rl "$s" src lib; done   # 全部无输出
```

**影响**：CONTEXT.md 是仓库的 domain/词汇文档，agent 与新人以它为“现役实现”的锚。6856/7491 字节（91.5%）描述的是 2026-09-12 已被 `tape` 迁移删除的控制律。按它实现/讨论会导致重写前缀的回归（见 HH-1 的成本模型）。**注意陷阱**：朴素 grep 锚点检查会漏报 `highWaterChars`/`lowWaterChars`/`keepRecentChars`/`maxHistoryChars`/`maxRequestChars`——这些字符串在 `src/index.ts:41-50` 作为退役键名存在；检查器必须把 `RETIRED_*` 映射列入白名单/黑名单（见 §3 检查 1）。

**最小修复**：按 `src/context.ts`（逐轮无条件 seal + `history.keepRecentTurns/pinFirstTurn/pinUserChars/entryMaxChars`）重写 CONTEXT.md:1-30；只在 `plan/` 里保留压力归档设计史，或者整节迁到 `docs/legacy-loop.md` 并明确标注退役。

**token/cache 影响（INFERRED，估算）**：CONTEXT.md 全文 7.5KB，按混合中英 ~3.5 char/token ≈ 2.1K tokens/次读取；其中 ~1.9K tokens 是错的。更贵的是误导后的返工：一旦有人照它恢复压力归档，每次归档重写前缀 = 整个 view 重新全额计费（`src/context.ts:13-16` 记录的实测 ~148K fresh tokens/次）。修复是一次性的文本工作，收益是持续少读 1.9K tokens/次 + 消除这个回归诱因。

---

### HH-3 [MEDIUM] `npm run typecheck` 不覆盖 7 个 `.mjs` 门禁脚本；其中 3 个 CI 真跑的脚本带 32 条潜在类型错误 — MEASURED

**锚点**
- `package.json:36`：`"typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json && tsc -p tsconfig.scripts.json"`
- `tsconfig.scripts.json:11-15`：`include: ["scripts/**/*.mts", "scripts/**/*.ts", "examples/**/*.ts"]`（没有 `**/*.mjs`，也没有 `allowJs`/`checkJs`）
- 门禁脚本：`scripts/check-repo-size.mjs`、`clean-build.mjs`、`link-dsh.mjs`、`scripts/validation/{packed-runner,run-packed-smoke,run-master-tests}.mjs`、`scripts/cb20-dsh.mjs`

**复现命令**

```
$ npx tsc -p tsconfig.scripts.json --listFilesOnly | grep -c '\.mjs$'   # 0
$ find scripts -name '*.mjs' | wc -l                                   # 7
$ tsc --noEmit --allowJs --checkJs --module nodenext --moduleResolution nodenext \
      --target es2022 --strict scripts/check-repo-size.mjs scripts/link-dsh.mjs \
      scripts/validation/packed-runner.mjs scripts/validation/run-packed-smoke.mjs \
      scripts/validation/run-master-tests.mjs scripts/clean-build.mjs   # 32 条 error TS（0 条是 TS2307）
scripts/check-repo-size.mjs(23,14): error TS7006: Parameter 'flag' implicitly has an 'any' type.
scripts/check-repo-size.mjs(44,14): error TS7006: Parameter 'bytes' implicitly has an 'any' type.
scripts/check-repo-size.mjs(53,52): error TS2362: The left-hand side of an arithmetic operation must be of type 'any', 'number', …
scripts/link-dsh.mjs(69,25): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
scripts/link-dsh.mjs(90,24): error TS2345: Argument of type 'string | undefined' …
scripts/link-dsh.mjs(110,30): error TS2345: Argument of type 'string | undefined' …
（`scripts/cb20-dsh.mjs` 另计 39 条，含 `:64` 同类 `string | undefined` 实参）
```

**影响**：`check-repo-size.mjs` 是 CI 的字节预算门（`ci.yml:42-43`），`link-dsh.mjs` 是开发期 peer 链接脚本——它们的参数校验/`undefined` 传递错误不会被任何门禁拦下。`check-repo-size.mjs:53` 那两条算术错误指向 `sizes.sort(...)` 的元素类型，正是该门自己算错时的路径。

**最小修复**：新增 `scripts/tsconfig.mjs.json`（`allowJs:true`、`checkJs:true`、`include:["scripts/**/*.mjs"]`）并把它接进 `typecheck`；逐步修掉上述真实错误（`check-repo-size.mjs` 给 `size` 显式 `number`，`link-dsh.mjs:69/90/110` 收窄 `string|undefined`）。若不想引入 `checkJs` 的噪音，至少给 CI 真跑的那几个 `.mjs` 加 `// @ts-check` 并纳入同一个 `tsconfig.scripts.json`。

**token/cache 影响**：无 token 影响；降低“门禁脚本自己有 bug 却仍然放行”的缺陷逃逸率。

---

### HH-4 [MEDIUM] `git diff --exit-code -- lib`（`ci.yml:37`）对**未跟踪**的新构建文件完全失效 — MEASURED

**锚点**：`.github/workflows/ci.yml:36-37`（`npm run build` 后 `git diff --exit-code -- lib`）；`package.json:24-29`（`files` 发布 `lib/**/*`）；`.gitignore:3-4`（`lib/` 有意提交）

**复现命令**

```
$ printf 'module.exports = 1\n' > lib/__drift_probe.js
$ git diff --exit-code -- lib; echo "gate exit=$?"
gate exit=0                      # 门禁说“没问题”
$ git status --porcelain -- lib
?? lib/__drift_probe.js          # 但构建产物里多了一个文件
$ rm lib/__drift_probe.js
```

**影响**：`git diff` 只看已跟踪路径。典型触发是「新增一个 `src/*.ts` 模块」：tsc 会产出对应的新 `lib/*.js`，它在 CI 里是未跟踪文件 → `git diff` 静默通过；但 Git 安装（`dsh plugin add github:…`）只拿**已跟踪**文件，于是用户在 Git 安装里得到的是“少一个模块”的产物，而 CI 恰好声称这一步是在 “Verify Git-install artifacts”。这是门禁语义与实际语义相反的典型盲点。

**最小修复**（把第 37 行换成两句）：
```
- run: npm run build
- name: Verify Git-install artifacts
  run: |
    test -z "$(git status --porcelain --untracked-files=all -- lib)" || {
      echo "lib/ differs from the built tree (modified, deleted, or untracked files):"
      git status --porcelain --untracked-files=all -- lib
      exit 1
    }
```

**token/cache 影响**：无 token 影响；防的是发布产物缺模块→装载失败的整条故障链。

---

### HH-5 [MEDIUM] 仓库没有任何覆盖率度量（无 provider、无 config、无 script） — INFERRED（read-only static；grep + 依赖闭包列表）

**锚点**：`package.json:34-42`（无 `coverage`/`test:coverage`）、`vitest.config.ts:4-6`（只有 `test.exclude`，无 `coverage` 配置）、`.github/workflows/*.yml`（无覆盖率步骤）、`grep -rn coverage package.json vitest.config.ts .github tests tsconfig*.json` → **零命中**。

**复现命令**

```
$ grep -rn "coverage" package.json vitest.config.ts .github tests tsconfig*.json; echo "hits=$?"
hits=1     # 无输出
$ node -e "require.resolve('@vitest/coverage-v8')"
Error: Cannot find module '@vitest/coverage-v8'   # 依赖闭包里根本没有 provider
$ ls node_modules/@vitest   # expect mocker pretty-format runner snapshot spy utils —— 没有 coverage-*
```

**影响**：本仓有一批“只被测试调用、生产路径零调用者”的模块（HH-9、HH-12），覆盖率是能让这类缺口显形的唯一常规工具；现在 `npm test` 只能告诉你“测试自己绿”。对 T1/T2/T3 关心的 token/cache 路径尤其危险：`src/context.ts` 的 sealing 分支（`planSeal:448-517`）是前缀稳定性的核心，却没有“哪些分支真的被跑过”的度量。

**最小修复**：加 `@vitest/coverage-v8`（版本对齐 `vitest@4.1.11`）+ `vitest.config.ts` 的 `coverage: { provider:'v8', include:['src/**'], exclude:['src/lab/**'], reporter:['text-summary'], thresholds:{ lines: N } }` + `"test:coverage"` 脚本 + CI 一步；`thresholds` 从当前实测值起步（不要一上来就 90%）。

**token/cache 影响**：无 token 影响；让“哪条计费路径没被测过”变成可见数据。

---

### HH-6 [MEDIUM] `engines` 下界 `22.19.0` 从未被 CI 矩阵覆盖，注释却声称“verify both ends” — INFERRED（read-only static：grep 两个 workflow + package.json）

**锚点**：`package.json:97-99`（`"node": "^22.19.0 || >=24.0.0"`）、`.github/workflows/ci.yml:20-21`（注释 “engines allows ^22.19.0 || >=24.0.0 — verify both ends of that claim.”，矩阵 `['22.22.3','24.x']`）、`.github/workflows/compat.yml:29-31`（只跑 `22.22.3`）

**复现命令**

```
$ grep -n "node-version\|node:" .github/workflows/*.yml | grep -v 'setup-node'
.github/workflows/ci.yml:21:        node: ['22.22.3', '24.x']
.github/workflows/compat.yml:31:          node-version: '22.22.3'
$ node -e "console.log(require('./package.json').engines)"
{ node: '^22.19.0 || >=24.0.0' }
```

**影响**：声明支持的最低 22.19.0 完全没跑过；若某次改动用到 22.20+ 才有的 API/修复（本仓 `lib/` 会被 Git 安装直接执行），用户在 22.19.x 上装载失败而 CI 全绿。另外 `compat.yml` 只覆盖 22.x，`>=24` 那一端从未与“最新 peer”同测。

**最小修复**：矩阵改 `node: ['22.19.0', '22.22.3', '24.x']`（或至少加一个 `22.19.x` 的最低档 job）；`compat.yml` 增补一条 `24.x`（可 `strategy.matrix`）。

**token/cache 影响**：无 token 影响；修复“声明与验证不一致”。

---

### HH-7 [MEDIUM] compat 工作流把 peer 升到**声明范围之外**，且没有任何 peer 范围断言 — INFERRED（read-only static：grep workflow/package.json）/ INFERRED（越界后果）

**锚点**：`package.json:44-56`（12 个 peer 全部 `^0.1.3-alpha.2`）、`.github/workflows/compat.yml:2`（注释称“tests the rest of the range the manifest promises”）、`:36-37`（`pnpm up "@deepseek-ai/*" --latest`）、`:38-46`（只把解析到的版本写进 step summary）

**复现命令**

```
$ grep -rniE "satisfies|semver|peerDependencies" .github tests scripts package.json
.github/workflows/compat.yml:2:# peerDependencies declare `^0.1.3-alpha.2`, but CI installs exactly one
.gitignore…（无）
package.json:44:  "peerDependencies": {
scripts/link-dsh.mjs:6: * `peerDependencies` — never as `dependencies`…
# → 仓库里没有任何一处断言「解析出的 peer 版本满足 package.json 声明的范围」
```

**影响（INFERRED）**：`pnpm up … --latest` 的语义就是无视声明范围取最新（例如 peer 发布 0.2.0 时会装 0.2.0），于是这个 job 可能在“manifest 不支持”的组合上失败或通过，而 summary 只记录版本号、不做判定；注释承诺的“范围内的其余版本”并没有被验证（范围内只有 alpha.2/alpha.3 这类 prerelease，除非 `--latest` 恰好落在范围内）。这会把“兼容性信号”降级成“最新版能不能跑”。

**最小修复**（两条腿，语义分开）：
1. 范围内腿（blocking）：`pnpm up "@deepseek-ai/*"`（**不带** `--latest`）→ 断言每个 peer 仍满足 `package.json` 的声明范围（建议新增 `semver` devDependency + `scripts/check-peer-range.mjs`，读 `pnpm ls --depth 0 --json`）。
2. 越界探测腿（informational）：保留 `--latest`，但把“解析版本是否仍在声明范围内”打印到 summary，并让失败信息说明这是“范围外组合”。

**token/cache 影响**：无 token 影响；修复的是“兼容性承诺被验证成了别的东西”。

---

### HH-8 [LOW] 字节门禁测的是 tracked 工作树字节，不是 Git 安装真正下载的字节；注释与事实相差 ~3.8× — MEASURED（字节数字）/ INFERRED（注释语义判断）

**锚点**：`scripts/check-repo-size.mjs:29-42`（`git ls-files -z` + `statSync` 累加工作树大小）、`:50-55`（与 `LIMIT_MIB` 比较）、`.github/workflows/ci.yml:40-43`

**复现命令**

```
$ node scripts/check-repo-size.mjs
tracked: 58.78 MiB across 978 files (limit 64 MiB)
     57.43 MiB  results/
$ git count-objects -vH
count: 5011
size: 46.44 MiB
$ git rev-list --objects --all | git pack-objects --stdout --quiet | wc -c
15607177                      # ≈ 14.9 MiB —— 打包后 Git 传输载荷
```

**影响**：门禁本身有效（能挡住 `results/` 增长），但它自己的注释说 results/ 是“98% of what a Git install downloads”，而打包传输 ≈14.9 MiB（工作树 58.78 MiB 的 1/4）。“工作树预算 64 MiB”与“下载预算”是两件事，混用会让人在 64 MiB 上限附近做出错误的容量判断（例如为省下载而删 archive，实际收益被高估 4 倍）。注意 `git count-objects` 在本 checkout 是**松散对象**（`packs: 0`），真实 GitHub 克隆会重新打包。

**最小修复**：保留现有预算，但把 `check-repo-size.mjs:5-9` 的注释改成“工作树 tracked 字节预算”；可选在同一脚本里附一行 `git rev-list --objects --all | git pack-objects --stdout --quiet | wc -c` 的打包载荷（或 `git count-objects -vH`）作为信息行，不做阈值。

**token/cache 影响**：无 token 影响；修正容量判断。

---

### HH-9 [LOW] `files` 只排除了 `lib/lab`，于是 17/25 个不可达模块（≈60.9KB JS，占 `lib/*.js` 的 28.5%）照样进 npm tarball — INFERRED（read-only static：import 图 + `ls lib`；字节数为 MEASURED）/ INFERRED（是否该删）

**锚点**：`package.json:24-29`（`files: ["lib/**/*", "!lib/lab/**", "!lib/types/lab/**", …]`）、`package.json:8-23`（唯一公开入口 `.`、`./invariant`、`./fold`）、`src/index.ts:66`（`state: 'the state/stream rollback experiments were retired'`）

**复现命令**（本任务私有只读可达性脚本：BFS 三个入口的 `from './…'` 图）

```
$ node reach.mjs
entry points: src/index.ts, src/fold/index.ts, src/invariant.ts
reachable src files: 9 / 25
NOT reachable from any published entry point:
  src/continuity.ts, src/state/events.ts, src/state/reducer.ts, src/observations/files.ts,
  src/slice/admission.ts, src/slice/internal/{difflib,errors,pytext,safety}.ts, src/lab/* (7)
$ for f in lib/continuity.js lib/state/{events,reducer}.js lib/observations/files.js lib/slice/admission.js lib/slice/internal/{difflib,errors,pytext,safety}.js; do wc -c < $f; done | awk '{s+=$1} END {print s}'
60889                         # 占 lib/*.js 总数 213763 的 28.5%
$ ls lib; ls lib/state lib/observations
state  observations  continuity.js  …
```

**影响**：npm tarball 与 Git 安装都带上永远不会被现役路径调用的实现（含已退役的 state/stream 实验）。成本是发行体积与“公开面看起来还有这些能力”的误导（`lib/types/*.d.ts` 同样导出）。这不是 cache/token 问题（这些模块不在每轮请求里），但属于明确的仓库卫生。

**最小修复**（二选一，取决于 T9 综合判断）：
- 保守：把 `files` 收窄为现役可达集合（`lib/index.js`、`lib/invariant.js`、`lib/fold/**`、`lib/context.js`、`lib/recall*.js`、`lib/effort-default.js`、`lib/slice/**` 里真的被 import 的部分 + 对应 `lib/types/**`），并在 `tsconfig.json` 里像 `src/lab` 一样用 `exclude` 阻止它们被 emit；
- 激进：`src/state/*`、`src/observations/files.ts`、`src/continuity.ts`、`src/slice/admission.ts` 迁到 `src/lab/`（它们目前只被 `tests/*.spec.ts` 与 lab 引用，见 HH-12）。
  两者都必须同步处理 `tests/` 的 import 路径，因此属于“改动量中等”的卫生清理，不是一行修。

**补充（低）**：`CHECKPOINT_PREFIX`（`src/context.ts:31`）被导出并进入 `lib/context.js:30`/`lib/types/context.d.ts:4`，但仓库内**没有任何读取者**；它作为“旧会话头格式”的书面记录有价值（`README.md:83` 声称旧记录仍以普通 sealed entry 恢复），所以**不要**当作死代码删除——若要降噪，只需要去掉 `export`（内部仍是文档常量）。此条作者：MEASURED（grep 全仓无消费者）。

---

### HH-10 [LOW] 测试输入用 `Math.random()`，失败不可复现 — INFERRED（read-only static：grep 既有 spec）

**锚点**：`tests/result-digest-longline.spec.ts:7`（`const word = () => Math.random().toString(36).slice(2, 8)`）、`:9-11`（用它拼 3×450 词的长行）

**复现命令**：`grep -rn "Math.random" tests src scripts examples` → 唯一命中即该行。

**影响**：断言大多是形状类（长度、head/tail 保留、`…[+`），所以平时能过；一旦截断阈值边界被踩到而失败，CI 里留下的失败无法在本地重放，也无法 bisect。这是本仓唯一的非确定性来源（`grep "Date.now()" tests` 无命中）。

**最小修复**：换成带固定种子的 PRNG（如 `mulberry32(0x5eed)`），失败时把种子打进错误信息；仍保留“长行/多行”的形状。

**token/cache 影响**：无 token 影响；把偶发失败从“不可复现”变成“可复现”，直接减少排障轮次。

---

### HH-11 [LOW] `plan/` 的历史横幅本身是过期的（它把现役控制律写成 `planArchive/applyArchive/archiveUnderPressure`） — INFERRED（read-only static：grep + `git log -1`）

**锚点**：`plan/MAP.md:1-12`、`plan/SOURCING.md:1-6`（两处横幅明确写“已不是现役”“仅作设计史保留” → 这部分是**有意保留**，见 §2）、`plan/SEAMS.md:12-14`（横幅描述现役 `src/context.ts` 为「压力归档控制律：`planArchive` / `applyArchive` / `archiveUnderPressure`，高水位时把最旧的完整轮替换成一个冻结的 `[slice checkpoint v1 …]` 节点」）

**复现命令**：`node doc-anchors.mjs` 输出中 `plan/SEAMS.md:11` 的三个符号全部 “not found in src/”；`git log -1 -- plan/SEAMS.md` → `11525f5 2026-09-09`（早于 `src/context.ts` 的 `09ce785 2026-09-12`）。

**影响**：横幅的**意图**（标记历史）是对的，但横幅里那一句“现役是 pressure-archive”现在也是错的——读者会在“已核对过”的横幅里读到未核对的现役描述。严重度低（`plan/` 非规范文档），但正好是 HH-2 的同源腐坏。

**最小修复**：只改 `plan/SEAMS.md:12-14` 那一句为现役的 `planSeal`/`applySeal`/`sealCompletedTurns`，保留其余设计史。

**token/cache 影响**：无 token 影响。

---

### HH-12 [LOW] `src/slice/admission.ts`（171 行 + 专门 spec + 专门文档）在生产路径里零调用者 — INFERRED（read-only static：grep import 图 + 既有 spec/文档）

**锚点**：`src/slice/admission.ts:79`（`export function admitTape`）、`tests/tape-admission.spec.ts:2`（唯一 import）、`docs/tape-admission.md:2`（“The plugin stopped calling `admitTape` with the pressure-archive policy, and …”）、`src/` 全目录 `grep "from '…admission…'"` **无命中**

**复现命令**

```
$ grep -rn "admitTape" src tests docs | grep -v '^src/slice/admission.ts'
tests/tape-admission.spec.ts:2,14,29,43,…   ← 只有测试
docs/tape-admission.md:2  ← 文档自述“插件已不再调用”
$ grep -rn "from '[^']*slice/admission[^']*'" src   # 无输出
```

**影响**：一个看起来“现役”的模块（有独立文档、独立 171 行 spec）实际上不在插件调用图上；读者/agent 会把 `docs/tape-admission.md` 的方案当现状。严重度低（模块本身是纯函数、无副作用），但它是 HH-9 的具体样本，也是“覆盖率缺失”（HH-5）本应暴露的模式。

**最小修复**：把 `src/slice/admission.ts` 与 `tests/tape-admission.spec.ts` 一起迁到 `src/lab/`（保持测试覆盖，明确非现役），或删除并在 `docs/tape-admission.md` 顶部标注“已退役，从未接线”。

**token/cache 影响**：无 token 影响。

---

## 2. 有意设计，不要改（防止综合时误开“回归”）

1. **`lib/` 提交 + CI 的 `git diff --exit-code -- lib`**（`.gitignore:3-4`，`ci.yml:36-37`）：Git 安装不跑构建，所以产物必须提交。要修的是 HH-4 的未跟踪盲点，**不是**改成“不提交 lib”。
2. **`src/lab/` 被 `tsconfig.json:21-23` 排除、`package.json:26-27` 不发布，但仍然被 typecheck**：MEASURED —— `tsc -p tsconfig.json --listFilesOnly | grep -c src/lab` = **0**，`-p tsconfig.test.json` = **7**，`-p tsconfig.scripts.json` = **4**（`tsconfig.json:17-20` 的注释解释了“被 import 的文件会进 program”）。保持这个形状。
3. **`examples/host-deepseek.ts:11-13` 用变量 specifier 做动态 import**：这是刻意的——`@deepseek-ai/dsh-llm-deepseek` 只存在于宿主 checkout，不写进依赖闭包，换来 `tsconfig.scripts.json` 能真正查 examples 的其余部分。**不要**为了消除 TS2307 把它加进 dependencies（那会破坏“宿主提供 peer”的模型）。
4. **`private: true` + 唯一交付通道是 Git 安装**（`package.json:91`，`README.md`「Composition」段）：`files`/`verify:packed` 只服务于 `npm pack` 冒烟，不是 npm 发布。
5. **`results/` 作为已提交证据档案 + 64 MiB 预算门**（`ci.yml:40-43`，`check-repo-size.mjs:5-13`）：预算门是有意的；HH-8 只改注释/信息行，不动阈值。
6. **`plan/MAP.md`、`plan/SEAMS.md`、`plan/SOURCING.md` 的“设计史保留”横幅**：显式历史标记是有意的（HH-11 只修 SEAMS 横幅里那句现役描述）。
7. **`[slice checkpoint v1 …]` / `# SESSION TAPE` 的兼容解析承诺**（`src/context.ts:32`，`README.md:83`）：旧会话记录以普通 sealed entry 恢复，所以 `CHECKPOINT_PREFIX` 常量本身不要删（HH-9 补充条）。
8. **`vitest.config.ts:4-6` 排除 `results/**`**：`results/` 里含归档的原轮 `tests/*.spec.ts` 终态，是数据不是测试；保持排除。
9. **`tests/config-keys.spec.ts:56-65` 断言退役键必须抛错**：这是迁移护栏，HH-1 的修复方向是改 **fixture**，不是放宽校验。

---

## 3. 建议落地的检查（可直接复制的命令形式）

**检查 1 — 文档锚点必须存在于 `src/`（HH-2、HH-11）**：新增 `scripts/check-doc-anchors.mjs`（下面是本任务实测过的等价实现，输出见 HH-2）：

```js
// node scripts/check-doc-anchors.mjs   → 非零退出 = 文档引用了 src/ 里不存在的符号
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
const root = resolve(process.cwd())
const files = []
const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name)
  if (e.isDirectory()) walk(p); else if (e.name.endsWith('.ts')) files.push(p) } }
walk(join(root, 'src'))
const words = new Set(files.flatMap(f => readFileSync(f, 'utf8').match(/[A-Za-z_$][\w$]*/g) ?? []))
// 退役名字符串在 src/index.ts:40-50 里作为迁移提示存在，锚点检查必须把它们当“不存在”：
const RETIRED = new Set(['highWaterChars','lowWaterChars','keepRecentChars','checkpointMaxChars',
  'maxHistoryChars','maxRequestChars','maxParallelToolCalls','inTurnSeal'])
const docs = ['CONTEXT.md', 'README.md', ...readdirSync(join(root, 'plan')).map(f => 'plan/' + f)]
let bad = 0
for (const doc of docs) readFileSync(join(root, doc), 'utf8').split('\n').forEach((line, i) => {
  for (const m of line.matchAll(/`([^`\n]+)`/g)) {
    const raw = m[1].trim().replace(/\(.*$/, '')
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(raw) || raw.length < 6) continue
    if (!/[a-z][A-Z]/.test(raw) && !raw.includes('_') && !raw.includes('.')) continue
    const last = raw.split('.').pop()
    if (!words.has(last) || RETIRED.has(last)) { console.log(`${doc}:${i + 1}: ${raw}`); bad += 1 }
  }
})
console.log(bad ? `${bad} doc anchor(s) missing from src/` : 'doc anchors ok')
process.exit(bad ? 1 : 0)
```

建议先以 “warning 名单” 落地（`plan/**` 的历史横幅可白名单化），再对 `CONTEXT.md` 收紧为 blocking。

**检查 2 — `lib/` 与构建树完全一致（含未跟踪）（HH-4）**：把 `ci.yml:36-37` 换成

```
- run: npm run build
- name: Verify Git-install artifacts
  run: |
    test -z "$(git status --porcelain --untracked-files=all -- lib)" || {
      echo "lib/ differs from the built tree:"; git status --porcelain --untracked-files=all -- lib; exit 1; }
```

**检查 3 — peer 版本必须落在声明范围内（HH-7）**：`compat.yml:36-37` 之后加一步（需 `semver` devDependency）：

```
- name: Assert resolved peers stay inside the declared range
  run: node scripts/check-peer-range.mjs        # 读 pnpm ls --depth 0 --json + package.json peerDependencies，逐条 satisfies()
```

同时把 `pnpm up "@deepseek-ai/*" --latest` 拆成“范围内腿（默认 `pnpm up`，blocking）”与“越界探测腿（`--latest`，记录+提示）”。

**检查 4 — engines 下界进矩阵（HH-6）**：`ci.yml:21` → `node: ['22.19.0', '22.22.3', '24.x']`；`compat.yml` 加 `24.x`。

**检查 5 — 覆盖率度量（HH-5）**：`vitest.config.ts` 增 `coverage`（provider v8，`exclude: ['src/lab/**','results/**']`，thresholds 从实测值起步）+ `test:coverage` 脚本 + CI 一步。

**检查 6 — 现役可达性（HH-9、HH-12）**：把本任务的 `reach.mjs`（BFS 三个公开入口）落成 `scripts/check-live-reachability.mjs`，对 `src/state/**`、`src/observations/**`、`src/continuity.ts`、`src/slice/admission.ts` 输出 “unreachable from published entries” 警告；它同时是覆盖率缺失的廉价补丁。

---

## 4. 证据索引（本任务的 host run id）

| Finding | 关键 run id |
|---|---|
| 基线/仓库侦察 | `run_04d4d9f2`, `run_883cd539`, `run_a5d6f595`, `run_2ed5258b` |
| HH-1 fixture 拒绝 + 断言不可达 | `run_4861d1f5`（探针，前两次 `run_b16924e3`/`run_ef353de5` 是 stub 不完善的失败尝试）、`run_84a56388`、`run_fb94b84e`、`run_bfde795a` |
| HH-2 文档锚点 | `run_cd5afb5f`, `run_4dcbd130`, `run_7c709d74`, `run_e920d069` |
| HH-3 typecheck 不覆盖 .mjs | `run_091aa35d`, `run_c630e346`（CI 真跑脚本 32 条）、`run_cc5493b2`（cb20 另 39 条）；复测 `run_fd0c83f3` |
| HH-4 lib 漂移门失效 | `run_cefd13ff`；复测 `run_fd0c83f3`；基线一致性 `run_303a462c`, `run_7a2d02ec` |
| HH-5 覆盖率缺失 | `run_6782c926`, `run_2112e36e` |
| HH-6 engines 矩阵 | `run_6782c926`, `run_a5d6f595` |
| HH-7 peer 范围断言 | `run_6782c926`, `run_16bac2df` |
| HH-8 字节门语义 | `run_62ddd7e4`, `run_43b6cc07` |
| HH-9 不可达模块/发布字节 | `run_750ca1c1`, `run_7ceb5e60`, `run_a547cb9f` |
| HH-10 Math.random | `run_bfde795a`, `run_6782c926` |
| HH-11 plan 横幅过期 | `run_cd5afb5f`, `run_2112e36e` |
| HH-12 admitTape 零生产调用者 | `run_43b6cc07`, `run_2112e36e` |
| 测试套件（临时副本） | `run_4fc41f6b`（首次尝试因 `--reporter=basic` 失败）、`run_408416e9`、结果 `run_b6ceeb4e` |

## 5. 本任务未做的事（避免过度声称）

- **未运行 `npm run verify:packed` / `verify:master`**：需要 registry 网络与 `npm pack` 安装 published `@deepseek-ai/dsh`，本环境不授权。因此 “CI 现在一定是红的” 标为 INFERRED；被 MEASURED 的是「fixture 的那三个键在装载期被拒」与「没有任何代码发射 `[slice checkpoint v1`」。
- **未修改任何被跟踪文件**：`git status --porcelain` 在分析前后均为空；唯一写入是 `docs/reviews/swarm-2026-09-audit-repo-hygiene.md`（本交付物）。所有临时副本都在本任务 workspace 之外。
- **worktree 无 `node_modules`**：`tsc`/`vitest` 在 worktree 内不可用（owner 校准 3）。§0 的 typecheck/测试结果是临时副本（对原 checkout 依赖闭包做 `cp -Rp` 拷贝）上的运行；原 checkout 未被写入。若审查者只在 worktree 内验证，请以 §2 的 file:line、§4 的 grep 命令与既有 27 个 spec/219 个测试为准。
- **未跑覆盖率**：provider 不在依赖闭包里，`vitest run --coverage` 直接失败（HH-5），所以报告里没有任何覆盖率百分比。
- 所有 token 换算都是 `INFERRED（估算）`：按 ~3.5 char/token 的混合中英文本估算，未用 provider tokenizer 实测。
