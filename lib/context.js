/** Durable conversational replacement on the stock ordered surface. */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { deriveEventMessage } from '@deepseek-ai/dsh-session';
import { buildContinuity } from './state/reducer.js';
import { admitTape } from './slice/admission.js';
import { TapeEntry, renderTapeReply, tapeRender } from './slice/tape.js';
export const HISTORY_SOURCE = 'slice:history';
export const HISTORY_HEADER = '# SESSION TAPE (sealed conversational history; not current-world truth)\n';
export class SliceBudgetError extends Error {
    constructor(message) { super(message); this.name = 'SliceBudgetError'; }
}
function ours(event) {
    return event.type === 'user/message' && event.data.source.kind === 'plugin'
        && event.data.source.plugin === HISTORY_SOURCE;
}
/** Preserve context ownership and multimodal user content at their original positions. */
function conversational(event) {
    if (event.type === 'assistant/message' || event.type === 'tool/result')
        return true;
    return event.type === 'user/message' && (ours(event)
        || (event.surfaceOp === 'append' && event.data.source.kind === 'user' && event.data.content.every(block => block.type === 'text')));
}
function textOf(message) {
    return message.content.map(block => block.type === 'text' ? block.text : '').join('');
}
function originsOf(session, seqs) {
    const seen = new Set();
    const found = new Map();
    const visit = (seq) => {
        if (seen.has(seq))
            return;
        seen.add(seq);
        const event = session.eventAt(seq);
        if (!event)
            return;
        // Only expand our own summaries. Other producers' canonical replacements
        // stay authoritative; resurrecting their shadowed messages would undo them.
        if (ours(event) && 'sourceEventSeqs' in event && event.sourceEventSeqs) {
            event.sourceEventSeqs.forEach(visit);
        }
        else
            found.set(seq, event);
    };
    seqs.forEach(visit);
    return [...found.values()].sort((a, b) => a.seq - b.seq);
}
function closedCalls(events) {
    const calls = new Set();
    const results = new Set();
    for (const event of events) {
        const message = deriveEventMessage(event);
        for (const block of message?.content ?? []) {
            if (block.type === 'tool-call')
                calls.add(block.id);
            if (block.type === 'tool-result')
                results.add(block.toolCallId);
        }
    }
    return [...calls].every(id => results.has(id)) && [...results].every(id => calls.has(id));
}
/** Build a request view without reading files or changing the current turn. */
export function compactHistory(session, maxHistoryChars) {
    const events = session.snapshotEvents();
    const continuity = buildContinuity(session);
    let completedThrough = -1;
    let turn = 0;
    const turns = new Map();
    for (const event of events) {
        if (event.type === 'turn/start')
            turn = event.data.turn;
        turns.set(event.seq, turn);
        if (event.type === 'turn/end')
            completedThrough = event.seq;
    }
    if (completedThrough < 0)
        return;
    const spans = [];
    let nodes = [];
    const flush = () => {
        if (!nodes.length)
            return;
        const origins = originsOf(session, nodes);
        if (closedCalls(origins))
            spans.push({ nodes, origins, entries: [] });
        nodes = [];
    };
    for (const seq of session.surface.nodes) {
        const event = session.eventAt(seq);
        if (conversational(event) && (seq < completedThrough || ours(event)))
            nodes.push(seq);
        else
            flush();
    }
    flush();
    if (!spans.length)
        return;
    for (const span of spans) {
        const groups = new Map();
        for (const event of span.origins) {
            const message = deriveEventMessage(event);
            if (!message)
                continue;
            const t = event.type === 'assistant/message' || event.type === 'tool/result'
                ? event.data.turn : turns.get(event.seq) ?? 0;
            if (t < 1)
                continue;
            let lines = groups.get(t);
            if (!lines) {
                lines = [];
                groups.set(t, lines);
            }
            if (event.type === 'user/message')
                lines.push(`[user]\n${textOf(message)}`);
            else if (event.type === 'assistant/message') {
                const text = textOf(message);
                if (text)
                    lines.push(renderTapeReply(`slice-turn-${t}`, text));
            }
            // Tool outputs and reasoning remain on the original durable page. Each
            // group carries an explicit recall pointer even before budget admission.
        }
        for (const [t, lines] of groups)
            span.entries.push(new TapeEntry({
                kind: 'digest', ref: `slice-turn-${t}`,
                rendered: `[sealed turn ${t}; status ${continuity.sealMeta[`slice-turn-${t}`]?.status ?? 'recorded'}; full record: recall_turn({"turn":"${t}"})]\n${lines.join('\n')}\n`,
            }));
    }
    const perSpan = Math.floor(maxHistoryChars / spans.length) - Array.from(HISTORY_HEADER).length;
    if (perSpan < 0)
        throw new SliceBudgetError('maxHistoryChars cannot fit the protected context layout and history markers; increase the history budget.');
    // Decide all replacements first. A failed admission must not partially edit
    // the surface or leave a half-compacted request behind.
    const replacements = spans.map(span => {
        const admitted = admitTape(span.entries, {
            maxTapeChars: perSpan,
            recallForEntry: entry => {
                const t = Number(entry.ref.replace('slice-turn-', ''));
                return t > 0 ? { kind: 'turn', turn: t } : undefined;
            },
        });
        if (!admitted.ok)
            throw new SliceBudgetError(`History budget cannot admit durable recall markers (${admitted.reason}); increase maxHistoryChars.`);
        return { span, text: HISTORY_HEADER + tapeRender(admitted.entries) };
    });
    for (const { span, text } of replacements) {
        if (span.nodes.length === 1) {
            const existing = session.eventAt(span.nodes[0]);
            if (ours(existing) && textOf(deriveEventMessage(existing)) === text)
                continue;
        }
        session.append('user/message', createUserMessage({
            content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: HISTORY_SOURCE },
        }), {
            surfaceOp: { op: 'replace', start: span.nodes[0], end: span.nodes[span.nodes.length - 1] },
            sourceEventSeqs: span.nodes,
        });
    }
}
/** Serialized message bound, deliberately distinct from tokenizer/model capacity. */
export function assertRequestBudget(messages, maxRequestChars) {
    const chars = Array.from(JSON.stringify(messages)).length;
    if (chars > maxRequestChars)
        throw new SliceBudgetError(`Request messages need ${chars} characters, above maxRequestChars=${maxRequestChars}. Current input and protected context were preserved; increase the budget or start a smaller task.`);
}
