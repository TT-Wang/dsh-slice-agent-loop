#!/usr/bin/env python3
"""自检(stdlib-only):
1. 对每个场景:setup(root) 到临时目录,不做任何事就 verify → 必须 ok=False,且 detail 说清楚缺了什么
2. 用独立的参考求解器(只按 manifest 文本里的规则,像 agent 一样从入口沿 next 走链)生成全部输出 → verify 必须 ok=True
3. 模拟"后段腐蚀":参考解的 late 三分之一改成诱饵风格 → early/mid 满分、late 掉分,证明分段能反映 rot
用法: python3 selfcheck.py
"""
import importlib.util, os, re, shutil, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name, mod):
    p = os.path.join(HERE, name, mod + ".py")
    spec = importlib.util.spec_from_file_location("%s_%s" % (name, mod), p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def rd(root, rel):
    with open(os.path.join(root, rel), encoding="utf-8") as f:
        return f.read()


def wr(root, rel, text):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)


# ── 参考求解器 l1:只依据 MANIFEST.txt 的 R1..R9 ──────────────────────────
def solve_l1(root):
    man = rd(root, "MANIFEST.txt")
    cur = re.search(r"^Entry point: (nodes/\S+\.txt)$", man, re.M).group(1)
    tier = {"gold": "p1", "silver": "p3", "bronze": "p7"}
    order, reads = [], 1
    while cur != "END":
        f = dict(re.findall(r"^(\w+) = (.*)$", rd(root, cur), re.M))   # ';' 注释行不匹配,自然被忽略
        reads += 1
        nid = f["id"].lower()
        name = f["name"][7:] if f["name"].startswith("legacy-") else f["name"]
        out = "\n".join(["# migrated-by: kestrel-v3", "name: " + name, "port: " + f["port"].zfill(5),
                         "owner: " + f["owner"].split("@")[0] + "@kestrel.internal", "tier: " + tier[f["tier"]],
                         ";; end-of-record 7f3a"]) + "\n"
        wr(root, "migrated/%s.svc" % nid, out)
        order.append("migrated/%s.svc" % nid)
        cur = f["next"]
    wr(root, "migrated/INDEX.txt", "\n".join(order) + "\n")
    return order, reads


# ── 参考求解器 l2:只依据 LEDGER_RULES.md 的 R1..R9,余额/序号/hold 一路带着 ──
def solve_l2(root, slip_at=None):
    """slip_at: 1-based position where a simulated agent mis-adds by +10 and then carries its wrong balance forward
    (like a real agent would) -- used to show that one slip costs exactly one item, not the whole tail."""
    man = rd(root, "LEDGER_RULES.md")
    cur = re.search(r"^Entry record:\s+(ledger/\S+\.rec)$", man, re.M).group(1)
    bal = int(re.search(r"^Opening balance: (-?\d+)$", man, re.M).group(1))
    fee = int(re.search(r"charge an additional fee\s+of (\d+)", man).group(1))
    kind = {"receipt": "R", "payment": "P", "adjustment": "J"}
    hold, seq, journal, order, reads = False, 0, [], [], 1
    while cur != "END":
        f = dict(re.findall(r"^(\w+): (.*)$", rd(root, cur), re.M))
        reads += 1
        seq += 1
        amt = int(f["amount"])
        eff = -amt if f["type"] == "payment" else amt
        before = bal
        if f["type"] == "payment" and hold:
            after, flag = before, "HELD"
        else:
            after = before + eff
            if eff < 0 and after < 0:
                after, flag = after - fee, "OVERDRAFT"
            else:
                flag = "NONE"
        if seq == slip_at:
            after += 10
        out = "\n".join(["# cashbook posting v7", "ref: " + f["ref"], "seq: %03d" % seq, "kind: " + kind[f["type"]],
                         "amount: %+d" % eff, "before: %d" % before, "after: %d" % after, "flag: " + flag,
                         ";; posted 9c41"]) + "\n"
        wr(root, "postings/%s.post" % f["ref"].lower(), out)
        order.append(f["ref"].lower())
        journal.insert(0, "%03d %s %d" % (seq, f["ref"], after))      # newest first
        bal = after
        if f.get("control") == "HOLD": hold = True
        elif f.get("control") == "RELEASE": hold = False
        cur = f["next"]
    wr(root, "postings/JOURNAL.txt", "\n".join(journal) + "\n")
    return order, reads, bal


# ── 模拟后段腐蚀:late 三分之一按诱饵风格重写 ────────────────────────────
def rot_l1(root, order):
    for path in order[30:]:
        body = rd(root, path)
        body = body.replace("# migrated-by: kestrel-v3", "# migrated-by: kestrel-v4") \
                   .replace(";; end-of-record 7f3a", ";; EOF").replace("@kestrel.internal", "@kestrel.io")
        wr(root, path, body)


def rot_l2(root, order):
    for ref in order[30:]:
        rel = "postings/%s.post" % ref
        body = rd(root, rel).replace(";; posted 9c41", ";; posted 9c42").replace("kind: P", "kind: DR") \
                            .replace("kind: R", "kind: CR").replace("flag: HELD", "flag: NONE")
        wr(root, rel, body)


def run(name, solver, rotter):
    setup, verify = load(name, "setup").setup, load(name, "verify").verify
    print("=" * 100)
    print("[%s] 1) untouched workdir" % name)
    root = tempfile.mkdtemp(prefix=name + "_")
    setup(root)
    ok, detail = verify(root)
    print("   ok=%s\n   %s" % (ok, detail[:300] + (" ..." if len(detail) > 300 else "")))
    assert ok is False, "verifier is vacuous"

    print("[%s] 2) reference solver (follows the manifest literally, walks the chain)" % name)
    res = solver(root)
    order, reads = res[0], res[1]
    ok, detail = verify(root)
    print("   items=%d, dependent reads on the critical path (manifest + chain)=%d, minimal tool calls=%d"
          % (len(order), reads, reads + len(order) + 1))
    if len(res) > 2:
        print("   final balance = %d" % res[2])
    print("   ok=%s\n   %s" % (ok, detail))
    assert ok is True, "verifier rejects the reference solution"

    print("[%s] 3) simulated late-chain rot (reference solution, last third rewritten in decoy style)" % name)
    rotter(root, order)
    ok, detail = verify(root)
    print("   ok=%s\n   %s" % (ok, detail))
    assert ok is False and "early=15/15" in detail and "late=0/15" in detail
    shutil.rmtree(root)


def run_slip():
    """l2 only: one arithmetic slip at record 20 (carried forward) must cost exactly one item."""
    name = "l2_ledger_state"
    setup, verify = load(name, "setup").setup, load(name, "verify").verify
    print("=" * 100)
    print("[%s] 4) single arithmetic slip at record 20, wrong balance carried forward by the 'agent'" % name)
    root = tempfile.mkdtemp(prefix=name + "_slip_")
    setup(root)
    solve_l2(root, slip_at=20)
    ok, detail = verify(root)
    print("   ok=%s\n   %s" % (ok, detail))
    assert ok is False and "ok=44/45" in detail and detail.endswith("violations: r20-tx-kx8p: after")
    shutil.rmtree(root)


if __name__ == "__main__":
    run("l1_chain_migrate", solve_l1, rot_l1)
    run("l2_ledger_state", solve_l2, rot_l2)
    run_slip()
    print("=" * 100)
    print("SELFCHECK PASSED")
