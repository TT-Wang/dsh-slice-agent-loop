import { createContinuity, fillAssistant, recordUser, sealTurn, trackCheck, trackReasoning, trackToolOutcome, } from '../continuity.js';
import { recordedFileObservations } from '../observations/files.js';
import { asRecord } from './events.js';
function textOf(value) {
    const content = asRecord(value).content;
    if (!Array.isArray(content))
        return '';
    return content.map(block => {
        const item = asRecord(block);
        return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
    }).join('');
}
/**
 * The sole continuity replay path. The live provider runs the same reducer over
 * its durable snapshot. Generated replacements are not additional conversation
 * facts. Tool metadata contributes historical read/touch hints, never file bases:
 * it contains neither opaque FsTarget identity nor a provably complete body.
 */
export function reduceContinuityEvents(input, sessionId, policy = {}) {
    const events = Array.from(input);
    const c = createContinuity();
    // A remote display path may literally be "__proto__".
    c.readCount = Object.create(null);
    c.touchCount = Object.create(null);
    const observations = recordedFileObservations(events);
    const readsByTurn = new Map();
    const touchesByTurn = new Map();
    for (const observation of observations) {
        let touches = touchesByTurn.get(observation.turn);
        if (touches === undefined)
            touchesByTurn.set(observation.turn, touches = new Set());
        touches.add(observation.address.path);
        if (observation.operation === 'read') {
            let reads = readsByTurn.get(observation.turn);
            if (reads === undefined)
                readsByTurn.set(observation.turn, reads = new Set());
            reads.add(observation.address.path);
        }
    }
    let turn;
    let hasUser = false;
    let userText = '';
    let assistantText = '';
    const calls = new Map();
    for (const event of events) {
        const data = asRecord(event.data);
        if (event.type === 'turn/start') {
            turn = typeof data.turn === 'number' ? data.turn : undefined;
            hasUser = false;
            userText = '';
            assistantText = '';
            calls.clear();
            continue;
        }
        if (turn === undefined)
            continue;
        if (event.type === 'user/message' && event.surfaceOp === 'append' && asRecord(data.source).kind === 'user') {
            const text = textOf(data);
            userText += userText && text ? `\n${text}` : text;
            if (!hasUser) {
                recordUser(c, userText, turn);
                hasUser = true;
            }
            else {
                c.conversation[c.conversation.length - 1].user = userText;
            }
            if (!c.goal && userText) {
                c.goal = userText;
                c.goalTurn = turn;
            }
        }
        else if (event.type === 'assistant/message' && event.surfaceOp === 'append' && data.turn === turn) {
            const text = textOf(data.message);
            if (text.trim())
                assistantText = text;
            if (hasUser)
                fillAssistant(c, text);
            if (policy.reasoningTape) {
                const content = asRecord(data.message).content;
                if (Array.isArray(content)) {
                    for (const block of content) {
                        const value = asRecord(block);
                        if (value.type === 'reasoning' && typeof value.text === 'string')
                            trackReasoning(c, value.text);
                    }
                }
            }
        }
        else if (event.type === 'tool/call' && data.turn === turn && typeof data.callId === 'string') {
            let args;
            try {
                args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments;
            }
            catch {
                args = undefined;
            }
            calls.set(data.callId, { name: String(data.name), arguments: args });
        }
        else if (event.type === 'tool/result' && event.surfaceOp === 'append' && data.turn === turn) {
            const content = asRecord(data.message).content;
            const block = asRecord(Array.isArray(content) ? content[0] : undefined);
            const resultText = textOf(block);
            trackToolOutcome(c, block.isError === true, resultText);
            const call = typeof block.toolCallId === 'string' ? calls.get(block.toolCallId) : undefined;
            const command = asRecord(call?.arguments).command;
            if (policy.checkInDigest && !block.isError && call?.name === 'bash' && typeof command === 'string'
                && /pytest|python -m|unittest|npm test|npm run test|cargo test|go test|vitest|jest/.test(command)) {
                trackCheck(c, command, resultText);
            }
        }
        else if (event.type === 'turn/end' && data.turn === turn) {
            // Observations are counted once per displayed address per turn, including
            // repeated reads and nested dispatches. No counters depend on admission.
            for (const path of readsByTurn.get(turn) ?? [])
                c.readCount[path] = (c.readCount[path] ?? 0) + 1;
            for (const path of touchesByTurn.get(turn) ?? [])
                c.touchCount[path] = (c.touchCount[path] ?? 0) + 1;
            if (hasUser) {
                sealTurn(c, {
                    ...policy, turnId: `slice-turn-${turn}`, status: String(asRecord(data.reason).kind ?? 'unknown'),
                    userRequest: userText, assistantReply: assistantText, sessionId,
                });
            }
            else {
                // A rejected/no-user turn must not leak pending state into its successor.
                c.pendingError = '';
                c.pendingReasoning = [];
                c.pendingCheck = undefined;
            }
            turn = undefined;
        }
    }
    return c;
}
export function buildContinuity(session, policy = {}) {
    return reduceContinuityEvents(session.snapshotEvents(), session.id, policy);
}
