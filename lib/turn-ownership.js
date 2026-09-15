/**
 * A user-role event belongs to the turn open when it was appended, or the
 * last ended turn (including errors/aborts) when appended between turns. Source metadata
 * distinguishes human input from generated context; it does not change the
 * recall page that owns the event. Before the first turn there is no page,
 * so the surface policy must retain such events instead of archiving them.
 *
 * Shared by surface sealing, recall_turn and recall_search: every archived
 * user-role event must resolve through the same turn locator in both tools.
 */
export function userMessageTurn(openTurn, lastEnded) {
    return openTurn ?? lastEnded;
}
