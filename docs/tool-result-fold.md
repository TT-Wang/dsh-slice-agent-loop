# tool-result-fold:给 dsh 原生 transcript loop 加轮内折叠

> 独立仓库(正式家):https://github.com/TT-Wang/dsh-tool-result-fold — `dsh plugin add github:TT-Wang/dsh-tool-result-fold`。本仓库的 `src/fold` 是同源副本,供 runner 与契约测试用。

2026-09-03 夜。一天的磁带实验之后的结论是:短会话里最简单的 transcript 最便宜,slice 赢在长会话与
重工具输出;而全天最干净的收益是**轮内折叠**——l1 那 80% 全靠它,不依赖磁带。于是把折叠从 slice
里拆出来,做成一个能直接挂在默认 loop 上的独立插件。

## 机制

- 每步开始前(`agent/pre-step`)扫描上一步落盘的工具结果;按内容路由折叠(复用 `src/slice/result-digest.ts`:
  源代码与 grep/glob 不折,日志错误优先,文档/数据留头尾与结构行,小结果不折,折了不省也不折)。
- 折叠视图以 **surface 替换事件** 遮蔽原节点(`tool/result` + `surfaceOp: {op:'replace'}` + `sourceEventSeqs`
  引用原 seq)——与 dsh 自带的 `compaction-tool-result-pruner` 同一机制,会话不变量明确允许。原文原样
  留在日志里;UI/回放看得到两份;模型看到的上下文只追加不改写,前缀缓存不受影响。
- `expand_result({turn, step, call})` 逐字取回原文;折叠视图首行写明这个调用。
- 系统提示词加一段 `<fold>` 可供性说明(与 slice 的 FOLD_SYSTEM_ADDENDUM 同源)。

不能用的路:在 `session/event` 回调里追加替换事件(会话禁止重入);`tools/post-execute` 替换内容
(日志里就只剩折后文本,原文丢失)。

## 挂载

```ts
import ToolResultFold from '@dsh-external/dsh-slice-agent-loop/fold'
await ctx.plugin(ToolResultFold, { digest: { minChars: 1500 } })   // 挂在原生 AgentLoop 之外,不要与 slice loop 同挂
```

runner:`--arm transcript-fold`(原生 loop + 本插件);账本 `digest` 字段记折叠次数与前后字符数。

## 评测(同日、同代码、同 runner、同条件;原生 loop 对 原生 loop + 本插件)

| 场景 | 形状 | transcript | + fold | 折叠 | 判卷 |
|---|---|---|---|---|---|
| l1 链式迁移 | 830K 字符工具输出,50 步 | 0.135 | **0.023**(−83%) | 46 次 817K→54K | 45/45 两臂 |
| l2 账本状态 | 826K 字符记录 + 3.7K 规则文档 | 0.216 | 第一次 **✗ 0/45** 0.023;加保护后 **✓ 45/45 0.024**(−89%) | 45 次 826K→59K | 见下 |
| s10 压缩丢失 | 76 轮、73 次整读 9K blob | 0.509 | 0.538(第一次;模型把 64 次折叠逐一 expand)/ 0.411(第二次:每轮只有 4 步、读都在前 2 步,`pinSteps` 让它一次没折,退避没触发;和 0.509 的差是 243 步对 302 步的噪声) | 64 次 594K→67K | 两臂全保住 |
| s13 压缩失忆 | 16 轮、8 个 9K blob | 0.017 | 0.020 / 0.023 | 0 / 9 次 | 两臂全保住 |
| s14b 回忆阶梯 | 17 轮 | 0.020 | 0.030(0 次折叠,65 步对 59 步) | 0 | 两臂全保住 |
| s15b 工具结果失忆 | 17 轮 | 0.023 | 0.022 | 0 | 两臂 24/24 |
| s15c 严格失忆 | 17 轮 | 0.050 | 0.052 | 0 | 两臂 24/24 |
| n1 / n2 / n3 | 记忆型 | 0.016 / 0.015 / 0.021 | 0.018 / 0.016 / 0.021 | 0 | 全通过 |
| s2 任务图 | 10 轮编码 | 0.071 | 0.087(0 次折叠,81 步对 68 步) | 0 | 两臂通过 |

**结论**:有大块可折内容的任务(l1、l2)省 80–90%;没有可折内容的任务(编码、短记忆型)一次都不折,差异是运行噪声,
唯一系统性差别是系统提示词里多一段 `<fold>` 和多一个工具。**折叠不是 100% 净收益**,两个场景暴露了它的两种失效:

1. **折掉了规则**(l2 第一次):3.7K 的 LEDGER_RULES.md 被按行折掉 R1–R9 整段,45 个 posting 全写错目录。对策:data 类
   起折阈值 1500 → 6000 字符(小文档折了省不到几个 token 却可能丢规则);`R1 path:` 这类带空格/斜杠的键算结构行;
   **每轮前 2 步的结果不折**(`pinSteps`,规则和说明几乎总在开头被读)。加保护后 45/45。
2. **折了模型偏要看的东西**(s10 第一次):任务要的就是 blob 中段,模型对 64 次折叠逐一 `expand_result`,上下文里视图和
   原文各一份,比不折还贵 6%。对策:**展开退避**——同一工具的折叠被取回 2 次且取回率过半,本会话不再折它(契约测试覆盖;
   s10 复跑时因为每轮的读都落在被钉住的前 2 步,根本没折,退避没有机会触发)。附带的观察:`pinSteps: 2` 在"每轮读一样东西"
   的短轮形状上等于关掉折叠,这类形状折叠本来也不赚;它真正起作用的是几十步的单轮长链(l1/l2)。

## Headroom 吸收清单

已吸收:ContentRouter(按内容类型分派)、LogCompressor(错误优先、上下文行、相似行去重、首末错误必留、省略标记带层级计数)、
SmartCrusher 的简化版(JSON 数组/含大数组的对象/JSONL 按元素:首 30% 尾 15%、错误元素必留、相同元素去重、标记写字段名)、
SearchCompressor(每文件配额、首末必留、`[... and N more matches in file]`)、DiffCompressor(留头、改动两侧 2 行上下文、
每文件 hunk 配额)、CCR 的"可逆 + 按需取回"(`expand_result`)、Live-zone 只压新字节、feedback hints 的思路(展开退避)。
未吸收且说明理由:CodeCompressor(AST 级代码压缩:代码残缺会让模型编错,我们选择代码不折)、Kompress ML 模型与图像压缩
(需要模型服务)、Effort Routing(按步降档,用户明确不做:不公平)、Verbosity Steering(提示词末尾的"简洁"引导,会混淆折叠
本身的对照,未采用)、CacheAligner / 代理层缓存稳定化(我们按构造只追加,不需要)。

契约测试:`tests/fold-plugin.spec.ts`(挂真实原生 loop + 请求重建不变量;含钉住前几步、展开退避)、`tests/result-digest-*.spec.ts`。
账本:`results/20260903-fold/`、`results/20260903-fold-ab/`。
