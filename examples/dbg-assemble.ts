import { assembleSlice, normalizeCtx } from '/Users/tongtao/code/dsh-slice-agent-loop/src/slice/index.js'
const spec = { s: { task: { goal: 'Reply with exactly: SMOKE OK', goal_source: 'conversation' } } }
const ctx = normalizeCtx(spec, (t: string) => t)
const assembled = assembleSlice(ctx, { systemPrefix: '', request: 'Reply with exactly: SMOKE OK' })
console.log('PREFIX:', JSON.stringify(assembled.systemPrefix))
console.log('USER len:', assembled.userString.length)
console.log('USER:', JSON.stringify(assembled.userString.slice(0, 700)))
