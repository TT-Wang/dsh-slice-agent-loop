# 三个最值得做、还没人做的 dsh 插件(2026-09-04)

## 扫描方法与已知边界

- **dsh 本体**:200 余个包的描述、扩展缝(seams)、各包 README 的「Known Limitations and Deferred Work」(维护者自己列的未做项)。
- **DeepSeek 计价**(api-docs pricing 页,2026-09):v4-flash 未命中 $0.22–0.44/M、命中 $0.007–0.014/M、输出 $0.66–1.32/M,
  v4-pro 三倍;高峰只有工作日 UTC 01–04 与 06–10 共 7 小时,其余时段一律半价。缓存按**完整前缀**匹配、自动开启、服务端保存
  数小时到数天,usage 里给 `prompt_cache_hit_tokens / prompt_cache_miss_tokens`。结论:上下文长度几乎免费(命中价是未命中的
  1/30)、改写前缀很贵、输出最贵(是命中价的 94 倍)。
- **生态**:GitHub 仓库搜索(API)+ awesome-dsh-plugin 精选列表(约 1,200 条、23 类)。生态极大(radar 类项目称发现 1.1–1.6 万候选),
  这里只核了名字与描述,不能证明"绝对没人做";下面说的"没人做"指精选列表与关键词搜索里没有,或只有 0–2 星的雏形。

## 已经有人做的(不重复)

| 方向 | 已有 |
|---|---|
| 成本计量、预算、峰谷提示 | dsh-cost-meter ★249、dsh-budget、dsh-budget-guard(峰谷计价)、dsh-token-planner、多种余额小组件 |
| 缓存命中率显示、缓存教练 | dsh-client-ui-cache-hit、dsh-cache-coach(点名第一处破坏前缀的改动,只观察)、dsh-cache-stabilizer ★2 |
| 缓存感知的压缩 | dsh-cache-aware-compaction(冷热盈亏点判断,73 测试,报告 62%)★0 |
| 谷时调度 | dsh-input-traffic(高峰自动暂停)、dsh-off-peak-schedule-widget、cost-lens |
| 推理档位路由 | dsh-routing-suite ★7046、dsh-effort-slider |
| 工具结果裁剪 | dsh-token-saver ★0、我们的 dsh-tool-result-fold |
| 编辑工具变体 | dsh-tool-edit(replace/patch/apply_patch/hashline)★0、dsh-tool-hashline ★2 |
| 代码索引 | dsh-plugin-codegraph ★12、codegraph、dsh-repo-analyzer(都是按需工具,不是稳定前缀) |

## 一、缓存对齐的委派:子代理与 workflow 共享前缀(cache-aligned delegation)

**机制**。DeepSeek 只认完整前缀。dsh 的 spawn 子代理"从空对话开始,任务提示必须说清一切",workflow 的 `agent()` 同样起新代理;
父代理把同一份说明(规格、仓库背景、要读的文件)写进每个孩子的任务文本,这些字节对每个孩子都是**未命中**。而 fork 后端把父代理已完成
的轮次原样作为种子——在别的提供商上这是最贵的做法,在 DeepSeek 上恰恰相反:父上下文 100K token,孩子每步只付命中价 $0.0007,
比让孩子重读同样的文件便宜两个数量级。
**没人做**:精选列表里子代理类插件全是监控与 UI;GitHub 上"subagent/swarm + cache/prefix"零结果;dsh-swarm(100+ 并发 V4 代理)
只做屏障同步。
**做什么**:(1)委派工具的变体:孩子的第一条用户消息 = [字节稳定的共享序言(persona、工具、任务说明、要共享的文件内容,确定性排序)] +
[每个孩子各自的任务],序言放前面才能命中;(2)fork-first 策略:DeepSeek 路由上默认 fork,孩子继承父缓存;(3)扇出报表:每个
孩子的 `prompt_cache_hit_tokens` 占比、共享/独有字节、扇出总价。用到的缝:`ctx.subagents` provider、`dsh-tool-subagent`、
workflow 引擎的 `agent()`、`agent/request`(可为孩子改路由)。
**算账**。N 个孩子共享 B token 的说明:现在每孩子多付 B × $0.22/M,对齐后付 B × $0.007/M。20 孩子 × 20K = 省 $0.085/次扇出;
100 孩子 × 30K = 省 $0.64/次;孩子若各自重读同一批文件,再省一遍。fork-first 下孩子首步就是命中。
**风险**:孩子的任务若插在序言前面,一字节不同就全部未命中——插件要把"序言在前、任务在后"变成不可违反的约束;fork 会把父对话里
无关的东西带给孩子,要允许按轮截断。
**A/B**:一个 workflow 扇出 20 个孩子读同一份 20K 规格:spawn + 内联说明 vs 共享序言 vs fork;看 usage 里的命中 token 与总价。

## 二、缓存稳定的工作区序言(workspace prelude,跨会话与跨孩子的冷启动)

**机制**。缓存服务端保存数小时到数天,和进程无关:同一仓库里今天开的每个会话、每个孩子,只要开头字节相同就命中。
dsh-agent-instructions 已经把 AGENTS.md 放进系统提示(稳定,已享受这一点);但仓库地图、关键文件内容没有人放进稳定前缀,
模型每个会话开头都去 `ls`、`cat README`、`find`(我们 20 次同日运行里平均 1.5 步探索),而按需的代码索引工具(codegraph)每次
都是新字节。
**没人做**:精选列表与搜索里没有"session-start 稳定序言"类插件;codegraph/repo-analyzer 是查询工具。
**做什么**:一个系统提示节(或首条注入上下文):确定性的仓库地图(目录树、入口文件、构建/测试命令、最近改动文件列表)+ 可配置的
关键文件全文;字节稳定(固定排序、不带时间戳),只在 git HEAD/树哈希变化时重生成(失效即换一份新缓存);大小有上限。用到的缝:
`ctx.systemPrompt.section`(order 靠前)、`dsh-agent-instructions` 的同类机制、`fs` 读文件、`session/event`。
**算账**。每个会话开头:序言 10–20K token,未命中 $0.0022–0.0044,命中 $0.0001;加上少走 1–2 步探索(每步输出 + 未命中 ≈ $0.001–
0.002)。单会话省 $0.003–0.008,不大,但**每个会话都省**,且与第一条叠加:所有孩子共享同一份。更重要的是质量:模型一开局就知道
仓库在哪、怎么跑测试。
**风险**:序言一旦被某个插件改写(比如插入当前时间)就全部作废——需要 cache-coach 那类观察来守;大仓库要选文件;仓库变动频繁时
命中率下降但不会更差于现状。
**A/B**:同一仓库连开 10 个会话做小任务,有/无序言,比首轮 `prompt_cache_hit_tokens`、探索步数、总价。

## 三、扇出成本治理:按孩子计量、按扇出设预算、按血缘归因(fan-out cost governance)

**机制**。这是维护者自己列在 deferred 里的:workflow"没有跨孩子的 token 预算词汇",jobs/subagent 也没有;现有的 dsh-cost-meter、
dsh-budget-guard 都是按会话或按天封顶,看不见一个 workflow 或一棵子代理树花了多少。而 DeepSeek 便宜带来的用法正是大扇出
(dsh-swarm 的 100+ 并发代理),一次失控的扇出能在几分钟里烧掉一天的预算;在高峰 7 小时里价格还翻倍。
**没人做**:精选列表 (d) 类零命中;GitHub 只有 dsh-preset-flash-director ★1 提到"delegation budget"(预设,不是计量插件)。
**做什么**:(1)用 `ctx.tokenMeter` 与 usage 事件按孩子会话计量,沿 lineage 汇总成树;(2)每次扇出的预算(token 或 $,含峰谷价),
超限时按策略处理:停止新孩子、让在跑的孩子收尾(`agent/turn-stopping`)、或降为 flash;(3)报表:每个孩子的未命中/命中/输出与占比,
指出最贵的分支;(4)可选:高峰时段把非紧急扇出排到谷时(`schedule`)。用到的缝:`session/event` 的 usage、subagent 的 lineage、
workflow 引擎、`agent/request`、`schedule`。
**算账**。它不省"正常"的钱,省的是事故:一个 50 孩子、每孩子 30 步、每步 60K 上下文的扇出,即便全部命中也是 90M 命中 token
($0.63)+ 输出;若其中一半孩子因为序言不对齐而未命中,就是 $0.2 → $6.6。有治理才敢开大扇出。
**风险**:预算杀进程会留下半成品,要和 checkpoint/续跑配合;按孩子归因依赖 lineage 事件完整。
**A/B**:同一 workflow 在有/无预算下跑一次故意失控的扇出(孩子无限重试),比总价与是否被截住。

## 候选但没选的

- 未改动文件的 read 指针(用 fs-observation 的已观察记录):离线估计真正内容相同的重复读很少(s10 的 70 次重复读是内容在变),收益小。
- 遮蔽优先的压缩(Complexity Trap):前缀缓存下中途遮蔽同样要改写前缀;dsh-cache-aware-compaction 已在冷热判断上做了有测量的工作。
- 紧凑编辑工具(patch/hashline):已有两个雏形;在 effort low 下编辑载荷只占输出的一部分,推理仍是大头。
- 按步降档/路由:已有成熟插件,且按步降档不改变上下文结构,不是这条线的事。
