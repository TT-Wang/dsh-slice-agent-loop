/** Deterministic programs for tool-bridge tests; only program execution is replaced. */
import { Context, Service } from '@deepseek-ai/cordis'
import { isAbsolute } from 'node:path'
import type { PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'

/** These fixtures call supplied bindings directly; they do not execute model-written code. */
export abstract class FixtureCodeRuntime extends Service {
  abstract readonly language: string
  abstract readonly isolation: string

  constructor(ctx: Context) {
    super(ctx, 'ptcRuntime')
  }

  /** PTC hosts resolve directory/deadline choices before calling run. */
  resolve(request: PtcRunRequest): PtcRunSpec {
    if (request.sandboxPolicy !== undefined) throw new Error('Fixture runtime does not support sandbox policies')
    if (request.timeoutMs !== undefined && request.timeoutMs !== null) throw new Error('Fixture runtime does not support numeric deadlines')
    const cwd = request.cwd ?? process.cwd()
    if (!isAbsolute(cwd)) throw new Error('Fixture runtime requires an absolute cwd')
    return { ...request, cwd, timeoutMs: null }
  }

  abstract run(spec: PtcRunSpec): Promise<PtcRunResult>
}
