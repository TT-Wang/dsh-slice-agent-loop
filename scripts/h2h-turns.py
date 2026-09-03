#!/usr/bin/env python3
"""历史 h2h 会话的逐轮用量(与 turn-profile.py 同口径:每轮步数 / 去重读文件 / 测试次数 / out(reasoning))。
用法:python3 scripts/h2h-turns.py <session-id-prefix> [...]   (在 ~/.dsh/sessions 下按 session-<id> 匹配)"""
import json, sys, os, glob, re, subprocess, collections
P = dict(miss=0.22, hit=0.007, out=0.66)
for sid in sys.argv[1:]:
    paths = glob.glob(os.path.expanduser(f'~/.dsh/sessions/*-h2h-*/session-{sid}*/session.jsonl.zstd'))
    if not paths: print('no session', sid); continue
    text = subprocess.run(['zstd', '-dc', paths[0]], capture_output=True, text=True, timeout=120).stdout
    turn = 1; rows = collections.defaultdict(lambda: dict(steps=0, miss=0, hit=0, out=0, rsn=0, reads=set(), tests=0))
    for line in text.split('\n'):
        if not line: continue
        try: e = json.loads(line)
        except Exception: continue
        t = e.get('type'); dd = e.get('data') or {}
        if t == 'assistant/message' and dd.get('usage'):
            u = dd['usage']; r = rows[turn]; r['steps'] += 1
            r['miss'] += u.get('inputTokens', 0) or 0; r['hit'] += u.get('cacheReadTokens', 0) or 0
            r['out'] += u.get('outputTokens', 0) or 0; r['rsn'] += u.get('reasoningTokens', 0) or 0
        elif t == 'tool/call' or t == 'tool/exec' or (t and t.startswith('tool/') and 'arguments' in json.dumps(dd)[:400]):
            s = json.dumps(dd)
            m = re.search(r'\\"file_path\\": \\"([^"\\]+)', s) or re.search(r'"file_path": "([^"]+)"', s)
            if '"read"' in s[:300] and m: rows[turn]['reads'].add(m.group(1))
            if '"bash"' in s[:300] and re.search(r'pytest|python -m|unittest|npm test|python3? [\\w./-]+\.py', s): rows[turn]['tests'] += 1
        elif t == 'turn/end': turn += 1
    print(f"session {sid} ({os.path.basename(os.path.dirname(os.path.dirname(paths[0])))[:60]})")
    tot = dict(steps=0, miss=0, hit=0, out=0, rsn=0)
    for tn in sorted(rows):
        r = rows[tn]; c = (r['miss'] * P['miss'] + r['hit'] * P['hit'] + r['out'] * P['out']) / 1e6
        print(f"  t{tn:>2} steps={r['steps']:>3} rd={len(r['reads']):>2} tst={r['tests']:>2} miss={r['miss']:>6} hit={r['hit']:>8} out={r['out']/1000:>6.1f}K rsn={r['rsn']/1000:>5.1f}K ${c:.4f}")
        for k in tot: tot[k] += r[k]
    c = (tot['miss'] * P['miss'] + tot['hit'] * P['hit'] + tot['out'] * P['out']) / 1e6
    print(f"  TOTAL steps={tot['steps']} miss={tot['miss']} hit={tot['hit']} out={tot['out']} reasoning={tot['rsn']} ${c:.4f}")
