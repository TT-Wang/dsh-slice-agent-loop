import { SessionLogOffset } from '@deepseek-ai/dsh-session';
import { shellWriteTargets } from './shell-writes.js';
/**
 * K = 2 covers the usual pause in work on a file: an edit, then a turn that only
 * tests or reviews it, or one that asks a question, before the next edit. A
 * longer window keeps re-reads of files the model stopped changing. 48,000
 * characters (about 14K tokens at the ~3.4 characters per input token measured
 * on the 2026-10-23 logs, reasoning included) holds a full read of a ~500-line
 * source file plus a turn's edits to it: replaying the 2026-10-23 coding task
 * (lh1, 8 turns), the edited file's steps fit in 7 of 8 turns; the eighth
 * carried 27K characters of reasoning in one edit step.
 */
export const DEFAULT_WORKING_SET = { turns: 2, maxChars: 48_000 };
const caches = new WeakMap();
const callKey = (turn, step, id) => JSON.stringify([turn, step, id]);
/**
 * Characters of results outside the working set a kept step may carry beyond its own working-set
 * content: a README read beside the source file is fine, a 13K-character log beside a short notes
 * file is not (the 2026-10-23 flood session read one blob and its digest file in parallel each turn).
 */
export const SIBLING_ALLOWANCE = 4_000;
const READ_ENVELOPE = /^<path>([^\n]*)<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/;
const EDIT_RESULT = /^The file (.+) has been updated(?: successfully)?\./;
function argumentsOf(value) {
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
function textOf(content) {
    return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
}
function normalize(path) {
    const absolute = path.startsWith('/');
    const parts = [];
    for (const part of path.split('/')) {
        if (!part || part === '.')
            continue;
        if (part === '..' && parts.length && parts.at(-1) !== '..')
            parts.pop();
        else
            parts.push(part);
    }
    return `${absolute ? '/' : ''}${parts.join('/')}`;
}
function argumentPath(args) {
    const value = args.file_path ?? args.path ?? args.filePath;
    return typeof value === 'string' && value.trim() ? normalize(value) : undefined;
}
/** A DSH `read` result that starts at line 1 and reaches the end of the file uncapped. */
function fullRead(text) {
    const body = READ_ENVELOPE.exec(text)?.[2];
    if (body === undefined)
        return false;
    const total = /\(End of file - total (\d+) lines\)$/.exec(body);
    return total !== null && (total[1] === '0' || body.startsWith('1: '));
}
/** One file tool outcome, or undefined when it neither shows nor changes a file. */
function classify(name, rawArgs, text, isError, direct) {
    const args = argumentsOf(rawArgs);
    if (name === 'bash') {
        // A failed command may still have written before it failed: the step shows what was run.
        const command = typeof args.command === 'string' ? args.command : '';
        const targets = command ? shellWriteTargets(command) : [];
        return targets.length ? { op: 'edit', targets } : undefined;
    }
    if (isError)
        return undefined;
    if (name === 'read') {
        const path = READ_ENVELOPE.exec(text)?.[1] ?? argumentPath(args);
        // A code-channel read reached the program, not necessarily the model.
        return path === undefined ? undefined : { op: direct && fullRead(text) ? 'view' : 'seen', path };
    }
    if (name === 'write') {
        const path = READ_ENVELOPE.exec(text)?.[1] ?? argumentPath(args);
        return path === undefined ? undefined : { op: direct ? 'write' : 'edit', path };
    }
    if (name === 'edit') {
        const path = EDIT_RESULT.exec(text)?.[1] ?? argumentPath(args);
        return path === undefined ? undefined : { op: 'edit', path };
    }
    return undefined;
}
/** File events per turn, scanned incrementally from the append-only log (like context-reads). */
function fileEvents(session) {
    let cache = caches.get(session);
    if (!cache) {
        cache = { nextSeq: 0, calls: new Map(), roots: new Map(), dispatches: new Map(), byTurn: new Map() };
        caches.set(session, cache);
    }
    if (cache.nextSeq === session.seq)
        return cache.byTurn;
    const { calls, roots, dispatches, byTurn } = cache;
    const record = (call, event) => {
        const list = byTurn.get(call.turn) ?? [];
        list.push({ key: callKey(call.turn, call.step, call.id), turn: call.turn, ...event });
        byTurn.set(call.turn, list);
    };
    const remember = (call) => { calls.set(callKey(call.turn, call.step, call.id), call); roots.set(call.id, call); };
    const nextSeq = session.seq;
    for (const event of session.snapshotEvents(SessionLogOffset(cache.nextSeq), nextSeq)) {
        if (event.type === 'assistant/message' && event.surfaceOp === 'append') {
            for (const block of event.data.message.content) {
                if (block.type === 'tool-call')
                    remember({ name: block.name, arguments: block.arguments, turn: event.data.turn, step: event.data.step, id: block.id });
            }
        }
        else if (event.type === 'tool/call') {
            remember({ name: event.data.name, arguments: event.data.arguments, turn: event.data.turn, step: event.data.step, id: event.data.callId });
        }
        else if (event.type === 'tool/result' && event.surfaceOp === 'append') {
            const message = event.data.message;
            const call = calls.get(callKey(event.data.turn, event.data.step, message.toolCallId));
            const outcome = call && classify(call.name, call.arguments, textOf(message.content), message.isError === true, true);
            if (call && outcome)
                record(call, { ...outcome, ...outcome.op === 'view' ? { result: event.seq } : {} });
        }
        else if (event.type === 'tool/ptc-dispatch-start') {
            const root = roots.get(event.data.rootCallId);
            if (root)
                dispatches.set(event.data.subCallId, root);
        }
        else if (event.type === 'tool/ptc-dispatch') {
            const root = dispatches.get(event.data.subCallId) ?? roots.get(event.data.rootCallId);
            dispatches.delete(event.data.subCallId);
            const outcome = root && classify(event.data.name, event.data.arguments, textOf(event.data.content), event.data.isError === true, false);
            if (root && outcome)
                record(root, outcome);
        }
    }
    cache.nextSeq = nextSeq;
    return byTurn;
}
function textChars(text) {
    let count = text.length;
    const pairs = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
    while (pairs.exec(text))
        count -= 1;
    return count;
}
/** What a kept message costs to carry: visible text, reasoning, call arguments and result text. */
function keptChars(message) {
    let count = 0;
    for (const block of message?.content ?? []) {
        if (block.type === 'text' || block.type === 'reasoning')
            count += textChars(block.text);
        else if (block.type === 'tool-call')
            count += textChars(block.arguments);
    }
    return count;
}
/**
 * Surface steps: each assistant message with calls, and the result nodes answering them. A result
 * node may be another producer's in-place view of the result (a fold); it still answers the call.
 */
function surfaceSteps(nodes) {
    const results = new Map();
    for (const node of nodes) {
        const { event } = node;
        if (event.type === 'tool/result')
            results.set(callKey(event.data.turn, event.data.step, event.data.message.toolCallId), node);
    }
    const steps = new Map();
    for (const node of nodes) {
        const { event } = node;
        if (event.type !== 'assistant/message')
            continue;
        const calls = (node.message?.content ?? []).flatMap(block => block.type === 'tool-call' ? [block] : []);
        if (!calls.length)
            continue;
        const step = { step: event.data.step, members: [node.seq], chars: keptChars(node.message), intact: true, calls: new Map() };
        for (const call of calls) {
            const key = callKey(event.data.turn, event.data.step, call.id);
            const result = results.get(key);
            const size = result ? keptChars(result.message) : 0;
            if (result) {
                step.members.push(result.seq);
                step.chars += size;
            }
            else
                step.intact = false;
            step.calls.set(key, { args: textChars(call.arguments), result: size });
            steps.set(key, step);
        }
    }
    return { steps, results: new Map([...results].map(([key, node]) => [key, node.seq])) };
}
/** Known canonical paths a shell target can name: equal, or ending in it at a path boundary. */
function resolve(target, known) {
    const bare = target.replace(/^(?:\$\{?PWD\}?\/)+/, '');
    if (/[$*?[\]{}~`]/.test(bare))
        return [];
    const path = normalize(bare).replace(/^(?:\.\.\/)+/, '').replace(/^\/+/, '');
    if (!path || path === '..')
        return [];
    return [...known].filter(candidate => candidate === `/${path}` || candidate === path || candidate.endsWith(`/${path}`));
}
/**
 * Decide which surface nodes of turns before `before` (the turns this seal may
 * seal, all completed) stay raw. `nodes` is the current surface in order; only
 * assistant messages and tool results are ever kept.
 */
export function keepWorkingSet(session, nodes, before, policy) {
    const kept = { seqs: new Set(), notes: new Map() };
    const byTurn = fileEvents(session);
    const { steps, results } = surfaceSteps(nodes);
    const known = new Set();
    const changedIn = new Map();
    /** The file's latest view and every later change are still raw on the surface. */
    const live = new Map();
    for (const turn of [...byTurn.keys()].filter(t => t < before).sort((a, b) => a - b)) {
        const events = byTurn.get(turn);
        for (const event of events)
            if (event.path !== undefined)
                known.add(event.path);
        const perFile = new Map();
        for (const event of events) {
            for (const file of event.path !== undefined ? [event.path] : event.targets.flatMap(target => resolve(target, known))) {
                const list = perFile.get(file) ?? [];
                if (list.at(-1) !== event)
                    list.push(event);
                perFile.set(file, list);
            }
        }
        const changed = new Set([...perFile].flatMap(([file, list]) => list.some(event => event.op === 'write' || event.op === 'edit') ? [file] : []));
        changedIn.set(turn, changed);
        /** Turns of the window in which the file changed: 0 means it is not in the working set. */
        const persistence = (file) => {
            let count = 0;
            for (let t = turn - policy.turns; t <= turn; t += 1)
                if (changedIn.get(t)?.has(file))
                    count += 1;
            return count;
        };
        const visible = (event) => event.op === 'write' || (event.op === 'view' && results.get(event.key) === event.result);
        const candidates = [];
        for (const [file, list] of perFile) {
            const turns = persistence(file);
            if (!turns)
                continue;
            let reset = -1;
            list.forEach((event, index) => { if (visible(event))
                reset = index; });
            const changes = (from) => list.slice(from).filter(event => event.op === 'edit' || event.op === 'write');
            const chain = reset >= 0 ? [list[reset], ...changes(reset + 1)] : live.get(file) === true ? changes(0) : [];
            if (chain.length)
                candidates.push({ file, chain, turns, last: events.indexOf(list.at(-1)) });
        }
        // A file changed across more of the window is the one being worked on, not a one-off script; then recency.
        candidates.sort((a, b) => b.turns - a.turns || b.last - a.last);
        // Working-set content of a step: its calls that view or change a working-set file, read from the log
        // alone, so a kept step stays lean however later seals change which views are visible.
        const own = new Set([...perFile].flatMap(([file, list]) => persistence(file) ? list.flatMap(event => event.op === 'seen' ? [] : [event.key]) : []));
        const lean = (step) => {
            let inside = 0;
            let outside = 0;
            for (const [key, size] of step.calls) {
                if (own.has(key))
                    inside += size.args + size.result;
                else
                    outside += size.result;
            }
            return outside <= Math.max(inside, SIBLING_ALLOWANCE);
        };
        const chosen = new Set();
        const files = [];
        let used = 0;
        for (const { file, chain } of candidates) {
            const needed = [...new Set(chain.map(event => steps.get(event.key)))];
            if (needed.some(step => step === undefined || !step.intact || !lean(step)))
                continue;
            const extra = needed.filter(step => !chosen.has(step)).reduce((sum, step) => sum + step.chars, 0);
            if (used + extra > policy.maxChars)
                continue;
            for (const step of needed)
                chosen.add(step);
            used += extra;
            files.push(file);
        }
        for (const file of perFile.keys()) {
            if (files.includes(file))
                live.set(file, true);
            else if (changed.has(file))
                live.set(file, false);
        }
        if (!chosen.size)
            continue;
        for (const step of chosen)
            for (const seq of step.members)
                kept.seqs.add(seq);
        kept.notes.set(turn, { steps: [...chosen].map(step => step.step).sort((a, b) => a - b), files });
    }
    return kept;
}
const NOTE_FILES = 6;
/** Entry line for a turn that left steps raw. Labels drop the files' shared directory; locators are not needed, the steps are on the surface. */
export function workingSetNote(note) {
    const shown = note.files.slice(0, NOTE_FILES);
    const split = shown.map(file => file.split('/'));
    let shared = Math.min(...split.map(parts => parts.length - 1));
    for (let index = 0; index < shared; index += 1) {
        if (split.some(parts => parts[index] !== split[0][index])) {
            shared = index;
            break;
        }
    }
    const labels = split.map(parts => {
        const label = parts.slice(shared).join('/');
        return label.length > 120 ? `…${label.slice(label.length - 119)}` : label;
    });
    const more = note.files.length > shown.length ? `, +${note.files.length - shown.length} more` : '';
    return `[slice note · working set: step(s) ${note.steps.join(', ')} of this turn kept raw in place for ${labels.join(', ')}${more}]`;
}
