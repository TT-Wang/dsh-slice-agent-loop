#!/usr/bin/env python3
"""Unit tests for run_ab.py's pure parts (budget accounting, turn classification, answer classes, attempt
numbering on --resume):  python3 scripts/ab/test_run_ab.py"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_ab as A  # noqa: E402

PEAK = {"miss": 0.44, "hit": 0.014, "out": 1.32}


def stdout_file(lines):
    fd, path = tempfile.mkstemp(suffix=".jsonl")
    with os.fdopen(fd, "w") as fh:
        for ev in lines:
            fh.write(json.dumps(ev) + "\n")
    return path


class StdoutUsage(unittest.TestCase):
    def test_unpriced_and_open_steps(self):
        u = {"inputTokens": 1_000_000, "cacheReadTokens": 0, "outputTokens": 0}
        path = stdout_file([
            {"type": "session", "sessionId": "s1"},
            {"type": "status", "phase": "turn_start", "turn": 3},
            {"type": "status", "phase": "step_start", "turn": 3, "step": 1},
            {"type": "status", "phase": "step_end", "turn": 3, "step": 1, "usage": u},
            {"type": "status", "phase": "step_start", "turn": 3, "step": 2},
            {"type": "status", "phase": "step_end", "turn": 3, "step": 2},  # a retried attempt reported no sample
            {"type": "status", "phase": "step_start", "turn": 3, "step": 3},  # killed mid-request
        ])
        p = A.usage_from_stdout(path)
        os.remove(path)
        self.assertEqual((p["steps"], p["unpriced_steps"], p["open_steps"], p["turns"], p["sid"]), (2, 1, 1, [3], "s1"))
        b = A.Budget("/nonexistent/ledger.jsonl", 10, 0.75, 0.6, PEAK, unpriced_usd=0.05, max_unpriced=1)
        usd, n = b.price_parsed(p)
        self.assertAlmostEqual(usd, 0.44 + 2 * 0.05)
        self.assertEqual(n, 2)
        b.set_live("c", usd, n)
        self.assertTrue(b.too_many_unpriced())   # 2 > 1: stop cleanly
        self.assertTrue(b.exhausted())
        self.assertFalse(b.can_start())

    def test_margin_and_reserve(self):
        b = A.Budget("/nonexistent/ledger.jsonl", 1.0, 0.3, 0.2, PEAK)
        b.set_live("c", 0.75)
        self.assertFalse(b.exhausted())
        self.assertFalse(b.can_start())          # 0.75 + 0.3 >= 1
        b.set_live("c", 0.80)
        self.assertTrue(b.exhausted())           # 0.80 + 0.2 >= 1


class Classify(unittest.TestCase):
    def rec(self, exit_code, **kw):
        return dict({"timeout": False, "budget_kill": False, "exit": exit_code, "error_code": None}, **kw)

    def test_infra_is_only_provider_network_credential_or_timeout(self):
        err = lambda code: {"kind": "error", "error": {"code": code, "message": "x"}}  # noqa: E731
        self.assertTrue(A.classify_end(self.rec(1), err("TRANSPORT"), ""))
        self.assertTrue(A.classify_end(self.rec(1), err("RATE_LIMIT"), ""))
        self.assertTrue(A.classify_end(self.rec(1), err("SERVER"), ""))
        self.assertTrue(A.classify_end(self.rec(1), err("HTTP_503"), ""))
        self.assertTrue(A.classify_end(self.rec(1), err("MISSING_CREDENTIAL"), ""))
        self.assertTrue(A.classify_end(self.rec(1), None, ""))                        # no turn_end: the process died
        self.assertTrue(A.classify_end(self.rec(1, timeout=True), None, ""))
        self.assertFalse(A.classify_end(self.rec(1), err("CONTEXT_WINDOW_EXCEEDED"), ""))
        self.assertFalse(A.classify_end(self.rec(1), err("INVALID_REQUEST"), ""))
        self.assertFalse(A.classify_end(self.rec(1), err("UNKNOWN"), ""))
        self.assertFalse(A.classify_end(self.rec(1), {"kind": "blocked"}, ""))
        self.assertFalse(A.classify_end(self.rec(1), {"kind": "max-tokens"}, ""))
        self.assertFalse(A.classify_end(self.rec(0), {"kind": "completed"}, ""))
        t = {"infra": False, "exit": 1, "turn_end": {"kind": "error"}}
        self.assertTrue(A.turn_ok(t))                                                # the cell continues; G5 counts it


class AnswerClass(unittest.TestCase):
    def test_how_text_never_decides(self):
        ok_detail = "fingerprint recovered from tool output; script+fixtures gone; substrate ok | how: 'CANNOT-RECOVER was not needed; hedged nothing'"
        self.assertEqual(A.answer_class(True, ok_detail, {}), "correct")
        self.assertEqual(A.answer_class(False, "LOSS: substrate: normalize_id missing in lib/ids.py | how: 'DECOY avoided'", {}), "correct")
        self.assertEqual(A.answer_class(False, "LOSS: DECOY fx-8b69ed7a (a user-flood log line) | how: 'x'", {}), "decoy")
        self.assertEqual(A.answer_class(False, "LOSS: STALE cfg-81d29c44 (the T2 value)", {}), "stale")
        self.assertEqual(A.answer_class(False, "whatever", {"exam_class": "wrong"}), "wrong")


class ResumeNumbering(unittest.TestCase):
    def test_attempts_continue_after_a_budget_stop(self):
        d = tempfile.mkdtemp(prefix="ab-resume-test-")
        os.makedirs(os.path.join(d, "cells"))
        index = os.path.join(d, "index.jsonl")
        with open(index, "w") as fh:
            fh.write(json.dumps({"cell": "t.r1.arm1", "attempt": 1, "status": "budget_stop"}) + "\n")
        seen = []

        def fake_run_cell(ctx, task, rep, arm, attempt):
            seen.append(attempt)
            return {"cell": A.cell_id(task, rep, arm), "status": "done", "valid": True}
        orig = A.run_cell
        A.run_cell = fake_run_cell
        try:
            ctx = {"batch_dir": d, "index": index, "resume": True, "max_attempts": 2,
                   "budget": A.Budget(os.path.join(d, "spend.jsonl"), 10, 0.1, 0.1, PEAK)}
            cell = A.run_cell_with_retries(ctx, "t", 1, "arm1")
        finally:
            A.run_cell = orig
            shutil.rmtree(d)
        self.assertEqual(seen, [2])                                  # not 1 again: workdir, turn files, ledger rows stay unique
        self.assertEqual([a["attempt"] for a in cell["attempts"]], [1, 2])


if __name__ == "__main__":
    unittest.main(verbosity=2)
