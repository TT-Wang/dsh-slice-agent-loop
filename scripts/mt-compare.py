#!/usr/bin/env python3
"""多轮 s/n 系列:历史 default(transcript)账本 vs 新 slice+折叠账本,同一价目表重定价后对照。

用法:python3 scripts/mt-compare.py <new-ledger-dir> [--old-git <repo> <path>...] [--old-file <path>...]
历史账本两种来源:iCloud 上 dsh-slice 仓库的 git 对象(git show HEAD:<path>)或本地文件。
两种 schema:旧 {scenario, totals:{input,output,cacheRead}, verdict:[ok, detail]};
新 {scenario, arm, totals:{input,cacheRead,output,reasoning,steps}, verdict:{ok,detail}, digest, tools}。
"""
import json, subprocess, sys, glob, os, re
P = dict(miss=0.22, hit=0.007, out=0.66)
def cost(t): return (t['input'] * P['miss'] + t['cacheRead'] * P['hit'] + t['output'] * P['out']) / 1e6
def load_old(src):
    if src.startswith('git:'):
        _, repo, path = src.split(':', 2)
        raw = subprocess.run(['git', '-C', repo, 'show', f'HEAD:{path}'], capture_output=True, text=True).stdout
    else:
        raw = open(src, encoding='utf-8').read()
    d = json.loads(raw)
    v = d.get('verdict'); ok = v[0] if isinstance(v, list) else (v.get('ok') if isinstance(v, dict) else bool(v))
    scen = d.get('scenario') or re.sub(r'.*-(s\d+[a-z]?_[a-z_]+|n\d_[a-z_]+)-.*', r'\1', os.path.basename(src))
    t = d['totals']; steps = sum(x.get('steps', 0) for x in d.get('turns', [])) or None
    return dict(scenario=scen, ok=ok, input=t['input'], cacheRead=t['cacheRead'], output=t['output'], steps=steps, cost=cost(t), src=src)
args = sys.argv[1:]
new_dir = args[0]; olds = []
i = 1
while i < len(args):
    if args[i] == '--old-git': repo = args[i + 1]; i += 2
    elif args[i] == '--old-file': olds.append(args[i + 1]); i += 2
    else: olds.append(f'git:{repo}:{args[i]}'); i += 1
old = {}
for src in olds:
    try: r = load_old(src); old[r['scenario']] = r
    except Exception as e: print(f'  (skip {src}: {str(e)[:60]})', file=sys.stderr)
new = {}
for f in sorted(glob.glob(os.path.join(new_dir, '*.json'))):
    d = json.load(open(f)); t = d['totals']
    new[d['scenario']] = dict(ok=d['verdict']['ok'], detail=d['verdict']['detail'], input=t['input'], cacheRead=t['cacheRead'], output=t['output'], reasoning=t.get('reasoning'), steps=t.get('steps'), cost=cost(t), digest=d.get('digest'), tools=d.get('tools'))
scens = sorted(set(old) | set(new), key=lambda s: (s[0], int(re.sub(r'\D', '', s.split('_')[0]) or 0), s))
print(f"{'scenario':<26}{'default(历史)':>16}{'$':>8}{'slice+fold':>14}{'$':>8}{'Δ$':>8}   fold")
for s in scens:
    o = old.get(s); n = new.get(s)
    ov = ('✓' if o['ok'] else '✗') if o else '—'; nv = ('✓' if n['ok'] else '✗') if n else '—'
    oc = f"{o['cost']:.4f}" if o else '—'; nc = f"{n['cost']:.4f}" if n else '—'
    dl = f"{(n['cost'] - o['cost']) / o['cost'] * 100:+.0f}%" if o and n else '—'
    dg = f"{n['digest']['count']}×({n['digest']['charsBefore']//1000}K→{n['digest']['charsAfter']//1000}K)" if n and n.get('digest') else ('0' if n else '')
    print(f"{s:<26}{ov:>16}{oc:>8}{nv:>14}{nc:>8}{dl:>8}   {dg}")
    if n and not n['ok']: print(f"    slice fail: {n['detail'][:140]}")
