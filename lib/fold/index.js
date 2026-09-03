/**
 * tool-result-fold — 给 dsh 默认 transcript loop 加"轮内折叠"的独立插件(2026-09-04)。
 *
 * 正式家在独立仓库 https://github.com/TT-Wang/dsh-tool-result-fold(`dsh plugin add github:TT-Wang/dsh-tool-result-fold`);
 * 这里的副本供本仓库的 runner(`--arm transcript-fold`)与契约测试使用,两边源码同源,改动请先改那边。
 *
 * 机制:每步开始前(`agent/pre-step`),把上一步刚落盘的工具结果按内容路由折成紧凑视图,以
 * **surface 替换事件**遮蔽原节点(`surfaceOp: replace`,引用被遮蔽的 seq)——与 dsh 自带的
 * compaction-tool-result-pruner 同一机制,会话不变量明确允许"引用被替换事件的内容改写"。
 * 原文原样留在日志里,`expand_result` 逐字取回;模型看到的上下文只追加不改写,前缀缓存不受影响。
 *
 * 路由规则复用 slice 的 result-digest(Headroom 式):代码与 grep/glob 不折,日志错误优先,
 * 文档/数据留头尾与结构行。默认 loop 不装 slice loop 也能用;两者不要同时挂(slice 自己折)。
 */
import { Service } from '@deepseek-ai/cordis';
import { freezeMessage } from '@deepseek-ai/dsh-llm';
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { digestToolResult, resolveDigestPolicy } from '../slice/result-digest.js';
export const name = 'tool-result-fold';
export const EXPAND_TOOL_NAME = 'expand_result';
/** 系统提示词里的可供性说明:模型得知道视图是折过的、原文一步可取。 */
export const FOLD_AFFORDANCE = `<fold>
Your context is append-only: nothing already in it is rewritten or dropped. Large tool results are condensed by the host as they enter. Data and document reads keep their first and last lines and every structured line (key = value, key: value, headings, section markers); build/test/log output keeps every error, failure and warning line with surrounding context, stack traces and summary lines; source code and grep/glob results are never condensed. Everything else is replaced by exact markers \`…[+N lines / M chars]…\`, and the view's first line names the call that returns the full result: ${EXPAND_TOOL_NAME}({"turn": t, "step": s, "call": n}), durable and one call away. So read a whole file in one call rather than paging it with offset/limit — a full read costs no more context than its condensed view, while every page costs a step.
</fold>`;
function callPath(args) {
    if (typeof args !== 'object' || args === null)
        return undefined;
    const bag = args;
    return typeof bag.file_path === 'string' ? bag.file_path : typeof bag.path === 'string' ? bag.path : undefined;
}
function parseArgs(raw) {
    if (typeof raw !== 'string')
        return raw;
    try {
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
function resultChars(message) {
    let n = 0;
    for (const b of message.content)
        for (const inner of b.content ?? [])
            if (inner.type === 'text' && typeof inner.text === 'string')
                n += inner.text.length;
    return n;
}
function resultText(block) {
    return (block.content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}
/** 一个会话的折叠状态:处理游标、callId → 工具名/路径、统计。 */
class SessionFolder {
    session;
    policy;
    pinSteps;
    backoffAfter;
    pinMaxChars;
    cursor = 0;
    calls = new Map();
    /** 每步的追加态结果计数(call 序号 = 该步第 n 个结果,expand_result 用同一规则定位)。 */
    stats = { folded: 0, charsBefore: 0, charsAfter: 0, expanded: 0, backedOff: [] };
    /** (turn:step:call) → 被折结果的工具名;展开时据此记账。 */
    foldedAt = new Map();
    perTool = new Map();
    constructor(session, policy, pinSteps, backoffAfter, pinMaxChars) {
        this.session = session;
        this.policy = policy;
        this.pinSteps = pinSteps;
        this.backoffAfter = backoffAfter;
        this.pinMaxChars = pinMaxChars;
    }
    /** 把游标之后新落盘的、仍在 surface 上的追加态工具结果折掉。 */
    fold() {
        const session = this.session;
        const end = session.seq;
        const onSurface = new Set(session.surface.nodes);
        const ordinal = new Map();
        for (let i = this.cursor; i < end; i += 1) {
            const event = session.eventAt(i);
            if (event === undefined)
                continue;
            if (event.type === 'tool/call') {
                const d = event.data;
                this.calls.set(d.callId, { name: d.name, path: callPath(parseArgs(d.arguments)) });
                if (d.name === EXPAND_TOOL_NAME)
                    this.noteExpansion(parseArgs(d.arguments));
                continue;
            }
            if (event.type !== 'tool/result' || !isAppendSurfaceEvent(event))
                continue;
            const d = event.data;
            const key = `${d.turn}:${d.step}`;
            const n = (ordinal.get(key) ?? this.countBefore(d.turn, d.step, i)) + 1;
            ordinal.set(key, n);
            if (!onSurface.has(i))
                continue;
            if (d.step <= this.pinSteps && resultChars(d.message) < this.pinMaxChars)
                continue;
            this.foldOne(i, event, d, n);
        }
        this.cursor = end;
    }
    /** expand_result 被调用:记到被折结果的工具名上;达到退避阈值就把该工具列入不折名单。 */
    noteExpansion(args) {
        const a = (typeof args === 'object' && args !== null ? args : {});
        const key = `${Number(a.turn)}:${Number(a.step)}:${a.call === undefined ? 1 : Number(a.call)}`;
        const tool = this.foldedAt.get(key);
        if (tool === undefined)
            return;
        this.stats.expanded += 1;
        const t = this.perTool.get(tool) ?? { folded: 0, expanded: 0 };
        t.expanded += 1;
        this.perTool.set(tool, t);
        if (t.expanded >= this.backoffAfter && t.expanded * 2 >= t.folded && !this.stats.backedOff.includes(tool))
            this.stats.backedOff.push(tool);
    }
    /** 同一步里游标之前已有几个追加态结果(游标跨步时序号要接上)。 */
    countBefore(turn, step, upto) {
        let n = 0;
        for (let i = Math.max(0, upto - 64); i < upto; i += 1) {
            const e = this.session.eventAt(i);
            if (e?.type === 'tool/result' && isAppendSurfaceEvent(e)) {
                const d = e.data;
                if (d.turn === turn && d.step === step)
                    n += 1;
            }
        }
        return n;
    }
    foldOne(seq, event, d, n) {
        const first = d.message.content[0];
        if (!first || first.type !== 'tool-result' || first.isError || !first.content)
            return;
        const info = this.calls.get(String(first.toolCallId ?? d.message.source?.callId ?? '')) ?? { name: 'tool' };
        if (info.name === EXPAND_TOOL_NAME)
            return;
        if (this.stats.backedOff.includes(info.name))
            return;
        let changed = false;
        let before = 0;
        let after = 0;
        const hint = `${EXPAND_TOOL_NAME}({"turn": ${d.turn}, "step": ${d.step}, "call": ${n}})`;
        const inner = first.content.map((b) => {
            if (b.type !== 'text' || typeof b.text !== 'string')
                return b;
            before += b.text.length;
            const r = digestToolResult(b.text, { tool: info.name, ...(info.path ? { path: info.path } : {}) }, this.policy);
            after += r.text.length;
            if (!r.digested)
                return b;
            changed = true;
            return { ...b, text: `[${info.name}${info.path ? ' ' + info.path : ''} · ${r.kind} · ${r.totalLines} lines, ${r.keptLines} kept · ${hint} returns the full text]\n${r.text}` };
        });
        if (!changed)
            return;
        const message = freezeMessage({ ...d.message, content: [{ ...first, content: inner }] });
        this.session.append('tool/result', { ...event.data, message }, {
            surfaceOp: { op: 'replace', start: seq, end: seq },
            sourceEventSeqs: [seq],
        });
        this.stats.folded += 1;
        this.stats.charsBefore += before;
        this.stats.charsAfter += after;
        this.foldedAt.set(`${d.turn}:${d.step}:${n}`, info.name);
        const t = this.perTool.get(info.name) ?? { folded: 0, expanded: 0 };
        t.folded += 1;
        this.perTool.set(info.name, t);
    }
}
/** 从日志取某步第 n 个追加态工具结果的原文(替换事件不算)。 */
export function fullResultAt(events, turn, step, call) {
    const calls = new Map();
    let n = 0;
    for (const e of events) {
        if (e.type === 'tool/call') {
            const d = e.data;
            calls.set(d.callId, d.name);
            continue;
        }
        if (e.type !== 'tool/result' || !isAppendSurfaceEvent(e))
            continue;
        const d = e.data;
        if (d.turn !== turn || d.step !== step)
            continue;
        n += 1;
        if (n !== call)
            continue;
        const first = d.message.content[0];
        return { name: calls.get(String(first.toolCallId ?? d.message.source?.callId ?? '')) ?? 'tool', text: resultText(first) };
    }
    return null;
}
export function expandResultToolDefinition() {
    return defineTool({
        name: EXPAND_TOOL_NAME,
        description: 'Return the FULL text of a tool result that the host condensed on entry. The condensed view\'s first line names the call: turn, step and the result\'s ordinal within that step (1-based).',
        parameters: {
            turn: { type: 'number', required: true, description: 'Turn number from the condensed view\'s first line.' },
            step: { type: 'number', required: true, description: 'Step number from the condensed view\'s first line.' },
            call: { type: 'number', description: 'Which result of that step (1-based; default 1).' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args, exec) => {
            const agent = exec.agent;
            if (agent === undefined)
                throw new Error(`${EXPAND_TOOL_NAME} runs only inside an agent loop`);
            const a = args;
            const turn = Number(a.turn);
            const step = Number(a.step);
            const call = a.call === undefined ? 1 : Number(a.call);
            if (!Number.isInteger(turn) || !Number.isInteger(step) || turn < 1 || step < 1 || !Number.isInteger(call) || call < 1) {
                throw new Error(`${EXPAND_TOOL_NAME} needs {"turn": N, "step": M} (and optional "call": K), all positive integers`);
            }
            const hit = fullResultAt(agent.session.snapshotEvents(), turn, step, call);
            if (hit === null)
                throw new Error(`no tool result recorded at turn ${turn} step ${step} call ${call}`);
            return `[full result of ${hit.name} · turn ${turn} step ${step} call ${call}]\n${hit.text}`;
        },
    });
}
/** 供 runner/评测读取:某会话的折叠统计。 */
export const FOLD_STATS = new WeakMap();
/** cordis 插件本体:声明注入的服务(tools、systemPrompt),挂载即生效,卸载即回收(ctx.effect)。 */
export class ToolResultFold extends Service {
    static inject = ['tools', 'systemPrompt'];
    constructor(ctx, config = {}) {
        super(ctx, 'toolResultFold');
        const policy = resolveDigestPolicy(config.digest);
        const enabled = config.enabled ?? true;
        const pinSteps = config.pinSteps ?? 2;
        if (!Number.isInteger(pinSteps) || pinSteps < 0)
            throw new Error('pinSteps must be a non-negative integer');
        const pinMaxChars = config.pinMaxChars ?? 8_000;
        if (!(pinMaxChars >= 0))
            throw new Error('pinMaxChars must be >= 0');
        const backoffAfter = config.backoffAfterExpansions ?? 2;
        if (!Number.isInteger(backoffAfter) || backoffAfter < 1)
            throw new Error('backoffAfterExpansions must be an integer >= 1');
        ctx.effect(() => ctx.tools.register(expandResultToolDefinition()), 'toolResultFold.expandResult()');
        if (!enabled)
            return;
        ctx.effect(() => ctx.systemPrompt.section({ name: 'fold:affordance', order: -900, text: FOLD_AFFORDANCE }), 'toolResultFold.affordance()');
        const folders = new WeakMap();
        ctx.on('agent/pre-step', ({ agent }, next) => {
            const session = agent.session;
            let folder = folders.get(session);
            if (folder === undefined) {
                folder = new SessionFolder(session, policy, pinSteps, backoffAfter, pinMaxChars);
                folders.set(session, folder);
                FOLD_STATS.set(session, folder.stats);
            }
            folder.fold();
            return next();
        });
    }
}
export default ToolResultFold;
