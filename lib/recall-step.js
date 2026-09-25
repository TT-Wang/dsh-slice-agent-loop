/** Original per-step tool records, with spill hydration and honest preview fallback. */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import { loggedTextParts, originalPartText } from './fold/results.js';
export const RECALL_STEP_TOOL_NAME = 'recall_step';
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
function stepRecord(events, turn, step) {
    const calls = [];
    const results = [];
    let ordinal = 0;
    for (const event of events) {
        if (event.surfaceOp !== undefined && event.surfaceOp !== 'append')
            continue;
        const d = event.data;
        if (!d || d.turn !== turn || d.step !== step)
            continue;
        if (event.type === 'tool/call') {
            const c = d;
            calls.push(`→ ${c.block?.name ?? c.name ?? '?'}(${c.block?.arguments ?? c.arguments ?? ''})`);
        }
        else if (event.type === 'tool/result') {
            ordinal += 1;
            const message = d.message;
            const parts = loggedTextParts(message.content);
            const target = typeof event.seq === 'number' ? `"seq":${event.seq},"formatVersion":${SESSION_FORMAT_VERSION}` : `"turn":${turn},"step":${step},"call":${ordinal}`;
            results.push({ parts, isError: message.isError === true, locator: `expand_result({${target}})` });
        }
    }
    return calls.length === 0 && results.length === 0 ? null : { calls, results };
}
function renderStep(record, turn, step) {
    const previews = record.results.some((result) => result.parts.some((part) => part.preview !== undefined));
    const lines = [
        `[sealed step · turn ${turn} · step ${step} · ${record.calls.length} call(s) · ${previews ? 'logged tool record; spilled results below are previews' : 'verbatim tool record'}: what was executed then, not current world state]`,
        '', '## Calls', ...(record.calls.length ? record.calls : ['(no calls recorded)']),
        '', previews ? '## Results (previews where marked; use the exact expansion locator for full text)' : '## Results (verbatim)',
    ];
    if (record.results.length === 0)
        lines.push('(no results recorded)');
    for (const result of record.results) {
        lines.push(result.isError ? '[error result]' : '[result]');
        for (const [index, part] of result.parts.entries()) {
            if (part.preview !== undefined) {
                lines.push(`[text part ${index + 1} preview — NOT full output; ${part.preview.bytes === undefined ? 'full text' : `${part.preview.bytes} bytes`} stored at ${part.preview.locator}; full text: ${result.locator}]`);
                if (part.hydrationError !== undefined)
                    lines.push(`[spill unavailable: ${part.hydrationError}]`);
            }
            lines.push(part.text);
        }
    }
    return lines.join('\n') + '\n';
}
/** Pure log-only rendering marks spill previews explicitly; the registered tool hydrates them. */
export function renderSealedStepPage(events, turn, step) {
    const record = stepRecord(events, turn, step);
    return record === null ? null : renderStep(record, turn, step);
}
export function recallStepToolDefinition() {
    return defineTool({
        name: RECALL_STEP_TOOL_NAME,
        description: 'Retrieve the verbatim tool calls and results of one earlier STEP of the current turn (or a past '
            + 'turn). Spilled results are hydrated from their stored bytes when available; unavailable spills '
            + 'are explicitly marked as previews with an exact expansion locator. Use it to retrieve original '
            + 'tool content omitted from a folded view: an earlier read, a listing or an error trace. Surface '
            + 'replacement copies are excluded. Serves from the durable session log. Narrower than recall_turn '
            + '(one step, not the whole turn) and far cheaper than its view "full"; when you only need one '
            + 'condensed result, expand_result({"turn": t, "step": s, "call": n}) is cheaper still.',
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
            const record = stepRecord(agent.session.snapshotEvents(), turn, step);
            if (record === null)
                throw new Error(`no recorded tool calls for turn ${turn} step ${step}`);
            for (const result of record.results) {
                for (const part of result.parts) {
                    if (part.preview === undefined)
                        continue;
                    try {
                        part.text = await originalPartText(part, result.locator);
                        delete part.preview;
                    }
                    catch (error) {
                        // Keep other available evidence and never pass a preview off as the complete result.
                        part.hydrationError = error instanceof Error ? error.message : String(error);
                    }
                }
            }
            return renderStep(record, turn, step);
        },
    });
}
