# dsh-slice-agent-loop

[English](README.md)

面向 **DeepSeek Harness 0.1.3-alpha.2** 的有界上下文插件。现在与原生 agent-loop 一起运行，生命周期、收件箱、并发调度、持久化、请求序列和完整请求重建不变量都由 DSH 管理。

已完成的对话片段通过原生 surface replacement 写入 SESSION TAPE。运行时上下文、指令来源、当前请求和用户多模态消息保留原来的来源与位置；原始事件留在日志中，折叠和恢复后仍可召回。

## 迁移

1. 恢复原生 `agent-loop`、`agent-loop-invariant` 与 session projections；新 bundle 只添加 slice 插件。
2. 将 `maxParallelToolCalls` 等调度配置移到原生 loop。
3. `state`／`stream` 模式以及 `state`、`tape`、`inTurnSeal` 配置已经退役，加载时会明确报错。旧的本机文件快照与写入回滚代码已删除。
4. 私有 `sliceContext.contribute` 改用 DSH 的 system-prompt／runtime-context 扩展。`./invariant` 现为原生完整检查的兼容导出，不要重复挂载。
5. 旧日志里的 required `slice/*` 事件仍需原来的 reader 或显式迁移；本次不会改写旧日志或修改宿主的已知事件集合。

## 配置与限制

默认 `maxHistoryChars: 120000` 限制历史文本和召回标记；`maxRequestChars: 400000` 限制序列化模型消息，包括保护的上下文与当前输入。它们是字符上限，不是 token 估算；system prompt、工具 schema 与模型容量仍由宿主负责。无法安全满足上限时明确拒绝请求，不静默超限；预算拒绝前先记录用户输入。默认 `maxStepsPerTurn: 50`，`defaultReasoningEffort: low`，显式模型选择优先。

`recall_search` 搜索原始记录，`recall_turn` 包含该轮用户、助手与工具原始记录，`recall_step` 返回步骤，`expand_result` 按实际工具结果序号精确召回。`digest` 和 `fold` 可配置工具结果折叠策略。

读取窗口与编辑 diff 只能证明历史观察，不能证明文件全文、当前磁盘内容或远端身份。因此完整文件 base／免重读指针暂不启用，详见 [记录式记忆](docs/recorded-memory.md)。

## 验证

Node `^22.19.0 || >=24.0.0`，pnpm 11.7.0；依次执行 `pnpm install --frozen-lockfile`、`npm run typecheck`、`npm test`、`npm run build`。依赖锁定公开发布的 alpha.2 包；CI 运行完整测试，包括原生请求不变量和 JSONL 关闭／恢复。

缓存前缀与现付文本取决于实际替换片段。本次迁移没有沿用旧实现的成本／质量结论；[历史实验](docs/legacy-loop.zh.md) 需要在新策略上重新跑模型评测。
