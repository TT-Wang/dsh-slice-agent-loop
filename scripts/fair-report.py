#!/usr/bin/env python3
"""公平对照报告:同一天、同代码、同 runner、同条件下 transcript 与 slice 两臂的账本。

用法:python3 scripts/fair-report.py results/20260903-fair [--cb20 <transcript.json> <slice.json>]
每格:判卷、成本(flash 谷时价目)、步数、峰值 prompt、miss/hit/out(推理)、墙钟。
多次运行同一场景时取均值并标 n。
"""
import json, sys, glob, os, statistics
P = dict(miss=0.22, hit=0.007, out=0.66)
def cost(t): return (t['input'] * P['miss'] + t['cacheRead'] * P['hit'] + t['output'] * P['out']) / 1e6
root = sys.argv[1]
def load(arm):
    rows = {}
    for f in sorted(glob.glob(os.path.join(root, arm, '*.json'))):
        d = json.load(open(f)); t = d['totals']
        wall = sum(x.get('wallMs', 0) for x in d.get('turns', [])) / 1000
        rows.setdefault(d['scenario'], []).append(dict(ok=d['verdict']['ok'], detail=d['verdict']['detail'], cost=cost(t), steps=t['steps'], peak=t['peakInput'], miss=t['input'], hit=t['cacheRead'], out=t['output'], reasoning=t.get('reasoning', 0), wall=wall, env=d.get('env', {})))
    return rows
T, S = load('transcript'), load('slice')
def agg(rs):
    m = lambda k: statistics.mean(r[k] for r in rs)
    return dict(n=len(rs), ok=sum(1 for r in rs if r['ok']), cost=m('cost'), steps=m('steps'), peak=m('peak'), miss=m('miss'), hit=m('hit'), out=m('out'), reasoning=m('reasoning'), wall=m('wall'))
order = ['n1_verbatim_restore', 'n2_intent_ledger', 'n3_rot_checkpoints', 's1_longhorizon_debug', 's2_taskdag_scheduler', 's3_intervalset_algebra', 's4_multifile_refactor', 's5_standing_constraints', 's6_revert_by_reference', 's13_compact_amnesia', 's14b_recall_ladder', 's10_compactloss', 'l1_chain_migrate', 'l2_ledger_state']
print(f"{'scenario':<24}{'transcript':>12}{'$':>8}{'peak':>8}{'wall':>7} | {'slice':>10}{'$':>8}{'peak':>8}{'wall':>7} | {'Δ$':>6}{'Δpeak':>7}")
tot_t = tot_s = 0.0; okt = oks = 0; n_both = 0
for s in order:
    a = agg(T[s]) if s in T else None; b = agg(S[s]) if s in S else None
    if not a and not b: continue
    fa = f"{'✓' if a and a['ok'] == a['n'] else ('✗' if a else '—')}{(' n='+str(a['n'])) if a and a['n'] > 1 else ''}"
    fb = f"{'✓' if b and b['ok'] == b['n'] else ('✗' if b else '—')}{(' n='+str(b['n'])) if b and b['n'] > 1 else ''}"
    ca = f"{a['cost']:.4f}" if a else '—'; cb = f"{b['cost']:.4f}" if b else '—'
    pa = f"{a['peak']/1000:.0f}K" if a else ''; pb = f"{b['peak']/1000:.0f}K" if b else ''
    wa = f"{a['wall']/60:.1f}m" if a else ''; wb = f"{b['wall']/60:.1f}m" if b else ''
    dc = f"{(b['cost']-a['cost'])/a['cost']*100:+.0f}%" if a and b else ''
    dp = f"{b['peak']/a['peak']:.2f}×" if a and b else ''
    print(f"{s:<24}{fa:>12}{ca:>8}{pa:>8}{wa:>7} | {fb:>10}{cb:>8}{pb:>8}{wb:>7} | {dc:>6}{dp:>7}")
    if a and b: tot_t += a['cost']; tot_s += b['cost']; n_both += 1; okt += (a['ok'] == a['n']); oks += (b['ok'] == b['n'])
    for r in (T.get(s) or []):
        if not r['ok']: print(f"    transcript fail: {r['detail'][:150]}")
    for r in (S.get(s) or []):
        if not r['ok']: print(f"    slice fail: {r['detail'][:150]}")
print(f"\n{n_both} scenarios both arms: transcript pass {okt}/{n_both} ${tot_t:.3f} | slice pass {oks}/{n_both} ${tot_s:.3f} ({(tot_s-tot_t)/tot_t*100:+.0f}%)")
envs = {(r['env'].get('resolvedEffort'), r['env'].get('maxStepsPerTurn')) for rs in list(T.values()) + list(S.values()) for r in rs}
print('env (resolvedEffort, maxStepsPerTurn):', envs)
if '--cb20' in sys.argv:
    i = sys.argv.index('--cb20'); ct, cs = sys.argv[i + 1], sys.argv[i + 2]
    L = lambda p: {r['id']: r for r in json.load(open(p)) if 'error' not in r}
    A, B = L(ct), L(cs); paired = [k for k in A if k in B]
    c = lambda r: (r['input'] * P['miss'] + r['cacheRead'] * P['hit'] + r['output'] * P['out']) / 1e6
    f1 = lambda r: (2 * r['filePrecision'] * r['fileRecall'] / (r['filePrecision'] + r['fileRecall']) if r['filePrecision'] + r['fileRecall'] > 0 else 0)
    print(f"\nCB20 paired n={len(paired)} | completion transcript {len(A)}/20 slice {len(B)}/20")
    for name, X in (('transcript', A), ('slice', B)):
        rows = [X[k] for k in paired]
        print(f"  {name:<11} fileR={statistics.mean(r['fileRecall'] for r in rows):.3f} spanR={statistics.mean(r['spanRecall'] for r in rows):.3f} prec={statistics.mean(r['filePrecision'] for r in rows):.3f} F1={statistics.mean(f1(r) for r in rows):.3f} steps={statistics.mean(r['steps'] for r in rows):.0f} wall={statistics.mean(r['wallMs'] for r in rows)/1000:.0f}s $={sum(c(r) for r in rows):.4f}")
    w = sum(1 for k in paired if f1(B[k]) > f1(A[k]) + 1e-9); l = sum(1 for k in paired if f1(B[k]) < f1(A[k]) - 1e-9)
    print(f"  per-instance F1 slice wins/losses/ties: {w}/{l}/{len(paired)-w-l}; slice cheaper on {sum(1 for k in paired if c(B[k]) < c(A[k]))}/{len(paired)}")
