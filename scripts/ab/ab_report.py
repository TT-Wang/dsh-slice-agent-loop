#!/usr/bin/env python3
"""ab_report.py: aggregate P1-10 A/B cells and evaluate the pre-registered gates.

usage:
  ab_report.py <batch-dir> [<batch-dir> ...] [--baseline control] [--gates scripts/ab/gates.json]
               [--fingerprints AB/fingerprints.json] [--ledger AB/spend.jsonl] [--pooled] [--out DIR]

Reads <batch-dir>/cells/*.json written by run_ab.py and writes summary.json and summary.md
to --out (default: the first batch dir). Several batch dirs are pooled (the arbitration
batch next to the main one); --pooled doubles the count margins as gates.json prescribes.
Counts and paired deltas only, no p-values.
"""
import argparse
import glob
import json
import math
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BAD_EXAM = ("decoy", "stale", "hedged", "wrong", "cannot_recover")


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def cell_metrics(c):
    """Per-cell values of every gated or reported metric (None when the cell has no log)."""
    m = c.get("metrics")
    if not m:
        return None
    rc, rd, fin, us = m["recall"], m["reads"], m["finish"], m["usage"]
    sourced = any(e["recall_sourced"] for e in m.get("exams", []))
    return {
        "pass": 1 if c.get("pass") else 0,
        "recall_sourced_correct": 1 if (c.get("pass") and sourced) else 0,
        "recall_errors": rc["errors"],
        "fv_rejections": rc["fv_rejections"],
        "fv_rejections_unrecovered": rc["fv_rejections"] - rc["fv_rejections_recovered"],
        "bad_exam_answers": 1 if c.get("exam_class") in BAD_EXAM else 0,
        "rereads_same_turn": rd["reread_same_turn_unchanged"] + rd["reread_same_turn_after_edit"],
        "reread_same_turn_unchanged": rd["reread_same_turn_unchanged"],
        "reread_same_turn_after_edit": rd["reread_same_turn_after_edit"],
        "fold_then_reread": rd["fold_then_reread"],
        "reread_cross_turn": rd["reread_cross_turn"],
        "repeat_tool_reminders": rd["repeat_tool_reminders"],
        "cost": us["cost_offpeak"],
        "cost_peak": us["cost_peak"],
        "requests": us["requests"],
        "miss": us["miss"], "hit": us["hit"], "out": us["out"],
        "turn_first_miss": us["turn_first_miss"],
        "recall_turn_full": rc["recall_turn_views"]["full"],
        "closeout_turns": fin["closeout"],
        "completed_turns": fin["completed"],
        "step_limit_turns": fin.get("step_limit_cut", 0),
        "cross_turn_targets": rc["expand_cross_turn"]["targets"],
        "cross_turn_first_try_ok": rc["expand_cross_turn"]["first_try_ok"],
        "extra_hops": rc["extra_hops"],
        "recall_calls": sum(v["calls"] for v in rc["tools"].values()),
        "wall_s": c.get("wall_s") or 0,
    }


def collect(batch_dirs):
    cells, attempts = {}, []
    for bd in batch_dirs:
        batch = os.path.basename(os.path.normpath(bd))
        for path in sorted(glob.glob(os.path.join(bd, "cells", "*.json"))):
            if path.endswith(".budget_stop.json"):
                continue
            c = load(path)
            c["_batch"] = batch
            cells[(batch, c["alias"], c["rep"], c["arm"])] = c
        idx = os.path.join(bd, "index.jsonl")
        if os.path.exists(idx):
            with open(idx, encoding="utf-8") as fh:
                attempts += [json.loads(l) for l in fh if l.strip()]
    return cells, attempts


def pairs(cells, arm, base, tasks, g2=False):
    """Valid (arm, base) cell pairs by (batch, task, rep), plus the dropped pairs with the reason."""
    kept, dropped = [], []
    keys = sorted({(b, t, r) for (b, t, r, a) in cells if t in tasks})
    for b, t, r in keys:
        ca, cb = cells.get((b, t, r, arm)), cells.get((b, t, r, base))
        if not ca or not cb:
            dropped.append(((b, t, r), "missing cell"))
            continue
        if not (ca.get("valid") and cb.get("valid")):
            dropped.append(((b, t, r), "invalid: " + "; ".join((ca.get("invalid_reasons") or []) + (cb.get("invalid_reasons") or []))[:200]))
            continue
        if g2 and (ca.get("g2_excluded") or cb.get("g2_excluded")):
            dropped.append(((b, t, r), "G2 exclusion (flagged access or leak)"))
            continue
        kept.append(((b, t, r), cell_metrics(ca), cell_metrics(cb)))
    return kept, dropped


def evaluate(check, kept, pooled_mult):
    mult = pooled_mult if check.get("count") else 1
    rule, metric = check["rule"], check["metric"]
    out = {"id": check["id"], "desc": check.get("desc", metric), "metric": metric, "rule": rule, "pairs": len(kept)}
    if not kept:
        return dict(out, verdict="n/a", note="no valid pairs")
    if metric == "cross_turn_first_try":
        ta = sum(a["cross_turn_targets"] for _, a, _ in kept)
        tb = sum(b["cross_turn_targets"] for _, _, b in kept)
        oa = sum(a["cross_turn_first_try_ok"] for _, a, _ in kept)
        ob = sum(b["cross_turn_first_try_ok"] for _, _, b in kept)
        out.update(arm={"ok": oa, "targets": ta}, base={"ok": ob, "targets": tb})
        if ta < check.get("min_targets", 1) or tb < check.get("min_targets", 1):
            return dict(out, verdict="n/a", note="no cross-turn target on one side")
        ra, rb = oa / ta, ob / tb
        need = rb - check["margin"]
        out.update(arm_rate=round(ra, 4), base_rate=round(rb, 4), threshold=round(need, 4))
        if ra >= need - 1e-12:
            return dict(out, verdict="pass")
        short = math.ceil(need * ta - oa - 1e-9)
        return dict(out, shortfall_units=short, verdict="arbitrate" if short <= 1 else "fail")
    va = sum(a[metric] for _, a, _ in kept)
    vb = sum(b[metric] for _, _, b in kept)
    out.update(arm_sum=round(va, 6), base_sum=round(vb, 6))
    if check.get("count"):
        out.update(arm=round(va, 6), base=round(vb, 6))
    if rule == "ge_base_minus":
        thr = vb - check["margin"] * mult
        short = thr - va
    elif rule == "le_base_plus":
        thr = vb + check["margin"] * mult
        short = va - thr
    elif rule == "le_factor_base_plus":
        thr = check["factor"] * vb + check["margin"] * mult
        if check.get("relative_unit"):
            ratio = va / vb if vb else math.inf
            out.update(ratio=round(ratio, 4), base="sum %.4f" % vb)
            short = (ratio - check["factor"]) / check["arbitration_unit"]
        else:
            short = va - thr
    elif rule == "arm_eq":
        thr = check["value"]
        short = abs(va - thr)
    elif rule == "no_task_drop":
        by_task = {}
        for (b, t, r), a, bb in kept:
            s = by_task.setdefault(t, [0, 0])
            s[0] += a[metric]
            s[1] += bb[metric]
        drop = check["drop"] * mult
        worst = max(((s[1] - drop + 1) - s[0], t) for t, s in by_task.items())
        out.update(per_task={t: {"arm": s[0], "base": s[1]} for t, s in sorted(by_task.items())}, worst_task=worst[1])
        thr = f"no task with arm <= base - {drop}"
        short = worst[0]
    elif rule == "median_ratio_le":
        ratios = [a[metric] / b[metric] for _, a, b in kept if b[metric] > 0]
        med = statistics.median(ratios) if ratios else math.nan
        out.update(median=round(med, 4), n=len(ratios), base="paired")
        thr = check["value"]
        short = (med - thr) / check["arbitration_unit"]
    elif rule == "median_delta_le":
        deltas = [a[metric] - b[metric] for _, a, b in kept]
        med = statistics.median(deltas)
        out.update(median=med, base="paired")
        thr = check["value"]
        short = (med - thr) / check["arbitration_unit"]
    else:
        raise SystemExit(f"unknown rule {rule}")
    out["threshold"] = thr if isinstance(thr, str) else round(thr, 6)
    if short <= 1e-9:
        out["verdict"] = "pass"
    else:
        out["shortfall_units"] = round(short, 4)
        out["verdict"] = "arbitrate" if short <= 1 + 1e-9 else "fail"
    return out


def gate_verdict(checks):
    vs = [c["verdict"] for c in checks]
    if "fail" in vs:
        return "fail"
    if "arbitrate" in vs:
        return "arbitrate"
    return "pass"


def median(xs):
    return statistics.median(xs) if xs else None


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("batch_dirs", nargs="+")
    ap.add_argument("--baseline", default="control")
    ap.add_argument("--gates", default=os.path.join(HERE, "gates.json"))
    ap.add_argument("--fingerprints")
    ap.add_argument("--ledger")
    ap.add_argument("--pooled", action="store_true")
    ap.add_argument("--out")
    args = ap.parse_args(argv)
    gates = load(args.gates)
    cells, attempts = collect(args.batch_dirs)
    mult = gates["arbitration"]["count_margin_multiplier"] if args.pooled else 1
    tasks, recall_tasks = gates["unit"]["tasks"], gates["unit"]["recall_tasks"]
    arms = sorted({k[3] for k in cells})
    base = args.baseline

    # per arm x task table
    table = {}
    for arm in arms:
        for task in sorted({k[1] for k in cells}):
            cs = [c for k, c in cells.items() if k[3] == arm and k[1] == task]
            valid = [c for c in cs if c.get("valid")]
            ms = [cell_metrics(c) for c in valid if c.get("metrics")]
            table.setdefault(arm, {})[task] = {
                "cells": len(cs), "valid": len(valid), "pass": sum(1 for c in valid if c.get("pass")),
                "exam_classes": sorted(c.get("exam_class") for c in valid if c.get("exam_class")),
                "recall_sourced_correct": sum(m["recall_sourced_correct"] for m in ms),
                "median_cost_usd": median([m["cost"] for m in ms]), "median_requests": median([m["requests"] for m in ms]),
                "rereads_same_turn": sum(m["rereads_same_turn"] for m in ms), "recall_errors": sum(m["recall_errors"] for m in ms),
                "fv_rejections": sum(m["fv_rejections"] for m in ms), "flagged_or_leak": sum(1 for c in valid if c.get("g2_excluded")),
            }
    # gates
    results = {}
    for arm in [a for a in gates["arms"] if a in arms]:
        gres = []
        for g in gates["gates"]:
            if arm not in g["applies_to"]:
                continue
            checks = []
            for ch in g["checks"]:
                if arm not in ch.get("applies_to", g["applies_to"]):
                    continue
                b = ch.get("baseline", base)
                if b not in arms:
                    checks.append({"id": ch["id"], "verdict": "n/a", "note": f"baseline {b} not in data"})
                    continue
                scope_tasks = recall_tasks if ch["scope"] == "recall_g2" else tasks
                kept, dropped = pairs(cells, arm, b, scope_tasks, g2=ch["scope"] == "recall_g2")
                r = evaluate(ch, kept, mult)
                r["baseline"] = b
                r["dropped_pairs"] = [f"{k[1]}.r{k[2]} ({k[0]}): {why}" for k, why in dropped]
                checks.append(r)
            report_only = {}
            if g.get("report_only"):
                kept, _ = pairs(cells, arm, base, tasks)
                report_only = {m: {"arm": sum(a[m] for _, a, _ in kept), "base": sum(bb[m] for _, _, bb in kept)} for m in g["report_only"]}
            gres.append({"id": g["id"], "name": g["name"], "verdict": gate_verdict(checks), "checks": checks, "report_only": report_only})
        results[arm] = gres

    def passes(arm, ids):
        gs = {g["id"]: g["verdict"] for g in results.get(arm, [])}
        return all(gs.get(i) == "pass" for i in ids), gs

    decision = {}
    ok1, gs1 = passes("arm1", ["G1", "G2", "G3", "G4", "G5"])
    if "arm1" in results:
        decision["arm1"] = "ship A + C (G1-G5 pass)" if ok1 else ("arbitration (a gate missed by one unit)" if "arbitrate" in gs1.values() and "fail" not in gs1.values() else "do not ship (a gate failed)")
    ok2, gs2 = passes("arm2", ["G1", "G2", "G3", "G4", "G5", "G6"])
    if "arm2" in results:
        decision["arm2"] = "add F (G1-G6 pass)" if ok2 else ("arbitration (a gate missed by one unit)" if "arbitrate" in gs2.values() and "fail" not in gs2.values() else "drop F (a gate failed)")

    invalid = [{"cell": c["cell"], "batch": c["_batch"], "reasons": c.get("invalid_reasons"), "infra": c.get("infra"), "attempts": len(c.get("attempts") or [])}
               for c in cells.values() if not c.get("valid")]
    reruns = [a for a in attempts if a.get("status") != "done"]
    spend = None
    if args.ledger and os.path.exists(args.ledger):
        with open(args.ledger, encoding="utf-8") as fh:
            rows = [json.loads(l) for l in fh if l.strip()]
        by_batch = {}
        for r in rows:
            by_batch[r["batch"]] = round(by_batch.get(r["batch"], 0) + r.get("usd", 0), 6)
        spend = {"total_usd_peak_sheet": round(sum(r.get("usd", 0) for r in rows), 6), "by_batch": by_batch, "turns": len(rows)}
    fps = load(args.fingerprints) if args.fingerprints and os.path.exists(args.fingerprints) else None
    # warmup (hello): from rep 2 on, step 1 must read >= 4000 cached tokens (the prefix is cache-stable)
    warmup = {}
    for (b, t, r, a), c in sorted(cells.items()):
        if t == "hello" and c.get("metrics"):
            hits = c["metrics"]["usage"]["first_request_hits"]
            warmup.setdefault(a, []).append({"batch": b, "rep": r, "step1_cache_read": hits[0] if hits else None,
                                             "ok": r < 2 or bool(hits and hits[0] >= 4000), "valid": c.get("valid")})
    totals = {}
    for arm in arms:
        ms = [cell_metrics(c) for (b, t, r, a), c in cells.items() if a == arm and t in tasks and c.get("valid") and c.get("metrics")]
        totals[arm] = {"cells": len(ms), "cost_offpeak_usd": round(sum(m["cost"] for m in ms), 6), "cost_peak_usd": round(sum(m["cost_peak"] for m in ms), 6),
                       "miss": sum(m["miss"] for m in ms), "hit": sum(m["hit"] for m in ms), "out": sum(m["out"] for m in ms),
                       "requests": sum(m["requests"] for m in ms), "turn_first_miss": sum(m["turn_first_miss"] for m in ms)}
    summary = {
        "batches": [os.path.realpath(b) for b in args.batch_dirs], "pooled": args.pooled, "count_margin_multiplier": mult,
        "baseline": base, "arms": arms, "cells": len(cells), "valid_cells": sum(1 for c in cells.values() if c.get("valid")),
        "invalid_cells": invalid, "non_final_attempts": [{k: a.get(k) for k in ("cell", "attempt", "status", "infra", "reasons")} for a in reruns],
        "time_range": [min((c.get("started") or "~") for c in cells.values()) if cells else None, max((c.get("ended") or "") for c in cells.values()) if cells else None],
        "spend": spend, "table": table, "totals": totals, "warmup": warmup, "gates": results, "decision": decision,
        "structure": {a: {k: f.get(k) for k in ("system_chars", "slice_tools_json_chars", "prefix_chars", "prefix_delta_vs_control", "tape_header_lengths", "mean_tool_line_chars")} for a, f in (fps or {}).get("arms", {}).items()},
    }
    out = args.out or args.batch_dirs[0]
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "summary.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=1, sort_keys=True, ensure_ascii=False)
        fh.write("\n")
    with open(os.path.join(out, "summary.md"), "w", encoding="utf-8") as fh:
        fh.write(render_md(summary))
    print(render_md(summary))
    return 0


def render_md(s):
    L = ["# P1-10 native A/B summary", ""]
    L.append(f"Batches: {', '.join(os.path.basename(b) for b in s['batches'])}{' (pooled, count margins x%d)' % s['count_margin_multiplier'] if s['pooled'] else ''}. "
             f"Cells: {s['cells']} ({s['valid_cells']} valid). Baseline: {s['baseline']}. Time: {s['time_range'][0]} to {s['time_range'][1]}.")
    if s["spend"]:
        L.append(f"Spend (peak sheet): ${s['spend']['total_usd_peak_sheet']:.4f} over {s['spend']['turns']} turns; by batch {s['spend']['by_batch']}.")
    L += ["", "## Decision (computed from the pre-registered gates)", ""]
    for arm, d in s["decision"].items():
        L.append(f"- {arm}: {d}")
    if s["structure"]:
        L += ["", "## Structure (fingerprints)", "", "| arm | system chars | slice tool JSON | prefix chars | prefix delta | tape header | mean tool line |", "|---|---|---|---|---|---|---|"]
        for a, f in sorted(s["structure"].items()):
            L.append(f"| {a} | {f['system_chars']} | {f['slice_tools_json_chars']} | {f['prefix_chars']} | {f.get('prefix_delta_vs_control', '')} | {f['tape_header_lengths']} | {f['mean_tool_line_chars']} |")
    if s.get("warmup"):
        L += ["", "## Warmup (hello): step-1 cache read, rep >= 2 must be >= 4000", ""]
        for a, rows in sorted(s["warmup"].items()):
            L.append(f"- {a}: " + ", ".join(f"rep {w['rep']} {w['step1_cache_read']}{'' if w['ok'] else ' (LOW)'}" for w in rows))
    if s.get("totals"):
        L += ["", "## Totals over valid gated cells", "", "| arm | cells | $ off-peak | $ peak | miss | hit | out | requests | turn-first miss |", "|---|---|---|---|---|---|---|---|---|"]
        for a, t in sorted(s["totals"].items()):
            L.append(f"| {a} | {t['cells']} | {t['cost_offpeak_usd']:.4f} | {t['cost_peak_usd']:.4f} | {t['miss']} | {t['hit']} | {t['out']} | {t['requests']} | {t['turn_first_miss']} |")
    L += ["", "## Per arm and task (valid cells)", "", "| arm | task | valid/cells | pass | recall-sourced | exam classes | median $ (off-peak) | median requests | same-turn rereads | recall errors | fv rejections | excluded from G2 |", "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for arm, tasks in sorted(s["table"].items()):
        for task, t in sorted(tasks.items()):
            mc = f"{t['median_cost_usd']:.4f}" if t["median_cost_usd"] is not None else "-"
            L.append(f"| {arm} | {task} | {t['valid']}/{t['cells']} | {t['pass']} | {t['recall_sourced_correct']} | {','.join(t['exam_classes']) or '-'} | {mc} | {t['median_requests'] if t['median_requests'] is not None else '-'} | {t['rereads_same_turn']} | {t['recall_errors']} | {t['fv_rejections']} | {t['flagged_or_leak']} |")
    L += ["", "## Gates", ""]
    for arm, gs in sorted(s["gates"].items()):
        L += [f"### {arm}", "", "| gate | check | arm | baseline | threshold | verdict | pairs |", "|---|---|---|---|---|---|---|"]
        for g in gs:
            for c in g["checks"]:
                arm_v = c.get("arm_rate", c.get("median", c.get("ratio", c.get("arm", ""))))
                base_v = c.get("base_rate", c.get("base", ""))
                if isinstance(arm_v, dict):
                    arm_v = f"{arm_v['ok']}/{arm_v['targets']}"
                if isinstance(base_v, dict):
                    base_v = f"{base_v['ok']}/{base_v['targets']}"
                L.append(f"| {g['id']} ({g['verdict']}) | {c['id']}: {c.get('desc', '')} | {arm_v} | {base_v} ({c.get('baseline', '')}) | {c.get('threshold', '')} | {c['verdict']}{' (' + str(c['shortfall_units']) + ' units)' if c.get('shortfall_units') else ''}{' ' + c['note'] if c.get('note') else ''} | {c.get('pairs', '')} |")
            if g.get("report_only"):
                arm_r = ", ".join("%s %s" % (k, v["arm"]) for k, v in g["report_only"].items())
                base_r = ", ".join("%s %s" % (k, v["base"]) for k, v in g["report_only"].items())
                L.append(f"| {g['id']} | report only | {arm_r} | {base_r} | - | - | - |")
        L.append("")
    if s["invalid_cells"]:
        L += ["## Invalid cells (not counted)", ""]
        for c in s["invalid_cells"]:
            L.append(f"- {c['cell']} ({c['batch']}), attempts {c['attempts']}, infra {c['infra']}: {'; '.join(c['reasons'] or [])[:300]}")
        L.append("")
    if s["non_final_attempts"]:
        L += ["## Reruns and non-final attempts", ""]
        for a in s["non_final_attempts"]:
            L.append(f"- {a['cell']} attempt {a['attempt']}: {a['status']} (infra {a['infra']}) {('; '.join(a['reasons'] or []))[:200]}")
        L.append("")
    L.append("Counts and paired deltas only; n = 3 per task and arm detects large effects only.")
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
