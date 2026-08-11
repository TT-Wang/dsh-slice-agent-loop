/**
 * text_utils.py port — only what the render path touches (normalize_ws, one_line).
 */
import { pySplitWS, pyslice } from "./pytext.js";
/** Collapse all runs of whitespace to a single space and strip. null/non-str -> ''. */
export function normalizeWs(s) {
    if (s === null || s === undefined)
        return "";
    return pySplitWS(String(s)).join(" ");
}
/** normalizeWs truncated to n code points. */
export function oneLine(s, n = 80) {
    return pyslice(normalizeWs(s), 0, n);
}
