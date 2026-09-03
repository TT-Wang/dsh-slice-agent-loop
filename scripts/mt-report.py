#!/usr/bin/env python3
"""多轮对照报告:新 slice+折叠账本(run-scenario)vs 历史 default 会话(h2h-sessions.py --json)。
用法:python3 scripts/mt-report.py <new-ledger-dir> <h2h-default.json>
历史 default 选取规则(flash):s1/s2/s3 两次(08-09/08-10)取均值;s13 08-10;s10 只取 08-24(压缩生效的有效轮);
s14b 取 08-12 与 08-26 r1(08-31 为 reasoning-ab 变体,排除);其余场景无基线。"""
import json, sys, glob, os, statistics
P = dict(miss=0.22, hit=0.007, out=0.66)
new_dir, h2h_json = sys.argv[1], sys.argv[2]
h2h = json.load(open(h2h_json))
PICK = {
  's1_longhorizon_debug': ['4b856309', '93afaf54'], 's2_taskdag_scheduler': ['7dc279b7', '27cc99c5'],
  's3_intervalset_algebra': ['6a06034f', 'a66b1635'], 's13_compact_amnesia': ['ab4da602'],
  's10_compactloss': ['e76249a4'], 's14b_recall_ladder': ['8521672c', '632121a8'],
}
VERDICT = {'s10_compactloss': '✗ (3 facts lost, README 勘误)', 's1_longhorizon_debug': '✓', 's2_taskdag_scheduler': '✓', 's3_intervalset_algebra': '✓', 's13_compact_amnesia': '✓', 's14b_recall_ladder': '✓'}
old = {}
for scen, sids in PICK.items():
    rs = [r for r in h2h if r['scenario'] == scen and r['arm'] == 'default' and r['session'] in sids]
    if rs: old[scen] = dict(n=len(rs), cost=statistics.mean(r['cost'] for r in rs), steps=statistics.mean(r['steps'] for r in rs), out=statistics.mean(r['out'] for r in rs), reasoning=statistics.mean(r['reasoning'] for r in rs), miss=statistics.mean(r['miss'] for r in rs), hit=statistics.mean(r['hit'] for r in rs), verdict=VERDICT.get(scen, '?'))
new = {}
same_cond = {}
for f in sorted(glob.glob(os.path.join(new_dir, '*.json'))):
    d = json.load(open(f)); t = d['totals']
    if d.get('arm') == 'transcript':  # 同条件补跑的 transcript 基线(bash 修复后)
        same_cond[d['scenario']] = dict(n=1, cost=(t['input']*P['miss']+t['cacheRead']*P['hit']+t['output']*P['out'])/1e6, steps=t['steps'], out=t['output'], reasoning=t['reasoning'], miss=t['input'], hit=t['cacheRead'], verdict=('✓' if d['verdict']['ok'] else '✗') + ' 同条件补跑')
        continue
    if d.get('arm') != 'slice-noseal': continue
    new[d['scenario']] = dict(ok=d['verdict']['ok'], detail=d['verdict']['detail'], cost=(t['input']*P['miss']+t['cacheRead']*P['hit']+t['output']*P['out'])/1e6, steps=t['steps'], out=t['output'], reasoning=t['reasoning'], miss=t['input'], hit=t['cacheRead'], digest=d.get('digest'))
order = ['s1_longhorizon_debug','s2_taskdag_scheduler','s3_intervalset_algebra','s4_multifile_refactor','s5_standing_constraints','s6_revert_by_reference','s13_compact_amnesia','s14b_recall_ladder','s10_compactloss','l1_chain_migrate','l2_ledger_state']
print(f"{'scenario':<24}{'default 历史':>14}{'$':>8}{'steps':>7}{'out':>8} | {'slice+fold':>10}{'$':>8}{'steps':>7}{'out':>8}{'Δ$':>7}  fold")
for s in order:
    o = old.get(s) or same_cond.get(s); n = new.get(s)
    if not o and not n: continue
    oc = f"{o['cost']:.4f}" if o else '—'; ov = (o['verdict'] + f" n={o['n']}") if o else '无基线'
    nv = ('✓' if n['ok'] else '✗') if n else '—'; nc = f"{n['cost']:.4f}" if n else '—'
    dl = f"{(n['cost']-o['cost'])/o['cost']*100:+.0f}%" if o and n else ''
    dg = f"{n['digest']['count']}×{n['digest']['charsBefore']//1000}K→{n['digest']['charsAfter']//1000}K" if n and n.get('digest') else ('0' if n else '')
    os_ = f"{o['steps']:.0f}" if o else ''; oo = f"{o['out']/1000:.0f}K" if o else ''
    ns = str(n['steps']) if n else ''; no = f"{n['out']/1000:.0f}K" if n else ''
    print(f"{s:<24}{ov:>14}{oc:>8}{os_:>7}{oo:>8} | {nv:>10}{nc:>8}{ns:>7}{no:>8}{dl:>7}  {dg}")
    if n and not n['ok']: print(f"    slice fail: {n['detail'][:150]}")
