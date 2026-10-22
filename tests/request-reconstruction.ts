/**
 * Test-owned request-reconstruction check for loop-built LLM calls.
 *
 * Up to 0.2.0-rc.2 the host shipped this check as the `agent-loop-invariant`
 * companion (`@deepseek-ai/dsh-agent-loop/invariant`, registered through
 * `@deepseek-ai/dsh-invariants`). 0.2.1 removed every runtime invariant plugin
 * and ships nothing in their place (upstream f028f25667,
 * docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants). The suite still
 * depends on the check: a dispatched request that differs from its durable
 * session derivation must fail the turn, or a seal or fold that desynchronised
 * the surface from the log would go unnoticed. This is the 0.2.0-rc.2 check,
 * restated here so it runs the same on every supported host.
 */
import type { Context } from '@deepseek-ai/cordis'
import { isAgentLoopRequest, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { foldRequestHeader } from '@deepseek-ai/dsh-session'

/** Thrown at dispatch, so the loop reports it as an agent error and the model never sees the request. */
export class RequestReconstructionError extends Error {
  override readonly name = 'RequestReconstructionError'
}

function fail(reason: string): never {
  throw new RequestReconstructionError(reason)
}

/**
 * Reject a loop-built request whose messages are not exactly the session's
 * durable derivation, or whose call configuration and tools differ from the
 * folded request header. Requests the loop did not build pass through.
 * @param ctx - context carrying `llm` and `sessions`.
 * @returns the listener's disposer.
 */
export function requireReconstructableRequests(ctx: Context): () => void {
  // Prepend, so a short-circuiting replay listener cannot silence the check.
  return ctx.on('llm/stream', (options: GenerateOptions, next) => {
    if (!isAgentLoopRequest(options)) return next()
    if (!Object.isFrozen(options)) fail('a loop-built request must be frozen')
    if (!Object.isFrozen(options.messages)) fail('a loop-built request must carry a frozen messages array')
    const session = options.sessionId === undefined ? undefined : ctx.sessions.get(options.sessionId)
    if (session === undefined) fail(`a loop-built request must carry a live session id, got "${String(options.sessionId)}"`)
    const events = session.snapshotEvents()
    if (!events.some(event => event.type === 'step/start')) fail('a loop-built request with no step/start in its session log')
    const header = foldRequestHeader(events)
    if (header === undefined) fail('a loop-built request with no request/header event in its session log')
    if (JSON.stringify(options.messages) !== JSON.stringify(session.deriveMessages())) {
      fail(`llm request for session "${String(session.id)}" diverges from the dispatch-time durable derivation (log-reconstruction desync)`)
    }
    // The system prompt travels inside `messages` as surface node 0, never as `system`.
    const headerMatches = options.model === header.config.model
      && options.system === undefined
      && options.temperature === header.config.temperature
      && options.maxTokens === header.config.maxTokens
      && JSON.stringify(options.stop) === JSON.stringify(header.config.stop)
      && JSON.stringify(options.tools ?? []) === JSON.stringify(header.tools ?? [])
    if (!headerMatches) fail(`llm request for session "${String(session.id)}" diverges from the folded request header`)
    return next()
  }, { global: true, prepend: true })
}
