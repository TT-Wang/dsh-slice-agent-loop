import os
def _r(root, rel):
    p = os.path.join(root, rel)
    return open(p, encoding='utf-8').read() if os.path.isfile(p) else ''
def verify(root):
    fails = []
    if 'PROBE-OK-7f3a-5050' not in _r(root, 'answers/probe.md'): fails.append('bash: probe output missing (bash tool did not execute)')
    if 'file3.txt' not in _r(root, 'answers/grep.md'): fails.append('grep: wrong/missing file name')
    if '3' not in _r(root, 'answers/glob.md'): fails.append('glob: wrong/missing count')
    if _r(root, 'a.cfg').split('\n')[0] != 'alpha=2' or _r(root, 'b.cfg').split('\n')[0] != 'alpha=1': fails.append('edit: a.cfg not edited or b.cfg touched')
    if '21' not in _r(root, 'answers/lines.md'): fails.append('read: wrong/missing line count')
    return (len(fails) == 0, 'env probe ok' if not fails else 'FAILS: ' + '; '.join(fails))
