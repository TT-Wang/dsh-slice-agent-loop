/**
 * 切片装配的最小观察点：不起 agent、不连 DSH，直接看一轮拼出来什么。
 *
 *     npx tsx examples/dbg-assemble.ts
 */
import { assembleSlice } from '../src/slice/index.js'
import { baseEntry, digestEntry } from '../src/slice/tape.js'

const { system, user } = assembleSlice(
  {
    request: 'Reply with exactly: SMOKE OK',
    goal: 'Reply with exactly: SMOKE OK',   // 等于 request ⇒ 目标段应当不渲染
    tape: [
      digestEntry('[turn slice-turn-1 · task t · completed]\nask: 先看一眼\n', 'slice-turn-1'),
      baseEntry('a.py', 'print(1)\n'),
    ],
    openFiles: '### a.py — 1 lines · sha256:cc42155088fc · (edited this session)',
    lastError: '',                           // 空 ⇒ CURRENT ERROR 段应当不渲染
    contributions: [],                       // 无插件登记 ⇒ PLUGIN CONTEXT 段不出现
  },
  '<SYSTEM PREFIX>',
)

console.log('SYSTEM:', JSON.stringify(system))
console.log('USER len:', user.length)
console.log('---')
console.log(user)
