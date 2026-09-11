/** Slice context policy for the stock DSH agent loop. */
import { Context, Service } from '@deepseek-ai/cordis';
import { type ReasoningEffortDefault } from './effort-default.js';
import { type Config as FoldConfig } from './fold/index.js';
export interface Config {
    /** Historical text only; retained runtime and instruction messages keep their positions. */
    maxHistoryChars?: number;
    /** Hard bound on serialized model messages, including current input and multimodal data. */
    maxRequestChars?: number;
    maxStepsPerTurn?: number;
    defaultReasoningEffort?: ReasoningEffortDefault;
    digest?: FoldConfig['digest'];
    fold?: Omit<FoldConfig, 'digest'>;
    /** Experimental rollback loops are retired; only the native slice policy is supported. */
    mode?: 'slice';
}
export declare const DEFAULT_MAX_STEPS_PER_TURN = 50;
export declare const DEFAULT_MAX_HISTORY_CHARS = 120000;
export declare const DEFAULT_MAX_REQUEST_CHARS = 400000;
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
