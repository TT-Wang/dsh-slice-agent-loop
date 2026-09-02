# slice + 轮内折叠 vs 历史 default:多轮 s 系列、CB20、l1/l2

> 2026-09-03 凌晨 · deepseek-harness-a4 · deepseek-v4-flash · 提交 `0898eae` 起轮内折叠是 slice 默认
> 对照臂不重跑:default(stock transcript loop)用 2026-08 的历史会话(`~/.dsh/sessions` 里的
> h2h 日志,`scripts/h2h-sessions.py` 重算用量)与 CB20 历史账本,全部按同一价目表重定价
> (flash 谷时:miss $0.22/M · hit $0.007/M · out $0.66/M)。

## 条件对齐

历史 default 臂在 web profile 宿主上跑:不注入 effort(适配器出厂档 = high)、每轮无步数顶、
完整工具栈(read/write/edit + grep/glob + bash)。本次 slice+折叠臂用 `run-scenario.mts`
`--effort inherit --max-steps 250 --tools full` 对齐这三点(`--effort inherit` 走同一条
"适配器出厂档"路径,已核对 llm-deepseek 适配器:未设默认即 HIGH)。
先前一轮用产品默认(effort low、场景 meta 的 12–14 步顶)跑出的结果归档在
`results/20260902-multiturn/low-capped/`,不可与历史比:s1 第一轮就撞 12 步顶。

差异仍存:本次 in-process 宿主的系统提示没有 web profile 的宿主段;单次运行,推理量波动 ±30%。

## 多轮 s 系列(slice+折叠 单次 vs 历史 default 均值)

| 场景 | default 历史 | $ | 步 | out | slice+折叠 | $ | 步 | out | Δ$ | 折叠 |
|---|---|---|---|---|---|---|---|---|---|---|
| s1 长程调试(6 轮) | ✓ n=2 | 0.0908 | 61 | 89K | ✓ | 0.0666 | 51 | 77K | **−27%** | 0 |
| s2 任务图(10 轮) | ✓ n=2 | 0.0812 | 73 | 74K | ✓ | 0.0675 | 63 | 72K | **−17%** | 0 |
| s3 区间代数(10 轮) | ✓ n=2 | 0.0506 | 46 | 52K | ✓ | 0.0921 | 71 | 106K | **+82%** | 0 |
| s4 多文件重构(8 轮) | ✗ 补跑 transcript 同条件,同一项失败 | 0.1725 | 100 | 152K | ✗ 未删旧扁平模块 | 0.1670 | 91 | 193K | −3% | 8×(13K→4K) |
| s5 常驻约束(9 轮) | 无基线 | | | | ✓ | 0.0895 | 57 | 100K | | 0 |
| s6 按引用回退(8 轮) | 无基线 | | | | ✓ | 0.1143 | 84 | 120K | | 11×(39K→9K) |
| s13 失忆(16 轮) | ✓ n=1 | 0.0296 | 53 | 12K | ✓ | 0.0221 | 64 | 14K | **−25%** | 0 |
| s14b 召回阶梯(17 轮) | ✓ n=2 | 0.0314 | 63 | 11K | ✓ | 0.0318 | 75 | 25K | +1% | 0 |
| s10 洪水(76 轮) | ✗ 压缩丢 3 条事实 n=1 | 0.2498 | 237 | 33K | ✗ QUIZ-A build id 丢 | 0.1648 | 258 | 58K | −34% | 0 |

s10 的 default 只取 08-24 那次(压缩真正生效的有效轮,README 勘误);s14b 取 08-12 与 08-26 r1
(08-31 的三次是 reasoning-ab 变体)。

**读法**:
- 编码组(s1/s2/s3)全对,但成本方向不一:s1/s2 省 17–27%,s3 贵 82%——输出 106K 对 52K,
  推理 84K。这和 8 月的结论一致:**编码任务上 slice 的税在输出侧**(每轮重建种子后模型重新
  推敲),折叠在代码文件上是空操作(源代码不折,见下),帮不上。
- 记忆组(s13/s14b)全对且持平或更省;峰值 11–15K 对 default 的 59K。
- s10 两臂都失败,失败方式不同:default 是压缩丢事实,slice 是跨轮不带工具输出、模型召回
  没找回(recall_search 默认排除 tool_output,它调了两次没加类别)。历史上 slice 曾在 s10
  零丢失,本次没有——单次运行,不能下结论。
- s4/s5/s6 没有历史 default;s4 两次(low 限步、high 无顶)都在同一项失败(没删旧模块)。
  补跑一格 transcript(同条件)也在同一项失败,峰值 185K、$0.172——是场景/模型的问题,
  不是 loop 的问题;两臂成本持平。

## CB20(19 题配对;历史 default 有 1 题 20 分钟超时)

| | slice+折叠 | default(08-12 历史) |
|---|---|---|
| 完赛 | **20/20** | 19/20 |
| fileRecall / spanRecall | 0.749 / **0.803** | **0.761** / 0.772 |
| filePrecision / 宏 F1 | 0.222 / **0.332** | 0.229 / 0.323 |
| 平均步数 | **34** | 40 |
| 总价(19 题) | **$0.482** | $0.541 |
| miss / hit / out | **516K** / 20.3M / 344K | 963K / 18.4M / **304K** |
| 逐题 F1 胜/负/平 | 9 / 8 / 2 | |
| 逐题更便宜 | 11 / 19 | |

召回在噪声内持平(file −1.2pp、span +3.1pp),便宜 11%;未命中字节少 46%,是 slice 的
每轮种子 + 折叠共同作用(CB20 单轮,折叠贡献不能单独分离);输出多 13%。
runner:`scripts/cb20-dsh.mjs`,是旧 `cb50-dsh.mjs` 的 a4 移植(cookie 认证、typert
`/api/session/create|prompt` 端点、磁盘会话日志轮询),评分函数逐字沿用,提示词相同。
宿主:`~/.dsh/profiles/slice-fold`(链接到本分支 lib/,`defaultReasoningEffort: inherit`,
`maxStepsPerTurn: 250`,端口 3117),20 题串行,每题 20 分钟上限,无超时。

## l1 / l2(单轮重载荷,产品默认:effort low、150 步顶、仅 fs 工具;与既有各臂同条件)

| 场景 | transcript | 旧 slice(无折叠) | stream v3.2(3 次均值) | slice+折叠 |
|---|---|---|---|---|
| l1 | ✓ $0.135 | ✓ $0.142 | ✓ $0.028 | ✓ **$0.024** |
| l2 | ✓ $0.124 | ✓ $0.050 | ✓ $0.0285 | **✗ 0/45** $0.038 |

l2 的失败是第三次同一模式:没有宪法逐条复述规则时,模型把 `ledger/` 当根目录,45 个
posting 全写到 `ledger/postings/`(no-rules 消融、惰性提取试验、本次)。有早期宪法的
四次全对。另外本次 92 次读里 89 次是 offset/limit 分页——`<fold>` 说明没有像 stream v3.1
那样把它拉回整读,单次差异。**l2 这类"规则文档 + 长链"的任务要 `mode: 'stream'`。**

## 源代码不折(本次新增的守卫)

低 effort 复验时 store.py(Python)被折 3 次,模型对着残缺函数体编辑把 delete 方法编没了。
折叠现在按扩展名(py/ts/js/go/rs/c/cpp/java/rb/sh/sql……)与内容密度(代码特征行 ≥ 15%)
跳过源代码;结构行占比 ≥ 80% 的文件(配置、数据表)不设块上限。代价:编码场景折叠基本
为零(表里 s1/s2/s3/s13/s14b/s10 折叠 0 次),收益只在日志/档案型读取(s6、l1)。

## 结论

1. **slice+折叠 = slice 的跨轮折叠 + 轮内折叠。** 轮内折叠只在"大而杂"的工具结果上起作用
   (l1:830K → 46K 字符),源代码和小文件上是空操作。多轮编码场景的成本差异来自 slice
   本身(种子重建 vs 历史累积),与折叠无关。
2. **对 default 的成本优势取决于任务形状**:长会话记忆/洪水型省 25–34%,链式长任务省 80%+,
   编码型 −27% 到 +82% 不等(输出税)。CB20 检索省 11%、召回持平、完赛 20/20。
3. **正确性上 slice+折叠不是万能替代**:s4 两次失败、s10 失败、l2 失败(需要宪法)。
   评估里能用的对照只有历史数据,单次运行的噪声足以翻转 ±30% 以内的成本结论。

## 复算
`python3 scripts/h2h-sessions.py --arm default --json > results/20260902-multiturn/old-default/h2h-default.json`
`python3 scripts/mt-report.py results/20260902-multiturn results/20260902-multiturn/old-default/h2h-default.json`
`results/20260902-cb20/summary.json`(配对汇总)、`cb20-slice-fold.json`(逐题)、
`cb20-default-flash-20260812.json`(历史)。
