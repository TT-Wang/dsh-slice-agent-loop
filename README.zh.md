# dsh-slice-agent-loop

[English](README.md)

面向 **DeepSeek Harness 0.1.3-alpha.2** 的有界对话上下文策略。它与原生 agent loop 并行运行，生命周期、调度器、收件箱、持久化、请求序列与完整请求重建不变量全部保留在宿主侧。

已完成的对话片段成为持久的 `user/message` surface replacement。指令消息、当前用户输入、用户多模态消息与**当前生效的**运行时快照保留原来的来源与位置。唯一的例外是已被宿主取代的运行时快照：它会被移出请求视图，原位留下一条指向其 `recall_turn` 页的标记——因为每轮留一个死快照在 surface 上会把各 span 的预算压到零。原始事件留在会话日志里；折叠、省略或恢复之后由 `recall_turn` / `recall_search` 取回。

## 安装与组合

用 DSH 的插件安装器安装本仓库，并应用它的 `cordis.patch.yml` bundle。该 patch **只新增插件**。**保持 `agent-loop`、`agent-loop-invariant` 与原生 session projections 启用。** Git 包内含已生成的 `lib/` 产物。

本包已经自带一份工具结果折叠，和独立插件 [`dsh-tool-result-fold`](https://github.com/TT-Wang/dsh-tool-result-fold) 同源，也以 `./fold` 导出。**不要在同一个 profile 里再装那个独立插件**：两者都会注册 `expand_result`，第二次注册会在加载时直接失败（`tool "expand_result" is already registered`）。只有想在不装 slice 策略的原生 loop 上单独用折叠时，才单独挂 `./fold`（或那个独立插件）。

```yaml
- id: slice-agent-loop
  name: '@dsh-external/dsh-slice-agent-loop'
  config:
    maxHistoryChars: 120000
    maxRequestChars: 400000
    maxStepsPerTurn: 50
    defaultReasoningEffort: low
```

| 配置项 | 含义 |
|---|---|
| `maxHistoryChars` | 渲染后对话历史合计的硬上限，含各段 header 与召回标记。 |
| `maxRequestChars` | 序列化模型 **messages** 的硬上限，含受保护上下文与当前输入。它是字符上限，不是 token 估算；system prompt／工具 schema 与模型容量仍归宿主。 |
| `maxStepsPerTurn` | 超过这么多模型步就停止派发；默认 50。 |
| `defaultReasoningEffort` | `off`、`low`、`high`、`max` 或 `inherit`；宿主／模型的显式选择优先。**受模型能力门控**：只有已解析模型声明了该档位时才注入。模型未声明（或根本不声明 reasoning）时沿用适配器默认，并按路由告警一次；若能力查询本身失败，则静默沿用适配器默认（`src/effort-default.ts` 的 `declaredEfforts` 在任何异常上返回 `undefined`，只有拿到能力表时才告警）。|
| `digest` | 内容路由选项，见 `src/slice/result-digest.ts`。 |
| `fold` | 工具结果折叠选项，含 `enabled`、`pinSteps`、`pinMaxChars`、`spillPreviewMinBytes`、`backoffAfterExpansions`。 |

拒绝之前先做确定性降级。装不下自己那份 `maxHistoryChars` 的历史 span，会被换成一条有界的"全部省略"标记，其中带着它覆盖的每一轮的 `recall_turn` 定位符——**按 span 逐段降级**，装得下的 span 不会被装不下的那段拖着一起丢；这一步会走插件的 `warn` 通道打日志。装配后的请求若仍超过 `maxRequestChars`，则把历史预算让回去、从同一批原始事件重新规划（最多六轮），而不是让本会话之后每一轮都以同样方式拒绝。只有连有界标记都装不下、或仅受保护部分就已超出消息预算时，请求构造才**明确失败**。插件不会静默返回超限视图。预算拒绝前先记录当前输入。历史片段一律先全部规划、再追加替换。

`recall_search` 搜索原始的用户与助手文本、工具输入与工具错误；普通工具**输出**默认不在检索范围（它是会话里体量最大、信噪比最低的文本），需要时显式传 `kinds: ["tool_output"]`（见 `src/recall.ts` 的 `DEFAULT_SEARCH_KINDS`）。`recall_turn` 返回一整轮，含原始记录与工具元数据；`recall_step` 取回某一步；`expand_result` 按精确的结果序号取回，可按行或正则过滤。带 spill 定位符的工具结果用其预览里给出的定位符。

## 从 0.0.1 迁移

- 删掉旧的、停用原生 loop 与不变量的 override，改用新的增量 bundle。
- 把 `maxParallelToolCalls` 等调度配置移到原生 `agent-loop` 行。
- `mode: state`、`mode: stream`、`state`、`tape`、`inTurnSeal` 已退役，加载时报错。不安全的宿主文件快照与写入回滚实现已删除。
- 私有的 `sliceContext.contribute` 注册表已退役。改用宿主的 system-prompt／runtime-context 扩展，让来源身份与持久化归 DSH。
- 原生不变量与本包的兼容导出 `./invariant` **二选一挂载，不要都挂**。两者装的是同一套完整重建检查。
- 旧日志里含 required `slice/*` 事件的，仍需原来的 reader 或显式迁移。本次发布不改写宿主的已知事件词汇表，也不改写旧会话文件。

文件读取是记录下来的窗口，写入／编辑元数据含 diff 片段。它们是历史观察，不能证明文件当前全文，也不能证明后端身份。完整 base／免重读指针类优化保持关闭，直到宿主提供带完整 provider 文本、目标身份与版本的持久观察通道。见 [记录式记忆](docs/recorded-memory.md)。

## 开发与验证

使用 Node `^22.19.0 || >=24.0.0` 与 pnpm 11.7.0：

```sh
pnpm install --frozen-lockfile
npm run typecheck
npm test
npm run build
```

公开的 alpha.2 依赖锁在 `pnpm-lock.yaml` 里；**不需要维护者的本地检出，也不需要任何绝对依赖路径**。CI 对着这些已发布包跑完整测试，包括原生 loop 不变量与真实 JSONL 关闭／恢复。构建会先清掉过期的生成文件再产出 Git 安装用的产物。

`npm run verify:packed` 跑一遍免密钥的标准安装器／Loader／JSONL 冒烟；`npm run verify:master -- /path/to/deepseek-harness` 对着一份准备好的上游源码检出跑。[已记录的升级验证](docs/upgrade-verification.md) 把已发布版本、源码 master、打包产物三类证据分开陈述。

`verify:packed` 的前置条件：pnpm 11.7.0（由 `packageManager` 固定，建议开启 corepack；版本不符会直接失败，除非设置 `SLICE_PACKED_ALLOW_PNPM_MISMATCH=1`）；能访问 npm registry（它会把已发布的 `@deepseek-ai/dsh` 0.1.3-alpha.2 装进一个全新的临时工作区）；以及 JSONL 持久化原生插件 `fs-ext` 构建所需的工具链（冒烟会执行它的 install 脚本）。运行结束会打印证据目录。

原生回归套件覆盖：运行时上下文的保留／更新／移除、不透明指令来源归属、多模态输入、重试与 steering、请求序列切换、admission 失败、卸载，以及不带插件恢复会话。另有一个测试验证：改动后续消息会被原生不变量拒绝派发。

缓存前缀与现付文本取决于本轮哪些片段发生变化；**不存在普适的缓存命中或成本保证**。[早期自建 loop 的实测](docs/legacy-loop.zh.md) 属历史记录。本次迁移改变了策略，那些数字需要在新架构上重跑模型质量／成本实验后才能重新引用。
