/**
 * recall-step.ts — 轮内封存的召回工具:逐字取回某一步的完整工具调用与结果。
 *
 * 与 recall_turn 同源:从持久会话日志(tool/call · tool/result 事件)取,不依赖
 * 内存轨迹,agent 重建后同样可用。
 *
 * turn/step 从哪来:在线路径上,归档检查点 `[slice checkpoint v1 …]`(src/context.ts)只给
 * recall_turn 与 expand_result({"seq": q}) 定位,写着 turn/step 的是折叠视图首行
 * (`expand_result({"turn": t, "step": s, "call": n})`)与 fold 可供性(src/fold/index.ts),
 * 模型据此索引整步。src/lab/step-tape.ts 的封存条目首行是同一形状,但它不在运行时路径上。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
export const RECALL_STEP_TOOL_NAME = 'recall_step';
function resultText(message) {
    let isError = false;
    const parts = [];
    for (const block of message.content) {
        if (block.type !== 'tool-result')
            continue;
        if (block.isError)
            isError = true;
        for (const inner of block.content ?? [])
            if (inner.type === 'text' && inner.text)
                parts.push(inner.text);
    }
    return { text: parts.join('\n'), isError };
}
function parseInt1(value) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1)
        return value;
    if (typeof value === 'string') {
        const m = value.trim().match(/(\d+)\s*$/);
        if (m) {
            const n = Number(m[1]);
            if (Number.isInteger(n) && n >= 1)
                return n;
        }
    }
    return null;
}
/** 渲染某轮某步的全部调用与结果;该步无记录返回 null。 */
export function renderSealedStepPage(events, turn, step) {
    const calls = [];
    const results = [];
    for (const event of events) {
        if (event.surfaceOp !== undefined && event.surfaceOp !== 'append')
            continue;
        const d = event.data;
        if (!d || d.turn !== turn || d.step !== step)
            continue;
        if (event.type === 'tool/call') {
            const c = d;
            const name = c.block?.name ?? c.name ?? '?';
            const args = c.block?.arguments ?? c.arguments ?? '';
            calls.push(`→ ${name}(${args})`);
        }
        else if (event.type === 'tool/result') {
            const { text, isError } = resultText(d.message);
            results.push(`${isError ? '[error result]' : '[result]'}\n${text}`);
        }
    }
    if (calls.length === 0 && results.length === 0)
        return null;
    const lines = [
        `[sealed step · turn ${turn} · step ${step} · ${calls.length} call(s) · verbatim tool record: what was executed then, not current world state]`,
        '',
        '## Calls',
        ...(calls.length ? calls : ['(no calls recorded)']),
        '',
        '## Results (verbatim)',
        ...(results.length ? results : ['(no results recorded)']),
    ];
    return lines.join('\n') + '\n';
}
export function recallStepToolDefinition() {
    return defineTool({
        name: RECALL_STEP_TOOL_NAME,
        description: 'Retrieve the verbatim tool calls and full results of one earlier STEP of the current turn (or a past '
            + 'turn). Use it to retrieve original tool content omitted from a folded view: an earlier read, '
            + 'a listing or an error trace. Surface replacement copies are excluded. Serves from the durable '
            + 'session log. Narrower and cheaper than recall_turn (one step, not the whole turn); when you only '
            + 'need one condensed result of that step, expand_result({"turn": t, "step": s, "call": n}) is cheaper still.',
        parameters: {
            turn: { type: 'string', required: true, description: 'Turn number as shown in the sealed entry, e.g. "3".' },
            step: { type: 'string', required: true, description: 'Step number as shown in the sealed entry, e.g. "12".' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args, exec) => {
            const agent = exec.agent;
            if (agent === undefined)
                throw new Error('recall_step runs only inside an agent loop');
            const a = args;
            const turn = parseInt1(a?.turn);
            const step = parseInt1(a?.step);
            if (turn === null || step === null)
                throw new Error('recall_step needs {"turn": "N", "step": "M"}');
            const page = renderSealedStepPage(agent.session.snapshotEvents(), turn, step);
            if (page === null)
                throw new Error(`no recorded tool calls for turn ${turn} step ${step}`);
            return page;
        },
    });
}
