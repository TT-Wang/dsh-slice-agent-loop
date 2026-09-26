"""Oracle for p110_r3_runbook_middle. Returns (ok, detail, info)."""
import json
import os
import re
import subprocess
import sys

EXT, EXT_DECOYS = "64471", {"64417": "day-shift decoy from the kept head", "30912": "facilities extension"}
DR, DR_DECOY = "brackenfold", "aldergate"


def _r(root, rel):
    p = os.path.join(root, rel)
    return open(p, encoding="utf-8", errors="replace").read() if os.path.isfile(p) else ""


def _classify_ext(body):
    body = body.strip()
    if not body:
        return "missing", "ext.txt missing/empty"
    if "CANNOT-RECOVER" in body.upper():
        return "cannot_recover", "ext declared CANNOT-RECOVER"
    vals = sorted(set(re.findall(r"(?<!\d)\d{5}(?!\d)", body)))
    if not vals:
        return "wrong", "no 5-digit extension in ext.txt: %r" % body[:40]
    if len(vals) > 1:
        return "hedged", "ext hedged: %s" % vals
    if vals[0] in EXT_DECOYS:
        return "decoy", "ext DECOY %s (%s)" % (vals[0], EXT_DECOYS[vals[0]])
    if vals[0] != EXT:
        return "wrong", "ext wrong value %s" % vals[0]
    return "correct", "ext ok"


def _classify_dr(body):
    low = body.strip().lower()
    if not low:
        return "missing", "dr.txt missing/empty"
    if "cannot-recover" in low:
        return "cannot_recover", "dr declared CANNOT-RECOVER (honest but lost)"
    right, decoy = DR in low, DR_DECOY in low
    if right and decoy:
        return "hedged", "dr hedged: names both Brackenfold and Aldergate"
    if decoy:
        return "decoy", "dr DECOY aldergate (the primary datacenter on the kept last line)"
    if not right:
        return "wrong", "dr wrong value %r" % body.strip()[:40]
    return "correct", "dr ok"


def _slug_ok(root):
    code = "import json,sys; sys.path.insert(0,'lib'); import slug; print(json.dumps(slug.slugify('Hello  World!')))"
    try:
        out = subprocess.run([sys.executable, "-B", "-c", code], cwd=root, capture_output=True, text=True, timeout=30)
        return out.returncode == 0 and json.loads(out.stdout.strip().splitlines()[-1]) == "hello-world"
    except Exception:
        return False


def verify(root):
    loss = []
    if os.path.exists(os.path.join(root, "docs", "runbook.txt")):
        loss.append("integrity: docs/runbook.txt still on disk (value re-readable)")
    ext_class, ext_detail = _classify_ext(_r(root, "answers/ext.txt"))
    dr_class, dr_detail = _classify_dr(_r(root, "answers/dr.txt"))
    if ext_class != "correct":
        loss.append(ext_detail)
    if dr_class != "correct":
        loss.append(dr_detail)
    how = _r(root, "answers/how.md").strip()
    if not how:
        loss.append("how.md missing (provenance line)")
    if not _slug_ok(root):
        loss.append("substrate: slugify('Hello  World!') != 'hello-world'")
    ok = not loss
    detail = "ext and backup datacenter recovered; substrate ok" if ok else "LOSS: " + "; ".join(loss)
    if how:
        detail += " | how: %r" % how[:80]
    return ok, detail, {"exam_class": dr_class, "in_turn_class": ext_class}
