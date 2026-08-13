/**
 * Harness-universe adapter — one resolved set of harness module instances.
 *
 * dsh loads a plugin's module graph through Node's INTERNAL ModuleLoader
 * (cordis-plugin-loader `import()`: `loader.internal.import(...)`, required
 * for HMR), which bypasses the tsx hooks a source-run dsh uses for its own
 * graph. On a source checkout the harness therefore executes `src/*.ts`
 * while this plugin's static imports of the same packages resolve through
 * package.json `main` to the built `lib/*.js` — two live copies of each
 * module, each with its own `Symbol(...)`s and module-level singletons.
 * Measured casualties of that split:
 *
 *   - `createScope` stamps `Symbol('dsh.scope')` from OUR copy; the host's
 *     `scopeOf` reads ITS copy's symbol → "refusing to compose an unscoped
 *     context" at preset mount, killing every session.create.
 *   - `KNOWN_SESSION_EVENT_TYPES` is a mutable Set: registering slice/*
 *     types on our copy leaves the host's read path refusing our logs.
 *   - `TOOL_RUNTIME_SCHEDULER` (rc.1: TOOL_REGISTRY_SCHEDULER) is a non-global symbol: indexing the host's
 *     tool registry with our copy reads `undefined`.
 *   - `agentEvents`/`emitAgentEvent`/`assembleContextFor` brand carriers
 *     with scope symbols; `AGENT_LOOP_REQUESTS` is a module-level WeakSet
 *     (`markAgentLoopRequest`/`isAgentLoopRequest`); `LlmError` instanceof
 *     against host-thrown errors.
 *
 * Fix: detect which flavor the HOST runs (the ctx it hands us is an
 * instance of exactly one copy's `Context`) and, when the static imports
 * are the wrong copy, re-import the identity-sensitive packages through the
 * exports-map escape hatch every harness package ships (`"./src/*"`). That
 * specifier resolves to the very file URLs the host already has in the
 * module cache, so we receive the host's own instances — no second load.
 * On a released dsh (host runs lib) the static imports already match and
 * the src probe is never taken.
 *
 * Only identity-sensitive values route through here. Pure helpers (string
 * constants, brand casts, message builders, render/predicate functions
 * over plain data, `defineTool`) stay as ordinary static imports.
 */
import { Context } from '@deepseek-ai/cordis';
import * as staticAgent from '@deepseek-ai/dsh-agent';
import * as staticLlm from '@deepseek-ai/dsh-llm';
import * as staticScope from '@deepseek-ai/dsh-scope';
import * as staticSession from '@deepseek-ai/dsh-session';
import * as staticTools from '@deepseek-ai/dsh-tools';
export interface HarnessUniverse {
    readonly scope: typeof staticScope;
    readonly agent: typeof staticAgent;
    readonly session: typeof staticSession;
    readonly llm: typeof staticLlm;
    readonly tools: typeof staticTools;
}
/**
 * The resolved universe. Callers run strictly after
 * {@link ensureHarnessUniverse} completed (the lifecycle awaits it before
 * constructing any agent), so a miss here is a sequencing bug — fail loudly.
 */
export declare function harnessUniverse(): HarnessUniverse;
/** Nullable peek for callers that may legitimately run early (invariant middleware). */
export declare function maybeHarnessUniverse(): HarnessUniverse | undefined;
/**
 * Resolve (once) the module instances the HOST runs. Memoized per process:
 * one dsh process has one host universe.
 */
export declare function ensureHarnessUniverse(ctx: Context): Promise<HarnessUniverse>;
