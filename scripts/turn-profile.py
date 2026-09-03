#!/usr/bin/env python3
"""逐轮画像:一份 run-scenario 账本(+ 同名 .trace.jsonl)每轮的步数 / 去重读文件数 / 测试运行次数 /
输出与推理 token。用于解释多轮任务的成本差(重读、重跑测试、重新推导)。

用法:python3 scripts/turn-profile.py <ledger.json> [<ledger.json> ...]
多份账本按列并排(同场景不同臂/配置)。transcript 的历史会话请用 h2h-sessions.py 的逐轮版本。"""
import json, sys, re, collections
def profile(path):
    l = json.load(open(path)); tr = [json.loads(x) for x in open(path.replace('.json', '.trace.jsonl'))]
    steps = collections.Counter(); reads = collections.defaultdict(set); tests = collections.Counter(); tools = collections.Counter()
    for t in tr:
        steps[t['turn']] += 1
        for c in t['calls']:
            name = c.split('(')[0]; tools[name] += 1
            m = re.search(r'"file_path": "([^"]+)"', c)
            if name == 'read' and m: reads[t['turn']].add(m.group(1))
            if name == 'bash' and re.search(r'pytest|python -m|unittest|npm test|python3? [\w./-]+\.py', c): tests[t['turn']] += 1
    usage = {x['turn']: (x['output'], x.get('reasoning', 0)) for x in l['turns']}
    P = dict(miss=0.22, hit=0.007, out=0.66); t = l['totals']
    cost = (t['input'] * P['miss'] + t['cacheRead'] * P['hit'] + t['output'] * P['out']) / 1e6
    return dict(label=f"{l['arm']}{'' if l.get('readBases') in (None, True) else '/no-read-bases'}", ok=l['verdict']['ok'], cost=cost, steps=steps, reads=reads, tests=tests, usage=usage, tools=tools, totals=t)
runs = [profile(p) for p in sys.argv[1:]]
turns = sorted(set().union(*[set(r['steps']) for r in runs]))
print('turn  ' + ' ‖ '.join(f"{r['label'][:22]:<22} steps rd tst   out/reason" for r in runs))
for tn in turns:
    cells = []
    for r in runs:
        o, re_ = r['usage'].get(tn, (0, 0))
        cells.append(f"{'':<22} {r['steps'][tn]:>5} {len(r['reads'][tn]):>2} {r['tests'][tn]:>3} {o/1000:>6.1f}K/{(re_ or 0)/1000:>4.1f}K")
    print(f"t{tn:>2}   " + ' ‖ '.join(cells))
print('\nTOTAL')
for r in runs:
    t = r['totals']
    print(f"  {r['label']:<24} {'✓' if r['ok'] else '✗'} ${r['cost']:.4f} steps={t['steps']} reads={sum(len(v) for v in r['reads'].values())} tests={sum(r['tests'].values())} miss={t['input']} hit={t['cacheRead']} out={t['output']} reasoning={t.get('reasoning')} peak={t['peakInput']} tools={dict(r['tools'])}")
