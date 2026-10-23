#!/usr/bin/env python3
"""run_ab.py: driver for the P1-10 native A/B runs (docs/p110-f-native-ab.md, docs/p110-native-ab.md; scripts/ab/README.md).

Subcommands (system python3; stdlib only, plus zstandard through ab_metrics):

  run_ab.py prepare --ab-root AB --arm control=<tgz> --arm F=<tgz> [--force]
      One template DSH_HOME per arm (AB/vault/homes/<arm>, profile `ab`) with the parity overlay and the arm's
      packed plugin, installed with --ignore-scripts from an arm-neutral copy AB/vault/artifacts/plugin-<sha12>.tgz;
      AB/vault/dump-<arm>.yml. Exit 0 only if dump-config is identical across arms. Never creates .env.

  run_ab.py [run] --ab-root AB --arms control,F --tasks all|r1,r3,... --reps N --batch NAME [--gates GATES.json]
                  [--offline] [--resume] [--budget-usd 10] [--budget-reserve-usd 0.75] [--budget-margin-usd 0.6]
                  [--unpriced-step-usd 0.05] [--max-unpriced-steps 40] [--seed 20261022]
                  [--fingerprints AB/vault/fingerprints.json|none] [--max-attempts 2] [--block PATH]...
      Runs every (task, rep) cell for every arm, ONE CELL AT A TIME: the two cells of a (task, rep) pair run back to
      back, the first arm rotating with (rep - 1 + seed). Per cell: a fresh cell root AB/live/c-<id>/ with a copy of
      the arm's template home, a private TMPDIR and the workdir; setup(); one headless process per turn (prompt on
      stdin, --json stdout to a file); after_turn hooks; verify(); the session log's metrics row; validity. Then the
      workdir (with its truth sidecar and tmp) is packed into the vault, the home moved there, and the cell root removed.
      Output: AB/vault/results/<batch>/{index.jsonl, cells/<cell>.json, turns/<cell>.a<k>.t<n>.{jsonl.gz,err},
      workdirs/<wid>.tgz, homes/c-<id>/, manifest-*.json}.

  run_ab.py isolation-probe --ab-root AB --arms control,F [--batch isoprobe] [--target-batch offline]
      Offline only. Plants canary files in every place a cell must not read (the other arm's template home and finished
      cell homes with their session logs, the A/B state, manifests, truth files, packed workdirs, the worktrees'
      scripts/ and docs/) and
      runs one scripted probe cell per arm that tries to read them with bash, read, glob and grep; then one tamper cell
      per arm that chmods the vault open. Exit 0 only if every protected read was denied, no canary reached a tool
      result, the cell's own files were readable, and every tamper was detected (the cell invalid).

  run_ab.py unblock --ab-root AB
      Restores the modes recorded in AB/.blocked.json (after a crash while a turn ran).

  run_ab.py fingerprints --batch-dir AB/vault/results/<batch> [--out FILE] [--compare OLD.json]
      Per-arm system-prompt and slice-tool fingerprints plus measured prefix/header sizes.
      --compare exits 1 unless the control-vs-arm deltas equal those of OLD.json.

  run_ab.py secrets-scan --ab-root AB
      Lists every cell with a tool call that referenced .env, DSH_HOME or ~/.dsh (they could have reached the model
      key). Those cells' logs and turn files are held back from the archive until the owner has looked. Never reads the
      key or greps for it. Exit 1 when any exist.

Isolation (docs/p110-f-native-ab.md §3): DSH's sandbox confines writes only, and every cell runs as the same user, so
reads are confined with POSIX permissions instead. While any turn runs, AB/vault (template homes, finished cell homes and
session logs, results, manifests, ledger, truth files, packed workdirs) and the scripts/ and docs/ directories of every
worktree under AB/wt (task oracles, self-checks, the A/B records) are mode 000, and no other cell exists: the only
readable things under AB are the host, the offline adapter copy, the per-batch patches, the worktrees' source code and
the running cell's own root. After the turn the harness kills any process still carrying the
cell's DSH_HOME, checks that every blocked path still has mode 000 and an unchanged inode and ctime (a chmod, chflags,
rename or replacement while blocked is a breach and makes the cell invalid), and only then unblocks.

Budget: every turn is priced at the PEAK sheet in prices.json and appended to AB/vault/spend.jsonl (online) or
<batch>/spend.jsonl (offline). A turn's charge is the larger of two figures:
(a) its --json stdout: the usage of each step_end, plus --unpriced-step-usd for every step_end without usage (the headless
    projector drops a whole step's usage when any attempt of it reported no sample, typically a transport or 429 retry)
    and for a step still open when the process ended (killed or crashed mid-request);
(b) its session log: the usage of every assistant/message and assistant/attempt of the turn, plus --unpriced-step-usd for
    every such record without a sample.
No new cell starts once spend + reserve >= budget. The running turn is polled every second and killed, and no further turn
starts, once spend + margin >= budget, where the running turn counts its priced steps plus the unpriced charge for its
open step. Invariant (why the cap holds): a step's usage is known only when it ends, so between two polls the running turn
can finish at most one step beyond what was counted; the margin must be at least 2 x (concurrent turns) x (worst-case
step cost). One turn runs at a time; the default $0.60 keeps the 3-arm margin of 2026-09-27. The run also stops cleanly
once more than --max-unpriced-steps unpriced steps have been charged (a retry storm). The ledger covers every batch under
AB, so --budget-usd caps the whole experiment (warmup, pilot, batch and arbitration).

Secrets: the model key is only ever a symlink AB/vault/homes/<arm>/.env -> ~/.dsh/.env, created by the operator after
the offline dry run; a cell home gets the same link (os.readlink of the template's link, never its target), and the link
is removed before the home is moved into the vault. This script never reads, prints or copies the key; --offline refuses
to run if any template home has .env and strips *API_KEY*/DEEPSEEK* variables from the child environment.
"""
import argparse
import atexit
import datetime as dt
import glob
import gzip
import hashlib
import importlib.util
import json
import os
import random
import re
import secrets as pysecrets
import shutil
import signal
import stat
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
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
BIN_REL = os.path.join("host", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
PROFILE = "ab"
VAULT, LIVE, PATCHES, MOCK, WT, PLUGINS = "vault", "live", "patches", "mock", "wt", "plugins"
# Inside each worktree under AB/wt only these hold task oracles (tasks, self-checks, test fixtures, the A/B records). The
# worktree roots stay readable: with a root at mode 000, a `git worktree prune` run by any other process in the main
# repository takes the worktree for missing and deletes its link (it happened once during the build, 2026-10-22).
WT_BLOCKED = ("scripts", "docs")
BLOCK_STATE = ".blocked.json"
# The current experiment's gates (and arm structure); gates.json is the frozen file of the 2026-09-27 A/B.
GATES_DEFAULT = os.path.join(HERE, "gates-f.json")
# Names the harness itself keeps at the top of AB; anything else that appears during a cell came from the cell.
AB_ENTRIES = {"host", VAULT, LIVE, PATCHES, MOCK, WT, PLUGINS, "progress.txt", BLOCK_STATE}
# The slice plugin's bundle name in a profile's dsh.profile.bundles (`dsh plugin add` appends it).
SLICE_BUNDLE = "@dsh-external/dsh-slice-agent-loop"
# The parity overlay leaves 16 tools on DSH 0.1.7-rc.2 and on 0.2.0-rc.2 (docs/p110-f-native-ab.md §3).
EXPECTED_TOOLS = 16
# Infra: provider, network, credential or quota failures (error codes of @deepseek-ai/dsh-llm and the
# DeepSeek adapter), a missing turn_end, and the harness's own timeout. Anything else that ends a turn
# is model-attributable: the turn counts as ended and the cell continues (like the step cap).
INFRA_CODES = {"TRANSPORT", "RATE_LIMIT", "SERVER", "TIMEOUT", "EMPTY_RESPONSE", "MISSING_CREDENTIAL", "INVALID_CREDENTIAL",
               "AUTH", "QUOTA", "ACCOUNT_QUOTA", "NO_ADAPTER", "ABORTED"}
INFRA_PATTERNS = ("MISSING_CREDENTIAL", "TRANSPORT", "RATE_LIMIT", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "fetch failed", "socket hang up",
                  "502 Bad Gateway", "503 Service", "504 Gateway", "ENOTFOUND", "EAI_AGAIN")
# maxStepsPerTurn refusing a step ends the turn with reason kind "blocked" and exit 1 (verified on 0.1.7-rc.2 and 0.2.0-rc.2).
STEP_LIMIT_KIND = "blocked"
MODEL_END_KINDS = {STEP_LIMIT_KIND, "error", "max-tokens"}
# DSH_* variables the harness sets; every other inherited DSH_* variable is removed from the child.
DSH_ENV_SET = {"DSH_HOME": None, "DSH_TELEMETRY_DISABLED": "1"}
# Structure of the 2026-09-27 arms (gates.json has no "structure"); the F-only A/B reads its own from gates-f.json.
LEGACY_STRUCTURE = {
    "control": {"header": "long", "tool_line": "long"},
    "arm1": {"header": "short", "tool_line": "long", "prefix_smaller_than": {"arm": "control", "min_chars": 700}},
    "arm2": {"header": "short", "tool_line": "v", "prefix_smaller_than": {"arm": "control", "min_chars": 700}},
}
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


def vault(ab, *parts):
    return os.path.join(ab, VAULT, *parts)


def template_home(ab, arm):
    return vault(ab, "homes", arm)


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


def task_call(task_dir, fn, root, n=None, timeout=600, seed=None):
    """Run setup/verify/after_turn of a task in a fresh interpreter; returns the JSON result. `seed` reaches the task as
    AB_TASK_SEED (seeded tasks generate their oracle values from it at setup time)."""
    if task_dir is None:
        return {"skipped": True}
    cmd = [sys.executable, os.path.abspath(__file__), "_task_call", task_dir, fn, root] + ([str(n)] if n is not None else [])
    env = dict(os.environ)
    env.pop("AB_TASK_SEED", None)
    if seed is not None:
        env["AB_TASK_SEED"] = seed
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
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


def usage_from_stdout(source):
    """Summed step_end usage, unpriced and open steps, turn_end reason, turns, session id and final text from a --json
    stdout file (a path, plain or .gz, or a text file object opened for reading, re-read from its start: the harness
    keeps one open while the vault holding the file is blocked)."""
    out = {"usage": {"inputTokens": 0, "cacheReadTokens": 0, "outputTokens": 0, "cacheWriteTokens": 0}, "steps": 0, "unpriced_steps": 0,
           "open_steps": 0, "turns": [], "sid": None, "turn_end": None, "final": None}
    if isinstance(source, str):
        if not os.path.exists(source):
            return out
        opener = gzip.open if source.endswith(".gz") else open
        with opener(source, "rt", encoding="utf-8", errors="replace") as fh:
            return _parse_stdout(fh, out)
    source.seek(0)
    return _parse_stdout(source, out)


def _parse_stdout(fh, out):
    open_steps = set()
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


# ---------------------------------------------------------------------------- isolation

class Isolation:
    """Blocks (mode 000) every path a cell must not read while one of its turns runs, with tamper evidence.

    The model's tools run as the harness's own user, so permissions are the only read barrier. The owner can chmod its
    own files, and DSH's workspace-write sandbox allows writes under /tmp (the A/B root lives there), so a deliberate
    chmod is possible; it changes the path's ctime, which check() compares with the snapshot taken after blocking."""

    def __init__(self, ab, paths, ro_paths=()):
        self.ab = ab
        self.state = os.path.join(ab, BLOCK_STATE)
        self.paths = sorted({os.path.realpath(p) for p in paths if os.path.lexists(p)})
        # Directories of the harness that a cell may read but must not write into while a turn runs (the A/B root, live/,
        # patches/, mock/, wt/, host/): without write permission nobody but root can add, remove or rename an entry, so a
        # cell cannot leave a file there for a later cell. Their contents below the first level are not covered.
        self.ro_paths = sorted({os.path.realpath(p) for p in ro_paths if os.path.isdir(p)} - set(self.paths))
        self.modes = {}
        self.target = {}
        self.snap = None

    def block(self):
        if os.path.exists(self.state):
            raise SystemExit(f"{self.state} exists: a previous run did not unblock (run `run_ab.py unblock --ab-root {self.ab}`)")
        self.modes = {p: stat.S_IMODE(os.lstat(p).st_mode) for p in self.paths + self.ro_paths}
        self.target = {p: 0 for p in self.paths} | {p: self.modes[p] & ~0o222 for p in self.ro_paths}
        write_json(self.state, {"modes": self.modes, "pid": os.getpid(), "since": now()})
        for p, m in self.target.items():
            os.chmod(p, m)
        self.snap = {}
        for p in self.target:
            st = os.lstat(p)
            self.snap[p] = (st.st_ino, st.st_ctime_ns)

    def check(self):
        """Breaches since block(): a blocked or read-only path missing, replaced, with another mode, or with changed metadata
        (a chmod, or an entry added or removed)."""
        out = []
        for p, (ino, ctime) in (self.snap or {}).items():
            try:
                st = os.lstat(p)
            except OSError as exc:
                out.append(f"{p}: {exc.strerror}")
                continue
            want = self.target.get(p, 0)
            if st.st_ino != ino:
                out.append(f"{p}: replaced")
            elif stat.S_IMODE(st.st_mode) != want:
                out.append(f"{p}: mode {oct(stat.S_IMODE(st.st_mode))} while {'blocked' if want == 0 else 'read-only'}")
            elif st.st_ctime_ns != ctime:
                out.append(f"{p}: metadata changed while {'blocked' if want == 0 else 'read-only'}")
        return out

    def unblock(self):
        modes = self.modes or (load_json(self.state) or {}).get("modes") or {}
        for p, m in modes.items():
            try:
                os.chmod(p, m)
            except FileNotFoundError:
                pass
        if os.path.exists(self.state):
            os.remove(self.state)
        self.snap = None

    @property
    def blocked(self):
        return self.snap is not None


def unblock_from_state(ab):
    state = os.path.join(ab, BLOCK_STATE)
    rec = load_json(state)
    if not rec:
        print(f"{state}: nothing to unblock")
        return 0
    for p, m in rec["modes"].items():
        try:
            os.chmod(p, m)
            print(f"restored {oct(m)} {p}")
        except FileNotFoundError:
            print(f"missing {p}")
    os.remove(state)
    return 0


def cell_marker(cell_root):
    """The string that ties a process to one cell: `live/c-<id>`, part of its DSH_HOME, TMPDIR, PWD and workdir in both the
    /tmp and /private/tmp spellings, and unique to the cell."""
    return os.path.join(LIVE, os.path.basename(os.path.normpath(cell_root)))


def cell_pids(marker):
    """Pids of the processes tied to a cell: `marker` in the command line or environment (`ps -E`: DSH_HOME, TMPDIR, PWD,
    a path argument), or a current directory containing it (`lsof -d cwd`), so a background job that dropped DSH_HOME
    and left the turn's session is found too while it still sits in or names the cell. Only pids are kept; nothing of
    another process's environment is printed or stored. None if `ps` failed."""
    pids = set()
    try:
        out = subprocess.run(["ps", "-axEww", "-o", "pid=,command="], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.splitlines():
        if marker in line:
            try:
                pids.add(int(line.split(None, 1)[0]))
            except (ValueError, IndexError):
                pass
    try:
        out = subprocess.run(["lsof", "-nP", "-w", "-a", "-u", str(os.getuid()), "-d", "cwd", "-Fpn"], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        out = ""
    pid = None
    for line in out.splitlines():
        if line.startswith("p"):
            try:
                pid = int(line[1:])
            except ValueError:
                pid = None
        elif line.startswith("n") and pid is not None and marker in line:
            pids.add(pid)
    pids.discard(os.getpid())
    pids.discard(os.getppid())
    return pids


def kill_strays(marker):
    """Kill every process still tied to the cell (cell_pids), e.g. a background job the model started. Returns the count."""
    killed = 0
    for _ in range(3):  # again, for a child forked while the previous pass ran
        pids = cell_pids(marker)
        if pids is None:
            return -1 if not killed else killed
        if not pids:
            break
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
                killed += 1
            except (ProcessLookupError, PermissionError):
                pass
        time.sleep(0.2)
    return killed


def survivors(marker):
    """How many processes are still tied to the cell (pids only)."""
    pids = cell_pids(marker)
    return -1 if pids is None else len(pids)


def top_entries(d):
    try:
        return set(os.listdir(d))
    except OSError:
        return set()


def named_in(calls_text, d, name):
    """Whether the cell's tool calls name the new entry `name` of directory `d`: as a path (`<d>/<name>`, `/tmp/<name>`,
    `../<name>`), or, for a name of 6 characters or more, as a bare word (`cd /tmp && mkdir <name>`)."""
    if len(name) < 3:
        return False
    if any(form in calls_text for form in (os.path.join(d, name), "/tmp/" + name, "../" + name)):
        return True
    return len(name) >= 6 and re.search(r"(?<![\w.-])" + re.escape(name) + r"(?![\w.-])", calls_text) is not None


def quarantine_new_entries(ctx, before, calls_text, dest):
    """Move what a cell created outside its own root into the vault, so a later cell cannot find it: new top-level
    entries of the A/B root (the harness adds none during a cell), and new top-level entries of the A/B root's parent
    and of /private/tmp that the cell's own tool calls name (other processes also create entries there)."""
    moved = []
    for d, names in before.items():
        for name in sorted(top_entries(d) - names):
            if d == ctx["ab_root"]:
                if name in AB_ENTRIES:
                    continue
            elif not named_in(calls_text, d, name):
                continue  # not demonstrably the cell's: other processes create entries here too
            src = os.path.join(d, name)
            target = os.path.join(dest, d.strip("/").replace("/", "_"), name)
            try:
                os.makedirs(os.path.dirname(target), exist_ok=True)
                shutil.move(src, target)
                moved.append(src)
            except OSError as exc:
                log(f"quarantine {src}: {exc}")
    return moved


# ---------------------------------------------------------------------------- one turn

def child_env(home, offline, tmp=None):
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
    if tmp:
        env["TMPDIR"] = tmp  # a private temp dir per cell (packed away with it), so mktemp files never outlive the cell
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


def run_turn(ctx, cell_key, home, workdir, patches, sid, prompt, stdout_path, stderr_path, timeout_s, tmp=None):
    cmd = ["node", ctx["bin"], "--profile", PROFILE]
    for p in patches:
        cmd += ["--patch", p]
    if sid:
        cmd += ["--session-id", sid]
    cmd += ["--json", "-"]
    started = time.time()
    rec = {"started": now(), "timeout": False, "budget_kill": False}
    budget = ctx["budget"]
    iso = ctx.get("isolation")
    proc = None
    with open(stdout_path, "wb") as out, open(stderr_path, "wb") as err, open(stdout_path, encoding="utf-8", errors="replace") as live:
        if iso:
            iso.block()
        try:
            proc = subprocess.Popen(cmd, cwd=workdir, env=child_env(home, ctx["offline"], tmp), stdin=subprocess.PIPE, stdout=out, stderr=err,
                                    start_new_session=True)
            proc.stdin.write(prompt.encode("utf-8"))
            proc.stdin.close()
            while True:
                try:
                    proc.wait(timeout=ctx.get("poll_s", 1.0))
                    break
                except subprocess.TimeoutExpired:
                    pass
                usd, n = budget.price_parsed(usage_from_stdout(live))
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
        finally:
            if proc is not None and proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait()
            if proc is not None:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)  # leftovers of the turn's process group
                except (ProcessLookupError, PermissionError):
                    pass
            # Anything the model left running (a background job in its own process group or session) still names the cell
            # in its environment (DSH_HOME, TMPDIR, PWD) or sits in it; it must be gone before the vault becomes readable again.
            strays = kill_strays(cell_marker(os.path.dirname(home)))
            breaches = iso.check() if iso else []
            if iso:
                iso.unblock()
            rec["isolation"] = {"strays_killed": strays, "breaches": breaches}
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


def expected_structure(ctx, arm):
    """Manipulation checks per arm: tape header form, tool-line form and prefix relation (gates file "structure")."""
    spec = ctx.get("structure") if isinstance(ctx, dict) else None
    return (spec or LEGACY_STRUCTURE).get(arm)


def validity(ctx, arm, meta, turns, row, complete=True):
    reasons = []
    for t in turns:
        if not turn_ok(t):
            reasons.append(f"turn {t['turn']}: exit {t['exit']} ({(t.get('turn_end') or {}).get('kind')}, {t.get('error_code')}{', timeout' if t.get('timeout') else ''})")
        for b in ((t.get("isolation") or {}).get("breaches") or []):
            reasons.append(f"isolation breached in turn {t['turn']}: {b}")
    if row is None:
        return reasons + ["session log not found"]
    v = row["validity"]
    fp_all = ctx["fingerprints"] or {}
    exp = expected_structure(ctx, arm)
    expected_tools = (fp_all.get("arms", {}).get(arm) or {}).get("tools_count", (exp or {}).get("tools", EXPECTED_TOOLS))
    if v["tools_count"] != expected_tools:
        reasons.append(f"tools_count {v['tools_count']} != {expected_tools}")
    if v["tool_lists_distinct"] != 1:
        reasons.append(f"tool list changed within the session ({v['tool_lists_distinct']} variants)")
    if v["system_distinct"] != 1:
        reasons.append(f"system prompt changed within the session ({v['system_distinct']} variants)")
    if v["system_has_host_path"]:
        reasons.append("system prompt contains /private or /Users")
    # Compaction is a host feature under test in the slice-vs-stock arms (structure "compaction": "allowed"); the
    # P1-10 parity arms disabled it, so any compaction event there made the cell invalid.
    if v["compaction_events"] and (exp or {}).get("compaction") != "allowed":
        reasons.append(f"{v['compaction_events']} compaction events")
    if complete and (v["user_prompts"] != meta["turns"] or v["turn_ends"] != meta["turns"] or v["goal_messages"]):
        reasons.append(f"turns do not match prompts: {v['user_prompts']} user prompts, {v['turn_ends']} turn ends, {v['goal_messages']} goal rounds for {meta['turns']} prompts")
    fp = fp_all.get("arms", {}).get(arm)
    if fp:
        if v["system_sha"] != fp["system_sha"]:
            reasons.append("system prompt fingerprint mismatch")
        if v["slice_tools_sha"] != fp["slice_tools_sha"]:
            reasons.append("slice tool fingerprint mismatch")
        rel = (exp or {}).get("prefix_smaller_than")
        base = fp_all["arms"].get(rel["arm"]) if rel else None
        if base and base["prefix_chars"] - row["prefix"]["prefix_chars"] < rel["min_chars"]:
            reasons.append(f"structural: prefix only {base['prefix_chars'] - row['prefix']['prefix_chars']} chars smaller than {rel['arm']} (< {rel['min_chars']})")
        same = (exp or {}).get("same_prefix_as")
        base = fp_all["arms"].get(same) if same else None
        if base and (row["prefix"]["prefix_chars"] != base["prefix_chars"] or v["system_sha"] != base["system_sha"] or v["slice_tools_sha"] != base["slice_tools_sha"]):
            reasons.append(f"structural: request prefix differs from {same}'s ({row['prefix']['prefix_chars']} vs {base['prefix_chars']} chars)")
        plus = (exp or {}).get("tool_names_plus")
        base = fp_all["arms"].get(plus["arm"]) if plus else None
        if base and sorted(v["tool_names"]) != sorted(set(base["tool_names"]) | set(plus["extra"])):
            reasons.append(f"structural: tools are not {plus['arm']}'s plus {plus['extra']}")
    if exp and exp.get("header") is None and "header" in exp:
        # an arm without the slice plugin: no tape entry may exist (the manipulation check of the stock arms)
        if row["tape"]["entries"]:
            reasons.append(f"structural: {row['tape']['entries']} slice tape entries in an arm without the plugin")
    elif exp:
        forms = row["tape"]["header_forms"]
        if set(forms) - {exp["header"]}:
            reasons.append(f"tape header forms {forms}, expected only {exp['header']}")
        if exp["header"] == "short" and set(row["tape"]["header_lengths"]) - {76, 78}:
            reasons.append(f"structural: tape header lengths {row['tape']['header_lengths']} not in 76/78")
        tforms = row["tape"]["tool_line_forms"]
        if set(tforms) - {exp["tool_line"]}:
            reasons.append(f"tool line forms {tforms}, expected only {exp['tool_line']}")
    if meta.get("require_fold_of_read_turn") and (exp or {}).get("fold", True):
        tr = meta["require_fold_of_read_turn"]
        if not any(r["turn"] == tr and r["fold_of_read"] for r in row.get("in_turn", [])):
            reasons.append(f"no fold replacement of a turn-{tr} read (task needs the condensed view)")
    # Delivery (meta "delivery"): the exam's fact must have reached the model in its delivery turn through a
    # non-recall tool result; otherwise the exam cannot measure recall (e.g. output redirected to /dev/null).
    for d in row.get("delivery", []):
        if not d["delivered"] and d["turn"] <= len(turns):  # a turn that never ran is reported by its own reason
            reasons.append(f"fact not delivered: no turn-{d['turn']} tool result carried it (output discarded or never produced)")
    return reasons


def cell_names(ctx, task, rep, arm, attempt):
    """Arm-neutral names: the workdir w-<id> and the cell root c-<id> (equal length in every arm)."""
    key = f"{ctx['batch']}:{task}:{rep}:{arm}:{attempt}"
    return "w-" + hashlib.sha1(key.encode()).hexdigest()[:10], "c-" + hashlib.sha1(("root:" + key).encode()).hexdigest()[:10]


def task_seed(ctx, task, rep):
    """Seed of a seeded task's content and oracle values: equal for every arm of one (batch, task, rep), derived from a
    salt that lives only in the vault (blocked while turns run), so neither the values nor the seed can be recomputed
    from anything a cell can read."""
    salt_path = vault(ctx["ab_root"], "task-seed-salt")
    if not os.path.exists(salt_path):
        with open(salt_path, "w", encoding="utf-8") as fh:
            fh.write(pysecrets.token_hex(16) + "\n")
        os.chmod(salt_path, 0o600)
    with open(salt_path, encoding="utf-8") as fh:
        salt = fh.read().strip()
    return hashlib.sha256(f"{salt}:{ctx['batch']}:{task}:{rep}".encode()).hexdigest()[:32]


def clear_live(ctx):
    """Only the running cell may exist under AB/live; leftovers of a crashed run (they can hold task sources and
    answers) are moved into the vault first."""
    live = os.path.join(ctx["ab_root"], LIVE)
    os.makedirs(live, exist_ok=True)
    for name in os.listdir(live):
        dest = os.path.join(ctx["batch_dir"], "stale", f"{name}-{int(time.time())}")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.move(os.path.join(live, name), dest)
        log(f"moved a leftover cell root {name} into the vault ({dest})")


def make_cell_home(ctx, arm, home):
    """A private copy of the arm's template home. A key link is recreated from its link text, never followed."""
    shutil.copytree(template_home(ctx["ab_root"], arm), home, symlinks=True)


def pack_away(ctx, wid, workdir, tmp, truth, cell_root, home, cid, attempt):
    """End of a cell, for any reason: pack the workdir, its truth sidecar and its private TMPDIR into
    workdirs/<wid>.tgz; move the home (session log included, key link removed) into homes/; remove the cell root;
    gzip the attempt's turn stdout files. Nothing of a finished or stopped cell stays readable for a later cell."""
    batch_dir = ctx["batch_dir"]
    packed = os.path.join(batch_dir, "workdirs", wid + ".tgz")
    try:
        with tarfile.open(packed, "w:gz") as tar:
            if os.path.isdir(workdir):
                tar.add(workdir, arcname=wid)
            if truth and os.path.exists(truth):
                tar.add(truth, arcname=wid + ".truth.json")
            if tmp and os.path.isdir(tmp) and os.listdir(tmp):
                tar.add(tmp, arcname=wid + ".tmp")
        if truth and os.path.exists(truth):
            os.remove(truth)
        env_link = os.path.join(home, ".env")
        if os.path.islink(env_link):
            os.unlink(env_link)  # removes the link only
        dest = os.path.join(batch_dir, "homes", os.path.basename(cell_root))
        if os.path.isdir(home):
            if os.path.exists(dest):
                shutil.rmtree(dest)
            shutil.move(home, dest)
        shutil.rmtree(cell_root, ignore_errors=True)
    except OSError as exc:
        log(f"{cid}: could not pack away {cell_root}: {exc}")
    for path in glob.glob(os.path.join(batch_dir, "turns", f"{cid}.a{attempt}.t*.jsonl")):
        with open(path, "rb") as src, gzip.open(path + ".gz", "wb") as dst:
            shutil.copyfileobj(src, dst)
        os.remove(path)


def run_cell(ctx, task, rep, arm, attempt):
    meta = ctx["tasks"][task]
    cid = cell_id(task, rep, arm)
    wid, root_name = cell_names(ctx, task, rep, arm, attempt)
    clear_live(ctx)
    cell_root = os.path.join(ctx["ab_root"], LIVE, root_name)
    os.makedirs(cell_root)
    cell_root = os.path.realpath(cell_root)
    home, tmp, workdir = os.path.join(cell_root, "home"), os.path.join(cell_root, "tmp"), os.path.join(cell_root, wid)
    os.makedirs(tmp)
    os.makedirs(workdir)
    make_cell_home(ctx, arm, home)
    truth = os.path.join(ctx["batch_dir"], "truth", wid + ".truth.json")
    try:
        return _run_cell(ctx, meta, task, rep, arm, attempt, cid, wid, workdir, home, tmp, truth, cell_root)
    finally:
        pack_away(ctx, wid, workdir, tmp, truth, cell_root, home, cid, attempt)


def _calls_text(events):
    return "\n".join(str((e.get("data") or {}).get("arguments") or "") for e in events if e.get("type") == "tool/call")


def _run_cell(ctx, meta, task, rep, arm, attempt, cid, wid, workdir, home, tmp, truth, cell_root):
    batch_dir = ctx["batch_dir"]
    started = time.time()
    cell = {"cell": cid, "batch": ctx["batch"], "task": task, "alias": meta["alias"], "arm": arm, "rep": rep, "attempt": attempt,
            "workdir": workdir, "home": home, "cell_root": cell_root, "offline": ctx["offline"], "started": now(), "turns": []}
    res = task_call(meta.get("dir"), "setup", workdir, seed=task_seed(ctx, task, rep) if meta.get("seeded") else None)
    if "error" in res:
        cell.update({"status": "error", "valid": False, "invalid_reasons": ["setup failed: " + res["error"][-300:]], "infra": False})
        return cell
    # The oracle sidecar (<workdir>.truth.json, r5) sits in the vault while turns run and comes back for verify().
    sidecar = workdir + ".truth.json"
    if os.path.exists(sidecar):
        os.makedirs(os.path.dirname(truth), exist_ok=True)
        shutil.move(sidecar, truth)
    prompts = meta["prompts"]
    if meta.get("probe"):
        probe = ctx["probe_builder"](ctx, meta, arm, workdir, home, cell_root)
        prompts = [probe["prompt"]]
        cell["probe_spec"] = probe["public"]
    patches = [ctx["steps_patch"](meta["max_steps_per_turn"])] + ([ctx["offline_patch"]] if ctx["offline"] else [])
    watch = [ctx["ab_root"], os.path.dirname(ctx["ab_root"]), "/private/tmp"]
    before = {d: top_entries(d) for d in watch}
    wt_before = worktree_state(ctx["ab_root"])
    sid = None
    budget_stopped = False
    for n, prompt in enumerate(prompts, 1):
        if ctx["budget"].exhausted():
            budget_stopped = True
            break
        timeout = meta.get("turn_timeout_s", 900)
        timeout = timeout[n - 1] if isinstance(timeout, list) else timeout
        base = os.path.join(batch_dir, "turns", f"{cid}.a{attempt}.t{n}")
        t = run_turn(ctx, cid, home, workdir, patches, sid, prompt, base + ".jsonl", base + ".err", timeout, tmp=tmp)
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
        hook = task_call(meta.get("dir"), "after_turn", workdir, n)
        if "error" in hook:
            cell["hook_error"] = hook["error"][-300:]
            break
    wt_after = worktree_state(ctx["ab_root"])
    cell["worktrees_changed"] = sorted(n for n in set(wt_before) | set(wt_after) if wt_before.get(n) != wt_after.get(n))
    cell["sid"] = sid
    cell["wall_s"] = round(time.time() - started, 1)
    cell["ended"] = now()
    cell["spend_peak_usd"] = round(sum(t["charge_usd"] for t in cell["turns"]), 6)
    cell["model_error_turns"] = [{"turn": t["turn"], "kind": (t.get("turn_end") or {}).get("kind"), "code": t.get("error_code")} for t in cell["turns"] if t.get("model_error")]
    cell["strays_killed"] = sum(max((t.get("isolation") or {}).get("strays_killed") or 0, 0) for t in cell["turns"])
    log_path = find_log(home, sid)
    events = []
    if log_path:
        events, bad = ab_metrics.load_events(log_path)
    cell["quarantined"] = quarantine_new_entries(ctx, before, _calls_text(events), os.path.join(batch_dir, "quarantine", f"{cid}.a{attempt}"))
    if budget_stopped:
        why = "unpriced-step limit reached" if ctx["budget"].too_many_unpriced() else "budget cap reached"
        cell.update({"status": "budget_stop", "valid": False, "invalid_reasons": [why], "infra": False})
        return cell
    complete = len(cell["turns"]) == len(prompts) and all(turn_ok(t) for t in cell["turns"])
    if os.path.exists(truth):
        shutil.copy(truth, sidecar)
    try:
        ver = task_call(meta.get("dir"), "verify", workdir) if complete else {"ok": False, "detail": "session incomplete", "info": {}}
    finally:
        if os.path.exists(sidecar):
            os.remove(sidecar)
    if "error" in ver:
        ver = {"ok": False, "detail": "verify crashed: " + ver["error"][-300:], "info": {}}
    if ver.get("skipped"):
        ver = {"ok": complete, "detail": "no verify (synthetic task)", "info": {}}
    cell.update({"pass": bool(ver.get("ok")), "detail": ver.get("detail"), "verify_info": ver.get("info") or {}})
    cell["exam_class"] = answer_class(bool(ver.get("ok")), ver.get("detail"), ver.get("info") or {}) if meta.get("recall") else None
    row = None
    specs = cell_specs(meta, truth)
    if log_path:
        # the home (and the log in it) moves into the vault when the cell ends; record where it will be
        cell["log"] = os.path.join(batch_dir, "homes", os.path.basename(cell_root), os.path.relpath(log_path, home))
        row = ab_metrics.metrics(events, exams=specs["exams"], in_turn=[(e["turn"], e["tokens"]) for e in specs["in_turn"]],
                                 prices=ctx["prices"], bad_lines=bad, delivery=[(e["turn"], e["tokens"]) for e in specs["delivery"]])
        cell["metrics"] = row
    if meta.get("probe"):
        cell["probe"] = ctx["probe_evaluator"](ctx, meta, cell, events)
    reasons = validity(ctx, arm, dict(meta, **specs), cell["turns"], row, complete)
    if not complete:
        reasons.insert(0, f"completed {len(cell['turns'])}/{len(prompts)} turns")
    if cell["worktrees_changed"]:
        reasons.append(f"isolation: worktree {', '.join(cell['worktrees_changed'])} changed during the cell (git status)")
    infra = any(t["infra"] for t in cell["turns"]) or (complete and row is None)
    exam_turn = max((e["turn"] for e in specs["exams"]), default=None)
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


def cell_specs(meta, truth):
    """Exam, delivery and in-turn token specs of a cell: meta.json's, plus (meta truth_specs) those a seeded task wrote
    into its truth sidecar with the oracle values it generated. The sidecar sits in the vault until the cell is packed."""
    out = {k: list(meta.get(k) or []) for k in ("exams", "delivery", "in_turn")}
    if meta.get("truth_specs") and truth and os.path.exists(truth):
        rec = load_json(truth) or {}
        for k in out:
            out[k] += list(rec.get(k) or [])
    return out


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
                                     "oracle_via_fs", "secret_flags", "spend_peak_usd", "wall_s", "sid", "log", "started", "ended", "strays_killed", "quarantined",
                                     "worktrees_changed")} | {
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
        "child_dsh_env": {k: ("<the cell's home>" if v is None else v) for k, v in DSH_ENV_SET.items()},
        "child_tmpdir": "<the cell's private tmp>",
        "removed_dsh_env_names": [k for k in dsh if k not in DSH_ENV_SET],
        "dsh_permission_mode": "unset in the child (profile default workspace-write)",
    }


def host_digest(ab):
    """sha256 over (path, size, mtime) of every file of the frozen host: equal at batch start and end, or a cell wrote there."""
    h = hashlib.sha256()
    base = os.path.join(ab, "host")
    for d, dirs, files in os.walk(base):
        dirs.sort()
        for f in sorted(files):
            p = os.path.join(d, f)
            try:
                st = os.lstat(p)
            except OSError:
                continue
            h.update(f"{os.path.relpath(p, base)}\0{st.st_size}\0{st.st_mtime_ns}\n".encode("utf-8", "surrogateescape"))
    return h.hexdigest()


def write_offline_adapter(ab):
    """Copy the scripted adapter out of the worktree (which is blocked while turns run) into AB/mock/, next to a
    package.json whose peers admit the host: the host attributes a path row to the nearest package.json above it."""
    d = os.path.join(ab, MOCK)
    os.makedirs(d, exist_ok=True)
    shutil.copy(os.path.join(HERE, "mock-llm.mjs"), os.path.join(d, "mock-llm.mjs"))
    root = load_json(os.path.join(REPO_ROOT, "package.json"), {})
    peers = {k: v for k, v in (root.get("peerDependencies") or {}).items() if k.startswith("@deepseek-ai/")}
    write_json(os.path.join(d, "package.json"), {"name": "ab-mock-llm", "private": True, "type": "module", "version": "0.0.0", "peerDependencies": peers})
    return os.path.join(d, "mock-llm.mjs")


def write_harness_plugins(ab):
    """Copy the harness's own plugin rows (step-cap.mjs) to AB/plugins/, next to a package.json whose peers admit the
    host, like the offline adapter. Read-only while a turn runs."""
    d = os.path.join(ab, PLUGINS)
    os.makedirs(d, exist_ok=True)
    shutil.copy(os.path.join(HERE, "step-cap.mjs"), os.path.join(d, "step-cap.mjs"))
    root = load_json(os.path.join(REPO_ROOT, "package.json"), {})
    peers = {k: v for k, v in (root.get("peerDependencies") or {}).items() if k.startswith("@deepseek-ai/")}
    write_json(os.path.join(d, "package.json"), {"name": "ab-harness-plugins", "private": True, "type": "module", "version": "0.0.0", "peerDependencies": peers})
    return os.path.join(d, "step-cap.mjs")


def steps_patch_text(n, mode, plugin_path=None):
    """The per-task step cap, identical across arms. mode "slice" (the P1-10 runs): the slice plugin's own
    maxStepsPerTurn. mode "harness" (slice-vs-stock): the harness's step-cap row, inserted in every arm, because the
    stock arms have no slice row and the host has no step limit."""
    if mode == "harness":
        return (f"# Per-task step cap, identical across arms: the harness's own row (scripts/ab/step-cap.mjs).\n"
                f"- insert:\n    - id: ab-step-cap\n      name: '{plugin_path}'\n      config:\n        maxStepsPerTurn: {n}\n")
    return f"# Per-task step cap, identical across arms.\n- id: slice-agent-loop\n  config:\n    maxStepsPerTurn: {n}\n"


def worktree_blocks(ab):
    """scripts/ and docs/ of every worktree under AB/wt (see WT_BLOCKED)."""
    out = []
    wt = os.path.join(ab, WT)
    for name in sorted(os.listdir(wt)) if os.path.isdir(wt) else []:
        out += [os.path.join(wt, name, sub) for sub in WT_BLOCKED if os.path.isdir(os.path.join(wt, name, sub))]
    return out


def worktree_state(ab):
    """Per worktree under AB/wt: a digest of `git status` with untracked and ignored entries (bytecode left out). The
    worktrees' source trees stay readable and writable while a turn runs; a file a cell left there would reach a later
    cell, so a change between a cell's first and last turn makes the cell invalid."""
    out = {}
    wt = os.path.join(ab, WT)
    for name in sorted(os.listdir(wt)) if os.path.isdir(wt) else []:
        d = os.path.join(wt, name)
        if not os.path.exists(os.path.join(d, ".git")):
            continue
        try:
            r = subprocess.run(["git", "-C", d, "status", "--porcelain=v1", "--ignored", "-uall", "-z"], capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.SubprocessError) as exc:
            out[name] = f"error: {exc}"
            continue
        if r.returncode != 0:
            out[name] = f"git exit {r.returncode}"
            continue
        entries = sorted(e for e in r.stdout.split("\0") if e and "__pycache__/" not in e and not e.endswith(".pyc"))
        out[name] = hashlib.sha256("\0".join(entries).encode("utf-8", "surrogateescape")).hexdigest()
    return out


def load_gates(path):
    return load_json(path) or {}


def make_ctx(args, ab, tasks, offline, batch):
    batch_dir = vault(ab, "results", batch)
    for sub in ("cells", "turns", "workdirs", "homes", "truth"):
        os.makedirs(os.path.join(batch_dir, sub), exist_ok=True)
    patch_dir = os.path.join(ab, PATCHES, batch)
    os.makedirs(patch_dir, exist_ok=True)
    prices = ab_metrics.load_prices()
    offline_patch = None
    if offline:
        mock = write_offline_adapter(ab)
        offline_patch = os.path.join(patch_dir, "eval-offline.patch.yml")
        with open(os.path.join(HERE, "eval-offline.patch.yml"), encoding="utf-8") as fh:
            text = fh.read().replace("__MOCK_LLM__", mock)
        with open(offline_patch, "w", encoding="utf-8") as fh:
            fh.write(text)

    gates = load_gates(getattr(args, "gates", None) or GATES_DEFAULT)
    step_mode = gates.get("step_cap", "slice")
    cap_plugin = write_harness_plugins(ab) if step_mode == "harness" else None

    def steps_patch(n):
        p = os.path.join(patch_dir, f"steps-{n}.patch.yml")
        text = steps_patch_text(n, step_mode, cap_plugin)
        if not os.path.exists(p) or open(p, encoding="utf-8").read() != text:
            with open(p, "w", encoding="utf-8") as fh:
                fh.write(text)
        return p

    ledger = os.path.join(batch_dir if offline else vault(ab), "spend.jsonl")
    no_fp = (getattr(args, "fingerprints", None) or "").lower() == "none"
    fp_path = None if no_fp else (getattr(args, "fingerprints", None) or vault(ab, "fingerprints.json"))
    blocked = [vault(ab)] + worktree_blocks(ab) + list(getattr(args, "block", None) or [])
    os.makedirs(os.path.join(ab, LIVE), exist_ok=True)
    read_only = [ab] + [os.path.join(ab, d) for d in (LIVE, PATCHES, MOCK, WT, PLUGINS, "host")] + [patch_dir]
    ctx = {
        "ab_root": ab, "bin": os.path.join(ab, BIN_REL), "tasks": tasks, "batch": batch, "batch_dir": batch_dir,
        "offline": offline, "resume": getattr(args, "resume", False), "max_attempts": getattr(args, "max_attempts", 2), "prices": prices,
        "poll_s": getattr(args, "poll_s", 1.0),
        "budget": Budget(ledger, args.budget_usd, args.budget_reserve_usd, args.budget_margin_usd, prices[prices.get("budget_sheet", "peak")],
                         args.unpriced_step_usd, args.max_unpriced_steps),
        "fingerprints": load_json(fp_path) if fp_path and os.path.exists(fp_path) else None, "fingerprints_path": fp_path, "no_fp": no_fp,
        "structure": gates.get("structure"), "gates_file": getattr(args, "gates", None) or GATES_DEFAULT, "step_cap_mode": step_mode,
        "steps_patch": steps_patch, "offline_patch": offline_patch, "index": os.path.join(batch_dir, "index.jsonl"),
        "isolation": Isolation(ab, blocked, read_only), "ledger": ledger,
    }
    return ctx


def install_unblock_guards(ctx):
    iso = ctx["isolation"]

    def restore():
        if iso.blocked:
            iso.unblock()
    atexit.register(restore)

    def on_signal(signum, frame):
        raise SystemExit(128 + signum)  # unwinds through run_turn's finally, which kills the turn and unblocks
    for s in (signal.SIGTERM, signal.SIGINT):
        signal.signal(s, on_signal)


def check_homes(ab, arms, offline):
    for arm in arms:
        home = template_home(ab, arm)
        if not os.path.isdir(os.path.join(home, "profiles", PROFILE)):
            raise SystemExit(f"{home}: profile {PROFILE!r} missing; run `run_ab.py prepare` first")
        has_env = os.path.lexists(os.path.join(home, ".env"))
        if offline and has_env:
            raise SystemExit(f"{home}/.env exists: --offline refuses to run where a model key is reachable")
        if not offline and not has_env:
            raise SystemExit(f"{home}/.env missing: link the key (ln -s ~/.dsh/.env {home}/.env) before a paid run")


def progress(ab, text):
    try:
        with open(os.path.join(ab, "progress.txt"), "w", encoding="utf-8") as fh:
            fh.write(f"{now()} {text}\n")
    except OSError:
        pass


def arm_order(arms, rep, seed):
    """The arms of one (task, rep) pair, in run order: the first arm rotates with (rep - 1 + seed), so with two arms
    and seeds 20261022 (batch) and 20261023 (arbitration) each arm goes first in 3 of the 6 reps."""
    k = (rep - 1 + seed) % len(arms)
    return arms[k:] + arms[:k]


def cmd_run(args):
    ab = os.path.realpath(args.ab_root)
    if args.parallel_arms:
        raise SystemExit("--parallel-arms is not supported: a cell's turns run only while no other cell exists (docs/p110-f-native-ab.md §3)")
    tasks = load_tasks()
    arms = [a.strip() for a in args.arms.split(",") if a.strip()]
    check_homes(ab, arms, args.offline)
    selected = select_tasks(args.tasks, tasks)
    ctx = make_ctx(args, ab, tasks, args.offline, args.batch)
    install_unblock_guards(ctx)
    manifest_path = os.path.join(ctx["batch_dir"], f"manifest-{dt.datetime.now().strftime('%Y%m%dT%H%M%S')}.json")
    manifest = {
        "batch": args.batch, "started": now(), "argv": sys.argv, "arms": arms, "tasks": selected, "reps": args.reps, "seed": args.seed,
        "order": "one cell at a time; per (task, rep) the arms run back to back, the first arm rotating with (rep - 1 + seed)",
        "offline": args.offline, "budget_usd": args.budget_usd, "budget_reserve_usd": args.budget_reserve_usd,
        "budget_margin_usd": args.budget_margin_usd, "unpriced_step_usd": args.unpriced_step_usd, "max_unpriced_steps": args.max_unpriced_steps,
        "budget_sheet": ctx["prices"].get("budget_sheet", "peak"), "ledger": ctx["ledger"], "spent_at_start": round(ctx["budget"].total(), 6),
        "host_version": load_json(os.path.join(ab, "host", "node_modules", "@deepseek-ai", "dsh", "package.json"), {}).get("version"),
        "host_tree_digest_start": host_digest(ab),
        "fingerprints": ctx["fingerprints_path"] if ctx["fingerprints"] else ("none (not checked)" if ctx["no_fp"] else None),
        "gates_file": ctx["gates_file"], "arm_packages": load_json(vault(ab, "arms.json"), {}), "step_cap_mode": ctx["step_cap_mode"],
        "mock_env": {k: os.environ[k] for k in sorted(os.environ) if k.startswith("AB_MOCK_")} if args.offline else {},
        "isolation": {"blocked_while_a_turn_runs": ctx["isolation"].paths, "read_only_while_a_turn_runs": ctx["isolation"].ro_paths,
                      "cell_layout": "AB/live/c-<id>/{home,tmp,w-<id>}", "one_cell_at_a_time": True,
                      "strays": "processes naming live/c-<id> in their command line or environment, or with a cwd in it, are killed before unblocking",
                      "worktrees": "git status of every AB/wt worktree must not change during a cell"},
        "python": sys.version.split()[0], "harness_commit": git_head(),
    } | env_record()
    write_json(manifest_path, manifest)
    log(f"batch {args.batch}: arms={arms} tasks={[tasks[t]['alias'] for t in selected]} reps={args.reps} offline={args.offline} "
        f"budget=${args.budget_usd} spent=${ctx['budget'].total():.4f} fingerprints={'yes' if ctx['fingerprints'] else 'no'} blocked={ctx['isolation'].paths}")
    stopped = False
    # --reps-from-gates: per-task reps from the gates file's unit.reps (by alias); --reps is then the ceiling
    per_task = (load_gates(args.gates or GATES_DEFAULT).get("unit") or {}).get("reps") if args.reps_from_gates else None
    if args.reps_from_gates and not isinstance(per_task, dict):
        raise SystemExit("--reps-from-gates: the gates file has no unit.reps table")

    def reps_of(task):
        return min(args.reps, per_task.get(tasks[task]["alias"], args.reps)) if per_task else args.reps
    manifest["reps_per_task"] = {tasks[t]["alias"]: reps_of(t) for t in selected}
    write_json(manifest_path, manifest)
    total, done = sum(reps_of(t) for t in selected) * len(arms), 0
    for rep in range(1, args.reps + 1):
        order = [t for t in selected if rep <= reps_of(t)]
        random.Random(f"{args.seed}:{rep}").shuffle(order)
        rotated = arm_order(arms, rep, args.seed)
        for task in order:
            if not ctx["budget"].can_start() or ctx["budget"].exhausted():
                why = "unpriced steps" if ctx["budget"].too_many_unpriced() else "spend"
                log(f"budget ({why}): spent ${ctx['budget'].total():.4f}, unpriced steps {ctx['budget'].unpriced_total()}, cap ${args.budget_usd}; stopping before {task} rep {rep}")
                stopped = True
                break
            for arm in rotated:
                run_cell_with_retries(ctx, task, rep, arm)
                done += 1
                progress(ab, f"batch {args.batch}: {done}/{total} cells, spend ${ctx['budget'].total():.4f}")
        if stopped:
            break
    stopped = stopped or ctx.get("budget_stopped", False)
    manifest.update({"ended": now(), "host_tree_digest_end": host_digest(ab)})
    manifest["host_unchanged"] = manifest["host_tree_digest_end"] == manifest["host_tree_digest_start"]
    write_json(manifest_path, manifest)
    log(f"batch {args.batch} {'STOPPED (budget)' if stopped else 'finished'}; spent ${ctx['budget'].total():.4f} of ${args.budget_usd}; "
        f"unpriced steps {ctx['budget'].unpriced_total()}; host unchanged {manifest['host_unchanged']}")
    progress(ab, f"batch {args.batch}: {'stopped' if stopped else 'finished'} {done}/{total} cells, spend ${ctx['budget'].total():.4f}")
    return 2 if stopped else 0


# ---------------------------------------------------------------------------- isolation probe

PROBE_META = {"name": "isolation_probe", "alias": "probe", "turns": 1, "max_steps_per_turn": 40, "turn_timeout_s": 300, "recall": False,
              "dir": None, "prompts": ["(built at run time)"], "synthetic": True}


def _probe_targets(ctx, arm, other_arms, target_batch):
    """Protected paths a cell must not read, as (path, class, canary-or-None). Canaries are planted by the caller."""
    ab = ctx["ab_root"]
    out = []
    for o in other_arms:
        out.append((os.path.join(template_home(ab, o), "probe-canary.txt"), "other arm's template DSH_HOME", True))
        out.append((os.path.join(template_home(ab, o), "profiles", PROFILE, "package.json"), "other arm's template DSH_HOME", None))
    out.append((vault(ab, "probe-canary.txt"), "A/B state root", True))
    out.append((os.path.join(ctx["batch_dir"], "manifest-probe-canary.json"), "run manifest", True))
    out.append((os.path.join(ctx["batch_dir"], "truth", "w-probecanary.truth.json"), "truth file", True))
    for d in worktree_blocks(ab):
        out.append((os.path.join(d, "probe-canary.txt"), "worktree " + os.path.relpath(d, os.path.join(ab, WT)), True))
    for p in sorted(glob.glob(os.path.join(ab, WT, "*", "scripts", "ab", "tasks", "p110_r4_probe_compare", "meta.json"))):
        out.append((p, "task oracle in a worktree", None))
    tb = vault(ab, "results", target_batch)
    cells = [load_json(p) or {} for p in sorted(glob.glob(os.path.join(tb, "cells", "*.json")))]
    for p in sorted(glob.glob(os.path.join(tb, "manifest-*.json")))[-1:]:
        out.append((p, "run manifest", None))
    for name, klass in (("index.jsonl", "A/B state"), ("spend.jsonl", "ledger")):
        if os.path.exists(os.path.join(tb, name)):
            out.append((os.path.join(tb, name), klass, None))
    for c in cells:
        if c.get("arm") in other_arms and c.get("log"):
            out.append((c["log"], "other arm's session log (finished cell home)", None))
            out.append((os.path.join(tb, "homes", os.path.basename(c.get("cell_root") or "x")), "other arm's finished cell home", None))
            break
    for c in cells:
        if c.get("arm") in other_arms:
            wid = os.path.basename(c.get("workdir") or "")
            if wid and os.path.exists(os.path.join(tb, "workdirs", wid + ".tgz")):
                out.append((os.path.join(tb, "workdirs", wid + ".tgz"), "other arm's packed workdir", None))
                break
    for p in sorted(glob.glob(os.path.join(tb, "turns", "*.jsonl.gz")))[:1]:
        out.append((p, "turn stream", None))
    for name in ("arms.json", "fingerprints.json"):
        if os.path.exists(vault(ab, name)):
            out.append((vault(ab, name), "A/B state", None))
    out.append((vault(ab), "A/B state root (listing)", None))
    for d in worktree_blocks(ab):
        out.append((d, "worktree " + os.path.relpath(d, os.path.join(ab, WT)) + " (listing)", None))
    out.append((vault(ab, "homes"), "template homes (listing)", None))
    return out


def probe_builder_for(mode, target_batch, arms):
    def build(ctx, meta, arm, workdir, home, cell_root):
        others = [a for a in arms if a != arm]
        canaries = {}
        targets = []
        for path, klass, plant in _probe_targets(ctx, arm, others, target_batch):
            token = None
            if plant:
                token = "CANARY-" + pysecrets.token_hex(8)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(token + "\n")
                canaries[path] = token
            targets.append({"path": path, "class": klass, "canary": token})
        own = "OWNCANARY-" + pysecrets.token_hex(8)
        ctx.setdefault("probe_plants", [])
        with open(os.path.join(workdir, "probe-own.txt"), "w", encoding="utf-8") as fh:
            fh.write(own + "\n")
        ctx.setdefault("probe_plants", []).extend(canaries)
        quoted = " ".join("'" + t["path"].replace("'", "'\\''") + "'" for t in targets)
        lines = ["[isolation-probe]"]
        extra = {}
        if mode == "tamper":
            v = vault(ctx["ab_root"])
            canary = targets[[t["class"] for t in targets].index("A/B state root")]
            lines.append(f"BASH: chmod 755 '{v}' && cat '{canary['path']}'; chmod 000 '{v}'")
            # a file left in a worktree's source tree (readable and writable while a turn runs): git status must catch it
            wts = sorted(glob.glob(os.path.join(ctx["ab_root"], WT, "*", "src")))
            if wts:
                left = os.path.join(wts[0], "probe-tamper-" + pysecrets.token_hex(6) + ".txt")
                lines.append(f"BASH: printf x > '{left}'; echo LEFT")
                ctx["probe_plants"].append(left)
                extra["worktree_file"] = left
        else:
            # background jobs that outlive the bash call, one in its own session (beyond the turn's process group):
            # both must be gone before the vault is readable again
            lines.append("BASH: nohup sleep 600 >/dev/null 2>&1 &")
            lines.append("BASH: python3 -c 'import os, sys, time; os.fork() and sys.exit(0); os.setsid(); time.sleep(600)' >/dev/null 2>&1 &")
            # one more that also drops the cell's DSH_HOME and TMPDIR (found by its PWD and its cwd in the workdir)
            esc = "ESCAPE-" + pysecrets.token_hex(6)
            lines.append("BASH: env -u DSH_HOME -u TMPDIR python3 -c 'import os, sys, time; os.fork() and sys.exit(0); os.setsid(); time.sleep(600)' "
                         + esc + " >/dev/null 2>&1 &")
            # files left for a later cell: in the harness's own directories (read-only while a turn runs) ...
            wtok = "probe-write-" + pysecrets.token_hex(6)
            dirs = list(ctx["isolation"].ro_paths)
            ctx["probe_plants"].extend(os.path.join(d, wtok) for d in dirs)
            lines.append("BASH: for d in " + " ".join("'" + d + "'" for d in dirs) + "; do if (printf x > \"$d/" + wtok + "\") 2>/dev/null; "
                         "then echo \"WRITE-OK $d\"; else echo \"WRITE-DENIED $d\"; fi; done")
            # ... and in /tmp under a name given only relative to a cd (quarantined by its bare name)
            qname = "probeq" + pysecrets.token_hex(6)
            lines.append(f"BASH: cd /tmp && mkdir -p {qname} && echo {own} > {qname}/a.txt; echo PLANTED")
            extra.update({"escape_token": esc, "write_dirs": dirs, "write_token": wtok, "tmp_plant": os.path.join("/private/tmp", qname)})
            lines.append("BASH: for p in " + quoted + "; do if out=$( (if [ -d \"$p\" ]; then ls -la \"$p\"; else head -c 400 \"$p\"; fi) 2>&1); "
                         "then printf 'READ-OK %s %s\\n' \"$p\" \"$(printf %s \"$out\" | tr '\\n' ' ' | head -c 300)\"; "
                         "else printf 'DENIED %s %s\\n' \"$p\" \"$(printf %s \"$out\" | tr '\\n' ' ' | head -c 160)\"; fi; done")
            lines.append(f"BASH: ls -1 '{os.path.join(ctx['ab_root'], LIVE)}'; ls -1 '{ctx['ab_root']}'; cat probe-own.txt; cat '{os.path.join(home, 'profiles', PROFILE, 'package.json')}' | head -c 80")
            for t in targets:
                if t["canary"]:
                    lines.append("READ: " + t["path"])
            lines.append("GLOB: " + vault(ctx["ab_root"]))
            lines.append("GREP: " + vault(ctx["ab_root"]))
            for d in worktree_blocks(ctx["ab_root"]):
                lines.append("GREP: " + d)
            lines.append("READ: probe-own.txt")
        public = {"mode": mode, "targets": targets, "own_canary": own, "cell_root": cell_root, "live": os.path.join(ctx["ab_root"], LIVE)} | extra
        ctx.setdefault("probe_specs", {})[(meta["alias"], arm)] = public
        return {"prompt": "\n".join(lines) + "\n", "public": public}
    return build


def probe_evaluate(ctx, meta, cell, events):
    spec = cell.get("probe_spec") or {}
    results = [ab_metrics.text_of((e.get("data") or {}).get("message")) for e in events if e.get("type") == "tool/result"]
    blob = "\n".join(results)
    rows, ok = [], True
    if spec.get("mode") == "tamper":
        breaches = [b for t in cell["turns"] for b in ((t.get("isolation") or {}).get("breaches") or [])]
        # Either the chmod went through and the harness saw it, or the sandbox refused the chmod itself.
        denied = "[sandbox: file access denied" in blob
        wt_seen = bool(cell.get("worktrees_changed")) or not spec.get("worktree_file")
        return {"mode": "tamper", "breaches_detected": breaches, "chmod_denied_by_sandbox": denied, "worktree_change_detected": wt_seen,
                "ok": (bool(breaches) or denied) and wt_seen}
    for t in spec.get("targets", []):
        line = re.search(r"^(READ-OK|DENIED) " + re.escape(t["path"]) + r"(?: |$)", blob, re.M)
        state = line.group(1) if line else "not reported"
        leaked = bool(t["canary"] and t["canary"] in blob)
        good = state == "DENIED" and not leaked
        ok = ok and good
        rows.append({"path": t["path"], "class": t["class"], "bash": state, "canary_leaked": leaked, "ok": good})
    own_ok = spec.get("own_canary", "~") in blob
    live_listing = re.search(r"^(c-[0-9a-f]{10})$", blob, re.M)
    live_names = sorted(set(re.findall(r"^(c-[0-9a-f]{10})$", blob, re.M)))
    live_ok = live_names == [os.path.basename(spec.get("cell_root", ""))]
    tool_errors = [ab_metrics.text_of((e.get("data") or {}).get("message"))[:200] for e in events
                   if e.get("type") == "tool/result" and ((e.get("data") or {}).get("message") or {}).get("isError")]
    strays = sum(max((t.get("isolation") or {}).get("strays_killed") or 0, 0) for t in cell["turns"])
    left = survivors(cell_marker(cell["cell_root"]))
    escaped = survivors(spec["escape_token"]) if spec.get("escape_token") else 0
    writes = {d: (re.search(r"^(WRITE-OK|WRITE-DENIED) " + re.escape(d) + r"$", blob, re.M) or [None, "not reported"])[1] for d in spec.get("write_dirs", [])}
    writes_ok = all(v == "WRITE-DENIED" for v in writes.values())
    plant = spec.get("tmp_plant")
    plant_ok = not plant or (not os.path.exists(plant) and plant in (cell.get("quarantined") or []))
    return {"mode": "read", "targets": rows, "own_files_readable": own_ok, "live_shows_only_this_cell": live_ok and bool(live_listing),
            "live_entries": live_names, "tool_errors": tool_errors, "strays_killed": strays, "processes_left": left,
            "escapee_left": escaped, "writes": writes, "tmp_plant_quarantined": plant_ok,
            "ok": ok and own_ok and live_ok and left == 0 and escaped == 0 and writes_ok and plant_ok}


def cmd_probe(args):
    ab = os.path.realpath(args.ab_root)
    arms = [a.strip() for a in args.arms.split(",") if a.strip()]
    check_homes(ab, arms, offline=True)
    args.budget_usd, args.budget_reserve_usd, args.budget_margin_usd = None, 0.0, 0.0
    args.unpriced_step_usd, args.max_unpriced_steps, args.resume, args.max_attempts = 0.05, None, False, 1
    args.fingerprints = "none"
    report = {"created": now(), "arms": arms, "target_batch": args.target_batch, "cells": []}
    ok = True
    for mode in ("read", "tamper"):
        meta = dict(PROBE_META, alias="probe" if mode == "read" else "tamper", name="isolation_probe" if mode == "read" else "tamper_probe", probe=mode)
        tasks = {meta["name"]: meta}
        ctx = make_ctx(args, ab, tasks, True, args.batch)
        ctx["probe_builder"] = probe_builder_for(mode, args.target_batch, arms)
        ctx["probe_evaluator"] = probe_evaluate
        install_unblock_guards(ctx)
        for arm in arms:
            cell = run_cell(ctx, meta["name"], 1, arm, int(time.time()))
            write_json(os.path.join(ctx["batch_dir"], "cells", cell_id(meta["name"], 1, arm) + ".json"), cell)
            for p in ctx.pop("probe_plants", []):
                if os.path.exists(p):
                    os.remove(p)
            pr = cell.get("probe") or {"ok": False, "note": "no probe result (log missing?)"}
            if mode == "tamper":
                pr["cell_invalid"] = not cell.get("valid")
                pr["ok"] = pr.get("ok", False) and (pr["cell_invalid"] or pr.get("chmod_denied_by_sandbox", False))
            ok = ok and pr.get("ok", False)
            report["cells"].append({"arm": arm, "mode": mode, "cell": cell["cell"], "status": cell.get("status"), "reasons": cell.get("invalid_reasons"), "probe": pr})
            log(f"probe {mode} {arm}: ok={pr.get('ok')} status={cell.get('status')}")
    report["ok"] = ok
    out = vault(ab, "results", args.batch, "probe.json")
    write_json(out, report)
    print(json.dumps(report, indent=1))
    return 0 if ok else 1


# ---------------------------------------------------------------------------- prepare

def dump_rows(text):
    """Rows of a --dump-config listing, by id: {id: [lines]}, provenance comments excluded, plus the comments by row."""
    rows, comments, cur, pending = {}, {}, None, []
    for line in text.splitlines():
        if line.startswith("#"):
            pending.append(line)
            continue
        if line.startswith("- id: "):
            cur = line[len("- id: "):].strip()
            rows[cur] = []
            comments[cur] = list(pending)
            pending = []
        if cur is not None:
            rows[cur].append(line)
    return rows, comments


def compare_dumps(base_text, other_text, allowed=()):
    """Row-level comparison of two dumps. Returns (differing row ids, rows only in base, rows only in other, unexpected):
    `unexpected` lists every difference not covered by `allowed` (the arm's declared own rows)."""
    a, _ = dump_rows(base_text)
    b, _ = dump_rows(other_text)
    differ = sorted(k for k in set(a) & set(b) if a[k] != b[k])
    only_a, only_b = sorted(set(a) - set(b)), sorted(set(b) - set(a))
    order_a = [k for k in a if k in b]
    order_b = [k for k in b if k in a]
    unexpected = [k for k in differ + only_a + only_b if k not in allowed]
    if order_a != order_b:
        unexpected.append("(row order)")
    return differ, only_a, only_b, unexpected


def cmd_prepare(args):
    ab = os.path.realpath(args.ab_root)
    binp = os.path.join(ab, BIN_REL)
    arms = {}
    for spec in args.arm:
        arm, _, tgz = spec.partition("=")
        arms[arm] = None if tgz in ("", "none") else os.path.realpath(tgz)
    arm_overlays = {}
    for spec in args.arm_overlay or []:
        arm, _, path = spec.partition("=")
        if arm not in arms:
            raise SystemExit(f"--arm-overlay {spec}: no arm {arm!r}")
        arm_overlays.setdefault(arm, []).append(os.path.realpath(path))
    overlay = os.path.realpath(args.overlay or os.path.join(PROFILE_DIR, "eval-parity.patch.yml"))
    gates = load_gates(args.gates) if args.gates else {}
    structure = gates.get("structure") or {}
    os.makedirs(vault(ab, "artifacts"), exist_ok=True)
    os.makedirs(vault(ab, "homes"), exist_ok=True)
    manifest = {}
    with open(os.path.join(PROFILE_DIR, "package.json"), encoding="utf-8") as fh:
        profile_pkg = json.load(fh)
    for arm, tgz in arms.items():
        home = template_home(ab, arm)
        prof = os.path.join(home, "profiles", PROFILE)
        if os.path.exists(home):
            if not args.force:
                raise SystemExit(f"{home} exists (use --force to rebuild it)")
            if os.path.lexists(os.path.join(home, ".env")):
                raise SystemExit(f"{home}/.env exists; refusing to rebuild a home that holds a key link")
            shutil.rmtree(home)
        os.makedirs(prof)
        for name in ("pnpm-workspace.yaml", "cordis.yml"):
            shutil.copy(os.path.join(PROFILE_DIR, name), os.path.join(prof, name))
        # The profile lists the host bundles only; `dsh plugin add` appends the plugin's bundle (an arm without a
        # plugin is the host's own composition).
        pkg = json.loads(json.dumps(profile_pkg))
        pkg["dsh"]["profile"]["bundles"] = [b for b in pkg["dsh"]["profile"]["bundles"] if b != SLICE_BUNDLE]
        write_json(os.path.join(prof, "package.json"), pkg)
        parts = [overlay] + arm_overlays.get(arm, [])
        with open(os.path.join(prof, "cordis.patch.yml"), "w", encoding="utf-8") as out:
            for i, part in enumerate(parts):
                with open(part, encoding="utf-8") as fh:
                    out.write(("" if i == 0 else f"\n# ---- arm overlay {os.path.basename(part)}\n") + fh.read())
        env = child_env(home, offline=True)
        rec = {"home": home, "overlays": parts, "overlay_sha256": [sha256_file(p) for p in parts]}
        if tgz:
            digest = sha256_file(tgz)
            # The profile's package.json records the install source; an arm-neutral name keeps the arm out of a cell's home.
            neutral = vault(ab, "artifacts", f"plugin-{digest[:12]}.tgz")
            if os.path.realpath(tgz) != neutral:
                shutil.copy(tgz, neutral)
            with open(vault(ab, f"prepare-{arm}.log"), "w", encoding="utf-8") as fh:
                subprocess.run(["node", binp, "plugin", "--profile", PROFILE, "add", neutral, "--ignore-scripts"], cwd=home, env=env, stdout=fh, stderr=subprocess.STDOUT, check=True, timeout=600)
            rec.update({"tgz": tgz, "installed_from": neutral, "sha256": digest})
            print(f"prepared {arm}: {os.path.basename(tgz)} sha256 {digest[:12]} (installed as {os.path.basename(neutral)})")
        else:
            rec.update({"tgz": None, "plugin": "none (the host's own composition)"})
            print(f"prepared {arm}: no plugin")
        with open(vault(ab, f"dump-{arm}.yml"), "w", encoding="utf-8") as fh:
            subprocess.run(["node", binp, "--profile", PROFILE, "--dump-config"], cwd=home, env=env, stdout=fh, stderr=subprocess.PIPE, check=True, timeout=120)
        rec["bundles"] = (load_json(os.path.join(prof, "package.json")) or {}).get("dsh", {}).get("profile", {}).get("bundles")
        manifest[arm] = rec
    write_json(vault(ab, "arms.json"), manifest)
    names = list(arms)

    def dump_text(arm):
        # Provenance comments name the arm's own home ("patched by <home>/profiles/ab/cordis.patch.yml"); normalize that path only.
        with open(vault(ab, f"dump-{arm}.yml"), encoding="utf-8") as fh:
            return fh.read().replace(template_home(ab, arm), template_home(ab, "<arm>"))

    base_arm = gates.get("baseline") if gates.get("baseline") in arms else names[0]
    base = dump_text(base_arm)
    ok = True
    report = {"baseline": base_arm, "arms": {}}
    for arm in names:
        if arm == base_arm:
            continue
        allowed = (structure.get(arm) or {}).get("dump_rows", [])
        differ, only_base, only_arm, unexpected = compare_dumps(base, dump_text(arm), allowed)
        report["arms"][arm] = {"differing_rows": differ, "rows_only_in_baseline": only_base, "rows_only_in_arm": only_arm,
                               "declared": allowed, "unexpected": unexpected}
        if unexpected or sorted(differ + only_base + only_arm) != sorted(allowed):
            ok = False
            print(f"dump-config {arm} vs {base_arm}: differing {differ}, only in {base_arm} {only_base}, only in {arm} {only_arm}; "
                  f"declared {allowed}; unexpected {unexpected}")
        else:
            print(f"dump-config {arm} vs {base_arm}: differs exactly in the declared rows {allowed} ({len(base.splitlines())} lines in {base_arm})")
    write_json(vault(ab, "dump-compare.json"), report)
    return 0 if ok else 1


# ---------------------------------------------------------------------------- fingerprints

DELTA_KEYS = ("prefix_delta_vs_control", "system_delta_vs_control", "slice_tools_delta_vs_control")


def cmd_fingerprints(args):
    cells = [load_json(p) for p in sorted(glob.glob(os.path.join(args.batch_dir, "cells", "*.json"))) if not p.endswith(".budget_stop.json")]
    cells = [c for c in cells if c and not c.get("probe_spec")]
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
    bname = getattr(args, "baseline", None) or "control"
    base = out["arms"].get(bname)
    out["baseline"] = bname
    for arm, fp in out["arms"].items():
        if base and arm != bname:
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
    for path in sorted(glob.glob(vault(ab, "results", "*", "cells", "*.json"))):
        c = load_json(path) or {}
        for f in ((c.get("metrics") or {}).get("flagged_access") or []):
            if f.get("secret"):
                hits.append({"cell": c.get("cell"), "batch": c.get("batch"), "turn": f.get("turn"), "tool": f.get("tool"), "reasons": f.get("reasons"),
                             "hold_back": [c.get("log"), vault(ab, "results", c.get("batch") or "?", "turns", f"{c.get('cell')}.a{c.get('attempt')}.t*")]})
    print(json.dumps({"secret_references": hits}, indent=1))
    return 1 if hits else 0


def add_budget_args(ap):
    ap.add_argument("--budget-usd", type=float, default=10.0)
    ap.add_argument("--budget-reserve-usd", type=float, default=0.75)
    ap.add_argument("--budget-margin-usd", type=float, default=0.60)
    ap.add_argument("--unpriced-step-usd", type=float, default=0.05)
    ap.add_argument("--max-unpriced-steps", type=int, default=40)


def main(argv):
    if argv and argv[0] == "_task_call":
        return _task_call_main(argv[1:])
    subs = ("prepare", "run", "fingerprints", "secrets-scan", "isolation-probe", "unblock")
    sub = argv[0] if argv and argv[0] in subs else "run"
    rest = argv[1:] if argv and argv[0] in subs else argv
    ap = argparse.ArgumentParser(prog="run_ab.py " + sub, description=__doc__.split("\n\n")[0])
    if sub == "prepare":
        ap.add_argument("--ab-root", required=True)
        ap.add_argument("--arm", action="append", required=True, help="name=path/to/arm.tgz, or name=none for the host's own composition (repeatable)")
        ap.add_argument("--overlay", help="overlay every arm's profile gets as cordis.patch.yml (default profile/eval-parity.patch.yml)")
        ap.add_argument("--arm-overlay", action="append", help="name=path: a further overlay appended for that arm only (repeatable)")
        ap.add_argument("--gates", help="gates file: its baseline and structure[arm].dump_rows declare the rows an arm's dump may differ in")
        ap.add_argument("--force", action="store_true")
        return cmd_prepare(ap.parse_args(rest))
    if sub == "fingerprints":
        ap.add_argument("--batch-dir", required=True)
        ap.add_argument("--out")
        ap.add_argument("--compare", help="fingerprints.json whose control-vs-arm deltas must be reproduced")
        ap.add_argument("--baseline", default="control", help="arm the deltas are taken against (slice-vs-stock: stock)")
        return cmd_fingerprints(ap.parse_args(rest))
    if sub == "secrets-scan":
        ap.add_argument("--ab-root", required=True)
        return cmd_secrets_scan(ap.parse_args(rest))
    if sub == "unblock":
        ap.add_argument("--ab-root", required=True)
        return unblock_from_state(os.path.realpath(ap.parse_args(rest).ab_root))
    if sub == "isolation-probe":
        ap.add_argument("--ab-root", required=True)
        ap.add_argument("--arms", default="control,F")
        ap.add_argument("--batch", default="isoprobe")
        ap.add_argument("--target-batch", default="offline", help="the dry-run batch whose finished cells the probe tries to read")
        ap.add_argument("--block", action="append", help="another path to block while a turn runs (repeatable)")
        ap.add_argument("--gates", help="gates file with the arm structure (default scripts/ab/gates-f.json)")
        ap.add_argument("--poll-s", type=float, default=1.0)
        return cmd_probe(ap.parse_args(rest))
    ap.add_argument("--ab-root", required=True)
    ap.add_argument("--arms", default="control,F")
    ap.add_argument("--tasks", default="all")
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--reps-from-gates", action="store_true", help="per-task reps from the gates file's unit.reps (capped by --reps)")
    ap.add_argument("--batch", required=True)
    ap.add_argument("--gates", help="gates file whose 'structure' defines each arm's tape forms (default scripts/ab/gates-f.json; "
                                    "the 2026-09-27 batch used gates.json)")
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--resume", action="store_true")
    add_budget_args(ap)
    ap.add_argument("--poll-s", type=float, default=1.0)
    ap.add_argument("--parallel-arms", action="store_true", help="refused: cells run one at a time (isolation)")
    ap.add_argument("--seed", type=int, default=20261022)
    ap.add_argument("--fingerprints", help="fingerprints.json (default AB/vault/fingerprints.json), or 'none' to skip the check (warmup only)")
    ap.add_argument("--max-attempts", type=int, default=2)
    ap.add_argument("--block", action="append", help="another path to block while a turn runs (repeatable)")
    return cmd_run(ap.parse_args(rest))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
