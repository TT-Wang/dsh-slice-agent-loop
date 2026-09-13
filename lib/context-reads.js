/** Successful read evidence for immutable tape entries. The log is the source,
 * not a claim about the present filesystem or everything the model has seen. */
import { createHash } from 'node:crypto';
const READ_TOOLS = new Set(['read', 'read_section', 'read_file']);
const READ_INDEX_LIMIT = 10;
function sorted(value) {
    if (Array.isArray(value))
        return value.map(sorted);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sorted(child)]));
    return value;
}
function argumentsOf(value) {
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function readRef(call, seq, content, provenance) {
    if (!READ_TOOLS.has(call.name))
        return undefined;
    const args = argumentsOf(call.arguments);
    const target = args?.path ?? args?.file_path ?? args?.filePath;
    if (typeof target !== 'string' || !target.trim())
        return undefined;
    // Keep every non-path selector, including an unknown tool's section/window
    // arguments. Different windows or tool renderers are not change comparisons.
    const selectors = Object.fromEntries(Object.entries(args).filter(([key]) => !['path', 'file_path', 'filePath'].includes(key)));
    const window = Object.keys(selectors).length ? JSON.stringify(sorted(selectors)) : 'default';
    const channel = 'block' in provenance ? 'result' : 'code log';
    const text = content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
    // Image-only success is a read, but it is not a text fingerprint. Keep it out
    // of this text evidence index rather than comparing empty-string hashes.
    if (!content.some(block => block.type === 'text'))
        return undefined;
    return {
        key: JSON.stringify([target, call.name, window, channel]), target, window, tool: call.name,
        turn: call.turn, step: call.step, seq, ...provenance,
        digest: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8),
        lines: text === '' ? 0 : text.split('\n').length,
    };
}
function canonical(reads) {
    const latest = new Map();
    for (const read of reads)
        latest.set(read.key, read);
    return [...latest.values()];
}
/** Errors never enter the successful index or comparison history. A successful
 * retry replaces earlier success for that window; a later error does not. */
export function readHistory(session) {
    const calls = new Map();
    const reads = [];
    for (const event of session.snapshotEvents()) {
        if (event.type === 'assistant/message' && event.surfaceOp === 'append') {
            for (const block of event.data.message.content) {
                if (block.type === 'tool-call')
                    calls.set(block.id, { name: block.name, arguments: block.arguments, turn: event.data.turn, step: event.data.step });
            }
        }
        else if (event.type === 'tool/call') {
            calls.set(event.data.callId, { name: event.data.name, arguments: event.data.arguments, turn: event.data.turn, step: event.data.step });
        }
        else if (event.type === 'tool/result' && event.surfaceOp === 'append') {
            event.data.message.content.forEach((block, index) => {
                const call = calls.get(block.toolCallId);
                if (!call || block.isError)
                    return;
                const read = readRef(call, event.seq, block.content ?? [], { block: index + 1 });
                if (read)
                    reads.push(read);
            });
        }
        else if (event.type === 'tool/ptc-dispatch' && !event.data.isError) {
            const root = calls.get(event.data.rootCallId);
            if (!root)
                continue;
            const read = readRef({ ...root, name: event.data.name, arguments: event.data.arguments }, event.seq, event.data.content, { rootCallId: event.data.rootCallId });
            if (read)
                reads.push(read);
        }
    }
    const byTurn = new Map();
    for (const read of reads) {
        const list = byTurn.get(read.turn) ?? [];
        list.push(read);
        byTurn.set(read.turn, list);
    }
    const prior = new Map();
    for (const entries of byTurn.values()) {
        for (const read of canonical(entries)) {
            const list = prior.get(read.key) ?? [];
            list.push(read);
            prior.set(read.key, list);
        }
    }
    return { reads, prior };
}
/** A code dispatch is log-only. Associate it with its enclosing outer result,
 * but never imply that returning a value to code exposed those bytes to the model. */
export function readsForResult(history, event) {
    const roots = new Set(event.data.message.content.map(block => String(block.toolCallId)));
    return history.reads.filter(read => read.rootCallId === undefined ? read.seq === event.seq
        : roots.has(read.rootCallId) && read.turn === event.data.turn && read.step === event.data.step && read.seq < event.seq);
}
function location(read) {
    return `step ${read.step}, ${read.block === undefined ? 'dispatch ' : ''}seq ${read.seq}${read.block === undefined ? '' : ` block ${read.block}`}`;
}
export function readIndexLine(reads, turn, history) {
    const unique = canonical(reads);
    const shown = unique.slice(0, READ_INDEX_LIMIT).map(read => {
        const prior = (history.prior.get(read.key) ?? []).filter(entry => entry.turn < turn).at(-1);
        const change = prior === undefined ? '' : `, ${prior.digest === read.digest ? '=' : '≠'} turn ${prior.turn} ${location(prior)}`;
        const channel = read.block === undefined ? `, code log; model visibility not implied; recall_turn({"turn":"${read.turn}","view":"full"})` : ', logged result';
        return `${read.target} (${read.lines} lines, ${read.digest}, ${location(read)}, ${read.tool} window ${read.window}${channel}${change})`;
    });
    return `[files read this turn: ${shown.join(', ')}${unique.length > shown.length ? `, +${unique.length - shown.length} more` : ''}]`;
}
