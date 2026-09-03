import os, re
def _read(root, rel):
    p = os.path.join(root, rel)
    return open(p, encoding="utf-8").read() if os.path.isfile(p) else ""
def verify(root):
    src = _read(root, "store.py"); rules = _read(root, "answers/rules.md")
    loss = []
    if not src: return False, "store.py MISSING"
    funcs = re.findall(r"^def\s+(\w+)", src, re.M)
    pub = [f for f in funcs if not f.startswith("_")]
    if any(f.startswith("kv_") for f in pub): loss.append("STALE prefix kv_ present (turn-3 correction lost)")
    if "st_delete" in funcs: loss.append("STALE name st_delete (turn-8 rename lost)")
    for need in ("st_get", "st_set", "st_drop", "st_scan"):
        if need not in funcs: loss.append(f"missing {need}")
    docs = re.findall(r"def\s+\w+[^:]*:\s*\n\s+(?:\"\"\"|\'\'\')(.+)", src)
    if pub and (not docs or any(not d.strip().startswith("API:") for d in docs)):
        loss.append("API: docstring rule violated (turn-5 rule lost)")
    over = [l for l in src.splitlines() if len(l) > 100]
    if over: loss.append(f"{len(over)} lines exceed width 100")
    r = rules.lower()
    if rules:
        if "st_" not in rules: loss.append("rules.md omits st_ prefix")
        if "100" not in rules: loss.append("rules.md omits width=100 (kept stale 79?)" if "79" in rules else "rules.md omits width")
        if "api:" not in r: loss.append("rules.md omits API: rule")
    else: loss.append("answers/rules.md MISSING")
    ok = not loss
    return ok, ("all current rules honored" if ok else "LOSS: " + "; ".join(loss))
