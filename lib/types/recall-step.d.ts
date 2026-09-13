/** Original per-step tool records, with spill hydration and honest preview fallback. */
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
export declare const RECALL_STEP_TOOL_NAME = "recall_step";
type LogEvent = {
    type: string;
    data: unknown;
    surfaceOp?: unknown;
    seq?: unknown;
};
/** Pure log-only rendering marks spill previews explicitly; the registered tool hydrates them. */
export declare function renderSealedStepPage(events: Iterable<LogEvent>, turn: number, step: number): string | null;
export declare function recallStepToolDefinition(): ToolDefinition;
export {};
