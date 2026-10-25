#!/usr/bin/env python3
"""svs2_report.py: the svs2 ablation report (docs/svs2-ablation-2026-10-24.md §5-§8).

usage:
  svs2_report.py import-baseline --out DIR [--gates scripts/ab/gates-svs2.json] [--archive DIR]
      Read-only import of the baseline SLICE and STOCK cells of 2026-10-23 that gates pairing.baseline_cells names.
      Every cell's metrics row is recomputed from its archived session log with this harness's ab_metrics (one
      extractor for the baseline and the new arms), with the exam and delivery specs of its task (f1: from the truth
      sidecar inside its packed workdir, read in memory) and the gates file's system-prompt markers. Every metric the
      baseline stored must be reproduced, and so must its memory-exclusion flags; the new keys (rereads, system markers,
      kept-raw entries) are added. Writes DIR/cells/<task>.r<rep index>.<arm>.json (the rep is the svs2 rep index, the
      source cell is in _baseline) and DIR/import.json. Exit 1 if anything stored is not reproduced.

  svs2_report.py report <batch-dir> [<batch-dir> ...] --baseline DIR [--gates G] [--pooled] [--ledger FILE] [--out DIR]
      Pairs the new arms' cells (A, B, C) with the imported baseline cells by task and rep index and evaluates the
      pre-registered comparisons: per arm N_code and R_f1 against STOCK, the same against SLICE, the quality floor,
      the interpretation rule, the steps between arms (A/SLICE, B/A, C/B, C/A), re-read classes, requests and step-cap
      cuts per turn. Without --pooled also the arbitration test. Writes summary.json and summary.md to --out (default:
      the first batch dir). Counts, ratios and paired deltas only, no p-values.

  svs2_report.py rereads <cells-dir-or-batch-dir> [...]
      The re-read classes per arm and task of any cells (e.g. the imported baseline: c1 stock vs slice cross-turn 27 vs
      59, after own edit 9 vs 28, edits/writes 84 vs 168).
"""
import argparse
import glob
import io
import json
import math
import os
import statistics
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ab_metrics  # noqa: E402
import run_ab  # noqa: E402
import svs_report  # noqa: E402

GATES_DEFAULT = os.path.join(HERE, "gates-svs2.json")
RR_KEYS = ("first", "cross_turn", "same_turn", "after_own_edit", "reads", "edits_writes", "bash_writes", "fs_not_observed", "fs_stale_version")


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def write_json(path, obj):
    run_ab.write_json(path, obj)


# ---------------------------------------------------------------------------- import of the baseline cells

def rebase(path, old_root, new_root):
    """A path recorded under the baseline's scratch A/B root, moved to the archive copy of the same tree."""
    if path and path.startswith(old_root.rstrip("/") + "/"):
        return os.path.join(new_root, path[len(old_root.rstrip("/")) + 1:])
    return path


def truth_from_packed(archive, batch, cell):
    """The truth sidecar of a packed baseline workdir, read in memory (it holds oracle values: never written out)."""
    wid = os.path.basename(cell.get("workdir") or "")
    tgz = os.path.join(archive, batch, "workdirs", wid + ".tgz")
    if not wid or not os.path.exists(tgz):
        return None
    with tarfile.open(tgz, "r:gz") as tar:
        try:
            member = tar.getmember(wid + ".truth.json")
        except KeyError:
            return None
        fh = tar.extractfile(member)
        return json.load(io.TextIOWrapper(fh, encoding="utf-8")) if fh else None


def diff_stored(stored, new, path=""):
    """Every place where a value the baseline stored differs from the recomputed row (keys the baseline did not have are
    new metrics and are not compared)."""
    out = []
    if isinstance(stored, dict):
        if not isinstance(new, dict):
            return [path or "(root)"]
        for k, v in stored.items():
            if k not in new:
                out.append(f"{path}.{k}: missing")
            else:
                out += diff_stored(v, new[k], f"{path}.{k}")
        return out
    if isinstance(stored, list):
        if not isinstance(new, list) or len(stored) != len(new):
            return [f"{path}: list differs"]
        for i, (a, b) in enumerate(zip(stored, new)):
            out += diff_stored(a, b, f"{path}[{i}]")
        return out
    return [] if stored == new else [f"{path}: {str(stored)[:40]} != {str(new)[:40]}"]


def import_baseline(gates, out, archive=None):
    pr = gates["pairing"]
    archive = os.path.realpath(os.path.expanduser(archive or pr["baseline_archive"]))
    tasks = run_ab.load_tasks()
    by_alias = {m["alias"]: n for n, m in tasks.items()}
    markers = run_ab.structure_markers(gates.get("structure"))
    prices = ab_metrics.load_prices()
    os.makedirs(os.path.join(out, "cells"), exist_ok=True)
    report = {"archive": archive, "harness_commit": run_ab.git_head(), "system_markers": markers, "cells": [], "mismatches": {}}
    for alias, reps in pr["baseline_cells"].items():
        name = by_alias[alias]
        meta = tasks[name]
        for idx, (batch, brep) in sorted(reps.items(), key=lambda kv: int(kv[0])):
            for arm in gates["baseline_arms"]:
                src = os.path.join(archive, batch, "cells", f"{name}.r{brep}.{arm}.json")
                c = load(src)
                log = rebase(c.get("log"), pr["baseline_old_root"], archive)
                if not log or not os.path.exists(log):
                    report["mismatches"][src] = ["session log not found in the archive"]
                    continue
                events, bad = ab_metrics.load_events(log)
                truth = truth_from_packed(archive, batch, c) if meta.get("truth_specs") else None
                if meta.get("truth_specs") and truth is None:
                    report["mismatches"][src] = ["truth sidecar not found in the packed workdir"]
                    continue
                specs = run_ab.cell_specs(meta, None, truth_rec=truth)
                row = ab_metrics.metrics(events, exams=specs["exams"], in_turn=[(e["turn"], e["tokens"]) for e in specs["in_turn"]],
                                         prices=prices, bad_lines=bad, delivery=[(e["turn"], e["tokens"]) for e in specs["delivery"]],
                                         system_markers=markers)
                diffs = diff_stored(c.get("metrics") or {}, row)
                flags = run_ab.exam_flags(row, specs)
                diffs += [f"cell.{k}: {c.get(k)} != {v}" for k, v in flags.items() if c.get(k) != v]
                if diffs:
                    report["mismatches"][src] = diffs[:20]
                new = {k: v for k, v in c.items() if k != "metrics"}
                new.update({"metrics": row, "rep": int(idx), "batch": "baseline", "cell": f"{name}.r{idx}.{arm}",
                            "_baseline": {"batch": batch, "rep": brep, "cell": c.get("cell"), "source": src, "log": log,
                                          "log_sha256": run_ab.sha256_file(log), "recomputed_by": report["harness_commit"]}})
                write_json(os.path.join(out, "cells", new["cell"] + ".json"), new)
                report["cells"].append({"cell": new["cell"], "from": f"{batch}/{c.get('cell')}", "valid": c.get("valid"), "pass": c.get("pass"),
                                        "cost_peak": row["usage"]["cost_peak"], "stored_metrics_reproduced": not diffs})
    report["rereads"] = reread_table(collect_dir(out))
    report["ok"] = not report["mismatches"] and bool(report["cells"])
    write_json(os.path.join(out, "import.json"), report)
    return report


# ---------------------------------------------------------------------------- cells, sides, pairs

def collect_dir(d):
    """(alias, rep, arm) -> [cells] of one batch or cells directory (budget and account stops left out)."""
    cdir = os.path.join(d, "cells") if os.path.isdir(os.path.join(d, "cells")) else d
    out = {}
    for path in sorted(glob.glob(os.path.join(cdir, "*.json"))):
        if path.endswith((".budget_stop.json", ".account_stop.json")):
            continue
        c = load(path)
        if "alias" not in c or "arm" not in c:
            continue
        c["_batch"] = os.path.basename(os.path.normpath(d))
        out.setdefault((c["alias"], c["rep"], c["arm"]), []).append(c)
    return out


def merge(*cell_maps):
    out = {}
    for m in cell_maps:
        for k, v in m.items():
            out.setdefault(k, []).extend(v)
    return out


def values(c):
    """svs_report.values plus the svs2 per-cell quantities (re-read classes, kept-raw entries, turns)."""
    v = svs_report.values(c)
    if v is None:
        return None
    m = c["metrics"]
    rr = m.get("rereads") or {}
    v.update({"rr_" + k: rr.get(k, 0) for k in RR_KEYS})
    v["kept_raw_entries"] = (m.get("tape") or {}).get("kept_raw_entries", 0)
    v["turns"] = len([k for k in (m.get("per_turn") or {}) if k not in ("None", None)])
    return v


def side(cells):
    """One side of a pair: the mean over its valid cells (one per batch; the arbitration adds a second). Memory uses the
    cells not excluded from the memory comparison; the side is memory-excluded when none is left."""
    vs = [values(c) for c in cells or [] if c.get("valid") and c.get("metrics")]
    vs = [v for v in vs if v is not None]
    if not vs:
        return None
    mean = lambda k, xs=vs: sum(x[k] for x in xs) / len(xs)  # noqa: E731
    out = {"n": len(vs), "cost": mean("cost"), "cost_peak": mean("cost_peak"), "pass": mean("pass"), "requests": mean("requests"),
           "cells": [f"{c['cell']}@{c.get('_batch')}" for c in cells if c.get("valid")]}
    mem = [v for v in vs if not v["memory_excluded"]]
    if mem:
        items = sorted({k for v in mem for k in v["memory"]})
        out.update({"memory_excluded": False, "memory_correct": mean("memory_correct", mem), "memory_bad": mean("memory_bad", mem),
                    "memory_total": max(v["memory_total"] for v in mem),
                    "memory": {k: sum(1 for v in mem if v["memory"].get(k)) / len(mem) for k in items}})
    else:
        out.update({"memory_excluded": True, "memory_correct": 0, "memory_bad": 0, "memory_total": 0, "memory": {}})
    return out


def geomean(xs):
    xs = [x for x in xs if x is not None and x > 0]
    return math.exp(sum(math.log(x) for x in xs) / len(xs)) if xs else None


def rnd(x, nd=4):
    return round(x, nd) if isinstance(x, (int, float)) and x is not None else x


def compare(cells, gates, arm, other):
    """arm against other over the planned (task, rep index) pairs: per-task R (sum ratio of the sides), paired ratios,
    passes, memory; N_code, N_code3, R_f1; minimums."""
    unit, mins = gates["unit"], gates["min_pairs"]
    plan = gates["pairing"]["baseline_cells"]
    kept, dropped = [], []
    for t in unit["tasks"]:
        for r in sorted((int(x) for x in plan.get(t, {})), key=int):
            a, b = side(cells.get((t, r, arm))), side(cells.get((t, r, other)))
            if a is None or b is None:
                why = []
                if a is None:
                    why.append(f"no valid {arm} cell")
                if b is None:
                    why.append(f"no valid {other} cell")
                dropped.append(f"{t}.r{r}: " + ", ".join(why))
                continue
            kept.append(((t, r), a, b))
    tasks = {}
    for t in unit["tasks"]:
        ps = [(a, b) for (tt, _), a, b in kept if tt == t]
        ca, cb = sum(a["cost"] for a, _ in ps), sum(b["cost"] for _, b in ps)
        ratios = [a["cost"] / b["cost"] for a, b in ps if b["cost"] > 0]
        tasks[t] = {"pairs": len(ps), "min_pairs": mins["per_task"].get(t, 0), "cost_arm": rnd(ca, 6), "cost_base": rnd(cb, 6),
                    "R": rnd(ca / cb) if cb > 0 else None, "paired_ratios": [rnd(x) for x in ratios],
                    "median_paired_ratio": rnd(statistics.median(ratios)) if ratios else None,
                    "pass_arm": rnd(sum(a["pass"] for a, _ in ps), 3), "pass_base": rnd(sum(b["pass"] for _, b in ps), 3)}
        tasks[t]["dS"] = rnd(tasks[t]["pass_arm"] - tasks[t]["pass_base"], 3)
    R = {t: v["R"] for t, v in tasks.items()}

    def gm(ts):
        return rnd(geomean([R[t] for t in ts])) if ts and all(R.get(t) for t in ts) else None
    long_t = (unit.get("long_tasks") or [None])[0]
    mem = [(k, a, b) for k, a, b in kept if k[0] in unit["memory_tasks"]]
    mem_kept = [(k, a, b) for k, a, b in mem if not (a["memory_excluded"] or b["memory_excluded"])]
    items = sum(max(a["memory_total"], b["memory_total"]) for _, a, b in mem_kept)
    per_item = {}
    for (t, _), a, b in mem_kept:
        for name in sorted(set(a["memory"]) | set(b["memory"])):
            row = per_item.setdefault(f"{t}:{name}", {"arm": 0, "base": 0, "n": 0})
            row["arm"] = rnd(row["arm"] + a["memory"].get(name, 0), 3)
            row["base"] = rnd(row["base"] + b["memory"].get(name, 0), 3)
            row["n"] += 1
    M_a, M_b = sum(a["memory_correct"] for _, a, _ in mem_kept), sum(b["memory_correct"] for _, _, b in mem_kept)
    B_a, B_b = sum(a["memory_bad"] for _, a, _ in mem_kept), sum(b["memory_bad"] for _, _, b in mem_kept)
    insufficient = []
    if len(kept) < mins["per_arm_all"]:
        insufficient.append(f"{len(kept)} valid pairs < {mins['per_arm_all']}")
    insufficient += [f"{t}: {v['pairs']} pairs < {v['min_pairs']}" for t, v in tasks.items() if v["pairs"] < v["min_pairs"]]
    if items < mins["memory_items"]:
        insufficient.append(f"{items} memory items < {mins['memory_items']}")
    tot_a, tot_b = sum(a["cost"] for _, a, _ in kept), sum(b["cost"] for _, _, b in kept)
    all_ratios = [a["cost"] / b["cost"] for _, a, b in kept if b["cost"] > 0]
    return {
        "arm": arm, "against": other, "pairs": len(kept), "dropped_pairs": dropped, "tasks": tasks,
        "N_code": gm(unit["code_tasks"]), "N_code3": gm(unit.get("code_tasks_secondary") or []), "R_f1": R.get(long_t),
        "sum_ratio": rnd(tot_a / tot_b) if tot_b else None, "median_paired_ratio": rnd(statistics.median(all_ratios)) if all_ratios else None,
        "arm_cells_per_pair": sorted({a["n"] for _, a, _ in kept}),
        "dS": rnd(sum(a["pass"] for _, a, _ in kept) - sum(b["pass"] for _, _, b in kept), 3), "dS_t": {t: v["dS"] for t, v in tasks.items()},
        "memory": {"pairs": len(mem_kept), "items": items, "correct_arm": rnd(M_a, 3), "correct_base": rnd(M_b, 3), "dM": rnd(M_a - M_b, 3),
                   "bad_arm": rnd(B_a, 3), "bad_base": rnd(B_b, 3), "dB": rnd(B_a - B_b, 3), "per_item": per_item,
                   "dropped": [f"{k[0]}.r{k[1]}: memory exclusion" for k, a, b in mem if a["memory_excluded"] or b["memory_excluded"]]},
        "insufficient": insufficient,
    }


# ---------------------------------------------------------------------------- the pre-registered rules

def quality(cmp, dec):
    q, m = dec["quality_floor"], cmp["memory"]
    return (cmp["dS"] >= q["dS_min"] and all(v >= q["dS_t_min"] for v in cmp["dS_t"].values())
            and m["dM"] >= q["dM_min"] and m["dB"] <= q["dB_max"])


def interpret(Q, N, Rf, insufficient):
    """gates-svs2.json decision.rules for one arm against STOCK: the first rule that matches."""
    if insufficient or N is None or Rf is None:
        return "inconclusive", "a minimum is not met: " + "; ".join(insufficient or ["N_code or R_f1 not computable"])
    if not Q:
        return "quality floor fails", "the arm loses more than one pass or memory item to STOCK, or gains more than one bad answer"
    if N <= 1.10 and Rf <= 0.80:
        return "fixes the short-session overhead", f"N_code {N:.3f} <= 1.10 and R_f1 {Rf:.3f} <= 0.80"
    if N <= 1.10:
        return "fixes the short-session overhead but loses the long-session saving", f"N_code {N:.3f} <= 1.10, R_f1 {Rf:.3f} > 0.80"
    if Rf <= 0.80:
        return "does not fix the short-session overhead", f"N_code {N:.3f} > 1.10 (R_f1 {Rf:.3f} <= 0.80)"
    return "neither", f"N_code {N:.3f} > 1.10 and R_f1 {Rf:.3f} > 0.80"


def arbitration_needed(cmp, gates):
    """gates-svs2.json arbitration.trigger for one arm against STOCK, on a batch before pooling. Returns
    [(quantity, reason, tasks)]: the tasks that would get one more cell at every rep index."""
    dec, unit = gates["decision"], gates["unit"]
    Q = quality(cmp, dec)
    out = []
    if cmp["insufficient"]:
        low = sorted({t for t, v in cmp["tasks"].items() if v["pairs"] < v["min_pairs"]}) or list(unit["tasks"])
        out.append(("minimum", "minimum not met: " + "; ".join(cmp["insufficient"]), low))
    N, Rf = cmp["N_code"], cmp["R_f1"]
    if N is not None and Rf is not None:
        v0 = interpret(Q, N, Rf, [])[0]
        for d in (0.05, -0.05):
            if interpret(Q, N + d, Rf, [])[0] != v0:
                out.append(("N_code", f"interpretation moves to '{interpret(Q, N + d, Rf, [])[0]}' at N_code {N + d:.3f}", list(unit["code_tasks"])))
                break
        for d in (0.05, -0.05):
            if interpret(Q, N, Rf + d, [])[0] != v0:
                out.append(("R_f1", f"interpretation moves to '{interpret(Q, N, Rf + d, [])[0]}' at R_f1 {Rf + d:.3f}", list(unit["long_tasks"])))
                break
    q, m = dec["quality_floor"], cmp["memory"]
    marg_t = sorted(t for t, v in cmp["dS_t"].items() if v in (q["dS_t_min"], q["dS_t_min"] - 1))
    if cmp["dS"] in (q["dS_min"], q["dS_min"] - 1) or marg_t or m["dM"] in (q["dM_min"], q["dM_min"] - 1) or m["dB"] in (q["dB_max"], q["dB_max"] + 1):
        ts = marg_t or (list(unit["memory_tasks"]) if m["dM"] in (q["dM_min"], q["dM_min"] - 1) or m["dB"] in (q["dB_max"], q["dB_max"] + 1)
                        else sorted(t for t, v in cmp["dS_t"].items() if v < 0) or list(unit["tasks"]))
        out.append(("quality", f"quality floor at its margin (dS {cmp['dS']}, dS_t {cmp['dS_t']}, dM {m['dM']}, dB {m['dB']})", ts))
    return out


def step(cmp, dec):
    """A step between two arms: the geometric mean of R_c1 and R_c2 and R_f1, each labelled down / up / none."""
    st = dec["steps"]

    def lab(x):
        if x is None:
            return "not computable"
        return "moves the cost down" if x <= st["down"] else "moves the cost up" if x >= st["up"] else "no measurable effect at this n"
    return {"N_code": cmp["N_code"], "N_code_label": lab(cmp["N_code"]), "R_f1": cmp["R_f1"], "R_f1_label": lab(cmp["R_f1"]),
            "pairs": cmp["pairs"], "insufficient": cmp["insufficient"]}


# ---------------------------------------------------------------------------- reported quantities

def reread_table(cells):
    """Re-read classes summed per arm and task over valid cells (every cell of a side counts, not the side mean)."""
    out = {}
    for (t, r, a), cs in sorted(cells.items()):
        for c in cs:
            if not c.get("valid") or not c.get("metrics"):
                continue
            rr = c["metrics"].get("rereads")
            if rr is None:
                continue
            row = out.setdefault(a, {}).setdefault(t, {k: 0 for k in RR_KEYS} | {"cells": 0, "turns": 0})
            for k in RR_KEYS:
                row[k] += rr.get(k, 0)
            row["cells"] += 1
            row["turns"] += len([k for k in (c["metrics"].get("per_turn") or {}) if k not in ("None", None)])
    return out


def describe(cells):
    out = {}
    for (t, r, a), cs in sorted(cells.items()):
        for c in cs:
            v = values(c) if c.get("valid") else None
            if v is not None:
                out.setdefault(a, {}).setdefault(t, []).append(v)
    res = {}
    for a, tasks in out.items():
        for t, vs in tasks.items():
            def med(k):
                xs = [x[k] for x in vs if x.get(k) is not None]
                return statistics.median(xs) if xs else None
            res.setdefault(a, {})[t] = {
                "cells": len(vs), "pass": sum(x["pass"] for x in vs), "mean_cost_peak": rnd(sum(x["cost_peak"] for x in vs) / len(vs), 6),
                "median_cost_peak": med("cost_peak"), "median_requests": med("requests"), "median_requests_per_turn": med("requests_per_turn"),
                "median_steps_per_turn": med("max_step_mean"), "step_limit_turns": sum(x["step_limit_turns"] for x in vs),
                "turns": sum(x["turns"] for x in vs), "median_cache_hit_rate": med("cache_hit_rate"),
                "median_peak_request_tokens": med("peak_request_tokens"), "median_mean_request_tokens": med("mean_request_tokens"),
                "slice_folds": sum(x["slice_folds"] for x in vs), "kept_raw_entries": sum(x["kept_raw_entries"] for x in vs),
                "summaries": sum(x["summaries"] for x in vs), "prunes": sum(x["prunes"] for x in vs),
                "context_limit_errors": sum(x["context_limit_errors"] for x in vs),
                "memory_correct": sum(x["memory_correct"] for x in vs), "memory_total": sum(x["memory_total"] for x in vs),
                "memory_bad": sum(x["memory_bad"] for x in vs), "median_wall_s": med("wall_s"),
                "exams_recall_sourced": f"{sum(x['exams_recall_sourced'] for x in vs)}/{sum(x['exams'] for x in vs)}",
                "digest_missing": (sum(x["digest_missing"] or 0 for x in vs) if any(x["digest_missing"] is not None for x in vs) else None),
            }
    return res


def build_summary(batch_dirs, baseline_dir, gates, pooled=False, ledger=None):
    new = merge(*[collect_dir(b) for b in batch_dirs])
    base = collect_dir(baseline_dir)
    stray = sorted({k[2] for k in new} & set(gates["baseline_arms"]))
    cells = merge(new, {k: v for k, v in base.items() if k[2] in gates["baseline_arms"]})
    arms = [a for a in gates["arms"] if any(k[2] == a for k in new)]
    dec = gates["decision"]
    comparisons, interpretation, arbitration = {}, {}, {}
    for a in arms:
        for other in (gates["baseline"], gates["reference"]):
            comparisons[f"{a} vs {other}"] = compare(cells, gates, a, other)
        cmp = comparisons[f"{a} vs {gates['baseline']}"]
        Q = quality(cmp, dec)
        label, why = interpret(Q, cmp["N_code"], cmp["R_f1"], cmp["insufficient"])
        interpretation[a] = {"label": label, "because": why, "quality_floor_holds": Q, "N_code": cmp["N_code"], "R_f1": cmp["R_f1"],
                             "N_code3": cmp["N_code3"], "dS": cmp["dS"], "dM": cmp["memory"]["dM"], "dB": cmp["memory"]["dB"], "pooled": pooled}
        if not pooled:
            trig = arbitration_needed(cmp, gates)
            arbitration[a] = {"required": bool(trig), "reasons": [r for _, r, _ in trig],
                              "add": {q: ts for q, _, ts in trig}}
    steps = {}
    ref = gates["reference"]
    for x, y in (("a", ref), ("b", "a"), ("c", "b"), ("c", "a")):
        if x in arms and (y in arms or y == ref):
            steps[f"{x}/{y}"] = step(comparisons.get(f"{x} vs {y}") or compare(cells, gates, x, y), dec)
            steps[f"{x}/{y}"]["kind"] = "cross-batch (baseline of 2026-10-23)" if y in gates["baseline_arms"] else "within the batch"
    spend = None
    if ledger and os.path.exists(ledger):
        with open(ledger, encoding="utf-8") as fh:
            rows = [json.loads(l) for l in fh if l.strip()]
        by_batch = {}
        for r in rows:
            by_batch[r["batch"]] = round(by_batch.get(r["batch"], 0) + r.get("usd", 0), 6)
        spend = {"total_usd_peak_sheet": round(sum(r.get("usd", 0) for r in rows), 6), "by_batch": by_batch, "turns": len(rows)}
    warmup = {}
    for (t, r, a), cs in sorted(new.items()):
        for c in cs:
            if t == "hello" and c.get("metrics"):
                hits = c["metrics"]["usage"]["first_request_hits"]
                need = ((gates.get("structure") or {}).get(a) or {}).get("warm_min_cache_read", 4000)
                warmup.setdefault(a, []).append({"batch": c["_batch"], "rep": r, "step1_cache_read": hits[0] if hits else None, "min": need,
                                                 "ok": r < 2 or bool(hits and hits[0] >= need), "valid": c.get("valid")})
    all_new = [c for cs in new.values() for c in cs]
    return {
        "batches": [os.path.realpath(b) for b in batch_dirs], "baseline": os.path.realpath(baseline_dir), "pooled": pooled, "arms": arms,
        "baseline_arms_in_new_batches": stray, "cells_new": len(all_new), "valid_new": sum(1 for c in all_new if c.get("valid")),
        "invalid_new": [{"cell": c["cell"], "batch": c["_batch"], "reasons": c.get("invalid_reasons"), "infra": c.get("infra")} for c in all_new if not c.get("valid")],
        "interpretation": interpretation, "arbitration": arbitration, "comparisons": comparisons, "steps": steps,
        "rereads": reread_table(cells), "describe": describe(cells), "warmup": warmup, "spend": spend,
        "caveat": "cross-batch: the baseline cells ran on 2026-10-23, the new arms on another day, with no concurrent STOCK or SLICE control; "
                  "provider-side variance between the days (latency, cache retention, routing) is not separable from an arm effect. "
                  "B/A, C/B and C/A are within one batch.",
    }


def fmt(x, nd=3):
    if x is None:
        return "-"
    return f"{x:.{nd}f}" if isinstance(x, float) else str(x)


def render_md(s):
    L = ["# svs2 ablation summary", "",
         f"New batches: {', '.join(os.path.basename(b) for b in s['batches'])}{' (pooled)' if s['pooled'] else ''}; baseline: imported cells "
         f"({os.path.basename(s['baseline'])}). New cells {s['cells_new']} ({s['valid_new']} valid). Arms: {', '.join(s['arms'])}.", "",
         f"Caveat: {s['caveat']}"]
    if s["baseline_arms_in_new_batches"]:
        L.append(f"WARNING: baseline arms in the new batches ({s['baseline_arms_in_new_batches']}); they are not used.")
    if s["spend"]:
        L.append(f"Spend (peak sheet): ${s['spend']['total_usd_peak_sheet']:.4f} over {s['spend']['turns']} turns; by batch {s['spend']['by_batch']}.")
    L += ["", "## Interpretation per arm (pre-registered rules, gates-svs2.json)", "",
          "| arm | interpretation | N_code (c1, c2) | R_f1 | N_code3 (+r2) | dS | dM | dB | quality floor | arbitration |", "|---|---|---|---|---|---|---|---|---|---|"]
    for a, v in s["interpretation"].items():
        arb = s["arbitration"].get(a)
        L.append(f"| {a} | **{v['label']}** ({v['because']}) | {fmt(v['N_code'])} | {fmt(v['R_f1'])} | {fmt(v['N_code3'])} | {v['dS']} | {v['dM']} | {v['dB']} | "
                 f"{'holds' if v['quality_floor_holds'] else 'FAILS'} | {('required: ' + '; '.join(arb['reasons'])) if arb and arb['required'] else ('not required' if arb else '-')} |")
    if s["steps"]:
        L += ["", "## Steps between arms (which change moves the cost; reported)", "", "| step | kind | N_code | | R_f1 | | pairs |", "|---|---|---|---|---|---|---|"]
        for k, v in s["steps"].items():
            L.append(f"| {k} | {v['kind']} | {fmt(v['N_code'])} | {v['N_code_label']} | {fmt(v['R_f1'])} | {v['R_f1_label']} | {v['pairs']} |")
    for k, c in s["comparisons"].items():
        m = c["memory"]
        L += ["", f"## {k}", "",
              f"Pairs {c['pairs']} (arm cells per pair {c['arm_cells_per_pair']}); N_code {fmt(c['N_code'])}, R_f1 {fmt(c['R_f1'])}, N_code3 {fmt(c['N_code3'])}; "
              f"sum ratio {fmt(c['sum_ratio'])}, median paired ratio {fmt(c['median_paired_ratio'])}; dS {c['dS']}; memory {m['correct_arm']} vs {m['correct_base']} "
              f"of {m['items']} items (dM {m['dM']}), bad {m['bad_arm']} vs {m['bad_base']} (dB {m['dB']})."
              + (f" Insufficient: {'; '.join(c['insufficient'])}." if c["insufficient"] else ""), "",
              "| task | pairs/min | R | median paired | paired ratios | pass arm/base | dS_t |", "|---|---|---|---|---|---|---|"]
        for t, v in c["tasks"].items():
            L.append(f"| {t} | {v['pairs']}/{v['min_pairs']} | {fmt(v['R'])} | {fmt(v['median_paired_ratio'])} | {v['paired_ratios']} | {v['pass_arm']}/{v['pass_base']} | {v['dS']} |")
        if c["dropped_pairs"] or m["dropped"]:
            L += [""] + [f"- dropped: {x}" for x in c["dropped_pairs"] + m["dropped"]]
    L += ["", "## Re-read classes (sums over valid cells; reported)", "",
          "| arm | task | cells | turns | first | cross-turn | same-turn | after own edit | reads | edits/writes | bash writes | FS_NOT_OBSERVED | FS_STALE_VERSION |",
          "|" + "---|" * 13]
    for a, tasks in sorted(s["rereads"].items()):
        for t, r in sorted(tasks.items()):
            L.append(f"| {a} | {t} | {r['cells']} | {r['turns']} | {r['first']} | {r['cross_turn']} | {r['same_turn']} | {r['after_own_edit']} | {r['reads']} | "
                     f"{r['edits_writes']} | {r['bash_writes']} | {r['fs_not_observed']} | {r['fs_stale_version']} |")
    L += ["", "## Cost structure and context (valid cells; reported)", "",
          "| arm | task | cells | pass | mean $ peak | median requests | req/turn | steps/turn | step-cap cuts (of turns) | cache hit | peak req tokens | "
          "mean req tokens | folds | kept-raw entries | memory correct/total (bad) | median wall s |", "|" + "---|" * 16]
    for a, tasks in sorted(s["describe"].items()):
        for t, r in sorted(tasks.items()):
            L.append(f"| {a} | {t} | {r['cells']} | {r['pass']} | {fmt(r['mean_cost_peak'], 4)} | {fmt(r['median_requests'])} | {fmt(r['median_requests_per_turn'])} | "
                     f"{fmt(r['median_steps_per_turn'])} | {r['step_limit_turns']} of {r['turns']} | {fmt(r['median_cache_hit_rate'])} | {fmt(r['median_peak_request_tokens'])} | "
                     f"{fmt(r['median_mean_request_tokens'], 0)} | {r['slice_folds']} | {r['kept_raw_entries']} | {r['memory_correct']}/{r['memory_total']} ({r['memory_bad']}) | "
                     f"{fmt(r['median_wall_s'], 0)} |")
    if s["invalid_new"]:
        L += ["", "## Invalid new cells (not counted)", ""] + [f"- {c['cell']} ({c['batch']}), infra {c['infra']}: {'; '.join(c['reasons'] or [])[:300]}" for c in s["invalid_new"]]
    if s.get("warmup"):
        L += ["", "## Warmup (hello): step-1 cache read from rep 2 on", ""]
        for a, rows in sorted(s["warmup"].items()):
            L.append(f"- {a}: " + ", ".join(f"rep {w['rep']} {w['step1_cache_read']}{'' if w['ok'] else ' (LOW, min ' + str(w['min']) + ')'}" for w in rows))
    L += ["", "Ratios are the named arm over the other; cost on the off-peak sheet (peak is exactly 2x every field). The arm side of a pair is the mean of "
          "its valid cells at that rep index."]
    return "\n".join(L) + "\n"


def main(argv):
    sub = argv[0] if argv and argv[0] in ("import-baseline", "report", "rereads") else "report"
    rest = argv[1:] if argv and argv[0] in ("import-baseline", "report", "rereads") else argv
    ap = argparse.ArgumentParser(prog="svs2_report.py " + sub, description=__doc__.split("\n\n")[0])
    ap.add_argument("--gates", default=GATES_DEFAULT)
    if sub == "import-baseline":
        ap.add_argument("--archive")
        ap.add_argument("--out", required=True)
        a = ap.parse_args(rest)
        rep = import_baseline(load(a.gates), a.out, a.archive)
        print(json.dumps({k: rep[k] for k in ("archive", "ok", "mismatches")} | {"cells": len(rep["cells"]), "rereads": rep["rereads"]}, indent=1))
        return 0 if rep["ok"] else 1
    if sub == "rereads":
        ap.add_argument("dirs", nargs="+")
        a = ap.parse_args(rest)
        print(json.dumps(reread_table(merge(*[collect_dir(d) for d in a.dirs])), indent=1))
        return 0
    ap.add_argument("batch_dirs", nargs="+")
    ap.add_argument("--baseline", required=True, help="the import-baseline output directory")
    ap.add_argument("--pooled", action="store_true")
    ap.add_argument("--ledger")
    ap.add_argument("--out")
    a = ap.parse_args(rest)
    summary = build_summary(a.batch_dirs, a.baseline, load(a.gates), a.pooled, a.ledger)
    summary["gates_file"] = os.path.realpath(a.gates)
    out = a.out or a.batch_dirs[0]
    os.makedirs(out, exist_ok=True)
    write_json(os.path.join(out, "summary.json"), summary)
    text = render_md(summary)
    with open(os.path.join(out, "summary.md"), "w", encoding="utf-8") as fh:
        fh.write(text)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
