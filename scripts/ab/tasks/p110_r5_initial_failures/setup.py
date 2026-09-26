"""R5 p110_r5_initial_failures: f3_test_suite_fix from dsh-tool-result-fold/bench, unchanged except that the
truth file is written beside the workdir (<workdir>.truth.json) instead of inside it."""
import os, random, json, hashlib
SEED = 20260904
MODULES = ['casing', 'padding', 'trimming', 'tokens', 'numbers', 'dates', 'slugs', 'wrap', 'align', 'escape', 'counts', 'compare', 'search', 'replace', 'split', 'join', 'dedupe', 'sort', 'filter', 'window', 'hashing', 'encode', 'decode', 'validate', 'format']
# each module: 8 functions with straightforward behaviour and 2 tests each => 400 tests
def stable(name):
    return sum((j + 1) * ord(c) for j, c in enumerate(name))

def shift(name, i):
    return (stable(name) * 7 + i * 3) % 9 + 1

def module_source(name, r):
    fns = []
    for i in range(8):
        k = shift(name, i)
        fns.append('''
def %s_f%d(s, n=%d):
    """%s helper %d: shift each char code by n and append the length."""
    out = ''.join(chr((ord(c) + n) %% 65536) for c in s)
    return out + str(len(s))
''' % (name, i, k, name, i))
    return '"""textkit.%s"""\n' % name + ''.join(fns)

def test_source(name, r):
    lines = ['from textkit.%s import *\n' % name]
    samples = ['abc', 'hello world', 'Zebra-42', 'x', 'mixed CASE 7']
    for i in range(8):
        k = shift(name, i)
        for j in range(2):
            s = samples[(stable(name) + i * 2 + j) % len(samples)]
            exp = ''.join(chr((ord(c) + k) % 65536) for c in s) + str(len(s))
            lines.append('def test_%s_f%d_%d():\n    assert %s_f%d(%r) == %r\n' % (name, i, j, name, i, s, exp))
    return '\n'.join(lines)

BUGS = {  # module: (function index, buggy replacement of the body)
    'tokens': (3, "    out = ''.join(chr((ord(c) + n + 1) % 65536) for c in s)\n    return out + str(len(s))\n"),
    'dates': (5, "    out = ''.join(chr((ord(c) + n) % 65536) for c in s)\n    return out + str(len(s) + 1)\n"),
    'slugs': (0, "    out = ''.join(chr((ord(c) - n) % 65536) for c in s)\n    return out + str(len(s))\n"),
    'hashing': (7, "    out = ''.join(chr((ord(c) + n) % 65536) for c in s[:-1])\n    return out + str(len(s))\n"),
    'validate': (2, "    out = ''.join(chr((ord(c) + n) % 65536) for c in s)\n    return str(len(s)) + out\n"),
}

def setup(root):
    r = random.Random(SEED)
    os.makedirs(os.path.join(root, 'textkit'), exist_ok=True)
    os.makedirs(os.path.join(root, 'tests'), exist_ok=True)
    open(os.path.join(root, 'textkit', '__init__.py'), 'w').write('"""textkit — small text helpers"""\n')
    failing = []
    for name in MODULES:
        rm = random.Random(SEED + stable(name))
        src = module_source(name, rm)
        rt = random.Random(SEED + stable(name))
        tsrc = test_source(name, rt)
        if name in BUGS:
            idx, body = BUGS[name]
            head = 'def %s_f%d(s, n=' % (name, idx)
            i = src.index(head)
            j = src.index('    out = ', i)
            k = src.index('\n', src.index('    return out', j)) + 1
            src = src[:j] + body + src[k:]
            failing += ['test_%s_f%d_%d' % (name, idx, jj) for jj in range(2)]
        open(os.path.join(root, 'textkit', name + '.py'), 'w').write(src)
        open(os.path.join(root, 'tests', 'test_%s.py' % name), 'w').write(tsrc)
    open(os.path.join(root, 'pytest.ini'), 'w').write('[pytest]\ntestpaths = tests\n')
    open(os.path.join(root, 'README.md'), 'w').write('# textkit\n\nRun the suite with `python3 -m pytest -v`.\n')
    # P1-10: the oracle lives beside the workdir, never inside it (the original wrote <root>/.truth/f3.json).
    digest = {f: hashlib.sha256(open(os.path.join(root, 'tests', f), 'rb').read()).hexdigest() for f in os.listdir(os.path.join(root, 'tests'))}
    json.dump({'failing': sorted(failing), 'test_hashes': digest}, open(truth_path(root), 'w'), indent=1)


def truth_path(root):
    return os.path.normpath(root) + '.truth.json'
