"""R4 p110_r4_probe_compare: two probe outputs from different turns must be combined.

tools/probe.py prints `probe region=<r> run=PRB-<r>-<hash8>` and an 8-endpoint
p50_ms/p95_ms table. Every number is sha256(SALT:region:endpoint:metric), so it
is a pure function of the script text and cannot be guessed. The same formula is
recomputed in verify.py (via `expected()` below). The output is about 350
characters, below every fold threshold, so the model sees it whole in T1/T2;
after the harness deletes tools/ (after T2) it survives only in the log.
"""
import hashlib
import os

SALT = "5f0c2d9e8b7a41c6a3e1d4f7b2c8e905"
REGIONS = ("us", "eu")
ENDPOINTS = ("auth", "catalog", "checkout", "search", "profile", "inventory", "payments", "shipping")


def _h(*parts):
    return int(hashlib.sha256((SALT + ":" + ":".join(parts)).encode("utf-8")).hexdigest()[:8], 16)


def run_id(region):
    return "PRB-%s-%08x" % (region, _h(region, "run"))


def value(region, endpoint, metric):
    p50 = 20 + _h(region, endpoint, "p50") % 180
    return p50 if metric == "p50" else p50 + 30 + _h(region, endpoint, "p95") % 500


def row(region, endpoint):
    return "%-12s%7d%8d" % (endpoint, value(region, endpoint, "p50"), value(region, endpoint, "p95"))


def expected():
    """(endpoint, us p95, eu p95) for the endpoint with the highest us p95."""
    us = sorted(((value("us", e, "p95"), e) for e in ENDPOINTS), reverse=True)
    assert us[0][0] != us[1][0], "us p95 maximum must be unique"
    ep = us[0][1]
    return ep, value("us", ep, "p95"), value("eu", ep, "p95")


PROBE = '''import hashlib, sys

SALT = "%s"
ENDPOINTS = %r


def _h(*parts):
    return int(hashlib.sha256((SALT + ":" + ":".join(parts)).encode("utf-8")).hexdigest()[:8], 16)


args = sys.argv[1:]
if len(args) != 2 or args[0] != "--region" or args[1] not in ("us", "eu"):
    print("usage: probe.py --region us|eu", file=sys.stderr)
    sys.exit(2)
region = args[1]
print("probe region=%%s run=PRB-%%s-%%08x" %% (region, region, _h(region, "run")))
print("%%-12s%%7s%%8s" %% ("endpoint", "p50_ms", "p95_ms"))
for ep in ENDPOINTS:
    p50 = 20 + _h(region, ep, "p50") %% 180
    p95 = p50 + 30 + _h(region, ep, "p95") %% 500
    print("%%-12s%%7d%%8d" %% (ep, p50, p95))
''' % (SALT, ENDPOINTS)


def setup(root):
    expected()
    os.makedirs(os.path.join(root, "tools"), exist_ok=True)
    os.makedirs(os.path.join(root, "lib"), exist_ok=True)
    os.makedirs(os.path.join(root, "answers"), exist_ok=True)
    with open(os.path.join(root, "tools", "probe.py"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(PROBE)
