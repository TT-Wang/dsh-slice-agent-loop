/** Slice context policy for the stock DSH agent loop. */
import { Context, Service } from '@deepseek-ai/cordis';
import { type ReasoningEffortDefault } from './effort-default.js';
import { type Config as FoldConfig } from './fold/index.js';
export interface HistoryConfig {
    /** Serialized final view above which the oldest completed turns are archived (default 300,000). */
    highWaterChars?: number;
    /** Archive target once triggered (default 150,000); must be below highWaterChars. */
    lowWaterChars?: number;
    /** The newest complete turns whose raw records reach this many chars always stay raw; at least one turn (default 60,000). */
    keepRecentChars?: number;
    /** Keep turn 1's user message as an untouched append node; its assistant/tool run is archivable (default true). */
    pinFirstTurn?: boolean;
    /** Archived user messages at or below this length are kept verbatim in the checkpoint; longer ones keep head 600 / tail 300 (default 1,200). */
    pinUserChars?: number;
    /** Target for one checkpoint node's text (default 8,000); a run of many short turns may exceed it. */
    checkpointMaxChars?: number;
}
export interface Config {
    /**
     * Optional extra cap on rendered history (checkpoints plus retained raw turn text). History stays raw
     * until `history.highWaterChars`; setting this explicitly also archives when rendered history exceeds it.
     * No default: absent, only the water marks drive archiving. Archives stay at least
     * `highWaterChars - lowWaterChars` of new history apart, so a cap below that is a target, not a bound.
     */
    maxHistoryChars?: number;
    /** Hard bound on serialized model messages, including current input and multimodal data. */
    maxRequestChars?: number;
    maxStepsPerTurn?: number;
    defaultReasoningEffort?: ReasoningEffortDefault;
    digest?: FoldConfig['digest'];
    fold?: Omit<FoldConfig, 'digest'>;
    history?: HistoryConfig;
    /** Experimental rollback loops are retired; only the native slice policy is supported. */
    mode?: 'slice';
}
export declare const DEFAULT_MAX_STEPS_PER_TURN = 50;
export declare const DEFAULT_MAX_REQUEST_CHARS = 400000;
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
