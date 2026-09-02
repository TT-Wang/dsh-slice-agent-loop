/**
 * DSH host 公开 wire 的共享客户端——一份实现,全仓复用(BACKLOG 0.9)。
 *
 * 消费方:verify.ts 真会话探针 / bench 三驱动器 / index-add auto 路 /
 * cron-trigger 零件;浏览器侧的 frontends/_vendor 与 scaffold 模板 SDK 按同一
 * 协议同构(它们不 import 本文件,cookie 由浏览器同源自带)。
 *
 * 为什么走公开 wire 而不是进程内服务:独立考官的独立性就在这条线上——考官与
 * 被考 agent 之间只有 host 的公开协议,没有后门。
 *
 * 协议两代(0.1.2-alpha.1 是分水岭,实弹破译见 docs/research/dsh-alpha2-migration.md):
 * - legacy:点号端点(`POST /api/session.prompt`)、无鉴权、payload 直给、
 *   events.mux 单流、`POST /api/respond` 代答。
 * - new:斜杠端点、cookie 鉴权(token 每进程轮换不落盘,换到的 cookie 由落盘
 *   密钥签名、跨 host 重启有效)、payload 双包裹且**包裹键按端点不同**
 *   (session/create 要 `request`,session/list 要 `_request`——不抄表,读网关
 *   `gateway/arguments-invalid` 报错改发)、prompt 必带客户端自铸 requestId、
 *   事件走 `ws /api/remote.mux` 逻辑流(session/follow 事件带 seq;
 *   session/control 投影;$events waterfall 问答/审批,代答 POST /api/$events/result)。
 *
 * 纪律(同幽灵宿主教训):不读版本号,发探针按应答定代际;探到哪代说哪代的话。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const WIRE_RPC_TIMEOUT_MS = 30_000;
/** cookie 名义 30 天;提前 1 天当过期,免得卡边界。 */
const COOKIE_LIFETIME_MS = 29 * 24 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000;

export type Cohort = "new" | "legacy";
export interface WireAuth { origin: string; cookie: string; obtainedAt: number }

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

function authCachePath(): string {
  return join(dshHome(), "assembler", "wire-auth.json");
}

function loadAuthCache(): Record<string, WireAuth> {
  try { return JSON.parse(readFileSync(authCachePath(), "utf8")) as Record<string, WireAuth>; } catch { return {}; }
}

function saveAuthCache(cache: Record<string, WireAuth>): void {
  mkdirSync(join(dshHome(), "assembler"), { recursive: true });
  writeFileSync(authCachePath(), JSON.stringify(cache, null, 2) + "\n");
}

/**
 * 在 host 启动日志里找带 token 的启动行(token 只打一次 stdout、不落盘,这是
 * 唯一来源)。取最后一次命中——host 重启后旧 token 作废。
 */
export function findLaunchUrl(port: number, logFiles?: readonly string[]): string | null {
  const home = dshHome();
  const candidates = logFiles ?? [
    join(home, "web-host.log"),
    ...(existsSync(join(home, "logs"))
      ? readdirSync(join(home, "logs")).filter((f) => f.endsWith(".log")).map((f) => join(home, "logs", f))
      : []),
  ];
  const re = new RegExp(`https?://[^\\s]*:${String(port)}/?\\?token=[A-Za-z0-9_-]+`, "g");
  let best: string | null = null;
  for (const f of candidates) {
    try {
      const hits = readFileSync(f, "utf8").match(re);
      if (hits !== null && hits.length > 0) best = hits[hits.length - 1] as string;
    } catch { /* 读不到就跳过 */ }
  }
  return best;
}

/** 用启动 token 换 cookie(redirect:manual → 303 + set-cookie;cookie 名含 `=`,手动带头)。 */
export async function exchangeToken(launchUrl: string): Promise<WireAuth> {
  const res = await fetch(launchUrl, { redirect: "manual", signal: AbortSignal.timeout(WIRE_RPC_TIMEOUT_MS) });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie === null) throw new Error(`换 cookie 失败:GET ${launchUrl.replace(/token=.*/, "token=…")} 返回 HTTP ${String(res.status)} 且无 set-cookie——token 可能已随 host 重启作废,重新捞启动日志里最新的 ?token= 行再试`);
  return { origin: new URL(launchUrl).origin, cookie: setCookie.split(";", 1)[0] as string, obtainedAt: Date.now() };
}

/**
 * 取得可用鉴权:缓存(跨 host 重启仍有效)→ 环境变量 DSH_ASSEMBLER_TOKEN_URL
 * → 启动日志 → 报可行动错误(报错即界面:错了什么/证据/下一步命令)。
 */
export async function ensureAuth(port: number, opts: { logFiles?: readonly string[] } = {}): Promise<WireAuth> {
  const origin = `http://127.0.0.1:${String(port)}`;
  const cache = loadAuthCache();
  const hit = cache[origin];
  if (hit !== undefined && Date.now() - hit.obtainedAt < COOKIE_LIFETIME_MS) return hit;
  const envUrl = process.env.DSH_ASSEMBLER_TOKEN_URL;
  const launchUrl = (envUrl !== undefined && envUrl.includes(`:${String(port)}/`)) ? envUrl : findLaunchUrl(port, opts.logFiles);
  if (launchUrl === null) {
    throw new Error(
      `拿不到 ${origin} 的 wire 鉴权:cookie 缓存里没有本 origin(${authCachePath()}),`
      + `启动日志(${dshHome()}/web-host.log 与 ${dshHome()}/logs/*.log)里也没找到 :${String(port)} 的 ?token= 启动行。`
      + `下一步任选:①重启该 host 并把 stdout 落到上述日志路径后重试;`
      + `②手动把启动打印的完整 ?token= URL 传进来:export DSH_ASSEMBLER_TOKEN_URL='http://127.0.0.1:${String(port)}/?token=…' 后重试。`,
    );
  }
  const auth = await exchangeToken(launchUrl);
  cache[origin] = auth;
  saveAuthCache(cache);
  return auth;
}

/** 探这台 host 说哪套 wire:不读版本号,只看应答(旧 wire 无鉴权即应答;新 wire 401)。 */
export async function probeCohort(port: number): Promise<Cohort> {
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/agentPreset.list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "assembler-cohort-probe", method: "agentPreset.list", payload: {} }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) return "new";
    if (!res.ok) return "new";
    const body = (await res.json()) as { result?: { ok?: boolean } };
    return body.result?.ok === true ? "legacy" : "new";
  } catch { return "new"; }
}

interface RpcOk<T> { ok: true; value: T }
interface RpcErr { ok: false; error: { code?: string; message?: string } }

/** 旧 wire 一元调用:点号端点、无鉴权、payload 直给。 */
function describeFetchFailure(error: unknown, timeoutMs: number): string {
  return error instanceof Error && error.name === "TimeoutError"
    ? `${String(Math.round(timeoutMs / 1000))}s 内无响应`
    : (error instanceof Error ? error.message : String(error));
}

export async function rpcLegacy<T>(port: number, method: string, payload: unknown, timeoutMs = WIRE_RPC_TIMEOUT_MS): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${String(port)}/api/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: `assembler-${randomUUID()}`, method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`${method}: wire RPC 失败(${describeFetchFailure(error, timeoutMs)})`);
  }
  const body = (await res.json()) as { result: RpcOk<T> | RpcErr };
  if (!body.result.ok) throw new Error(`${method}: ${JSON.stringify(body.result.error).slice(0, 300)}`);
  return body.result.value;
}

/**
 * 新 wire 一元调用:斜杠端点 + cookie + 双包裹。包裹键先按 `request` 发,网关
 * 报错逐字点名要 `_request` 就换键重发——报错本身就是迁移指南,不固化对照表。
 */
export async function rpcNew<T>(port: number, endpoint: string, request: unknown, auth: WireAuth, timeoutMs = WIRE_RPC_TIMEOUT_MS): Promise<T> {
  const send = async (key: "request" | "_request"): Promise<{ status: number; body: { result: RpcOk<T> | RpcErr } | null; text: string }> => {
    let res: Response;
    try {
      res = await fetch(`${auth.origin}/api/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: auth.cookie },
        body: JSON.stringify({ type: "client-request", rpcId: `assembler-${randomUUID()}`, method: endpoint, payload: { args: { [key]: request } } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`${endpoint}: wire RPC 失败(${describeFetchFailure(error, timeoutMs)})`);
    }
    const text = await res.text();
    let body: { result: RpcOk<T> | RpcErr } | null = null;
    try { body = JSON.parse(text) as { result: RpcOk<T> | RpcErr }; } catch { /* 非 JSON */ }
    return { status: res.status, body, text };
  };
  let attempt = await send("request");
  const firstErr = attempt.body?.result.ok === false ? attempt.body.result.error : undefined;
  if (firstErr !== undefined && /_request/.test(String(firstErr.message ?? ""))) attempt = await send("_request");
  if (attempt.status === 401) throw new Error(`${endpoint}: HTTP 401——cookie 过期或失效。删除 ${authCachePath()} 中本 origin 的条目后重试(会自动重新兑换)`);
  if (attempt.status !== 200 || attempt.body === null) throw new Error(`${endpoint}: HTTP ${String(attempt.status)} ${attempt.text.slice(0, 300)}`);
  if (!attempt.body.result.ok) throw new Error(`${endpoint}: ${attempt.body.result.error.code ?? "?"} ${attempt.body.result.error.message ?? ""}`.slice(0, 800));
  return attempt.body.result.value;
}

// ── remote.mux 逻辑流 ────────────────────────────────────────────────────────

interface MuxSocketLike {
  addEventListener(type: string, listener: (event: { data?: unknown; code?: number }) => void): void;
  send(data: string): void;
  close(): void;
}

function openMuxSocket(auth: WireAuth): MuxSocketLike {
  // Node ≥22 内建 WebSocket 接受非标准 {headers} 构造参数带 cookie(实测过闸);
  // 标准 DOM 签名没有该参,类型上只能绕。
  const Ctor = (globalThis as { WebSocket?: new (url: string, init?: object) => unknown }).WebSocket;
  if (Ctor === undefined) throw new Error("此 Node 无内建 WebSocket(需 Node ≥ 22)——事件流不可用,一元 RPC 不受影响");
  return new Ctor(`${auth.origin.replace(/^http/, "ws")}/api/remote.mux`, { headers: { cookie: auth.cookie } }) as MuxSocketLike;
}

export interface MuxStream { first: unknown; close: () => void }

/**
 * 开一条逻辑流:等到首帧 item 才返回(流被证实活着);开流即错则把网关报错逐字
 * 上抛。后续 item 逐帧回调;流断走 onClose(不许静默)。
 */
export function openStream(
  auth: WireAuth,
  endpoint: string,
  payload: unknown,
  onItem: (value: unknown) => void,
  opts: { onClose?: (why: string) => void } = {},
): Promise<MuxStream> {
  const socket = openMuxSocket(auth);
  const streamId = `assembler-${randomUUID()}`;
  return new Promise<MuxStream>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(new Error(`${endpoint}: 开流 15s 无首帧——host 在吗?cookie 对吗?(host 换过进程则删 ${authCachePath()} 重试)`));
    }, 15_000);
    socket.addEventListener("open", () => { socket.send(JSON.stringify({ type: "open", streamId, endpoint, payload })); });
    socket.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : "";
      let frame: { type?: string; streamId?: string; value?: unknown; error?: unknown };
      try { frame = JSON.parse(text) as typeof frame; } catch { return; }
      if (frame.streamId !== streamId) return; // 载体复用,别人的流不归我们管
      if (frame.type === "error") {
        if (!settled) { settled = true; clearTimeout(timer); socket.close(); reject(new Error(`${endpoint}: ${JSON.stringify(frame.error).slice(0, 400)}`)); }
        else opts.onClose?.(`error ${JSON.stringify(frame.error).slice(0, 200)}`);
        return;
      }
      if (frame.type === "end") { opts.onClose?.("end"); return; }
      if (frame.type !== "item") return;
      if (!settled) { settled = true; clearTimeout(timer); resolve({ first: frame.value, close: () => { socket.close(); } }); return; }
      onItem(frame.value);
    });
    socket.addEventListener("close", (event) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`${endpoint}: WS 在开流前断了(code ${String(event.code ?? "?")})——多半是 cookie 没过闸`)); }
      else opts.onClose?.(`ws-close ${String(event.code ?? "?")}`);
    });
    socket.addEventListener("error", () => { /* close 紧随其后统一报 */ });
  });
}

// ── 会话(两代统一门面) ─────────────────────────────────────────────────────

export interface AnswerItem { id: string; selected: string[]; custom?: string }
/** 问答检查点帧,推进 frames 供消费方扫描;应答凭据两代各留一支(eventId/rpcId)。 */
export interface CheckpointFrame { type: "__question"; questions: unknown[]; eventId?: string; rpcId?: string }

export interface WireSessionOptions {
  agentPreset?: string;
  cwd?: string;
  rpcTimeoutMs?: number;
  /** 订阅事件流(follow/events.mux)。trigger 探针这类"打一发就走"的场景关掉。 */
  events?: boolean;
  /** 订阅问答检查点($events waterfall / question/requested),推 __question 帧。 */
  questions?: boolean;
  /** 订阅 tokenUsage 投影(session/control / session/projection)。 */
  projections?: boolean;
}

export interface WireSession {
  cohort: Cohort;
  sessionId: string;
  /** 会话事件,形状与旧版一致(turn/end / tool/call / assistant/message / __question)。 */
  frames: any[];
  /** 本会话未识别帧按 type 计数(不猜帧名,如实记账)。 */
  otherFrameCounts: Record<string, number>;
  /** 疑似审批帧原文(新 wire:$events 的非问答 waterfall;旧 wire:approval/permission 型帧)。 */
  approvalFrames: string[];
  /** tokenUsage 投影最后一帧累计值(未订阅或无帧则 null)。 */
  tokenUsage: unknown;
  prompt: (text: string) => Promise<void>;
  answer: (q: CheckpointFrame, answers: AnswerItem[]) => Promise<{ accepted: boolean; detail?: string }>;
  /** 掐掉会话(尽力而为:判定成立后清场用,掐不掉不改变结论)。 */
  cancel: () => void;
  /** 只断事件流、不掐会话——index-add auto 一类"会话留侧栏可复查"的场景用。 */
  detach: () => void;
  /** cancel + detach:探针/驱动器的标准收尾。 */
  close: () => void;
}

export async function openWireSession(port: number, opts: WireSessionOptions = {}): Promise<WireSession> {
  const cohort = await probeCohort(port);
  const timeoutMs = opts.rpcTimeoutMs ?? WIRE_RPC_TIMEOUT_MS;
  const wantEvents = opts.events !== false;
  const frames: any[] = [];
  const otherFrameCounts: Record<string, number> = {};
  const approvalFrames: string[] = [];
  const createReq = { ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}), ...(opts.agentPreset !== undefined ? { agentPreset: opts.agentPreset } : {}) };

  if (cohort === "legacy") {
    const rpc = <T,>(method: string, payload: unknown): Promise<T> => rpcLegacy<T>(port, method, payload, timeoutMs);
    const { sessionId } = await rpc<{ sessionId: string }>("session.create", createReq);
    const session: WireSession = {
      cohort, sessionId, frames, otherFrameCounts, approvalFrames, tokenUsage: null,
      prompt: async (text) => { await rpc("session.prompt", { sessionId, mode: "queue", content: [{ type: "text", text }] }); },
      answer: async (q, answers) => {
        const res = await fetch(`http://127.0.0.1:${String(port)}/api/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "client-response", rpcId: q.rpcId, result: { ok: true, value: { sessionId, answer: { answers } } } }),
          signal: AbortSignal.timeout(15_000),
        });
        // 回执体是顶层 {accepted, reason};host 对无效应答静默拒收且 HTTP 200,必须核回执
        try {
          const receipt = (await res.json()) as { accepted?: boolean };
          return receipt.accepted === false ? { accepted: false, detail: JSON.stringify(receipt).slice(0, 200) } : { accepted: true };
        } catch { return { accepted: true }; }
      },
      cancel: () => { void rpc("session.cancel", { sessionId }).catch(() => { /* 会话可能已自然结束 */ }); },
      detach: () => { /* 未订流则无事可断;订流后在下方替换 */ },
      close: () => { session.cancel(); session.detach(); },
    };
    if (wantEvents) {
      const WsCtor = (globalThis as { WebSocket?: new (url: string) => MuxSocketLike }).WebSocket;
      if (WsCtor === undefined) throw new Error("此 Node 无内建 WebSocket(需 Node ≥ 22)");
      const ws = new WsCtor(`ws://127.0.0.1:${String(port)}/api/events.mux`);
      ws.addEventListener("message", (m) => {
        try {
          const f = JSON.parse(String(m.data)) as any;
          if (f.payload?.type === "session/event" && f.payload.sessionId === sessionId) frames.push(f.payload.event);
          else if (opts.questions === true && f.payload?.type === "question/requested" && f.payload.sessionId === sessionId) frames.push({ type: "__question", rpcId: f.rpcId, questions: f.payload.questions } satisfies CheckpointFrame);
          else if (opts.projections === true && f.payload?.type === "session/projection" && f.payload.sessionId === sessionId && f.payload.key === "tokenUsage") session.tokenUsage = f.payload.value ?? null;
          else if (f.payload?.sessionId === sessionId && typeof f.payload?.type === "string") {
            otherFrameCounts[f.payload.type] = (otherFrameCounts[f.payload.type] ?? 0) + 1;
            if (/approval|permission/i.test(String(f.payload.type))) approvalFrames.push(JSON.stringify(f.payload).slice(0, 400));
          }
        } catch { /* 非 JSON 帧 */ }
      });
      await new Promise<void>((res, rej) => {
        ws.addEventListener("open", () => { res(); });
        ws.addEventListener("error", () => { rej(new Error("events.mux websocket failed")); });
      });
      session.detach = () => { ws.close(); };
    }
    return session;
  }

  // ── 新 wire ──
  const auth = await ensureAuth(port);
  const rpc = <T,>(endpoint: string, request: unknown): Promise<T> => rpcNew<T>(port, endpoint, request, auth, timeoutMs);
  const { sessionId } = await rpc<{ sessionId: string }>("session/create", createReq);
  const streams: MuxStream[] = [];
  let eventsClientId = "";
  const session: WireSession = {
    cohort, sessionId, frames, otherFrameCounts, approvalFrames, tokenUsage: null,
    // 新 wire 的 prompt 必带客户端自铸 requestId,漏了拒收
    prompt: async (text) => { await rpc("session/prompt", { requestId: randomUUID(), sessionId, mode: "queue", content: [{ type: "text", text }] }); },
    answer: async (q, answers) => {
      try {
        const res = await fetch(`${auth.origin}/api/$events/result`, {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: auth.cookie },
          body: JSON.stringify({ type: "client-request", rpcId: `assembler-${randomUUID()}`, method: "$events/result", payload: { args: { clientId: eventsClientId, eventId: q.eventId, outcome: { kind: "result", value: { answers } } } } }),
          signal: AbortSignal.timeout(15_000),
        });
        const body = (await res.json()) as { result?: RpcOk<unknown> | RpcErr };
        if (body.result?.ok !== true) return { accepted: false, detail: JSON.stringify(body.result ?? body).slice(0, 200) };
        return { accepted: true };
      } catch (error) {
        return { accepted: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },
    cancel: () => { void rpc("session/cancel", { sessionId }).catch(() => { /* 尽力而为 */ }); },
    detach: () => { for (const s of streams) s.close(); },
    close: () => { session.cancel(); session.detach(); },
  };
  if (wantEvents) {
    const follow = await openStream(auth, "session/follow", { args: { request: { address: { kind: "session", sessionId } } } }, (value) => {
      const item = value as { type?: string; event?: { type?: string } };
      if (item.type === "event" && item.event !== undefined) frames.push(item.event);
      else if (typeof item.type === "string") otherFrameCounts[`follow/${item.type}`] = (otherFrameCounts[`follow/${item.type}`] ?? 0) + 1;
    });
    streams.push(follow);
  }
  if (opts.projections === true) {
    // session/control 投影流:**无参**(生成声明 typert.remote-client.d.ts:
    // `control: (signal?) => AsyncIterable<SessionControlFrame>`,参数名即包裹键,
    // 无参 = 恰为空 {args:{}}——传 request 网关逐字拒收,实测 2026-08-31)。
    // 全局流,帧带 sessionId 自滤;基线帧 type:'baseline',投影帧 {type:'projection',sessionId,key,value,seq}。
    const control = await openStream(auth, "session/control", { args: {} }, (value) => {
      const item = value as { type?: string; sessionId?: string; key?: string; value?: unknown };
      if (item.type === "projection" && item.sessionId === sessionId && item.key === "tokenUsage") session.tokenUsage = item.value ?? null;
    });
    streams.push(control);
  }
  if (opts.questions === true) {
    // $events waterfall:问答与审批同流;网关点名 payload 必须恰为空 {args:{}}
    const events = await openStream(auth, "$events", { args: {} }, (value) => {
      const frame = value as { type?: string; event?: string; eventId?: string; agentId?: string; request?: { questions?: unknown[] } };
      if (frame.type !== "waterfall" || frame.agentId !== sessionId) return;
      if (frame.event === "user-questions/request" && frame.eventId !== undefined) {
        frames.push({ type: "__question", eventId: frame.eventId, questions: frame.request?.questions ?? [] } satisfies CheckpointFrame);
      } else {
        const key = String(frame.event ?? "waterfall/?");
        otherFrameCounts[key] = (otherFrameCounts[key] ?? 0) + 1;
        if (/approval|permission/i.test(key)) approvalFrames.push(JSON.stringify(frame).slice(0, 400));
      }
    });
    const ready = events.first as { type?: string; clientId?: string };
    if (ready.type !== "ready" || ready.clientId === undefined) {
      events.close();
      throw new Error(`$events: 首帧不是 ready 而是 ${JSON.stringify(events.first).slice(0, 200)}`);
    }
    eventsClientId = ready.clientId;
    streams.push(events);
  }
  return session;
}
