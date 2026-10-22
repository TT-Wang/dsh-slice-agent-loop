#!/usr/bin/env python3
"""Unit tests for the gate evaluator in ab_report.py:  python3 scripts/ab/test_ab_report.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ab_report as R  # noqa: E402


def kept(rows):
    """rows: [(task, {metric: arm}, {metric: base})] -> evaluate()'s pair list."""
    return [(("b", t, i + 1), a, b) for i, (t, a, b) in enumerate(rows)]


class Evaluate(unittest.TestCase):
    def test_non_inferiority_counts(self):
        ch = {"id": "G1.total", "metric": "pass", "rule": "ge_base_minus", "margin": 1, "count": True}
        rows = lambda arm: kept([("r1", {"pass": a}, {"pass": 1}) for a in arm])  # noqa: E731
        self.assertEqual(R.evaluate(ch, rows([1, 1, 0]), 1)["verdict"], "pass")        # 2 >= 3 - 1
        self.assertEqual(R.evaluate(ch, rows([1, 0, 0]), 1)["verdict"], "arbitrate")   # one short
        self.assertEqual(R.evaluate(ch, rows([0, 0, 0]), 1)["verdict"], "fail")
        self.assertEqual(R.evaluate(ch, rows([1, 0, 0]), 2)["verdict"], "pass")        # pooled: margin doubled

    def test_per_task_drop(self):
        ch = {"id": "G1.per_task", "metric": "pass", "rule": "no_task_drop", "drop": 2, "count": True}
        ok = kept([("r1", {"pass": 1}, {"pass": 1}), ("r1", {"pass": 1}, {"pass": 1}), ("r1", {"pass": 0}, {"pass": 1})])
        bad = kept([("r1", {"pass": 1}, {"pass": 1}), ("r1", {"pass": 0}, {"pass": 1}), ("r1", {"pass": 0}, {"pass": 1})])
        self.assertEqual(R.evaluate(ch, ok, 1)["verdict"], "pass")
        r = R.evaluate(ch, bad, 1)                                                     # 1 <= 3 - 2
        self.assertEqual((r["verdict"], r["worst_task"]), ("arbitrate", "r1"))

    def test_rereads_factor(self):
        ch = {"id": "G3", "metric": "rereads_same_turn", "rule": "le_factor_base_plus", "factor": 1.25, "margin": 2, "count": True}
        self.assertEqual(R.evaluate(ch, kept([("c1", {"rereads_same_turn": 14}, {"rereads_same_turn": 10})]), 1)["verdict"], "pass")
        self.assertEqual(R.evaluate(ch, kept([("c1", {"rereads_same_turn": 15}, {"rereads_same_turn": 10})]), 1)["verdict"], "arbitrate")
        self.assertEqual(R.evaluate(ch, kept([("c1", {"rereads_same_turn": 25}, {"rereads_same_turn": 10})]), 1)["verdict"], "fail")

    def test_cost_median_and_total(self):
        med = {"id": "G4.median_ratio", "metric": "cost", "rule": "median_ratio_le", "value": 1.10, "arbitration_unit": 0.05}
        tot = {"id": "G4.total", "metric": "cost", "rule": "le_factor_base_plus", "factor": 1.10, "margin": 0, "arbitration_unit": 0.05, "relative_unit": True}
        rows = kept([("r1", {"cost": 1.05}, {"cost": 1.0}), ("r2", {"cost": 1.25}, {"cost": 1.0}), ("r3", {"cost": 1.12}, {"cost": 1.0})])
        self.assertEqual(R.evaluate(med, rows, 1)["verdict"], "arbitrate")             # median 1.12: 0.4 units past 1.10
        self.assertEqual(R.evaluate(tot, rows, 1)["verdict"], "arbitrate")             # 3.42 / 3 = 1.14: 0.8 units
        more = kept([("r1", {"cost": 1.05}, {"cost": 1.0}), ("r2", {"cost": 1.30}, {"cost": 1.0}), ("r3", {"cost": 1.12}, {"cost": 1.0})])
        self.assertEqual(R.evaluate(tot, more, 1)["verdict"], "fail")                  # 3.47 / 3 = 1.157: 1.13 units
        self.assertEqual(R.evaluate(tot, kept([("r1", {"cost": 1.5}, {"cost": 1.0})]), 1)["verdict"], "fail")

    def test_first_try_rate(self):
        ch = {"id": "G6.first_try", "metric": "cross_turn_first_try", "rule": "rate_ge_base_minus", "margin": 0.10, "min_targets": 1, "na_ok": True}
        row = lambda ok, n: {"cross_turn_first_try_ok": ok, "cross_turn_targets": n}  # noqa: E731
        self.assertEqual(R.evaluate(ch, kept([("r1", row(9, 10), row(10, 10))]), 1)["verdict"], "pass")
        self.assertEqual(R.evaluate(ch, kept([("r1", row(8, 10), row(10, 10))]), 1)["verdict"], "arbitrate")
        self.assertEqual(R.evaluate(ch, kept([("r1", row(5, 10), row(10, 10))]), 1)["verdict"], "fail")
        self.assertEqual(R.evaluate(ch, kept([("r1", row(3, 4), row(0, 0))]), 1)["verdict"], "n/a")

    def test_all_recovered(self):
        ch = {"id": "G2c.recovered", "metric": "fv_rejections_unrecovered", "rule": "arm_eq", "value": 0, "count": True}
        self.assertEqual(R.evaluate(ch, kept([("r1", {"fv_rejections_unrecovered": 0}, {"fv_rejections_unrecovered": 3})]), 1)["verdict"], "pass")
        self.assertEqual(R.evaluate(ch, kept([("r1", {"fv_rejections_unrecovered": 1}, {"fv_rejections_unrecovered": 0})]), 1)["verdict"], "arbitrate")


class NotEvaluable(unittest.TestCase):
    """A check with no or too few valid pairs must never pass by default (it would let a vacuous G2 ship)."""

    def test_no_pairs_is_insufficient_unless_na_ok(self):
        g2a = {"id": "G2a", "metric": "recall_sourced_correct", "rule": "ge_base_minus", "margin": 1, "count": True}
        self.assertEqual(R.evaluate(g2a, [], 1)["verdict"], "insufficient")
        first = {"id": "G6.first_try", "metric": "cross_turn_first_try", "rule": "rate_ge_base_minus", "margin": 0.10, "min_targets": 1, "na_ok": True}
        self.assertEqual(R.evaluate(first, [], 1)["verdict"], "n/a")
        row = {"cross_turn_first_try_ok": 0, "cross_turn_targets": 0}
        self.assertEqual(R.evaluate(dict(first, na_ok=False), kept([("r1", row, row)]), 1)["verdict"], "insufficient")

    def test_too_few_pairs(self):
        g2b = {"id": "G2b", "metric": "recall_errors", "rule": "le_base_plus", "margin": 2, "count": True}
        nine = kept([("r1", {"recall_errors": 0}, {"recall_errors": 0})] * 9)
        ten = kept([("r1", {"recall_errors": 0}, {"recall_errors": 0})] * 10)
        r = R.evaluate(g2b, nine, 1, 10)
        self.assertEqual((r["verdict"], r["pairs"], r["min_pairs"]), ("insufficient", 9, 10))
        self.assertEqual(R.evaluate(g2b, ten, 1, 10)["verdict"], "pass")

    def test_gate_and_decision(self):
        v = lambda *xs: [{"verdict": x} for x in xs]  # noqa: E731
        self.assertEqual(R.gate_verdict(v("pass", "n/a")), "pass")
        self.assertEqual(R.gate_verdict(v("pass", "insufficient", "arbitrate")), "insufficient")
        self.assertEqual(R.gate_verdict(v("insufficient", "fail")), "fail")
        ids = ["G1", "G2"]
        self.assertTrue(R.decide({"G1": "pass", "G2": "pass"}, ids, "ship", "no").startswith("ship"))
        self.assertTrue(R.decide({"G1": "pass", "G2": "insufficient"}, ids, "ship", "no").startswith("no on this batch"))
        self.assertTrue(R.decide({"G1": "arbitrate", "G2": "pass"}, ids, "ship", "no").startswith("arbitration"))
        self.assertTrue(R.decide({"G1": "fail", "G2": "insufficient"}, ids, "ship", "no").startswith("no (a gate failed)"))


class Room(unittest.TestCase):
    """F ships only with at least one unit of room on every check (docs/p110-f-native-ab.md §9)."""

    def test_room_units(self):
        g1 = {"id": "G1.total", "metric": "pass", "rule": "ge_base_minus", "margin": 1, "count": True}
        rows = lambda arm: kept([("r1", {"pass": a}, {"pass": 1}) for a in arm])  # noqa: E731
        self.assertEqual(R.evaluate(g1, rows([1, 1, 1]), 1)["room_units"], 1)
        self.assertEqual(R.evaluate(g1, rows([1, 1, 0]), 1)["room_units"], 0)         # passes at its limit
        req = {"id": "G4.requests", "metric": "requests", "rule": "median_delta_le", "value": 1, "arbitration_unit": 1}
        r = R.evaluate(req, kept([("r1", {"requests": 11}, {"requests": 10})] * 3), 1)
        self.assertEqual((r["verdict"], r["room_units"]), ("pass", 0))                 # the 2026-09-27 arm 2 case
        self.assertEqual(R.evaluate(req, kept([("r1", {"requests": 10}, {"requests": 10})]), 1)["room_units"], 1)
        med = {"id": "G4.median_ratio", "metric": "cost", "rule": "median_ratio_le", "value": 1.10, "arbitration_unit": 0.05}
        self.assertAlmostEqual(R.evaluate(med, kept([("r1", {"cost": 1.0}, {"cost": 1.0})]), 1)["room_units"], 2.0)
        drop = {"id": "G1.per_task", "metric": "pass", "rule": "no_task_drop", "drop": 2, "count": True}
        self.assertEqual(R.evaluate(drop, kept([("r1", {"pass": 1}, {"pass": 1})] * 3), 1)["room_units"], 1)
        self.assertEqual(R.evaluate(drop, kept([("r1", {"pass": 1}, {"pass": 1})] * 2 + [("r1", {"pass": 0}, {"pass": 1})]), 1)["room_units"], 0)
        rate = {"id": "G6.first_try", "metric": "cross_turn_first_try", "rule": "rate_ge_base_minus", "margin": 0.10, "min_targets": 1}
        row = lambda ok, n: {"cross_turn_first_try_ok": ok, "cross_turn_targets": n}  # noqa: E731
        self.assertEqual(R.evaluate(rate, kept([("r1", row(50, 50), row(50, 50))]), 1)["room_units"], 5)
        self.assertEqual(R.evaluate(rate, kept([("r1", row(45, 50), row(50, 50))]), 1)["room_units"], 0)
        eq = {"id": "G2c.recovered", "metric": "fv_rejections_unrecovered", "rule": "arm_eq", "value": 0, "count": True}
        self.assertIsNone(R.evaluate(eq, kept([("r1", {"fv_rejections_unrecovered": 0}, {"fv_rejections_unrecovered": 0})]), 1)["room_units"])

    def test_pooled_minimum_pairs_scale(self):
        g2b = {"id": "G2b", "metric": "recall_errors", "rule": "le_base_plus", "margin": 2, "count": True}
        nineteen = kept([("r1", {"recall_errors": 0}, {"recall_errors": 0})] * 19)
        self.assertEqual(R.evaluate(g2b, nineteen, 1, 10)["verdict"], "pass")
        r = R.evaluate(g2b, nineteen, 2, 10, 2)
        self.assertEqual((r["verdict"], r["min_pairs"]), ("insufficient", 20))

    def test_decision(self):
        spec = {"gates": ["G1", "G4"], "ship": "ship F", "drop": "do not ship F"}
        chk = lambda i, v, room: {"id": i, "verdict": v, "room_units": room}  # noqa: E731
        gates = lambda *cs: [{"id": "G1", "checks": [cs[0]]}, {"id": "G4", "checks": list(cs[1:])}]  # noqa: E731
        self.assertEqual(R.decide_with_room(gates(chk("G1.total", "pass", 1), chk("G4.requests", "pass", 2)), spec, False, 1), "ship F")
        d = R.decide_with_room(gates(chk("G1.total", "pass", 1), chk("G4.requests", "pass", 0)), spec, False, 1)
        self.assertTrue(d.startswith("arbitration") and "G4.requests" in d, d)
        self.assertTrue(R.decide_with_room(gates(chk("G1.total", "pass", 1), chk("G4.requests", "pass", 0)), spec, True, 1).startswith("do not ship F (pooled"))
        self.assertTrue(R.decide_with_room(gates(chk("G1.total", "fail", -3), chk("G4.requests", "pass", 0)), spec, False, 1).startswith("do not ship F (failed"))
        self.assertTrue(R.decide_with_room(gates(chk("G1.total", "insufficient", None), chk("G4.requests", "pass", 3)), spec, False, 1).startswith("arbitration"))
        self.assertEqual(R.decide_with_room(gates(chk("G1.total", "pass", 1), chk("G2c.recovered", "pass", None)), spec, False, 1), "ship F")


def synthetic_cells(d, worse_arm, gates_arm):
    import json
    os.makedirs(os.path.join(d, "cells"))
    tasks = {"r1": 1, "r2": 1, "r3": 1, "r4": 1, "r5": 1, "c1": 0, "c2": 0}
    for t, recall in tasks.items():
        for rep in (1, 2, 3):
            for arm in ("control", gates_arm):
                bad = arm == worse_arm and recall
                m = {"recall": {"errors": 50 if bad else 0, "fv_rejections": 20 if bad else 0, "fv_rejections_recovered": 0, "recall_turn_views": {"full": 0},
                                "expand_cross_turn": {"targets": 1, "first_try_ok": 1}, "extra_hops": 0, "tools": {"expand_result": {"calls": 1}}},
                     "reads": {"reread_same_turn_unchanged": 0, "reread_same_turn_after_edit": 0, "fold_then_reread": 0, "reread_cross_turn": 0, "repeat_tool_reminders": 0},
                     "finish": {"closeout": 3, "completed": 3, "step_limit_cut": 0}, "exams": [{"recall_sourced": not bad}],
                     "usage": {"cost_offpeak": 1.0, "cost_peak": 2.0, "requests": 10, "miss": 1, "hit": 1, "out": 1, "turn_first_miss": 1, "attempts_failed": 0},
                     "validity": {}}
                cell = {"cell": f"{t}.r{rep}.{arm}", "alias": t, "arm": arm, "rep": rep, "valid": True, "pass": True, "metrics": m,
                        "exam_class": ("decoy" if bad else "correct") if recall else None, "g2_excluded": bool(recall) and worse_arm is not None}
                with open(os.path.join(d, "cells", cell["cell"] + ".json"), "w") as fh:
                    json.dump(cell, fh)


class EndToEndF(unittest.TestCase):
    def test_equal_arms_ship_with_room_and_vacuous_g2_does_not(self):
        import json, shutil, tempfile
        d = tempfile.mkdtemp(prefix="ab-report-test-")
        synthetic_cells(d, None, "F")
        R.main([d, "--out", d, "--gates", os.path.join(os.path.dirname(os.path.abspath(__file__)), "gates-f.json")])
        with open(os.path.join(d, "summary.json")) as fh:
            s = json.load(fh)
        self.assertEqual(s["decision"]["F"], "ship F (every gate passes with at least one unit of room)")
        shutil.rmtree(d)
        d = tempfile.mkdtemp(prefix="ab-report-test-")
        synthetic_cells(d, "F", "F")
        R.main([d, "--out", d])
        with open(os.path.join(d, "summary.json")) as fh:
            s = json.load(fh)
        self.assertTrue(s["decision"]["F"].startswith("arbitration (insufficient: G2a"), s["decision"]["F"])
        shutil.rmtree(d)


class VacuousG2(unittest.TestCase):
    """End to end on synthetic cells: every recall pair excluded from G2 and arm1 much worse must not ship."""

    def test_all_recall_pairs_excluded(self):
        import json, tempfile
        d = tempfile.mkdtemp(prefix="ab-report-test-")
        os.makedirs(os.path.join(d, "cells"))
        tasks = {"r1": 1, "r2": 1, "r3": 1, "r4": 1, "r5": 1, "c1": 0, "c2": 0}
        for t, recall in tasks.items():
            for rep in (1, 2, 3):
                for arm in ("control", "arm1"):
                    bad = arm == "arm1" and recall
                    m = {"recall": {"errors": 50 if bad else 0, "fv_rejections": 20 if bad else 0, "fv_rejections_recovered": 0, "recall_turn_views": {"full": 0},
                                    "expand_cross_turn": {"targets": 1, "first_try_ok": 1}, "extra_hops": 0, "tools": {"expand_result": {"calls": 1}}},
                         "reads": {"reread_same_turn_unchanged": 0, "reread_same_turn_after_edit": 0, "fold_then_reread": 0, "reread_cross_turn": 0, "repeat_tool_reminders": 0},
                         "finish": {"closeout": 3, "completed": 3, "step_limit_cut": 0}, "exams": [{"recall_sourced": not bad}],
                         "usage": {"cost_offpeak": 1.0, "cost_peak": 2.0, "requests": 10, "miss": 1, "hit": 1, "out": 1, "turn_first_miss": 1, "attempts_failed": 0},
                         "validity": {}}
                    cell = {"cell": f"{t}.r{rep}.{arm}", "alias": t, "arm": arm, "rep": rep, "valid": True, "pass": True, "metrics": m,
                            "exam_class": ("decoy" if bad else "correct") if recall else None, "g2_excluded": bool(recall)}
                    with open(os.path.join(d, "cells", cell["cell"] + ".json"), "w") as fh:
                        json.dump(cell, fh)
        R.main([d, "--out", d, "--gates", os.path.join(os.path.dirname(os.path.abspath(__file__)), "gates.json")])  # the 2026-09-27 file
        with open(os.path.join(d, "summary.json")) as fh:
            s = json.load(fh)
        g2 = next(g for g in s["gates"]["arm1"] if g["id"] == "G2")
        self.assertEqual(g2["verdict"], "insufficient")
        self.assertFalse(s["decision"]["arm1"].startswith("ship"))
        import shutil
        shutil.rmtree(d)


if __name__ == "__main__":
    unittest.main(verbosity=2)
