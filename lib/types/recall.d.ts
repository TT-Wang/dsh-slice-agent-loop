/**
 * recall_turn — the slice loop's memory-recall tool.
 *
 * The tape truncates every sealed reply at REPLY_CAP_CHARS (2,000 code points:
 * 1,400 head + 500 tail, src/slice/tape.ts) and marks the cut with
 * `…[+N chars in sealed turn]`; the online history policy's archive
 * checkpoints (src/context.ts) cut long text as `…[+N chars, recall_turn]…`
 * and name recall_turn / expand_result locators. Until this tool, the
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
 * mid-turn steering alike), so the scan tracks turn/start. A plugin-produced
 * message appended while no turn is open (a runtime snapshot projected between
 * turns) belongs to the turn that just ended — see ownerOf.
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
 * view "full" (default): user text, assistant text, then every original
 * record of the turn as JSON (reasoning, tool calls, tool output, metadata).
 * view "dialogue": the same user and assistant text, each exactly once, with
 * every tool result reduced to one locator line — the cheap page for "what
 * was said", with the tool output one expand_result call away.
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
    /** Copy-paste follow-up: recall_turn dialogue view for dialogue hits, expand_result by seq for tool hits. */
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
