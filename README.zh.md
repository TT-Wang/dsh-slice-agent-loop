# dsh-slice-agent-loop

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/dsh2026) 用的 agent loop 替代实现:
上下文是一份**有界切片**,不是越长越长的对话记录。每轮上下文按当前任务的
尺寸重建 —— 600 轮实测会话的峰值在 ~120k 字符触顶,不随会话长度增长。
早期内测版;对应 DSH 快照 `20260811T152241Z`。

## 架构

**Session tape。** 只追加的封存轮账本:每轮问了什么、做了什么的摘要,文件
基线与已应用的补丁,以及回复。进入上下文的是 tape 而不是对话记录,所以
无论会话多长,峰值有界。

**Memory recall。** 切口处不丢东西。超长内容在 tape 里以精确标记截断,
全文始终留在持久会话日志里:`recall_turn` 逐字取回任一早前轮,
`recall_search` 找到某句话在哪一轮。上下文有界,历史无损。

## 安装

```sh
dsh plugin --profile <name> add "github:dsh-external/dsh-slice-agent-loop#main"
```

自带的 patch 会禁用 stock loop 与压缩 —— 有界重建同时替代两者。如果你的
组合里有 `agent-loop-invariant` 行,删掉它:重建的切片不可能与派生历史
逐字节相等,本插件在那条断言旁会拒绝加载。

## 配置

| 键 | 默认 | |
|---|--:|---|
| `kernel` | `'slice'` | 系统提示 kernel;`'ported'` 换成 Python prompt 逐字移植版(A/B 臂) |
| `maxStepsPerTurn` | `50` | 单轮 continuation step 硬顶 |
| `maxParallelToolCalls` | `10` | 每步并行工具体上限;DSH 0811 起同时限制子 agent 扇出 |

在你 profile 的 `cordis.patch.yml` 里按 id 定位已有行来设
(`- id: slice-agent-loop` + `config:`)。

## 开发

```bash
npm install --legacy-peer-deps   # @deepseek-ai/* peer 未发布
npm run link:dsh                 # 从你的 dsh 检出软链
npm run typecheck && npm test
```

`lib/` 是提交物(git 源安装不跑构建)—— 推之前先 `npm run build`。
真模型冒烟:`npm run e2e:recall`(需要 env 里有 `DEEPSEEK_API_KEY`)。

## 许可

BSD-3-Clause —— 见 [LICENSE](LICENSE)。
