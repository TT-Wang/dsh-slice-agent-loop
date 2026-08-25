/**
 * Public API for the bounded-context engine.
 *
 * 两块，各自独立：
 *   assemble.ts — 一轮的切片装配（纯函数，无状态）
 *   tape.ts     — 跨轮账本（条目、差分、组合、压缩）
 */
export { assembleSlice } from "./assemble.js";
export { TapeEntry, baseEntry, patchEntry, externalEntry, replyEntry, reasoningEntry, findingEntry, knowledgeEntry, digestEntry, entryFromOp, renderTapeBase, renderTapePatch, renderTapeExternal, renderTapeReply, unifiedPatch, applyUnified, composeAfter, tapeRender, tapeChars, compactTape, reconcileTapeWithDigests, canonicalText, findingHash, knowledgeHash, TAPE_BUDGET_CHARS, REPLY_CAP_CHARS, REASONING_CAP_CHARS, _h, } from "./tape.js";
export { wrapUntrusted, redactText } from "./internal/safety.js";
export { normalizeWs, oneLine } from "./internal/textUtils.js";
export { ValueError, PyTypeError } from "./internal/errors.js";
