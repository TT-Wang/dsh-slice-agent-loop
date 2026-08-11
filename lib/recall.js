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
        `[sealed turn slice-turn-${turn} · status ${status} · ${users.length} user message(s) · ${steps.length} assistant step(s) with text]`,
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
