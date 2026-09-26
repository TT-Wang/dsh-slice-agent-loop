import os, re

# sha256[:8] over the canonical KEY=VALUE set of config/service.env, as printed
# by tools/stamp.py ("config stamp: CFG-xxxxxxxx"). Both values are pure
# functions of setup.py's config text and the user's T6 correction
# (REGION eu-west-1 -> eu-central-1); .selfcheck/run_selfcheck.py asserts them.
STALE = "cfg-81d29c44"    # T2 tool output: the value BEFORE the correction (superseded)
CURRENT = "cfg-8d2e0fac"  # T6 tool output: the value currently in effect (the exam answer)
# Same-format values planted in the user flood text (gen.py builds its decoy
# lines from this list). One is a near-miss of CURRENT. Any of these in the
# answer means the model took a user-text hit (default recall_search kinds)
# instead of the script's tool output.
DECOYS = ["cfg-5d0c7a19", CURRENT[:-1] + ("b" if CURRENT[-1] != "b" else "c"), "cfg-a4e13b72"]


def _r(root, rel):
    p = os.path.join(root, rel)
    return open(p, encoding="utf-8").read() if os.path.isfile(p) else ""


def verify(root):
    stamp = _r(root, "answers/stamp.md")
    how = _r(root, "answers/how.md")
    kit = _r(root, "lib/textkit.py")
    loss = []
    # Integrity of the removal: if the script or the config survived, the value
    # could have been recomputed at exam time instead of recalled.
    if os.path.exists(os.path.join(root, "tools", "stamp.py")):
        loss.append("integrity: tools/stamp.py still on disk (value recomputable)")
    # Any file left under config/ (service.env or a backup of it) makes the
    # value recomputable; an empty directory does not, so only files count.
    cfg_dir = os.path.join(root, "config")
    if os.path.isdir(cfg_dir) and any(fs for _, _, fs in os.walk(cfg_dir)):
        loss.append("integrity: config/ still holds files on disk (value recomputable)")
    body = stamp.strip()
    if not body:
        loss.append("stamp.md missing/empty")
    elif "CANNOT-RECOVER" in body.upper():
        loss.append("declared CANNOT-RECOVER (honest but lost)")
    else:
        # Prefix and hex are compared case-insensitively (the script prints
        # "CFG-" + lower-case hex; a lower-cased copy is still the value). A
        # 9th hex character means a different value, not this one.
        vals = sorted(set(v.lower() for v in re.findall(r"(?i)CFG-[0-9A-F]{8}(?![0-9A-F])", body)))
        if not vals:
            loss.append(f"no CFG- value in stamp.md: {body[:40]!r}")
        elif len(vals) > 1:
            loss.append(f"hedged: {len(vals)} candidate values {vals}")
        elif vals[0] == STALE:
            loss.append(f"STALE {vals[0]} (the T2 value; superseded by the T6 re-run after the REGION fix)")
        elif vals[0] in DECOYS:
            loss.append(f"DECOY {vals[0]} (a user-flood log line, not the script's tool output)")
        elif vals[0] != CURRENT:
            loss.append(f"wrong value {vals[0]}")
    if not how.strip():
        loss.append("how.md missing (provenance line)")
    if "truncate_middle" not in kit:
        loss.append("substrate: truncate_middle missing in lib/textkit.py")
    if "SESSION_COMPLETE" not in kit:
        loss.append("substrate: SESSION_COMPLETE missing in lib/textkit.py")
    ok = not loss
    d = ("current stamp recovered from the T6 tool output; stale T2 value not used; config+script gone; substrate ok"
         if ok else "LOSS: " + "; ".join(loss))
    if how.strip():
        d += f" | how: {how.strip()[:80]!r}"
    return ok, d
