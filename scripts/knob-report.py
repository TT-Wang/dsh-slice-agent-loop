#!/usr/bin/env python3
"""磁带旋钮对照一行表:每份账本(+ results/sidecars 里同 session 的 .calls.jsonl)→
判卷 · $ · 步/读/测 · miss 拆成 封存(每轮第 1 步)/轮内 · hit · out(reasoning) · 种子峰值字符。
用法:python3 scripts/knob-report.py <ledger.json> [...]  (label 同 turn-profile.py)"""
import json, sys, re, os, glob, collections
P = dict(miss=0.22, hit=0.007, out=0.66)
def label(l):
    to = l.get('tapeOpts') or {}
    return l['arm'] + ('/rb' if l.get('readBases') else '') + ('/rp' if l.get('readPointer') else '') + ('/base' if l.get('anchor') == 'base' else '') \
        + (f"/rebase-{to['rebaseAfterPatches']}" if 'rebaseAfterPatches' in to else '') + (f"/reply-{to['replyHeadChars']}+{to.get('replyTailChars', '')}" if 'replyHeadChars' in to else '') \
        + ('/check' if to.get('checkInDigest') else '') + ('/collapse' if to.get('collapseEdits') else '') + (f"/rbmin-{to['readBasesMinReads']}" if 'readBasesMinReads' in to else '') + ('/gc' if to.get('gcSupersededBases') else '') + (f"/newmin-{to['newFileMinTouches']}" if 'newFileMinTouches' in to else '')
print(f"{'scenario':<10}{'config':<44}{'ok':<3}{'$':>7}{'steps':>6}{'rd':>4}{'tst':>4}{'sealmiss':>9}{'turnmiss':>9}{'hit':>9}{'out':>7}{'reason':>7}{'seedmax':>8}")
for path in sys.argv[1:]:
    l = json.load(open(path)); t = l['totals']
    tr = [json.loads(x) for x in open(path.replace('.json', '.trace.jsonl'))]
    reads = set(); tests = 0
    for x in tr:
        for c in x['calls']:
            m = re.search(r'"file_path": "([^"]+)"', c)
            if c.startswith('read') and m: reads.add((x['turn'], m.group(1)))
            if c.startswith('bash') and re.search(r'pytest|python -m|unittest|npm test|python3? [\w./-]+\.py', c): tests += 1
    side = glob.glob(os.path.join('results/sidecars', f"{l['sessionId']}.calls.jsonl"))
    seal = turn = seedmax = 0
    if side:
        for line in open(side[0]):
            r = json.loads(line)
            if r['kind'] == 'call': (seal if False else None); 
            if r['kind'] == 'call':
                if r['step'] == 1: seal += r['norm']['input']
                else: turn += r['norm']['input']
            elif r['kind'] == 'seed': seedmax = max(seedmax, len(r['user']) + len(r['system']))
    cost = (t['input'] * P['miss'] + t['cacheRead'] * P['hit'] + t['output'] * P['out']) / 1e6
    print(f"{l['scenario'][:9]:<10}{label(l)[:43]:<44}{'✓' if l['verdict']['ok'] else '✗':<3}{cost:>7.4f}{t['steps']:>6}{len(reads):>4}{tests:>4}{seal:>9}{turn:>9}{t['cacheRead']:>9}{t['output']/1000:>6.0f}K{(t.get('reasoning') or 0)/1000:>6.0f}K{seedmax/1000:>7.0f}K")
