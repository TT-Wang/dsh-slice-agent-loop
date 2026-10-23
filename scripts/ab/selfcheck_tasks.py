#!/usr/bin/env python3
"""Oracle self-check for every A/B task: verify() fails on the untouched workdir, passes on a correct
end state, and names the failure class of typical wrong answers. No model, no network.

    python3 scripts/ab/selfcheck_tasks.py [scratch-dir] [--keep]

C1/C2 use reference_fix.py from ~/code/sliceagent/evals/h2h when it is present (skipped otherwise).
Every workdir holds task sources and correct answers, i.e. oracle copies a model could find on disk, so
they are removed when the check ends (and a temporary scratch dir with them) unless --keep is given.
"""
import atexit, importlib.util, json, os, shutil, subprocess, sys, tempfile
W = os.path.dirname(os.path.abspath(__file__))
ARGS = [a for a in sys.argv[1:] if a != "--keep"]
KEEP = "--keep" in sys.argv[1:]
SCR = ARGS[0] if ARGS else tempfile.mkdtemp(prefix="ab-selfcheck-")
CREATED = []
def cleanup():
    if KEEP:
        return
    for root in CREATED:
        shutil.rmtree(root, ignore_errors=True)
        if os.path.exists(root + ".truth.json"): os.remove(root + ".truth.json")
    if not ARGS:
        shutil.rmtree(SCR, ignore_errors=True)
atexit.register(cleanup)
RUN = os.path.join(W, "run_ab.py")
def call(task, fn, root, n=None):
    cmd = [sys.executable, RUN, "_task_call", os.path.join(W, "tasks", task), fn, root] + ([str(n)] if n else [])
    return json.loads(subprocess.run(cmd, capture_output=True, text=True, check=True).stdout.strip().splitlines()[-1])
def fresh(task, name):
    root = os.path.join(SCR, name)
    shutil.rmtree(root, ignore_errors=True)
    if os.path.exists(root + ".truth.json"): os.remove(root + ".truth.json")
    os.makedirs(root)
    CREATED.append(root)
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
check("r4-header", "p110_r4_probe_compare", r4("endpoint,us_p95_ms,eu_p95_ms\nshipping,690,291\n"), True, "correct")
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
# Filler targets (2026-10-22): the files the r3 T2 and r4 T3 prompts ask to extend exist after setup, keep their
# existing helper, and the untouched module does not yet satisfy verify's substrate check
def filler(name, task, rel, helper):
    root = fresh(task, name); p = os.path.join(root, rel)
    src = open(p).read() if os.path.isfile(p) else ""
    ok = helper in src and call(task, "verify", root)["ok"] is False
    results.append(ok); print(("OK  " if ok else "BAD ") + name, rel, "exists" if src else "MISSING")
filler("r3-filler-target", "p110_r3_runbook_middle", "lib/slug.py", "def collapse_spaces(")
filler("r4-filler-target", "p110_r4_probe_compare", "lib/fmt.py", "def plural(")
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
# F1 (slice-vs-stock): oracle values come from the truth sidecar setup writes beside the workdir
def f1(build=None, lint=None, toml_dir="ops", toml=None, trap="NOT-PROVIDED\n", digest=True, fix=True):
    def f(root):
        t = json.load(open(root + ".truth.json"))
        hooks("svs_f1_flood_recall", root, 45)
        w(root, "core.py", "VERSION = '1.0'\nBUILD_CHECKED = True\ndef checksum(t): pass\ndef clamp(v, lo, hi): pass\n"
                           "def window(s, n): pass\ndef median(xs): pass\nSESSION_COMPLETE = True\n")
        if fix:
            w(root, "frames.py", "FRAMES = [1, 2, 3, 4, 5, 6, 7]\n")
        if digest:
            w(root, "digest.md", "".join(f"{b}: {tok}\n" for b, tok in sorted(t["tokens"].items())))
        w(root, "answers/build_id.md", (build(t) if build else t["build_id"]) + "\n")
        w(root, "answers/lint_error.md", (lint(t) if lint else t["lint_error"]) + "\n")
        d = t["deploy"]
        w(root, toml_dir + "/deploy.toml", toml or f'host = "{d["host"]}"\nport = {d["port"]}\ntoken_env = "{d["token_env"]}"\nretry_backoff_ms = {d["retry_backoff_ms"]}\n')
        w(root, "answers/staging_db.md", trap)
        w(root, "answers/recall_note.md", "remembered")
    return f
check("f1-untouched", "svs_f1_flood_recall", lambda r: None, False)
check("f1-correct", "svs_f1_flood_recall", f1(), True, "correct")
check("f1-build-decoy", "svs_f1_flood_recall", f1(build=lambda t: t["decoy_build_ids"][0]), False, "decoy")
check("f1-build-cannot", "svs_f1_flood_recall", f1(build=lambda t: "CANNOT-RECOVER"), False, "cannot_recover")
check("f1-lint-decoy", "svs_f1_flood_recall", f1(lint=lambda t: t["decoy_lint_errors"][0]), False, "decoy")
check("f1-lint-paraphrase", "svs_f1_flood_recall", f1(lint=lambda t: t["lint_error"].replace("never sealed", "not sealed")), False, "wrong")
check("f1-deploy-misplaced", "svs_f1_flood_recall", f1(toml_dir="."), False, "correct")
check("f1-deploy-wrong-port", "svs_f1_flood_recall", f1(toml='host = "10.7.4.23"\nport = 6131\ntoken_env = "ORCHID_DEPLOY_KEY"\nretry_backoff_ms = 350\n'), False, "correct")
check("f1-trap-confabulated", "svs_f1_flood_recall", f1(trap="orchid_staging\n"), False, "correct")
check("f1-digest-missing", "svs_f1_flood_recall", f1(digest=False), False, "correct")
check("f1-lint-unfixed", "svs_f1_flood_recall", f1(fix=False), False, "correct")
def f1_items(name, prep, want):
    root = fresh("svs_f1_flood_recall", name); prep(root); v = call("svs_f1_flood_recall", "verify", root)
    ok = v["info"]["memory_classes"] == want
    results.append(ok); print(("OK  " if ok else "BAD ") + name, v["info"]["memory_classes"])
f1_items("f1-items-misplaced", f1(toml_dir="."), {"build_id": "correct", "lint_error": "correct", "deploy": "misplaced", "trap": "correct"})
f1_items("f1-items-trap", f1(trap="orchid_staging\n"), {"build_id": "correct", "lint_error": "correct", "deploy": "correct", "trap": "confabulated"})
f1_items("f1-items-port", f1(toml='host = "10.7.4.23"\nport = 6131\ntoken_env = "ORCHID_DEPLOY_KEY"\nretry_backoff_ms = 350\n'),
         {"build_id": "correct", "lint_error": "correct", "deploy": "wrong", "trap": "correct"})
def f1_seeded():
    # AB_TASK_SEED changes every oracle value; the same seed reproduces them (both arms of a pair see the same content)
    import importlib.util as iu
    spec = iu.spec_from_file_location("f1s", os.path.join(W, "tasks", "svs_f1_flood_recall", "setup.py")); S = iu.module_from_spec(spec); spec.loader.exec_module(S)
    a, ta = S.build("seed-a"); a2, ta2 = S.build("seed-a"); b, tb = S.build("seed-b")
    logs = "".join(v for k, v in a.items() if k.startswith("data/"))
    ok = (a == a2 and ta == ta2 and ta["build_id"] != tb["build_id"] and ta["tokens"] != tb["tokens"] and ta["build_id"] not in logs
          and ta["lint_error"] not in logs and all(d in logs for d in ta["decoy_build_ids"]) and len(ta["tokens"]) == 32)
    results.append(ok); print(("OK  " if ok else "BAD ") + "f1-seeded", "deterministic per seed, oracle absent from the logs, decoys present")
f1_seeded()
check("hello", "hello", lambda r: None, True)
print("SELFCHECK", "PASSED" if all(results) else "FAILED", f"{sum(results)}/{len(results)}")
sys.exit(0 if all(results) else 1)
