// assembler-sdk.ts — scaffold 页面的固定通信层(骨架,禁改;与 _vendor 的 JS 版
// 同源同纪律:围栏出声/服务脸发现/失败必报)。页面的一切出网必须经此模块——
// lint 门机械查 src/pages/ 里的裸 fetch/WebSocket。
// 路由三档(PAGE-SPEC 同款词汇):
//   face   确定性流:sqliteFace().sql(...)   —— 零模型,毫秒级
//   wire   判断流:createClient().ask(...)   —— 真 agent 会话
//   ai-thin 薄判断:aiFace().complete(...) —— 一次补全,不开会话
import cfg from '../../app.config.json'

export const APP = cfg as { scaffold: string; APP_NAME: string; PRESET_ID: string; WORKDIR: string }

// ── wire(会话面)────────────────────────────────────────────────────────────
export interface AskResult {
  reply: string
  fence: { ok: true; data: unknown } | { ok: false; reason: string }
}

export interface ClientHooks {
  onDelta?: (cumulative: string) => void
  onToolCall?: (name: string) => void
  onError?: (message: string) => void
}

// ── wire 双代核(BACKLOG 0.9)────────────────────────────────────────────────
// 0.1.2-alpha.1 起 wire 重铸:斜杠端点 + payload 双包裹(包裹键=控制器 TS 参数名)
// + prompt 自铸 requestId + 事件走 remote.mux 逻辑流。宿主可能原地升级未重启
// (幽灵宿主),页面按应答探代际:斜杠 session/list 404 = 旧代(点号端点),
// 200/401 = 新代。同源 cookie 浏览器自动带(30 天内开过一次 ?token= URL 即可)。
type WireCohort = 'new' | 'legacy'
let wireCohortP: Promise<WireCohort> | null = null

function wireCohort(): Promise<WireCohort> {
  wireCohortP ??= fetch('/api/session/list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'fe-cohort-probe', method: 'session/list', payload: { args: { _request: {} } } }),
  }).then((r) => (r.status === 404 ? 'legacy' as const : 'new' as const)).catch(() => 'new' as const)
  return wireCohortP
}

function unwrapRpc(label: string): (j: any) => any {
  return (j: any) => {
    if (!j.result || !j.result.ok) throw new Error(label + ' 失败:' + JSON.stringify(j.result?.error ?? j).slice(0, 200))
    return j.result.value
  }
}

/** wire 一元调用:旧点号规范名进,按宿主代际翻译;新代包裹键读网关报错自适应(不抄表)。 */
export async function wireRpc(method: string, payload: unknown): Promise<any> {
  const c = await wireCohort()
  const rpcId = 'fe-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  if (c === 'legacy') {
    const res = await fetch('/api/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    })
    return unwrapRpc(method)(await res.json())
  }
  const endpoint = method.replace('.', '/')
  let req: any = payload ?? {}
  if (endpoint === 'session/prompt' && req.requestId === undefined) req = { requestId: rpcId, ...req }
  const send = async (key: 'request' | '_request'): Promise<any> => {
    const res = await fetch('/api/' + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: { [key]: req } } }),
    })
    if (res.status === 401) throw new Error(endpoint + ' 失败:HTTP 401 未鉴权——先在本浏览器打开一次 host 启动打印的 ?token= 链接(30 天有效)')
    return res.json()
  }
  let j = await send('request')
  const err = j.result && !j.result.ok ? j.result.error : null
  if (err && /_request/.test(String(err.message ?? ''))) j = await send('_request')
  return unwrapRpc(endpoint)(j)
}

/** 订本会话事件流,断线自重连;onReady 在订阅真正建立后回调一次(事件形状两代一致)。 */
export function wireStream(getSessionId: () => string | null, onEvent: (e: any) => void, opts: { onReady?: () => void } = {}): { close: () => void } {
  let stopped = false
  let readyFired = false
  const fireReady = (): void => { if (!readyFired) { readyFired = true; opts.onReady?.() } }
  const connect = (c: WireCohort): void => {
    const sid = getSessionId()
    if (stopped || sid === null || sid === '') return
    const reconnect = (): void => { if (!stopped && getSessionId()) setTimeout(() => { connect(c) }, 1500) }
    if (c === 'legacy') {
      const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/events.mux')
      ws.onopen = fireReady
      ws.onmessage = (m) => {
        let f: any
        try { f = JSON.parse(String(m.data)) } catch { return }
        const p = f.payload
        if (p && p.type === 'session/event' && p.sessionId === getSessionId()) onEvent(p.event)
      }
      ws.onclose = reconnect
      return
    }
    const streamId = 'fe-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/remote.mux')
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: sid } } } } })) }
    ws.onmessage = (m) => {
      let f: any
      try { f = JSON.parse(String(m.data)) } catch { return }
      if (f.streamId !== streamId || f.type !== 'item') return
      const v = f.value
      if (v?.type === 'snapshot') fireReady() // follow 首帧 = snapshot,订阅已立
      else if (v?.type === 'event' && v.event) onEvent(v.event)
    }
    ws.onclose = reconnect
  }
  void wireCohort().then(connect)
  return { close: () => { stopped = true } }
}

export function extractFence(text: string): AskResult['fence'] {
  const fences = [...String(text ?? '').matchAll(/```json\s*([\s\S]*?)```/g)]
  if (fences.length === 0) return { ok: false, reason: '回复末尾没有 ```json 围栏(agent 未按页面契约输出)' }
  try {
    return { ok: true, data: JSON.parse(fences[fences.length - 1][1]) }
  } catch (e) {
    return { ok: false, reason: 'json 围栏解析失败:' + String((e as Error).message).slice(0, 120) }
  }
}

export function createClient(hooks: ClientHooks = {}) {
  let sessionId: string | null = null
  let ws: { close: () => void } | null = null
  let busy = false
  let replyBuf = ''
  let waiters: Array<(r: AskResult) => void> = []

  const rpc = wireRpc // 双代翻译在 wire 核里,调用面保持旧点号规范名

  function textOf(e: any): string {
    const c = e?.data?.message?.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map((b: any) => (b && b.type === 'text' ? b.text : '')).join('')
    return ''
  }

  function handle(e: any): void {
    if (e.type === 'assistant/message') {
      const t = textOf(e)
      if (t) { replyBuf += (replyBuf === '' ? '' : '\n') + t; hooks.onDelta?.(replyBuf) }
    } else if (e.type === 'tool/call') {
      hooks.onToolCall?.(String(e?.data?.name ?? '?').replace(/^mcp__/, '').replace(/__/, ' · '))
    } else if (e.type === 'turn/end') {
      busy = false
      const w = waiters; waiters = []
      const out: AskResult = { reply: replyBuf, fence: extractFence(replyBuf) }
      w.forEach((fn) => fn(out))
    }
  }

  async function ensureSession(): Promise<void> {
    if (sessionId) return
    const v = await rpc('session.create', { cwd: APP.WORKDIR, agentPreset: APP.PRESET_ID })
    sessionId = v.sessionId
    // 等订阅真正建立再放行发问(legacy=ws.open,new=follow 首帧 snapshot)——
    // create 与订阅之间的早到帧不能丢。
    await new Promise<void>((r) => {
      ws = wireStream(() => sessionId, handle, { onReady: r })
    })
  }

  async function ask(text: string): Promise<AskResult> {
    if (busy) throw new Error('上一轮还在进行')
    replyBuf = ''; busy = true
    try {
      await ensureSession()
      await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })
    } catch (err) {
      busy = false
      hooks.onError?.(String((err as Error)?.message ?? err))
      throw err
    }
    return new Promise<AskResult>((resolve) => { waiters.push(resolve) })
  }

  return { ask, rpc, get busy() { return busy } }
}

// ── 服务脸(确定性流)────────────────────────────────────────────────────────
export interface SqliteFace {
  sql: (sql: string, params?: unknown[]) => Promise<{ rows?: Array<Record<string, unknown>>; changes?: number; lastInsertRowid?: number }>
  schema: () => Promise<{ tables: Array<{ name: string; columns: Array<{ name: string; type: string; notnull: boolean; pk: boolean }> }> }>
}

let svcCache: Promise<any> | null = null

export function discoverServices(): Promise<any> {
  svcCache ??= fetch('/assembler/ui/' + encodeURIComponent(APP.PRESET_ID) + '/.service')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  return svcCache
}

export async function sqliteFace(): Promise<SqliteFace | null> {
  const svc = await discoverServices()
  if (!svc?.sqlite) return null
  const base: string = svc.sqlite.url
  const token: string = svc.sqlite.token
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(base + path, { ...init, headers: { 'X-Service-Token': token, ...(init.headers ?? {}) } })
    const j = await r.json()
    if (j.error) throw new Error(j.error)
    return j
  }
  return {
    sql: (sql, params) => call('/sql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, params: params ?? [] }) }),
    schema: () => call('/schema'),
  }
}

// ── 通用取脸口(不是每来一件零件就加一个函数)──────────────────────────────
// 病史:SDK 曾只有 sqlite/ai/files 三个固定口,写手要用语音脸时够不着,转去补骨架
// 撞沙箱、整题颗粒无收。通用化后**新采购的带脸零件自动可用**。
// 用法:const f = await face('speech'); await f.get('/audio/x.mp3');
//       <audio src={f.mediaUrl('/speak?text=你好')} />   ← token 进 URL,标签带不了头
export interface Face {
  name: string
  url: string
  meta: Record<string, unknown>
  get: (path: string) => Promise<any>
  post: (path: string, body?: unknown) => Promise<any>
  send: (path: string, raw: BodyInit) => Promise<any>
  mediaUrl: (path: string) => string
}

/** 这个 preset 挂载了哪些服务脸(名字表)——写手先问这个,再决定怎么写。 */
export async function faces(): Promise<string[]> {
  const svc = await discoverServices()
  return svc ? Object.keys(svc) : []
}

export async function face(name: string): Promise<Face | null> {
  const svc = await discoverServices()
  const entry = svc?.[name]
  if (!entry?.url) return null
  const base: string = entry.url
  const token: string = entry.token
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(base + path, { ...init, headers: { 'X-Service-Token': token, ...(init.headers ?? {}) } })
    const ct = r.headers.get('content-type') ?? ''
    if (!ct.includes('application/json')) {
      if (!r.ok) throw new Error(`${name}${path} HTTP ${r.status}`)
      return r
    }
    const j = await r.json()
    if (j.error) throw new Error(j.error)
    return j
  }
  return {
    name, url: base, meta: entry,
    get: (path) => call(path),
    post: (path, body) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
    send: (path, raw) => call(path, { method: 'POST', body: raw }),
    mediaUrl: (path) => base + path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token),
  }
}

/** ai 服务脸(ai-thin 路由):一次补全,不开会话——薄判断的正确档位。 */
export interface AiFace {
  complete: (req: { prompt: string; system?: string; model?: string; maxTokens?: number }) => Promise<{ model: string; text: string; usage?: { prompt: number; completion: number } }>
}

export async function aiFace(): Promise<AiFace | null> {
  const svc = await discoverServices()
  if (!svc?.ai) return null
  const base: string = svc.ai.url
  const token: string = svc.ai.token
  return {
    complete: async (req) => {
      const r = await fetch(base + '/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Service-Token': token },
        body: JSON.stringify(req),
      })
      const j = await r.json()
      if (j.error) throw new Error(j.error)
      return j
    },
  }
}

/** 公共文件通道:大字节直传/取回,不过模型(页面喂文件的正确姿势)。 */
export interface FilesFace {
  upload: (name: string, body: Blob | ArrayBuffer | string) => Promise<{ ok: boolean; name: string; path: string; bytes: number }>
  list: () => Promise<{ files: Array<{ name: string; bytes: number; modifiedAt: string }>; dir: string }>
  fileUrl: (name: string) => string
}

export async function filesFace(): Promise<FilesFace | null> {
  const svc = await discoverServices()
  if (!svc?.files) return null
  const base: string = svc.files.url
  const token: string = svc.files.token
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(base + path, { ...init, headers: { 'X-Service-Token': token, ...(init.headers ?? {}) } })
    const j = await r.json()
    if (j.error) throw new Error(j.error)
    return j
  }
  return {
    upload: (name, body) => call('/upload/' + encodeURIComponent(name), { method: 'POST', body: body as BodyInit }),
    list: () => call('/list'),
    fileUrl: (name) => base + '/file/' + encodeURIComponent(name),
  }
}

// ── 通用原子 ────────────────────────────────────────────────────────────────
/** 回车触发(IME 守卫内置:选字确认回车不触发)。 */
export function bindEnter(el: HTMLElement, fn: () => void): void {
  el.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fn() }
  })
}
