#!/usr/bin/env python3
"""run_ab.py: driver for the P1-10 native A/B (see docs/p110-native-ab.md and scripts/ab/README.md).

Subcommands (system python3; stdlib only, plus zstandard through ab_metrics):

  run_ab.py prepare --ab-root AB --arm control=<tgz> --arm arm1=<tgz> [--arm arm2=<tgz>]
      One DSH_HOME per arm (AB/home-<arm>, profile `ab`) with the parity overlay, the arm's
      packed plugin installed with --ignore-scripts, and AB/dump-<arm>.yml. Never creates .env.

  run_ab.py [run] --ab-root AB --arms control,arm1,arm2 --tasks all|r1,r3,... --reps N --batch NAME
                  [--offline] [--resume] [--budget-usd 10] [--budget-reserve-usd 0.75] [--budget-margin-usd 0.6]
                  [--unpriced-step-usd 0.05] [--max-unpriced-steps 40]
                  [--parallel-arms] [--seed 20260927] [--fingerprints AB/fingerprints.json|none]
                  [--max-attempts 2]
      Runs every (task, rep) cell for every arm: fresh workdir, setup(), one headless process
      per turn (prompt on stdin, --json stdout written to a file), after_turn hooks, verify(),
      the session log's metrics row and the validity checks; then the workdir is packed away
      and removed. Output: AB/results/<batch>/{index.jsonl, cells/<cell>.json,
      turns/<cell>.a<k>.t<n>.{jsonl.gz,err}, workdirs/<wid>.tgz}.

  run_ab.py fingerprints --batch-dir AB/results/<batch> [--out AB/fingerprints.json] [--compare OLD.json]
      Per-arm system-prompt and slice-tool fingerprints plus measured prefix/header sizes.
      --compare exits 1 unless the control-vs-arm deltas equal those of OLD.json.

  run_ab.py secrets-scan --ab-root AB
      Lists every cell with a tool call that referenced .env, DSH_HOME or ~/.dsh (they could have
      reached the model key). Those cells' logs and turn files are held back from the archive until
      the owner has looked. Never reads the key or greps for it. Exit 1 when any exist.

Budget: every turn is priced at the PEAK sheet in prices.json and appended to AB/spend.jsonl
(online) or <batch>/spend.jsonl (offline). A turn's charge is the larger of two figures:
(a) its --json stdout: the usage of each step_end, plus --unpriced-step-usd for every step_end
    without usage (the headless projector drops a whole step's usage when any attempt of it
    reported no sample, typically a transport or 429 retry) and for a step still open when the
    process ended (killed or crashed mid-request);
(b) its session log: the usage of every assistant/message and assistant/attempt of the turn, plus
    --unpriced-step-usd for every such record without a sample.
No new cell starts once spend + reserve >= budget. Running turns are polled every second and
killed, and no further turn starts, once spend + margin >= budget, where a running turn counts its
priced steps plus the unpriced charge for its open step. Invariant (why the cap holds): a step's
usage is known only when it ends, so between two polls every concurrent turn can finish at most one
step beyond what was counted; the margin must be at least 2 x (concurrent turns) x (worst-case
step cost). Default: 3 arms x 2 x $0.10 (a 150K-token all-miss request with 30K output at peak is
about $0.11) = $0.60. The run also stops cleanly once more than --max-unpriced-steps unpriced
steps have been charged (a retry storm). The ledger covers every batch under AB, so
--budget-usd caps the whole experiment (warmup, pilot, batch and arbitration).

Secrets: the model key is only ever a symlink AB/home-<arm>/.env -> ~/.dsh/.env, created by
the operator after the offline dry run. This script never reads, prints or copies it;
--offline refuses to run if any .env exists and strips *API_KEY*/DEEPSEEK* variables from the
child environment.
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import glob
import gzip
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
import tarfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ab_metrics  # noqa: E402

TASKS_DIR = os.path.join(HERE, "tasks")
PROFILE_DIR = os.path.join(HERE, "profile")
BIN_REL = os.path.join("host", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
PROFILE = "ab"
# The parity overlay leaves 16 tools (19 before tool-goal was disabled; see docs/p110-native-ab.md §3).
EXPECTED_TOOLS = 16
# Infra: provider, network, credential or quota failures (error codes of @deepseek-ai/dsh-llm and the
# DeepSeek adapter), a missing turn_end, and the harness's own timeout. Anything else that ends a turn
# is model-attributable: the turn counts as ended and the cell continues (like the step cap).
INFRA_CODES = {"TRANSPORT", "RATE_LIMIT", "SERVER", "TIMEOUT", "EMPTY_RESPONSE", "MISSING_CREDENTIAL", "INVALID_CREDENTIAL",
               "AUTH", "QUOTA", "ACCOUNT_QUOTA", "NO_ADAPTER", "ABORTED"}
INFRA_PATTERNS = ("MISSING_CREDENTIAL", "TRANSPORT", "RATE_LIMIT", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "fetch failed", "socket hang up",
                  "502 Bad Gateway", "503 Service", "504 Gateway", "ENOTFOUND", "EAI_AGAIN")
# maxStepsPerTurn refusing a step ends the turn with reason kind "blocked" and exit 1 (verified on 0.1.7-rc.2).
STEP_LIMIT_KIND = "blocked"
MODEL_END_KINDS = {STEP_LIMIT_KIND, "error", "max-tokens"}
# DSH_* variables the harness sets; every other inherited DSH_* variable is removed from the child.
DSH_ENV_SET = {"DSH_HOME": None, "DSH_TELEMETRY_DISABLED": "1"}
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


def read_jsonl(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as fh:
        return [json.loads(l) for l in fh if l.strip()]


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


def answer_class(ok, detail, info):
    """Class of the exam answer: the task's own verdict (verify info), else the r2b/r2d detail vocabulary.

    A passing verify is always "correct". Otherwise only the verdict part of the detail is scanned: r1/r2
    append the model's own how.md text after " | how:", which must never decide the class."""
    if info.get("exam_class"):
        return info["exam_class"]
    if ok:
        return "correct"
    d = (detail or "").split(" | how:", 1)[0]
    for key, klass in ANSWER_MARKERS:
        if key in d:
            return klass
    if not d or d.startswith(("session incomplete", "verify crashed")):
        return "other"
    return "correct"


# ---------------------------------------------------------------------------- budget

class Budget:
    def __init__(self, ledger, cap, reserve, margin, sheet, unpriced_usd=0.05, max_unpriced=40):
        self.ledger, self.cap, self.reserve, self.margin, self.sheet = ledger, cap, reserve, margin, sheet
        self.unpriced_usd, self.max_unpriced = unpriced_usd, max_unpriced
        self.live = {}
        self.live_unpriced = {}
        self.spent = 0.0
        self.unpriced = 0
        for row in read_jsonl(self.ledger):
            self.spent += row.get("usd", 0.0)
            self.unpriced += row.get("unpriced_charged", 0)

    def price(self, u):
        p = self.sheet
        return (((u.get("inputTokens") or 0) + (u.get("cacheWriteTokens") or 0)) * p["miss"] + (u.get("cacheReadTokens") or 0) * p["hit"] + (u.get("outputTokens") or 0) * p["out"]) / 1e6

    def price_parsed(self, parsed):
        """Charge of one turn's stdout: priced step_end usage plus the unpriced charge per usage-less or open step."""
        n = parsed["unpriced_steps"] + parsed["open_steps"]
        return self.price(parsed["usage"]) + n * self.unpriced_usd, n

    def total(self):
        with LOCK:
            return self.spent + sum(self.live.values())

    def unpriced_total(self):
        with LOCK:
            return self.unpriced + sum(self.live_unpriced.values())

    def set_live(self, key, usd, unpriced=0):
        with LOCK:
            self.live[key] = usd
            self.live_unpriced[key] = unpriced

    def commit(self, key, record, usd, unpriced):
        with LOCK:
            self.live.pop(key, None)
            self.live_unpriced.pop(key, None)
            self.spent += usd
            self.unpriced += unpriced
        record["usd"] = round(usd, 6)
        record["unpriced_charged"] = unpriced
        append_jsonl(self.ledger, record)

    def can_start(self):
        return self.cap is None or (self.total() + self.reserve < self.cap and not self.too_many_unpriced())

    def too_many_unpriced(self):
        return self.max_unpriced is not None and self.unpriced_total() > self.max_unpriced

    def exhausted(self):
        return self.too_many_unpriced() or (self.cap is not None and self.total() + self.margin >= self.cap)


def usage_from_stdout(path):
    """Summed step_end usage, unpriced and open steps, turn_end reason, turns, session id and final text
    from a --json stdout file (plain or .gz)."""
    out = {"usage": {"inputTokens": 0, "cacheReadTokens": 0, "outputTokens": 0, "cacheWriteTokens": 0}, "steps": 0, "unpriced_steps": 0,
           "open_steps": 0, "turns": [], "sid": None, "turn_end": None, "final": None}
    if not os.path.exists(path):
        return out
    opener = gzip.open if path.endswith(".gz") else open
    open_steps = set()
    with opener(path, "rt", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("type") == "session":
                out["sid"] = ev.get("sessionId")
            elif ev.get("type") == "status" and ev.get("phase") == "turn_start":
                out["turns"].append(ev.get("turn"))
            elif ev.get("type") == "status" and ev.get("phase") == "step_start":
                open_steps.add((ev.get("turn"), ev.get("step")))
            elif ev.get("type") == "status" and ev.get("phase") == "step_end":
                open_steps.discard((ev.get("turn"), ev.get("step")))
                out["steps"] += 1
                if not isinstance(ev.get("usage"), dict):
                    out["unpriced_steps"] += 1
                    continue
                for k, v in ev["usage"].items():
                    if k in out["usage"] and isinstance(v, (int, float)):
                        out["usage"][k] += v
            elif ev.get("type") == "status" and ev.get("phase") == "turn_end":
                out["turn_end"] = ev.get("reason") or {}
            elif ev.get("type") == "final":
                out["final"] = ev.get("text")
    out["open_steps"] = len(open_steps)
    return out


def find_log(home, sid):
    logs = glob.glob(os.path.join(home, "sessions", "*", sid, "session.v4.jsonl.zstd")) if sid else []
    return logs[0] if logs else None


def log_usage(home, sid, turns):
    """Billed usage of the given turns from the session log (messages and attempts), or None without a log."""
    path = find_log(home, sid)
    if not path or not turns:
        return None
    try:
        events, _ = ab_metrics.load_events(path)
    except Exception:  # a log that cannot be read yet is reconciled at the cell's end
        return None
    return ab_metrics.usage_totals(events, turns=set(turns))


# ---------------------------------------------------------------------------- one turn

def child_env(home, offline):
    env = dict(os.environ)
    if offline:
        for key in list(env):
            if "API_KEY" in key.upper() or "DEEPSEEK" in key.upper():
                del env[key]
    for key in list(env):
        if key.startswith("DSH_") and key not in DSH_ENV_SET:
            del env[key]  # e.g. DSH_PERMISSION_MODE or DSH_TOOLS_MODE would change the composition
    env["DSH_HOME"] = home
    for key, value in DSH_ENV_SET.items():
        if value is not None:
            env[key] = value  # mirrors the owner's login shell (DSH_TELEMETRY_DISABLED=1)
    env["NODE_USE_ENV_PROXY"] = "1"
    opts = env.get("NODE_OPTIONS", "")
    if "--disable-warning=UNDICI-EHPA" not in opts:
        env["NODE_OPTIONS"] = (opts + " --disable-warning=UNDICI-EHPA").strip()
    return env


def classify_end(rec, reason, err_text):
    """infra / model-attributable classification of one finished turn (see INFRA_CODES)."""
    code = ((reason or {}).get("error") or {}).get("code") or rec.get("error_code")
    blob = err_text[-4000:] + json.dumps(reason or {})
    if rec["timeout"]:
        return True
    if rec["exit"] == 0 or rec["budget_kill"]:
        return False
    if not reason:  # no turn_end: the process died before the turn ended
        return True
    if reason.get("kind") == "error":
        return str(code) in INFRA_CODES or str(code).startswith("HTTP_5") or any(p in blob for p in INFRA_PATTERNS)
    return reason.get("kind") not in MODEL_END_KINDS


def run_turn(ctx, cell_key, home, workdir, patches, sid, prompt, stdout_path, stderr_path, timeout_s):
    cmd = ["node", ctx["bin"], "--profile", PROFILE]
    for p in patches:
        cmd += ["--patch", p]
    if sid:
        cmd += ["--session-id", sid]
    cmd += ["--json", "-"]
    started = time.time()
    rec = {"started": now(), "timeout": False, "budget_kill": False}
    budget = ctx["budget"]
    with open(stdout_path, "wb") as out, open(stderr_path, "wb") as err:
        proc = subprocess.Popen(cmd, cwd=workdir, env=child_env(home, ctx["offline"]), stdin=subprocess.PIPE, stdout=out, stderr=err, start_new_session=True)
        proc.stdin.write(prompt.encode("utf-8"))
        proc.stdin.close()
        while True:
            try:
                proc.wait(timeout=ctx.get("poll_s", 1.0))
                break
            except subprocess.TimeoutExpired:
                pass
            live = usage_from_stdout(stdout_path)
            usd, n = budget.price_parsed(live)
            budget.set_live(cell_key, usd, n)
            if budget.exhausted():
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
    with open(stderr_path, encoding="utf-8", errors="replace") as fh:
        err_text = fh.read()
    rec.update({
        "exit": proc.returncode, "wall_s": round(time.time() - started, 1), "sid": parsed["sid"] or sid,
        "steps": parsed["steps"], "unpriced_steps": parsed["unpriced_steps"], "open_steps": parsed["open_steps"], "session_turns": parsed["turns"],
        "usage": parsed["usage"], "turn_end": parsed["turn_end"],
        "step_limit": (parsed["turn_end"] or {}).get("kind") == STEP_LIMIT_KIND or bool(re.search(r"maxStepsPerTurn=\d+ reached", err_text)),
        "error_code": ((parsed["turn_end"] or {}).get("error") or {}).get("code") or (re.search(r"dsh: ([A-Z_0-9]{4,}):", err_text) or [None, None])[1],
    })
    rec["infra"] = classify_end(rec, parsed["turn_end"], err_text)
    rec["model_error"] = bool(not rec["infra"] and (parsed["turn_end"] or {}).get("kind") in ("error", "max-tokens"))
    # Charge: the larger of the stdout figure and the session-log figure (messages + attempts of the turn).
    usd_out, n_out = budget.price_parsed(parsed)
    lu = log_usage(home, rec["sid"], parsed["turns"])
    usd_log, n_log = 0.0, 0
    if lu is not None:
        n_log = lu["unpriced"]
        usd_log = budget.price({"inputTokens": lu["miss"], "cacheReadTokens": lu["hit"], "outputTokens": lu["out"], "cacheWriteTokens": lu["cache_write"]}) + n_log * budget.unpriced_usd
        rec["log_usage"] = lu
    rec["charge"] = {"usd_stdout": round(usd_out, 6), "usd_log": round(usd_log, 6), "unpriced_stdout": n_out, "unpriced_log": n_log}
    rec["charge_usd"] = max(usd_out, usd_log)
    rec["charge_unpriced"] = n_out if usd_out >= usd_log else n_log
    return rec


def turn_ok(t):
    """Exit 0, or a model-attributable end (step cap, a non-infra error, max-tokens); never an infra failure or a kill."""
    return not t["infra"] and not t.get("budget_kill") and not t.get("timeout") and (t["exit"] == 0 or (t.get("turn_end") or {}).get("kind") in MODEL_END_KINDS)


# ---------------------------------------------------------------------------- one cell

def cell_id(task, rep, arm):
    return f"{task}.r{rep}.{arm}"


def expected_structure(arm):
    """Manipulation checks per arm: tape header form and tool-line form."""
    return {"control": ("long", "long"), "arm1": ("short", "long"), "arm2": ("short", "v")}.get(arm)


def validity(ctx, arm, meta, turns, row, complete=True):
    reasons = []
    for t in turns:
        if not turn_ok(t):
            reasons.append(f"turn {t['turn']}: exit {t['exit']} ({(t.get('turn_end') or {}).get('kind')}, {t.get('error_code')}{', timeout' if t.get('timeout') else ''})")
    if row is None:
        return reasons + ["session log not found"]
    v = row["validity"]
    fp_all = ctx["fingerprints"] or {}
    expected_tools = (fp_all.get("arms", {}).get(arm) or {}).get("tools_count", EXPECTED_TOOLS)
    if v["tools_count"] != expected_tools:
        reasons.append(f"tools_count {v['tools_count']} != {expected_tools}")
    if v["tool_lists_distinct"] != 1:
        reasons.append(f"tool list changed within the session ({v['tool_lists_distinct']} variants)")
    if v["system_distinct"] != 1:
        reasons.append(f"system prompt changed within the session ({v['system_distinct']} variants)")
    if v["system_has_host_path"]:
        reasons.append("system prompt contains /private or /Users")
    if v["compaction_events"]:
        reasons.append(f"{v['compaction_events']} compaction events")
    if complete and (v["user_prompts"] != meta["turns"] or v["turn_ends"] != meta["turns"] or v["goal_messages"]):
        reasons.append(f"turns do not match prompts: {v['user_prompts']} user prompts, {v['turn_ends']} turn ends, {v['goal_messages']} goal rounds for {meta['turns']} prompts")
    fp = fp_all.get("arms", {}).get(arm)
    if fp:
        if v["system_sha"] != fp["system_sha"]:
            reasons.append("system prompt fingerprint mismatch")
        if v["slice_tools_sha"] != fp["slice_tools_sha"]:
            reasons.append("slice tool fingerprint mismatch")
        base = fp_all["arms"].get("control")
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


def pack_away(batch_dir, wid, workdir, cid, attempt):
    """End of a cell, for any reason: pack the workdir into workdirs/<wid>.tgz and remove it together with
    its <workdir>.truth.json sidecar, then gzip the attempt's turn stdout files. No task source, answer or
    plain-text tool output of a finished or stopped attempt stays on disk for a later cell to find."""
    packed = os.path.join(batch_dir, "workdirs", wid + ".tgz")
    try:
        if os.path.isdir(workdir):
            with tarfile.open(packed, "w:gz") as tar:
                tar.add(workdir, arcname=wid)
            shutil.rmtree(workdir, ignore_errors=True)
        if os.path.exists(workdir + ".truth.json"):
            os.remove(workdir + ".truth.json")
    except OSError as exc:
        log(f"{cid}: could not pack away {workdir}: {exc}")
    for path in glob.glob(os.path.join(batch_dir, "turns", f"{cid}.a{attempt}.t*.jsonl")):
        with open(path, "rb") as src, gzip.open(path + ".gz", "wb") as dst:
            shutil.copyfileobj(src, dst)
        os.remove(path)


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
    try:
        return _run_cell(ctx, meta, task, rep, arm, attempt, cid, wid, workdir)
    finally:
        pack_away(batch_dir, wid, workdir, cid, attempt)


def _run_cell(ctx, meta, task, rep, arm, attempt, cid, wid, workdir):
    batch_dir = ctx["batch_dir"]
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
        ctx["budget"].commit(cid, {"time": now(), "batch": ctx["batch"], "cell": cid, "attempt": attempt, "turn": n, "offline": ctx["offline"],
                                   "usage": t["usage"], "charge": t["charge"], "log_usage": t.get("log_usage")}, t["charge_usd"], t["charge_unpriced"])
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
    cell["spend_peak_usd"] = round(sum(t["charge_usd"] for t in cell["turns"]), 6)
    cell["model_error_turns"] = [{"turn": t["turn"], "kind": (t.get("turn_end") or {}).get("kind"), "code": t.get("error_code")} for t in cell["turns"] if t.get("model_error")]
    if budget_stopped:
        why = "unpriced-step limit reached" if ctx["budget"].too_many_unpriced() else "budget cap reached"
        cell.update({"status": "budget_stop", "valid": False, "invalid_reasons": [why], "infra": False})
        return cell
    complete = len(cell["turns"]) == meta["turns"] and all(turn_ok(t) for t in cell["turns"])
    ver = task_call(meta["dir"], "verify", workdir) if complete else {"ok": False, "detail": "session incomplete", "info": {}}
    if "error" in ver:
        ver = {"ok": False, "detail": "verify crashed: " + ver["error"][-300:], "info": {}}
    cell.update({"pass": bool(ver.get("ok")), "detail": ver.get("detail"), "verify_info": ver.get("info") or {}})
    cell["exam_class"] = answer_class(bool(ver.get("ok")), ver.get("detail"), ver.get("info") or {}) if meta.get("recall") else None
    log_path = find_log(home, sid)
    row = None
    if log_path:
        cell["log"] = log_path
        events, bad = ab_metrics.load_events(log_path)
        row = ab_metrics.metrics(events, exams=meta.get("exams", []), in_turn=[(e["turn"], e["tokens"]) for e in meta.get("in_turn", [])],
                                 prices=ctx["prices"], bad_lines=bad)
        cell["metrics"] = row
    reasons = validity(ctx, arm, meta, cell["turns"], row, complete)
    if not complete:
        reasons.insert(0, f"completed {len(cell['turns'])}/{meta['turns']} turns")
    infra = any(t["infra"] for t in cell["turns"]) or (complete and row is None)
    exam_turn = max((e["turn"] for e in meta.get("exams", [])), default=None)
    flags = (row or {}).get("flagged_access") or []
    exams = (row or {}).get("exams") or []
    flagged = bool(exam_turn and any(f["turn"] is not None and f["turn"] <= exam_turn for f in flags))
    leak = any(e["leak_assistant_turns"] or e["leak_write_turns"] for e in exams)
    via_fs = any(e["oracle_via_fs"] for e in exams)
    cell.update({"status": "done" if not reasons else "invalid", "valid": not reasons, "invalid_reasons": reasons, "infra": infra,
                 "flagged": flagged, "flag_count": len(flags), "secret_flags": sum(1 for f in flags if f.get("secret")),
                 "leak": leak, "oracle_via_fs": via_fs, "g2_excluded": flagged or leak or via_fs,
                 "step_limit_turns": sum(1 for t in cell["turns"] if t.get("step_limit"))})
    return cell


def prior_attempts(ctx, cid):
    """Attempt rows of this cell already in index.jsonl (earlier runs of the batch, including budget stops)."""
    return [r for r in read_jsonl(ctx["index"]) if r.get("cell") == cid and r.get("attempt") is not None]


def run_cell_with_retries(ctx, task, rep, arm):
    cid = cell_id(task, rep, arm)
    path = os.path.join(ctx["batch_dir"], "cells", cid + ".json")
    prior = load_json(path)
    if ctx["resume"] and prior and prior.get("status") in ("done", "invalid"):
        return prior
    # Attempt numbers always continue after every attempt already in index.jsonl, so workdirs, turn files and
    # ledger rows stay unique. On --resume, budget-stopped attempts do not use up --max-attempts; others do.
    earlier = prior_attempts(ctx, cid)
    first = 1 + max((r["attempt"] for r in earlier), default=0)
    if not ctx["resume"]:
        earlier = []
    used = sum(1 for r in earlier if r.get("status") not in ("budget_stop",))
    attempts = [{"attempt": r["attempt"], "status": r.get("status"), "reasons": r.get("reasons"), "infra": r.get("infra")} for r in earlier]
    cell = None
    for attempt in range(first, first + max(ctx["max_attempts"] - used, 0)):
        if not ctx["budget"].can_start():
            cell = {"cell": cid, "task": task, "arm": arm, "rep": rep, "status": "budget_stop", "valid": False, "invalid_reasons": ["budget cap reached before start"], "attempt": attempt}
            append_jsonl(ctx["index"], summary_line(cell))
            ctx["budget_stopped"] = True
            return cell  # not written to cells/: --resume retries it
        cell = run_cell(ctx, task, rep, arm, attempt)
        attempts.append({"attempt": attempt, "status": cell["status"], "reasons": cell.get("invalid_reasons"), "infra": cell.get("infra")})
        cell["attempts"] = attempts
        append_jsonl(ctx["index"], summary_line(cell))
        if cell["status"] in ("done", "budget_stop"):
            break
    if cell is None:
        return prior or {"cell": cid, "status": "exhausted", "valid": False, "invalid_reasons": ["no attempts left"]}
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
                                     "oracle_via_fs", "secret_flags", "spend_peak_usd", "wall_s", "sid", "log", "started", "ended")} | {
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


def env_record():
    """Names (never values) of the inherited proxy and DSH_* variables, plus the non-secret DSH_* switches
    that change the composition; the child removes every inherited DSH_* except the ones it sets."""
    dsh = sorted(k for k in os.environ if k.startswith("DSH_"))
    return {
        "proxy_env_names": sorted(k for k in os.environ if k.lower().endswith("_proxy")),
        "inherited_dsh_env_names": dsh,
        "child_dsh_env": {k: ("<the arm's home>" if v is None else v) for k, v in DSH_ENV_SET.items()},
        "removed_dsh_env_names": [k for k in dsh if k not in DSH_ENV_SET],
        "dsh_permission_mode": "unset in the child (profile default workspace-write)",
    }


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
    for sub in ("cells", "turns", "work", "workdirs", "patches"):
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
    no_fp = (args.fingerprints or "").lower() == "none"
    fp_path = None if no_fp else (args.fingerprints or os.path.join(ab, "fingerprints.json"))
    ctx = {
        "ab_root": ab, "bin": os.path.join(ab, BIN_REL), "tasks": tasks, "batch": args.batch, "batch_dir": batch_dir,
        "offline": args.offline, "resume": args.resume, "max_attempts": args.max_attempts, "prices": prices, "poll_s": args.poll_s,
        "budget": Budget(ledger, args.budget_usd, args.budget_reserve_usd, args.budget_margin_usd, prices[prices.get("budget_sheet", "peak")],
                         args.unpriced_step_usd, args.max_unpriced_steps),
        "fingerprints": load_json(fp_path) if fp_path and os.path.exists(fp_path) else None,
        "steps_patch": steps_patch, "offline_patch": offline_patch, "index": os.path.join(batch_dir, "index.jsonl"),
    }
    manifest = {
        "batch": args.batch, "started": now(), "argv": sys.argv, "arms": arms, "tasks": selected, "reps": args.reps, "seed": args.seed,
        "parallel_arms": args.parallel_arms, "offline": args.offline, "budget_usd": args.budget_usd, "budget_reserve_usd": args.budget_reserve_usd,
        "budget_margin_usd": args.budget_margin_usd, "unpriced_step_usd": args.unpriced_step_usd, "max_unpriced_steps": args.max_unpriced_steps,
        "budget_sheet": prices.get("budget_sheet", "peak"), "ledger": ledger, "spent_at_start": round(ctx["budget"].total(), 6),
        "host_version": load_json(os.path.join(ab, "host", "node_modules", "@deepseek-ai", "dsh", "package.json"), {}).get("version"),
        "fingerprints": fp_path if ctx["fingerprints"] else ("none (not checked)" if no_fp else None),
        "arm_packages": load_json(os.path.join(ab, "arms.json"), {}),
        "python": sys.version.split()[0],
        "harness_commit": git_head(),
    } | env_record()
    write_json(os.path.join(batch_dir, f"manifest-{dt.datetime.now().strftime('%Y%m%dT%H%M%S')}.json"), manifest)
    log(f"batch {args.batch}: arms={arms} tasks={[tasks[t]['alias'] for t in selected]} reps={args.reps} offline={args.offline} "
        f"budget=${args.budget_usd} spent=${ctx['budget'].total():.4f} fingerprints={'yes' if ctx['fingerprints'] else 'no'}")
    stopped = False
    for rep in range(1, args.reps + 1):
        order = list(selected)
        random.Random(f"{args.seed}:{rep}").shuffle(order)
        for task in order:
            if not ctx["budget"].can_start() or ctx["budget"].exhausted():
                why = "unpriced steps" if ctx["budget"].too_many_unpriced() else "spend"
                log(f"budget ({why}): spent ${ctx['budget'].total():.4f}, unpriced steps {ctx['budget'].unpriced_total()}, cap ${args.budget_usd}; stopping before {task} rep {rep}")
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
    log(f"batch {args.batch} {'STOPPED (budget)' if stopped else 'finished'}; spent ${ctx['budget'].total():.4f} of ${args.budget_usd}; unpriced steps {ctx['budget'].unpriced_total()}")
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

DELTA_KEYS = ("prefix_delta_vs_control", "system_delta_vs_control", "slice_tools_delta_vs_control")


def cmd_fingerprints(args):
    cells = [load_json(p) for p in sorted(glob.glob(os.path.join(args.batch_dir, "cells", "*.json"))) if not p.endswith(".budget_stop.json")]
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
    status = 0
    if args.compare:
        old = load_json(args.compare) or {}
        diffs = []
        for arm, fp in out["arms"].items():
            o = (old.get("arms") or {}).get(arm)
            if not o:
                diffs.append(f"{arm}: not in {args.compare}")
                continue
            for k in DELTA_KEYS:
                if k in fp and fp.get(k) != o.get(k):
                    diffs.append(f"{arm}: {k} {fp.get(k)} != {o.get(k)}")
            if fp["slice_tools_sha"] != o.get("slice_tools_sha"):
                diffs.append(f"{arm}: slice_tools_sha changed (the plugin's tool text must not depend on the provider)")
        changed = sorted(f"{arm}.{k}" for arm, fp in out["arms"].items() for k in ("system_sha", "tools_sha", "tools_count", "prefix_chars")
                         if fp.get(k) != ((old.get("arms") or {}).get(arm) or {}).get(k))
        out["compared_with"] = {"file": os.path.realpath(args.compare), "changed_fields": changed, "delta_mismatches": diffs}
        print(f"compare with {args.compare}: changed {changed or 'nothing'}; delta mismatches {diffs or 'none'}", file=sys.stderr)
        status = 1 if diffs else 0
    text = json.dumps(out, indent=1, sort_keys=True, ensure_ascii=False) + "\n"
    if args.out and status == 0:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
    print(text)
    return status


# ---------------------------------------------------------------------------- secrets scan

def cmd_secrets_scan(args):
    """Cells whose tool calls referenced .env, DSH_HOME or ~/.dsh. Reads only cells/*.json (the flags ab_metrics
    computed from tool-call arguments); never opens logs or turn files and never searches for the key."""
    ab = os.path.realpath(args.ab_root)
    hits = []
    for path in sorted(glob.glob(os.path.join(ab, "results", "*", "cells", "*.json"))):
        c = load_json(path) or {}
        for f in ((c.get("metrics") or {}).get("flagged_access") or []):
            if f.get("secret"):
                hits.append({"cell": c.get("cell"), "batch": c.get("batch"), "turn": f.get("turn"), "tool": f.get("tool"), "reasons": f.get("reasons"),
                             "hold_back": [c.get("log"), os.path.join(ab, "results", c.get("batch") or "?", "turns", f"{c.get('cell')}.a{c.get('attempt')}.t*")]})
    print(json.dumps({"secret_references": hits}, indent=1))
    return 1 if hits else 0


def main(argv):
    if argv and argv[0] == "_task_call":
        return _task_call_main(argv[1:])
    subs = ("prepare", "run", "fingerprints", "secrets-scan")
    sub = argv[0] if argv and argv[0] in subs else "run"
    rest = argv[1:] if argv and argv[0] in subs else argv
    ap = argparse.ArgumentParser(prog="run_ab.py " + sub, description=__doc__.split("\n\n")[0])
    if sub == "prepare":
        ap.add_argument("--ab-root", required=True)
        ap.add_argument("--arm", action="append", required=True, help="name=path/to/arm.tgz (repeatable)")
        ap.add_argument("--force", action="store_true")
        return cmd_prepare(ap.parse_args(rest))
    if sub == "fingerprints":
        ap.add_argument("--batch-dir", required=True)
        ap.add_argument("--out")
        ap.add_argument("--compare", help="fingerprints.json whose control-vs-arm deltas must be reproduced")
        return cmd_fingerprints(ap.parse_args(rest))
    if sub == "secrets-scan":
        ap.add_argument("--ab-root", required=True)
        return cmd_secrets_scan(ap.parse_args(rest))
    ap.add_argument("--ab-root", required=True)
    ap.add_argument("--arms", default="control,arm1,arm2")
    ap.add_argument("--tasks", default="all")
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--batch", required=True)
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--budget-usd", type=float, default=10.0)
    ap.add_argument("--budget-reserve-usd", type=float, default=0.75)
    ap.add_argument("--budget-margin-usd", type=float, default=0.60)
    ap.add_argument("--unpriced-step-usd", type=float, default=0.05)
    ap.add_argument("--max-unpriced-steps", type=int, default=40)
    ap.add_argument("--poll-s", type=float, default=1.0)
    ap.add_argument("--parallel-arms", action="store_true")
    ap.add_argument("--seed", type=int, default=20260927)
    ap.add_argument("--fingerprints", help="fingerprints.json (default AB/fingerprints.json), or 'none' to skip the check (warmup only)")
    ap.add_argument("--max-attempts", type=int, default=2)
    return cmd_run(ap.parse_args(rest))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
