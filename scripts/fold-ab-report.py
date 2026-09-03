#!/usr/bin/env python3
"""fold A/B 配对表:同一目录里每个场景的 transcript 与 transcript-fold 账本并排(最新一份)。
用法:python3 scripts/fold-ab-report.py <ledger-dir> [--md]"""
import json, sys, glob, os
P = dict(miss=0.22, hit=0.007, out=0.66)
d = sys.argv[1]; md = '--md' in sys.argv
rows = {}
for f in sorted(glob.glob(os.path.join(d, '*.json'))):
    l = json.load(open(f)); t = l['totals']
    c = (t['input'] * P['miss'] + t['cacheRead'] * P['hit'] + t['output'] * P['out']) / 1e6
    dg = l.get('digest') or {}
    rows[(l['scenario'], l['arm'])] = dict(ok=l['verdict']['ok'], cost=c, steps=t['steps'], miss=t['input'], hit=t['cacheRead'], out=t['output'], peak=t['peakInput'], folds=dg.get('count', 0), before=dg.get('charsBefore', 0), after=dg.get('charsAfter', 0), expand=l['toolHistogram'].get('expand_result', 0), detail=l['verdict']['detail'])
scen = sorted({k[0] for k in rows})
if md:
    print('| scenario | transcript | + fold | folds | expand | verdict |'); print('|---|---|---|---|---|---|')
for s in scen:
    a = rows.get((s, 'transcript')); b = rows.get((s, 'transcript-fold'))
    fa = lambda r, k: (r[k] if r else '—')
    if md:
        ca = f"{'✓' if a['ok'] else '✗'} {a['cost']:.3f} ({a['steps']} 步, 峰值 {a['peak']//1000}K)" if a else '—'
        cb = f"{'✓' if b['ok'] else '✗'} {b['cost']:.3f} ({b['steps']} 步, 峰值 {b['peak']//1000}K)" if b else '—'
        delta = f" **{(b['cost']-a['cost'])/a['cost']*100:+.0f}%**" if a and b else ''
        print(f"| {s} | {ca} | {cb}{delta} | {b['folds'] if b else '—'} ({(b['before'] if b else 0)//1000}K→{(b['after'] if b else 0)//1000}K) | {b['expand'] if b else '—'} | {(b['detail'] if b else '')[:60]} |")
    else:
        for arm, r in (('transcript', a), ('transcript-fold', b)):
            if r: print(f"{s[:22]:<23}{arm:<16} {'✓' if r['ok'] else '✗'} ${r['cost']:.4f} steps={r['steps']:>3} miss={r['miss']:>7} hit={r['hit']:>9} out={r['out']:>6} peak={r['peak']:>7} folds={r['folds']:>3} ({r['before']//1000}K→{r['after']//1000}K) expand={r['expand']} | {r['detail'][:70]}")
        if a and b: print(f"{'':<23}Δcost {(b['cost']-a['cost'])/a['cost']*100:+.0f}%  Δhit {(b['hit']-a['hit'])/max(a['hit'],1)*100:+.0f}%  Δout {(b['out']-a['out'])/max(a['out'],1)*100:+.0f}%")
