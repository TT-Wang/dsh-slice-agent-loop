/**
 * recall_turn — the slice loop's memory-recall tool.
 *
 * The tape truncates every sealed reply at REPLY_CAP_CHARS (1,200 code points)
 * and marks the cut with `…[+N chars in sealed turn]`. Until this tool, the
 * marker was a dead end: the Python engine pages the full text back through
 * its virtual context filesystem (`@sliceagent/history/...`), but that
 * filesystem has no DSH counterpart — DSH has no path interception, no read
 * middleware, and no resolver hook, so no spelling of a virtual path can ever
 * be served here. The 20-step/35-search runaway documented in
 * docs/modification-spec.md was a model hunting for exactly that promise.
 *
 * This is the same capability rebuilt on the DSH-native seam instead: a real
 * registered tool. The substrate is not a new store — the dsh Agent contract
 * already obliges this loop to append every user/message and assistant/message
 * to the session log verbatim and durably, which is also the source
 * restoreContinuity rebuilds from. Serving recall from those events means:
 *
 *  - zero new persistence, zero bytes added to the log;
 *  - recreation-safe by construction (the log is what an agent is rebuilt
 *    from, so anything a rebuilt agent can be is something recall can read);
 *  - verbatim by construction (the log holds the exact delivered bytes, not a
 *    reconstruction — same rule as the Python engine's sealed artifacts).
 *
 * The turn is attributed the way restoreContinuity attributes it: an
 * assistant/message carries its turn number explicitly; a user/message is
 * owned by the turn that was open when it was appended (step-1 input and
 * mid-turn steering alike), so the scan tracks turn/start.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
export const RECALL_TOOL_NAME = 'recall_turn';
export const RECALL_SEARCH_TOOL_NAME = 'recall_search';
/**
 * Event kinds recall_search scans, and the flood guard that shapes them.
 *
 * Ordinary tool OUTPUT is excluded by default — it is the session's highest-
 * volume, lowest-signal text (file dumps, listings), and letting it into the
 * corpus buries the sentence the model actually said under kilobytes of cat.
 * Tool INPUT (what was asked of a tool) and tool ERRORS stay in: both are
 * short and load-bearing. Callers opt tool output in with kinds:
 * ['tool_output'] when they know the fact was tool-born.
 */
export const DEFAULT_SEARCH_KINDS = ['user', 'assistant', 'tool_input', 'tool_error'];
/** `slice-turn-7`, `7`, or 7 → 7; null when unparseable. */
export function parseTurnId(value) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1)
        return value;
    if (typeof value !== 'string')
        return null;
    const match = /^(?:slice-turn-)?([0-9]+)$/.exec(value.trim());
    if (match === null)
        return null;
    const turn = Number(match[1]);
    return Number.isInteger(turn) && turn >= 1 ? turn : null;
}
/** Join a message's text blocks; non-text blocks (images, tool results) contribute nothing. */
function textOf(message) {
    return message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');
}
/**
 * Render one turn's verbatim page from durable session events. Pure so the
 * gate suite can drive it without an agent. Returns null when the log holds
 * nothing for that turn.
 */
export function renderSealedTurn(events, turn) {
    const users = [];
    const steps = [];
    let status = 'open';
    let openTurn = null;
    let seen = false;
    for (const event of events) {
        const data = event.data;
        switch (event.type) {
            case 'turn/start':
                openTurn = data.turn;
                if (openTurn === turn)
                    seen = true;
                break;
            case 'turn/end':
                if (data.turn === turn)
                    status = data.reason.kind;
                if (openTurn === data.turn)
                    openTurn = null;
                break;
            case 'user/message':
                // data IS the UserMessage; ownership = the turn open at append time.
                if (openTurn === turn) {
                    const text = textOf(data);
                    if (text.trim())
                        users.push(text);
                }
                break;
            case 'assistant/message':
                if (data.turn === turn) {
                    seen = true;
                    const text = textOf(data.message);
                    if (text.trim())
                        steps.push({ step: data.step, text });
                }
                break;
            default:
                break;
        }
    }
    if (!seen)
        return null;
    const lines = [
        // Epistemic frame, aligned with the kernel's evidence tiers: a sealed turn
        // establishes what was SAID, never current world state. Verbatim, but old.
        `[sealed turn slice-turn-${turn} · status ${status} · ${users.length} user message(s) · ${steps.length} assistant step(s) with text · historical record: establishes what was said, not current world state]`,
        '',
        '## User request (verbatim)',
        users.length > 0 ? users.join('\n\n') : '(no user text recorded for this turn)',
        '',
        '## Assistant response (verbatim)',
    ];
    if (steps.length === 0) {
        lines.push('(no assistant text recorded for this turn)');
    }
    else {
        for (const { step, text } of steps)
            lines.push(`[step ${step}]`, text, '');
    }
    return {
        rendered: lines.join('\n').replace(/\n+$/, '\n'),
        userMessages: users.length,
        assistantSteps: steps.length,
    };
}
/** Sealed turn numbers present in the log, for the not-found error message. */
function sealedTurns(events) {
    const turns = new Set();
    for (const event of events) {
        if (event.type === 'turn/end')
            turns.add(event.data.turn);
    }
    return [...turns].sort((a, b) => a - b);
}
function tokenize(text) {
    return text.toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter((t) => t.length > 1);
}
/** Snippet centred on the first query-term match, ±window code points. */
function snippetAround(text, terms, window = 90) {
    const lower = text.toLowerCase();
    let at = -1;
    for (const term of terms) {
        const i = lower.indexOf(term);
        if (i >= 0 && (at < 0 || i < at))
            at = i;
    }
    if (at < 0)
        at = 0;
    const chars = Array.from(text);
    const from = Math.max(0, at - window);
    const to = Math.min(chars.length, at + window);
    return (from > 0 ? '…' : '') + chars.slice(from, to).join('').replace(/\s+/g, ' ').trim() + (to < chars.length ? '…' : '');
}
/**
 * Scored search over the durable session log. Pure so the gate suite can
 * drive it without an agent.
 *
 * Scoring is deliberately simple — term-frequency with a short-document
 * boost and a recency tiebreak — and deliberately not called BM25: at
 * session scale (hundreds of events, all in memory) ranking subtlety buys
 * nothing, while the KIND filter does all the real work (see
 * DEFAULT_SEARCH_KINDS: ordinary tool output is the flood, and it is out
 * by default).
 */
export function searchSessionEvents(events, query, opts) {
    const kinds = new Set(opts?.kinds ?? DEFAULT_SEARCH_KINDS);
    const limit = Math.min(Math.max(opts?.limit ?? 5, 1), 20);
    const terms = tokenize(query);
    if (terms.length === 0)
        return [];
    // Corpus assembly mirrors renderSealedTurn's turn attribution EXACTLY —
    // including the turn/end clearing this function originally lacked. Without
    // it, anything injected between turns (a task notice, a host-side summary)
    // was silently attributed to the turn that had just ENDED, so search would
    // name a turn whose recall_turn page then failed to contain the text: two
    // tools disagreeing about the same locator (review repro #2).
    const docs = [];
    let openTurn = null;
    let seq = 0;
    for (const event of events) {
        seq += 1;
        const data = event.data;
        switch (event.type) {
            case 'turn/start':
                openTurn = data.turn;
                break;
            case 'turn/end':
                if (openTurn === data.turn)
                    openTurn = null;
                break;
            case 'user/message':
                if (kinds.has('user') && openTurn !== null) {
                    const text = textOf(data);
                    if (text.trim())
                        docs.push({ turn: openTurn, kind: 'user', text, seq });
                }
                break;
            case 'assistant/message': {
                const turn = data.turn;
                const step = data.step;
                const message = data.message;
                if (kinds.has('assistant')) {
                    const text = textOf(message);
                    if (text.trim())
                        docs.push({ turn, step, kind: 'assistant', text, seq });
                }
                if (kinds.has('tool_input')) {
                    for (const block of message.content) {
                        if (block.type === 'tool-call') {
                            // The recall tools' own calls are queries ABOUT history, not
                            // history: indexing them makes every search self-match its own
                            // argument string (review repro #1).
                            if (block.name === RECALL_TOOL_NAME || block.name === RECALL_SEARCH_TOOL_NAME)
                                continue;
                            const text = `${block.name ?? ''} ${block.arguments ?? ''}`;
                            if (text.trim())
                                docs.push({ turn, step, kind: 'tool_input', text, seq });
                        }
                    }
                }
                break;
            }
            case 'tool/result': {
                const turn = data.turn;
                const step = data.step;
                const raw = JSON.stringify(data.message ?? {});
                const isError = raw.includes('"isError":true');
                const kind = isError ? 'tool_error' : 'tool_output';
                if (kinds.has(kind)) {
                    docs.push({ turn, step, kind, text: raw, seq });
                }
                break;
            }
            default:
                break;
        }
    }
    // The still-open turn is NOT history: its content already sits in front of
    // the model, and its events include the very search being executed. Serving
    // it back is pure self-noise (review repro #1), so the open turn at scan
    // end is excluded from the corpus.
    const sealedDocs = openTurn === null ? docs : docs.filter((doc) => doc.turn !== openTurn);
    const hits = [];
    for (const doc of sealedDocs) {
        const lower = doc.text.toLowerCase();
        let tf = 0;
        let matched = 0;
        for (const term of terms) {
            let i = lower.indexOf(term);
            if (i < 0)
                continue;
            matched += 1;
            while (i >= 0) {
                tf += 1;
                i = lower.indexOf(term, i + term.length);
            }
        }
        if (matched === 0)
            continue;
        // All-terms coverage dominates LEXICOGRAPHICALLY (x1000 over a capped
        // term-frequency term): a short document containing every query term must
        // outrank a flood that repeats one term 300 times. tf is capped at 10 —
        // beyond that repetition carries no extra evidence, only volume.
        const coverage = matched / terms.length;
        const brevity = 1 / Math.log2(4 + Array.from(doc.text).length / 200);
        const score = coverage * 1000 + Math.min(tf, 10) * brevity;
        hits.push({ turn: doc.turn, ...(doc.step === undefined ? {} : { step: doc.step }), kind: doc.kind, score, snippet: snippetAround(doc.text, terms) });
    }
    hits.sort((a, b) => b.score - a.score || b.turn - a.turn);
    return hits.slice(0, limit);
}
/** Render hits as a compact, actionable page: every hit names its recall_turn follow-up. */
export function renderSearchHits(query, hits, searchedKinds = DEFAULT_SEARCH_KINDS) {
    if (hits.length === 0) {
        // Say what was ACTUALLY searched. The first version hardcoded the default
        // kind list and suggested kinds: ["tool_output"] even to a caller who had
        // just searched exactly that (review repro #3).
        const searched = searchedKinds.join('/');
        const hint = searchedKinds.includes('tool_output')
            ? 'broaden the query, or check earlier sealed turns with recall_turn'
            : 'retry with kinds: ["tool_output"] if the fact was tool-born, or broaden the query';
        return `[recall_search "${query}" · 0 hits over kinds ${searched} — ${hint}]`;
    }
    const lines = [
        `[recall_search "${query}" · ${hits.length} hit(s) · historical record — for the verbatim full turn, call `
            + `recall_turn({"turn": "slice-turn-N"})]`,
    ];
    for (const hit of hits) {
        lines.push(`- slice-turn-${hit.turn}${hit.step === undefined ? '' : ` step ${hit.step}`} [${hit.kind}] ${hit.snippet}`);
    }
    return lines.join('\n');
}
/** The search tool: tier 1 of the two-tier recall (search → recall_turn verbatim fetch). */
export function recallSearchToolDefinition() {
    return defineTool({
        name: RECALL_SEARCH_TOOL_NAME,
        description: 'Search THIS session\'s durable history when you need something said or done earlier but do not know '
            + 'which turn. Returns scored hits with turn ids — follow up with recall_turn for the verbatim record. '
            + 'By default searches user/assistant text, tool inputs and tool errors; ordinary tool output is '
            + 'excluded as flood — pass kinds: ["tool_output"] to search it deliberately.',
        parameters: {
            query: { type: 'string', required: true, description: 'Terms to search for (matched case-insensitively).' },
            kinds: {
                type: 'array',
                description: 'Override the searched kinds. Any of: user, assistant, tool_input, tool_error, tool_output.',
                items: { type: 'string', enum: ['user', 'assistant', 'tool_input', 'tool_error', 'tool_output'] },
            },
            limit: { type: 'number', description: 'Max hits, 1-20. Default 5.' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args, exec) => {
            const agent = exec.agent;
            if (agent === undefined) {
                throw new Error('recall_search runs only inside an agent loop (no owning agent on this execution)');
            }
            const a = args;
            const query = typeof a?.query === 'string' ? a.query : '';
            if (!query.trim())
                throw new Error('recall_search needs {"query": "..."}');
            const kinds = Array.isArray(a.kinds) && a.kinds.length > 0 ? a.kinds : undefined;
            const limit = typeof a.limit === 'number' ? a.limit : undefined;
            const hits = searchSessionEvents(agent.session.events, query, { ...(kinds ? { kinds } : {}), ...(limit ? { limit } : {}) });
            return renderSearchHits(query, hits, kinds ?? DEFAULT_SEARCH_KINDS);
        },
    });
}
/**
 * The registered tool. One global registration serves every agent: the
 * scheduler stamps `exec.agent` on each execution (driver.ts sets `agent:
 * this` when building the ToolExecutionInput), so the handler reads the
 * calling agent's own session log and cannot cross sessions.
 */
export function recallToolDefinition() {
    return defineTool({
        name: RECALL_TOOL_NAME,
        description: 'Retrieve the verbatim full text of an earlier turn in THIS session: the complete user request and '
            + 'every assistant step, exactly as delivered. Use it when the SESSION TAPE shows a truncated entry '
            + '(`…[+N chars in sealed turn]`) or a `recall:` line names a turn. Serves from the durable session '
            + 'log, so it works after agent recreation too.',
        parameters: {
            turn: {
                type: 'string',
                required: true,
                description: 'The turn to recall, as the tape names it: "slice-turn-3" (or just "3").',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args, exec) => {
            const agent = exec.agent;
            if (agent === undefined) {
                throw new Error('recall_turn runs only inside an agent loop (no owning agent on this execution)');
            }
            const turn = parseTurnId(args?.turn);
            if (turn === null) {
                throw new Error('recall_turn needs {"turn": "slice-turn-N"} (or just "N")');
            }
            const page = renderSealedTurn(agent.session.events, turn);
            if (page === null) {
                const known = sealedTurns(agent.session.events);
                throw new Error(`no recorded turn ${turn} in this session`
                    + (known.length > 0 ? ` (sealed turns: ${known.slice(0, 20).join(', ')})` : ' (no sealed turns yet)'));
            }
            return page.rendered;
        },
    });
}
