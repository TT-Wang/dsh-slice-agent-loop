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
/**
 * The registered tool. One global registration serves every agent: the
 * scheduler stamps `exec.agent` on each execution (driver.ts sets `agent:
 * this` when building the ToolExecutionInput), so the handler reads the
 * calling agent's own session log and cannot cross sessions.
 */
export declare function recallToolDefinition(): ToolDefinition;
export {};
