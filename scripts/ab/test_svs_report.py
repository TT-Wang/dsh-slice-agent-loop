#!/usr/bin/env python3
"""Unit tests for svs_report.py (the slice-vs-stock decision rules):  python3 scripts/ab/test_svs_report.py"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import svs_report as S  # noqa: E402

GATES = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "gates-svs.json")))
TASKS = GATES["unit"]["tasks"]


def cell(task, rep, arm, cost, ok=True, mem=None, excluded=False, valid=True, compacted=False):
    """A cells/*.json record with the fields svs_report reads."""
    c = {"cell": f"{task}.r{rep}.{arm}", "alias": task, "task": task, "rep": rep, "arm": arm, "valid": valid, "pass": ok, "g2_excluded": excluded,
         "invalid_reasons": [] if valid else ["x"], "wall_s": 10,
         "metrics": {"usage": {"cost_offpeak": cost, "cost_peak": 2 * cost, "miss": 1, "hit": 1, "out": 1, "requests": 3, "cache_hit_rate": 0.9},
                     "finish": {"closeout": 1, "step_limit_cut": 0}, "reads": {"reread_same_turn_unchanged": 0, "reread_same_turn_after_edit": 0},
                     "compaction": {"summaries": 1 if compacted else 0, "failed": 0, "prunes": 0, "turns": [], "context_limit_errors": 0},
                     "context": {"peak_request_tokens": 1000}, "per_turn": {"1": {"max_step": 3}},
                     "exams": [{"compacted_before": compacted}]}}
    if task == "f1":
        classes = mem or {"build_id": "correct", "lint_error": "correct", "deploy": "correct", "trap": "correct"}
        c["verify_info"] = {"memory_classes": classes}
        c["exam_class"] = "correct"
    elif task.startswith("r"):
        c["exam_class"] = mem or ("correct" if ok else "wrong")
    return c


def write_batch(cells):
    d = tempfile.mkdtemp(prefix="svs-report-")
    os.makedirs(os.path.join(d, "cells"))
    for c in cells:
        with open(os.path.join(d, "cells", c["cell"] + ".json"), "w") as fh:
            json.dump(c, fh)
    return d


def full(slice_cost, stock_cost, over=None):
    """Every planned pair, slice and stock; slice_cost/stock_cost: task -> cost."""
    out, over = [], over or {}
    for t in TASKS:
        for r in range(1, GATES["unit"]["reps"][t] + 1):
            out.append(cell(t, r, "slice", slice_cost.get(t, 1.0), **over.get(("slice", t, r), {})))
            out.append(cell(t, r, "stock", stock_cost.get(t, 1.0), **over.get(("stock", t, r), {})))
    return out


class Decision(unittest.TestCase):
    def run_cells(self, cells, pooled=False):
        d = write_batch(cells)
        try:
            return S.build_summary([d], GATES, pooled=pooled)
        finally:
            shutil.rmtree(d)

    def test_worth_it(self):
        s = self.run_cells(full({"f1": 0.6}, {"f1": 1.0}))
        c = s["comparisons"]["slice vs stock"]
        self.assertEqual((c["pairs"], c["L"], c["N"], c["dS"], c["memory"]["items"]), (23, 0.6, 1.0, 0, 23))
        self.assertEqual(s["decision"]["verdict"], "worth it")
        self.assertEqual(s["decision"]["arbitration"], "not required")

    def test_not_worth_it_no_saving(self):
        s = self.run_cells(full({t: 1.1 for t in TASKS}, {}))
        self.assertEqual(s["decision"]["verdict"], "not worth it")

    def test_mixed_is_inconclusive_and_band_triggers_arbitration(self):
        s = self.run_cells(full({"f1": 0.5, **{t: 1.15 for t in TASKS if t != "f1"}}, {}))
        self.assertEqual(s["decision"]["verdict"], "inconclusive")
        self.assertIn("verdict moves", s["decision"]["arbitration"])  # N 1.15 is within 0.05 of 1.10

    def test_quality_floor_fails_on_memory(self):
        bad = {"build_id": "decoy", "lint_error": "wrong", "deploy": "correct", "trap": "correct"}
        s = self.run_cells(full({"f1": 0.5}, {}, {("slice", "f1", 1): {"mem": bad, "ok": False}}))
        c = s["comparisons"]["slice vs stock"]
        self.assertEqual((c["memory"]["dM"], c["memory"]["dB"], c["dS"]), (-2, 2, -1))
        self.assertEqual(s["decision"]["verdict"], "not worth it")

    def test_memory_exclusion_and_minimums(self):
        over = {("slice", t, r): {"valid": False} for t in ("r1", "r2") for r in (1, 2)}
        s = self.run_cells(full({"f1": 0.5}, {}, over))
        c = s["comparisons"]["slice vs stock"]
        self.assertEqual(c["pairs"], 19)
        self.assertIn("r1: 1 pairs < 2", c["insufficient"])
        self.assertEqual(s["decision"]["verdict"], "inconclusive")
        over = {("stock", "r3", 1): {"excluded": True}}
        c = self.run_cells(full({"f1": 0.5}, {}, over))["comparisons"]["slice vs stock"]
        self.assertEqual((c["memory"]["pairs"], c["memory"]["items"], len(c["memory"]["dropped"])), (16, 22, 1))

    def test_slice_better_route(self):
        lost = {"build_id": "cannot_recover", "lint_error": "cannot_recover", "deploy": "correct", "trap": "correct"}
        s = self.run_cells(full({"f1": 0.9}, {}, {("stock", "f1", 1): {"mem": lost, "ok": False}}))
        c = s["comparisons"]["slice vs stock"]
        self.assertEqual((c["memory"]["dM"], c["memory"]["dB"]), (2, 0))  # an honest miss is not a bad answer
        self.assertEqual(s["decision"]["verdict"], "worth it")
        self.assertIn("better", s["decision"]["because"])

    def test_slice_better_margin_triggers_arbitration(self):
        # dM +2 decides rule 4 at L 0.9: one item less and the verdict would be inconclusive, so the batch arbitrates
        lost = {"build_id": "cannot_recover", "lint_error": "cannot_recover", "deploy": "correct", "trap": "correct"}
        s = self.run_cells(full({"f1": 0.9}, {}, {("stock", "f1", 1): {"mem": lost, "ok": False}}))
        self.assertEqual(s["decision"]["verdict"], "worth it")
        self.assertIn("'slice better' at its margin", s["decision"]["arbitration"])
        # the same margin under rule 3 (L 0.6) does not matter: no trigger
        s = self.run_cells(full({"f1": 0.6}, {}, {("stock", "f1", 1): {"mem": lost, "ok": False}}))
        self.assertEqual((s["decision"]["verdict"], s["decision"]["arbitration"]), ("worth it", "not required"))
        # dM +1 with L 0.9 (rule 4 would decide at +2): inconclusive now, arbitration required
        one = {"build_id": "cannot_recover", "lint_error": "correct", "deploy": "correct", "trap": "correct"}
        s = self.run_cells(full({"f1": 0.9}, {}, {("stock", "f1", 1): {"mem": one, "ok": False}}))
        self.assertEqual(s["decision"]["verdict"], "inconclusive")
        self.assertIn("'slice better' at its margin", s["decision"]["arbitration"])

    def test_minimum_rule_precedes_quality_floor(self):
        # §7 rule 1 before rule 2: a minimum not met is inconclusive even where Q fails (gates-svs.json rules[0])
        self.assertEqual(GATES["decision"]["rules"][0]["verdict"], "inconclusive")
        bad = {"build_id": "decoy", "lint_error": "wrong", "deploy": "wrong", "trap": "confabulated"}
        over = {("slice", "f1", 1): {"mem": bad, "ok": False}, ("slice", "c1", 1): {"valid": False}, ("slice", "c1", 2): {"valid": False}}
        s = self.run_cells(full({"f1": 0.5}, {}, over))
        self.assertEqual(s["decision"]["verdict"], "inconclusive")
        self.assertIn("minimum", s["decision"]["because"])

    def test_n_split_is_reported(self):
        s = self.run_cells(full({"f1": 0.6, "c1": 1.21, "c2": 1.21}, {}))
        c = s["comparisons"]["slice vs stock"]
        self.assertEqual((c["N_recall"], c["N_coding"]), (1.0, 1.21))
        self.assertEqual(s["decision"]["verdict"], "worth it")  # N = 1.21^(2/7) = 1.056: the split never decides

    def test_pooled_has_no_band_test(self):
        s = self.run_cells(full({"f1": 0.79}, {}), pooled=True)
        self.assertEqual(s["decision"]["verdict"], "worth it")
        self.assertNotIn("arbitration", s["decision"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
