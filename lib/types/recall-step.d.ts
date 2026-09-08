/**
 * recall-step.ts — 轮内封存的召回工具:逐字取回某一步的完整工具调用与结果。
 *
 * 与 recall_turn 同源:从持久会话日志(tool/call · tool/result 事件)取,不依赖
 * 内存轨迹,agent 重建后同样可用。
 *
 * turn/step 从哪来:在线路径上,归档检查点 `[slice checkpoint v1 …]`(src/context.ts)只给
 * recall_turn 与 expand_result({"seq": q}) 定位,写着 turn/step 的是折叠视图首行
 * (`expand_result({"turn": t, "step": s, "call": n})`)与 fold 可供性(src/fold/index.ts),
 * 模型据此索引整步。src/lab/step-tape.ts 的封存条目首行是同一形状,但它不在运行时路径上。
 */
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
export declare const RECALL_STEP_TOOL_NAME = "recall_step";
/** 渲染某轮某步的全部调用与结果;该步无记录返回 null。 */
export declare function renderSealedStepPage(events: Iterable<{
    type: string;
    data: unknown;
    surfaceOp?: unknown;
}>, turn: number, step: number): string | null;
export declare function recallStepToolDefinition(): ToolDefinition;
