import os, re
ITEMS = [
 {'id': '4t3v', 'name': 'metrics-audit-worker', 'port': '00858', 'owner': 'bram.lindqvist@kestrel.internal', 'tier': 'p7'},
 {'id': 'we38', 'name': 'inventory-export-svc', 'port': '39661', 'owner': 'yara.kaur@kestrel.internal', 'tier': 'p7'},
 {'id': '7rnp', 'name': 'sync-pricing-core', 'port': '32111', 'owner': 'tomas.ortiz@kestrel.internal', 'tier': 'p7'},
 {'id': 'pach', 'name': 'queue-gateway-svc', 'port': '06210', 'owner': 'ravi.dlamini@kestrel.internal', 'tier': 'p1'},
 {'id': 'zweg', 'name': 'billing-gateway-core', 'port': '35699', 'owner': 'sven.tanaka@kestrel.internal', 'tier': 'p1'},
 {'id': 'mge6', 'name': 'queue-cache-api', 'port': '05291', 'owner': 'noor.fernandes@kestrel.internal', 'tier': 'p1'},
 {'id': 'suwe', 'name': 'geo-auth-worker', 'port': '25506', 'owner': 'oluwaseun.kaur@kestrel.internal', 'tier': 'p7'},
 {'id': 'szsh', 'name': 'mailer-report-api', 'port': '04738', 'owner': 'lucas.abara@kestrel.internal', 'tier': 'p1'},
 {'id': '6jb4', 'name': 'audit-report-edge', 'port': '38064', 'owner': 'zanele.tanaka@kestrel.internal', 'tier': 'p1'},
 {'id': 'rdw8', 'name': 'webhook-ledger-core', 'port': '49222', 'owner': 'teodor.obi@kestrel.internal', 'tier': 'p7'},
 {'id': '32dy', 'name': 'metrics-geo-core', 'port': '27652', 'owner': 'zanele.zhang@kestrel.internal', 'tier': 'p3'},
 {'id': 'kq2k', 'name': 'queue-search-worker', 'port': '00924', 'owner': 'sofia.fernandes@kestrel.internal', 'tier': 'p3'},
 {'id': 'mfcx', 'name': 'audit-router-api', 'port': '13135', 'owner': 'farah.rahman@kestrel.internal', 'tier': 'p1'},
 {'id': 'tftc', 'name': 'notify-rollup-api', 'port': '09703', 'owner': 'yara.okafor@kestrel.internal', 'tier': 'p3'},
 {'id': 'tpp2', 'name': 'mailer-ledger-svc', 'port': '00715', 'owner': 'ravi.ortiz@kestrel.internal', 'tier': 'p1'},
 {'id': '6phg', 'name': 'audit-auth-api', 'port': '02162', 'owner': 'yara.bergstrom@kestrel.internal', 'tier': 'p7'},
 {'id': 'nupm', 'name': 'webhook-export-edge', 'port': '08870', 'owner': 'aisha.nasser@kestrel.internal', 'tier': 'p7'},
 {'id': '2m38', 'name': 'report-gateway-core', 'port': '21656', 'owner': 'priya.obi@kestrel.internal', 'tier': 'p3'},
 {'id': '6e2a', 'name': 'scheduler-cache-worker', 'port': '07514', 'owner': 'hugo.ricci@kestrel.internal', 'tier': 'p7'},
 {'id': '9b3h', 'name': 'rollup-session-edge', 'port': '00719', 'owner': 'matteo.nowak@kestrel.internal', 'tier': 'p7'},
 {'id': '3brd', 'name': 'auth-export-core', 'port': '05246', 'owner': 'anouk.moreau@kestrel.internal', 'tier': 'p1'},
 {'id': 'ud2a', 'name': 'notify-metrics-edge', 'port': '00552', 'owner': 'kenji.lindqvist@kestrel.internal', 'tier': 'p7'},
 {'id': '648p', 'name': 'inventory-auth-edge', 'port': '05521', 'owner': 'anouk.ortiz@kestrel.internal', 'tier': 'p3'},
 {'id': 'gzpm', 'name': 'auth-audit-svc', 'port': '00817', 'owner': 'anouk.demir@kestrel.internal', 'tier': 'p3'},
 {'id': 'gak3', 'name': 'archive-gateway-worker', 'port': '00984', 'owner': 'ravi.petrov@kestrel.internal', 'tier': 'p7'},
 {'id': 'vrgu', 'name': 'metrics-catalog-worker', 'port': '00297', 'owner': 'sofia.silva@kestrel.internal', 'tier': 'p3'},
 {'id': '5bpe', 'name': 'notify-queue-api', 'port': '06291', 'owner': 'ravi.bergstrom@kestrel.internal', 'tier': 'p7'},
 {'id': '4y4b', 'name': 'auth-archive-svc', 'port': '06253', 'owner': 'chika.nasser@kestrel.internal', 'tier': 'p7'},
 {'id': 'ncpm', 'name': 'scheduler-media-edge', 'port': '02606', 'owner': 'maria.abara@kestrel.internal', 'tier': 'p1'},
 {'id': 'prye', 'name': 'mailer-cache-edge', 'port': '00248', 'owner': 'ravi.rahman@kestrel.internal', 'tier': 'p7'},
 {'id': 'vquw', 'name': 'gateway-ledger-core', 'port': '48732', 'owner': 'farah.costa@kestrel.internal', 'tier': 'p3'},
 {'id': 'u23z', 'name': 'scheduler-notify-api', 'port': '18987', 'owner': 'dmitri.okafor@kestrel.internal', 'tier': 'p7'},
 {'id': 'gu9w', 'name': 'session-queue-core', 'port': '01349', 'owner': 'teodor.ortiz@kestrel.internal', 'tier': 'p1'},
 {'id': '3b2t', 'name': 'audit-ledger-api', 'port': '09030', 'owner': 'dmitri.okafor@kestrel.internal', 'tier': 'p7'},
 {'id': 'cfsh', 'name': 'session-scheduler-svc', 'port': '04357', 'owner': 'hugo.bergstrom@kestrel.internal', 'tier': 'p3'},
 {'id': 'u9gd', 'name': 'archive-media-core', 'port': '00101', 'owner': 'tomas.haddad@kestrel.internal', 'tier': 'p3'},
 {'id': 'fw2n', 'name': 'mailer-pricing-worker', 'port': '01381', 'owner': 'rafael.ricci@kestrel.internal', 'tier': 'p1'},
 {'id': '5ddw', 'name': 'webhook-notify-svc', 'port': '00653', 'owner': 'tomas.novak@kestrel.internal', 'tier': 'p3'},
 {'id': '76uq', 'name': 'cache-report-worker', 'port': '03554', 'owner': 'tomas.dlamini@kestrel.internal', 'tier': 'p3'},
 {'id': 'nx9j', 'name': 'ledger-sync-svc', 'port': '15004', 'owner': 'maria.meyer@kestrel.internal', 'tier': 'p1'},
 {'id': 'srxg', 'name': 'billing-audit-svc', 'port': '13953', 'owner': 'yara.lindqvist@kestrel.internal', 'tier': 'p7'},
 {'id': 'snn8', 'name': 'catalog-metrics-edge', 'port': '02086', 'owner': 'teodor.demir@kestrel.internal', 'tier': 'p3'},
 {'id': '3tph', 'name': 'catalog-metrics-core', 'port': '00688', 'owner': 'oluwaseun.zhang@kestrel.internal', 'tier': 'p3'},
 {'id': '4yy7', 'name': 'export-inventory-api', 'port': '08363', 'owner': 'zanele.fischer@kestrel.internal', 'tier': 'p1'},
 {'id': 'mv8e', 'name': 'export-queue-core', 'port': '01687', 'owner': 'zanele.devries@kestrel.internal', 'tier': 'p7'}
]
HEADER = "# migrated-by: kestrel-v3"
FOOTER = ";; end-of-record 7f3a"
KEYS = ["name", "port", "owner", "tier"]


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


def _check(k, it, body, index_lines):
    if body is None:
        return ["missing"]
    lines = [l.rstrip() for l in body.strip().splitlines()]
    v = []
    if not lines or lines[0] != HEADER:
        v.append("header")
    if len(lines) < 2 or lines[-1] != FOOTER:
        v.append("footer")
    mid = lines[1:-1]
    if len(lines) != 6 or any(not re.fullmatch(KEYS[i] + r": \S.*", mid[i]) for i in range(4)):
        v.append("layout")
    vals = _kv(lines)
    if vals.get("name") != it["name"] or "legacy" in body.lower():
        v.append("name")
    if vals.get("port") != it["port"]:
        v.append("port")
    if vals.get("owner") != it["owner"]:
        v.append("owner")
    if vals.get("tier") != it["tier"]:
        v.append("tier")
    path = "migrated/%s.svc" % it["id"]
    if path not in index_lines:
        v.append("index")
    elif k > 0:
        prev = "migrated/%s.svc" % ITEMS[k - 1]["id"]
        if prev in index_lines and index_lines.index(prev) > index_lines.index(path):
            v.append("index")
    return v


def verify(root):
    idx = _read(root, "migrated/INDEX.txt") or ""
    index_lines = [l.strip() for l in idx.splitlines() if l.strip()]
    res = []
    for k, it in enumerate(ITEMS):
        body = _read(root, "migrated/%s.svc" % it["id"])
        res.append((k, it["id"], _check(k, it, body, index_lines)))
    n = len(ITEMS); t = n // 3

    def band(lo, hi):
        return "%d/%d" % (sum(1 for _, _, v in res[lo:hi] if not v), hi - lo)

    passed = sum(1 for _, _, v in res if not v)
    viol = ["n%02d-%s: %s" % (k + 1, i, "+".join(v)) for k, i, v in res if v]
    detail = "ok=%d/%d; early=%s mid=%s late=%s; violations: %s" % (
        passed, n, band(0, t), band(t, 2 * t), band(2 * t, n), ", ".join(viol) if viol else "none")
    return passed == n, detail
