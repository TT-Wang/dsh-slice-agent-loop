"""f1 (slice-vs-stock, 2026-10-23): a long session with large tool outputs and early facts quizzed late.

Adapted from sliceagent's s10_compactloss (76 turns: a one-shot build id, an ephemeral lint error, 64 full reads
of 9 KB blobs, three quizzes) and s13_compact_amnesia (deployment parameters stated by the user in turn 1, a
placement constraint, a never-given fact as a confabulation trap). Changes for this evaluation:

- the blobs are realistic service logs (about 12,000 characters, about 95 lines each) instead of random letters,
  each with one AUDIT-TOKEN line placed between 40% and 60% of the file, and some carrying same-format decoys:
  other build ids (deploy events) and other lint findings;
- the build id, the lint finding and every blob token are generated at setup time from AB_TASK_SEED, which
  run_ab.py derives from a salt kept in the vault plus (batch, task, rep): both arms of a pair get identical
  content, and no oracle value exists on disk outside the workdir, the vault and the cell's own session log;
- the truth (oracle values, plus the exam and delivery token specs ab_metrics uses) is written beside the
  workdir (<workdir>.truth.json), which the harness keeps in the vault while turns run;
- the two scripts sit under tools/ and are deleted by hooks.after_turn after their turns, so the build id and the
  lint message exist only in the tool results of turns 3 and 5 (and the session log).

Stdlib only.
"""
import hashlib
import json
import os
import random

N_BLOBS = 48
BLOB_CHARS = 12_000
# User-stated facts of turn 1 (they are in the prompt itself, so they are static).
HOST, PORT, TOKEN_ENV, BACKOFF, CONSTRAINT_DIR = "10.7.4.23", "6311", "ORCHID_DEPLOY_KEY", "350", "ops"
DEFAULT_SEED = "svs-f1-selfcheck"
TOKEN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
SERVICES = ["orders-api", "billing", "inventory", "auth-gw", "search", "notify", "ledger", "shipping"]
ROUTES = ["GET /v1/orders/{id}", "POST /v1/orders", "GET /v1/items", "PUT /v1/cart/{id}", "GET /healthz",
          "POST /v1/payments", "GET /v1/users/{id}/prefs", "DELETE /v1/sessions/{id}", "GET /v1/search?q=..."]
REGIONS = ["eu-west-1", "us-east-2", "ap-south-1"]
WARN_MSGS = ["slow upstream response from pricing", "retrying idempotent request", "cache miss storm on key prefix catalog:",
             "connection pool at 85% capacity", "clock skew 230ms against ntp peer", "deprecated header X-Client-Ver seen"]
ERROR_MSGS = ["upstream timeout after 3000ms", "deadlock detected; transaction rolled back", "TLS handshake failed: certificate expired",
              "payload rejected: schema mismatch on field 'currency'", "queue publish failed: broker unavailable"]
LINT_KINDS = ["dangling-sentinel", "unsealed-frame", "orphan-binding"]


def _seed():
    return os.environ.get("AB_TASK_SEED") or DEFAULT_SEED


def build(seed):
    """Everything setup writes, from one seed: files and the truth record."""
    rng = random.Random(hashlib.sha256(("svs-f1:" + seed).encode()).hexdigest())
    hexs = lambda n: "".join(rng.choice("0123456789abcdef") for _ in range(n))
    build_id = "bx-" + hexs(10)
    sentinel = rng.choice(["qz", "kv", "mt", "rw"]) + "_" + rng.choice(["marker", "anchor", "latch"])
    lint_code = "E%04d" % rng.randint(1000, 9899)
    lint_frame = rng.randint(2, 7)
    lint_kind = rng.choice(LINT_KINDS)
    lint_error = f"{lint_code} {lint_kind}: '{sentinel}' bound but never sealed (frame {lint_frame})"
    decoy_builds = sorted({"bx-" + hexs(10) for _ in range(6)} - {build_id})
    decoy_lints = []
    for _ in range(3):
        code = "E%04d" % rng.randint(1000, 9899)
        if code == lint_code:
            continue
        decoy_lints.append(f"{code} {rng.choice(LINT_KINDS)}: '{rng.choice(['qz', 'kv', 'mt', 'rw'])}_{rng.choice(['marker', 'anchor', 'latch'])}' "
                           f"bound but never sealed (frame {rng.randint(2, 7)})")
    tokens = {}
    while len(tokens) < N_BLOBS:
        t = "".join(rng.choice(TOKEN_ALPHABET) for _ in range(8))
        if t not in tokens.values():
            tokens[f"blob_{len(tokens) + 1:02d}"] = t
    # decoys go into these blobs (never the first or last few, so they sit between the early facts and the quizzes)
    decoy_blob_build = rng.sample(range(6, N_BLOBS - 3), len(decoy_builds))
    decoy_blob_lint = rng.sample([i for i in range(6, N_BLOBS - 3) if i not in decoy_blob_build], len(decoy_lints))
    blobs = {}
    clock = 8 * 3600
    for i in range(1, N_BLOBS + 1):
        name = f"blob_{i:02d}"
        lines = []
        extra = []
        if i in decoy_blob_build:
            b = decoy_builds[decoy_blob_build.index(i)]
            extra.append(f"INFO  [deployer] rollout started build_id={b} canary=5% region={rng.choice(REGIONS)}")
        if i in decoy_blob_lint:
            extra.append(f"WARN  [ci-lint] frames.py: {decoy_lints[decoy_blob_lint.index(i)]}")
        while sum(len(l) + 1 for l in lines) < BLOB_CHARS:
            clock += rng.randint(1, 40)
            ts = "2026-10-%02dT%02d:%02d:%02d.%03dZ" % (3 + i // 16, (clock // 3600) % 24, (clock // 60) % 60, clock % 60, rng.randint(0, 999))
            r = rng.random()
            svc = rng.choice(SERVICES)
            if r < 0.07:
                body = f"WARN  [{svc}] {rng.choice(WARN_MSGS)} req={hexs(8)}"
            elif r < 0.10:
                body = f"ERROR [{svc}] {rng.choice(ERROR_MSGS)} req={hexs(8)} attempt={rng.randint(1, 3)}"
            elif r < 0.12 and extra:
                body = extra.pop()
            else:
                status = rng.choice([200] * 12 + [201, 204, 304, 400, 404, 409, 429, 500, 503])
                body = (f"INFO  [{svc}] req={hexs(8)} route={rng.choice(ROUTES)} status={status} dur_ms={rng.randint(2, 900)} "
                        f"user=u-{rng.randint(10000, 99999)} region={rng.choice(REGIONS)}")
            lines.append(f"{ts} {body}")
        lines += [f"{ts} {e}" for e in extra]  # a decoy the loop did not place yet
        at = int(len(lines) * rng.uniform(0.40, 0.60))
        lines.insert(at, f"{ts} AUDIT [import-audit] AUDIT-TOKEN: {tokens[name]} batch={name} checksum=ok")
        blobs[name + ".log"] = "\n".join(lines) + "\n"
    truth = {
        "build_id": build_id, "lint_error": lint_error, "lint_code": lint_code, "tokens": tokens,
        "decoy_build_ids": decoy_builds, "decoy_lint_errors": decoy_lints,
        "deploy": {"host": HOST, "port": PORT, "token_env": TOKEN_ENV, "retry_backoff_ms": BACKOFF, "dir": CONSTRAINT_DIR},
        # ab_metrics specs (run_ab.py merges them with meta.json): exams address the quiz turns, delivery the turns whose
        # tool output must carry the fact (a run whose output was discarded leaves nothing to recall).
        "exams": [{"turn": 57, "tokens": [build_id]}, {"turn": 58, "tokens": [lint_error]}],
        "delivery": [{"turn": 3, "tokens": [build_id]}, {"turn": 5, "tokens": [lint_error]}],
    }
    files = {
        "README.md": "# compactloss substrate\nSmall utility project. data/ holds service-log excerpts for the import audit; "
                     "digest.md accumulates one audit token per excerpt.\n",
        "core.py": "# core utilities\n",
        "frames.py": f"FRAMES = [1, 2, 3, 4, 5, 6, 7]\n{sentinel} = object()   # sentinel bound for frame {lint_frame}\n",
        ".build_seed": build_id + "\n",
        "tools/inspect_build.py": (
            "import os\n"
            "SEED = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.build_seed')\n"
            "if os.path.exists(SEED):\n"
            "    print('BUILD_ID: ' + open(SEED).read().strip())\n"
            "    os.remove(SEED)\n"
            "else:\n"
            "    print('BUILD SEED CONSUMED: the id was shown exactly once and cannot be reproduced')\n"),
        "tools/lint_frames.py": (
            "import os\n"
            "HERE = os.path.dirname(os.path.abspath(__file__))\n"
            "src = open(os.path.join(HERE, '..', 'frames.py')).read()\n"
            f"print({lint_error!r} if {sentinel!r} in src else 'frames.py: clean')\n"),
    }
    for name, body in blobs.items():
        files["data/" + name] = body
    return files, truth


def setup(root):
    files, truth = build(_seed())
    for rel, body in files.items():
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(body)
    with open(os.path.normpath(root) + ".truth.json", "w", encoding="utf-8") as fh:
        json.dump(truth, fh, indent=1, sort_keys=True)
