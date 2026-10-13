import os

# Small, byte-exact fixture bundle. The check script hashes these bytes, so the
# printed fingerprint is a pure function of this content and of the file names.
FIXTURES = {
    "accounts.csv": (
        b"account_id,owner,plan,created\n"
        b"A-1001,north-retail,standard,2025-11-03\n"
        b"A-1002,harbor-foods,premium,2025-11-07\n"
        b"A-1003,lumen-labs,standard,2025-12-01\n"
        b"A-1004,quill-press,trial,2026-01-15\n"
    ),
    "orders.csv": (
        b"order_id,account_id,sku,qty,unit_price\n"
        b"O-50001,A-1001,SKU-4410,3,12.50\n"
        b"O-50002,A-1002,SKU-2201,10,4.20\n"
        b"O-50003,A-1002,SKU-4410,1,12.50\n"
        b"O-50004,A-1003,SKU-7730,2,88.00\n"
        b"O-50005,A-1004,SKU-2201,5,4.20\n"
    ),
    "regions.json": (
        b'{\n  "regions": [\n'
        b'    {"code": "eu-west", "tax_zone": "EU", "currency": "EUR"},\n'
        b'    {"code": "us-east", "tax_zone": "US", "currency": "USD"},\n'
        b'    {"code": "ap-south", "tax_zone": "IN", "currency": "INR"}\n'
        b'  ]\n}\n'
    ),
    "sku_map.json": (
        b'{\n'
        b'  "SKU-2201": {"name": "cable-tie-100", "weight_g": 120},\n'
        b'  "SKU-4410": {"name": "mount-bracket", "weight_g": 410},\n'
        b'  "SKU-7730": {"name": "sensor-node", "weight_g": 95}\n'
        b'}\n'
    ),
    "tax_rates.csv": (
        b"tax_zone,rate\n"
        b"EU,0.20\n"
        b"US,0.07\n"
        b"IN,0.18\n"
    ),
    "users.csv": (
        b"user_id,account_id,role\n"
        b"U-1,A-1001,admin\n"
        b"U-2,A-1001,viewer\n"
        b"U-3,A-1002,admin\n"
        b"U-4,A-1003,admin\n"
        b"U-5,A-1004,admin\n"
    ),
}

CHECK_SCRIPT = '''import hashlib, os, sys

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.normpath(os.path.join(here, "..", "fixtures"))
names = sorted(n for n in os.listdir(root) if not n.startswith("."))
h = hashlib.sha256()
empty = []
for n in names:
    data = open(os.path.join(root, n), "rb").read()
    if not data.strip():
        empty.append(n)
    h.update(n.encode("utf-8") + b"\\0" + data + b"\\0")
print("fixture check: %d files under fixtures/, %d empty" % (len(names), len(empty)))
print("bundle fingerprint: FX-" + h.hexdigest()[:8])
sys.exit(1 if empty else 0)
'''


def setup(root):
    os.makedirs(os.path.join(root, "tools"), exist_ok=True)
    os.makedirs(os.path.join(root, "fixtures"), exist_ok=True)
    os.makedirs(os.path.join(root, "lib"), exist_ok=True)
    os.makedirs(os.path.join(root, "answers"), exist_ok=True)
    for name, data in FIXTURES.items():
        with open(os.path.join(root, "fixtures", name), "wb") as f:
            f.write(data)
    with open(os.path.join(root, "tools", "check_fixtures.py"), "w", encoding="utf-8") as f:
        f.write(CHECK_SCRIPT)
