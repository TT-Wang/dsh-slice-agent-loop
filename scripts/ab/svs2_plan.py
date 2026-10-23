#!/usr/bin/env python3
"""svs2_plan.py: cost model and cost ladder of the svs2 ablation (docs/svs2-ablation-2026-10-24.md §9).

usage:
  svs2_plan.py [--gates scripts/ab/gates-svs2.json] [--baseline AB/vault/baseline] [--batch AB/vault/results/<b>]...
               [--ledger AB/vault/spend.jsonl] [--arbitrate ARM:TASK,TASK]... [--json]

Prices every stage of gates budget.stages (warm, S1-S5) for the three new arms at peak:
- per cell: the measured mean cost of that arm and task in the given batches once one exists, else the prior
  (budget.prior: max(SLICE, STOCK) per task, SLICE's for f1, x 1.2), the baseline means taken from the imported
  baseline cells when --baseline is given, else from gates budget.baseline_per_cell_peak;
- before the batch: the full design (all stages + the arbitration reserve) must project to <= planning_target_usd,
  else stages are dropped from the end (S5, S4, S3, S2; S1 and warm are never dropped) until it does;
- while the batch runs: a stage still to run is affordable when ledger + its unrun cells + the arbitration reserve
  <= cap - reserve - margin; the first stage that is not affordable is skipped with every later one;
- --arbitrate a:c1,c2 prices an arbitration (one more cell at every rep index of those tasks for that arm) against
  the same condition (the reserve is then this estimate).
Prints the ladder; --json prints the same as JSON. Exit 0.
"""
import argparse
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import run_ab  # noqa: E402

GATES_DEFAULT = os.path.join(HERE, "gates-svs2.json")


def baseline_means(gates, baseline_dir=None):
    """{arm: {task: mean cost per cell at peak}} of the baseline arms: from the imported cells, else the gates table."""
    table = {a: dict(v) for a, v in gates["budget"]["baseline_per_cell_peak"].items() if not a.startswith("_")}
    if baseline_dir:
        acc = {}
        for p in glob.glob(os.path.join(baseline_dir, "cells", "*.json")):
            c = run_ab.load_json(p) or {}
            if c.get("valid") and c.get("metrics"):
                acc.setdefault(c["arm"], {}).setdefault(c["alias"], []).append(c["metrics"]["usage"]["cost_peak"])
        for arm, tasks in acc.items():
            for t, xs in tasks.items():
                table.setdefault(arm, {})[t] = round(sum(xs) / len(xs), 6)
    return table


def priors(gates, base):
    pr = gates["budget"]["prior"]
    out = {}
    tasks = set(gates["unit"]["tasks"]) | {"hello"}
    for t in tasks:
        s, k = base.get("slice", {}).get(t), base.get("stock", {}).get(t)
        v = s if t in gates["unit"].get("long_tasks", []) else max(x for x in (s, k) if x is not None)
        out[t] = round(v * pr["safety"], 6)
    return out


def measured(batch_dirs):
    """{(arm, task): [cost_peak]} of the new cells so far (every finished cell, valid or not: they were paid for)."""
    out = {}
    for bd in batch_dirs or []:
        for p in glob.glob(os.path.join(bd, "cells", "*.json")):
            if p.endswith((".budget_stop.json", ".account_stop.json")):
                continue
            c = run_ab.load_json(p) or {}
            cost = (c.get("metrics") or {}).get("usage", {}).get("cost_peak")
            if cost is None:
                cost = c.get("spend_peak_usd")
            if cost is not None:
                out.setdefault((c["arm"], c["alias"]), []).append(cost)
    return out


def done_cells(batch_dirs):
    out = set()
    for bd in batch_dirs or []:
        for p in glob.glob(os.path.join(bd, "cells", "*.json")):
            if p.endswith((".budget_stop.json", ".account_stop.json")):
                continue
            c = run_ab.load_json(p) or {}
            if c.get("status") in ("done", "invalid"):
                out.add((c["arm"], c["alias"], c["rep"]))
    return out


def plan(gates, baseline_dir=None, batch_dirs=(), ledger=None, arbitrate=()):
    b = gates["budget"]
    arms = gates["arms"]
    base = baseline_means(gates, baseline_dir)
    prior = priors(gates, base)
    meas = measured(batch_dirs)
    done = done_cells(batch_dirs)

    def est(arm, t):
        xs = meas.get((arm, t))
        return (sum(xs) / len(xs), "measured") if xs else (prior[t], "prior")
    spent = 0.0
    if ledger and os.path.exists(ledger):
        spent = sum(r.get("usd", 0) for r in run_ab.read_jsonl(ledger))
    limit = b["cap_usd_peak"] - b["reserve_usd"] - b["margin_usd"]
    # arbitration: the reserve, or the requested arbitration(s)
    if arbitrate:
        arb_cells = [(arm, t, r) for arm, ts in arbitrate for t in ts for r in sorted(int(x) for x in gates["pairing"]["baseline_cells"][t])]
    else:
        ar = b["arbitration_reserve"]
        worst = max(arms, key=lambda a: sum(est(a, t)[0] for t in ar["tasks"]))
        arb_cells = [(worst, t, r) for t in ar["tasks"] for r in ar["reps"]]
    arb_usd = sum(est(a, t)[0] for a, t, _ in arb_cells)
    stages = []
    for st in b["stages"]:
        cells = [(a, t, r) for t in st["tasks"] for r in st["reps"] for a in arms]
        todo = [c for c in cells if c not in done]
        stages.append({"id": st["id"], "tasks": st["tasks"], "reps": st["reps"], "cells": len(cells), "cells_to_run": len(todo),
                       "prior_usd": round(sum(prior[t] for _, t, _ in cells), 4),
                       "estimate_usd": round(sum(est(a, t)[0] for a, t, _ in cells), 4),
                       "to_run_usd": round(sum(est(a, t)[0] for a, t, _ in todo), 4)})
    # before the batch: the full design at priors (+ the reserve) against the planning target; drop from the end
    full = sum(s["prior_usd"] for s in stages)
    design = [s["id"] for s in stages]
    p = full + arb_usd
    droppable = [s["id"] for s in stages if s["id"] not in ("warm", "S1")]
    dropped = []
    while p > b["planning_target_usd"] and droppable:
        sid = droppable.pop()
        dropped.append(sid)
        p -= next(s["prior_usd"] for s in stages if s["id"] == sid)
    # while running: the first unaffordable stage is skipped with every later one
    running, run_ok = spent, True
    for s in stages:
        s["affordable"] = run_ok and running + s["to_run_usd"] + arb_usd <= limit
        if s["id"] in dropped:
            s["affordable"] = False
            s["note"] = "dropped by the planning ladder"
        run_ok = s["affordable"]
        if run_ok:
            running += s["to_run_usd"]
    return {
        "cap_usd_peak": b["cap_usd_peak"], "limit_usd": round(limit, 4), "planning_target_usd": b["planning_target_usd"],
        "spent_usd": round(spent, 4), "per_cell_prior": prior, "baseline_means": base,
        "per_cell_estimate": {f"{a}:{t}": {"usd": round(est(a, t)[0], 6), "from": est(a, t)[1]} for a in arms for t in sorted(prior)},
        "stages": stages, "full_design_usd": round(full, 4), "arbitration_usd": round(arb_usd, 4),
        "arbitration_cells": len(arb_cells), "arbitration_is_reserve": not arbitrate,
        "planned_with_arbitration_usd": round(full + arb_usd, 4), "planning_ladder_dropped": dropped, "design": [x for x in design if x not in dropped],
        "projected_end_usd": round(running + arb_usd, 4),
        "expected_usd_no_safety": round(sum(sum(base["slice"].get(t, 0) if t in gates["unit"].get("long_tasks", []) else max(base["slice"].get(t, 0), base["stock"].get(t, 0))
                                                for t in st["tasks"]) * len(st["reps"]) * len(arms) for st in b["stages"]), 4),
    }


def render(res):
    L = [f"cap ${res['cap_usd_peak']:.2f} at peak; stop line (cap - reserve - margin) ${res['limit_usd']:.2f}; planning target ${res['planning_target_usd']:.2f}; "
         f"spent so far ${res['spent_usd']:.4f}",
         "per-cell prior (peak): " + ", ".join(f"{t} ${v:.4f}" for t, v in sorted(res["per_cell_prior"].items())),
         "", "| stage | tasks | reps | cells | prior $ | estimate $ | cells to run | to run $ | affordable now |", "|---|---|---|---|---|---|---|---|---|"]
    for s in res["stages"]:
        L.append(f"| {s['id']} | {','.join(s['tasks'])} | {s['reps']} | {s['cells']} | {s['prior_usd']:.4f} | {s['estimate_usd']:.4f} | {s['cells_to_run']} | "
                 f"{s['to_run_usd']:.4f} | {'yes' if s['affordable'] else 'NO'}{' (' + s['note'] + ')' if s.get('note') else ''} |")
    L += ["", f"full design ${res['full_design_usd']:.4f} + arbitration {'reserve' if res['arbitration_is_reserve'] else 'requested'} "
          f"${res['arbitration_usd']:.4f} ({res['arbitration_cells']} cells) = ${res['planned_with_arbitration_usd']:.4f}; "
          f"planning ladder dropped {res['planning_ladder_dropped'] or 'nothing'}; projected end ${res['projected_end_usd']:.4f}; "
          f"expected without the safety factor ${res['expected_usd_no_safety']:.4f} (no arbitration)"]
    return "\n".join(L) + "\n"


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--gates", default=GATES_DEFAULT)
    ap.add_argument("--baseline")
    ap.add_argument("--batch", action="append")
    ap.add_argument("--ledger")
    ap.add_argument("--arbitrate", action="append", help="ARM:TASK,TASK (repeatable)")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    arb = []
    for spec in a.arbitrate or []:
        arm, _, ts = spec.partition(":")
        arb.append((arm, [t for t in ts.split(",") if t]))
    res = plan(run_ab.load_json(a.gates), a.baseline, a.batch or [], a.ledger, arb)
    print(json.dumps(res, indent=1) if a.json else render(res))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
