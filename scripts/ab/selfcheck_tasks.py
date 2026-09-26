#!/usr/bin/env python3
"""Oracle self-check for every A/B task: verify() fails on the untouched workdir, passes on a correct
end state, and names the failure class of typical wrong answers. No model, no network.

    python3 scripts/ab/selfcheck_tasks.py [scratch-dir]

C1/C2 use reference_fix.py from ~/code/sliceagent/evals/h2h when it is present (skipped otherwise).
"""
import importlib.util, json, os, shutil, subprocess, sys, tempfile
W = os.path.dirname(os.path.abspath(__file__))
SCR = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="ab-selfcheck-")
RUN = os.path.join(W, "run_ab.py")
def call(task, fn, root, n=None):
    cmd = [sys.executable, RUN, "_task_call", os.path.join(W, "tasks", task), fn, root] + ([str(n)] if n else [])
    return json.loads(subprocess.run(cmd, capture_output=True, text=True, check=True).stdout.strip().splitlines()[-1])
def fresh(task, name):
    root = os.path.join(SCR, name)
    shutil.rmtree(root, ignore_errors=True)
    if os.path.exists(root + ".truth.json"): os.remove(root + ".truth.json")
    os.makedirs(root)
    call(task, "setup", root)
    return root
def w(root, rel, text):
    p = os.path.join(root, rel); os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "w").write(text)
def hooks(task, root, turns):
    for n in range(1, turns + 1): call(task, "after_turn", root, n)
results = []
def check(name, task, prep, want_ok, want_class=None):
    root = fresh(task, name); prep(root); v = call(task, "verify", root)
    cls = v["info"].get("exam_class")
    ok = v["ok"] == want_ok and (want_class is None or cls == want_class or (cls is None and want_class.upper() in v["detail"].upper()))
    results.append(ok); print(("OK  " if ok else "BAD ") + name, v["ok"], cls, v["detail"][:110])
# R1
def r1(ans):
    def f(root):
        hooks("p110_r1_fixture_fp", root, 6); w(root, "lib/ids.py", "def normalize_id(s):\n    return s\nSESSION_COMPLETE = True\n")
        w(root, "answers/fingerprint.md", ans); w(root, "answers/how.md", "looked it up with expand_result")
    return f
check("r1-untouched", "p110_r1_fixture_fp", lambda r: None, False)
check("r1-correct", "p110_r1_fixture_fp", r1("FX-8b69ed6e\n"), True)
check("r1-decoy", "p110_r1_fixture_fp", r1("FX-8b69ed7a\n"), False, "decoy")
check("r1-cannot", "p110_r1_fixture_fp", r1("CANNOT-RECOVER\n"), False, "cannot-recover")
# R2
def r2(ans):
    def f(root):
        hooks("p110_r2_superseded_stamp", root, 7); w(root, "lib/textkit.py", "def truncate_middle(s, n):\n    return s\nSESSION_COMPLETE = True\n")
        w(root, "answers/stamp.md", ans); w(root, "answers/how.md", "recall")
    return f
check("r2-untouched", "p110_r2_superseded_stamp", lambda r: None, False)
check("r2-correct", "p110_r2_superseded_stamp", r2("CFG-8d2e0fac\n"), True)
check("r2-stale", "p110_r2_superseded_stamp", r2("CFG-81d29c44\n"), False, "stale")
# R3
def r3(ext, dr):
    def f(root):
        hooks("p110_r3_runbook_middle", root, 3); w(root, "lib/slug.py", "import re\ndef slugify(s):\n    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')\n")
        w(root, "answers/ext.txt", ext); w(root, "answers/dr.txt", dr); w(root, "answers/how.md", "expand_result")
    return f
check("r3-untouched", "p110_r3_runbook_middle", lambda r: None, False)
check("r3-correct", "p110_r3_runbook_middle", r3("64471\n", "Brackenfold\n"), True, "correct")
check("r3-dr-decoy", "p110_r3_runbook_middle", r3("64471\n", "Aldergate\n"), False, "decoy")
check("r3-ext-decoy", "p110_r3_runbook_middle", r3("64417\n", "Brackenfold\n"), False, "correct")
# R4
def r4(line):
    def f(root):
        hooks("p110_r4_probe_compare", root, 4)
        w(root, "lib/fmt.py", "def pct(part, whole):\n    return 'n/a' if whole == 0 else '%.1f%%' % (part / whole * 100)\n")
        w(root, "answers/compare.csv", line); w(root, "answers/how.md", "expand_result on both runs")
    return f
check("r4-untouched", "p110_r4_probe_compare", lambda r: None, False)
check("r4-correct", "p110_r4_probe_compare", r4("shipping,690,291\n"), True, "correct")
check("r4-swapped", "p110_r4_probe_compare", r4("shipping,291,690\n"), False, "wrong")
# R5 (reference fix from f3's oracle)
def r5(failing):
    def f(root):
        spec = importlib.util.spec_from_file_location("r5s", os.path.join(W, "tasks", "p110_r5_initial_failures", "setup.py")); S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)
        for name, (idx, _) in S.BUGS.items():
            p = os.path.join(root, "textkit", name + ".py"); src = open(p).read(); head = "def %s_f%d(s, n=" % (name, idx)
            i = src.index(head); j = src.index("    out = ", i); k = src.index("\n", src.index("    return", j)) + 1
            open(p, "w").write(src[:j] + "    out = ''.join(chr((ord(c) + n) % 65536) for c in s)\n    return out + str(len(s))\n" + src[k:])
        w(root, "failing.txt", failing(json.load(open(root + ".truth.json"))["failing"]))
    return f
check("r5-untouched", "p110_r5_initial_failures", lambda r: None, False)
check("r5-correct", "p110_r5_initial_failures", r5(lambda f: "\n".join(f) + "\n"), True, "correct")
check("r5-partial", "p110_r5_initial_failures", r5(lambda f: "\n".join(f[:8]) + "\n"), False, "wrong")
# C1, C2: reference_fix.py from the source scenario directories
def ref(src):
    def f(root):
        spec = importlib.util.spec_from_file_location("ref", src); M = importlib.util.module_from_spec(spec); spec.loader.exec_module(M); M.apply(root)
    return f
H = os.path.expanduser("~/code/sliceagent/evals/h2h")
check("c1-untouched", "lh1_incremental_build", lambda r: None, False)
check("c2-untouched", "m3_consistency_bugfix", lambda r: None, False)
if os.path.isdir(H):
    check("c1-reference", "lh1_incremental_build", ref(H + "/lh1_incremental_build/reference_fix.py"), True)
    check("c2-reference", "m3_consistency_bugfix", ref(H + "/m3_consistency_bugfix/reference_fix.py"), True)
else:
    print("skip c1/c2 reference checks:", H, "not found")
check("hello", "hello", lambda r: None, True)
print("SELFCHECK", "PASSED" if all(results) else "FAILED", f"{sum(results)}/{len(results)}")
sys.exit(0 if all(results) else 1)
