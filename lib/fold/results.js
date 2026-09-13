/** Original result lookup shared by narrow expansion and whole-step recall. */
import { readFile } from 'node:fs/promises';
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session';
function noteCalls(names, event) {
    if (event.type === 'tool/call')
        names.set(event.data.callId, event.data.name);
    if (event.type === 'assistant/message') {
        for (const block of event.data.message.content)
            if (block.type === 'tool-call')
                names.set(block.id, block.name);
    }
}
function blocksOf(message, block) {
    const blocks = message.content.filter((item) => item.type === 'tool-result');
    if (block === undefined)
        return blocks;
    if (!Number.isInteger(block) || block < 1)
        throw new Error('expand_result: "block" must be a positive integer');
    const selected = blocks[block - 1];
    if (selected === undefined)
        throw new Error(`expand_result: no result block ${block} (result has ${blocks.length} blocks)`);
    return [selected];
}
function textOf(block) {
    return block.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
}
function describeResult(calls, message, block) {
    const blocks = blocksOf(message, block);
    const names = [...new Set(blocks.map((item) => calls.get(String(item.toolCallId ?? message.source?.callId ?? '')) ?? 'tool'))];
    return { name: names.join(', ') || 'tool', text: blocks.map(textOf).join('\n') };
}
function resultEventAt(events, turn, step, call) {
    let ordinal = 0;
    for (const event of events) {
        if (event.type !== 'tool/result' || !isAppendSurfaceEvent(event))
            continue;
        if (event.data.turn === turn && event.data.step === step && ++ordinal === call)
            return event;
    }
    return undefined;
}
/** The ordinal counts original result events, never replacement copies or sibling blocks. */
export function fullResultAt(events, turn, step, call, block) {
    const result = resultEventAt(events, turn, step, call);
    if (result === undefined)
        return null;
    const calls = new Map();
    for (const event of events) {
        if (event.seq > result.seq)
            break;
        noteCalls(calls, event);
    }
    return describeResult(calls, result.data.message, block);
}
/** A replacement locator resolves to its durable original tool/result. */
export function originalResultAt(events, seq) {
    const seen = new Set();
    for (let at = seq;;) {
        const direct = events[at];
        const event = direct?.seq === at ? direct : events.find((item) => item.seq === at);
        if (event === undefined)
            throw new Error(`expand_result: no session event at seq ${at}`);
        if (event.type !== 'tool/result')
            throw new Error(`expand_result: seq ${at} is a ${event.type} event, not a tool result`);
        if (isAppendSurfaceEvent(event))
            return event;
        const source = event.sourceEventSeqs?.[0];
        if (source === undefined || seen.has(source))
            throw new Error(`expand_result: the replacement at seq ${at} names no original tool result`);
        seen.add(at);
        at = source;
    }
}
export function resultBySeq(events, seq, block) {
    const original = originalResultAt(events, seq);
    const calls = new Map();
    let call = 0;
    for (const event of events) {
        if (event.seq > original.seq)
            break;
        noteCalls(calls, event);
        if (event.type === 'tool/result' && isAppendSurfaceEvent(event)
            && event.data.turn === original.data.turn && event.data.step === original.data.step)
            call += 1;
    }
    return { ...describeResult(calls, original.data.message, block), seq: original.seq, turn: original.data.turn, step: original.data.step, call };
}
/** A durable spill preview names the stored bytes on its first line. */
export function spillLocatorOf(text) {
    const first = text.split('\n', 1)[0];
    const match = /^\[.* · full text \((\d+) bytes\) stored at (.+?) — .*\]$/.exec(first);
    return match ? { bytes: Number(match[1]), locator: match[2] } : undefined;
}
export function storedTextLocatorOf(logged) {
    // Native spill-policy bounds nested dispatch log copies separately. The
    // local backend's complete notice has fixed retrieval guidance; match that
    // suffix so a period inside a path cannot truncate the locator.
    const native = /(?:^|\n\n)\(Omitted \d+ bytes\. Full formatted result stored at: ([^\n]+)\. Use read with offset\/limit, or grep this path to search within it\.\)$/.exec(logged);
    return spillLocatorOf(logged) ?? (native ? { locator: native[1] } : undefined);
}
export async function originalText(logged, where) {
    const spill = storedTextLocatorOf(logged);
    if (spill === undefined)
        return logged;
    try {
        return await readFile(spill.locator, 'utf8');
    }
    catch (error) {
        throw new Error(`expand_result: the full text of ${where} (${spill.bytes ?? 'unknown'} bytes) was stored at ${spill.locator} and cannot be read from here (${String(error)}); read that locator with the file tools instead`);
    }
}
/** Hydrate each original text part before joining siblings or parts. A spill
 * preview identifies only its own part, never the text that follows it. */
export async function originalResultText(events, locator, where, block) {
    const event = 'seq' in locator ? originalResultAt(events, locator.seq)
        : resultEventAt(events, locator.turn, locator.step, locator.call);
    if (event === undefined)
        throw new Error(`expand_result: no tool result recorded at ${where}`);
    return (await Promise.all(blocksOf(event.data.message, block).map(async (item, index) => (await Promise.all(item.content.flatMap((part, partIndex) => part.type === 'text'
        ? [originalText(part.text, `${where} block ${block ?? index + 1} text part ${partIndex + 1}`)] : []))).join('\n')))).join('\n');
}
