/**
 * assemble.ts — DSH 原生的切片装配。
 *
 * 渲染 → 丢空 → 按数组顺序拼。没有区表、没有预算、没有降级、没有失败路径。
 * 契约见 plan/SEAMS.md；这里是它的全部实现。
 *
 * 取代 Python 移植的 types.ts / regions.ts / state.ts / compiler.ts /
 * buildSlice.ts / internal/placement.ts —— 那套东西为四档保真度、弹性降级和
 * 19 个分区而建，而其中 16 个分区从来没有生产者，降级机制一次都没触发过。
 */
import type { TapeEntry } from './tape.js';
/**
 * 一轮的全部输入。无状态，driver 每轮全量构造，字段无默认值。
 *
 * 只含已有生产者的字段：字段存在即承诺，而编译器不会催你兑现。需要 I/O、
 * hash 或脱敏的项由 driver 渲染成串再交（`openFiles` 即如此）——所有 I/O 和
 * 安全边界都在 driver 侧，本模块是纯函数。
 */
export interface SliceInput {
    /** 本轮用户原文。渲染在 <context> 之外的固定槽。 */
    request: string;
    /** 话题总目标。等于 request 时不渲染——追问的第一轮没有"先前目标"。 */
    goal: string;
    /** 封存轮的账本条目。rendered 在构造时冻结，这是它能进缓存前缀的原因。 */
    tape: readonly TapeEntry[];
    /** OPEN FILES 索引正文（driver 现算：盘态、行数、sha256、脱敏）。 */
    openFiles: string;
    /** 上一轮结束时未解决的工具错误原文。 */
    lastError: string;
}
export interface AssembledSlice {
    /** 宿主拥有的字节稳定 system 前缀，原样透传。 */
    system: string;
    /** 本轮的易变切片串。 */
    user: string;
}
/**
 * 一轮装配。
 *
 * 数组字面量的顺序**就是**输出顺序，也是唯一的排序轴。第一项恒为 tape：
 * 缓存命中边界 = `system + 上一轮结束时的 tape`，它之后的一切每轮必然 miss，
 * 所以任何把 tape 挪后或改写的改动都会让整个成本模型垮掉。往后越接近
 * CURRENT REQUEST 越急，未解决的错误因此排在最末。
 *
 * CURRENT REQUEST 和 NOW 不在 `<context>` 里：位置必须固定、不可缺席，且
 * CURRENT REQUEST 是最高指令权威，不该参与任何排序。
 */
export declare function assembleSlice(input: SliceInput, systemPrefix: string, hints?: string): AssembledSlice;
