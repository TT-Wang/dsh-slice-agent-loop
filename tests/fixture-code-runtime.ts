/** Deterministic programs for tool-bridge tests, independent of the host runtime package rename. */
import { Context, Service } from '@deepseek-ai/cordis'
import { isAbsolute } from 'node:path'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'

interface FixtureRunRequest extends CodeRunRequest {
  cwd?: string
  timeoutMs?: number | null
  sandboxPolicy?: unknown
}

/** These fixtures call supplied bindings directly; they do not execute model-written code. */
export abstract class FixtureCodeRuntime extends Service {
  abstract readonly language: string
  abstract readonly isolation: string

  constructor(ctx: Context) {
    // Published 0.1.5 uses codeRuntime; current source uses ptcRuntime. Both
    // names expose this same fixture, without loading an older host runtime.
    super(ctx, 'codeRuntime')
    ctx.provide('ptcRuntime', this)
  }

  /** Current PTC hosts resolve directory/deadline choices before calling run. */
  resolve(request: FixtureRunRequest): FixtureRunRequest & { cwd: string; timeoutMs: null } {
    if (request.sandboxPolicy !== undefined) throw new Error('Fixture runtime does not support sandbox policies')
    if (request.timeoutMs !== undefined && request.timeoutMs !== null) throw new Error('Fixture runtime does not support numeric deadlines')
    const cwd = request.cwd ?? process.cwd()
    if (!isAbsolute(cwd)) throw new Error('Fixture runtime requires an absolute cwd')
    return { ...request, cwd, timeoutMs: null }
  }

  abstract run(request: CodeRunRequest): Promise<CodeRunResult>
}
