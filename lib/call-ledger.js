/**
 * call-ledger.ts — flag-gated per-call sidecar telemetry for miss attribution.
 *
 * Off unless SLICE_CALL_LEDGER_DIR is set (the bench sets it; production runs
 * pay zero cost). One JSONL file per session under that dir:
 *
 *   {"kind":"seed","turn":N,"system":…,"runtimeContext":…,"user":…}   per turn
 *   {"kind":"call","turn":N,"step":S,"provider":…,"model":…,"usage":…,"norm":…} per successful call
 *
 * The seed line captures the EXACT bytes of the turn's first-call request head
 * (system prefix · runtime-context block · slice user text) so the offline
 * tool (scripts/attribute-miss.mts) can diff adjacent turns and attribute the
 * first divergent byte to a zone. Usage is recorded raw AND normalized —
 * `norm.input` follows the bench-ledger convention (MISS tokens, i.e. fresh
 * prompt tokens not served from cache), `norm.reasoning` is split out per the
 * cost-attribution consensus (r1/s14b are output-side losses; next campaign
 * needs the column without re-running baselines).
 *
 * Telemetry must never break the loop: every write is try/caught, and the
 * first failure latches the ledger off for the rest of the process.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
/**
 * Tolerant reader for the usage shapes seen across DeepSeek's OpenAI-compat
 * API and DSH assemblers: snake_case (`prompt_cache_hit_tokens`) first, then
 * camelCase mirrors, then the generic `prompt_tokens_details.cached_tokens`.
 * Returns undefined when nothing recognizable is present.
 */
export function normalizeUsage(u) {
    if (u === null || typeof u !== 'object')
        return undefined;
    const r = u;
    const promptDetails = (r.prompt_tokens_details ?? r.promptTokensDetails);
    const completionDetails = (r.completion_tokens_details ?? r.completionTokensDetails);
    // DSH 计量形状(llm/src/types.ts:131 + 20260901 实证):cacheReadTokens 单列,
    // inputTokens 是 billed(=MISS)输入,total = input + cacheRead + output。
    // OpenAI 形状:prompt_tokens 是总量,hit 在 prompt_cache_hit_tokens/details。
    const hitDsh = num(r.cacheReadTokens) ?? num(r.cache_read_tokens);
    const hit = num(r.prompt_cache_hit_tokens) ?? num(r.promptCacheHitTokens)
        ?? hitDsh
        ?? num(promptDetails?.cached_tokens) ?? num(promptDetails?.cachedTokens);
    const promptTotal = num(r.prompt_tokens) ?? num(r.promptTokens)
        ?? (hitDsh === undefined ? num(r.input_tokens) ?? num(r.inputTokens) : undefined);
    const missDirect = num(r.prompt_cache_miss_tokens) ?? num(r.promptCacheMissTokens)
        ?? (hitDsh !== undefined ? num(r.inputTokens) ?? num(r.input_tokens) : undefined);
    const output = num(r.completion_tokens) ?? num(r.completionTokens)
        ?? num(r.output_tokens) ?? num(r.outputTokens) ?? 0;
    const reasoning = num(completionDetails?.reasoning_tokens) ?? num(completionDetails?.reasoningTokens)
        ?? num(r.reasoning_tokens) ?? num(r.reasoningTokens) ?? 0;
    const cacheRead = hit ?? 0;
    const input = missDirect ?? (promptTotal !== undefined ? Math.max(0, promptTotal - cacheRead) : undefined);
    if (input === undefined && hit === undefined && output === 0)
        return undefined;
    return { input: input ?? 0, cacheRead, output, reasoning };
}
let resolvedDir;
let latchedOff = false;
const preparedDirs = new Set();
function ledgerDir() {
    if (latchedOff)
        return null;
    if (resolvedDir === undefined) {
        const raw = process.env.SLICE_CALL_LEDGER_DIR;
        resolvedDir = raw !== undefined && raw.trim() !== '' ? raw.trim() : null;
    }
    return resolvedDir;
}
/** Test seam: re-read the env var and lift the failure latch. */
export function resetCallLedgerForTest() {
    resolvedDir = undefined;
    latchedOff = false;
    preparedDirs.clear();
}
function writeLine(sessionId, record) {
    const dir = ledgerDir();
    if (dir === null)
        return;
    try {
        if (!preparedDirs.has(dir)) {
            mkdirSync(dir, { recursive: true });
            preparedDirs.add(dir);
        }
        appendFileSync(join(dir, `${sessionId}.calls.jsonl`), JSON.stringify(record) + '\n', 'utf8');
    }
    catch {
        // Telemetry never interrupts the loop; first failure turns it off.
        latchedOff = true;
    }
}
/** Record the turn's seed bytes (called once per turn, at seed construction). */
export function recordSeedEvent(sessionId, seed) {
    writeLine(sessionId, { kind: 'seed', ts: Date.now(), ...seed });
}
/** Record one successful LLM call's usage (skipped calls carry no usage). */
export function recordCallEvent(sessionId, call) {
    const norm = normalizeUsage(call.usage);
    writeLine(sessionId, { kind: 'call', ts: Date.now(), ...call, ...(norm === undefined ? {} : { norm }) });
}
