# slice + 轮内折叠 vs 历史 default:多轮 s 系列、CB20、l1/l2

> 2026-09-03 · deepseek-harness-a4 · deepseek-v4-flash · 提交 `0898eae` 起轮内折叠是 slice 默认
> 对照臂不重跑:default(stock transcript loop)用 2026-08 的历史会话(`~/.dsh/sessions` 里的
> h2h 日志,`scripts/h2h-sessions.py` 重算用量)与 CB20 历史账本,全部按同一价目表重定价
> (flash 谷时:miss $0.22/M · hit $0.007/M · out $0.66/M)。

## 条件对齐与环境体检

历史 default 臂在 web profile 宿主上跑:不注入 effort(适配器出厂档 = high)、每轮无步数顶、
完整工具栈(read/write/edit + grep/glob + bash)。本次 slice+折叠臂用 `run-scenario.mts`
`--effort inherit --max-steps 250 --tools full` 对齐这三点。每格账本记录**实际生效**的环境
(从请求头读 effort、注册表读工具清单):`resolved=high · maxStepsPerTurn=250 ·
tools=[read,write,edit,glob,grep,bash,recall_turn,recall_search,recall_step]`。

两次作废的教训:① 第一轮用产品默认(low、meta 的 12–14 步顶)跑,s1 第一轮就撞顶,与历史不可比;
② 第二轮 runner 挂的是 `subprocess` 抽象基类而不是 `subprocess-local`,bash 在所有格子里实际不可用
(`this.ctx.subprocess.spawn is not a function`),s10 的"build id 丢失"就是脚本没跑成。之后加了
探针场景 `z0_env_smoke`(六种工具在两臂各真实执行一遍、verify 判定)作为每次批次前的体检。
作废账本存 `results/20260902-multiturn/{low-capped,bash-broken}/`。

## 多轮 s 系列(slice+折叠 单次 vs 历史 default 均值)

| 场景 | default | $ | 步 | out | slice+折叠 | $ | 步 | out | Δ$ | 折叠 |
|---|---|---|---|---|---|---|---|---|---|---|
| s1 长程调试(6 轮) | ✓ n=2 | 0.0908 | 61 | 89K | ✓ | 0.0679 | 52 | 82K | **−25%** | 0 |
| s2 任务图(10 轮) | ✓ n=2 | 0.0812 | 73 | 74K | ✓ | 0.1200 | 108 | 129K | **+48%** | 0 |
| s3 区间代数(10 轮) | ✓ n=2 | 0.0506 | 46 | 52K | ✓ | 0.0813 | 64 | 90K | **+61%** | 1 |
| s4 多文件重构(8 轮) | ✓ 同条件补跑 transcript | 0.1430 | 119 | 109K | ✓ | 0.1252 | 87 | 139K | **−12%** | 2 |
| s5 常驻约束(9 轮) | 无基线 | | | | ✓ | 0.1178 | 96 | 128K | | 1 |
| s6 按引用回退(8 轮) | 无基线 | | | | ✓ | 0.1589 | 125 | 160K | | 3 |
| s13 失忆(16 轮) | ✓ n=1 | 0.0296 | 53 | 12K | ✓ | 0.0208 | 62 | 13K | **−30%** | 0 |
| s14b 召回阶梯(17 轮) | ✓ n=2 | 0.0314 | 63 | 11K | ✓ | 0.0249 | 64 | 18K | **−21%** | 0 |
| s10 洪水(76 轮) | **✗** 压缩丢 3 条事实 n=1 | 0.2498 | 237 | 33K | **✓ 零丢失** | 0.1573 | 276 | 45K | **−37%** | 0 |

s10 的 default 只取 08-24 那次(压缩真正生效的有效轮,README 勘误);s14b 取 08-12 与 08-26 r1;
s4 的旧"s3_multifile_refactor"是 1 轮场景,不可比,改为同条件补跑一格 transcript(峰值 139K 对 53K)。

**读法**:
- **9/9 全对**,历史 default 8/9(s10 丢事实)。
- 记忆/洪水组(s13、s14b、s10)便宜 21–37%,峰值 11–33K 对 default 的 59K–96K。
- 编码组分化:s1 −25%、s4 −12%,s2 +48%、s3 +61%。贵的两个都是输出侧:s2 输出 129K 对 74K,
  s3 90K 对 52K——每轮重建种子后模型重新推敲、重新跑测试。8 月的结论("编码任务上 slice 的税
  在输出侧")复现。折叠在这组里几乎不发生(0–3 次,都是 bash 输出),与成本差异无关。

## 三臂:加上旧 slice(无轮内折叠)的历史数据

旧 slice 来源同 default:`~/.dsh/sessions` 里 8 月 h2h 的 slice 会话(`scripts/h2h-sessions.py --arm slice`),
取与 default 同批的 08-10 / 08-12 flash 运行(s10 取 08-12 零丢失轮与 08-24 schema 重写后各一次),
同一价目表。注意旧 slice 是 8 月的代码(08-24 前是 schema 重写前的版本),不是"今天的 slice 去掉折叠";
要做干净消融用 `run-scenario.mts --no-fold`。

| 场景 | default 历史 | 旧 slice 历史 | slice+折叠 | 折叠 vs 旧 slice | 步数 d/s/f | 输出 d/s/f |
|---|---|---|---|---|---|---|
| s1 | 0.0908 | 0.0742 | 0.0679 | −9% | 61/53/52 | 89K/78K/82K |
| s2 | 0.0812 | 0.0942 | 0.1200 | +27% | 73/84/108 | 74K/97K/129K |
| s3 | 0.0506 | 0.0870 | 0.0813 | −7% | 46/76/64 | 52K/95K/90K |
| s13 | 0.0296 | 0.0255 | 0.0208 | −19% | 53/60/62 | 12K/12K/13K |
| s14b | 0.0314 | 0.0292 | 0.0249 | −15% | 63/58/64 | 11K/16K/18K |
| s10 | 0.2498 ✗ | 0.1642 ✓ | 0.1573 ✓ | −4% | 237/255/276 | 33K/42K/45K |

三臂判卷:旧 slice 六个全对(README 记录),slice+折叠六个全对,default 五个(s10 丢事实)。
折叠相对旧 slice 在 5/6 个场景便宜 4–19%,s2 贵 27%(步数 108 对 84,单次波动);编码组的
输出税(s2/s3 相对 default 贵)在旧 slice 上同样存在,是 slice 本身的性质。

CB20 三臂(19 题配对):

| | default 历史 | 旧 slice 历史 | slice+折叠 |
|---|---|---|---|
| fileRecall / spanRecall | 0.761 / 0.772 | **0.816 / 0.847** | 0.749 / 0.803 |
| 精度 / 宏 F1 | 0.229 / 0.323 | 0.227 / **0.342** | 0.222 / 0.332 |
| 平均步数 | 40 | 40 | **34** |
| 总价 | $0.541 | $0.602 | **$0.482** |
| miss / hit / out | 963K / 18.4M / 304K | 767K / 29.8M / 340K | **516K** / 20.3M / 344K |

折叠比旧 slice 便宜 20%(未命中少 33%、命中少 32%——上下文里的字节少了),召回低 4–7pp。
CB20 的检索任务里被折掉的正是模型"顺手读到"的内容,召回下降与此相符;但 8 月与今天的
kernel 与宿主也不同,单独归因不了。

l1/l2 三臂(产品默认条件):default $0.135 / $0.124,旧 slice $0.142 / $0.050(v2 批次,无折叠),
slice+折叠 $0.024–0.031 / $0.030——链式长任务上折叠是决定性的。

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
`maxStepsPerTurn: 250`,端口 3117),web profile 自带 subprocess-local,bash 正常。

## l1 / l2(单轮重载荷,产品默认:effort low、150 步顶、仅 fs 工具;与既有各臂同条件)

| 场景 | transcript | 旧 slice(无折叠) | stream v3.2(3 次均值) | slice+折叠 |
|---|---|---|---|---|
| l1 | ✓ $0.135 | ✓ $0.142 | ✓ $0.028 | ✓ **$0.024** |
| l2 | ✓ $0.124 | ✓ $0.050 | ✓ $0.0285 | **✗ 0/45** $0.038 |

l2 的失败是第三次同一模式:没有宪法逐条复述规则时,模型把 `ledger/` 当根目录,45 个
posting 全写到 `ledger/postings/`(no-rules 消融、惰性提取试验、本次)。有早期宪法的
四次全对。**l2 这类"规则文档 + 长链"的任务要 `mode: 'stream'`。**

## 折叠的适用边界

源代码不折(按扩展名与代码特征密度);grep/glob 结果不折;文件读取按文档折(头尾 + 结构行,
结构块按键新颖性自适应);命令输出按内容判:日志走错误优先。规则细节与借鉴来源见
`docs/fold-content-routing.md`。在编码型多轮场景里折叠基本不发生,收益只在日志/档案型读取
(l1:830K → 46K 字符)。

## 结论

1. **正确性**:slice+折叠 9/9 多轮 + CB20 20/20 完赛 + l1;唯一失败是 l2(需要 stream 的宪法)。
   历史 default 在 s10 上丢事实。折叠没有造成任何一次失败(两次疑似都是 runner 故障或代码折叠,
   后者已用"源代码不折"堵住)。
2. **成本取决于任务形状**:长会话记忆/洪水型便宜 21–37%,链式长任务便宜 80% 以上,检索便宜 11%,
   编码型从 −25% 到 +61%(输出税:每轮重建种子后重新推敲)。
3. **单次运行噪声 ±30%**;评估里能用的对照只有历史数据。要下更强的结论需要每格三次。

## 复算
`python3 scripts/h2h-sessions.py --arm default --json > results/20260902-multiturn/old-default/h2h-default.json`
`python3 scripts/mt-report.py results/20260902-multiturn results/20260902-multiturn/old-default/h2h-default.json`
`results/20260902-cb20/summary.json`(配对汇总)、`cb20-slice-fold.json`(逐题)、`cb20-default-flash-20260812.json`(历史)。
