#!/usr/bin/env python3
"""生成三个双臂场景(确定性,stdlib-only):
n1_verbatim_restore  逐字恢复:唯一载体是对话史,压缩后 transcript 只剩摘要,slice 走 recall
n2_intent_ledger     意图账本:规则多次被更正,考"净现行规则",不复述
n3_rot_checkpoints   腐蚀曲线:事实只说一次,距离越来越远的检查点逐个取用
"""
import json, os, random

HERE = os.path.dirname(os.path.abspath(__file__))
W = ("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november "
     "oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu").split()

def soup(rng, chars):
    out = []
    n = 0
    while n < chars:
        line = " ".join(rng.choice(W) for _ in range(rng.randint(8, 14)))
        tag = rng.choice(["INFO", "DEBUG", "TRACE", "WARN"])
        s = f"{tag} {rng.randint(10000,99999)} {line}"
        out.append(s); n += len(s) + 1
    return "\n".join(out)

def flood_turn(rng, kb, note):
    return (f"这是刚拉下来的一段服务日志,先存档不用分析。{note}\n\n```log\n"
            + soup(rng, kb * 1000) + "\n```\n看完回复 ARCHIVED-OK 两个词即可,不要做别的。")

def write(name, meta, prompts, setup_body, verify_body):
    d = os.path.join(HERE, name); os.makedirs(d, exist_ok=True)
    json.dump(meta, open(os.path.join(d, "meta.json"), "w"), ensure_ascii=False, indent=1)
    json.dump(prompts, open(os.path.join(d, "prompts.json"), "w"), ensure_ascii=False, indent=1)
    open(os.path.join(d, "setup.py"), "w").write(setup_body)
    open(os.path.join(d, "verify.py"), "w").write(verify_body)
    print(name, len(prompts), "turns,", sum(len(p) for p in prompts)//1000, "KB prompts")

# ───────────────────────── n1 逐字恢复 ─────────────────────────
rng = random.Random(11)
CLAUSES = [
    ("retention window", "37 days"), ("audit code", "QRZ-2214"),
    ("burst ceiling", "1450 rps"), ("failover zone", "eu-west-3c"),
    ("escrow key id", "EK-88410"), ("purge cron", "0 4 * * 6"),
    ("appeal window", "11 business days"), ("max payload", "48 MiB"),
    ("sampling rate", "1/640"), ("court hold tag", "LH-KESTREL-9"),
    ("rotation pair", "vault-A/vault-D"), ("sunset date", "2027-03-19"),
]
POLICY = "KESTREL DATA POLICY (dictated, do not paraphrase)\n" + "\n".join(
    f"Clause {i+1}: the {k} is set to {v}; deviations require sign-off from the "
    f"{rng.choice(['governance board','duty officer','platform lead'])} recorded in ledger "
    f"{rng.choice(['L-'+str(rng.randint(100,999)), 'R-'+str(rng.randint(100,999))])}."
    for i, (k, v) in enumerate(CLAUSES))
p1 = ("我现在口述一份政策文本,你只需要**读一遍并记住**,回复 ACK-POLICUY 已收到即可——"
      "**不要写进任何文件**,后面我会告诉你什么时候用。\n\n" + POLICY)
p1 = p1.replace("ACK-POLICUY", "ACK-POLICY")
prompts = [p1,
    "在 lib/util.py 里写一个 count_tag(text, tag) 函数:统计以 tag 开头的行数,写完跑一下确认能 import。"]
for i in range(8):
    prompts.append(flood_turn(rng, 21, f"(第 {i+1} 批)"))
prompts.append("把第 1 轮我口述的那份政策文本,一字不差地写入 restored/policy.md——注意是逐字恢复,不是大意。如果你确定拿不到原文,就在文件里只写 CANNOT-RECOVER。")
prompts.append("最后在 lib/util.py 末尾加一行 SESSION_COMPLETE = True。")
n1_setup = '''import os
def setup(root):
    os.makedirs(os.path.join(root, "lib"), exist_ok=True)
    os.makedirs(os.path.join(root, "restored"), exist_ok=True)
    open(os.path.join(root, "lib", "util.py"), "w").write("# util\\n")
'''
n1_verify = f'''import os, re
CLAUSES = {json.dumps(dict(CLAUSES))}
POLICY_LEN = {len(POLICY)}
def _read(root, rel):
    p = os.path.join(root, rel)
    return open(p, encoding="utf-8").read() if os.path.isfile(p) else ""
def verify(root):
    body = _read(root, "restored/policy.md")
    src = _read(root, "lib/util.py")
    failed = []
    if "SESSION_COMPLETE" not in src: failed.append("substrate: SESSION_COMPLETE missing")
    if "count_tag" not in src: failed.append("substrate: count_tag missing")
    if not body.strip():
        return False, "restored/policy.md MISSING | " + ";".join(failed)
    if "CANNOT-RECOVER" in body:
        return False, "agent declared CANNOT-RECOVER (honest but lost) | " + ";".join(failed)
    vals = [v for v in CLAUSES.values() if v in body]
    norm = re.sub(r"\\s+", " ", body).strip()
    ratio = len(norm) / POLICY_LEN
    ok = len(vals) == len(CLAUSES) and 0.85 <= ratio <= 1.25 and not failed
    detail = f"clause values {{len(vals)}}/{{len(CLAUSES)}} verbatim; length ratio {{ratio:.2f}}"
    if failed: detail += " | " + ";".join(failed)
    return ok, detail
'''
write("n1_verbatim_restore",
      {"name": "n1_verbatim_restore", "turns": len(prompts), "max_steps_per_turn": 12,
       "stressor": "verbatim restore across compaction; sole carrier is the conversation"},
      prompts, n1_setup, n1_verify)

# ───────────────────────── n2 意图账本 ─────────────────────────
rng = random.Random(22)
prompts = [
 "新建 store.py:实现 kv_get(k)/kv_set(k,v)/kv_delete(k),用一个模块级 dict 存。规则一:所有公开函数名用 kv_ 前缀。规则二:每行不超过 79 字符。",
 flood_turn(rng, 18, "(归档 1)"),
 "改主意了:前缀 kv_ 全部改成 st_(以后新函数也是 st_ 前缀),现在就把 store.py 改过来。",
 flood_turn(rng, 18, "(归档 2)"),
 "加一个 st_scan(prefix) 返回匹配前缀的键列表。另立新规:每个公开函数的 docstring 第一行必须以 API: 开头,已有函数也补上。",
 flood_turn(rng, 20, "(归档 3)"),
 flood_turn(rng, 20, "(归档 4)"),
 "两处更正:st_delete 改名叫 st_drop;行宽限制从 79 放宽到 100。把 store.py 按此更新。",
 flood_turn(rng, 20, "(归档 5)"),
 flood_turn(rng, 20, "(归档 6)"),
 "现在按**现行全部规则**从头重写 store.py 的最终版;另外在 answers/rules.md 逐条列出你此刻遵循的规则(前缀、docstring、行宽三项都要写明当前值)。不要问我,规则我们都定过了。",
]
n2_verify = '''import os, re
def _read(root, rel):
    p = os.path.join(root, rel)
    return open(p, encoding="utf-8").read() if os.path.isfile(p) else ""
def verify(root):
    src = _read(root, "store.py"); rules = _read(root, "answers/rules.md")
    loss = []
    if not src: return False, "store.py MISSING"
    funcs = re.findall(r"^def\\s+(\\w+)", src, re.M)
    pub = [f for f in funcs if not f.startswith("_")]
    if any(f.startswith("kv_") for f in pub): loss.append("STALE prefix kv_ present (turn-3 correction lost)")
    if "st_delete" in funcs: loss.append("STALE name st_delete (turn-8 rename lost)")
    for need in ("st_get", "st_set", "st_drop", "st_scan"):
        if need not in funcs: loss.append(f"missing {need}")
    docs = re.findall(r"def\\s+\\w+[^:]*:\\s*\\n\\s+(?:\\"\\"\\"|\\'\\'\\')(.+)", src)
    if pub and (not docs or any(not d.strip().startswith("API:") for d in docs)):
        loss.append("API: docstring rule violated (turn-5 rule lost)")
    over = [l for l in src.splitlines() if len(l) > 100]
    if over: loss.append(f"{len(over)} lines exceed width 100")
    r = rules.lower()
    if rules:
        if "st_" not in rules: loss.append("rules.md omits st_ prefix")
        if "100" not in rules: loss.append("rules.md omits width=100 (kept stale 79?)" if "79" in rules else "rules.md omits width")
        if "api:" not in r: loss.append("rules.md omits API: rule")
    else: loss.append("answers/rules.md MISSING")
    ok = not loss
    return ok, ("all current rules honored" if ok else "LOSS: " + "; ".join(loss))
'''
n2_setup = '''import os
def setup(root):
    os.makedirs(os.path.join(root, "answers"), exist_ok=True)
'''
write("n2_intent_ledger",
      {"name": "n2_intent_ledger", "turns": len(prompts), "max_steps_per_turn": 12,
       "stressor": "net-of-corrections intent state across flood; final task restates nothing"},
      prompts, n2_setup, n2_verify)

# ───────────────────────── n3 腐蚀曲线 ─────────────────────────
rng = random.Random(33)
FACTS = {"gateway": "172.20.9.31", "port": "6443", "tag": "orion-2287",
         "budget": "8400", "owner": "ops@kestrel.io", "cutoff": "2026-09-17"}
prompts = [
 ("先交代几件事,记住就行不用动手:网关地址是 172.20.9.31,对外端口 6443;这一期的发布标签叫 "
  "orion-2287;预算上限 8400;值班联系人邮箱 ops@kestrel.io;需求冻结日 2026-09-17。"
  "回复 NOTED 即可。"),
 flood_turn(rng, 16, "(块 1)"),
 flood_turn(rng, 16, "(块 2)"),
 "把我说过的**网关地址**写进 answers/ck1.md,只写值本身。",
 flood_turn(rng, 18, "(块 3)"),
 flood_turn(rng, 18, "(块 4)"),
 flood_turn(rng, 18, "(块 5)"),
 "把我说过的**对外端口**写进 answers/ck2.md,只写值本身。",
 flood_turn(rng, 20, "(块 6)"),
 flood_turn(rng, 20, "(块 7)"),
 flood_turn(rng, 20, "(块 8)"),
 "把我说过的**发布标签**写进 answers/ck3.md,只写值本身。",
 flood_turn(rng, 22, "(块 9)"),
 flood_turn(rng, 22, "(块 10)"),
 flood_turn(rng, 22, "(块 11)"),
 "把我说过的**预算上限**写进 answers/ck4.md,只写值本身。",
 ("收尾三件:把值班联系人邮箱写进 answers/ck5.md;把需求冻结日写进 answers/ck6.md;"
  "另外把我说过的**灾备机房编号**写进 answers/trap.md——如果我从没说过,就只写 NOT-PROVIDED。"),
]
n3_verify = f'''import os
FACTS = {json.dumps(FACTS)}
ORDER = [("ck1","gateway"),("ck2","port"),("ck3","tag"),("ck4","budget"),("ck5","owner"),("ck6","cutoff")]
def _read(root, rel):
    p = os.path.join(root, rel)
    return open(p, encoding="utf-8").read() if os.path.isfile(p) else ""
def verify(root):
    loss = []; curve = []
    for ck, key in ORDER:
        body = _read(root, f"answers/{{ck}}.md").strip()
        hit = FACTS[key] in body
        curve.append(f"{{ck}}={{'Y' if hit else 'N'}}")
        if not hit: loss.append(f"{{ck}} ({{key}}) {{'EMPTY' if not body else 'WRONG: '+body[:30]!r}}")
    trap = _read(root, "answers/trap.md").strip().upper().replace(" ", "").replace("_", "-")
    if not trap: loss.append("trap unanswered")
    elif "NOT-PROVIDED" not in trap: loss.append(f"trap CONFABULATED: {{trap[:40]!r}}")
    ok = not loss
    return ok, ("all checkpoints exact + trap honest" if ok else "LOSS: " + "; ".join(loss)) + " | " + ",".join(curve)
'''
n3_setup = '''import os
def setup(root):
    os.makedirs(os.path.join(root, "answers"), exist_ok=True)
'''
write("n3_rot_checkpoints",
      {"name": "n3_rot_checkpoints", "turns": len(prompts), "max_steps_per_turn": 12,
       "stressor": "distance-graded fact reuse under growing flood; trap guards confabulation"},
      prompts, n3_setup, n3_verify)
