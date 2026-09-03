#!/usr/bin/env python3
"""开轮推理里"解读磁带"的占比:对每份 .full.jsonl,取每轮第 1 步的推理文本,按段落统计提到
tape/[base]/sha256/OPEN FILES/patch/digest 的段落字符占比。用法:python3 scripts/turnstart-share.py <ledger.json|.full.jsonl> ..."""
import json, sys, re, glob
pat = re.compile(r'tape|\[base|base file|base version|base entry|base snapshot|sha256|OPEN FILES|patch|current in tape|snapshot|digest|sealed', re.I)
for arg in sys.argv[1:]:
    f = arg if arg.endswith('.full.jsonl') else arg.replace('.json', '.full.jsonl')
    rows = [json.loads(l) for l in open(f)]
    tot = tape = 0; per = []
    for r in rows:
        if r['step'] != 1 or not r.get('reasoning'): continue
        paras = [p for p in re.split(r'\n\s*\n', r['reasoning']) if p.strip()]
        t = sum(len(p) for p in paras); tp = sum(len(p) for p in paras if pat.search(p))
        tot += t; tape += tp; per.append(f"t{r['turn']}:{tp * 100 // max(t, 1)}%")
    print(f"{f.split('/')[-2]}/{f.split('/')[-1][:34]}: step1 reasoning {tot // 1000}K chars, tape-talk {tape * 100 // max(tot, 1)}%  [{' '.join(per)}]")
