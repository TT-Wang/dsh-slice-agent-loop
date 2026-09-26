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
        ch = {"id": "G6.first_try", "metric": "cross_turn_first_try", "rule": "rate_ge_base_minus", "margin": 0.10, "min_targets": 1}
        row = lambda ok, n: {"cross_turn_first_try_ok": ok, "cross_turn_targets": n}  # noqa: E731
        self.assertEqual(R.evaluate(ch, kept([("r1", row(9, 10), row(10, 10))]), 1)["verdict"], "pass")
        self.assertEqual(R.evaluate(ch, kept([("r1", row(8, 10), row(10, 10))]), 1)["verdict"], "arbitrate")
        self.assertEqual(R.evaluate(ch, kept([("r1", row(5, 10), row(10, 10))]), 1)["verdict"], "fail")
        self.assertEqual(R.evaluate(ch, kept([("r1", row(3, 4), row(0, 0))]), 1)["verdict"], "n/a")

    def test_all_recovered(self):
        ch = {"id": "G2c.recovered", "metric": "fv_rejections_unrecovered", "rule": "arm_eq", "value": 0, "count": True}
        self.assertEqual(R.evaluate(ch, kept([("r1", {"fv_rejections_unrecovered": 0}, {"fv_rejections_unrecovered": 3})]), 1)["verdict"], "pass")
        self.assertEqual(R.evaluate(ch, kept([("r1", {"fv_rejections_unrecovered": 1}, {"fv_rejections_unrecovered": 0})]), 1)["verdict"], "arbitrate")


if __name__ == "__main__":
    unittest.main(verbosity=2)
