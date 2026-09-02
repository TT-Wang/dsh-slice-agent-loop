/**
 * Assemble-then-verify: after a preset is emitted, derive a probe task from
 * the requirement, run it in a REAL session bound to the new preset, and
 * judge the reply. "Vibe assembly" promises find → assemble → verify; this
 * module is the verify leg.
 *
 * The probe run drives the host's own public wire contract rather than
 * internal services: the wire is the surface a user's session actually rides,
 * and a probe that passes here passes exactly the way a user's session would.
 * 传输层在 src/wire.ts(共享客户端,BACKLOG 0.9):探协议定代际,旧 wire 走
 * 点号端点+events.mux,新 wire(0.1.2-alpha.1 起)走 cookie+斜杠端点+
 * session/follow 流;帧形状两代归一,本文件判定逻辑零改动。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { BlockAssembler, type GenerateOptions } from "@deepseek-ai/dsh-llm";
import { createUserMessage } from "@deepseek-ai/dsh-llm/message";
import type { CapabilityEntry } from "./index.js";
import { openWireSession } from "./wire.js";

/** A probe task plus its machine-checkable acceptance marks. */
export interface ProbeSpec {
  /** One-turn task the assembled agent should complete with its parts. */
  task: string;
  /**
   * Acceptance marks: ALL must appear (case-insensitive) in the agent's final
   * reply. The deriver is told to pick content-bearing marks (computed values,
   * verbatim echoes) rather than self-assertions like "done".
   */
  mustInclude: string[];
}

/**
 * One turn of a multi-turn scenario probe: a prompt plus the marks its OWN
 * reply must carry. A later turn's marks are how state continuity is tested
 * from the outside — "the invoice you filed in turn 1, what was its number?"
 * asserts persistence without inspecting the trajectory.
 */
export interface ScenarioTurn {
  prompt: string;
  mustInclude: string[];
}

/** A scenario probe: several turns in ONE session, judged turn by turn. */
export interface ScenarioSpec {
  /** What this scenario proves (one line, for the ledger). */
  goal: string;
  turns: ScenarioTurn[];
}

/** Per-turn outcome of a scenario run. */
export interface TurnResult {
  index: number;
  prompt: string;
  mustInclude: string[];
  pass: boolean;
  /** Truncated reply — the evidence this turn's verdict judged. */
  reply: string;
}

export interface ProbeResult {
  /**
   * PASS / FAIL are the probe's verdict on the assembled agent.
   *
   * The two non-verdicts are deliberately DIFFERENT statuses, because they mean
   * opposite things to whoever signs off the delivery:
   *
   * - SKIPPED — there was nothing to verify and that is by design: verification
   *   was turned off, or a required credential is unconfigured so the agent
   *   cannot reach its upstream yet. Expected, reportable, not a defect.
   * - ERRORED — the probe itself could not run: the session would not open, the
   *   preset would not mount. The agent is UNVERIFIED, which is a failure of
   *   the delivery even though the preset file exists.
   *
   * Folding the second into the first is how three unmounted agents once got
   * reported as `ok: true, failed: []`.
   */
  status: "PASS" | "FAIL" | "SKIPPED" | "ERRORED";
  /** Single-turn probe (kind: 'single'). */
  probe?: ProbeSpec;
  /** Scenario probe (kind: 'scenario'). */
  scenario?: ScenarioSpec;
  /** Which probe shape ran. */
  kind?: "single" | "scenario";
  /** Final assistant reply (truncated) — the evidence the verdict judged. */
  reply?: string;
  /** Per-turn results for a scenario run. */
  turns?: TurnResult[];
  /** Why the run degraded to SKIPPED, when it did. */
  reason?: string;
  /**
   * True when this PASS was CARRIED FORWARD from the verify ledger rather than
   * probed fresh: the preset's bytes are identical to a generation that already
   * passed, within the carry TTL. The verdict is honest — it DID run, on these
   * exact bytes — but a reader must be able to tell "probed now" from "probed
   * then", so the flag rides the result and the render says which (账本文化:
   * 沿用要明说,绝不冒充新跑)。
   */
  carried?: boolean;
  /**
   * 探针会话里被装配 agent 实际调用的工具聚合(动用率报告的数据源)。
   * 字段命名对齐 OTel GenAI 语义约定的 execute_tool / gen_ai.tool.name,将来
   * 台账可直接喂任何观测平台。注意语义边界:探针只走主流程,"未动用"是修剪
   * 线索,不是"无用"判决(短信件没动可能只是凭证没配)。
   */
  toolsUsed?: Array<{ name: string; calls: number }>;
}

/** 聚合一段会话帧里的 tool/call:name → 次数(动用率报告)。 */
function aggregateToolCalls(frames: readonly any[]): Array<{ name: string; calls: number }> {
  const counts = new Map<string, number>();
  for (const e of frames) {
    if (e?.type !== "tool/call") continue;
    const name = String(e.data?.name ?? "");
    if (name === "") continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls);
}

/**
 * 冒烟探针的每轮预算(刻意收紧;曾有过 600s 的宽预算,随 pipeline 形态删除)。
 *
 * 市场战役实测(s04 简历打分):首探让 agent 找不存在的文件,重试探针又踩空
 * 工作区,agent 不问人、只是硬试,把 600s×2 烧满(总 638s→再重试 906s)。
 * 冒烟探针是"证明这套能力活着"的最小证据,不是生产任务:一轮真 agent 干活
 * 240s 绰绰有余(战役里 PASS 的多轮场景每轮 3-48s)。收紧预算把"失控探针"
 * 从 10 分钟的黑洞变成 4 分钟内的快速判负——省下的是每个失败场景 5-15 分钟。
 * 需要更长的部署仍可用 verifyTimeoutMs 覆盖(合法长任务的逃生阀)。
 */
export const PROBE_TURN_BUDGET_MS = 240_000;

/**
 * 验收覆盖(阶段 3):一次验收最多几条探针路径(1 主 + ≤3 覆盖)。覆盖路径每题
 * 打包 2-4 件相邻零件 → 上限可覆盖 ~12 件工具零件,恰在"工具过多致准确率下滑
 * 阈值 10-15 件"的现实 preset 尺寸内。要调改常量,不进 Config——调用方不该多
 * 一个概念(AUX_CALL_TIMEOUT_MS 先例)。
 */
export const VERIFY_MAX_PATHS = 4;

/**
 * 非主路径软预算:verify 已耗墙钟超过它就不再开下一条路径(草图的与推导的一视
 * 同仁),逐件出声"未考(预算截断)"。只管"开不开下一条",绝不中断进行中的轮
 * (不替用户砍)。主路径永远跑。
 */
export const VERIFY_EXTRA_PATH_SOFT_BUDGET_MS = 480_000;

/**
 * 多路径动用并集:各路径 toolsUsed 按工具名合并求和(排序稳定)。全部输入
 * undefined(如全路径 ERRORED 无轨迹)时如实返回 undefined,不假装有证据。
 */
export function mergeToolsUsed(
  lists: Array<Array<{ name: string; calls: number }> | undefined>,
): Array<{ name: string; calls: number }> | undefined {
  const real = lists.filter((l): l is Array<{ name: string; calls: number }> => l !== undefined);
  if (real.length === 0) return undefined;
  const sum = new Map<string, number>();
  for (const l of real) for (const u of l) sum.set(u.name, (sum.get(u.name) ?? 0) + u.calls);
  return [...sum.entries()].map(([name, calls]) => ({ name, calls })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Deadline for one probe wire RPC (session.create, session.prompt).
 *
 * These are supposed to return in milliseconds: session.prompt uses mode:queue,
 * so it enqueues and returns immediately — the agent runs LATER, and sendTurn's
 * own turn-budget loop waits for that. But the `await fetch` had NO timeout, so
 * a host that accepts the socket and never answers hangs the RPC forever — and
 * because sendTurn's while-loop only starts counting AFTER fetch resolves, the
 * turn budget never even engages. Observed live: session.prompt for a scenario's
 * second turn never returned; assemble sat past its whole worst-case window with
 * a spinner. 30s is generous for an enqueue-and-ack; blowing it means the host
 * is not answering, which is an ERRORED probe, not a hung turn.
 */
export const PROBE_RPC_TIMEOUT_MS = 30_000;

/**
 * 归一化:小写 + 剔除空白与常见排版标点(间隔号/破折号/全半角括号引号等)。
 * 实测假红(reader-b):标记「第2章第2段」,agent 回复「第 2 章 · 第 2 段」——
 * 语义完全一致,排版变体让子串匹配判死,白烧一整轮 302s 重试。归一后两边
 * 都变「第2章第2段」→ 命中。
 */
function canonMark(s: string): string {
  return s.toLowerCase().replace(/[\s·・、,,。.::;;!!??“”"'‘’()()\[\]【】《》<>\-—–_/\\|*`~]+/g, "");
}

/**
 * Pure mark check: every mark present, case-insensitive. Unit-tested.
 * 双通道:先精确子串(原语义);不中再归一化子串(治排版变体假红)。归一后
 * 标记至少还剩 2 个字符才走归一通道(全标点标记归一成空串会假阳)。
 */
export function marksPresent(marks: readonly string[], reply: string): boolean {
  if (marks.length === 0) return false;
  const hay = reply.toLowerCase();
  const hayCanon = canonMark(reply);
  return marks.every((m) => {
    if (hay.includes(m.toLowerCase())) return true;
    const cm = canonMark(m);
    return cm.length >= 2 && hayCanon.includes(cm);
  });
}

/** Pure verdict for a single-turn probe. */
export function evaluateProbe(spec: ProbeSpec, reply: string): boolean {
  return marksPresent(spec.mustInclude, reply);
}

/**
 * Pure verdict for a scenario: EVERY turn must pass.
 *
 * All-or-nothing rather than a score, deliberately: a scenario is a contract
 * ("after three turns the books still add up"), and a partially honored
 * contract is a broken one. Scoring turns would also drift toward grading the
 * trajectory, which the charter forbids.
 */
export function evaluateScenario(turns: readonly TurnResult[], expected: number): boolean {
  return turns.length === expected && expected > 0 && turns.every((t) => t.pass);
}

/**
 * 探针草图范例(范例优先于规则,先例:Anthropic Tool Use Examples 72%→90%)。
 * 编排者出题(verify_preset 参数描述/emit 接力棒)与考官回退推导共用同一份——
 * s23 实测:回退推导没吃范例时出过 base64 解码怪题,把装配 agent 逼到求助判负
 * 烧掉 816s;范例在场的验收全部 18-55s。
 */
export const PROBE_SKETCH_EXAMPLES =
  'GOOD scenario sketch: {"kind":"scenario","createTask":"新建一条采购单:单号 PO-4471,供应商晨光文具,金额 862 元,备注加急","retrieveTask":"查采购单 PO-4471,报出它的供应商和金额","token":"PO-4471","marks":["晨光文具","862"]} '
  + '— the token appears in BOTH turns; the retrieve turn asks BY token without restating 晨光文具/862 (the agent must fetch them); marks are stored values, not "done". '
  + 'GOOD single sketch: {"kind":"single","task":"把这段话按句拆行并编号后存为 notes.txt,完成后报文件名与行数:今天验收通过。明天发布。","marks":["notes.txt","2"]} '
  + '— output goes to a file, so marks are the filename and a computed count, never the body text. '
  + 'LARGE FIXTURES (a real epub/csv/image): NEVER paste the payload (base64 etc.) into the task — no LLM copies 2KB of base64 byte-exactly '
  + '(measured: transcription corrupts past ~1.2K chars and burns retries). Write the fixture INTO the preset workspace as a file first, '
  + 'then reference its relative path in the task (e.g. "解析工作区 uploads/sample.epub,报出书名与第二章标题"). '
  + 'COVERAGE PATHS: verify_preset also takes {"probes": [<same shapes>]} — path [0] is the main workflow; each probes[] entry exercises parts the main path never touches (bundle 2-4 related parts per path, ≤4 paths total). Skip it and the examiner auto-derives coverage probes after the main path passes.';

/**
 * 大载荷机械闸:探针任务里出现 ≥200 连续 base64 形字符 = 有人在往指令里塞
 * 文件本体。实测(读书助手 e2e):手抄 2132 字符 base64 三轮抄错三处,烧掉
 * ~40 分钟 diff 自己的笔误——夹具走文件、任务引路径,是唯一可靠形状。
 */
export const PAYLOAD_RUN_RE = /[A-Za-z0-9+/=]{200,}/;

export function probePayloadViolation(texts: ReadonlyArray<string | undefined>): boolean {
  return texts.some((t) => t !== undefined && PAYLOAD_RUN_RE.test(t));
}

/** Shared mark-design rules — the same discipline governs single and scenario probes. */
const MARK_RULES = [
  "- mustInclude: 1-3 content-bearing strings that will appear in the reply IFF the task truly succeeded (a computed value, a verbatim token from the task input). Never accept generic words like \"done\" or \"success\".",
  "- mustInclude values MUST be derivable from data embedded in the task text itself. NEVER use remembered world facts (a domain's IP, a live exchange rate, today's date) — live data changes and remembered values go stale.",
  "- Avoid over-precise numeric marks: a mark like \"111.195\" fails when the tool legitimately prints 111.1949. Prefer a verbatim echo token, an integer, or the leading digits of a number (e.g. \"111.1\").",
  // 实测假红:需求含"要一个文件管理页面",推导器把"文件管理页面"当了标记——
  // 被判的是 agent 的回复,agent 不是页面,UI 词永远不会出现。
  "- NEVER use UI/page words from the requirement (页面/前端/界面/看板/page/UI) as marks — the agent's REPLY is judged, and the agent is not the page. Marks must be tokens the agent's own answer would naturally contain.",
  // 实测两连败(fs-reader-e2e):推导器让轮 1"读取工作区中的 book_cn.txt"——
  // 探针工作区是空的,agent 找不到文件只能问人,无人值守 = 判负。场景引用的
  // 一切材料必须由探针自己先造出来。
  "- The probe runs in an EMPTY workspace with NOBODY attending the session. NEVER reference a pre-existing file/record, and NEVER design a turn that needs a human to supply anything mid-run. Any file or data a turn uses must first be CREATED by the agent inside this same probe — e.g. turn 1: \"把以下内容写入 book.txt:<a short passage you invent inline>\", later turns then read/extend it.",
  // 市场战役 s05/s24 实测:推导器发明"本周(03-09~03-15)""2025-06-"这类日期,
  // agent 按日期查不到数据只能问人;跨轮引用只许用轮 1 造出的独特 token。
  "- NEVER invent absolute dates, date windows, or serial numbers as FACTS a later turn must match — later turns reference earlier state by the distinctive tokens turn 1 created (\"INV-7781 那一单\"), never by a date range you made up.",
  // 市场战役 s18 实测:接待类场景没喂客户资料,agent 只能问"如何称呼您"——判负。
  "- If the requirement is about serving a PERSON (customer intake, interview, tutoring), the probe prompt must EMBED that person's data inline (a name/phone/case facts you invent): the probe PLAYS the counterpart. The agent must never need to ask a real human for anything.",
  // 市场战役 s12 实测:推导出"打开看板页面验证",agent 拿浏览器访 example.com 后问人。
  "- The agent's delivered web page/frontend is NOT testable by the agent: never ask it to open/visit/check its own UI or any URL for it, and never design turns around browser tools unless the requirement is about visiting EXTERNAL sites. Test the agent's tools and persisted state directly.",
  // 市场战役 s28 实测:测"无依据时拒答",把整句话术「知识库中没有相关内容」当标记,
  // agent 换个说法(「未找到」「无法回答」)就假红。拒答/否定类无法用固定话术断言:
  // 别测拒答,改测 agent 能正确USE它有依据的内容——正向任务的标记才稳定。
  "- NEVER test a REFUSAL or a NEGATIVE ('says it cannot find / has no data / declines') with a mark: refusal wording is unbounded, so any fixed phrase mis-fails a correct refusal. Test the POSITIVE capability instead — give the agent data it CAN use and mark on the answer it must produce from that data.",
  // 市场战役 a04 实测:任务是"起草合同并存档",agent 把正文写进文件、回复只给摘要,
  // 却要求回复逐字含「苏州蓝海电子公司/50万元」——产出到文件的任务,正文不在对话里。
  "- When a turn asks the agent to WRITE its output to a file/record (draft a contract, save a report), the long content lives in the FILE, not the chat reply — do NOT mark on verbatim body text. Mark on what the reply naturally states: the saved filename, a confirmation token you gave it, or a short computed field. To verify the content itself, add a LATER turn that reads it back and reports one specific value.",
  "- Budget: the probe agent has ~10 minutes per turn, and a turn that overruns is scored FAIL. Size EVERY turn to fit, the first one included — batch-flavored requirements (score N resumes, process N files) are probed with 2-3 items MAX; 3 items proves the capability as well as 30 does. Avoid tasks whose replies embed large payloads (full base64 images) — ask for byte counts or short prefixes instead.",
];

/**
 * 标记消毒(机械闸,不指望 prompt):剔除站不住的验收标记。实测病例:代码碎片
 * "print("(s31)、单字符、纯符号。判据:长度 2-60、含至少两个相连的字母/数字/
 * 汉字、不是纯标点。消毒后为空 = 这份推导不可用(调用方回退或报错)。
 */
export function sanitizeMarks(marks: unknown[]): string[] {
  return marks
    .map((m) => String(m).trim())
    .filter((s) => s.length >= 2 && s.length <= 60)
    .filter((s) => /[\p{L}\p{N}]{2}/u.test(s))
    .slice(0, 3);
}

/** One fast-model JSON call with the deriver's provider/model discipline. */
/**
 * Deadline for one auxiliary model call in the assemble path (selection,
 * probe derivation). These calls run INSIDE the user's assemble turn: without
 * a signal, an upstream that neither answers nor closes (observed live: four
 * proxied sockets ESTABLISHED, session log frozen for 6 minutes) hangs the
 * whole turn forever — the user sees a spinner and nothing else. Generous on
 * purpose: a derivation is seconds on a healthy route, so two minutes only
 * ever fires on a genuinely broken route. 实测晚高峰 DeepSeek 官方端点 + max 档,一次选型可超 120s——用户裁定"先看得见,再谈砍":配合装配直播台,窗口放宽到 300s,悬挂仍有底。原文如下:the abort feeds the existing failure paths
 * (probe → 未能验证, selection → loud tool error) instead of a silent hang.
 */
// 用户裁定(2026-08-21):有装配直播台之后,辅助调用**不设兜底闸**——慢就看着,
// 绝不替用户砍(120s 版曾把晚高峰的正常选型误杀)。0 = 禁用;要恢复止血闸,
// 把它改回毫秒数即可,两个调用点会自动重新挂上 AbortSignal。风险如实记:
// 上游真悬挂时该调用会一直等,直播台里表现为行动链停在"选型完成"之前——
// 看得见,由人决定杀不杀(job 面板可 kill,或直接关会话)。
export const AUX_CALL_TIMEOUT_MS = 0;

/** 一次辅助调用的 token 账目(账单用):产出多少、其中推理多少、缓存命中多少。 */
export interface AuxUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
}

/** 从一段流的 usage chunk 里累计账目;形状防御性读取(缺哪个字段记 0)。 */
export function addUsage(into: AuxUsage, chunk: unknown): void {
  const c = chunk as { type?: unknown; usage?: Record<string, unknown> } | null;
  if (c?.type !== "usage" || c.usage === null || typeof c.usage !== "object") return;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  into.inputTokens += n(c.usage.inputTokens);
  into.outputTokens += n(c.usage.outputTokens);
  into.reasoningTokens += n(c.usage.reasoningTokens);
  into.cacheReadTokens += n(c.usage.cacheReadTokens);
}

/** 账单里的紧凑账目行,如 "出6.8k/思5.9k/缓12.3k";全零(拿不到 usage)返回 ''。 */
export function usageDetail(u: AuxUsage): string {
  if (u.outputTokens === 0 && u.inputTokens === 0 && u.cacheReadTokens === 0) return "";
  const k = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v));
  return `出${k(u.outputTokens)}/思${k(u.reasoningTokens)}/缓${k(u.cacheReadTokens)}`;
}

/** 辅助调用可选的模型路由与档位;effort 只辖装配器自己的内部调用,与会话模型无关。 */
export interface AuxLlm {
  provider?: string;
  model?: string;
  /** 装配器内部调用(选型/推导)的推理档:off|low|high|max;缺省继承 connection 默认。 */
  effort?: string;
}

async function callDeriver(
  ctx: Context,
  prompt: string,
  llm: AuxLlm,
  onUsage?: (u: AuxUsage) => void,
): Promise<Record<string, unknown>> {
  const assembler = new BlockAssembler();
  // Same fast-model + provider-resolution discipline as llmMapRequirement:
  // provider follows host selection, model pins flash unless config overrides.
  const selection = (ctx.get("agentDefaultModel") as { currentSelection?: () => { provider?: string } | undefined } | undefined)?.currentSelection?.();
  const options: GenerateOptions = {
    provider: llm.provider ?? selection?.provider ?? "deepseek-official",
    model: llm.model ?? "deepseek-v4-flash",
    // 档位是本调用自己的:推导一份 JSON 探针稿不需要会话级 max 深思——实测
    // 继承 max 时一次推导 90s,其中绝大头是隐藏推理链的解码。
    ...(llm.effort !== undefined ? { reasoningEffort: llm.effort as GenerateOptions["reasoningEffort"] } : {}),
    messages: [createUserMessage({ content: [{ type: "text", text: prompt }], source: { kind: "user" } })],
    ...(AUX_CALL_TIMEOUT_MS > 0 ? { signal: AbortSignal.timeout(AUX_CALL_TIMEOUT_MS) } : {}),
  };
  const usage: AuxUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 };
  for await (const chunk of ctx.llm.stream(options)) {
    addUsage(usage, chunk);
    assembler.push(chunk);
  }
  onUsage?.(usage);
  const finish = assembler.finish;
  if (finish.kind === "error" || finish.kind === "aborted") {
    throw new Error(`probe deriver: model call ${finish.kind}: ${finish.failure.message}`);
  }
  let text = "";
  for (const block of assembler.message().content) {
    if (block.type === "text") text += block.text;
  }
  return parseModelJson(text);
}

/**
 * 模型 JSON 出口的唯一解析器:剥 ``` 围栏、截首 { 到末 }、再 parse。
 * 实测(市场战役 s21):重试轮 matcher 回了 ```json 围栏,裸 JSON.parse 直接
 * 「Unexpected token '`'」把整个重试炸掉——模型输出永远可能带杂音,每个
 * 解析点各自裸奔就是每个点各自炸一次。失败信息带原文片段,可诊断。
 */
export function parseModelJson(raw: string): Record<string, unknown> {
  const unfenced = raw.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`模型未返回 JSON:${raw.slice(0, 160)}——推导器打滑;重调 verify_preset 并附探针草图可绕过推导(出题范例见 emit_preset 结果)`);
  }
  try {
    return JSON.parse(unfenced.slice(start, end + 1)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`模型 JSON 解析失败(${error instanceof Error ? error.message.slice(0, 80) : "?"}):${unfenced.slice(start, start + 160)}`);
  }
}

/** Ask the fast model for a probe task tailored to the selected parts. */
export async function deriveProbe(
  ctx: Context,
  requirement: string,
  selected: CapabilityEntry[],
  llm: AuxLlm,
  onUsage?: (u: AuxUsage) => void,
): Promise<ProbeSpec> {
  const tools = selected.map((c) => `- ${c.tool ?? c.id}: ${c.description.slice(0, 120)}`).join("\n");
  // 段序即缓存工程:静态规则前置,requirement/tools 沉尾(§09 借法)。
  const prompt = [
    "You design a ONE-TURN smoke probe for a freshly assembled agent (its requirement and tools are at the END of this prompt).",
    "",
    "Rules:",
    '- Respond with JSON only: {"task": "...", "mustInclude": ["...", "..."]}',
    "- task: a single instruction the agent can finish in one turn (< 2 minutes) using ONLY the listed tools; write it in the requirement's language.",
    "- Prefer self-contained work (compute, transform, generate). Use the network only when the agent's parts are network tools.",
    ...MARK_RULES,
    "",
    `The agent was assembled for this requirement: ${requirement}`,
    "Its tools:",
    tools,
  ].join("\n");
  const parsed = await callDeriver(ctx, prompt, llm, onUsage) as unknown as ProbeSpec;
  if (typeof parsed.task !== "string" || !Array.isArray(parsed.mustInclude)) {
    throw new Error("probe deriver JSON missing task/mustInclude");
  }
  const marks = sanitizeMarks(parsed.mustInclude);
  if (marks.length === 0) {
    throw new Error(`probe deriver 的验收标记全被消毒剔除(原标记:${parsed.mustInclude.map(String).join(", ").slice(0, 80)})——重调 verify_preset 并附上你自己的探针草图可绕过整段推导(出题范例见 emit_preset 结果)`);
  }
  return { task: parsed.task, mustInclude: marks };
}

/**
 * 覆盖补推导的解析纯件:{"probes":[{task,mustInclude}...]} → 消毒后的 ProbeSpec[]。
 * 脏题(缺字段/标记全被消毒)逐题丢弃(调用方出声),超 cap 截断;整体不炸。
 */
export function parseCoverageProbes(parsed: Record<string, unknown>, maxProbes: number): ProbeSpec[] {
  const raw = Array.isArray(parsed.probes) ? parsed.probes : [];
  const out: ProbeSpec[] = [];
  for (const item of raw) {
    if (out.length >= maxProbes) break;
    const o = item as Record<string, unknown> | null;
    if (o === null || typeof o.task !== "string" || o.task.trim() === "" || !Array.isArray(o.mustInclude)) continue;
    const marks = sanitizeMarks(o.mustInclude);
    if (marks.length === 0) continue;
    out.push({ task: o.task, mustInclude: marks });
  }
  return out;
}

/**
 * 覆盖补推导(阶段 3):考完已排路径后,按**经验未覆盖清单**一次批量出题——
 * 覆盖是轨迹事实不是申报事实(草图不设 covers 字段:申报会把闸变成可刷的靶子,
 * 第六条不认"它说它考了")。恒一次 aux 调用,不是每件一次(成本上限第一道)。
 * 每题强制单轮、打包 2-4 件相邻零件;整体解析失败由调用方接 throw 并出声取消,
 * 不影响已成立的主路径判定。
 */
export async function deriveCoverageProbes(
  ctx: Context,
  requirement: string,
  uncovered: CapabilityEntry[],
  maxProbes: number,
  llm: AuxLlm,
  onUsage?: (u: AuxUsage) => void,
): Promise<ProbeSpec[]> {
  if (uncovered.length === 0 || maxProbes <= 0) return [];
  const tools = uncovered.map((c) => `- ${c.tool ?? c.id}: ${c.description.slice(0, 120)}`).join("\n");
  // 段序即缓存工程(§09):静态规则前置,requirement/清单沉尾。
  const prompt = [
    "You design COVERAGE smoke probes for an already-verified agent: its MAIN workflow passed, but the tools listed at the END were never touched by any probe. Write probes that exercise them.",
    "",
    "Rules:",
    `- Respond with JSON only: {"probes": [{"task": "...", "mustInclude": ["..."]}, ...]} — at most ${String(maxProbes)} probes.`,
    "- Each task: ONE turn (< 2 minutes), self-sufficient, in the requirement's language; bundle 2-4 RELATED listed tools into one task when natural (fewer probes beat more).",
    "- Only exercise the listed tools; do not re-test the main workflow.",
    ...MARK_RULES,
    "",
    `The agent was assembled for this requirement: ${requirement}`,
    "Never-touched tools:",
    tools,
  ].join("\n");
  const parsed = await callDeriver(ctx, prompt, llm, onUsage);
  return parseCoverageProbes(parsed, maxProbes);
}

/** What the deriver decided to run: one turn, or a multi-turn scenario. */
export type ProbePlan =
  | { kind: "single"; probe: ProbeSpec }
  | { kind: "scenario"; scenario: ScenarioSpec };

/**
 * Ask the fast model for a probe PLAN: it decides whether one turn suffices
 * or the requirement deserves a multi-turn scenario.
 *
 * The choice is the model's, not a keyword heuristic on our side — the same
 * task-agnostic discipline the matcher follows. A scenario is only worth
 * running when the agent can actually carry state across turns (its parts
 * write files or rows); a pure calculator has nothing to remember, and a
 * multi-turn probe of one would test the model's short-term memory rather
 * than the assembly.
 *
 * Falls back to the single-turn deriver when the model returns a malformed
 * or empty scenario: verification degrading to a weaker probe beats failing
 * an assembly that is probably fine.
 */
export async function deriveProbePlan(
  ctx: Context,
  requirement: string,
  selected: CapabilityEntry[],
  llm: AuxLlm,
  onUsage?: (u: AuxUsage) => void,
  arch?: { workflow?: string; dataModel?: string },
): Promise<ProbePlan> {
  const tools = selected.map((c) => `- ${c.tool ?? c.id}: ${c.description.slice(0, 120)}`).join("\n");
  // 架构驱动探针(方向 2):选型前已出的架构 spec 知道这个 agent 的主工作流与
  // 数据模型。把它喂给探针派生,探针就验**主流程的关键跨轮路径**,而不是从需求
  // 重编一个可能偏门的场景——首探更贴合真实用法、更容易一次过,少触发那个整轮
  // 297s 的重试。(实测:重试轮是一次复杂装配的单笔最大墙钟浪费。)
  const archBlock = (arch?.workflow ?? "") !== "" || (arch?.dataModel ?? "") !== ""
    ? [
        "",
        "This agent's architecture (design the probe to exercise its MAIN workflow, not a side path):",
        arch?.workflow !== undefined && arch.workflow !== "" ? `- main workflow: ${arch.workflow}` : "",
        arch?.dataModel !== undefined && arch.dataModel !== "" ? `- data model: ${arch.dataModel}` : "",
        "The scenario's turn 1 should CREATE the central record of this workflow; a later turn should RETRIEVE/USE it — this is the workflow's own happy path, the thing a real user does first.",
      ].filter((s) => s !== "").join("\n")
    : "";
  // 段序即缓存工程(§09:静态前缀=缓存):形状说明/范例/MARK_RULES 全静态,
  // 放最前吃前缀缓存;requirement/tools/archBlock 每次都变,沉到尾部。
  const prompt = [
    "You design an acceptance probe for a freshly assembled agent (the requirement and its tools are listed at the END of this prompt).",
    "",
    "First DECIDE the probe shape:",
    '- "single" — one turn is enough to prove the agent works (pure compute/transform/generate agents).',
    '- "scenario" — 2-4 turns in ONE session, when the requirement implies work that OUTLIVES a turn (filing, bookkeeping, tracking, archiving) AND the tools can actually persist it (files, databases). A later turn then asks about what an earlier turn produced, which proves continuity.',
    // 2 轮已是证明"状态活过一轮"的最小形状;每多一轮都是整段真 agent 墙钟。
    "- Scenario turn count: DEFAULT to exactly 2 turns (create state → retrieve it). Use 3-4 only when 2 genuinely cannot prove the requirement.",
    "",
    "Then respond with JSON only, in ONE of these two shapes:",
    '{"kind": "single", "task": "...", "mustInclude": ["..."]}',
    '{"kind": "scenario", "goal": "one line: what this proves", "turns": [{"prompt": "...", "mustInclude": ["..."]}, ...]}',
    "",
    // 范例优先(与编排者出题共用同一份;回退推导没范例时出过 base64 怪题):
    `Model your probe on these examples (translated into the requirement's domain and language): ${PROBE_SKETCH_EXAMPLES}`,
    "",
    "Rules:",
    "- Write prompts in the requirement's language.",
    "- Each turn is one instruction the agent can finish in one turn using ONLY the tools above.",
    "- SCENARIO SHAPE: turn 1 creates state with a distinctive token you invent (e.g. INV-7781); a LATER turn must ask the agent to retrieve or use that state WITHOUT restating it — its marks are how state continuity is judged. Never make a later turn merely repeat turn 1's work.",
    "- Judging is black-box: only each turn's reply text is inspected. Never require the agent to follow specific steps or announce its plan.",
    ...MARK_RULES,
    "",
    `The agent was assembled for this requirement: ${requirement}`,
    "Its tools:",
    tools,
    archBlock,
  ].join("\n");

  let parsed: Record<string, unknown>;
  try {
    parsed = await callDeriver(ctx, prompt, llm, onUsage);
  } catch (error) {
    // A malformed plan is not a reason to skip verification entirely.
    // 回退调用的账目同样上报——账单累计的是"推导"整个阶段的钱。
    return { kind: "single", probe: await deriveProbe(ctx, requirement, selected, llm, onUsage) };
  }

  if (parsed.kind === "scenario" && Array.isArray(parsed.turns)) {
    const turns: ScenarioTurn[] = (parsed.turns as Array<Record<string, unknown>>)
      .filter((t) => typeof t.prompt === "string" && Array.isArray(t.mustInclude) && t.mustInclude.length > 0)
      .slice(0, 4)
      // 标记消毒是机械闸:某轮标记全剔 = 该场景稿不可信,整体走单轮回退。
      .map((t) => ({ prompt: String(t.prompt), mustInclude: sanitizeMarks(t.mustInclude as unknown[]) }));
    // A one-turn "scenario" is a single probe wearing a costume; two turns is
    // the minimum that can prove anything about continuity.
    if (turns.length >= 2 && turns.every((t) => t.mustInclude.length > 0)) {
      return { kind: "scenario", scenario: { goal: typeof parsed.goal === "string" ? parsed.goal : "多轮场景验收", turns } };
    }
  }
  if (typeof parsed.task === "string" && Array.isArray(parsed.mustInclude)) {
    const marks = sanitizeMarks(parsed.mustInclude as unknown[]);
    if (marks.length > 0) return { kind: "single", probe: { task: parsed.task, mustInclude: marks } };
  }
  return { kind: "single", probe: await deriveProbe(ctx, requirement, selected, llm, onUsage) };
}

/**
 * Text an assistant/message frame delivered to the user.
 *
 * Wire shape: {type:'assistant/message', data:{turn, step, message:{role, content:[blocks]}}}.
 * TEXT blocks only — reasoning text is the model talking to itself, and a
 * mark that appears there but not in the reply did not reach the user.
 */
function frameText(e: any): string {
  const c = e.data?.message?.content ?? e.data?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((b: any) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
  }
  return "";
}

/** A live probe session: one preset, one workdir, many turns. */
interface ProbeSession {
  sessionId: string;
  frames: any[];
  prompt: (text: string) => Promise<void>;
  close: () => void;
}

/**
 * Open a session bound to the preset and subscribe to its event stream.
 *
 * 传输层走共享 wire 客户端:RPC 超时把 socket 本身也钉死(enqueue-and-ack 无应答
 * 会挂在 sendTurn 的轮预算开始计时之前,见 PROBE_RPC_TIMEOUT_MS)。探针退出必须
 * 掐掉会话:判超时弃考后,被考的 agent 那一轮还在服务器上跑——白烧 token,侧栏
 * 的探针会话还永远显示"深思中",旁观者会误以为装配没完(实测:用户盯着遗孤轮问
 * "为什么还在 deep diving")。cancel 由 close() 承接、尽力而为:探针的判定在弃考
 * 那一刻已经成立,掐不掐得掉都不改变结论。
 */
async function openProbeSession(port: number, presetId: string, cwd?: string): Promise<ProbeSession> {
  const workdir = cwd ?? mkdtempSync(join(tmpdir(), "assembler-probe-"));
  const w = await openWireSession(port, { agentPreset: presetId, cwd: workdir, rpcTimeoutMs: PROBE_RPC_TIMEOUT_MS });
  return { sessionId: w.sessionId, frames: w.frames, prompt: w.prompt, close: w.close };
}

/**
 * Send one prompt and return the outcome of THAT turn.
 *
 * Turn boundaries come from counting `turn/end` events rather than from the
 * frame index: a turn's frames arrive after the prompt is accepted, and the
 * count is what distinguishes "this turn finished" from "an earlier one did"
 * when several turns share the session.
 *
 * 三件直播台义务(bilingual-reader 悬挂取证后加,2026-08-21):
 *  1. 动作流:轮内每个 tool/call 即时 phase 一行——48s 的轮在直播台不再是
 *     48s 的空白,"卡了还是在干活"肉眼可判。
 *  2. 心跳:20s 没有可见动作也报一行经过时间。AUX 无闸 + 轮预算 600s 之后,
 *     心跳是"静默 ≠ 死亡"的唯一凭证。
 *  3. 问人即判负:agent 调 ask_user_question 时,探针会话无人可答,这个调用
 *     会挂到轮预算耗尽(实测挂满 600s:agent 猜完 7 个不存在的文件工具名后
 *     问用户"能否把 book.txt 粘贴给我")。探针的语义是"自主完成",中途求助
 *     = 能力面不足,立即判 FAIL 并把问题原文带回——这行原文就是缺口诊断书。
 *
 * @returns `{reply}` 轮正常完成;`{askedUser}` agent 中途问人(判负,值为问题
 *          原文);`{}` 轮预算耗尽。
 */
export interface TurnOutcome { reply?: string; askedUser?: string }

export async function sendTurn(session: ProbeSession, prompt: string, timeoutMs: number, onPhase?: (line: string) => void): Promise<TurnOutcome> {
  const endsBefore = session.frames.filter((e) => e.type === "turn/end").length;
  const startIndex = session.frames.length;
  await session.prompt(prompt);
  const t0 = Date.now();
  let scanned = startIndex;
  let framesSeen = session.frames.length;
  let lastVisibleAt = Date.now();
  let lastAction = "";
  while (Date.now() - t0 < timeoutMs) {
    for (; scanned < session.frames.length; scanned++) {
      const ev = session.frames[scanned];
      if (ev?.type !== "tool/call") continue;
      const name = String(ev.data?.name ?? "?");
      if (name === "ask_user_question") {
        let q = "";
        try {
          const args = JSON.parse(String(ev.data?.arguments ?? "{}")) as { questions?: Array<{ question?: unknown }> };
          q = String(args.questions?.[0]?.question ?? "");
        } catch { /* 参数解析不了就只报工具名 */ }
        return { askedUser: q !== "" ? q : "(问题原文不可解析)" };
      }
      lastAction = name;
      lastVisibleAt = Date.now();
      onPhase?.(`  · 动作:${name}`);
    }
    if (session.frames.filter((e) => e.type === "turn/end").length > endsBefore) {
      return {
        reply: session.frames
          .slice(startIndex)
          .filter((e) => e.type === "assistant/message")
          .map(frameText)
          .join("\n"),
      };
    }
    if (Date.now() - lastVisibleAt >= 20_000) {
      lastVisibleAt = Date.now();
      // 帧还在到达 = 模型在输出(思维链/正文流);帧也停了 = 在等模型或工具。
      const streaming = session.frames.length > framesSeen;
      framesSeen = session.frames.length;
      const state = streaming ? "模型输出流动中" : "等待模型/工具响应";
      onPhase?.(`  …轮进行中(${String(Math.round((Date.now() - t0) / 1000))}s,${state}${lastAction !== "" ? `,已用:${lastAction}` : ""})`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return {};
}

/** Run a single-turn probe in a real session bound to the preset. */
/**
 * Tell the watcher which sidebar session is the live probe.
 *
 * The probe runs in its own session with an auto-generated title; the assemble
 * call the user is watching cannot show that session's thinking inline (a tool
 * result is atomic). DSH web has no session deep-link to click, so the next
 * best thing is to name the probe session in the progress stream the instant it
 * opens — the user opens that sidebar row and watches the real thinking + tool
 * calls live. The task's opening words are the hint, because that is exactly
 * what the session-title plugin derives its title from.
 */
function announceProbeSession(onPhase: ((line: string) => void) | undefined, sessionId: string, taskHint: string): void {
  if (onPhase === undefined) return;
  const hint = taskHint.replace(/\s+/g, " ").trim().slice(0, 24);
  onPhase(`探针会话已开(实时思维链在此)——侧栏找标题近似「${hint}…」的会话点开旁观 · id ${sessionId.slice(0, 16)}`);
}

export async function runProbe(
  port: number,
  presetId: string,
  probe: ProbeSpec,
  timeoutMs = PROBE_TURN_BUDGET_MS,
  onPhase?: (line: string) => void,
  cwd?: string,
): Promise<ProbeResult> {
  const session = await openProbeSession(port, presetId, cwd);
  announceProbeSession(onPhase, session.sessionId, probe.task);
  try {
    const out = await sendTurn(session, probe.task, timeoutMs, onPhase);
    if (out.askedUser !== undefined) {
      onPhase?.(`✗ agent 中途向用户求助(探针无人可答,判 FAIL):「${out.askedUser.slice(0, 120)}」`);
      return { status: "FAIL", kind: "single", probe, reason: `agent 求助用户而非自主完成:「${out.askedUser.slice(0, 200)}」——通常是能力面缺了它要的工具`, toolsUsed: aggregateToolCalls(session.frames) };
    }
    if (out.reply === undefined) {
      return { status: "FAIL", kind: "single", probe, reason: `probe turn did not finish within ${Math.round(timeoutMs / 1000)}s`, toolsUsed: aggregateToolCalls(session.frames) };
    }
    const pass = evaluateProbe(probe, out.reply);
    return { status: pass ? "PASS" : "FAIL", kind: "single", probe, reply: out.reply.slice(0, 400), toolsUsed: aggregateToolCalls(session.frames) };
  } finally {
    session.close();
  }
}

/**
 * Run a multi-turn scenario in ONE session — the same session is what makes
 * continuity testable: a later turn asking about turn 1's work can only
 * succeed if the state really outlived the turn.
 *
 * Every turn is judged by its own marks and ALL must pass; the run stops at
 * the first failure (later turns build on the failed one, so their verdicts
 * would be noise rather than evidence).
 */
/**
 * 前端验收(纳入装配即验证):
 *  - 门 1 页面可达:GET /assembler/ui/<id> 必须 200,且槽位已填(presetId 进了
 *    页面、无残留 {{slot}})——发射对了但伺服不通,交付到客户手里就是白屏。
 *  - 门 2 会话环路:用页面完全同款的参数(cwd=preset/workspace + agentPreset)
 *    开一个真会话,发一条口令回显微探针——证明"页面里那套接线"端到端活着。
 *    页面本身是静态 JS,它的全部副作用就是这两个 wire 调用;两门齐过 = 前端
 *    以与探针同级的黑盒标准被验证。沿用轮只跑门 1(环路已在台账代际证过,
 *    不为它重付一轮 agent)。
 */
export async function runFrontendGate(
  port: number,
  presetId: string,
  presetDir: string,
  opts: { loop?: boolean; timeoutMs?: number } = {},
): Promise<{ pass: boolean; reason?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/assembler/ui/${presetId}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { pass: false, reason: `页面不可达:HTTP ${res.status}` };
    const html = await res.text();
    // 绑定证据二选一:模板页 = 带引号的 presetId 槽位;scaffold 页 = 绝对资产
    // base(/assembler/ui/<id>/)——两种形态都证明这张页是发给本 preset 的。
    if (!html.includes(`'${presetId}'`) && !html.includes(`/assembler/ui/${presetId}/`)) return { pass: false, reason: "页面槽位未填(presetId 未进页面)" };
    if (/\{\{[A-Za-z]+\}\}/.test(html)) return { pass: false, reason: "页面存在未填充的 {{槽位}}" };
  } catch (error) {
    return { pass: false, reason: `页面请求失败:${error instanceof Error ? error.message : String(error)}` };
  }
  if (opts.loop === false) return { pass: true, reason: "页面门 PASS(沿用轮跳环路门)" };
  const token = `FE-GATE-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const session = await openProbeSession(port, presetId, join(presetDir, "workspace"));
  try {
    const out = await sendTurn(session, `请原样回复这串口令(不要解释):${token}`, opts.timeoutMs ?? 90_000);
    if (out.askedUser !== undefined) return { pass: false, reason: `环路门:agent 反问用户(「${out.askedUser.slice(0, 80)}」)` };
    if (out.reply === undefined) return { pass: false, reason: "环路门:回显轮未在时限内完成" };
    if (!marksPresent([token], out.reply)) return { pass: false, reason: "环路门:回复未含口令" };
    return { pass: true, reason: "页面门+环路门 PASS" };
  } finally {
    session.close();
  }
}

export async function runScenario(
  port: number,
  presetId: string,
  scenario: ScenarioSpec,
  timeoutMs = PROBE_TURN_BUDGET_MS,
  onPhase?: (line: string) => void,
  cwd?: string,
): Promise<ProbeResult> {
  const session = await openProbeSession(port, presetId, cwd);
  announceProbeSession(onPhase, session.sessionId, scenario.turns[0]?.prompt ?? scenario.goal);
  const turns: TurnResult[] = [];
  // 动用率随每个出口走:失败出口也带——"跑到一半都动用了什么"正是诊断素材。
  const used = (): Array<{ name: string; calls: number }> => aggregateToolCalls(session.frames);
  try {
    for (const [i, turn] of scenario.turns.entries()) {
      const turnStart = Date.now();
      const out = await sendTurn(session, turn.prompt, timeoutMs, onPhase);
      if (out.askedUser !== undefined) {
        onPhase?.(`轮 ${String(i + 1)}/${String(scenario.turns.length)} ✗ agent 中途向用户求助(探针无人可答):「${out.askedUser.slice(0, 120)}」`);
        return {
          status: "FAIL",
          kind: "scenario",
          scenario,
          turns,
          reason: `第 ${String(i + 1)} 轮 agent 求助用户而非自主完成:「${out.askedUser.slice(0, 200)}」——通常是能力面缺了它要的工具`,
          toolsUsed: used(),
        };
      }
      const reply = out.reply;
      if (reply === undefined) {
        onPhase?.(`轮 ${String(i + 1)}/${String(scenario.turns.length)} ✗ 超时(${String(Math.round(timeoutMs / 1000))}s)`);
        return {
          status: "FAIL",
          kind: "scenario",
          scenario,
          turns,
          reason: `第 ${String(i + 1)} 轮未在 ${String(Math.round(timeoutMs / 1000))}s 内完成`,
          toolsUsed: used(),
        };
      }
      const pass = marksPresent(turn.mustInclude, reply);
      onPhase?.(`轮 ${String(i + 1)}/${String(scenario.turns.length)} ${pass ? '✓' : '✗'}(${String(Math.round((Date.now() - turnStart) / 1000))}s)`);
      turns.push({ index: i + 1, prompt: turn.prompt, mustInclude: turn.mustInclude, pass, reply: reply.slice(0, 300) });
      if (!pass) {
        return {
          status: "FAIL",
          kind: "scenario",
          scenario,
          turns,
          reason: `第 ${String(i + 1)} 轮未含验收标记 [${turn.mustInclude.join(", ")}]`,
          toolsUsed: used(),
        };
      }
    }
    const pass = evaluateScenario(turns, scenario.turns.length);
    return { status: pass ? "PASS" : "FAIL", kind: "scenario", scenario, turns, toolsUsed: used() };
  } finally {
    session.close();
  }
}

/**
 * 跨 preset 共享数据探针的形状:证明一套班子**真的共享数据**,而不只是各库钉
 * 到同一文件——writer 写一条带独特 token 的记录,reader(另一个 preset、同一
 * 共享库)把它读回来。读得到 = 数据真的在班子间流动。交接由编排者自己设计
 * (verify_shared_data 的机械闸把守 token/payload 纪律),不再有 LLM 派生器
 * (旧派生器随 pipeline 形态删除,git 备查)。
 */
export interface SharedDataProbe {
  writerId: string;
  writerTask: string;
  readerId: string;
  readerTask: string;
  mustInclude: string[];
}

/**
 * 跑跨 agent 共享数据探针:writer 会话写 → reader 会话读 → 判 reader 回复含标记。
 * 两个会话绑不同 preset(各自的 SQLITE_DEFAULT_DB 都钉到同一共享库),cwd 各用
 * 自己的 workspace(filesystem 面),但 sqlite 默认库同一份——这正是被验证的接线。
 */
export async function runSharedDataProbe(
  port: number,
  probe: SharedDataProbe,
  writerCwd: string,
  readerCwd: string,
  timeoutMs = PROBE_TURN_BUDGET_MS,
  onPhase?: (line: string) => void,
): Promise<{ pass: boolean; reason: string; writerReply?: string; readerReply?: string }> {
  onPhase?.(`共享数据探针:${probe.writerId} 写 → ${probe.readerId} 读(标记 [${probe.mustInclude.join(", ")}])`);
  const writer = await openProbeSession(port, probe.writerId, writerCwd);
  let writerReply: string | undefined;
  try {
    const out = await sendTurn(writer, probe.writerTask, timeoutMs, onPhase);
    if (out.askedUser !== undefined) return { pass: false, reason: `写入方 ${probe.writerId} 中途求助:「${out.askedUser.slice(0, 100)}」` };
    if (out.reply === undefined) return { pass: false, reason: `写入方 ${probe.writerId} 未在时限内完成` };
    writerReply = out.reply.slice(0, 300);
    onPhase?.(`  ✓ ${probe.writerId} 写入完成`);
  } finally {
    writer.close();
  }
  const reader = await openProbeSession(port, probe.readerId, readerCwd);
  try {
    const out = await sendTurn(reader, probe.readerTask, timeoutMs, onPhase);
    if (out.askedUser !== undefined) return { pass: false, reason: `读取方 ${probe.readerId} 中途求助:「${out.askedUser.slice(0, 100)}」`, writerReply };
    if (out.reply === undefined) return { pass: false, reason: `读取方 ${probe.readerId} 未在时限内完成`, writerReply };
    const readerReply = out.reply.slice(0, 300);
    const pass = marksPresent(probe.mustInclude, out.reply);
    return {
      pass,
      reason: pass
        ? `${probe.readerId} 读到了 ${probe.writerId} 写入的记录(共享数据流动成立)`
        : `${probe.readerId} 的回复未含标记 [${probe.mustInclude.join(", ")}]——写入方写了、读取方读不到,共享未真正打通`,
      writerReply,
      readerReply,
    };
  } finally {
    reader.close();
  }
}

/**
 * 触发面考官(无人值守形态的第四格):**打一发,验后果**。
 * 机制:像 cron-trigger 到点那样经公开 wire 开一个真会话、注入带无人值守纪律头
 * 的任务,然后**不看回复**——轮询配套 preset 的服务脸,直到效果断言成立或超时。
 * 完成判据是落库效果而非会话结束(P3 教训:会话结束≠工作结束)。
 */
export async function runTriggerProbe(
  port: number,
  opts: {
    presetId: string
    task: string
    presetDir: string
    effectSql: string
    expect: string
    timeoutMs?: number
    faceUrl: string
    faceToken: string
    onPhase?: (line: string) => void
  },
): Promise<{ pass: boolean; reason: string; sessionId?: string; elapsedSeconds: number }> {
  const t0 = Date.now();
  const budget = opts.timeoutMs ?? 240_000;
  let sessionId: string;
  try {
    // events:false——打一发就走,不订流也不掐会话(被触发的工作要跑完,效果凭库说话)
    const w = await openWireSession(port, {
      agentPreset: opts.presetId,
      cwd: join(opts.presetDir, "workspace"),
      events: false,
      rpcTimeoutMs: PROBE_RPC_TIMEOUT_MS,
    });
    sessionId = w.sessionId;
    // 与 cron-trigger 实际注入的纪律头同款:无人在场、别提问、做完为止
    await w.prompt(`[定时任务自动触发,无人在场——独立完成,不要向任何人提问;做完为止,不要因为一次尝试失败就停]\n${opts.task}`);
  } catch (error) {
    return { pass: false, reason: `触发失败(wire 开会话):${error instanceof Error ? error.message : String(error)}`, elapsedSeconds: Math.round((Date.now() - t0) / 1000) };
  }
  opts.onPhase?.(`已打一发(session ${sessionId.slice(0, 18)});开始轮询效果断言`);
  // 轮询效果:唯一判据是库里长没长出东西
  while (Date.now() - t0 < budget) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const r = await fetch(`${opts.faceUrl}/sql`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-service-token": opts.faceToken },
        body: JSON.stringify({ sql: opts.effectSql, params: [] }),
        signal: AbortSignal.timeout(8000),
      });
      const j = (await r.json()) as { rows?: unknown; error?: string };
      if (typeof j.error !== "string" && JSON.stringify(j.rows ?? []).includes(opts.expect)) {
        return { pass: true, reason: `触发→执行→落库闭环成立(效果断言命中「${opts.expect}」)`, sessionId, elapsedSeconds: Math.round((Date.now() - t0) / 1000) };
      }
    } catch { /* 面暂时不可达:继续轮询 */ }
  }
  return { pass: false, reason: `${Math.round(budget / 1000)}s 内未见效果(断言「${opts.expect}」未在 ${opts.effectSql.slice(0, 60)} 的结果里出现)——agent 没干活?表/列名不对?`, sessionId, elapsedSeconds: Math.round((Date.now() - t0) / 1000) };
}
