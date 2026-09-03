# 轮内折叠的内容路由(2026-09-03,借鉴 Headroom)

> 来源:headroomlabs-ai/headroom(Apache-2.0,Rust 核心 + Python)。读的是它的源码:
> `crates/headroom-core/src/transforms/{live_zone,log_compressor,anchor_selector,adaptive_sizer,content_detector}.rs`、
> `ccr/mod.rs`、`headroom/config.py`。实现:`src/slice/result-digest.ts`(`digestToolResult`)。

## 抄了什么

| Headroom | 我们的实现 | 备注 |
|---|---|---|
| 只压"活区"(最新一条用户消息里的块),冻结前缀字节不变 | 注入时折叠,轨迹只追加 | 早已一致;它从 Anthropic KV cache 推出来,我们从 DeepSeek 价目表推出来 |
| ContentRouter:正则检测内容类型再分派 | `detectContentKind`:code / search / log / data | 文件读取一律按文档(data)处理,只有命令输出才按内容判 log/search——文件里夹着的部署日志不改变它是文档 |
| `DEFAULT_EXCLUDE_TOOLS` 排除 Read/Glob/Grep/Write/Edit | grep/glob/recall_* 不折;源代码不折 | 数据型文件的 read 仍然折(l1/l2 的收益来源);Headroom 连 Read 都不折,理由是 Edit 的 old_string 要精确字节——我们只在源代码上照做 |
| LogCompressor:逐行分级,错误取首/末/前 10,前后 3 行上下文,栈帧整段,摘要行,相似行去重保留消息前缀 | `digestLog`:同规则(`logMaxErrors 10`、`logContextLines 3`、头 3 尾 6、去重键 = 前缀 + 归一化数字/十六进制/路径) | 512 字节起折(Headroom 各类型阈值都是 512 B) |
| anchor_selector + adaptive_sizer:位置锚点、去重、按信息饱和拐点定保留数 | 结构块按"键的新颖性"自适应:每块至少 3 行,其后只留键没出现过的行,上限 12 | 简化版:同形附录块(l2 的四个 `[prior-reconciliation]`)第二次起只剩前 3 行 |
| tokenizer 校验门:压后不小于原文就回退 | `maxKeepRatio 0.55` 守卫 | 早已一致 |
| CCR:`<<ccr:HASH,KIND,SIZE>>` 标记 + `headroom_retrieve(hash)`,SQLite 存原文,TTL 30 分钟 | 视图头行 `recall_step(t, s) returns the full text`,原文在会话日志,永不过期 | 它还会在响应路径内联替换模型直接引用的标记;我们没有这一层 |

## 没抄的

- **Kompress(ModernBERT)对散文做 token 级删减**:有损且需要模型推理,我们不做。
- **SmartCrusher 对 JSON 数组的统计离群保留**:我们的工具输出里 JSON 数组少见;先不做。
- **Stale-read 替换 / Read maturation**(文件被编辑后把旧 Read 换成标记;大 Read 先放在缓存断点后,安静 5 轮再压进缓存):这是在 transcript 里模拟 tape 的动机;slice 在轮末本来就不带工具输出,不需要。
- **代理 / MCP 产品形态**。

## 离线效果(read 形状,`N: ` 行号前缀)

| 输入 | 之前(cap 4) | 现在 |
|---|---|---|
| l1 节点 17,556 字符 | 951 | 1,125(第一块附录全留,后续同形块只留 3 行) |
| l2 记录 17,897 字符 | 1,284 | 1,305 |
| 166 行测试日志 6,961 字符(中段插入 FAIL + 断言 + 栈) | 头尾规则会折掉 FAIL | 579,FAIL/断言/栈帧/末尾摘要全留 |

## 复验(合并后,`results/20260903-fold-routing/`)

| 场景 | 条件 | 结果 | 成本 | 折叠 |
|---|---|---|---|---|
| l1 ×3 | 产品默认(low、fs) | 44/45、45/45、45/45 | $0.031 / $0.029 / $0.025 | 44×(798K→51K 字符) |
| l2 | 产品默认 | 45/45 | $0.030 | 45×(813K→59K) |
| s6 | 历史条件(high、250 步、完整工具栈) | ✓ | $0.129(上次 $0.159) | 0 |

l1 那次 44/45 是模型在第 3 步顺手发了个无意义 edit、第 4 步跳过节点 2 没写(INDEX 里却登记了),
节点 2 的折叠视图六个字段与 next 完好——模型失误,与折叠无关;另两次全对。l2 在没有宪法的
slice 下这次通过(此前三次路径漂移),说明漂移是概率性的,不是必然;需要稳的场合仍用 stream。
