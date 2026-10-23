#!/usr/bin/env python3
"""svs_report.py: the slice-vs-stock evaluation report (docs/slice-vs-stock-2026-10-23.md §6-§8).

usage:
  svs_report.py <batch-dir> [<batch-dir> ...] [--gates scripts/ab/gates-svs.json] [--pooled]
                [--fingerprints FILE] [--ledger FILE] [--out DIR]

Reads <batch-dir>/cells/*.json written by run_ab.py (the cell collection of ab_report.py), computes the
pre-registered quantities of gates-svs.json for the primary comparison (slice against stock) and, reported only, for
the configured variant stock-compact, and applies the decision rules. Without --pooled the batch is also tested for
the single pre-declared arbitration (a minimum not met, a verdict that moves when L or N moves by 0.05, or the
quality floor decided at its margin). Writes summary.json and summary.md to --out (default: the first batch dir).
Counts, ratios and paired deltas only, no p-values.
"""
import argparse
import json
import math
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ab_report  # noqa: E402

GATES_DEFAULT = os.path.join(HERE, "gates-svs.json")
# Bad memory answers: a value produced where the right one was required. CANNOT-RECOVER and a missing answer are
# honest misses (they count as not correct, not as bad).
BAD = ("wrong", "decoy", "stale", "hedged", "confabulated")


def memory_of(c):
    """({item: correct}, bad count) of one cell: f1 from verify info (four items), r1-r5 from the exam class (one item)."""
    info = c.get("verify_info") or {}
    if "memory_classes" in info:
        classes = info["memory_classes"]
        return {k: v == "correct" for k, v in classes.items()}, sum(1 for v in classes.values() if v in BAD)
    if c.get("exam_class") is not None:
        cls = c["exam_class"]
        return {"exam": cls == "correct"}, 1 if cls in BAD else 0
    return {}, 0


def values(c):
    """Per-cell values the report uses (None without a metrics row)."""
    m = c.get("metrics")
    if not m:
        return None
    us, fin, rd = m["usage"], m["finish"], m["reads"]
    comp = m.get("compaction") or {}
    ctx = m.get("context") or {}
    turns = [v for k, v in (m.get("per_turn") or {}).items() if k not in ("None", None)]
    items, bad = memory_of(c)
    return {
        "pass": 1 if c.get("pass") else 0,
        "cost": us["cost_offpeak"], "cost_peak": us["cost_peak"],
        "miss": us["miss"], "hit": us["hit"], "out": us["out"], "requests": us["requests"],
        "compaction_calls": us.get("compaction_calls", 0),
        "cache_hit_rate": us.get("cache_hit_rate"),
        "peak_request_tokens": ctx.get("peak_request_tokens"), "mean_request_tokens": ctx.get("mean_request_tokens"),
        "last_turn_peak_request_tokens": ctx.get("last_turn_peak_request_tokens"),
        "summaries": comp.get("summaries", 0), "failed_compactions": comp.get("failed", 0), "prunes": comp.get("prunes", 0),
        "compaction_turns": comp.get("turns", []), "context_limit_errors": comp.get("context_limit_errors", 0),
        "native_spills": comp.get("native_spills", 0), "slice_folds": comp.get("slice_folds", 0),
        "requests_per_turn": round(us["requests"] / len(turns), 2) if turns else None,
        "max_step_mean": round(sum(t.get("max_step", 0) for t in turns) / len(turns), 2) if turns else None,
        "step_limit_turns": fin.get("step_limit_cut", 0), "closeout_turns": fin["closeout"],
        "rereads_same_turn": rd["reread_same_turn_unchanged"] + rd["reread_same_turn_after_edit"],
        "wall_s": c.get("wall_s") or 0,
        "memory": items, "memory_correct": sum(items.values()), "memory_total": len(items), "memory_bad": bad,
        "memory_excluded": bool(c.get("g2_excluded")),
        "compacted_before_exam": any(e.get("compacted_before") for e in (m.get("exams") or [])),
        # reported only (pre-freeze additions, 2026-10-23)
        "exams": len(m.get("exams") or []),
        "exams_recall_sourced": sum(1 for e in (m.get("exams") or []) if e.get("recall_sourced")),
        "exams_partial_leak": sum(1 for e in (m.get("exams") or []) if e.get("partial_leak_assistant_turns")),
        "fold_of_read_t1": any(r.get("fold_of_read") for r in (m.get("in_turn") or []) if r.get("turn") == 1) if m.get("in_turn") else None,
        "digest_missing": (c.get("verify_info") or {}).get("digest_missing"),
    }


def geomean(xs):
    xs = [x for x in xs if x is not None and x > 0]
    return math.exp(sum(math.log(x) for x in xs) / len(xs)) if xs else None


def pairs_of(cells, arm, base, tasks):
    """Valid (arm, base) pairs per (batch, task, rep), plus the dropped ones with the reason."""
    kept, dropped = [], []
    for b, t, r in sorted({(b, t, r) for (b, t, r, a) in cells if t in tasks}):
        ca, cb = cells.get((b, t, r, arm)), cells.get((b, t, r, base))
        if not ca or not cb:
            dropped.append(f"{t}.r{r} ({b}): missing cell")
        elif not (ca.get("valid") and cb.get("valid")):
            dropped.append(f"{t}.r{r} ({b}): invalid: " + "; ".join((ca.get("invalid_reasons") or []) + (cb.get("invalid_reasons") or []))[:200])
        else:
            kept.append(((b, t, r), values(ca), values(cb)))
    return kept, dropped


def comparison(cells, gates, arm, base):
    """P1-P3 of gates-svs.json for arm against base."""
    unit, mins = gates["unit"], gates["min_pairs"]
    kept, dropped = pairs_of(cells, arm, base, unit["tasks"])
    by_task = {}
    for (b, t, r), a, bb in kept:
        by_task.setdefault(t, []).append((a, bb))
    tasks = {}
    for t in unit["tasks"]:
        ps = by_task.get(t, [])
        ca, cb = sum(a["cost"] for a, _ in ps), sum(b["cost"] for _, b in ps)
        ratios = [a["cost"] / b["cost"] for a, b in ps if b["cost"] > 0]
        tasks[t] = {"pairs": len(ps), "min_pairs": mins["per_task"].get(t, 0), "cost_arm": round(ca, 6), "cost_base": round(cb, 6),
                    "R": round(ca / cb, 4) if cb > 0 else None, "paired_ratios": [round(x, 4) for x in ratios],
                    "median_paired_ratio": round(statistics.median(ratios), 4) if ratios else None,
                    "pass_arm": sum(a["pass"] for a, _ in ps), "pass_base": sum(b["pass"] for _, b in ps)}
        tasks[t]["dS"] = tasks[t]["pass_arm"] - tasks[t]["pass_base"]
    R = {t: v["R"] for t, v in tasks.items()}
    L = R.get(unit["long_tasks"][0]) if unit["long_tasks"] else None
    N = geomean([R[t] for t in unit["short_tasks"]]) if all(R.get(t) for t in unit["short_tasks"]) else None
    G = geomean([R[t] for t in unit["tasks"]]) if all(R.get(t) for t in unit["tasks"]) else None
    # secondary, never decisive: N split into its recall tasks (r1-r5) and its coding tasks (c1, c2)
    sub = {}
    for name, key in (("N_recall", "short_recall_tasks"), ("N_coding", "short_coding_tasks")):
        ts = unit.get(key) or []
        v = geomean([R[t] for t in ts]) if ts and all(R.get(t) for t in ts) else None
        sub[name] = round(v, 4) if v is not None else None
    tot_a, tot_b = sum(a["cost"] for _, a, _ in kept), sum(b["cost"] for _, _, b in kept)
    all_ratios = [a["cost"] / b["cost"] for _, a, b in kept if b["cost"] > 0]
    mem = [(k, a, b) for k, a, b in kept if k[1] in unit["memory_tasks"]]
    mem_kept = [(k, a, b) for k, a, b in mem if not (a["memory_excluded"] or b["memory_excluded"])]
    mem_dropped = [f"{k[1]}.r{k[2]} ({k[0]}): memory exclusion (flagged access, leak or oracle via the file system)"
                   for k, a, b in mem if a["memory_excluded"] or b["memory_excluded"]]
    items = sum(max(a["memory_total"], b["memory_total"]) for _, a, b in mem_kept)
    per_item = {}
    for (_, t, _), a, b in mem_kept:
        for name in sorted(set(a["memory"]) | set(b["memory"])):
            row = per_item.setdefault(f"{t}:{name}", {"arm": 0, "base": 0, "n": 0})
            row["arm"] += int(a["memory"].get(name, False))
            row["base"] += int(b["memory"].get(name, False))
            row["n"] += 1
    M_a, M_b = sum(a["memory_correct"] for _, a, _ in mem_kept), sum(b["memory_correct"] for _, _, b in mem_kept)
    B_a, B_b = sum(a["memory_bad"] for _, a, _ in mem_kept), sum(b["memory_bad"] for _, _, b in mem_kept)
    insufficient = []
    if len(kept) < mins["all"]:
        insufficient.append(f"{len(kept)} valid pairs < {mins['all']}")
    insufficient += [f"{t}: {v['pairs']} pairs < {v['min_pairs']}" for t, v in tasks.items() if v["pairs"] < v["min_pairs"]]
    if items < mins["memory_items"]:
        insufficient.append(f"{items} memory items < {mins['memory_items']}")
    return {
        "arm": arm, "baseline": base, "pairs": len(kept), "dropped_pairs": dropped, "tasks": tasks,
        "L": round(L, 4) if L is not None else None, "N": round(N, 4) if N is not None else None, "G": round(G, 4) if G is not None else None,
        **sub,
        "sum_ratio": round(tot_a / tot_b, 4) if tot_b else None,
        "median_paired_ratio": round(statistics.median(all_ratios), 4) if all_ratios else None,
        "cost_arm": round(tot_a, 6), "cost_base": round(tot_b, 6),
        "dS": sum(a["pass"] for _, a, _ in kept) - sum(b["pass"] for _, _, b in kept), "dS_t": {t: v["dS"] for t, v in tasks.items()},
        "memory": {"pairs": len(mem_kept), "items": items, "correct_arm": M_a, "correct_base": M_b, "dM": M_a - M_b,
                   "bad_arm": B_a, "bad_base": B_b, "dB": B_a - B_b, "per_item": per_item, "dropped": mem_dropped},
        "insufficient": insufficient,
    }


def quality(cmp, dec):
    """(quality floor holds, slice better on quality) under gates-svs.json decision."""
    q, qb, m = dec["quality_floor"], dec["quality_better"], cmp["memory"]
    holds = (cmp["dS"] >= q["dS_min"] and all(v >= q["dS_t_min"] for v in cmp["dS_t"].values())
             and m["dM"] >= q["dM_min"] and m["dB"] <= q["dB_max"])
    return holds, cmp["dS"] >= qb["dS_min"] or m["dM"] >= qb["dM_min"]


def verdict(Q, better, L, N, insufficient):
    """The pre-registered decision table (gates-svs.json decision.rules): the first rule that matches decides."""
    if insufficient or L is None or N is None:
        return "inconclusive", "a minimum is not met: " + "; ".join(insufficient or ["L or N not computable"])
    if not Q:
        return "not worth it", "the quality floor fails"
    if L <= 0.80 and N <= 1.10:
        return "worth it", f"quality floor holds, L {L:.3f} <= 0.80, N {N:.3f} <= 1.10"
    if better and L <= 1.00 and N <= 1.10:
        return "worth it", f"slice better on quality, L {L:.3f} <= 1.00, N {N:.3f} <= 1.10"
    if L >= 0.95 and N >= 1.00:
        return "not worth it", f"no long-session saving (L {L:.3f} >= 0.95) and no short-session saving (N {N:.3f} >= 1.00)"
    if N >= 1.25 and L > 0.80:
        return "not worth it", f"short-session overhead N {N:.3f} >= 1.25 without a large long-session saving (L {L:.3f} > 0.80)"
    if L <= 0.80 and N > 1.10:
        return "inconclusive", f"long-session saving (L {L:.3f}) bought with short-session overhead (N {N:.3f} > 1.10)"
    return "inconclusive", f"L {L:.3f}, N {N:.3f}: neither the worth-it nor the not-worth-it conditions hold"


def arbitration_needed(cmp, gates):
    """The pre-declared trigger (gates-svs.json arbitration.trigger), evaluated on a batch before pooling."""
    dec = gates["decision"]
    Q, better = quality(cmp, dec)
    why = []
    if cmp["insufficient"]:
        why.append("minimum not met: " + "; ".join(cmp["insufficient"]))
    L, N = cmp["L"], cmp["N"]
    if L is not None and N is not None:
        v0 = verdict(Q, better, L, N, [])[0]
        for dl, dn in ((0.05, 0), (-0.05, 0), (0, 0.05), (0, -0.05)):
            v = verdict(Q, better, L + dl, N + dn, [])[0]
            if v != v0:
                why.append(f"verdict moves to '{v}' at L {L + dl:.3f}, N {N + dn:.3f}")
                break
    q, m = dec["quality_floor"], cmp["memory"]
    if (cmp["dS"] in (q["dS_min"], q["dS_min"] - 1) or any(v in (q["dS_t_min"], q["dS_t_min"] - 1) for v in cmp["dS_t"].values())
            or m["dM"] in (q["dM_min"], q["dM_min"] - 1) or m["dB"] in (q["dB_max"], q["dB_max"] + 1)):
        why.append(f"quality floor at its margin (dS {cmp['dS']}, dS_t {cmp['dS_t']}, dM {m['dM']}, dB {m['dB']})")
    # 'slice better' (rule 4) at its margin where it matters: Q holds, rule 3 does not decide, rule 4's cost conditions
    # hold, and the larger of dS and dM is one unit either side of the +2 threshold (pre-freeze addition, 2026-10-23)
    qb = dec["quality_better"]
    if (Q and L is not None and N is not None and not (L <= 0.80 and N <= 1.10) and L <= 1.00 and N <= 1.10
            and max(cmp["dS"], m["dM"]) in (qb["dS_min"] - 1, qb["dS_min"])):
        why.append(f"'slice better' at its margin (dS {cmp['dS']}, dM {m['dM']}) with L {L:.3f}, N {N:.3f} inside rule 4's cost conditions")
    return why


def describe(cells):
    """Secondary, reported only: per arm and task, medians and sums of the context-management quantities."""
    out = {}
    for (b, t, r, a), c in sorted(cells.items()):
        v = values(c) if c.get("valid") else None
        if v is not None:
            out.setdefault(a, {}).setdefault(t, []).append(v)
    res = {}
    for a, tasks in out.items():
        for t, vs in tasks.items():
            def med(k):
                xs = [x[k] for x in vs if x[k] is not None]
                return statistics.median(xs) if xs else None
            res.setdefault(a, {})[t] = {
                "cells": len(vs), "pass": sum(x["pass"] for x in vs), "median_cost_offpeak": med("cost"), "median_requests": med("requests"),
                "median_peak_request_tokens": med("peak_request_tokens"), "median_mean_request_tokens": med("mean_request_tokens"),
                "median_last_turn_peak_tokens": med("last_turn_peak_request_tokens"), "median_cache_hit_rate": med("cache_hit_rate"),
                "summaries": sum(x["summaries"] for x in vs), "failed_compactions": sum(x["failed_compactions"] for x in vs),
                "prunes": sum(x["prunes"] for x in vs), "compaction_turns": [x["compaction_turns"] for x in vs],
                "context_limit_errors": sum(x["context_limit_errors"] for x in vs), "native_spills": sum(x["native_spills"] for x in vs),
                "slice_folds": sum(x["slice_folds"] for x in vs), "median_requests_per_turn": med("requests_per_turn"),
                "median_steps_per_turn": med("max_step_mean"), "step_limit_turns": sum(x["step_limit_turns"] for x in vs),
                "rereads_same_turn": sum(x["rereads_same_turn"] for x in vs), "median_wall_s": med("wall_s"),
                "memory_correct": sum(x["memory_correct"] for x in vs), "memory_total": sum(x["memory_total"] for x in vs),
                "memory_bad": sum(x["memory_bad"] for x in vs),
                "post_compaction_memory_failures": sum(x["memory_total"] - x["memory_correct"] for x in vs if x["compacted_before_exam"]),
                "cells_compacted_before_exam": sum(1 for x in vs if x["compacted_before_exam"]),
                # a failed compaction attempt is billed but its usage is never logged: the cell's cost is a lower bound
                "cells_cost_lower_bound": sum(1 for x in vs if x["failed_compactions"]),
                "exams_recall_sourced": f"{sum(x['exams_recall_sourced'] for x in vs)}/{sum(x['exams'] for x in vs)}",
                "exams_partial_leak": sum(x["exams_partial_leak"] for x in vs),
                "r3_t1_fold": (f"{sum(1 for x in vs if x['fold_of_read_t1'])}/{len(vs)}" if t == "r3" else None),
                "digest_missing": (sum(x["digest_missing"] or 0 for x in vs) if any(x["digest_missing"] is not None for x in vs) else None),
            }
    return res


def build_summary(batch_dirs, gates, pooled=False, ledger=None, fingerprints=None):
    cells, attempts = ab_report.collect(batch_dirs)
    arms = sorted({k[3] for k in cells})
    base, prim = gates["baseline"], gates["primary"]
    comparisons = {}
    for arm in [prim["arm"]] + list(gates.get("secondary_arms", [])):
        if arm in arms and base in arms:
            comparisons[f"{arm} vs {base}"] = comparison(cells, gates, arm, base)
    if prim["arm"] in arms and "stock-compact" in arms:
        comparisons[f"{prim['arm']} vs stock-compact"] = comparison(cells, gates, prim["arm"], "stock-compact")
    key = f"{prim['arm']} vs {prim['against']}"
    decision = {}
    if key in comparisons:
        cmp = comparisons[key]
        Q, better = quality(cmp, gates["decision"])
        v, why = verdict(Q, better, cmp["L"], cmp["N"], cmp["insufficient"])
        decision = {"comparison": key, "quality_floor_holds": Q, "slice_better_on_quality": better, "verdict": v, "because": why, "pooled": pooled}
        if not pooled:
            trig = arbitration_needed(cmp, gates)
            decision["arbitration"] = ("required: " + "; ".join(trig)) if trig else "not required"
    for k, cmp in comparisons.items():
        if k != key:
            Q, better = quality(cmp, gates["decision"])
            cmp["descriptive_verdict"] = verdict(Q, better, cmp["L"], cmp["N"], cmp["insufficient"])[0] + " (secondary, not a decision)"
    spend = None
    if ledger and os.path.exists(ledger):
        with open(ledger, encoding="utf-8") as fh:
            rows = [json.loads(l) for l in fh if l.strip()]
        by_batch = {}
        for r in rows:
            by_batch[r["batch"]] = round(by_batch.get(r["batch"], 0) + r.get("usd", 0), 6)
        spend = {"total_usd_peak_sheet": round(sum(r.get("usd", 0) for r in rows), 6), "by_batch": by_batch, "turns": len(rows)}
    # warmup (hello): from rep 2 on, step 1 must read the arm's cached prefix (structure warm_min_cache_read)
    warmup = {}
    for (b, t, r, a), c in sorted(cells.items()):
        if t == "hello" and c.get("metrics"):
            hits = c["metrics"]["usage"]["first_request_hits"]
            need = ((gates.get("structure") or {}).get(a) or {}).get("warm_min_cache_read", 4000)
            warmup.setdefault(a, []).append({"batch": b, "rep": r, "step1_cache_read": hits[0] if hits else None, "min": need,
                                             "ok": r < 2 or bool(hits and hits[0] >= need), "valid": c.get("valid")})
    return {
        "warmup": warmup,
        "batches": [os.path.realpath(b) for b in batch_dirs], "pooled": pooled, "arms": arms, "cells": len(cells),
        "valid_cells": sum(1 for c in cells.values() if c.get("valid")),
        "invalid_cells": [{"cell": c["cell"], "batch": c["_batch"], "reasons": c.get("invalid_reasons"), "infra": c.get("infra")}
                          for c in cells.values() if not c.get("valid")],
        "non_final_attempts": [{k: a.get(k) for k in ("cell", "attempt", "status", "infra", "reasons")} for a in attempts if a.get("status") != "done"],
        "spend": spend, "decision": decision, "comparisons": comparisons, "describe": describe(cells),
        "fingerprints": ab_report.load(fingerprints) if fingerprints and os.path.exists(fingerprints) else None,
    }


def fmt(x, nd=3):
    if x is None:
        return "-"
    return f"{x:.{nd}f}" if isinstance(x, float) else str(x)


def render_md(s):
    L = ["# slice-vs-stock summary", "",
         f"Batches: {', '.join(os.path.basename(b) for b in s['batches'])}{' (pooled)' if s['pooled'] else ''}. "
         f"Cells: {s['cells']} ({s['valid_cells']} valid). Arms: {', '.join(s['arms'])}."]
    if s["spend"]:
        L.append(f"Spend (peak sheet): ${s['spend']['total_usd_peak_sheet']:.4f} over {s['spend']['turns']} turns; by batch {s['spend']['by_batch']}.")
    if s.get("warmup"):
        L += ["", "## Warmup (hello): step-1 cache read from rep 2 on, at least the arm's minimum", ""]
        for a, rows in sorted(s["warmup"].items()):
            L.append(f"- {a}: " + ", ".join(f"rep {w['rep']} {w['step1_cache_read']}{'' if w['ok'] else ' (LOW, min ' + str(w['min']) + ')'}" for w in rows))
    d = s["decision"]
    if d:
        L += ["", "## Decision (pre-registered rules, gates-svs.json)", "",
              f"- {d['comparison']}: **{d['verdict']}** ({d['because']}); quality floor {'holds' if d['quality_floor_holds'] else 'FAILS'}"
              + ("; slice better on quality" if d["slice_better_on_quality"] else "")]
        if "arbitration" in d:
            L.append(f"- arbitration: {d['arbitration']}")
    for k, c in s["comparisons"].items():
        m = c["memory"]
        L += ["", f"## {k}" + (f" ({c['descriptive_verdict']})" if c.get("descriptive_verdict") else ""), "",
              f"Pairs {c['pairs']}; L = {fmt(c['L'])}, N = {fmt(c['N'])} (secondary: N_recall {fmt(c.get('N_recall'))}, N_coding {fmt(c.get('N_coding'))}), "
              f"G = {fmt(c['G'])}; sum ratio {fmt(c['sum_ratio'])}, "
              f"median paired ratio {fmt(c['median_paired_ratio'])}; dS {c['dS']}; memory {m['correct_arm']} vs {m['correct_base']} correct "
              f"of {m['items']} items (dM {m['dM']}), bad {m['bad_arm']} vs {m['bad_base']} (dB {m['dB']})."
              + (f" Insufficient: {'; '.join(c['insufficient'])}." if c["insufficient"] else ""), "",
              "| task | pairs/min | R (sum ratio) | median paired ratio | paired ratios | pass arm/base | dS_t |", "|---|---|---|---|---|---|---|"]
        for t, v in c["tasks"].items():
            L.append(f"| {t} | {v['pairs']}/{v['min_pairs']} | {fmt(v['R'])} | {fmt(v['median_paired_ratio'])} | {v['paired_ratios']} | {v['pass_arm']}/{v['pass_base']} | {v['dS']} |")
        if m["per_item"]:
            L += ["", "| memory item | arm correct | base correct | pairs |", "|---|---|---|---|"]
            L += [f"| {item} | {v['arm']} | {v['base']} | {v['n']} |" for item, v in sorted(m["per_item"].items())]
        if c["dropped_pairs"] or m["dropped"]:
            L += [""] + [f"- dropped: {x}" for x in c["dropped_pairs"] + m["dropped"]]
    L += ["", "## Context management and cost structure (valid cells, reported only)", "",
          "| arm | task | cells | pass | median $ off-peak | median requests | median peak req tokens | median mean req tokens | median last-turn peak | "
          "median cache hit | summaries (failed) | prunes | compaction turns | ctx-limit errors | spills | slice folds | req/turn | steps/turn | "
          "step-cap cuts | same-turn rereads | memory correct/total (bad) | post-compaction memory failures | median wall s |",
          "|" + "---|" * 23]
    for a, tasks in sorted(s["describe"].items()):
        for t, r in sorted(tasks.items()):
            L.append(f"| {a} | {t} | {r['cells']} | {r['pass']} | {fmt(r['median_cost_offpeak'], 4)} | {fmt(r['median_requests'])} | "
                     f"{fmt(r['median_peak_request_tokens'])} | {fmt(r['median_mean_request_tokens'], 0)} | {fmt(r['median_last_turn_peak_tokens'])} | "
                     f"{fmt(r['median_cache_hit_rate'])} | {r['summaries']} ({r['failed_compactions']}) | {r['prunes']} | {r['compaction_turns']} | "
                     f"{r['context_limit_errors']} | {r['native_spills']} | {r['slice_folds']} | {fmt(r['median_requests_per_turn'])} | "
                     f"{fmt(r['median_steps_per_turn'])} | {r['step_limit_turns']} | {r['rereads_same_turn']} | "
                     f"{r['memory_correct']}/{r['memory_total']} ({r['memory_bad']}) | {r['post_compaction_memory_failures']} | {fmt(r['median_wall_s'], 0)} |")
    if s["invalid_cells"]:
        L += ["", "## Invalid cells (not counted)", ""]
        L += [f"- {c['cell']} ({c['batch']}), infra {c['infra']}: {'; '.join(c['reasons'] or [])[:300]}" for c in s["invalid_cells"]]
    L += ["", "## Recall sourcing, partial leaks and manipulation checks (valid cells, reported only)", "",
          "| arm | task | exams recall-sourced | exams with a partial leak before them | r3 T1 fold | f1 digest tokens missing | cells whose cost is a lower bound (failed compactions) |",
          "|---|---|---|---|---|---|---|"]
    for a, tasks in sorted(s["describe"].items()):
        for t, r in sorted(tasks.items()):
            L.append(f"| {a} | {t} | {r['exams_recall_sourced']} | {r['exams_partial_leak']} | {fmt(r['r3_t1_fold'])} | {fmt(r['digest_missing'])} | {r['cells_cost_lower_bound']} |")
    L += ["", "Ratios are the named arm over its baseline; cost on the off-peak sheet (peak is exactly 2x every field). "
          "A cell with a failed compaction attempt has a cost that is a lower bound (the attempt is billed, its usage is not logged)."]
    return "\n".join(L) + "\n"


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("batch_dirs", nargs="+")
    ap.add_argument("--gates", default=GATES_DEFAULT)
    ap.add_argument("--fingerprints")
    ap.add_argument("--ledger")
    ap.add_argument("--pooled", action="store_true")
    ap.add_argument("--out")
    args = ap.parse_args(argv)
    summary = build_summary(args.batch_dirs, ab_report.load(args.gates), args.pooled, args.ledger, args.fingerprints)
    summary["gates_file"] = os.path.realpath(args.gates)
    out = args.out or args.batch_dirs[0]
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "summary.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=1, sort_keys=True, ensure_ascii=False)
        fh.write("\n")
    text = render_md(summary)
    with open(os.path.join(out, "summary.md"), "w", encoding="utf-8") as fh:
        fh.write(text)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
