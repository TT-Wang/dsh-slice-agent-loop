"""Oracle for p110_r4_probe_compare. Returns (ok, detail, info)."""
import importlib.util
import json
import os
import re
import subprocess
import sys

_spec = importlib.util.spec_from_file_location("p110_r4_setup", os.path.join(os.path.dirname(os.path.abspath(__file__)), "setup.py"))
S = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(S)


def _r(root, rel):
    p = os.path.join(root, rel)
    return open(p, encoding="utf-8", errors="replace").read() if os.path.isfile(p) else ""


def _classify(body):
    ep, us, eu = S.expected()
    text = body.strip()
    if not text:
        return "missing", "compare.csv missing/empty"
    if "CANNOT-RECOVER" in text.upper():
        return "cannot_recover", "declared CANNOT-RECOVER (honest but lost)"
    lines = [l.strip().strip("`") for l in text.splitlines() if l.strip() and not l.strip().startswith("```")]
    if len(lines) != 1:
        return "hedged", "hedged: %d lines in compare.csv" % len(lines)
    parts = [p.strip() for p in lines[0].split(",")]
    if len(parts) != 3 or not re.fullmatch(r"\d+", parts[1] or "x") or not re.fullmatch(r"\d+", parts[2] or "x"):
        return "wrong", "malformed line %r" % lines[0][:60]
    got = (parts[0].lower(), int(parts[1]), int(parts[2]))
    if got == (ep, us, eu):
        return "correct", "compare line exact"
    if got == (ep, eu, us):
        return "wrong", "wrong value: swapped regions %r" % lines[0]
    if got[0] != ep:
        return "wrong", "wrong value: endpoint %s (expected the highest us p95)" % got[0]
    return "wrong", "wrong value: numbers %r" % lines[0]


def _pct_ok(root):
    code = "import json,sys; sys.path.insert(0,'lib'); import fmt; print(json.dumps([fmt.pct(1, 3), fmt.pct(1, 0)]))"
    try:
        out = subprocess.run([sys.executable, "-B", "-c", code], cwd=root, capture_output=True, text=True, timeout=30)
        return out.returncode == 0 and json.loads(out.stdout.strip().splitlines()[-1]) == ["33.3%", "n/a"]
    except Exception:
        return False


def verify(root):
    loss = []
    if os.path.exists(os.path.join(root, "tools", "probe.py")):
        loss.append("integrity: tools/probe.py still on disk (values recomputable)")
    klass, detail = _classify(_r(root, "answers/compare.csv"))
    if klass != "correct":
        loss.append(detail)
    how = _r(root, "answers/how.md").strip()
    if not how:
        loss.append("how.md missing (provenance line)")
    if not _pct_ok(root):
        loss.append("substrate: pct(1, 3) != '33.3%' or pct(1, 0) != 'n/a'")
    ok = not loss
    out = "compare line recovered from both probe runs; substrate ok" if ok else "LOSS: " + "; ".join(loss)
    if how:
        out += " | how: %r" % how[:80]
    return ok, out, {"exam_class": klass}
