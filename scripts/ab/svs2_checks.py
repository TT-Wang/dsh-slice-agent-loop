#!/usr/bin/env python3
"""svs2_checks.py: the same-conditions checks of the svs2 ablation (docs/svs2-ablation-2026-10-24.md §3), offline.

usage:
  svs2_checks.py conditions [--gates scripts/ab/gates-svs2.json] [--tree b111e434]
      The files that define what a cell sees are byte-identical to the baseline harness tree (git tree of scripts/ab
      at the freeze commit 35df351): the task definitions of hello, c1, c2, r2 and f1 (every file, and no file added
      or missing), the price sheet, the step-cap row, the neutral overlay, the profile template and the offline
      adapter; and the per-task step-cap patch this harness writes equals the baseline's patch files (archive
      patches/<batch>/steps-<N>.patch.yml) apart from the A/B root in the plugin path.
  svs2_checks.py host --host AB/host [--gates G]
      The host's (path, size, mtime) tree digest and its content digest equal the baseline's (gates
      pairing.baseline_conditions), and its dsh version is 0.2.1-rc.2.
  svs2_checks.py f1-content --salt FILE [--gates G] [--archive DIR]
      With the given salt, run_ab.task_seed and f1's setup() produce, for every f1 rep index, the same truth sidecar
      (sha256) as the packed workdir of its baseline cell (both arms), and the same data files. Runs in a temporary
      directory that is removed afterwards; prints hashes only, never a value.
Exit 0 only if every check holds.
"""
import argparse
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import run_ab  # noqa: E402

GATES_DEFAULT = os.path.join(HERE, "gates-svs2.json")
# What a cell's conditions depend on, relative to scripts/ab (task directories are compared file by file).
CONDITION_TASKS = ("hello", "lh1_incremental_build", "m3_consistency_bugfix", "p110_r2_superseded_stamp", "svs_f1_flood_recall")
CONDITION_FILES = ("prices.json", "step-cap.mjs", "mock-llm.mjs", "eval-offline.patch.yml", "profile/eval-neutral.patch.yml",
                   "profile/package.json", "profile/pnpm-workspace.yaml", "profile/cordis.yml")


def git(*args):
    return subprocess.run(["git", "-C", HERE] + list(args), capture_output=True, timeout=60)


def tree_files(tree, sub):
    """{relative path: blob bytes} of a directory of the git tree (recursive)."""
    r = git("ls-tree", "--full-tree", "-r", "--name-only", f"{tree}:{sub}")  # --full-tree: git -C scripts/ab would filter by the cwd
    if r.returncode != 0:
        return None
    out = {}
    for name in r.stdout.decode().splitlines():
        out[name] = git("show", f"{tree}:{sub}/{name}").stdout
    return out


def disk_files(d):
    out = {}
    for root, dirs, files in os.walk(d):
        dirs[:] = sorted(x for x in dirs if x != "__pycache__")
        for f in sorted(files):
            if f.endswith(".pyc"):
                continue
            p = os.path.join(root, f)
            with open(p, "rb") as fh:
                out[os.path.relpath(p, d)] = fh.read()
    return out


def check_conditions(gates, tree):
    res = {"tree": tree, "items": [], "ok": True}

    def item(name, ok, note=""):
        res["items"].append({"what": name, "ok": ok, "note": note})
        res["ok"] = res["ok"] and ok
    for t in CONDITION_TASKS:
        want = tree_files(tree, f"tasks/{t}")
        have = disk_files(os.path.join(HERE, "tasks", t))
        if want is None:
            item(f"tasks/{t}", False, "not in the tree")
            continue
        missing, added = sorted(set(want) - set(have)), sorted(set(have) - set(want))
        changed = sorted(k for k in set(want) & set(have) if want[k] != have[k])
        item(f"tasks/{t}", not (missing or added or changed),
             f"{len(want)} files" + (f"; missing {missing}" if missing else "") + (f"; added {added}" if added else "") + (f"; changed {changed}" if changed else ""))
    for f in CONDITION_FILES:
        want = git("show", f"{tree}:{f}")
        with open(os.path.join(HERE, f), "rb") as fh:
            have = fh.read()
        item(f, want.returncode == 0 and want.stdout == have, "sha256 " + hashlib.sha256(have).hexdigest()[:12])
    # the step-cap patch text, against the baseline's own patch files (archive patches/<batch>/), path normalized
    archive_root = os.path.dirname(os.path.dirname(os.path.expanduser(gates["pairing"]["baseline_archive"])))  # <root>/vault/results
    old_ab = os.path.dirname(os.path.dirname(gates["pairing"]["baseline_old_root"]))
    tasks = run_ab.load_tasks()
    for alias in gates["unit"]["tasks"]:
        meta = next(m for m in tasks.values() if m["alias"] == alias)
        n = meta["max_steps_per_turn"]
        for batch in sorted({b for b, _ in gates["pairing"]["baseline_cells"][alias].values()}):
            p = os.path.join(archive_root, "patches", batch, f"steps-{n}.patch.yml")
            if not os.path.exists(p):
                item(f"step cap {alias} ({batch})", False, f"{p} missing")
                continue
            with open(p, encoding="utf-8") as fh:
                base = fh.read()
            mine = run_ab.steps_patch_text(n, gates.get("step_cap", "slice"), os.path.join(old_ab, run_ab.PLUGINS, "step-cap.mjs"))
            item(f"step cap {alias} = {n} ({batch})", mine == base, "the patch text equals the baseline's with the A/B root swapped")
    return res


def check_host(gates, host):
    bc = gates["pairing"]["baseline_conditions"]
    content, files, links = run_ab.host_content_digest(host)
    tree = run_ab.host_digest(None, host)
    version = run_ab.load_json(os.path.join(host, "node_modules", "@deepseek-ai", "dsh", "package.json"), {}).get("version")
    want_version = bc["host"].rsplit("@", 1)[1]
    res = {"host": os.path.realpath(host), "dsh_version": version, "tree_digest": tree, "content_digest": content, "files": files, "symlinks": links,
           "tree_as_baseline": tree == bc["host_tree_digest"], "content_as_baseline": content == bc["host_content_digest"],
           "version_as_baseline": version == want_version}
    res["ok"] = res["tree_as_baseline"] and res["content_as_baseline"] and res["version_as_baseline"]
    return res


def check_f1_content(gates, salt, archive=None):
    pr = gates["pairing"]
    archive = os.path.realpath(os.path.expanduser(archive or pr["baseline_archive"]))
    tasks = run_ab.load_tasks()
    name = next(n for n, m in tasks.items() if m["alias"] == "f1")
    meta = tasks[name]
    res = {"salt_sha256_matches_gates": run_ab.sha256_file(salt) == pr.get("salt_sha256"), "reps": [], "ok": True}
    tmp = tempfile.mkdtemp(prefix="svs2-f1-")
    try:
        ab = os.path.join(tmp, "ab")
        os.makedirs(os.path.join(ab, run_ab.VAULT))
        shutil.copy(salt, os.path.join(ab, run_ab.VAULT, "task-seed-salt"))
        for idx in sorted(pr["seed_keys"]["f1"], key=int):
            # a new batch of any name: the seed key comes from the gates map, not from the batch
            ctx = {"ab_root": ab, "batch": "svs2-check", "tasks": tasks, "seed_keys": pr["seed_keys"]}
            seed = run_ab.task_seed(ctx, name, int(idx))
            wd = os.path.join(tmp, f"w{idx}")
            os.makedirs(wd)
            r = run_ab.task_call(meta["dir"], "setup", wd, seed=seed)
            if "error" in r:
                res["reps"].append({"rep": int(idx), "ok": False, "note": "setup failed"})
                res["ok"] = False
                continue
            with open(wd + ".truth.json", "rb") as fh:
                truth_sha = hashlib.sha256(fh.read()).hexdigest()
            mine = {os.path.relpath(os.path.join(d, f), wd): run_ab.sha256_file(os.path.join(d, f))
                    for d, _, fs in os.walk(os.path.join(wd, "data")) for f in fs}
            batch, brep = pr["baseline_cells"]["f1"][idx]
            row = {"rep": int(idx), "baseline": f"{batch} r{brep}", "truth_sha256": truth_sha[:16], "data_files": len(mine), "arms": {}}
            for arm in gates["baseline_arms"]:
                c = run_ab.load_json(os.path.join(archive, batch, "cells", f"{name}.r{brep}.{arm}.json")) or {}
                wid = os.path.basename(c.get("workdir") or "")
                with tarfile.open(os.path.join(archive, batch, "workdirs", wid + ".tgz"), "r:gz") as tar:
                    t = tar.extractfile(tar.getmember(wid + ".truth.json")).read()
                    base_data = {}
                    for m in tar.getmembers():
                        if m.isfile() and m.name.startswith(wid + "/data/"):
                            base_data[os.path.relpath(m.name, wid)] = hashlib.sha256(tar.extractfile(m).read()).hexdigest()
                same = hashlib.sha256(t).hexdigest() == truth_sha and base_data == mine
                row["arms"][arm] = {"truth_equal": hashlib.sha256(t).hexdigest() == truth_sha, "data_equal": base_data == mine}
                res["ok"] = res["ok"] and same
            res["reps"].append(row)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    res["ok"] = res["ok"] and res["salt_sha256_matches_gates"]
    return res


def main(argv):
    sub = argv[0] if argv and argv[0] in ("conditions", "host", "f1-content") else None
    if sub is None:
        print(__doc__)
        return 2
    ap = argparse.ArgumentParser(prog="svs2_checks.py " + sub)
    ap.add_argument("--gates", default=GATES_DEFAULT)
    if sub == "conditions":
        ap.add_argument("--tree", default=None, help="git tree of scripts/ab to compare with (default: gates baseline_conditions.scripts_ab_tree)")
    elif sub == "host":
        ap.add_argument("--host", required=True)
    else:
        ap.add_argument("--salt", required=True)
        ap.add_argument("--archive")
    a = ap.parse_args(argv[1:])
    gates = run_ab.load_json(a.gates)
    if sub == "conditions":
        res = check_conditions(gates, a.tree or gates["pairing"]["baseline_conditions"]["scripts_ab_tree"])
    elif sub == "host":
        res = check_host(gates, a.host)
    else:
        res = check_f1_content(gates, a.salt, a.archive)
    print(json.dumps(res, indent=1))
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
