/** Slice context policy for the stock DSH agent loop. */
import { Context, Service } from '@deepseek-ai/cordis';
import { type HistoryPolicy } from './context.js';
import { type ReasoningEffortDefault } from './effort-default.js';
import { type Config as FoldConfig } from './fold/index.js';
export interface HistoryConfig {
    /**
     * Completed assistant/tool spans left raw at the tail (default 0: sealed at the first step of the next turn).
     * Human user messages always remain at their original nodes, regardless of this setting.
     * Kept turns remain verbatim and may still hit the provider cache. Sealing an older turn
     * changes the prefix before the retained raw tail, which can make that tail miss the cache.
     */
    keepRecentTurns?: number;
    /** Optional code-point cap for new entry text (minimum 256); omitted preserves all assistant text. Never caps user nodes or rewrites frozen entries. */
    entryMaxChars?: number;
    /**
     * Opt-in working-set retention (omitted: off). When a turn seals, the steps holding the latest
     * full view of each file changed in that turn or the `turns` turns before it (default 2), and
     * that turn's later changes to it, stay raw at their positions, up to `maxChars` per turn
     * (default 48,000). `{}` enables the defaults. See src/working-set.ts.
     */
    workingSet?: WorkingSetConfig;
}
export interface WorkingSetConfig {
    turns?: number;
    maxChars?: number;
}
export interface Config {
    /** Optional positive step cap; omitted means the stock loop controls termination. */
    maxStepsPerTurn?: number;
    defaultReasoningEffort?: ReasoningEffortDefault;
    digest?: FoldConfig['digest'];
    fold?: Omit<FoldConfig, 'digest'>;
    history?: HistoryConfig;
    /** Experimental rollback loops are retired; only the native slice policy is supported. */
    mode?: 'slice';
}
export declare const DEFAULT_HISTORY: Readonly<HistoryPolicy>;
/**
 * Reject unrecognised keys at load, but say which kind of wrong it is: a key
 * the retired driver used gets its migration note; anything else is unknown and
 * names the nearest valid key. A typo is not a retirement.
 */
export declare function checkConfigKeys(config: object): void;
export declare class SliceLoopPlugin extends Service {
    static inject: string[];
    constructor(ctx: Context, config?: Config);
}
export default SliceLoopPlugin;
