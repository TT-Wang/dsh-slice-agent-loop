import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
// rc8: CallId 更名 ToolCallId(brand 化)。
import { ToolCallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export function errorResponse(message = 'provider failed', code = 'SERVER'): StreamChunk[] {
  return [{ type: 'finish', reason: { kind: 'error', failure: { message, code } } }]
}

export function toolCallResponse(rawCallId: string, name: string, args: object): StreamChunk[] {
  const id = ToolCallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Build one assistant response containing several model-ordered tool calls. */
export function multiToolCallResponse(
  calls: ReadonlyArray<{ id: string; name: string; args: object }>,
): StreamChunk[] {
  const chunks: StreamChunk[] = []
  calls.forEach((call, index) => {
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: ToolCallId(call.id),
          name: call.name,
          arguments: JSON.stringify(call.args),
        },
      },
    )
  })
  chunks.push(
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

export class MockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  /**
   * `contextWindow` drives the slice capacity budget (elasticity / locator
   * downgrade). Left undefined the driver applies no bound — which is exactly
   * how that whole path stayed dead code and untested (评审 E/#32).
   */
  constructor(
    private readonly responses: Array<StreamChunk[] | 'hang' | Error>,
    private readonly contextWindow?: number,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      // DSH 读的是嵌套的 `context.contextWindow`（llm/src/index.ts:658），
      // 不是顶层字段——写错了 preparedCall.context 就恒为 undefined。
      ...(this.contextWindow === undefined ? {} : { context: { contextWindow: this.contextWindow } }),
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('mock response exhausted')
    if (response instanceof Error) throw response
    if (response === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    const chunks = response
    for (const chunk of chunks) yield chunk
  }
}
