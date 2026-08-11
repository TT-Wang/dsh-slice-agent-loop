# dsh-slice-agent-loop

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/dsh2026) 用的 agent loop 替代实现。它的上下文引擎是一份**有界切片**,不是一条越长越长的对话记录。

stock loop 每次请求都把 `session.deriveMessages()`(整段派生历史)发出去,所以 prompt 随会话增长。这个 loop 每轮从携带的状态重建一份有界上下文 —— 一个对话环、一条 append-only 的 SESSION TAPE 存放封存轮的摘要、以及带哈希锚点的文件定位符 —— prompt 的尺寸由**当前任务**决定,而不是由之前发生过的所有事情决定。

600 轮会话实测:tape 在 ~120k 字符触顶,第 300 轮到第 600 轮之间只涨 1.11×。这条性质由 `tests/unit.test.ts` 把着,不是只写在这里。

```
第 100 轮: 76,560 字符    第 300 轮: 83,473    第 600 轮: 92,725
```

## 状态

早期。这个 loop 实现了 dsh `Agent` 的完整契约,门套件经过反转验证(每个修复都退回去跑一遍,确认对应的门真的会红),但它是个年轻的移植版,有已知缺口 —— 依赖它之前先读[已知局限](#已知局限)。版本 `0.0.1` 对应 DSH 快照 `20260810T155924Z`。

## 安装

官方 bundle 插件,从 git 源安装,不走 npm。构建产物已提交进仓库,所以 git 源安装不需要构建步骤:

```sh
dsh plugin --profile <name> add "github:dsh-external/dsh-slice-agent-loop#main"
```

从本地检出安装则是:`dsh plugin --profile <name> add .`

包自带 `cordis.patch.yml`,所以把它装进一个 profile 就是全部接线。这份 patch 做三件事,前两件不是可选的:

```yaml
- id: agent-loop        # ctx.agents 只有一个工厂位
  disabled: true
- id: compact-basic     # 本 loop 的有界重建替代了压缩
  disabled: true
- id: command-compact   # 它 inject `compact`,服务没了会永久挂起
  disabled: true
- insert:
    - id: slice-agent-loop
      name: '@dsh-external/dsh-slice-agent-loop'
```

两个 loop 同时挂载会直接报错,而不是按加载顺序挑一个,所以 `agent-loop` 那行必须保持 disabled。

### 压缩位于 preset 平面

DSH 0810 之后,真正在跑的压缩栈待在每个 preset 自己的 `compaction` isolate 组里,host 平面的 patch 伸不进去 —— 上面那几行只管得到 host 平面。在 `standard`、`code` 或 `cordis` 下压缩栈照旧运行,而 `dsh-token-meter` 计价的是 *surface* 而不是真正发出去的那份切片(`dsh-external/issues#564`),所以它报的压力数字描述的不是这个 loop 的真实请求。

要在没有压缩的情况下跑,两个办法:选 `minimal`(唯一不挂压缩的 preset),或者自己写一个 preset 放进 `$DSH_HOME/.agent-presets/` —— 复制 `standard/agent.cordis.yml`,把 `compaction` 组删掉。

## 配置

| 键 | 默认值 | 含义 |
|---|--:|---|
| `maxParallelToolCalls` | `10` | 每步同时在飞的并行安全工具体上限。并发不安全的工具仍然自成屏障。 |
| `maxStepsPerTurn` | `50` | 单轮 continuation step 硬顶。是**界**不是停滞检测 —— 见下。 |

从你自己 profile 的 `cordis.patch.yml` 里设,它在上面那层 bundle 之后生效。那一行**已经存在**了,按 id 定位它:

```yaml
- id: slice-agent-loop
  config:
    maxParallelToolCalls: 4
```

不要套在 `- insert:` 里面。insert 是**追加一条新的**而不是配置已有那条,而两个 loop 工厂正是上面说的那个直接报错的情况。也不要加 `name:` 键,除非它精确等于 `@dsh-external/dsh-slice-agent-loop` —— name 是**断言**不是覆盖,对不上会让加载器**静默跳过整行**。

## 与 `@deepseek-ai/dsh-agent-loop/invariant` 不兼容

那个配套插件断言 `model-visible ⟺ logged`:发出去的 messages 必须和 `session.deriveMessages()` 逐字节相等。**有界切片 loop 在构造上就满足不了它** —— 发一份重建出来的切片而不是派生历史,正是这个 loop 的全部意义。

所以这个插件在它旁边会**拒绝加载**,并给出一条讲清怎么修的报错,而不是让每一轮都死在 `llm/stream` 里。这里有个坑要留神:`dsh scaffold` 把 `agent-loop-invariant` 写成**独立于** `agent-loop` 的一行,所以换掉 loop 并不会把它一起带走。

```yaml
# 切到 slice loop 时把这行删掉
- id: agent-loop-invariant
  disabled: true
```

### 诚实的替代

请求仍然可审计。每次分发之前,driver 会追加一条持久的 `slice/request-slice` 事件,带上它即将发送的那份切片的摘要 —— 事后你可以证明第 N 轮第 M 步到底装了什么,而不必把整份切片复制进日志。

`@dsh-external/dsh-slice-agent-loop/invariant` 检查的就是这条更弱的性质。和 stock 那个不同,它对这个 loop 是**成立的**:

```yaml
- id: slice-loop-invariant
  name: '@dsh-external/dsh-slice-agent-loop/invariant'
```

## 持久事件

| 事件 | 负载 | 用途 |
|---|---|---|
| `slice/file-anchor` | `{ turn, path, body }` | 一次成功编辑的脱敏后态,在轮封存时追加。agent 重建时,tape 的文件锚点只从日志恢复 —— 绝不靠推测去重读磁盘。 |
| `slice/request-slice` | `{ turn, step, seedDigest, messageCount }` | 一次分发请求的审计记录(见上)。 |
| `slice/step-budget` | `{ turn, step, budget }` | 该轮撞到 `maxStepsPerTurn` 被终止。`turn/end` 的 `reason.kind` 为 `'step-budget'`。 |

三者都归插件所有,且只进日志:它们从不进入模型面,所以对 prompt 零开销。

## 文件锚定

跨轮的文件连续性,是切片比对话记录便宜的原因所在:被编辑过的文件以 `base`/`patch` 两种 tape 条目的形式携带,外加一份 OPEN FILES 定位索引(路径 · 行数 · sha256),而不是整份重新粘一遍。

**索引给的是文件,不是调用。** 它以前会附一句 `read_file("<路径>")` —— 这是**双重错**:DSH 的读取工具注册名是 `read`,而且参数是 `{file_path}` 不是位置字符串。而没有任何门发现,因为模型从来没试过。硬编码 `read` 会在宿主改名时腐烂,运行时发现又做不到非启发式(`ToolSchema` 只有 `{name, description, parameters}`,没有能力标签可匹配),所以干脆不渲染调用名。模型本来就看得见自己的工具 schema,它只需要知道回读哪个文件。`tests/driver-contract.spec.ts` 里现在有一条门:渲染出的任何调用形状,只要名字不是宿主真实注册的工具,立刻变红。

锚定观察的是**执行平面**,不是模型看到的东西。它挂在 `tools/result` 上,认 `exec.name` —— 真正跑起来的那个工具。

这个区别正是它在每个 preset 下都能工作的原因。在 **Code mode** 下,工具面收缩成单个 `run_code`,真正的编辑变成 TypeScript 程序里的子调用。两个平面都经由同一个 `scheduler.finish` 落地,所以一条缝盖住两边,loop 完全不需要知道 Code mode 存在。

默认覆盖 DSH 自己的文件系统工具:

| 工具 | 路径字段 | 说明 |
|---|---|---|
| `write`、`edit` | `file_path` | `dsh-tool-fs` |
| `str_replace_editor` | `path` | 只认 `create` / `str_replace` / `insert` —— `view` 是只读的,从不锚定 |

如果你的部署把文件工具注册成别的名字,锚定会**静默地找不到任何东西**,护城河的主体随之停止工作。这两种失败模式(名字不对、只观察顶层调用)都有门看着,在 `tests/driver-contract.spec.ts`;自定义工具面需要把名字加进 `src/driver.ts` 的 `EDIT_TOOL_NAMES`。

## 步数预算

`maxStepsPerTurn` 会终止一个不收敛的轮。它是**界,不是诊断** —— 不去判断模型有没有在取得进展。

一个停滞检测方案被设计出来又被否决了。它的判据(continuation 步 + 无助手文本 + 无新文件锚点)在真实的 19 轮会话上重放:会砍掉 143 步里的 **45 步(31%)**,其中 24 步来自一个做了 74 次不同工具调用的高产轮,而且在普通 5 步轮上就发警告。原因是**对推理模型,「无可见文本 + 工具调用」正是调查工作的常态**:叙述进 reasoning 块,可见文本只在收尾出现。一个高产的 49 步轮和一个徒劳的 20 步轮在这个维度上无法区分 —— 重复度也一样,两者都是 0%。

撞顶时追加 `slice/step-budget`,并以 `reason.kind: 'step-budget'` 结束该轮。它**不会**走 `agent/turn-stopping` seam —— 那个 seam 的契约是"用 steering 表示反对,并在同一轮里继续",和硬停止正相反。撞顶时到达的 steering 留在 inbox 里由下一轮 claim,与 error 路径同款处置。

## 已知局限

- **弹性只降得动一个分区。** driver 会从模型上下文窗口算出一个字符预算,再把切片按这个预算重投影一次;移植过来的 `ElasticityController` 确实会跑降级循环 —— 但在有内容的三个分区里,只有 `open_files` 有东西可降。`task_objective` 是强制的,不会产出定位符替代;而 `session_tape`(体积最大的那块)在 `locatorRegion()` 里**根本没有分支**。所以小幅超限会被"把 OPEN FILES 索引降成定位符形态"吸收掉(几百字符);再往下控制器就没有候选了,抛 `ContextUnfitError`。driver 接住它,退回不设限的投影并告警,所以装不下的切片不会弄死一轮;上界仍然是由 tape 预算兜着的,不是由分区降级兜着的。
- **取回类入口是被刻意拿掉的,不是坏的。** 移植过来的 Python 渲染器会发出写成 `read_file(...)`、指向 `@sliceagent/...` 的回读指针 —— 那是一套由**本移植版没有拿过来的持久层**服务的虚拟上下文文件系统。DSH 也服务不了它:没有路径拦截、没有 read 中间件、没有 resolver hook。driver 侧那些指针**已删除而不是伪装**,所以 tape 只陈述"这条回复被截了",不再给出一个不可能成功的调用。全文仍然完整留在会话日志里;想让模型够得着,挂 `@deepseek-ai/dsh-tool-session-query`(`session_search`、`session_event_read` 等五个,都是真实注册的工具)。`src/slice/` 下引擎侧的渲染器还留着 Python 的写法,因为它们被黄金套件逐字节钉死,而且只在本移植版渲染为空的分区里出现。
- **和 stock invariant 不兼容**(见上)。
- **`dsh-token-meter` 和压缩栈计价的是 surface**,不是真正分发出去的切片,所以它们报的压力数字描述的不是这个 loop 的真实请求。这个偏差随轮数增长且不收敛;已上报为 `dsh-external/issues#564`。
- **只有三个上下文分区有内容** —— `session_tape`、`task_objective`、`open_files`。移植过来的引擎还有别的(intent、findings、progress signals、world),它们渲染为空。
- **任务目标钉死在会话的第一条消息上。** 话题切换没有移植,所以一个中途换任务的长会话,会一直把最初那个目标放在权级最高的区块里。
- **Code mode 锚定写,不锚定读。** 锚定在子调用的写上触发,所以跨轮文件连续性是成立的。但 `run_code` 程序内部执行的读是另一回事:loop 只知道它看见被写过的文件,所以一个读五个文件、只改一个的程序,只会把改过的那个带到下一轮。Code mode 的"把多步折进一个程序"和切片的"把文件状态带过轮次"到底是互补还是相冲,没有测过。

## 快速开始

```bash
git clone https://github.com/dsh-external/dsh-slice-agent-loop.git
cd dsh-slice-agent-loop
npm install --legacy-peer-deps && npm run link:dsh
```

没在 org 上配 ssh key 就走 https。`--legacy-peer-deps` 是唯一一个非标准动作:那 9 个 `@deepseek-ai/*` peer 是私有的,裸跑 `npm install` 会停在 `E404 ... is not in this registry` —— 那个报错读起来像这个包坏了,实际只是 npm 拉不到宿主自己会提供的东西。`link:dsh` 随后把它们从你的 dsh 检出软链过来。

## 开发

```bash
npm run typecheck && npm test
```

有两件事脚本自己说不出来:

- **任何 `npm install` 之后都要重跑 `link:dsh`。** npm 会重写 `node_modules`,把 peer 软链一起冲掉;而报出来的错读起来像整个 harness 消失了(`Cannot find module '@deepseek-ai/dsh-agent'`)。
- **`lib/` 是提交进仓库的** —— 推之前先构建,否则 git 源安装装到的是旧产物。

全量套件是 pre-push 门而不是 CI 门:harness peer 是私有的,伪造它们等于测一个 mock 而不是测契约。CI 能覆盖什么、以及为什么那部分才值得覆盖,写在 [`ci.yml`](.github/workflows/ci.yml) 里。

## 许可

BSD-3-Clause —— 见 [LICENSE](LICENSE)。
