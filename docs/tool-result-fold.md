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
| l1 链式迁移(830K 字符工具输出) | effort low、fs 工具、meta 步顶 | 0.135 | <!--l1--> | 0.024–0.028 |
| s13 压缩失忆(9K 字符 blob ×8) | 历史条件 | 0.028–0.030(历史 default) | <!--s13--> | 0.0195 |
| s2 任务图(编码) | 历史条件 | 0.081 / 0.082(历史) | <!--s2--> | 中位 0.085 |

<!--FOLD-VERDICT-->

契约测试:`tests/fold-plugin.spec.ts`(挂真实原生 loop + 请求重建不变量)。
