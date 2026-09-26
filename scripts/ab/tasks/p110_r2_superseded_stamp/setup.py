import os

# A small runtime config. tools/stamp.py prints a "config stamp" that is a pure
# function of the parsed KEY=VALUE set (comments, blank lines, quoting and
# whitespace are canonicalised away), so the value printed after the user's
# T6 correction (REGION eu-west-1 -> eu-central-1) is the same no matter how the
# model performs the edit (sed, rewrite, quoted value, appended override line).
CONFIG = (
    "# ingest-gateway runtime config\n"
    "SERVICE_NAME=ingest-gateway\n"
    "REGION=eu-west-1\n"
    "REPLICAS=3\n"
    "LOG_LEVEL=info\n"
    "QUEUE_DEPTH=4096\n"
    "TLS_PROFILE=modern\n"
    "RETENTION_DAYS=14\n"
)

STAMP_SCRIPT = '''import hashlib, os, sys

here = os.path.dirname(os.path.abspath(__file__))
path = os.path.normpath(os.path.join(here, "..", "config", "service.env"))
pairs = {}
bad = []
for n, raw in enumerate(open(path, encoding="utf-8").read().splitlines(), 1):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith("export "):
        line = line[7:].strip()
    if "=" not in line:
        bad.append(n)
        continue
    k, v = line.split("=", 1)
    k, v = k.strip(), v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\\"'":
        v = v[1:-1]
    pairs[k] = v
canon = "\\n".join("%s=%s" % (k, pairs[k]) for k in sorted(pairs))
h = hashlib.sha256(canon.encode("utf-8")).hexdigest()[:8]
print("config parsed: %d keys from config/service.env%s"
      % (len(pairs), (", %d bad line(s)" % len(bad)) if bad else ""))
print("config stamp: CFG-" + h)
sys.exit(1 if bad or not pairs else 0)
'''


def setup(root):
    os.makedirs(os.path.join(root, "tools"), exist_ok=True)
    os.makedirs(os.path.join(root, "config"), exist_ok=True)
    os.makedirs(os.path.join(root, "lib"), exist_ok=True)
    os.makedirs(os.path.join(root, "answers"), exist_ok=True)
    with open(os.path.join(root, "config", "service.env"), "w", encoding="utf-8", newline="\n") as f:
        f.write(CONFIG)
    with open(os.path.join(root, "tools", "stamp.py"), "w", encoding="utf-8", newline="\n") as f:
        f.write(STAMP_SCRIPT)
