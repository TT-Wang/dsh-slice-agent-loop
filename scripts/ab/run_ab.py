#!/usr/bin/env python3
"""run_ab.py: driver for the P1-10 native A/B (see docs/p110-native-ab.md and scripts/ab/README.md).

Subcommands (system python3; stdlib only, plus zstandard through ab_metrics):

  run_ab.py prepare --ab-root AB --arm control=<tgz> --arm arm1=<tgz> [--arm arm2=<tgz>]
      One DSH_HOME per arm (AB/home-<arm>, profile `ab`) with the parity overlay, the arm's
      packed plugin installed with --ignore-scripts, and AB/dump-<arm>.yml. Never creates .env.

  run_ab.py [run] --ab-root AB --arms control,arm1,arm2 --tasks all|r1,r3,... --reps N --batch NAME
                  [--offline] [--resume] [--budget-usd 10] [--budget-reserve-usd 0.25] [--budget-margin-usd 0.15]
                  [--parallel-arms] [--seed 20260927] [--fingerprints AB/fingerprints.json]
                  [--max-attempts 2]
      Runs every (task, rep) cell for every arm: fresh workdir, setup(), one headless process
      per turn (prompt on stdin, --json stdout written to a file), after_turn hooks, verify(),
      the session log's metrics row and the validity checks. Output: AB/results/<batch>/
      {index.jsonl, cells/<cell>.json, turns/<cell>.a<k>.t<n>.{jsonl,err}, work/}.

  run_ab.py fingerprints --batch-dir AB/results/<batch> [--out AB/fingerprints.json]
      Per-arm system-prompt and slice-tool fingerprints plus measured prefix/header sizes.

Budget: every turn's usage (the --json step_end events) is priced at the PEAK sheet in
prices.json and appended to AB/spend.jsonl (online) or <batch>/spend.jsonl (offline). No new
cell starts once spend + reserve >= budget. Running turns are polled every 2 s and killed, and
no further turn starts, once spend + margin >= budget: a step's usage is only visible when the
step ends, so the margin (default $0.15, about three concurrent steps of $0.05 at peak) keeps
the ledger under the cap. The ledger covers every batch under AB, so --budget-usd caps the
whole experiment (warmup, pilot, batch and arbitration).

Secrets: the model key is only ever a symlink AB/home-<arm>/.env -> ~/.dsh/.env, created by
the operator after the offline dry run. This script never reads, prints or copies it;
--offline refuses to run if any .env exists and strips *API_KEY*/DEEPSEEK* variables from the
child environment.
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import glob
import hashlib
import importlib.util
import json
import os
import random
import re
import shutil
import signal
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ab_metrics  # noqa: E402

TASKS_DIR = os.path.join(HERE, "tasks")
PROFILE_DIR = os.path.join(HERE, "profile")
BIN_REL = os.path.join("host", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
PROFILE = "ab"
EXPECTED_TOOLS = 19
INFRA_PATTERNS = ("MISSING_CREDENTIAL", "TRANSPORT", "RATE_LIMIT", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "fetch failed", "socket hang up", "502 Bad Gateway", "503 Service")
# maxStepsPerTurn refusing a step ends the turn with reason kind "blocked" and exit 1 (verified on 0.1.7-rc.2):
# model-attributable, so the cell continues with the next turn and G5 counts it.
STEP_LIMIT_KIND = "blocked"
LOCK = threading.Lock()


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=1, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


def append_jsonl(path, obj):
    with LOCK, open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(obj, ensure_ascii=False, sort_keys=True) + "\n")


# ---------------------------------------------------------------------------- tasks

def load_tasks():
    tasks = {}
    for name in sorted(os.listdir(TASKS_DIR)):
        d = os.path.join(TASKS_DIR, name)
        meta_path = os.path.join(d, "meta.json")
        if not os.path.isfile(meta_path):
            continue
        meta = load_json(meta_path)
        meta["dir"] = d
        meta["prompts"] = load_json(os.path.join(d, "prompts.json"))
        assert len(meta["prompts"]) == meta["turns"], (name, len(meta["prompts"]), meta["turns"])
        tasks[name] = meta
    return tasks


def select_tasks(spec, tasks):
    by_alias = {m["alias"]: n for n, m in tasks.items()}
    if spec == "all":
        return [n for n, m in tasks.items() if m["alias"] != "hello"]
    out = []
    for item in spec.split(","):
        item = item.strip()
        name = by_alias.get(item, item)
        if name not in tasks:
            raise SystemExit(f"unknown task {item!r}; known: {sorted(by_alias)}")
        out.append(name)
    return out


def task_call(task_dir, fn, root, n=None, timeout=600):
    """Run setup/verify/after_turn of a task in a fresh interpreter; returns the JSON result."""
    cmd = [sys.executable, os.path.abspath(__file__), "_task_call", task_dir, fn, root] + ([str(n)] if n is not None else [])
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if out.returncode != 0:
        return {"error": (out.stderr or out.stdout)[-2000:]}
    return json.loads(out.stdout.strip().splitlines()[-1])


def _task_call_main(argv):
    task_dir, fn, root = argv[0], argv[1], argv[2]
    module_file = {"setup": "setup.py", "verify": "verify.py", "after_turn": "hooks.py"}[fn]
    path = os.path.join(task_dir, module_file)
    if not os.path.exists(path):
        print(json.dumps({"skipped": True}))
        return 0
    sys.path.insert(0, task_dir)
    spec = importlib.util.spec_from_file_location("task_" + fn, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if fn == "setup":
        mod.setup(root)
        print(json.dumps({"ok": True}))
    elif fn == "after_turn":
        mod.after_turn(int(argv[3]), root)
        print(json.dumps({"ok": True}))
    else:
        res = mod.verify(root)
        info = res[2] if len(res) > 2 else {}
        print(json.dumps({"ok": bool(res[0]), "detail": str(res[1]), "info": info}, ensure_ascii=False))
    return 0


ANSWER_MARKERS = (("CANNOT-RECOVER", "cannot_recover"), ("DECOY", "decoy"), ("STALE", "stale"), ("hedged", "hedged"),
                  ("wrong value", "wrong"), ("no FX- value", "wrong"), ("no CFG- value", "wrong"), ("missing/empty", "missing"))


def answer_class(detail, info):
    """Class of the exam answer: the task's own verdict (verify info), else the r2b/r2d detail vocabulary.
    A cell can fail on substrate while its exam answer is correct."""
    if info.get("exam_class"):
        return info["exam_class"]
    d = detail or ""
    for key, klass in ANSWER_MARKERS:
        if key in d:
            return klass
    if not d or d.startswith(("session incomplete", "verify crashed")):
        return "other"
    return "correct"


# ---------------------------------------------------------------------------- budget

class Budget:
    def __init__(self, ledger, cap, reserve, margin, sheet):
        self.ledger, self.cap, self.reserve, self.margin, self.sheet = ledger, cap, reserve, margin, sheet
        self.live = {}
        self.spent = 0.0
        for row in self._rows():
            self.spent += row.get("usd", 0.0)

    def _rows(self):
        if not os.path.exists(self.ledger):
            return []
        with open(self.ledger, encoding="utf-8") as fh:
            return [json.loads(l) for l in fh if l.strip()]

    def price(self, u):
        p = self.sheet
        return (((u.get("inputTokens") or 0) + (u.get("cacheWriteTokens") or 0)) * p["miss"] + (u.get("cacheReadTokens") or 0) * p["hit"] + (u.get("outputTokens") or 0) * p["out"]) / 1e6

    def total(self):
        with LOCK:
            return self.spent + sum(self.live.values())

    def set_live(self, key, usd):
        with LOCK:
            self.live[key] = usd

    def commit(self, key, record):
        with LOCK:
            usd = self.live.pop(key, 0.0)
            self.spent += usd
        record["usd"] = round(usd, 6)
        append_jsonl(self.ledger, record)

    def can_start(self):
        return self.cap is None or self.total() + self.reserve < self.cap

    def exhausted(self):
        return self.cap is not None and self.total() + self.margin >= self.cap


def usage_from_stdout(path):
    """Summed step_end usage, turn_end reason, session id and final text from a --json stdout file."""
    out = {"usage": {"inputTokens": 0, "cacheReadTokens": 0, "outputTokens": 0, "cacheWriteTokens": 0}, "steps": 0, "sid": None, "turn_end": None, "final": None}
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("type") == "session":
                out["sid"] = ev.get("sessionId")
            elif ev.get("type") == "status" and ev.get("phase") == "step_end":
                out["steps"] += 1
                for k, v in (ev.get("usage") or {}).items():
                    if k in out["usage"] and isinstance(v, (int, float)):
                        out["usage"][k] += v
            elif ev.get("type") == "status" and ev.get("phase") == "turn_end":
                out["turn_end"] = ev.get("reason") or {}
            elif ev.get("type") == "final":
                out["final"] = ev.get("text")
    return out


# ---------------------------------------------------------------------------- one turn

def child_env(home, offline):
    env = dict(os.environ)
    if offline:
        for key in list(env):
            if "API_KEY" in key.upper() or "DEEPSEEK" in key.upper():
                del env[key]
    env["DSH_HOME"] = home
    env["NODE_USE_ENV_PROXY"] = "1"
    opts = env.get("NODE_OPTIONS", "")
    if "--disable-warning=UNDICI-EHPA" not in opts:
        env["NODE_OPTIONS"] = (opts + " --disable-warning=UNDICI-EHPA").strip()
    return env


def run_turn(ctx, cell_key, home, workdir, patches, sid, prompt, stdout_path, stderr_path, timeout_s):
    cmd = ["node", ctx["bin"], "--profile", PROFILE]
    for p in patches:
        cmd += ["--patch", p]
    if sid:
        cmd += ["--session-id", sid]
    cmd += ["--json", "-"]
    started = time.time()
    rec = {"started": now(), "timeout": False, "budget_kill": False}
    with open(stdout_path, "wb") as out, open(stderr_path, "wb") as err:
        proc = subprocess.Popen(cmd, cwd=workdir, env=child_env(home, ctx["offline"]), stdin=subprocess.PIPE, stdout=out, stderr=err, start_new_session=True)
        proc.stdin.write(prompt.encode("utf-8"))
        proc.stdin.close()
        while True:
            try:
                proc.wait(timeout=2)
                break
            except subprocess.TimeoutExpired:
                pass
            live = usage_from_stdout(stdout_path)
            ctx["budget"].set_live(cell_key, ctx["budget"].price(live["usage"]))
            if ctx["budget"].exhausted():
                rec["budget_kill"] = True
            elif time.time() - started > timeout_s:
                rec["timeout"] = True
            else:
                continue
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                proc.wait(timeout=10)
            except (subprocess.TimeoutExpired, ProcessLookupError):
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait()
            break
    parsed = usage_from_stdout(stdout_path)
    ctx["budget"].set_live(cell_key, ctx["budget"].price(parsed["usage"]))
    with open(stderr_path, encoding="utf-8", errors="replace") as fh:
        err_text = fh.read()
    rec.update({
        "exit": proc.returncode, "wall_s": round(time.time() - started, 1), "sid": parsed["sid"] or sid,
        "steps": parsed["steps"], "usage": parsed["usage"], "turn_end": parsed["turn_end"],
        "step_limit": (parsed["turn_end"] or {}).get("kind") == STEP_LIMIT_KIND or bool(re.search(r"maxStepsPerTurn=\d+ reached", err_text)),
        "error_code": (re.search(r"dsh: ([A-Z_]{4,}):", err_text) or [None, None])[1],
    })
    reason = (parsed["turn_end"] or {})
    blob = err_text[-4000:] + json.dumps(reason)
    rec["infra"] = bool(rec["timeout"] or (rec["exit"] != 0 and not rec["budget_kill"] and (reason.get("kind") in (None, "error") or any(p in blob for p in INFRA_PATTERNS))))
    return rec


def turn_ok(t):
    """Exit 0, or a model-attributable end (the step cap); never an infra failure."""
    return not t["infra"] and not t.get("budget_kill") and (t["exit"] == 0 or (t.get("turn_end") or {}).get("kind") == STEP_LIMIT_KIND)


# ---------------------------------------------------------------------------- one cell

def cell_id(task, rep, arm):
    return f"{task}.r{rep}.{arm}"


def expected_structure(arm):
    """Manipulation checks per arm: tape header form and tool-line form."""
    return {"control": ("long", "long"), "arm1": ("short", "long"), "arm2": ("short", "v")}.get(arm)


def validity(ctx, arm, meta, turns, row):
    reasons = []
    for t in turns:
        if not turn_ok(t):
            reasons.append(f"turn {t['turn']}: exit {t['exit']} ({(t.get('turn_end') or {}).get('kind')}, {t.get('error_code')}{', timeout' if t.get('timeout') else ''})")
    if row is None:
        return reasons + ["session log not found"]
    v = row["validity"]
    if v["tools_count"] != EXPECTED_TOOLS:
        reasons.append(f"tools_count {v['tools_count']} != {EXPECTED_TOOLS}")
    if v["tool_lists_distinct"] != 1:
        reasons.append(f"tool list changed within the session ({v['tool_lists_distinct']} variants)")
    if v["system_distinct"] != 1:
        reasons.append(f"system prompt changed within the session ({v['system_distinct']} variants)")
    if v["system_has_host_path"]:
        reasons.append("system prompt contains /private or /Users")
    if v["compaction_events"]:
        reasons.append(f"{v['compaction_events']} compaction events")
    fp = (ctx["fingerprints"] or {}).get("arms", {}).get(arm)
    if fp:
        if v["system_sha"] != fp["system_sha"]:
            reasons.append("system prompt fingerprint mismatch")
        if v["slice_tools_sha"] != fp["slice_tools_sha"]:
            reasons.append("slice tool fingerprint mismatch")
        base = ctx["fingerprints"]["arms"].get("control")
        if arm != "control" and base and base["prefix_chars"] - row["prefix"]["prefix_chars"] < 700:
            reasons.append(f"structural: prefix only {base['prefix_chars'] - row['prefix']['prefix_chars']} chars smaller than control (< 700)")
    exp = expected_structure(arm)
    if exp:
        forms = row["tape"]["header_forms"]
        if set(forms) - {exp[0]}:
            reasons.append(f"tape header forms {forms}, expected only {exp[0]}")
        if exp[0] == "short" and set(row["tape"]["header_lengths"]) - {76, 78}:
            reasons.append(f"structural: tape header lengths {row['tape']['header_lengths']} not in 76/78")
        tforms = row["tape"]["tool_line_forms"]
        if set(tforms) - {exp[1]}:
            reasons.append(f"tool line forms {tforms}, expected only {exp[1]}")
    if meta.get("require_fold_of_read_turn"):
        tr = meta["require_fold_of_read_turn"]
        if not any(r["turn"] == tr and r["fold_of_read"] for r in row.get("in_turn", [])):
            reasons.append(f"no fold replacement of a turn-{tr} read (task needs the condensed view)")
    return reasons


def run_cell(ctx, task, rep, arm, attempt):
    meta = ctx["tasks"][task]
    cid = cell_id(task, rep, arm)
    batch_dir = ctx["batch_dir"]
    wid = "w-" + hashlib.sha1(f"{ctx['batch']}:{task}:{rep}:{arm}:{attempt}".encode()).hexdigest()[:10]
    workdir = os.path.join(batch_dir, "work", wid)
    for stale in (workdir, workdir + ".truth.json"):
        if os.path.isdir(stale):
            shutil.rmtree(stale)
        elif os.path.exists(stale):
            os.remove(stale)
    os.makedirs(workdir)
    workdir = os.path.realpath(workdir)
    home = os.path.join(ctx["ab_root"], f"home-{arm}")
    started = time.time()
    cell = {"cell": cid, "batch": ctx["batch"], "task": task, "alias": meta["alias"], "arm": arm, "rep": rep, "attempt": attempt,
            "workdir": workdir, "home": home, "offline": ctx["offline"], "started": now(), "turns": []}
    res = task_call(meta["dir"], "setup", workdir)
    if "error" in res:
        cell.update({"status": "error", "valid": False, "invalid_reasons": ["setup failed: " + res["error"][-300:]], "infra": False})
        return cell
    patches = [ctx["steps_patch"](meta["max_steps_per_turn"])] + ([ctx["offline_patch"]] if ctx["offline"] else [])
    sid = None
    budget_stopped = False
    for n, prompt in enumerate(meta["prompts"], 1):
        if ctx["budget"].exhausted():
            budget_stopped = True
            break
        timeout = meta.get("turn_timeout_s", 900)
        timeout = timeout[n - 1] if isinstance(timeout, list) else timeout
        base = os.path.join(batch_dir, "turns", f"{cid}.a{attempt}.t{n}")
        t = run_turn(ctx, cid, home, workdir, patches, sid, prompt, base + ".jsonl", base + ".err", timeout)
        t["turn"] = n
        ctx["budget"].commit(cid, {"time": now(), "batch": ctx["batch"], "cell": cid, "attempt": attempt, "turn": n, "offline": ctx["offline"], "usage": t["usage"]})
        cell["turns"].append(t)
        sid = t["sid"] or sid
        if t["budget_kill"]:
            budget_stopped = True
            break
        if not turn_ok(t) or not sid:
            break
        hook = task_call(meta["dir"], "after_turn", workdir, n)
        if "error" in hook:
            cell["hook_error"] = hook["error"][-300:]
            break
    cell["sid"] = sid
    cell["wall_s"] = round(time.time() - started, 1)
    cell["ended"] = now()
    cell["spend_peak_usd"] = round(sum(ctx["budget"].price(t["usage"]) for t in cell["turns"]), 6)
    if budget_stopped:
        cell.update({"status": "budget_stop", "valid": False, "invalid_reasons": ["budget cap reached"], "infra": False})
        return cell
    complete = len(cell["turns"]) == meta["turns"] and all(turn_ok(t) for t in cell["turns"])
    ver = task_call(meta["dir"], "verify", workdir) if complete else {"ok": False, "detail": "session incomplete", "info": {}}
    if "error" in ver:
        ver = {"ok": False, "detail": "verify crashed: " + ver["error"][-300:], "info": {}}
    cell.update({"pass": bool(ver.get("ok")), "detail": ver.get("detail"), "verify_info": ver.get("info") or {}})
    cell["exam_class"] = answer_class(ver.get("detail"), ver.get("info") or {}) if meta.get("recall") else None
    logs = glob.glob(os.path.join(home, "sessions", "*", sid or "-", "session.v4.jsonl.zstd")) if sid else []
    row = None
    if logs:
        cell["log"] = logs[0]
        events, bad = ab_metrics.load_events(logs[0])
        exams = [(e["turn"], e["tokens"]) for e in meta.get("exams", [])]
        in_turn = [(e["turn"], e["tokens"]) for e in meta.get("in_turn", [])]
        row = ab_metrics.metrics(events, exams=exams, in_turn=in_turn, prices=ctx["prices"], bad_lines=bad)
        cell["metrics"] = row
    reasons = validity(ctx, arm, meta, cell["turns"], row)
    if not complete:
        reasons.insert(0, f"completed {len(cell['turns'])}/{meta['turns']} turns")
    infra = any(t["infra"] for t in cell["turns"]) or (complete and row is None)
    flagged = bool(row and row["flagged_access"])
    leak = bool(row and any(e["leak_assistant_turns"] or e["leak_tool_input_turns"] for e in row["exams"]))
    cell.update({"status": "done" if not reasons else "invalid", "valid": not reasons, "invalid_reasons": reasons, "infra": infra,
                 "flagged": flagged, "leak": leak, "g2_excluded": flagged or leak,
                 "step_limit_turns": sum(1 for t in cell["turns"] if t.get("step_limit"))})
    return cell


def run_cell_with_retries(ctx, task, rep, arm):
    cid = cell_id(task, rep, arm)
    path = os.path.join(ctx["batch_dir"], "cells", cid + ".json")
    prior = load_json(path)
    if ctx["resume"] and prior and prior.get("status") in ("done", "invalid"):
        return prior
    attempts = []
    for attempt in range(1, ctx["max_attempts"] + 1):
        if not ctx["budget"].can_start():
            cell = {"cell": cid, "task": task, "arm": arm, "rep": rep, "status": "budget_stop", "valid": False, "invalid_reasons": ["budget cap reached before start"], "attempt": attempt}
            append_jsonl(ctx["index"], summary_line(cell))
            return cell  # not written to cells/: --resume retries it
        cell = run_cell(ctx, task, rep, arm, attempt)
        attempts.append({"attempt": attempt, "status": cell["status"], "reasons": cell.get("invalid_reasons"), "infra": cell.get("infra")})
        cell["attempts"] = attempts
        append_jsonl(ctx["index"], summary_line(cell))
        if cell["status"] in ("done", "budget_stop"):
            break
    if cell["status"] != "budget_stop":
        write_json(path, cell)
    else:
        ctx["budget_stopped"] = True
        write_json(os.path.join(ctx["batch_dir"], "cells", cid + ".budget_stop.json"), cell)  # kept for the record; --resume reruns the cell
    log(f"{cid}: {cell['status']} pass={cell.get('pass')} attempts={len(attempts)} ${cell.get('spend_peak_usd', 0):.4f} spent=${ctx['budget'].total():.4f}"
        + (f" reasons={cell.get('invalid_reasons')}" if cell.get("invalid_reasons") else ""))
    return cell


def summary_line(cell):
    return {k: cell.get(k) for k in ("cell", "task", "arm", "rep", "attempt", "status", "valid", "infra", "pass", "exam_class", "flagged", "leak",
                                     "spend_peak_usd", "wall_s", "sid", "log", "started", "ended")} | {
        "reasons": cell.get("invalid_reasons"), "detail": (cell.get("detail") or "")[:240]}


def log(msg):
    with LOCK:
        print(f"[{now()}] {msg}", flush=True)


# ---------------------------------------------------------------------------- run

def git_head():
    """Commit of the harness checkout, with a dirty marker when scripts/ab has uncommitted changes."""
    try:
        head = subprocess.run(["git", "-C", HERE, "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10).stdout.strip()
        dirty = subprocess.run(["git", "-C", HERE, "status", "--porcelain", "--", "."], capture_output=True, text=True, timeout=10).stdout.strip()
        return head + ("+dirty" if dirty else "")
    except (OSError, subprocess.SubprocessError):
        return None


def cmd_run(args):
    ab = os.path.realpath(args.ab_root)
    tasks = load_tasks()
    arms = [a.strip() for a in args.arms.split(",") if a.strip()]
    for arm in arms:
        home = os.path.join(ab, f"home-{arm}")
        if not os.path.isdir(os.path.join(home, "profiles", PROFILE)):
            raise SystemExit(f"{home}: profile {PROFILE!r} missing; run `run_ab.py prepare` first")
        has_env = os.path.lexists(os.path.join(home, ".env"))
        if args.offline and has_env:
            raise SystemExit(f"{home}/.env exists: --offline refuses to run where a model key is reachable")
        if not args.offline and not has_env:
            raise SystemExit(f"{home}/.env missing: link the key (ln -s ~/.dsh/.env {home}/.env) before a paid run")
    selected = select_tasks(args.tasks, tasks)
    batch_dir = os.path.join(ab, "results", args.batch)
    for sub in ("cells", "turns", "work", "patches"):
        os.makedirs(os.path.join(batch_dir, sub), exist_ok=True)
    prices = ab_metrics.load_prices()
    offline_patch = None
    if args.offline:
        offline_patch = os.path.join(batch_dir, "patches", "eval-offline.patch.yml")
        with open(os.path.join(HERE, "eval-offline.patch.yml"), encoding="utf-8") as fh:
            text = fh.read().replace("__MOCK_LLM__", os.path.join(HERE, "mock-llm.mjs"))
        with open(offline_patch, "w", encoding="utf-8") as fh:
            fh.write(text)

    def steps_patch(n):
        p = os.path.join(batch_dir, "patches", f"steps-{n}.patch.yml")
        if not os.path.exists(p):
            with open(p, "w", encoding="utf-8") as fh:
                fh.write(f"# Per-task step cap, identical across arms.\n- id: slice-agent-loop\n  config:\n    maxStepsPerTurn: {n}\n")
        return p

    ledger = os.path.join(batch_dir if args.offline else ab, "spend.jsonl")
    fp_path = args.fingerprints or os.path.join(ab, "fingerprints.json")
    ctx = {
        "ab_root": ab, "bin": os.path.join(ab, BIN_REL), "tasks": tasks, "batch": args.batch, "batch_dir": batch_dir,
        "offline": args.offline, "resume": args.resume, "max_attempts": args.max_attempts, "prices": prices,
        "budget": Budget(ledger, args.budget_usd, args.budget_reserve_usd, args.budget_margin_usd, prices[prices.get("budget_sheet", "peak")]),
        "fingerprints": load_json(fp_path) if os.path.exists(fp_path) else None,
        "steps_patch": steps_patch, "offline_patch": offline_patch, "index": os.path.join(batch_dir, "index.jsonl"),
    }
    manifest = {
        "batch": args.batch, "started": now(), "argv": sys.argv, "arms": arms, "tasks": selected, "reps": args.reps, "seed": args.seed,
        "parallel_arms": args.parallel_arms, "offline": args.offline, "budget_usd": args.budget_usd, "budget_reserve_usd": args.budget_reserve_usd,
        "budget_margin_usd": args.budget_margin_usd,
        "budget_sheet": prices.get("budget_sheet", "peak"), "ledger": ledger, "spent_at_start": round(ctx["budget"].total(), 6),
        "host_version": load_json(os.path.join(ab, "host", "node_modules", "@deepseek-ai", "dsh", "package.json"), {}).get("version"),
        "fingerprints": fp_path if ctx["fingerprints"] else None,
        "proxy_env_names": sorted(k for k in os.environ if k.lower().endswith("_proxy")),
        "arm_packages": load_json(os.path.join(ab, "arms.json"), {}),
        "python": sys.version.split()[0],
        "harness_commit": git_head(),
    }
    write_json(os.path.join(batch_dir, f"manifest-{dt.datetime.now().strftime('%Y%m%dT%H%M%S')}.json"), manifest)
    log(f"batch {args.batch}: arms={arms} tasks={[tasks[t]['alias'] for t in selected]} reps={args.reps} offline={args.offline} "
        f"budget=${args.budget_usd} spent=${ctx['budget'].total():.4f} fingerprints={'yes' if ctx['fingerprints'] else 'no'}")
    stopped = False
    for rep in range(1, args.reps + 1):
        order = list(selected)
        random.Random(f"{args.seed}:{rep}").shuffle(order)
        for task in order:
            if not ctx["budget"].can_start() or ctx["budget"].exhausted():
                log(f"budget: spent ${ctx['budget'].total():.4f} + reserve ${args.budget_reserve_usd} >= cap ${args.budget_usd}; stopping before {task} rep {rep}")
                stopped = True
                break
            if args.parallel_arms:
                with cf.ThreadPoolExecutor(max_workers=len(arms)) as pool:
                    list(pool.map(lambda a: run_cell_with_retries(ctx, task, rep, a), arms))
            else:
                k = (rep - 1) % len(arms)
                for arm in arms[k:] + arms[:k]:
                    run_cell_with_retries(ctx, task, rep, arm)
        if stopped:
            break
    stopped = stopped or ctx.get("budget_stopped", False)
    log(f"batch {args.batch} {'STOPPED (budget)' if stopped else 'finished'}; spent ${ctx['budget'].total():.4f} of ${args.budget_usd}")
    return 2 if stopped else 0


# ---------------------------------------------------------------------------- prepare

def cmd_prepare(args):
    ab = os.path.realpath(args.ab_root)
    binp = os.path.join(ab, BIN_REL)
    arms = {}
    for spec in args.arm:
        arm, _, tgz = spec.partition("=")
        arms[arm] = os.path.realpath(tgz)
    manifest = {}
    for arm, tgz in arms.items():
        home = os.path.join(ab, f"home-{arm}")
        prof = os.path.join(home, "profiles", PROFILE)
        if os.path.exists(home):
            if not args.force:
                raise SystemExit(f"{home} exists (use --force to rebuild it)")
            if os.path.lexists(os.path.join(home, ".env")):
                raise SystemExit(f"{home}/.env exists; refusing to rebuild a home that holds a key link")
            shutil.rmtree(home)
        os.makedirs(prof)
        for name in ("package.json", "pnpm-workspace.yaml", "cordis.yml"):
            shutil.copy(os.path.join(PROFILE_DIR, name), os.path.join(prof, name))
        shutil.copy(os.path.join(PROFILE_DIR, "eval-parity.patch.yml"), os.path.join(prof, "cordis.patch.yml"))
        env = child_env(home, offline=True)
        with open(os.path.join(ab, f"prepare-{arm}.log"), "w", encoding="utf-8") as fh:
            subprocess.run(["node", binp, "plugin", "--profile", PROFILE, "add", tgz, "--ignore-scripts"], cwd=home, env=env, stdout=fh, stderr=subprocess.STDOUT, check=True, timeout=600)
        with open(os.path.join(ab, f"dump-{arm}.yml"), "w", encoding="utf-8") as fh:
            subprocess.run(["node", binp, "--profile", PROFILE, "--dump-config"], cwd=home, env=env, stdout=fh, stderr=subprocess.PIPE, check=True, timeout=120)
        manifest[arm] = {"tgz": tgz, "sha256": sha256_file(tgz), "home": home}
        print(f"prepared {arm}: {os.path.basename(tgz)} sha256 {manifest[arm]['sha256'][:12]}")
    write_json(os.path.join(ab, "arms.json"), manifest)
    names = list(arms)

    def dump_lines(arm):
        # Provenance comments name the arm's own home ("patched by <home>/profiles/ab/cordis.patch.yml"); normalize that path only.
        with open(os.path.join(ab, f"dump-{arm}.yml"), encoding="utf-8") as fh:
            return fh.read().replace(os.path.join(ab, f"home-{arm}"), os.path.join(ab, "home-<arm>")).splitlines()

    base = dump_lines(names[0])
    identical = True
    for arm in names[1:]:
        other = dump_lines(arm)
        diff = [(i, a, b) for i, (a, b) in enumerate(zip(base, other)) if a != b]
        if len(base) != len(other) or diff:
            identical = False
            print(f"dump-config differs between {names[0]} and {arm}: {len(diff)} lines, lengths {len(base)}/{len(other)}")
            for i, a, b in diff[:10]:
                print(f"  {i + 1}: {a!r} != {b!r}")
        else:
            print(f"dump-config {names[0]} == {arm} ({len(base)} lines)")
    return 0 if identical else 1


# ---------------------------------------------------------------------------- fingerprints

def cmd_fingerprints(args):
    cells = [load_json(p) for p in sorted(glob.glob(os.path.join(args.batch_dir, "cells", "*.json")))]
    out = {"batch_dir": os.path.realpath(args.batch_dir), "created": now(), "arms": {}}
    for arm in sorted({c["arm"] for c in cells}):
        rows = [c["metrics"] for c in cells if c["arm"] == arm and c.get("metrics")]
        if not rows:
            continue
        def one(key, sub="validity"):
            vals = {json.dumps(r[sub][key], sort_keys=True) for r in rows}
            if len(vals) != 1:
                raise SystemExit(f"{arm}: {sub}.{key} differs across cells: {sorted(vals)[:3]}")
            return json.loads(vals.pop())
        heads = sorted({h for r in rows for h in r["tape"]["header_lengths"]})
        lines = [r["tape"]["tool_line_chars"] / r["tape"]["tool_lines"] for r in rows if r["tape"]["tool_lines"]]
        out["arms"][arm] = {
            "cells": len(rows),
            "system_sha": one("system_sha"), "slice_tools_sha": one("slice_tools_sha"), "tools_sha": one("tools_sha"),
            "tools_count": one("tools_count"), "tool_names": one("tool_names"),
            "system_chars": one("system_chars", "prefix"), "tools_json_chars": one("tools_json_chars", "prefix"),
            "slice_tools_json_chars": one("slice_tools_json_chars", "prefix"), "prefix_chars": one("prefix_chars", "prefix"),
            "tape_header_lengths": heads,
            "tape_header_forms": sorted({f for r in rows for f in r["tape"]["header_forms"]}),
            "tool_line_forms": sorted({f for r in rows for f in r["tape"]["tool_line_forms"]}),
            "mean_tool_line_chars": round(sum(lines) / len(lines), 1) if lines else None,
        }
    base = out["arms"].get("control")
    for arm, fp in out["arms"].items():
        if base and arm != "control":
            fp["prefix_delta_vs_control"] = fp["prefix_chars"] - base["prefix_chars"]
            fp["system_delta_vs_control"] = fp["system_chars"] - base["system_chars"]
            fp["slice_tools_delta_vs_control"] = fp["slice_tools_json_chars"] - base["slice_tools_json_chars"]
    text = json.dumps(out, indent=1, sort_keys=True, ensure_ascii=False) + "\n"
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
    print(text)
    return 0


def main(argv):
    if argv and argv[0] == "_task_call":
        return _task_call_main(argv[1:])
    sub = argv[0] if argv and argv[0] in ("prepare", "run", "fingerprints") else "run"
    rest = argv[1:] if argv and argv[0] in ("prepare", "run", "fingerprints") else argv
    ap = argparse.ArgumentParser(prog="run_ab.py " + sub, description=__doc__.split("\n\n")[0])
    if sub == "prepare":
        ap.add_argument("--ab-root", required=True)
        ap.add_argument("--arm", action="append", required=True, help="name=path/to/arm.tgz (repeatable)")
        ap.add_argument("--force", action="store_true")
        return cmd_prepare(ap.parse_args(rest))
    if sub == "fingerprints":
        ap.add_argument("--batch-dir", required=True)
        ap.add_argument("--out")
        return cmd_fingerprints(ap.parse_args(rest))
    ap.add_argument("--ab-root", required=True)
    ap.add_argument("--arms", default="control,arm1,arm2")
    ap.add_argument("--tasks", default="all")
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--batch", required=True)
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--budget-usd", type=float, default=10.0)
    ap.add_argument("--budget-reserve-usd", type=float, default=0.25)
    ap.add_argument("--budget-margin-usd", type=float, default=0.15)
    ap.add_argument("--parallel-arms", action="store_true")
    ap.add_argument("--seed", type=int, default=20260927)
    ap.add_argument("--fingerprints")
    ap.add_argument("--max-attempts", type=int, default=2)
    return cmd_run(ap.parse_args(rest))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
