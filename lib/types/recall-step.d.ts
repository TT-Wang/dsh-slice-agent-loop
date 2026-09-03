/**
 * recall-step.ts — 轮内封存的召回工具:逐字取回某一步的完整工具调用与结果。
 *
 * 与 recall_turn 同源:从持久会话日志(tool/call · tool/result 事件)取,不依赖
 * 内存轨迹,agent 重建后同样可用。封存条目首行写着 `recall_step(turn, step)`,
 * 模型据此索引。
 */
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
export declare const RECALL_STEP_TOOL_NAME = "recall_step";
/** 渲染某轮某步的全部调用与结果;该步无记录返回 null。 */
export declare function renderSealedStepPage(events: Iterable<{
    type: string;
    data: unknown;
}>, turn: number, step: number): string | null;
export declare function recallStepToolDefinition(): ToolDefinition;
