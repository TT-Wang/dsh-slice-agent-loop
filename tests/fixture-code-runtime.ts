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

  /** The program shape run_code describes to the model; 0.2.1 reads it, 0.2.0 does not. Same value as the stock base class default. */
  get programFormat(): 'function-body' { return 'function-body' }

  /** PTC hosts resolve directory/deadline choices before calling run. */
  resolve(request: PtcRunRequest): PtcRunSpec {
    if (request.sandboxPolicy !== undefined) throw new Error('Fixture runtime does not support sandbox policies')
    if (request.timeoutMs !== undefined && request.timeoutMs !== null) throw new Error('Fixture runtime does not support numeric deadlines')
    const cwd = request.cwd ?? process.cwd()
    if (!isAbsolute(cwd)) throw new Error('Fixture runtime requires an absolute cwd')
    return { ...request, cwd, timeoutMs: null }
  }

  abstract run(spec: PtcRunSpec): Promise<PtcRunResult>

  /** 0.2.1 run_code releases an Agent's retained program state when the Agent is disposed; these fixtures keep none. */
  release(): Promise<void> { return Promise.resolve() }
}

/**
 * The `workingDirectory` service, reduced to what run_code asks of it.
 *
 * Since 0.2.1 an Agent-owned run_code call resolves its directory through
 * `ctx.workingDirectory.ensure(agent)` and fails with "run_code with an Agent
 * requires workingDirectory" when no such service is mounted (upstream
 * 79bd3d8da7; dsh-base mounts @deepseek-ai/dsh-working-directory). 0.2.0-rc.2
 * never reads it, so the stub is inert there. The real service also writes a
 * `working-directory/change` event and a runtime-context entry; that package
 * does not exist at 0.2.0-rc.2, so it cannot be mounted on both hosts.
 */
export class FixtureWorkingDirectory extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workingDirectory')
  }

  ensure(): Promise<string> { return Promise.resolve(process.cwd()) }
}
