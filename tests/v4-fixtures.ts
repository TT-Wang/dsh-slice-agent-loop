/**
 * Session format V4 fixture vocabulary shared by the specs.
 *
 * V4 has no shared `{ kind: 'plugin', plugin }` source: every producer owns a
 * kind. The host's runtime-context projection declares 'runtime-context' in a
 * dsh-agent-loop module that is not a public type entry, so the tests declare
 * the identical member here. A tool result is its own tool-role message
 * (`createToolResultMessage`), not a `tool-result` block inside a user message.
 */
import { createToolResultMessage, ToolCallId, type ContentBlock, type ContextFormed, type Message, type RequestMessage, type ToolResultMessage } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'runtime-context': { kind: 'runtime-context' } & ContextFormed
    /** A third-party producer as the V3-to-V4 migration names it; it may declare a context form. */
    'plugin:test-context': { kind: 'plugin:test-context' } & ContextFormed
  }
}

/** Source kind of a foreign (non-slice, non-host) producer in the specs. */
export const TEST_CONTEXT_SOURCE = 'plugin:test-context'

/** One V4 tool-role result answering `callId`. */
export function toolResult(callId: string, content: string | readonly ContentBlock[], isError = false): ToolResultMessage {
  return createToolResultMessage({
    callId: ToolCallId(callId),
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : [...content],
    isError,
  })
}

/** Durable request messages carry identity; identity-free one-shot inputs never reach these specs. */
export function durable(messages: readonly RequestMessage[]): Message[] {
  return messages.map((message) => {
    if (!('id' in message) || message.id === undefined) throw new Error('request carried an identity-free input')
    return message as Message
  })
}
