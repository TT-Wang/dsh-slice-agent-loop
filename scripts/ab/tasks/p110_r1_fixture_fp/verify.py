import os, re

# sha256 over the fixture bundle written by setup.py, as printed by
# tools/check_fixtures.py in turn 1 ("bundle fingerprint: FX-8b69ed6e").
FP = "fx-8b69ed6e"
# Same-format values planted in the user flood text (see gen.py DECOY_LINES).
# One is a near-miss of FP. Any of these in the answer means the model took a
# user-text hit (default recall_search kinds) instead of the tool output.
DECOYS = ["fx-3c1a9f04", "fx-8b69ed7a", "fx-e2d40b91"]


def _r(root, rel):
    p = os.path.join(root, rel)
    return open(p, encoding="utf-8").read() if os.path.isfile(p) else ""


def verify(root):
    fp_file = _r(root, "answers/fingerprint.md")
    how = _r(root, "answers/how.md")
    ids = _r(root, "lib/ids.py")
    loss = []
    # Integrity of the removal: if the script or its inputs survived, the value
    # could have been recomputed at exam time instead of recalled.
    if os.path.exists(os.path.join(root, "tools", "check_fixtures.py")):
        loss.append("integrity: tools/check_fixtures.py still on disk (value recomputable)")
    if os.path.isdir(os.path.join(root, "fixtures")):
        loss.append("integrity: fixtures/ still on disk (value recomputable)")
    body = fp_file.strip()
    if not body:
        loss.append("fingerprint.md missing/empty")
    elif "CANNOT-RECOVER" in body.upper():
        loss.append("declared CANNOT-RECOVER (honest but lost)")
    else:
        # Case-insensitive on the prefix too: the script prints "FX-", but a
        # lower-cased restatement of the right value is still the right value.
        vals = sorted(set(v.lower() for v in re.findall(r"FX-[0-9A-Fa-f]{8}", body, re.IGNORECASE)))
        if not vals:
            loss.append(f"no FX- value in fingerprint.md: {body[:40]!r}")
        elif len(vals) > 1:
            loss.append(f"hedged: {len(vals)} candidate values {vals}")
        elif vals[0] in DECOYS:
            loss.append(f"DECOY {vals[0]} (a user-flood log line, not the script's tool output)")
        elif vals[0] != FP:
            loss.append(f"wrong value {vals[0]}")
    if not how.strip():
        loss.append("how.md missing (provenance line)")
    if "normalize_id" not in ids:
        loss.append("substrate: normalize_id missing in lib/ids.py")
    if "SESSION_COMPLETE" not in ids:
        loss.append("substrate: SESSION_COMPLETE missing in lib/ids.py")
    ok = not loss
    d = ("fingerprint recovered from tool output; script+fixtures gone; substrate ok"
         if ok else "LOSS: " + "; ".join(loss))
    if how.strip():
        d += f" | how: {how.strip()[:80]!r}"
    return ok, d
