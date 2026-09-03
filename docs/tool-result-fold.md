# tool-result-fold:给 dsh 原生 transcript loop 加轮内折叠

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

## 评测

| 场景 | 条件 | transcript | transcript + fold | slice(参考) |
|---|---|---|---|---|
| l1 链式迁移(830K 字符工具输出) | effort low、fs 工具、meta 步顶 | 0.135 | **0.023**(✓ 45/45;46 次折叠,817K→54K 字符;峰值 43K 对 331K) | 0.024–0.028 |
| s13 压缩失忆(9K 字符 blob ×8) | 历史条件 | **0.0169**(同日原生 loop;历史 default 0.028–0.030 是另一套 kernel,不可比) | 0.0196(未截超长行,一次没折)/ 0.0226(超长行截断后:9 次折叠 43K→20K 字符,miss 19.8K 最低,但输出 16K 对 7.8K,噪声) | 0.0195 |
| s2 任务图(编码) | 历史条件 | 0.081 / 0.082(历史)/ **0.071**(同日原生 loop,68 步) | 0.087(一次没折:编码型没有可折的结果;81 步,推理 43K) | 中位 0.085 |

**裁决**:

- **重工具输出的任务上是净收益**:l1 从 0.135 降到 0.023(−83%),45/45 全对,峰值上下文 43K 对 331K;比 slice 自己的
  0.024–0.036 还低,因为没有磁带重建的那份税。
- **没有可折内容的任务上是中性的**:s2 一次都没折(编码型:源码、grep、短测试输出都不折),0.087 对同日原生 0.071
  是 81 步对 68 步的运行噪声;两臂此时的唯一差别是系统提示词里的 `<fold>` 说明和多出来的 `expand_result` 工具。
  s13 三次 0.017 / 0.020 / 0.023 也在噪声内,那里折叠只省了约 5K 未命中 token。
- **正确性**:五个评测全部通过,没有一次需要 `expand_result` 取回原文。
- **同日原生 transcript 在 s2 上 $0.071,比新默认 slice 的中位 0.085 还便宜**,和前面的判断一致:短编码会话用 transcript。

所以产品形态可以定为:**默认 = 原生 transcript + 本插件**;slice 的磁带留给长会话与重工具输出——而 l1 这个
最典型的重工具输出场景,折叠本身已经拿到了 slice 几乎全部的收益。剩下需要磁带的只有"transcript 撑到要压缩"
的长会话(s10 那类),那是下一步"先 transcript、磁带在影子里等着"方案的事。

发现并修的一个盲区:折叠按行判,s13 的 9K 字符 blob 只有 3 行,原样通过;现在 data 类超过 1500 字符的单行按
字符头尾截断(`maxLineChars`,压缩 JSON / base64 / 长 CSV 行同理),代码、grep、日志不受影响。

契约测试:`tests/fold-plugin.spec.ts`(挂真实原生 loop + 请求重建不变量)。
