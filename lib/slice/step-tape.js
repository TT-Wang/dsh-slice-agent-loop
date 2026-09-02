/**
 * step-tape.ts — 轮内封存(in-turn sealing)的纯函数层。
 *
 * 把 slice 在轮界做的事下沉到步级:一轮走到阈值后,最旧的一批步被折叠成
 * 封存条目——调用摘要 + 结果头尾 + 精确切口——原文留在会话日志,
 * `recall_step` 逐字取回。与 tape.ts 同一哲学:折叠但不丢失,构造即冻结。
 *
 * 本模块不做 I/O、不认识 driver;driver 负责"什么时候封、封哪些步、怎么把
 * 折叠后的消息拼回请求"。阈值经济学见 stepsToSeal。
 */
// ─────────────────────────────────────────────────────────── 截断
/** 每个工具结果在封存条目里保留的头/尾字符数(码点计,与 tape.ts 同口径)。 */
export const STEP_RESULT_HEAD_CHARS = 500;
export const STEP_RESULT_TAIL_CHARS = 160;
/** 封存步里助手可见文本的头部保留。 */
export const STEP_ASSISTANT_HEAD_CHARS = 320;
/** 调用参数预览的单行上限。 */
export const STEP_ARGS_PREVIEW_CHARS = 160;
/** 头 + 精确切口标记 + 尾;不超长则原样。标记里的 N 是被切掉的码点数。 */
export function cutHeadTail(text, head, tail, unit) {
    const chars = Array.from(text);
    if (chars.length <= head + tail)
        return text;
    const cut = chars.length - head - tail;
    return chars.slice(0, head).join('') + ` …[+${cut} chars in sealed ${unit}]… ` + chars.slice(chars.length - tail).join('');
}
/** 参数原文压成单行预览(JSON 原样,只折行与截尾)。 */
export function argsPreview(raw, cap = STEP_ARGS_PREVIEW_CHARS) {
    const oneLine = raw.replace(/\s+/g, ' ').trim();
    const chars = Array.from(oneLine);
    return chars.length <= cap ? oneLine : chars.slice(0, cap).join('') + '…';
}
/** 一步的封存条目。首行固定为 `[step N]`,便于 recall_step 对应。 */
export function renderSealedStep(turn, s) {
    const lines = [`[step ${s.step} · recall_step(${turn}, ${s.step}) returns full results]`];
    const assistant = s.assistantText.trim();
    if (assistant)
        lines.push(`  said: ${cutHeadTail(assistant, STEP_ASSISTANT_HEAD_CHARS, 0, 'step')}`);
    for (const c of s.calls) {
        lines.push(`  → ${c.name}(${argsPreview(c.arguments)})${c.isError ? ' !error' : ''}`);
        const body = c.resultText.trim();
        if (body) {
            const shown = cutHeadTail(body, STEP_RESULT_HEAD_CHARS, STEP_RESULT_TAIL_CHARS, 'step');
            for (const l of shown.split('\n'))
                lines.push(`    ${l}`);
        }
    }
    for (const u of s.interjections) {
        const t = u.trim();
        if (t)
            lines.push(`  user: ${cutHeadTail(t, STEP_ASSISTANT_HEAD_CHARS, 0, 'step')}`);
    }
    return lines.join('\n') + '\n';
}
export const STEP_TAPE_HDR = '# SEALED STEPS (in-turn record of THIS turn\'s earlier steps: each tool call and the head/tail of its '
    + 'result, exactly as executed. `…[+N chars in sealed step]…` marks an exact cut — recall_step(turn, step) '
    + 'returns that step\'s full results verbatim. Sealed steps establish what already happened in this turn, '
    + 'not current world state: files may have changed since; the OPEN FILES index and fresh reads are authoritative)\n';
/** 封存块正文:标题 + 条目按序拼接。条目 append-only,拼接结果对同输入字节稳定。 */
export function renderStepTape(entries) {
    return STEP_TAPE_HDR + entries.join('');
}
export const DEFAULT_SEAL_POLICY = { enabled: false, sealTokens: 40_000, batchSteps: 8, keepSteps: 4, protectEarlySteps: 2 };
/** 封存批次的渲染体量必须 ≤ 原文的这个比例才值得(否则折叠只多付一次缓存重建
 *  而不省上下文——l1 长链病态:结果比 head+tail 保留窗还短)。 */
export const SEAL_MIN_SAVE_RATIO = 0.6;
/** 这批封存是否划算:sealedChars 相对被移除的 rawChars 至少省下 (1-ratio)。 */
export function sealSavesEnough(rawChars, sealedChars, ratio = SEAL_MIN_SAVE_RATIO) {
    return rawChars > 0 && sealedChars <= rawChars * ratio;
}
/** 轨迹字符 → token 的保守估算(代码 + CJK 混合;归因实测 2.5–4.2)。 */
export const SEAL_CHARS_PER_TOKEN = 3.2;
/**
 * 本次请求前应封存的步数。0 = 不动。
 * 条件:启用 && 轨迹 ≥ 阈值 && 未封存的已完成步 ≥ batch + keep;
 * 封 batch 步,且封完仍保留 ≥ keep 步原文。
 */
export function stepsToSeal(policy, trajectoryChars, unsealedCompletedSteps, consideredThrough) {
    if (!policy.enabled)
        return 0;
    if (trajectoryChars < policy.sealTokens * SEAL_CHARS_PER_TOKEN)
        return 0;
    if (unsealedCompletedSteps < policy.batchSteps + policy.keepSteps)
        return 0;
    const n = Math.min(policy.batchSteps, unsealedCompletedSteps - policy.keepSteps);
    // 宪法保护:封存窗口 (consideredThrough, consideredThrough+n] 不得侵入前
    // protectEarlySteps 步。窗口起点在保护区内则右移起点(减少可封步数)。
    const windowStart = consideredThrough;
    const protectedUntil = policy.protectEarlySteps;
    if (windowStart >= protectedUntil)
        return n;
    const shrink = protectedUntil - windowStart;
    return Math.max(0, n - shrink);
}
export function resolveSealPolicy(input) {
    const p = { ...DEFAULT_SEAL_POLICY, ...(input ?? {}) };
    for (const key of ['sealTokens', 'batchSteps', 'keepSteps']) {
        if (!Number.isInteger(p[key]) || p[key] < 1)
            throw new Error(`inTurnSeal.${key} must be a positive integer`);
    }
    if (!Number.isInteger(p.protectEarlySteps) || p.protectEarlySteps < 0)
        throw new Error('inTurnSeal.protectEarlySteps must be a non-negative integer');
    return p;
}
