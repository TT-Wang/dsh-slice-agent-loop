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
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
export declare const RECALL_TOOL_NAME = "recall_turn";
export declare const RECALL_SEARCH_TOOL_NAME = "recall_search";
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
export declare const DEFAULT_SEARCH_KINDS: readonly ["user", "assistant", "tool_input", "tool_error"];
export type SearchKind = (typeof DEFAULT_SEARCH_KINDS)[number] | 'tool_output';
/** `slice-turn-7`, `7`, or 7 → 7; null when unparseable. */
export declare function parseTurnId(value: unknown): number | null;
interface SealedTurnPage {
    rendered: string;
    userMessages: number;
    assistantSteps: number;
}
/**
 * Render one turn's verbatim page from durable session events. Pure so the
 * gate suite can drive it without an agent. Returns null when the log holds
 * nothing for that turn.
 */
export declare function renderSealedTurn(events: Iterable<{
    type: string;
    data: unknown;
}>, turn: number): SealedTurnPage | null;
/** One scored hit: enough to decide, plus the exact recall_turn follow-up. */
export interface RecallHit {
    turn: number;
    step?: number;
    kind: SearchKind;
    score: number;
    snippet: string;
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
export declare function searchSessionEvents(events: Iterable<{
    type: string;
    data: unknown;
}>, query: string, opts?: {
    kinds?: readonly SearchKind[];
    limit?: number;
}): RecallHit[];
/** Render hits as a compact, actionable page: every hit names its recall_turn follow-up. */
export declare function renderSearchHits(query: string, hits: readonly RecallHit[], searchedKinds?: readonly SearchKind[]): string;
/** The search tool: tier 1 of the two-tier recall (search → recall_turn verbatim fetch). */
export declare function recallSearchToolDefinition(): ToolDefinition;
/**
 * The registered tool. One global registration serves every agent: the
 * scheduler stamps `exec.agent` on each execution (driver.ts sets `agent:
 * this` when building the ToolExecutionInput), so the handler reads the
 * calling agent's own session log and cannot cross sessions.
 */
export declare function recallToolDefinition(): ToolDefinition;
export {};
