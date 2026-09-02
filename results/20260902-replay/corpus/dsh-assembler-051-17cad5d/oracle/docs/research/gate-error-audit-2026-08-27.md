# 报错过堂判决书(阶段 2 第一件事,2026-08-27)

> 独立审计官按宪法第二条(报错即界面)+ 第七条(不许静默)对全仓闸报错逐个过堂。
> src 五文件 + scripts 八文件全读,catch 点位 70+ 逐一过目。只审未改;执刀见后续提交。
>
> **执刀核对记(2026-09-01,rustc 对标复查)**:三刀与大部分中轻伤已由后续提交执毕,
> 术后标记在码内可 grep(`过堂刀`):刀1=scaffold.ts:660(未知路由判 FAIL+四路由枚举);
> 刀2①②③=orchestrated-tools.ts:806/860/768 + index.ts:593(快照失实/无脸无声/缺书拒印
> 全部改诚实出声);刀3=index.ts:276 + orchestrated-tools.ts:1716(「不存在」族带现有
> 清单+近邻候选)。中轻伤抽查同绿:submit_part 文案(2172)、headless SKIPPED 给
> `dsh --profile web` 活路(1037/1401/1451)、federate 剔除名单随目录出声(index.ts:1124)、
> listTools 报真错(2159)、npm view 带 stderr+改法(index-add:281)、verify_trigger 缺参
> 逐个点名(1517)。**新增入账**:0.9 共享 wire 客户端(src/wire.ts)的报错按同一标准
> 成文——鉴权拿不到给两条实名命令、401 给缓存删除路径、开流超时给自查三问。

## 统计

- **总闸 100 族(133+ 点位);三问全格 87 族(87%)**。
- 三问不合格分布:①只读改不动 9 族 / ②候选缺席 6 族 / ③死胡同静默 2 族(另闸外静默 9 处)。
- **病理分布**:2026-08 新造的核心机械闸(照抄闸/死知识闸/草图闸五 why/检索门/
  骨架锁门/缺必填参数/冒烟门/lock-check)几乎全格——第二条在新码里已是活法;
  不合格集中在**老边角前置检查**、**「不存在」族候选缺席**(数据在手边没伸手)、
  **降级路径声到错耳朵**(host console ≠ agent 界面)。
- 第七条的真问题不在 catch{} 数量,在**三处结果台账失实**(快照假宣称/前端静默/
  知识包静默)。

## 终判三刀(重伤)

1. **scaffold.ts:596 未知路由静默放行**——route 拼错/编造的动作记一行「标注留档」
   后照常计 PASS,"声明即得分"从 route 字段复辟。修法:未知路由 = 行为考 FAIL,
   报错给四路由枚举(考官自身实现的真实词表);顺修 face 支 PRESET_ID 空时的
   畸形报文。
2. **emit_preset 结果三处失实/无声**(同一 execute,一次治平):
   - 快照 cpSync 失败仅进 console,结果行仍按快照前布尔宣称「已存快照」——
     **声与事实相反**,最坏形态;
   - 前端发射失败仅 console,agent 不知道自己交付了一台没脸的 preset;
   - 知识包 docs 目录缺失静默 continue——发射"成功"、kb/ 空、BOM 无记录;
     死知识闸只查"有没有手",没人查"有没有书"。修法:skipped 非空**拒印**
     (与死知识闸同性质的物理缺件)。
3. **「preset 不存在」族(5 处)+ id 全灭闸候选缺席**——readdirSync 现有 preset
   清单与 byNorm 归一表都是现成数据;造 presetIdHint 小件五处共用;id 全灭闸
   还是英文+陈名 assemble+反问句。

## 中轻伤清单(执刀序)

- submit_part 登记降级死胡同:「可手工 register」指向沙箱够不着的 CLI,且工件
  已落盘、重调同 id 被"已存在闸"拒——改诚实分工报文 + 幂等补登记分支;
- headless SKIPPED 族(4 处)不给活路——补「dsh --profile web」句式(auto 闸现成);
- 服务脸不可达族(verify_trigger + scaffold 行为考)问句不是修法——给 read_preset
  核 BOM 的实名命令与零件 id;
- verify_trigger 四参合并闸不点名缺哪个;
- 记分板/verify 台账/last-verify 写失败无声或声不到界面;parts.lock 读失败静默降级;
- federate 剔除不可达服务器仅 console——search_catalog 零命中被教导「如实进
  missing」,而真相可能是"零件在、此刻拉不起"→ 假缺口。零命中应附剔除名单;
- 小病:pagesDir 三合一报错、assemble: 陈名两处、npm view 吞 stderr、
  「listTools 为空」四字、路由 offense 括号笔误、推导失败不提草图绕行、
  lock 缺 scaffold 字段不给修法、emit_app 危险目标只说拒不说去哪。

## 判「可静默」留档(12 处,理由过堂通过)

progressAppend/jobs 叙事通道、范例相似度取证、tryReconcileOne(结果有声)、
服务脸探活(后续判定接手)、session.cancel 尽力掐、非 JSON 帧过滤、轮询暂不可达、
包 meta 可选、台账损坏=重探自愈、非本地路径缓存键、考卷 YAML 坏(behavior 考接手)、
上游 clone 失败(工单有声)。

## 模范闸名录(后续新闸照抄的范本)

死知识闸(候选现场取自 canReadKb 结构推定)· 双前端闸 · 同名异概念闸(三选一)·
大载荷闸(指认 LLM 物理极限+夹具改法)· 草图闸五 why · 凭证 SKIPPED(env 实名)·
验中版本钉 · 照抄闸 · 检索门(逐题逐标记点名,拦下不留半成品)· emit_app 缺必填
参数(逐个列缺参+描述+example,全取自 scaffold.yml 真实声明)· 骨架锁门 ·
构建门(证据=编译器原文)· writeYaml 拒写(自认 bug+保证无副作用)· lock-check
(逐条违例行+完整再生命令)· auto 前置(headless 族该抄的句式)。
