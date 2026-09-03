import os, re
RECORDS = [
 {'ref': 'TX-D8QQ', 'type': 'receipt', 'amount': 716, 'memo': 'Quintero', 'control': None},
 {'ref': 'TX-T8CD', 'type': 'adjustment', 'amount': -38, 'memo': None, 'control': None},
 {'ref': 'TX-P393', 'type': 'adjustment', 'amount': 39, 'memo': 'Kowalczyk', 'control': None},
 {'ref': 'TX-RK9X', 'type': 'payment', 'amount': 174, 'memo': 'Mbeki', 'control': None},
 {'ref': 'TX-RPWY', 'type': 'receipt', 'amount': 647, 'memo': None, 'control': None},
 {'ref': 'TX-TWNF', 'type': 'adjustment', 'amount': -43, 'memo': 'Umarov', 'control': None},
 {'ref': 'TX-7WUX', 'type': 'adjustment', 'amount': 15, 'memo': 'Bergstrom', 'control': None},
 {'ref': 'TX-NHUE', 'type': 'payment', 'amount': 187, 'memo': 'Guerrero', 'control': None},
 {'ref': 'TX-DDT2', 'type': 'payment', 'amount': 495, 'memo': None, 'control': None},
 {'ref': 'TX-JSG5', 'type': 'payment', 'amount': 347, 'memo': 'Takahashi', 'control': None},
 {'ref': 'TX-7795', 'type': 'payment', 'amount': 538, 'memo': 'Marchetti', 'control': None},
 {'ref': 'TX-FJDJ', 'type': 'payment', 'amount': 220, 'memo': 'Larsson', 'control': None},
 {'ref': 'TX-63NP', 'type': 'payment', 'amount': 623, 'memo': 'Halvorsen', 'control': None},
 {'ref': 'TX-C4H6', 'type': 'payment', 'amount': 588, 'memo': None, 'control': 'HOLD'},
 {'ref': 'TX-HQKS', 'type': 'receipt', 'amount': 308, 'memo': 'Oyelaran', 'control': None},
 {'ref': 'TX-3NVS', 'type': 'payment', 'amount': 402, 'memo': None, 'control': None},
 {'ref': 'TX-Y2K5', 'type': 'receipt', 'amount': 435, 'memo': 'Delacroix', 'control': None},
 {'ref': 'TX-CHD7', 'type': 'receipt', 'amount': 597, 'memo': 'Rasmussen', 'control': None},
 {'ref': 'TX-WYCA', 'type': 'payment', 'amount': 132, 'memo': 'Kaminski', 'control': 'RELEASE'},
 {'ref': 'TX-KX8P', 'type': 'payment', 'amount': 339, 'memo': 'Nakamura', 'control': None},
 {'ref': 'TX-44E9', 'type': 'receipt', 'amount': 735, 'memo': 'Jankowski', 'control': None},
 {'ref': 'TX-R23P', 'type': 'payment', 'amount': 536, 'memo': 'Achterberg', 'control': None},
 {'ref': 'TX-PUJG', 'type': 'adjustment', 'amount': 16, 'memo': 'Villanueva', 'control': None},
 {'ref': 'TX-G5F7', 'type': 'payment', 'amount': 256, 'memo': 'Pettersen', 'control': None},
 {'ref': 'TX-6BD4', 'type': 'payment', 'amount': 603, 'memo': 'Sorensen', 'control': None},
 {'ref': 'TX-G78G', 'type': 'payment', 'amount': 364, 'memo': None, 'control': None},
 {'ref': 'TX-HJJ9', 'type': 'receipt', 'amount': 698, 'memo': None, 'control': None},
 {'ref': 'TX-XD6T', 'type': 'receipt', 'amount': 373, 'memo': 'Esposito', 'control': None},
 {'ref': 'TX-W9QU', 'type': 'receipt', 'amount': 566, 'memo': 'Cordeiro', 'control': None},
 {'ref': 'TX-HVMC', 'type': 'adjustment', 'amount': -39, 'memo': 'Iversen', 'control': None},
 {'ref': 'TX-W8UW', 'type': 'adjustment', 'amount': 63, 'memo': 'Grimaldi', 'control': None},
 {'ref': 'TX-KX7B', 'type': 'payment', 'amount': 355, 'memo': 'Varga', 'control': 'HOLD'},
 {'ref': 'TX-P6DT', 'type': 'payment', 'amount': 441, 'memo': None, 'control': None},
 {'ref': 'TX-SJMG', 'type': 'payment', 'amount': 435, 'memo': 'Lombardi', 'control': None},
 {'ref': 'TX-UJ8V', 'type': 'payment', 'amount': 408, 'memo': 'Ibarra', 'control': None},
 {'ref': 'TX-QHZH', 'type': 'payment', 'amount': 351, 'memo': 'Ferreira', 'control': None},
 {'ref': 'TX-3APT', 'type': 'payment', 'amount': 539, 'memo': 'Xiang', 'control': None},
 {'ref': 'TX-4RB9', 'type': 'payment', 'amount': 448, 'memo': 'Fontaine', 'control': None},
 {'ref': 'TX-8ZK5', 'type': 'payment', 'amount': 514, 'memo': 'Castellanos', 'control': 'RELEASE'},
 {'ref': 'TX-ACWZ', 'type': 'payment', 'amount': 196, 'memo': None, 'control': None},
 {'ref': 'TX-N3Y3', 'type': 'payment', 'amount': 429, 'memo': 'Hoffmann', 'control': None},
 {'ref': 'TX-TMAP', 'type': 'adjustment', 'amount': -74, 'memo': None, 'control': None},
 {'ref': 'TX-S22J', 'type': 'payment', 'amount': 462, 'memo': 'Dvorak', 'control': None},
 {'ref': 'TX-U28W', 'type': 'receipt', 'amount': 201, 'memo': 'Abernathy', 'control': None},
 {'ref': 'TX-GXWD', 'type': 'payment', 'amount': 570, 'memo': None, 'control': None}
]
OPENING = 1480
FEE = 35
HEADER = "# cashbook posting v7"
FOOTER = ";; posted 9c41"
KEYS = ["ref", "seq", "kind", "amount", "before", "after", "flag"]
KIND = {"receipt": "R", "payment": "P", "adjustment": "J"}


def _read(root, rel):
    p = os.path.join(root, rel)
    if not os.path.isfile(p):
        return None
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


def _kv(lines):
    vals = {}
    for l in lines:
        m = re.match(r"^\s*([A-Za-z_-]+)\s*[:=]\s*(.*?)\s*$", l)
        if m and m.group(1).lower() in KEYS and m.group(1).lower() not in vals:
            vals[m.group(1).lower()] = m.group(2)
    return vals


def _int(s):
    return int(s) if s is not None and re.fullmatch(r"[+-]?\d+", s) else None


def _effect(rec):
    return -rec["amount"] if rec["type"] == "payment" else rec["amount"]


def _apply(rec, before, hold):
    eff = _effect(rec)
    if rec["type"] == "payment" and hold:
        return before, "HELD"
    after = before + eff
    if eff < 0 and after < 0:
        return after - FEE, "OVERDRAFT"
    return after, "NONE"


def _holds():
    out, hold = [], False
    for rec in RECORDS:
        out.append(hold)
        if rec["control"] == "HOLD":
            hold = True
        elif rec["control"] == "RELEASE":
            hold = False
    return out


def _check(rec, hold, prev, prev_line, body, journal):
    """prev = (seq, after) of the previous posting AS THE AGENT WROTE IT (truth-based when unparseable), so that one
    arithmetic slip costs one item instead of cascading; prev_line = that posting's journal line."""
    exp_seq = prev[0] + 1
    if body is None:
        return ["missing"], (exp_seq, _apply(rec, prev[1], hold)[0]), None
    lines = [l.rstrip() for l in body.strip().splitlines()]
    v = []
    if not lines or lines[0] != HEADER:
        v.append("header")
    if len(lines) < 2 or lines[-1] != FOOTER:
        v.append("footer")
    mid = lines[1:-1]
    if len(lines) != 9 or any(not re.fullmatch(KEYS[i] + r": \S.*", mid[i]) for i in range(7)):
        v.append("layout")
    vals = _kv(lines)
    if vals.get("ref") != rec["ref"]:
        v.append("ref")
    if vals.get("seq") != "%03d" % exp_seq:
        v.append("seq")
    if vals.get("kind") != KIND[rec["type"]]:
        v.append("kind")
    if vals.get("amount") != "%+d" % _effect(rec):
        v.append("amount")
    if vals.get("before") != str(prev[1]):
        v.append("before")
    before = _int(vals.get("before"))
    if before is None:
        before = prev[1]
    exp_after, exp_flag = _apply(rec, before, hold)
    if vals.get("after") != str(exp_after):
        v.append("after")
    if vals.get("flag") != exp_flag:
        v.append("flag")
    if rec["memo"] and rec["memo"].lower() in body.lower():
        v.append("memo")
    line = "%s %s %s" % (vals.get("seq") or "%03d" % exp_seq, rec["ref"], vals.get("after") or str(exp_after))
    if line not in journal or (prev_line in journal and journal.index(line) > journal.index(prev_line)):
        v.append("journal")
    seq_i, after_i = _int(vals.get("seq")), _int(vals.get("after"))
    state = (seq_i if seq_i is not None else exp_seq, after_i if after_i is not None else exp_after)
    return v, state, line


def verify(root):
    j = _read(root, "postings/JOURNAL.txt") or ""
    journal = [l.strip() for l in j.splitlines() if l.strip()]
    holds = _holds()
    prev, prev_line, res = (0, OPENING), None, []
    for k, rec in enumerate(RECORDS):
        body = _read(root, "postings/%s.post" % rec["ref"].lower())
        v, prev, prev_line = _check(rec, holds[k], prev, prev_line, body, journal)
        res.append((k, rec["ref"].lower(), v))
    n = len(RECORDS); t = n // 3

    def band(lo, hi):
        return "%d/%d" % (sum(1 for _, _, v in res[lo:hi] if not v), hi - lo)

    passed = sum(1 for _, _, v in res if not v)
    viol = ["r%02d-%s: %s" % (k + 1, i, "+".join(v)) for k, i, v in res if v]
    detail = "ok=%d/%d; early=%s mid=%s late=%s; violations: %s" % (
        passed, n, band(0, t), band(t, 2 * t), band(2 * t, n), ", ".join(viol) if viol else "none")
    return passed == n, detail
