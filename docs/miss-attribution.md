# Miss attribution（缓存未命中归因）

回答一个此前答不了的问题：**每个轮界的 miss 到底是什么**——正常的追加（新 tape 条目 + 后缀重建），还是字节漂移（封存内容变了 / system 变了 / runtime-context 在种子前面抖动）。

背景与共识（2026-09-01 grill 会话）：账本成本分解显示未命中输入占 slice 成本 39–86%，是第一大头；修字节卫生之前先建归因，否则修完无法验收。

## 用法

```bash
# 1) bench 运行时带上 sidecar 开关（生产不设 = 零开销）
SLICE_CALL_LEDGER_DIR=results/sidecars <你的 bench 命令>

# 2) 离线归因
npx tsx scripts/attribute-miss.mts results/sidecars            # 整个目录
npx tsx scripts/attribute-miss.mts results/sidecars/<id>.calls.jsonl --json
```

Sidecar 每会话一个文件（`<sessionId>.calls.jsonl`）：每轮一条 `seed`（system · runtime-context 块 · 切片 user 文本的**发出原字节**），每次成功调用一条 `call`（原始 usage + 归一化 `norm`，`norm.input` 沿用 bench 账本口径 = MISS tokens；`norm.reasoning` 单列，为下一场输出侧战役留的弹药）。

## Verdict 语义

| verdict | 含义 | 处置 |
|---|---|---|
| `ok` | tape 逐字节复用，分歧点在轮后缀，miss 尺寸在期望 ± 容差内 | 健康 |
| `suspect-size` | 结构健康但实际 miss 超期望 > 容差（默认 2×64-token 块） | 先查 envelope/估算，再怀疑服务端逐出 |
| `tape-drift` | 封存 tape 字节变了——append-only 不变式被打破 | 渲染不稳定，修代码 |
| `system-drift` | system 前缀会话中途变了 | 修装配 |
| `runtime-context-volatile` | 宿主 runtime-context 块变了；它排在切片**之前**，抖一次 = 整条 tape 前缀作废 | 最高优先级排查 |

## 已知限制

- 期望 miss 是字符→token 估算（用 sidecar 自身校准 chars/token），容差按 DeepSeek 64-token 块粒度给；它抓的是"12.5K vs 期望 2K"量级的异常，不是逐 token 对账。
- **turn 1 不参与归因**（无前轮），且其 cacheRead 受账号级缓存跨 run 焐热影响，数字天然脏。
- 轮内第 2+ 步的 miss（轨迹消息）不做字节归因，只进 totals。
- 失败/重试的调用无 usage，不落 `call` 行。

## 后续（按共识顺序）

1. n2 + n3 最小验证：工具在无异常轮上期望≈实际，n2-turn2 悬案结案。
2. 字节卫生两组修复（稳定渲染、第二次读取即冻结），优先级由归因数据裁决。
3. 修复落地后把「所有轮界 verdict === 'ok'」钉进 CI（`analyze()` 就是断言函数；CLI exit code 已按此设计）。
