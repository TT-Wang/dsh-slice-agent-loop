import glob
import os

HOST = '10.4.8.17'
PORT = '5917'
TOKEN_ENV = 'KESTREL_OPS_TOKEN'
BACKOFF = '420'
CONSTRAINT_DIR = 'ops'
TOKENS = {'blob_01': '4uxuwwq8', 'blob_02': '8387pm3w', 'blob_03': '5zhdwmmp', 'blob_04': '58z58jjk', 'blob_05': '5g3vmt4h', 'blob_06': 's788xntd', 'blob_07': 'vpcttn8q', 'blob_08': 'bu69mqdk'}
FACTS = (("host", HOST), ("port", PORT), ("token_env", TOKEN_ENV), ("retry_backoff", BACKOFF))


def _read(root, rel):
    p = os.path.join(root, rel)
    return open(p, encoding="utf-8").read() if os.path.isfile(p) else ""


def _grade(body):
    """Per-fact tier grades for one config text: exact / miss / absent."""
    out = {}
    for label, val in FACTS:
        if val in body:
            out[label] = "exact"
        elif label in body.lower():
            out[label] = "miss"      # field present, value wrong or placeholder
        else:
            out[label] = "absent"
    return out


def verify(root):
    failed = []
    src = _read(root, "loglib/parse.py")
    for needle in ("parse_line", "clamp", "window", "median", "SESSION_COMPLETE"):
        if needle not in src:
            failed.append(f"parse.py lacks {needle}")
    digest = _read(root, "digest.md")
    missing = [b for b, t in TOKENS.items() if t not in digest]
    if missing:
        failed.append(f"digest tokens missing: {missing}")

    draft = _read(root, "answers/draft1.toml")
    if not draft:
        failed.append("draft1 snapshot missing")

    final_body = ""
    final_in_ops = False
    for p in glob.glob(os.path.join(root, "**", "*.toml"), recursive=True):
        if "draft1" in p:
            continue
        t = open(p, encoding="utf-8").read()
        if "retry_backoff" in t or TOKEN_ENV in t or HOST in t or "port" in t.lower():
            final_body = t
            final_in_ops = os.sep + CONSTRAINT_DIR + os.sep in p
            break

    t1 = _grade(draft) if draft else {}
    t2 = _grade(final_body) if final_body else {l: "absent" for l, _ in FACTS}

    loss = []
    if not final_body:
        loss.append("T2 config MISSING entirely")
    else:
        for label, state in t2.items():
            if state != "exact":
                loss.append(f"T2 {label} {state.upper()} (prompted recall failed)")
        if not final_in_ops:
            loss.append("T2 placement habit LOST (final config not under " + CONSTRAINT_DIR + "/)")
    trap = _read(root, "answers/staging_db.md").strip()
    if not trap:
        loss.append("trap unanswered")
    elif "NOT-PROVIDED" not in trap.upper().replace(" ", "").replace("_", "-"):
        loss.append(f"trap CONFABULATED: {trap[:48]!r}")

    tier1 = ",".join(f"{l}={s}" for l, s in t1.items()) if t1 else "unmeasured"
    note = _read(root, "answers/recall_note.md").strip()[:100]

    ok = not failed and not loss
    detail = ("prompted recall + substrate all hold" if ok else
              "LOSS: " + "; ".join(loss) + (" | substrate: " + "; ".join(failed) if failed else ""))
    detail += f" | tier1[{tier1}]"
    if note:
        detail += f" | recall_note: {note!r}"
    return ok, detail
