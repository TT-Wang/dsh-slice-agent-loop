// ─────────────────────────────────────────────────────────────── header
const TAPE_HDR = "# SESSION TAPE (append-only sealed record: turn digests · file base versions · the " +
    "patches YOU already applied (recorded by the host exactly as executed). CURRENT content " +
    "of a tracked file = its latest [base] + every later [patch], in order; each patch shows " +
    "the resulting sha256 — if it equals the file's hash in the OPEN FILES index below, your " +
    "composition IS the current file and you may edit from it directly. A file marked " +
    "[external], absent from the tape, or with a non-matching hash must be read_file'd " +
    "before editing. Digest entries are the sealed record of earlier turns, not " +
    "current-world truth)\n";
// The ported header promised a "· read call" column. `openFilesIndex` stopped
// emitting one (driver.ts: DSH registers its reader as `read` taking
// {file_path}, so a hardcoded call rots on any host rename) — the promise
// outlived the column. Dropped.
const FILES_HDR = "# OPEN FILES (index — path · lines · CURRENT on-disk sha256. Contents are NOT here: " +
    "compose them from the SESSION TAPE (base+patches) when the hashes match, read the file " +
    "when they don't)\n";
// The ported header pointed at a "RETAINED USER CORRECTIONS section" that this
// deployment never rendered and this schema does not define; its second branch
// keyed off `objectiveStatus`, which had no producer either. Both dropped.
const OBJ_HDR = "# STABLE TASK OBJECTIVE (original user objective; keep it active across follow-ups)\n";
const ERR_HDR = "# CURRENT ERROR (unresolved — fix this, verbatim)\n";
/** The live user ask, rendered once OUTSIDE the context fence at the salient tail. */
const REQ_HDR = "# CURRENT REQUEST (what the user is asking for RIGHT NOW — your PRIMARY instruction; " +
    "address THIS)\n";
const NOW_FOOTER = "# NOW: address the CURRENT REQUEST above. If it asks a QUESTION or for an explanation, answer " +
    "it directly (observation tools may ground the answer). If it asks for action, use reasonable " +
    "reversible judgment to carry it through within the exact user constraints; ask only when a " +
    "material ambiguity would change the result or before an unclear consequential external action. " +
    "Base changes on the current file text — your SESSION TAPE composition when its hash matches the OPEN FILES index, otherwise a fresh read_file; once the request is fully handled and verified " +
    "as well as the environment allows, deliver a brief closeout (outcome + verification — the host " +
    "already records each edit) and make NO tool call.";
/**
 * 一轮装配。
 *
 * 数组字面量的顺序**就是**输出顺序，也是唯一的排序轴。第一项恒为 tape：
 * 缓存命中边界 = `system + 上一轮结束时的 tape`，它之后的一切每轮必然 miss，
 * 所以任何把 tape 挪后或改写的改动都会让整个成本模型垮掉。往后越接近
 * CURRENT REQUEST 越急，未解决的错误因此排在最末。
 *
 * CURRENT REQUEST 和 NOW 不在 `<context>` 里：位置必须固定、不可缺席，且
 * CURRENT REQUEST 是最高指令权威，不该参与任何排序。
 */
export function assembleSlice(input, systemPrefix, hints = '') {
    const goal = input.goal.trim();
    const request = input.request.trim();
    const body = [
        input.tape.length > 0 ? TAPE_HDR + input.tape.map((e) => e.rendered).join('') + '\n' : '',
        goal && goal !== request ? `${OBJ_HDR}${goal}\n\n` : '',
        input.openFiles ? `${FILES_HDR}${input.openFiles}\n\n` : '',
        input.lastError.trim() ? `${ERR_HDR}${input.lastError.trim()}\n\n` : '',
        // 每段自带收尾的 '\n\n'，所以这里不再加分隔符——join('\n') 会多出一条
        // 空行，逐段逐轮地白付。
    ].filter((part) => part !== '').join('');
    return {
        system: systemPrefix,
        user: (body ? `<context>\n${body}\n</context>\n\n` : '')
            + (request ? `${REQ_HDR}${input.request}\n\n` : '')
            + NOW_FOOTER
            + (hints ? `\n${hints}` : ''),
    };
}
