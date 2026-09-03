import os
def setup(root):
    os.makedirs(os.path.join(root, 'data'), exist_ok=True)
    os.makedirs(os.path.join(root, 'answers'), exist_ok=True)
    with open(os.path.join(root, 'tools_probe.py'), 'w') as f:
        f.write("import sys\nprint('PROBE-OK-7f3a-' + str(sum(range(101))))\n")
    for i in range(5):
        with open(os.path.join(root, 'data', f'file{i}.txt'), 'w') as f:
            f.write(('lorem ipsum\n' * 20) + ('needle-xq91 lives here\n' if i == 3 else 'nothing\n'))
    for n in ('a.cfg', 'b.cfg', 'c.cfg'):
        with open(os.path.join(root, n), 'w') as f:
            f.write('alpha=1\nbeta=2\n')
