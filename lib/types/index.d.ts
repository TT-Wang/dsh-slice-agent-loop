/** Slice context policy for the stock DSH agent loop. */
import { Context, Service } from '@deepseek-ai/cordis';
import { type ReasoningEffortDefault } from './effort-default.js';
import { type Config as FoldConfig } from './fold/index.js';
export interface HistoryConfig {
    /**
     * Completed turns left raw at the tail (default 0: a turn is sealed at the first step of the next turn).
     * Raising it trades prefix-stable bytes for verbatim recency — the kept turns are re-read in full on
     * every request until they seal, and they seal in one span when they do.
     */
    keepRecentTurns?: number;
    /** Keep turn 1's user message as an untouched append node; its assistant/tool run is sealable (default true). */
    pinFirstTurn?: boolean;
    /** Sealed user messages at or below this length are kept verbatim in the entry; longer ones keep head 600 / tail 300 (default 1,200). */
    pinUserChars?: number;
    /** Target for one entry's text (default 8,000); a span of many short turns may exceed it. */
    entryMaxChars?: number;
}
export interface Config {
    maxStepsPerTurn?: number;
    defaultReasoningEffort?: ReasoningEffortDefault;
    digest?: FoldConfig['digest'];
    fold?: Omit<FoldConfig, 'digest'>;
    history?: HistoryConfig;
    /** Experimental rollback loops are retired; only the native slice policy is supported. */
    mode?: 'slice';
}
export declare const DEFAULT_MAX_STEPS_PER_TURN = 50;
export declare const DEFAULT_HISTORY: Required<HistoryConfig>;
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
