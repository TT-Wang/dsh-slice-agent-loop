/**
 * Retained-size attribution for a .heapsnapshot written by heap-growth.mts --heap-snapshots.
 *
 *   node --max-old-space-size=8192 --import tsx scripts/bench/heap-snapshot-summary.mts file.heapsnapshot [--json out.json]
 *
 * Builds the dominator tree (Cooper–Harvey–Kennedy over strong edges; weak edges are
 * ignored) and reports the retained size of the structures this benchmark is about:
 * the Session and its event log, the surface manager, the stock loop's agent, the
 * slice fold's per-session SessionFolder and the slice read-history cache (found by
 * its field names), plus the top self-size groups by node type/constructor.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: 'string' } } })
const file = positionals[0]
if (file === undefined) throw new Error('usage: heap-snapshot-summary.mts file.heapsnapshot')

interface Snapshot {
  snapshot: { meta: { node_fields: string[]; node_types: [string[], ...unknown[]]; edge_fields: string[]; edge_types: [string[], ...unknown[]] }; node_count: number }
  nodes: number[]
  edges: number[]
  strings: string[]
}
const snap = JSON.parse(readFileSync(file, 'utf8')) as Snapshot
const meta = snap.snapshot.meta
const NF = meta.node_fields.length
const EF = meta.edge_fields.length
const nType = meta.node_fields.indexOf('type')
const nName = meta.node_fields.indexOf('name')
const nSelf = meta.node_fields.indexOf('self_size')
const nEdges = meta.node_fields.indexOf('edge_count')
const eType = meta.edge_fields.indexOf('type')
const eName = meta.edge_fields.indexOf('name_or_index')
const eTo = meta.edge_fields.indexOf('to_node')
const nodeTypes = meta.node_types[0]
const edgeTypes = meta.edge_types[0]
const WEAK = edgeTypes.indexOf('weak')
const SHORTCUT = edgeTypes.indexOf('shortcut')
const ELEMENT = edgeTypes.indexOf('element')
const HIDDEN = edgeTypes.indexOf('hidden')
const N = snap.nodes.length / NF
const nodes = snap.nodes
const edges = snap.edges

const firstEdge = new Uint32Array(N + 1)
for (let i = 0, e = 0; i < N; i += 1) { firstEdge[i] = e; e += nodes[i * NF + nEdges]! * EF }
firstEdge[N] = edges.length
const typeOf = (i: number) => nodeTypes[nodes[i * NF + nType]!]!
const nameOf = (i: number) => snap.strings[nodes[i * NF + nName]!]!
const selfOf = (i: number) => nodes[i * NF + nSelf]!
const edgeName = (e: number) => {
  const t = edges[e + eType]!
  return t === ELEMENT || t === HIDDEN ? String(edges[e + eName]) : snap.strings[edges[e + eName]!]!
}
const strong = (e: number) => { const t = edges[e + eType]!; return t !== WEAK && t !== SHORTCUT }

// ---------------------------------------------------------------- dominators (root = node 0)
const order = new Int32Array(N).fill(-1) // post-order number
const post: number[] = []
{
  const stack: number[] = [0]
  const cursor = new Uint32Array(N)
  const seen = new Uint8Array(N)
  seen[0] = 1
  cursor[0] = firstEdge[0]!
  while (stack.length) {
    const v = stack[stack.length - 1]!
    let pushed = false
    while (cursor[v]! < firstEdge[v + 1]!) {
      const e = cursor[v]!
      cursor[v] = e + EF
      if (!strong(e)) continue
      const w = edges[e + eTo]! / NF
      if (seen[w]) continue
      seen[w] = 1
      cursor[w] = firstEdge[w]!
      stack.push(w)
      pushed = true
      break
    }
    if (!pushed) { order[v] = post.length; post.push(v); stack.pop() }
  }
}
// predecessors (strong edges, reachable nodes only)
const predCount = new Uint32Array(N + 1)
for (let v = 0; v < N; v += 1) {
  if (order[v]! < 0) continue
  for (let e = firstEdge[v]!; e < firstEdge[v + 1]!; e += EF) if (strong(e)) { const w = edges[e + eTo]! / NF; if (order[w]! >= 0) predCount[w + 1]! += 1 }
}
for (let i = 1; i <= N; i += 1) predCount[i]! += predCount[i - 1]!
const preds = new Uint32Array(predCount[N]!)
{
  const fill = predCount.slice(0, N)
  for (let v = 0; v < N; v += 1) {
    if (order[v]! < 0) continue
    for (let e = firstEdge[v]!; e < firstEdge[v + 1]!; e += EF) if (strong(e)) { const w = edges[e + eTo]! / NF; if (order[w]! >= 0) preds[fill[w]!++] = v }
  }
}
const idom = new Int32Array(N).fill(-1)
idom[0] = 0
const intersect = (a: number, b: number) => {
  while (a !== b) {
    while (order[a]! < order[b]!) a = idom[a]!
    while (order[b]! < order[a]!) b = idom[b]!
  }
  return a
}
for (let changed = true; changed;) {
  changed = false
  for (let k = post.length - 2; k >= 0; k -= 1) {
    const v = post[k]!
    let dom = -1
    for (let p = predCount[v]!; p < predCount[v + 1]!; p += 1) {
      const u = preds[p]!
      if (idom[u]! < 0) continue
      dom = dom < 0 ? u : intersect(u, dom)
    }
    if (dom >= 0 && idom[v] !== dom) { idom[v] = dom; changed = true }
  }
}
const retained = new Float64Array(N)
for (const v of post) retained[v]! += selfOf(v)
for (const v of post) if (v !== 0 && idom[v]! >= 0) retained[idom[v]!]! += retained[v]!

// ---------------------------------------------------------------- report
const MB = (b: number) => +(b / 2 ** 20).toFixed(2)
const total = retained[0]!
const child = (v: number, name: string): number | undefined => {
  for (let e = firstEdge[v]!; e < firstEdge[v + 1]!; e += EF) if (edgeName(e) === name) return edges[e + eTo]! / NF
  return undefined
}
const fieldsOf = (v: number) => { const s = new Set<string>(); for (let e = firstEdge[v]!; e < firstEdge[v + 1]!; e += EF) s.add(edgeName(e)); return s }

const named: Record<string, { count: number; retainedMB: number }> = {}
const note = (label: string, v: number | undefined) => {
  if (v === undefined) return
  const row = named[label] ??= { count: 0, retainedMB: 0 }
  row.count += 1
  row.retainedMB = +(row.retainedMB + MB(retained[v]!)).toFixed(2)
}
for (let v = 0; v < N; v += 1) {
  if (typeOf(v) !== 'object') continue
  const name = nameOf(v)
  if (name === 'Session') {
    note('Session (all it dominates)', v)
    note('Session.log array', child(v, 'log'))
    note('Session.surfaceManager', child(v, 'surfaceManager'))
    note('Session.eventsSnapshot', child(v, 'eventsSnapshot'))
  } else if (name === 'SessionFolder') note('slice SessionFolder (fold state)', v)
  else if (name === 'Agent' || name === 'AgentLoopAgent') note(`${name}`, v)
  else if (name === 'Object') {
    const f = fieldsOf(v)
    if (f.has('priorIndex') && f.has('dispatches') && f.has('roots')) note('slice read-history cache', v)
  }
}

// Retained size per event type, over the elements of Session.log. A child shared by
// two events (or with another holder) is dominated by the Session itself, so it is
// reported as `shared` rather than under either type.
const byEventType: Record<string, { count: number; retainedMB: number }> = {}
let eventsRetained = 0
let sessionRetained = 0
for (let v = 0; v < N; v += 1) {
  if (typeOf(v) !== 'object' || nameOf(v) !== 'Session') continue
  sessionRetained += retained[v]!
  const log = child(v, 'log')
  if (log === undefined) continue
  for (let e = firstEdge[log]!; e < firstEdge[log + 1]!; e += EF) {
    if (edges[e + eType] !== ELEMENT) continue
    const event = edges[e + eTo]! / NF
    const typeNode = child(event, 'type')
    const op = child(event, 'surfaceOp')
    // A replacement's surfaceOp is an object ({op:'replace',…}); an append's is the string 'append'.
    const type = (typeNode === undefined ? '?' : nameOf(typeNode)) + (op !== undefined && typeOf(op) === 'object' ? ' (replace)' : '')
    const row = byEventType[type] ??= { count: 0, retainedMB: 0 }
    row.count += 1
    row.retainedMB += retained[event]! / 2 ** 20
    eventsRetained += retained[event]!
  }
}
for (const row of Object.values(byEventType)) row.retainedMB = +row.retainedMB.toFixed(2)
const eventsSplit = { perEventMB: MB(eventsRetained), sharedOrOtherUnderSessionMB: MB(sessionRetained - eventsRetained) }

const groups = new Map<string, { count: number; self: number }>()
for (let v = 0; v < N; v += 1) {
  if (order[v]! < 0) continue
  const t = typeOf(v)
  const key = t === 'object' || t === 'closure' ? `${t}:${nameOf(v)}` : t
  const g = groups.get(key) ?? { count: 0, self: 0 }
  g.count += 1
  g.self += selfOf(v)
  groups.set(key, g)
}
const top = [...groups.entries()].sort((a, b) => b[1].self - a[1].self).slice(0, 20)
  .map(([key, g]) => ({ group: key, count: g.count, selfMB: MB(g.self) }))

const summary = { file, nodes: N, reachableNodes: post.length, totalRetainedMB: MB(total), named, eventsSplit, byEventType, topSelf: top }
console.log(JSON.stringify(summary, null, 1))
if (opt.json !== undefined) writeFileSync(opt.json, `${JSON.stringify(summary, null, 1)}\n`)
