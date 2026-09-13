/**
 * Append-only session tape on the stock ordered surface.
 *
 * Every completed turn beyond `keepRecentTurns` is sealed into one frozen
 * `[slice tape v1 …]` entry at that turn's own position, at the first step of
 * the next turn. An entry is a pure function of the nodes it shadows and is
 * NEVER re-rendered or nested: the seal replaces the newest unsealed span, so
 * every byte before it is identical to the previous request and DeepSeek's
 * prefix cache keeps hitting. The re-billed suffix is the new entry itself,
 * not the whole conversation.
 *
 * That is the one property this module exists to protect. The alternative it
 * replaced — leave history raw, then collapse the OLDEST turns under pressure —
 * kept more verbatim text but rewrote the prefix at its first message, so each
 * archive re-billed the entire view. Measured on 14 recorded member sessions of
 * a live controller: an archive every ~2 turns, ~148K fresh tokens each, ~8.6%
 * of total weighted cost, against ~0.6K per turn for tail sealing.
 *
 * Superseded runtime-context snapshots need no separate shadowing here: the
 * host projects one per change and each declares the earlier ones obsolete, and
 * the turn they belong to absorbs them as one note line when it seals. Only the
 * last-resort tier (a request that cannot fit even with every turn sealed) ever
 * rewrites existing entries, and it says so through `warn`.
 */
import { createHash } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { deriveEventMessage } from '@deepseek-ai/dsh-session';
import { renderTapeReply } from './slice/tape.js';
export const HISTORY_SOURCE = 'slice:history';
export const CHECKPOINT_PREFIX = '[slice checkpoint v1 · turns ';
/** Header of a sealed entry. Sessions written by the pressure-archive build carry CHECKPOINT_PREFIX; both parse. */
export const TAPE_PREFIX = '[slice tape v1 · turns ';
/** Stand-in for a superseded runtime snapshot inside the entry that seals its turn. */
export const SNAPSHOT_NOTE_PREFIX = '[slice note · ';
/** The host's runtime-context projection (dsh-agent-loop RuntimeContextProjection). */
export const RUNTIME_CONTEXT_SOURCE = '@deepseek-ai/dsh-system-prompt';
const USER_HEAD = 600;
const USER_TAIL = 300;
const TOOL_LINES_PER_TURN = 6;
/** Tool names whose targets make up the per-turn read index of a sealed entry. */
const READ_TOOL_NAMES = new Set(['read', 'read_section', 'read_file']);
/** Cap for one turn's read index; the tail is summarized as "+N more". */
const READ_INDEX_PER_TURN = 10;
/** Hex chars of the content digest kept in a read fingerprint (collision-prone by design: it is a hint). */
const READ_DIGEST_CHARS = 8;
function chars(value) {
    return Array.from(JSON.stringify(value)).length;
}
function textOf(message) {
    return message.content.map(block => block.type === 'text' ? block.text : '').join('');
}
export function ours(event) {
    return event.type === 'user/message' && event.data.source.kind === 'plugin'
        && event.data.source.plugin === HISTORY_SOURCE;
}
/**
 * One host-projected runtime-context snapshot. The host emits one per change and
 * each snapshot's own text declares that it supersedes the earlier ones, so only
 * the newest one carries live information.
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
/** Original append events behind a node; only our own replacements are expanded. */
function originsOf(session, seqs) {
    const seen = new Set();
    const found = [];
    const visit = (seq) => {
        if (seen.has(seq))
            return;
        seen.add(seq);
        const event = session.eventAt(seq);
        if (!event)
            return;
        if (ours(event) && 'sourceEventSeqs' in event && event.sourceEventSeqs)
            event.sourceEventSeqs.forEach(visit);
        else
            found.push(event);
    };
    seqs.forEach(visit);
    return found.sort((a, b) => a.seq - b.seq);
}
/**
 * Tool-call ids with no partner. A turn is archived only when this is empty:
 * shadowing half of a call/result pair would leave an unmatched tool block on
 * the request surface. Ids rather than a boolean, so the cut can be reported.
 */
function unpairedCalls(messages) {
    const calls = new Set();
    const results = new Set();
    for (const message of messages) {
        for (const block of message.content) {
            if (block.type === 'tool-call')
                calls.add(block.id);
            if (block.type === 'tool-result')
                results.add(block.toolCallId);
        }
    }
    return [...new Set([...calls, ...results])].filter(id => !calls.has(id) || !results.has(id));
}
/**
 * Protection per surface node. Current input, instruction and plugin messages,
 * multimodal user content and the LIVE runtime snapshot keep their positions.
 * The live snapshot is the newest one: the one `pending` is about to append when
 * the host projected a change this step, else the newest on the surface. It is
 * never shadowed — the host's RuntimeContextProjection retains that one seq and
 * would reproject if a replacement named it. Every older snapshot is superseded
 * by the host's own declaration and is archivable history — in the open turn
 * too (a turn whose context changes every step), where only noteRuns may touch
 * it. A snapshot no recall page serves (one projected before the first turn)
 * stays protected: omitting it would be unrecoverable.
 */
function inspectSurface(session, pinFirstTurn, pending) {
    const turnAt = new Map();
    // Recall owner at append time, as src/recall.ts ownerOf attributes a runtime
    // snapshot (a plugin message): the open turn, else the turn that just ended, else 0.
    const recallAt = new Map();
    const toolNames = new Map();
    let turn = 0;
    let open = 0;
    let ended = 0;
    let completedThrough = -1;
    let lastTurn = 0;
    for (const event of session.snapshotEvents()) {
        if (event.type === 'turn/start') {
            turn = event.data.turn;
            open = event.data.turn;
        }
        if (event.type === 'tool/call')
            toolNames.set(event.data.callId, event.data.name);
        turnAt.set(event.seq, turn);
        recallAt.set(event.seq, open || ended);
        if (event.type === 'turn/end') {
            completedThrough = event.seq;
            lastTurn = Math.max(lastTurn, event.data.turn);
            ended = event.data.turn;
            if (event.data.turn === open)
                open = 0;
        }
    }
    const turnOf = (event) => event.type === 'assistant/message' || event.type === 'tool/result' ? event.data.turn : turnAt.get(event.seq) ?? 0;
    const rangeOf = (event) => {
        if (ours(event)) {
            const header = /^\[slice (?:checkpoint|tape) v1 · turns (\d+)-(\d+)/.exec(textOf(deriveEventMessage(event)));
            if (header)
                return [Number(header[1]), Number(header[2])];
            const turns = originsOf(session, [event.seq]).map(turnOf).filter(t => t >= 1);
            return turns.length ? [Math.min(...turns), Math.max(...turns)] : [0, 0];
        }
        const t = turnOf(event);
        return [t, t];
    };
    let live;
    if (!pending.some(isRuntimeSnapshot)) {
        const surface = session.surface.nodes;
        for (let index = surface.length - 1; index >= 0 && live === undefined; index -= 1) {
            if (runtimeSnapshot(session.eventAt(surface[index])))
                live = surface[index];
        }
    }
    let pinned = false;
    const nodes = [];
    for (const seq of session.surface.nodes) {
        const event = session.eventAt(seq);
        const message = deriveEventMessage(event);
        const turns = rangeOf(event);
        let guarded = seq > completedThrough || turns[0] < 1;
        let superseded = false;
        let recallTurns = [recallAt.get(seq) ?? 0];
        if (runtimeSnapshot(event)) {
            // Not the open-turn guard: a dead snapshot of the open turn is still dead.
            guarded = seq === live || recallTurns[0] < 1;
            superseded = !guarded;
        }
        else if (ours(event)) {
            const sources = 'sourceEventSeqs' in event ? event.sourceEventSeqs ?? [] : [];
            if (sources.length && sources.every(source => { const origin = session.eventAt(source); return origin !== undefined && runtimeSnapshot(origin); })) {
                superseded = true;
                recallTurns = sources.map(source => recallAt.get(source) ?? 0);
            }
        }
        else if (event.type === 'user/message') {
            const own = event.surfaceOp === 'append' && event.data.source.kind === 'user' && event.data.content.every(block => block.type === 'text');
            if (!own)
                guarded = true;
            else if (pinFirstTurn && !pinned && turns[0] === 1) {
                pinned = true;
                guarded = true;
            }
        }
        nodes.push({ seq, event, message, size: message ? chars(message) : 0, turns, protected: guarded,
            superseded: superseded && !guarded, recallTurns });
    }
    return { nodes, completedThrough, lastTurn, toolNames };
}
function excerpt(text, verbatimUpTo, head, tail) {
    const all = Array.from(text);
    if (all.length <= verbatimUpTo || all.length <= head + tail)
        return text;
    return `${all.slice(0, head).join('')}…[+${all.length - head - tail} chars, recall_turn]…${all.slice(all.length - tail).join('')}`;
}
/** The file a read-style tool call targeted, or undefined when its arguments name none. */
function readTarget(argumentsJson) {
    if (typeof argumentsJson !== 'string')
        return undefined;
    try {
        const parsed = JSON.parse(argumentsJson);
        const value = parsed['path'] ?? parsed['file_path'] ?? parsed['filePath'];
        return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
    }
    catch {
        return undefined;
    }
}
/** The text a tool result handed back to the model — the bytes a fingerprint covers. */
function resultText(blocks) {
    return blocks
        .flatMap(block => block.content ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('');
}
/** What one read returned: line count, size and a short content digest. */
function readMark(text) {
    return {
        digest: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, READ_DIGEST_CHARS),
        lines: text === '' ? 0 : text.split('\n').length,
        chars: Array.from(text).length,
    };
}
/**
 * Every read this session already performed, by target, in event order. Built from the append-only
 * log (not the surface) so a read stays comparable after its turn, or its result, was sealed away.
 */
function readHistory(session) {
    const calls = new Map();
    const history = new Map();
    for (const event of session.snapshotEvents()) {
        if (event.type === 'assistant/message') {
            for (const block of event.data.message.content) {
                if (block.type !== 'tool-call' || !READ_TOOL_NAMES.has(block.name))
                    continue;
                const target = readTarget(block.arguments);
                if (target !== undefined)
                    calls.set(block.id, { target, turn: event.data.turn });
            }
            continue;
        }
        // A derived replacement carries no new read: only the original append record counts.
        if (event.type !== 'tool/result' || event.surfaceOp !== 'append')
            continue;
        for (const block of event.data.message.content) {
            const call = calls.get(block.toolCallId);
            if (call === undefined)
                continue;
            const list = history.get(call.target) ?? [];
            list.push({ turn: call.turn, digest: readMark(resultText(event.data.message.content)).digest });
            history.set(call.target, list);
        }
    }
    return history;
}
function collectItems(session, run, toolNames) {
    const items = [];
    const readByCall = new Map();
    let current;
    for (const node of run) {
        const { event } = node;
        if (ours(event) && !node.superseded) {
            items.push({ kind: 'earlier', turns: node.turns });
            current = undefined;
            continue;
        }
        const turn = node.turns[0];
        if (!current || current.turn !== turn) {
            current = { kind: 'turn', turn, users: [], reply: '', tools: [], reads: [], snapshots: [] };
            items.push(current);
        }
        // A superseded snapshot is neither user speech nor current truth: never a request line.
        if (node.superseded) {
            current.snapshots.push(...node.recallTurns);
            continue;
        }
        if (!node.message)
            continue;
        if (event.type === 'user/message')
            current.users.push(textOf(node.message));
        else if (event.type === 'assistant/message') {
            const text = textOf(node.message);
            if (text)
                current.reply = text;
            // The next turn must see which files this turn already read: without the index the sealed span
            // looks like the file was never opened, and the model re-reads it (c1: S1 rereads 43.5% vs N 23.0%).
            for (const block of event.data.message.content) {
                if (block.type !== 'tool-call' || !READ_TOOL_NAMES.has(block.name))
                    continue;
                const target = readTarget(block.arguments);
                if (target === undefined)
                    continue;
                let ref = current.reads.find(read => read.target === target);
                if (ref === undefined) {
                    ref = { target, step: event.data.step };
                    current.reads.push(ref);
                }
                readByCall.set(block.id, ref);
            }
        }
        else if (event.type === 'tool/result') {
            // Point at the original append record: that is where the full text lives.
            const origin = event.surfaceOp === 'append' ? event : session.eventAt(event.sourceEventSeqs?.[0] ?? event.seq) ?? event;
            const source = origin.type === 'tool/result' ? origin : event;
            const blocks = source.data.message.content;
            // Fingerprint the bytes the read returned: a later turn seeing the same digest knows the file is
            // unchanged, and a different digest is the one honest reason to read it again.
            const text = resultText(blocks);
            for (const block of blocks) {
                const ref = readByCall.get(block.toolCallId);
                if (ref !== undefined && ref.mark === undefined)
                    ref.mark = readMark(text);
            }
            const name = blocks.map(block => toolNames.get(block.toolCallId) ?? 'tool').filter((n, i, a) => a.indexOf(n) === i).join(', ');
            const size = blocks.flatMap(block => block.content ?? []).reduce((n, b) => n + (b.type === 'text' ? Array.from(b.text).length : 0), 0);
            current.tools.push(`[tool turn ${turn} step ${source.data.step} seq ${source.seq} · ${name} · ${size} chars · expand_result({"seq":${source.seq}})]`);
        }
    }
    return items;
}
/** One line for every superseded runtime snapshot of a turn; the text stays on its recall page. */
export function snapshotNote(recallTurns) {
    const count = recallTurns.length;
    const noun = count === 1 ? 'runtime-context snapshot' : `${count} runtime-context snapshots`;
    const turns = [...new Set(recallTurns.filter(t => t >= 1))];
    const where = turns.length
        ? turns.map(t => `recall_turn({"turn":"${t}"})`).join(', ')
        : 'recall_search({"query":"...","kinds":["context"]})';
    return `${SNAPSHOT_NOTE_PREFIX}${noun} superseded by a later one; not repeated here · verbatim: ${where}]`;
}
/**
 * One pointer line so a later turn knows which files this sealed turn already read — and, with the
 * fingerprint, whether a file it read later still holds the same bytes (`= turn N`) or changed (`≠ turn N`).
 * The digest is a hint, not proof: it covers what the read returned, not the file on disk.
 */
function readIndexLine(reads, turn, history) {
    const shown = reads.slice(0, READ_INDEX_PER_TURN).map(read => {
        if (read.mark === undefined)
            return `${read.target} (step ${read.step})`;
        const prior = (history.get(read.target) ?? []).filter(entry => entry.turn < turn).at(-1);
        const change = prior === undefined ? '' : prior.digest === read.mark.digest ? `, = turn ${prior.turn}` : `, ≠ turn ${prior.turn}`;
        return `${read.target} (${read.mark.lines} lines, ${read.mark.digest}, step ${read.step}${change})`;
    });
    const extra = reads.length - shown.length;
    return `[files read this turn: ${shown.join(', ')}${extra > 0 ? `, +${extra} more` : ''}]`;
}
function renderItems(items, range, count, pinUserChars, shrink, history) {
    const lines = [`${TAPE_PREFIX}${range[0]}-${range[1]} · ${count} turn(s) sealed · recall_turn({"turn":"<n>","view":"dialogue"}) returns a turn's dialogue; expand_result({"seq":<q>}) returns a tool result]`];
    for (const item of items) {
        if (item.kind === 'earlier') {
            lines.push(`[earlier checkpoint covered turns ${item.turns[0]}-${item.turns[1]}; recall_turn for details]`);
            continue;
        }
        lines.push(`[turn ${item.turn}]`);
        item.users.forEach((text, index) => {
            const body = excerpt(text, shrink.userHead >= USER_HEAD ? pinUserChars : 0, shrink.userHead, shrink.userTail);
            lines.push(index === 0 ? body : `[user]\n${body}`);
        });
        if (item.snapshots.length)
            lines.push(snapshotNote(item.snapshots));
        if (item.reply)
            lines.push(renderTapeReply(`slice-turn-${item.turn}`, item.reply, shrink.reply).trimEnd());
        if (item.reads.length)
            lines.push(readIndexLine(item.reads, item.turn, history));
        if (shrink.tools && item.tools.length) {
            lines.push(...item.tools.slice(0, TOOL_LINES_PER_TURN));
            if (item.tools.length > TOOL_LINES_PER_TURN)
                lines.push(`[+${item.tools.length - TOOL_LINES_PER_TURN} more tool results]`);
        }
    }
    return lines.join('\n');
}
/**
 * Deterministic entry text: drop tool lines first, then shrink excerpts until it fits.
 * `maxChars` is a target: the smallest level is returned as is when even it does not fit.
 */
export function renderCheckpoint(session, run, toolNames, pinUserChars, maxChars) {
    const items = collectItems(session, run, toolNames);
    const history = readHistory(session);
    const covered = new Set();
    for (const item of items) {
        if (item.kind === 'turn')
            covered.add(item.turn);
        else
            for (let t = item.turns[0]; t <= item.turns[1]; t += 1)
                covered.add(t);
    }
    const range = [Math.min(...covered), Math.max(...covered)];
    const levels = [{ tools: true, userHead: USER_HEAD, userTail: USER_TAIL, reply: { cap: 2000, head: 1400, tail: 500 } }];
    levels.push({ ...levels[0], tools: false });
    for (let divisor = 2; divisor <= 16; divisor *= 2) {
        levels.push({ tools: false, userHead: Math.floor(USER_HEAD / divisor), userTail: Math.floor(USER_TAIL / divisor),
            reply: { cap: Math.floor(2000 / divisor), head: Math.floor(1400 / divisor), tail: Math.floor(500 / divisor) } });
    }
    let text = '';
    for (const level of levels) {
        text = renderItems(items, range, covered.size, pinUserChars, level, history);
        if (Array.from(text).length <= maxChars)
            return text;
    }
    return text;
}
/**
 * Decide the whole seal before any append. Returns an empty plan when every
 * completed turn beyond the keep window is already sealed.
 *
 * The seal lands after every existing entry, so the prefix before it is
 * byte-identical to the previous request. There is no request budget and no
 * refusal: this policy bounds the view by construction (one entry per completed
 * turn, tool results folded within the open turn), and the only hard limit is
 * the model's own context window, which belongs to the host. A budget that
 * refused instead — and poisoned every later turn of the session — arrived with
 * the 2026-09-08 refactor and is gone again.
 */
export function planSeal(session, pending, policy, warn) {
    const layout = inspectSurface(session, policy.pinFirstTurn, pending);
    const messagesOf = (nodes) => nodes.flatMap(node => node.message ? [node.message] : []);
    const view = (runs) => {
        const messages = [];
        let historyChars = 0;
        const replaced = new Map();
        const shadowed = new Set();
        for (const run of runs) {
            replaced.set(run.nodes[0].seq, run);
            run.nodes.forEach(node => shadowed.add(node.seq));
        }
        for (const node of layout.nodes) {
            const run = replaced.get(node.seq);
            if (run) {
                messages.push(run.message);
                historyChars += chars(run.message);
                continue;
            }
            if (shadowed.has(node.seq))
                continue;
            if (node.message)
                messages.push(node.message);
            if (!node.protected)
                historyChars += node.size;
        }
        return { viewChars: chars([...messages, ...pending]), historyChars };
    };
    const initial = view([]);
    /** An entry already on the surface. Frozen: re-rendering one rewrites the prefix it sits in. */
    const sealedEntry = (node) => ours(node.event) && !node.superseded;
    // The only trigger. One seal costs the entry it writes, so there is nothing to wait for — and waiting is
    // exactly what makes the rewrite expensive, because by then the span to replace sits under everything newer.
    const sealBefore = layout.lastTurn - policy.keepRecentTurns + 1;
    const cuts = new Map();
    const buildRuns = (before) => {
        const runs = [];
        let current = [];
        const push = (nodes) => {
            if (!nodes.length)
                return;
            const text = renderCheckpoint(session, nodes, layout.toolNames, policy.pinUserChars, policy.entryMaxChars);
            runs.push({ nodes, message: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: HISTORY_SOURCE } }) });
        };
        // A turn whose calls are not all closed cuts the run instead of suppressing it (calls close within their turn),
        // and says so: a silent cut looks exactly like an archive that never shrinks the view (A-RT-05).
        const flush = () => {
            let segment = [];
            for (let i = 0; i < current.length;) {
                let j = i + 1;
                while (j < current.length && current[j].turns[1] === current[i].turns[1])
                    j += 1;
                const turn = current.slice(i, j);
                const unpaired = unpairedCalls(messagesOf(turn));
                if (!unpaired.length)
                    segment.push(...turn);
                else {
                    const key = `${turn[0].seq}`;
                    if (!cuts.has(key))
                        cuts.set(key, `slice tape: turn ${turn[0].turns[1]} (seq ${turn[0].seq}..${turn[turn.length - 1].seq}) kept raw and cut the sealed span, unpaired tool call/result ${unpaired.join(', ')}`);
                    push(segment);
                    segment = [];
                }
                i = j;
            }
            push(segment);
            current = [];
        };
        for (const node of layout.nodes) {
            if (!node.protected && node.turns[1] < before && !sealedEntry(node))
                current.push(node);
            else
                flush();
        }
        flush();
        return runs;
    };
    const plan = buildRuns(sealBefore);
    for (const message of cuts.values())
        warn?.(message);
    const measure = plan.length ? view(plan) : initial;
    const appends = plan.map(run => ({
        message: run.message,
        start: run.nodes[0].seq, end: run.nodes[run.nodes.length - 1].seq, sources: run.nodes.map(node => node.seq),
    }));
    return { appends, ...measure };
}
export function applySeal(session, plan) {
    for (const append of plan.appends) {
        session.append('user/message', append.message, { surfaceOp: { op: 'replace', start: append.start, end: append.end }, sourceEventSeqs: append.sources });
    }
}
/** Plan and apply in one call; the decision is complete before the first append. */
export function sealCompletedTurns(session, pending, policy, warn) {
    const plan = planSeal(session, pending, policy, warn);
    applySeal(session, plan);
    return plan;
}
/**
 * Size of the request this step will build: the current surface plus the
 * messages pre-step's decision is about to append. The loop derives its
 * messages before agent/request runs, so pre-step is the last point at which
 * the session may still be edited.
 */
export function requestChars(session, incoming = []) {
    return chars([...session.deriveMessages(), ...incoming]);
}
