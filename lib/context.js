/** Durable conversational replacement on the stock ordered surface. */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { deriveEventMessage } from '@deepseek-ai/dsh-session';
import { buildContinuity } from './state/reducer.js';
import { admitTape } from './slice/admission.js';
import { TapeEntry, renderTapeReply, tapeRender } from './slice/tape.js';
export const HISTORY_SOURCE = 'slice:history';
export const HISTORY_HEADER = '# SESSION TAPE (sealed conversational history; not current-world truth)\n';
/** The host's runtime-context projection (dsh-agent-loop RuntimeContextProjection). */
export const RUNTIME_CONTEXT_SOURCE = '@deepseek-ai/dsh-system-prompt';
export class SliceBudgetError extends Error {
    constructor(message) { super(message); this.name = 'SliceBudgetError'; }
}
function ours(event) {
    return event.type === 'user/message' && event.data.source.kind === 'plugin'
        && event.data.source.plugin === HISTORY_SOURCE;
}
/**
 * One host-projected runtime-context snapshot. The host emits one per change and
 * each snapshot's own text declares that it supersedes the earlier ones, so only
 * the newest one on the surface carries live information.
 */
function runtimeSnapshot(event) {
    return event.type === 'user/message' && event.data.source.kind === 'plugin'
        && event.data.source.plugin === RUNTIME_CONTEXT_SOURCE;
}
/** True for a message the host's runtime-context projection just produced. */
export function isRuntimeSnapshot(message) {
    return message.role === 'user' && message.source.kind === 'plugin'
        && message.source.plugin === RUNTIME_CONTEXT_SOURCE;
}
/** Newest surface runtime snapshot: the host's own retained projection node. */
function liveRuntimeSnapshot(session) {
    const nodes = session.surface.nodes;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const seq = nodes[index];
        if (runtimeSnapshot(session.eventAt(seq)))
            return seq;
    }
    return undefined;
}
/**
 * Preserve context ownership and multimodal user content at their original
 * positions. Superseded runtime snapshots are the one exception: shadowing the
 * live one would make the host reproject it, but every older one is declared
 * obsolete by the host itself, so leaving them protected accumulates one dead
 * protected node per turn and drives every span budget to zero.
 *
 * A superseded snapshot is admitted only when recall_turn actually serves it,
 * i.e. it was appended while a turn was open (recallTurn >= 1). Omitting text
 * no recall tool can reach would break the admission contract, so an
 * unattributable snapshot stays protected instead.
 */
function conversational(event, liveRuntime, recallTurn) {
    if (event.type === 'assistant/message' || event.type === 'tool/result')
        return true;
    if (runtimeSnapshot(event))
        return event.seq !== liveRuntime && recallTurn(event.seq) >= 1;
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
/**
 * Tool-call ids in this span that have no partner. A span is compacted only when
 * this is empty: sealing half of a call/result pair would leave an unmatched tool
 * block on the request surface. The ids are returned rather than a boolean so the
 * caller can say which call made it skip -- silently declining to compact looks
 * exactly like a budget that simply never shrinks.
 */
function unpairedCalls(events) {
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
    return [...new Set([...calls, ...results])].filter(id => !calls.has(id) || !results.has(id));
}
function turnOfEntry(entry) {
    const turn = Number(entry.ref.replace('slice-turn-', ''));
    return Number.isSafeInteger(turn) ? turn : 0;
}
/** Rendered tape for one span, or undefined when this budget cannot admit it. */
function admitSpan(span, maxTapeChars) {
    const admitted = admitTape(span.entries, {
        maxTapeChars,
        recallForEntry: entry => {
            const turn = turnOfEntry(entry);
            return turn > 0 ? { kind: 'turn', turn } : undefined;
        },
    });
    return admitted.ok ? HISTORY_HEADER + tapeRender(admitted.entries) : undefined;
}
/**
 * Smallest legal view of a span: every entry omitted under one marker whose size
 * does not grow with the number of turns. Every entry in a span is built below
 * with ref `slice-turn-<t>` for a t >= 1, so each one has a durable locator by
 * construction and the range alone names them all.
 */
function omitAllMarker(entries) {
    if (!entries.length)
        return '';
    const turns = entries.map(turnOfEntry).sort((a, b) => a - b);
    return `[tape admission: all ${entries.length} sealed turns (${turns[0]}..${turns[turns.length - 1]}) omitted from this request view; recorded history is unchanged. `
        + 'Recall any of them verbatim: recall_turn({"turn":"<id>"}), or recall_search({"query":"..."}) when you do not know which turn]\n';
}
/**
 * Build a request view without reading files or changing the current turn.
 *
 * `runtimeSuperseded` says a freshly projected runtime-context snapshot is
 * about to be appended, so the one still on the surface is already dead. Left
 * protected it would double the cost of a large runtime context in every
 * request. Shadowing it is safe even if this step never dispatches: the host's
 * RuntimeContextProjection drops its retained node when a replacement event
 * names it (dsh-agent-loop RuntimeContextProjection constructor), and reprojects
 * on the next pre-step.
 */
export function compactHistory(session, maxHistoryChars, warn, runtimeSuperseded = false) {
    const events = session.snapshotEvents();
    const continuity = buildContinuity(session);
    let completedThrough = -1;
    let turn = 0;
    let open = 0;
    const turns = new Map();
    // recall_turn owns a user/message by the turn that was OPEN when it was
    // appended, and clears that ownership at turn/end. Any locator this policy
    // prints for such a message must use the same attribution, or the two
    // disagree about the same id (the failure src/recall.ts:226 documents).
    const openTurns = new Map();
    for (const event of events) {
        if (event.type === 'turn/start') {
            turn = event.data.turn;
            open = event.data.turn;
        }
        turns.set(event.seq, turn);
        openTurns.set(event.seq, open);
        if (event.type === 'turn/end') {
            completedThrough = event.seq;
            if (event.data.turn === open)
                open = 0;
        }
    }
    const recallTurn = (seq) => openTurns.get(seq) ?? 0;
    if (completedThrough < 0)
        return;
    const spans = [];
    let nodes = [];
    const flush = () => {
        if (!nodes.length)
            return;
        const origins = originsOf(session, nodes);
        const unpaired = unpairedCalls(origins);
        if (!unpaired.length)
            spans.push({ nodes, origins, entries: [] });
        else
            warn?.(`slice compactHistory: span seq ${nodes[0]}..${nodes[nodes.length - 1]} left uncompacted, unpaired tool call/result ${unpaired.join(', ')}`);
        nodes = [];
    };
    const liveRuntime = runtimeSuperseded ? undefined : liveRuntimeSnapshot(session);
    for (const seq of session.surface.nodes) {
        const event = session.eventAt(seq);
        if (conversational(event, liveRuntime, recallTurn) && (seq < completedThrough || ours(event)))
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
            // A superseded runtime snapshot is neither user speech nor current truth,
            // so its bytes are dead weight here -- but dropping it silently would be
            // the one omission this policy makes without a locator. Leave a marker
            // naming the recall page that serves it (recall_turn's own attribution,
            // and recall_search indexes it under kind `context`).
            if (runtimeSnapshot(event)) {
                const at = recallTurn(event.seq);
                if (at < 1)
                    continue; // not admitted above; unreachable from the surface loop
                let lines = groups.get(at);
                if (!lines) {
                    lines = [];
                    groups.set(at, lines);
                }
                lines.push(`[runtime-context snapshot of this turn superseded by a later one and omitted here; verbatim: recall_turn({"turn":"${at}"})]`);
                continue;
            }
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
    // Decide all replacements first. A failed admission must not partially edit
    // the surface or leave a half-compacted request behind.
    const admitted = perSpan < 0 ? undefined : spans.map(span => admitSpan(span, perSpan));
    // Last resort, per span: no history text at all, one bounded marker whose
    // recall locators still cover every omitted turn. Deterministic degradation
    // beats a refusal that would repeat identically on every later turn -- and it
    // is applied only to the spans that actually overflowed, so a span that
    // admits with headroom is not destroyed because an older one did not.
    const minimal = spans.map(span => HISTORY_HEADER + omitAllMarker(span.entries));
    const size = (texts) => texts.reduce((sum, text) => sum + Array.from(text).length, 0);
    let texts = spans.map((_span, index) => admitted?.[index] ?? minimal[index]);
    if (size(texts) > maxHistoryChars)
        texts = minimal;
    const needed = size(texts);
    if (needed > maxHistoryChars) {
        throw new SliceBudgetError(`History budget cannot admit even the minimal recall markers: ${needed} characters are required, maxHistoryChars=${maxHistoryChars}. Nothing was truncated and the durable record is unchanged, but every later turn of this session fails the same way until maxHistoryChars is raised or a new session is started.`);
    }
    const degraded = texts.reduce((count, text, index) => count + (text === minimal[index] && admitted?.[index] !== minimal[index] ? 1 : 0), 0);
    if (degraded > 0) {
        warn?.(`slice compactHistory: ${degraded} of ${spans.length} history span(s) exceeded maxHistoryChars=${maxHistoryChars} and were replaced by a bounded omit-all recall marker; their text is served only by recall_turn/recall_search from here on`);
    }
    const replacements = spans.map((span, index) => ({ span, text: texts[index] }));
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
/**
 * Size of the request this step will build: the current surface plus the
 * messages the loop is about to append. The loop derives its messages before
 * the agent/request waterfall runs (dsh-agent-loop step() passes
 * session.deriveMessages() into buildRequest), so pre-step is the last point
 * at which the session may still be edited -- and `incoming` is exactly what
 * pre-step's decision will append, so this is a measurement, not an estimate.
 */
export function requestChars(session, incoming = []) {
    return Array.from(JSON.stringify([...session.deriveMessages(), ...incoming])).length;
}
/** Rendered history currently on the surface, in the units maxHistoryChars bounds. */
function historyChars(session) {
    let chars = 0;
    for (const seq of session.surface.nodes) {
        const event = session.eventAt(seq);
        if (event && ours(event))
            chars += Array.from(textOf(deriveEventMessage(event))).length;
    }
    return chars;
}
/** How many times a single step may re-plan history before it gives up. */
const FIT_PASSES = 6;
/**
 * Give history budget back until the serialized request fits maxRequestChars.
 *
 * compactHistory spends the whole fixed maxHistoryChars regardless of the
 * request bound, so a session can die on maxRequestChars while the plugin is
 * still holding history it is free to trim -- a permanent refusal (every later
 * turn throws identically, with no dispatch, until the session is abandoned)
 * in exchange for history nobody asked it to keep. Each pass re-plans from the
 * same originals rather than trimming an already-trimmed view, so shrinking is
 * not cumulative loss. When even the bounded markers do not fit, compactHistory
 * refuses atomically and assertRequestBudget reports the real overflow: at that
 * point the protected floor alone is over budget and no history remains to give.
 */
export function fitRequestBudget(session, incoming, maxHistoryChars, maxRequestChars, warn, runtimeSuperseded = false) {
    let budget = maxHistoryChars;
    for (let pass = 0; pass < FIT_PASSES && budget > 0; pass += 1) {
        const over = requestChars(session, incoming) - maxRequestChars;
        if (over <= 0)
            return;
        // Cut from what history actually occupies, not from the configured cap:
        // when the surface is far below the cap (a large protected floor is what
        // overflows), subtracting from the cap changes nothing and the session
        // dies with tens of thousands of trimmable characters still in the view.
        budget = Math.max(0, Math.min(budget, historyChars(session)) - over);
        warn?.(`slice: request is ${over} characters above maxRequestChars=${maxRequestChars}; re-planning history at maxHistoryChars=${budget}`);
        try {
            compactHistory(session, budget, warn, runtimeSuperseded);
        }
        catch (error) {
            if (!(error instanceof SliceBudgetError))
                throw error;
            return;
        }
    }
}
