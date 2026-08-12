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
 *   - `TOOL_REGISTRY_SCHEDULER` is a non-global symbol: indexing the host's
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
const STATIC_UNIVERSE = {
    scope: staticScope,
    agent: staticAgent,
    session: staticSession,
    llm: staticLlm,
    tools: staticTools,
};
let resolved;
let pending;
/**
 * The resolved universe. Callers run strictly after
 * {@link ensureHarnessUniverse} completed (the lifecycle awaits it before
 * constructing any agent), so a miss here is a sequencing bug — fail loudly.
 */
export function harnessUniverse() {
    if (resolved === undefined) {
        throw new Error('dsh-slice-agent-loop: harness universe not resolved — '
            + 'ensureHarnessUniverse(ctx) must complete before agents run');
    }
    return resolved;
}
/** Nullable peek for callers that may legitimately run early (invariant middleware). */
export function maybeHarnessUniverse() {
    return resolved;
}
/**
 * Resolve (once) the module instances the HOST runs. Memoized per process:
 * one dsh process has one host universe.
 */
export function ensureHarnessUniverse(ctx) {
    pending ??= resolveUniverse(ctx).then((universe) => {
        resolved = universe;
        return universe;
    });
    return pending;
}
/** Runtime-built specifier so tsc doesn't try to typecheck the host's src tree. */
function importHostSrc(pkg) {
    return import(`${pkg}/src/index.ts`);
}
async function resolveUniverse(ctx) {
    // The ctx the host constructed is an instance of exactly one cordis copy's
    // Context. If it matches OUR copy, the whole graph is single-instance and
    // the static imports are the host's own modules.
    if (ctx instanceof Context)
        return STATIC_UNIVERSE;
    try {
        const [scope, agent, session, llm, tools] = await Promise.all([
            importHostSrc('@deepseek-ai/dsh-scope'),
            importHostSrc('@deepseek-ai/dsh-agent'),
            importHostSrc('@deepseek-ai/dsh-session'),
            importHostSrc('@deepseek-ai/dsh-llm'),
            importHostSrc('@deepseek-ai/dsh-tools'),
        ]);
        return {
            scope: scope,
            agent: agent,
            session: session,
            llm: llm,
            tools: tools,
        };
    }
    catch (error) {
        throw new Error('dsh-slice-agent-loop: the host runs a different copy of the harness '
            + 'packages than this plugin\'s imports resolved to (ctx is not an '
            + 'instance of our cordis Context), and re-importing the host\'s '
            + 'copies via the "./src/*" export failed. Without shared instances, '
            + 'scope/session/tool symbol identities split and sessions cannot '
            + 'mount. This usually means a source-run dsh whose packages no '
            + 'longer ship src/ — update the plugin to the host\'s plugin-module '
            + 'resolution surface.', { cause: error });
    }
}
