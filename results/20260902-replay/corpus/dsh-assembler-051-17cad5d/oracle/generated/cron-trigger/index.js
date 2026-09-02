// @dsh-index/cron-trigger — 触发器零件(机器脸天生;零件分类法盘出的缺件)。
// 让任何已交付的 preset 免改造获得"无人值守"形态:到点后本零件像探针驱动器一样
// 走 host 公开 wire(session.create + session.prompt)开一个真会话、注入任务——
// 不需要 host 任何配合。任务表持久化在 PART_WORKDIR/cron-tasks.json,进程重启
// (会话重开)自动恢复。
//
// 设计裁定:
// - fire 是 fire-and-forget(返回 sessionId 不等完成):无人值守的完成判据归
//   任务自己的落库效果,考官打一发后查效果(触发考模式:fire-task → 查账)。
// - 到点判定用 cron-parser(与 cron-parse 零件同上游);计时器 unref(质检门
//   契约:stdio 关闭进程必须退场)。
// - wire 端口来自 env CRON_WIRE_PORT(部署参数,装配时可 param 覆盖,默认 3096)。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import cronParser from 'cron-parser';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const WIRE_PORT = Number(process.env.CRON_WIRE_PORT || 3096);
const WORKDIR = process.env.PART_WORKDIR || process.cwd();
const TASKS_FILE = join(WORKDIR, 'cron-tasks.json');
const server = new McpServer({ name: 'cron-trigger', version: '0.0.1' });

function loadTasks() {
	try { return existsSync(TASKS_FILE) ? JSON.parse(readFileSync(TASKS_FILE, 'utf8')) : []; } catch { return []; }
}
function saveTasks(tasks) {
	mkdirSync(WORKDIR, { recursive: true });
	writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}
function nextFire(cron, from = new Date()) {
	return cronParser.parseExpression(cron, { currentDate: from }).next().toDate().toISOString();
}
const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

/**
 * 走 host 公开 wire 开真会话注入任务(与验收探针同一条路)。
 * 零件自包含,不能 import 仓库 lib——内联迷你双代客户端(BACKLOG 0.9):
 * 探协议定代际(旧代点号无鉴权;新代 0.1.2-alpha.1 起斜杠 + cookie + 双包裹 +
 * requestId)。新代 cookie 由落盘密钥签名、跨 host 重启有效:优先读共享缓存
 * ~/.dsh/assembler/wire-auth.json(与装配器主客户端同一份),缺则扫启动日志换新。
 */
async function fireTask(task) {
	const base = `http://127.0.0.1:${WIRE_PORT}`;
	const post = async (path, body, headers = {}) => {
		const res = await fetch(`${base}${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(20_000),
		});
		const text = await res.text();
		let j = null;
		try { j = JSON.parse(text); } catch { /* 非 JSON */ }
		return { status: res.status, j, text };
	};
	// 探代际:旧 wire 无鉴权即应答,新 wire 401
	const probe = await post('/api/agentPreset.list', { type: 'client-request', rpcId: 'cron-probe', method: 'agentPreset.list', payload: {} }).catch(() => null);
	const legacy = probe !== null && probe.status === 200 && probe.j?.result?.ok === true;

	let rpc;
	if (legacy) {
		rpc = async (method, payload) => {
			const { j } = await post(`/api/${method}`, { type: 'client-request', rpcId: `cron-${Date.now()}`, method, payload });
			if (!j?.result?.ok) throw new Error(`${method}: ${JSON.stringify(j?.result?.error ?? j).slice(0, 300)}`);
			return j.result.value;
		};
	} else {
		const dsh = process.env.DSH_HOME ?? join(homedir(), '.dsh');
		const cachePath = join(dsh, 'assembler', 'wire-auth.json');
		let cookie = null;
		try { cookie = JSON.parse(readFileSync(cachePath, 'utf8'))[base]?.cookie ?? null; } catch { /* 无缓存 */ }
		if (cookie === null) {
			// 启动日志里捞 ?token= 行(token 只打一次 stdout 不落盘),换 30 天 cookie
			const logs = [join(dsh, 'web-host.log')];
			try { for (const f of readdirSync(join(dsh, 'logs'))) if (f.endsWith('.log')) logs.push(join(dsh, 'logs', f)); } catch { /* 无日志目录 */ }
			let url = null;
			const re = new RegExp(`https?://[^\\s]*:${WIRE_PORT}/?\\?token=[A-Za-z0-9_-]+`, 'g');
			for (const f of logs) { try { const m = readFileSync(f, 'utf8').match(re); if (m?.length) url = m[m.length - 1]; } catch { /* 跳过 */ } }
			if (url === null) throw new Error(`定时开火失败:host ${base} 是新 wire(需 cookie 鉴权),但共享缓存 ${cachePath} 无本 origin 条目,启动日志(${dsh}/logs/*.log)也无 :${WIRE_PORT} 的 ?token= 行。下一步:重启 host 并把 stdout 落到上述日志路径,或先跑一次装配器的 verify(会写缓存)。`);
			const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
			const sc = res.headers.get('set-cookie');
			if (sc === null) throw new Error(`定时开火失败:token 换 cookie 无 set-cookie(HTTP ${res.status})——token 已随 host 重启作废,重捞日志最新行`);
			cookie = sc.split(';', 1)[0];
			try { mkdirSync(join(dsh, 'assembler'), { recursive: true }); const c = (() => { try { return JSON.parse(readFileSync(cachePath, 'utf8')); } catch { return {}; } })(); c[base] = { origin: base, cookie, obtainedAt: Date.now() }; writeFileSync(cachePath, JSON.stringify(c, null, 2) + '\n'); } catch { /* 缓存写不进不拦路 */ }
		}
		rpc = async (method, payload) => {
			const endpoint = method.replace('.', '/');
			const req = endpoint === 'session/prompt' ? { requestId: `cron-${Date.now()}-${Math.random().toString(36).slice(2)}`, ...payload } : payload;
			const send = (key) => post(`/api/${endpoint}`, { type: 'client-request', rpcId: `cron-${Date.now()}`, method: endpoint, payload: { args: { [key]: req } } }, { cookie });
			let r = await send('request');
			const err = r.j?.result?.ok === false ? r.j.result.error : null;
			if (err !== null && /_request/.test(String(err.message ?? ''))) r = await send('_request');
			if (r.status === 401) throw new Error(`${endpoint}: HTTP 401——缓存 cookie 失效,删 ${cachePath} 后重试(会自动重换)`);
			if (!r.j?.result?.ok) throw new Error(`${endpoint}: ${JSON.stringify(r.j?.result?.error ?? r.text).slice(0, 300)}`);
			return r.j.result.value;
		};
	}
	const { sessionId } = await rpc('session.create', { cwd: WORKDIR, agentPreset: task.presetId });
	await rpc('session.prompt', {
		sessionId,
		mode: 'queue',
		content: [{ type: 'text', text: `[定时任务 ${task.id} 自动触发,无人在场——独立完成,不要向任何人提问;完成标准以任务描述为准,做完为止,不要因为一次尝试失败就停]\n${task.prompt}` }],
	});
	return sessionId;
}

server.registerTool('cron-info', {
	title: '触发器信息',
	description: '本零件让 preset 获得定时无人值守能力:schedule-task 登记 cron 任务(到点自动开真会话执行),list/cancel 管理,fire-task 立即触发一次(考官验收用)。任务持久化于工作区 cron-tasks.json。',
	inputSchema: {},
}, async () => text({ wirePort: WIRE_PORT, tasksFile: TASKS_FILE, tasks: loadTasks().length, tick: '30s' }));

server.registerTool('schedule-task', {
	title: '登记定时任务',
	description: '登记一个 cron 定时任务:到点自动以指定 preset 开一个真会话执行 prompt(无人值守)。cron 用五段表达式(分 时 日 月 周,如 "0 9 1 * *" = 每月 1 日 09:00)。返回任务 id 与未来 3 次触发时间。',
	inputSchema: {
		cron: z.string().describe('五段 cron 表达式,如 0 9 * * 1(每周一 09:00)'),
		prompt: z.string().describe('到点注入会话的任务指令(自给自足:无人在场,写清完成标准与落库要求)'),
		presetId: z.string().describe('以哪个 preset 开会话执行(通常是本 agent 自己的 preset id)'),
		id: z.string().optional().describe('任务 id(缺省自动生成 task-N)'),
	},
}, async ({ cron, prompt, presetId, id }) => {
	let parsed;
	try { parsed = cronParser.parseExpression(cron); } catch (e) { return text({ error: `cron 表达式不合法:${e.message}` }); }
	const tasks = loadTasks();
	const tid = id && id.trim() !== '' ? id.trim() : `task-${tasks.length + 1}`;
	if (tasks.some((t) => t.id === tid)) return text({ error: `任务 id 已存在:${tid}(先 cancel-task 或换 id)` });
	const task = { id: tid, cron, prompt, presetId, createdAt: new Date().toISOString(), nextFireAt: nextFire(cron), lastFiredAt: null, fires: 0 };
	tasks.push(task);
	saveTasks(tasks);
	const next3 = [];
	for (let i = 0; i < 3; i++) next3.push(parsed.next().toDate().toISOString());
	return text({ scheduled: tid, presetId, next3 });
});

server.registerTool('list-tasks', {
	title: '列出定时任务',
	description: '列出全部已登记的定时任务(id/cron/下次触发/累计触发次数)。',
	inputSchema: {},
}, async () => text({ tasks: loadTasks().map((t) => ({ id: t.id, cron: t.cron, presetId: t.presetId, nextFireAt: t.nextFireAt, fires: t.fires, lastFiredAt: t.lastFiredAt })) }));

server.registerTool('cancel-task', {
	title: '取消定时任务',
	description: '按 id 取消一个定时任务。',
	inputSchema: { id: z.string() },
}, async ({ id }) => {
	const tasks = loadTasks();
	const left = tasks.filter((t) => t.id !== id);
	if (left.length === tasks.length) return text({ error: `无此任务:${id}` });
	saveTasks(left);
	return text({ cancelled: id, remaining: left.length });
});

server.registerTool('fire-task', {
	title: '立即触发一次',
	description: '不等到点,立即触发一次指定任务(触发面考官用:打一发,然后到库里/工作区验后果)。fire-and-forget:返回被开会话的 sessionId,任务执行的完成判据是它的落库效果。',
	inputSchema: { id: z.string() },
}, async ({ id }) => {
	const tasks = loadTasks();
	const task = tasks.find((t) => t.id === id);
	if (!task) return text({ error: `无此任务:${id}` });
	try {
		const sessionId = await fireTask(task);
		task.lastFiredAt = new Date().toISOString();
		task.fires += 1;
		task.nextFireAt = nextFire(task.cron);
		saveTasks(tasks);
		return text({ fired: id, sessionId, note: '任务会话已启动(异步执行);效果以落库/工作区产物为准' });
	} catch (e) {
		return text({ error: `触发失败:${e.message}(host 没在 ${WIRE_PORT} 上跑?)` });
	}
});

// ── 到点巡检(30s 一拍;unref 保证 stdio 关闭即退场)─────────────────────────
const tick = setInterval(() => {
	const tasks = loadTasks();
	const now = Date.now();
	let dirty = false;
	for (const task of tasks) {
		if (task.nextFireAt && new Date(task.nextFireAt).getTime() <= now) {
			task.nextFireAt = nextFire(task.cron); // 先推进指针再触发:失败不重复轰炸
			task.lastFiredAt = new Date().toISOString();
			task.fires += 1;
			dirty = true;
			fireTask(task).catch((e) => { console.error(`[cron-trigger] ${task.id} 触发失败:${e.message}`); });
		}
	}
	if (dirty) saveTasks(tasks);
}, 30_000);
tick.unref();

await server.connect(new StdioServerTransport());
