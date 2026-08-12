# Plan: Reasonix 学习成果落地

> **处置记录(2026-08-12,本节为准;下文为原始计划,标题曾写"4 项全做")**
> - **#5 前缀不变门 — 已落地**(`keeps the system prefix and tool catalog byte-stable across turns`,变异验证)
> - **#2 recall 两级化 — 已落地,形态有别于计划**:独立工具 `recall_search`(评分检索 + kind 防洪)+ 既有 `recall_turn`,未做 `around` 操作(轮粒度的 recall_turn 已覆盖邻域需求)、未做 operation 复用单工具(两工具目录语义更清晰)
> - **#1 bounded-call 隔离 — 判定不适用,未落地**:本 loop 唯一模型调用即主轮请求(driver.ts:971),无元调用消费者;按仓库纪律不造无消费者的基础设施
> - **#3 TTL 感知恢复 — 判定不适用,未落地**:切片每轮重建有界上下文,冷恢复无可修剪之物
> 详见 README「Memory recall」节与 commit aa80006 / 后续修复提交。

来源：DeepSeek-Reasonix 研究（2026-08-12）· 目标仓库：`~/code/dsh-slice-agent-loop`
原则：每项都带测试门（本仓库惯例：变异验证）；不引入新持久化；bounded slice 哲学优先。

## #5 前缀不变门（先做，最小）

- 断言：同一 session 连续两轮请求，system 前缀字节级相等（byte-stable prefix 是整个缓存经济的前提）
- 位置：`tests/driver-contract.spec.ts` 新 gate；MockAdapter 记录两轮请求，比较 `request.system`
- 变异验证：临时给 system 注入轮号 → 红；恢复 → 绿

## #1 bounded-call 隔离（boundedllm 模式）

- 新模块 `src/bounded-call.ts`：无工具、无历史、temperature 0、硬预算（timeout/maxTokens/maxBytes）、usage 记独立 source
- 现实消费者：本 loop 当前无元调用（标题由 dsh session-title 插件承担）——模块作为**基础设施 + 文档化模式**落地，不虚构消费者
- 门：预算硬顶（超时/超字节中断）、usage source 隔离、不含历史

## #2 recall 两级化（search + around + kind 过滤）

- `recall.ts` 升级：`operation: 'search' | 'around' | 'turn'`（turn 保持 tape 广告位兼容）
- search：BM25-lite 排名（user_text/assistant_text/tool_input/tool_error；**tool_output 默认排除**，kind 可显式包含）
- around：命中点邻域消息（before/after 有界）
- 门：search 排名正确性、kind 过滤、around 邻域、工具输出默认排除、旧 recall_turn 调用向后兼容

## #3 TTL 感知 resume

- `src/cache-policy.ts`：vendor TTL 表（DeepSeek 24h、Anthropic/DashScope 5m，显式 config 优先），baseURL host 精确/后缀匹配
- resume 时：比较最后事件时间与 TTL，发 `slice/resume-cache {warm, idleMs, ttlMs}` 事件（观测用；slice 重建本就有界，不做修剪）
- 门：vendor 识别、TTL 解析优先级、warm/cold 两路事件

## 执行序与验证

1. #5（≈30min）→ #1（≈1h）→ #2（≈1.5h）→ #3（≈45min）
2. 每项：实现 + 门 + `npm test` 全绿 + typecheck
3. 全部完成后：一个 commit、push、更新 README（recall 新能力 + 新事件）
