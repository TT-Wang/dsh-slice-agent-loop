#!/usr/bin/env python3
"""从 ~/.dsh/sessions 里历史 h2h 会话日志(session.jsonl.zstd)重算每次运行的用量与成本。
用法:python3 scripts/h2h-sessions.py [--arm default|slice] [--scenario s1_longhorizon_debug ...]
输出:场景 · 臂 · 日期 · 模型 · 轮数 · 步数 · miss/hit/out/reasoning · 重定价成本($0.22/0.007/0.66 per M)。"""
import os, sys, json, glob, subprocess, re, datetime, collections
P = dict(miss=0.22, hit=0.007, out=0.66)
args = sys.argv[1:]
arm = args[args.index('--arm') + 1] if '--arm' in args else None
scen_filter = [a for a in args if re.match(r'^[sn]\d', a)]
root = os.path.expanduser('~/.dsh/sessions')
rows = []
for d in sorted(glob.glob(os.path.join(root, '*-h2h-*'))):
    m = re.search(r'-h2h-([a-z0-9_]+?)-(default|slice)-([A-Za-z0-9]+)--$', d)
    if not m: continue
    scen, a, tag = m.groups()
    if arm and a != arm: continue
    if scen_filter and scen not in scen_filter: continue
    for sd in sorted(glob.glob(os.path.join(d, 'session-*'))):
        lp = os.path.join(sd, 'session.jsonl.zstd')
        if not os.path.exists(lp): continue
        try: text = subprocess.run(['zstd', '-dc', lp], capture_output=True, text=True, timeout=120).stdout
        except Exception: continue
        miss = hit = out = reas = steps = turns = 0; model = None; t0 = None; ok = None
        for line in text.split('\n'):
            if not line: continue
            try: e = json.loads(line)
            except Exception: continue
            t = e.get('type'); dd = e.get('data') or {}
            if t0 is None and e.get('time'): t0 = e['time']
            if t == 'assistant/message' and dd.get('usage'):
                u = dd['usage']; miss += u.get('inputTokens', 0) or 0; hit += u.get('cacheReadTokens', 0) or 0
                out += u.get('outputTokens', 0) or 0; reas += u.get('reasoningTokens', 0) or 0; steps += 1
                model = model or (dd.get('message') or {}).get('source', {}).get('model')
            elif t == 'turn/end': turns += 1
            elif t == 'request/header' and not model:
                model = (dd.get('header') or dd).get('model') if isinstance(dd, dict) else None
        if steps == 0: continue
        cost = (miss * P['miss'] + hit * P['hit'] + out * P['out']) / 1e6
        date = datetime.datetime.fromtimestamp(t0 / 1000).strftime('%m-%d %H:%M') if t0 else '?'
        rows.append((scen, a, date, str(model), turns, steps, miss, hit, out, reas, cost, os.path.basename(sd)[8:16]))
rows.sort(key=lambda r: (r[0], r[1], r[2]))
if '--json' in args:
    keys=['scenario','arm','date','model','turns','steps','miss','hit','out','reasoning','cost','session']
    print(json.dumps([dict(zip(keys, r)) for r in rows], ensure_ascii=False)); sys.exit(0)
print(f"{'scenario':<24}{'arm':<8}{'date':<13}{'model':<20}{'turns':>6}{'steps':>6}{'miss':>9}{'hit':>10}{'out':>8}{'reason':>8}{'$cost':>8}  session")
for r in rows: print(f"{r[0]:<24}{r[1]:<8}{r[2]:<13}{r[3][:19]:<20}{r[4]:>6}{r[5]:>6}{r[6]:>9}{r[7]:>10}{r[8]:>8}{r[9]:>8}{r[10]:>8.4f}  {r[11]}")
