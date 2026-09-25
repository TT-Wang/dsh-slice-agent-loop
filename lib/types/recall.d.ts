/**
 * recall_turn and recall_search read original events from the durable DSH log.
 * The current tape policy (src/context.ts) may shorten requests, replies and
 * read indexes to fit a new entry. Its recall locators resolve to these events;
 * no second archive or virtual context filesystem is involved.
 *
 * Full pages preserve original records as JSON; dialogue pages show user and
 * assistant text once, with tool-result locators. Both distinguish generated
 * context from human input and work after session recreation.
 *
 * Assistant messages carry their turn explicitly. User-role messages share
 * userMessageTurn with surface sealing: the open turn owns step-1 input and
 * mid-turn steering; the last ended turn owns between-turn messages. Before
 * the first turn there is no recall page, so the surface policy retains the
 * original message. Recall records what was said, not present world state.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
export declare const RECALL_TOOL_NAME = "recall_turn";
export declare const RECALL_SEARCH_TOOL_NAME = "recall_search";
/**
 * The recall family: tools whose inputs are queries ABOUT history and whose
 * outputs are copies OF history. Neither is evidence — indexing them makes a
 * search self-match its own argument string, and re-surfaces already-recalled
 * text as if it had been said a second time.
 */
export declare const RECALL_FAMILY: ReadonlySet<string>;
/**
 * Event kinds recall_search scans, and the flood guard that shapes them.
 *
 * Ordinary tool OUTPUT is excluded from the dialogue kinds — it is the
 * session's highest-volume, lowest-signal text (file dumps, listings), and
 * letting it into the corpus unbounded buries the sentence the model actually
 * said under kilobytes of cat. Tool INPUT (what was asked of a tool) and tool
 * ERRORS stay in: both are short and load-bearing. scope "auto" admits tool
 * output through bounded slots (TOOL_OUTPUT_SLOTS hits, TOOL_SNIPPET_CHARS
 * each); kinds: ['tool_output'] searches it unbounded.
 *
 * CONTEXT is user-role text a plugin produced rather than the human: runtime-
 * context snapshots and injected notices. It is searched by default because
 * the history policy archives superseded snapshots out of the request view
 * and points at these tools for them (src/context.ts) — an omission is only
 * legal when a recall tool actually serves the omitted content.
 */
export declare const DEFAULT_SEARCH_KINDS: readonly ["user", "assistant", "context", "tool_input", "tool_error"];
export type SearchKind = (typeof DEFAULT_SEARCH_KINDS)[number] | 'tool_output';
export type SearchScope = 'dialogue' | 'auto';
export declare const TOOL_OUTPUT_SLOTS = 3;
export declare const TOOL_SNIPPET_CHARS = 600;
export type RecallView = 'full' | 'dialogue';
/** `slice-turn-7`, `7`, or 7 → 7; null when unparseable. */
export declare function parseTurnId(value: unknown): number | null;
type LogEvent = {
    type: string;
    data: unknown;
    surfaceOp?: unknown;
    seq?: unknown;
};
interface SealedTurnPage {
    rendered: string;
    userMessages: number;
    assistantSteps: number;
    /** User-role messages a plugin produced: runtime snapshots, injected notices. */
    contextMessages: number;
}
/**
 * Render one turn's verbatim page from durable session events. Pure so the
 * gate suite can drive it without an agent. Returns null when the log holds
 * nothing for that turn.
 *
 * view "dialogue" (default): user text and assistant text, each exactly once,
 * with every tool result reduced to one locator line — the cheap page for
 * "what was said", with the tool output one expand_result call away.
 * view "full": the same text, then every original record of the turn as JSON
 * (reasoning, tool calls, tool output, metadata). Two orders of magnitude
 * larger on a working turn, so it is served only when asked for by name.
 *
 * Both views serve generated context (runtime snapshots, injected notices) in
 * its own section, never folded into the human's request: an archived or
 * superseded snapshot must stay reachable from the page its locator names.
 */
export declare function renderSealedTurn(events: Iterable<LogEvent>, turn: number, opts?: {
    view?: RecallView;
}): SealedTurnPage | null;
/** One scored hit: enough to decide, plus the exact follow-up call that returns the original. */
export interface RecallHit {
    turn: number;
    step?: number;
    kind: SearchKind;
    score: number;
    snippet: string;
    /** Durable tool/result event seq (tool_output / tool_error hits only). */
    seq?: number;
    /** Copy-paste follow-up: dialogue for said text, full for tool inputs, expansion for tool results. */
    locator: string;
}
/** Resolve the searched kinds: explicit kinds win; otherwise the scope (dialogue kinds, "auto" adds bounded tool output). */
export declare function resolveSearchKinds(opts?: {
    kinds?: readonly SearchKind[];
    scope?: SearchScope;
}): readonly SearchKind[];
/**
 * Scored search over the durable session log. Pure so the gate suite can
 * drive it without an agent.
 *
 * Scoring is deliberately simple — term-frequency with a short-document
 * boost and a recency tiebreak — and deliberately not called BM25: at
 * session scale (hundreds of events, all in memory) ranking subtlety buys
 * nothing, while the KIND filter does all the real work (see
 * DEFAULT_SEARCH_KINDS: ordinary tool output is the flood, and it is out
 * unless asked for).
 *
 * Without kinds or scope the corpus is the dialogue kinds (the tool defaults
 * scope to "auto"). scope "auto" adds tool output through bounded slots: at
 * most TOOL_OUTPUT_SLOTS tool-output hits per query, each snippet at most
 * TOOL_SNIPPET_CHARS; explicit kinds are unbounded beyond `limit`.
 */
export declare function searchSessionEvents(events: Iterable<LogEvent>, query: string, opts?: {
    kinds?: readonly SearchKind[];
    scope?: SearchScope;
    limit?: number;
}): RecallHit[];
/** Render hits as a compact, actionable page: every hit names its exact follow-up call. */
export declare function renderSearchHits(query: string, hits: readonly RecallHit[], searchedKinds?: readonly SearchKind[]): string;
/** The search tool: tier 1 of the two-tier recall (search → recall_turn / expand_result verbatim fetch). */
export declare function recallSearchToolDefinition(): ToolDefinition;
/**
 * The registered tool. One global registration serves every agent: the
 * scheduler stamps `exec.agent` on each execution (driver.ts sets `agent:
 * this` when building the ToolExecutionInput), so the handler reads the
 * calling agent's own session log and cannot cross sessions.
 */
export declare function recallToolDefinition(): ToolDefinition;
export {};
