#!/usr/bin/env python3
"""Unit tests for run_ab.py's pure parts (budget accounting, turn classification, answer classes, cell validity,
attempt numbering on --resume):  python3 scripts/ab/test_run_ab.py"""
import json
import os
import shutil
import sys
import tempfile
import time
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


class Validity(unittest.TestCase):
    def test_undelivered_fact_invalidates_the_cell(self):
        row = {"validity": {"tools_count": 16, "tool_lists_distinct": 1, "system_distinct": 1, "system_has_host_path": False, "compaction_events": 0,
                            "user_prompts": 4, "turn_ends": 4, "goal_messages": 0, "system_sha": "s", "slice_tools_sha": "t"},
               "prefix": {"prefix_chars": 18311}, "tape": {"header_forms": {}, "header_lengths": [], "tool_line_forms": {}},
               "in_turn": [], "delivery": [{"turn": 1, "n_tokens": 1, "delivered": False, "tool": None}, {"turn": 2, "n_tokens": 1, "delivered": True, "tool": "bash"}]}
        turns = [{"turn": n, "infra": False, "exit": 0, "turn_end": {"kind": "completed"}} for n in range(1, 5)]
        ctx = {"fingerprints": None}
        reasons = A.validity(ctx, "control", {"turns": 4}, turns, row)
        self.assertEqual(reasons, ["fact not delivered: no turn-1 tool result carried it (output discarded or never produced)"])
        row["delivery"][0]["delivered"] = True
        self.assertEqual(A.validity(ctx, "control", {"turns": 4}, turns, row), [])
        # a delivery turn that never ran is reported by the incomplete-cell reason, not by this one
        row["delivery"][1]["delivered"] = False
        self.assertEqual(A.validity(ctx, "control", {"turns": 4}, turns[:1], row, complete=False), [])


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


class Isolation(unittest.TestCase):
    """Blocked paths are mode 000 while a turn runs; a chmod, rename or replacement in that window is a breach."""

    def setUp(self):
        self.ab = os.path.realpath(tempfile.mkdtemp(prefix="ab-iso-test-"))
        for d in ("vault", "wt"):
            os.makedirs(os.path.join(self.ab, d, "sub"))
            with open(os.path.join(self.ab, d, "sub", "secret.txt"), "w") as fh:
                fh.write("oracle\n")

    def tearDown(self):
        for d in ("vault", "wt", "vault-old"):
            p = os.path.join(self.ab, d)
            if os.path.exists(p):
                os.chmod(p, 0o755)
        shutil.rmtree(self.ab)

    def iso(self):
        return A.Isolation(self.ab, [os.path.join(self.ab, "vault"), os.path.join(self.ab, "wt"), os.path.join(self.ab, "missing")])

    def test_block_denies_reads_and_unblock_restores(self):
        iso = self.iso()
        iso.block()
        self.assertTrue(os.path.exists(os.path.join(self.ab, ".blocked.json")))
        with self.assertRaises(PermissionError):
            open(os.path.join(self.ab, "vault", "sub", "secret.txt")).read()
        with self.assertRaises(PermissionError):
            os.listdir(os.path.join(self.ab, "wt"))
        self.assertEqual(iso.check(), [])
        iso.unblock()
        self.assertFalse(os.path.exists(os.path.join(self.ab, ".blocked.json")))
        with open(os.path.join(self.ab, "vault", "sub", "secret.txt")) as fh:
            self.assertEqual(fh.read(), "oracle\n")
        self.assertEqual(oct(os.stat(os.path.join(self.ab, "vault")).st_mode & 0o777), "0o755")

    def test_tamper_is_detected(self):
        iso = self.iso()
        iso.block()
        v = os.path.join(self.ab, "vault")
        time.sleep(0.01)
        os.chmod(v, 0o755)
        open(os.path.join(v, "sub", "secret.txt")).read()
        os.chmod(v, 0)                                      # put back: mode 000 again, but the ctime moved
        os.rename(os.path.join(self.ab, "wt"), os.path.join(self.ab, "vault-old"))
        os.makedirs(os.path.join(self.ab, "wt"))
        os.chmod(os.path.join(self.ab, "wt"), 0)
        breaches = iso.check()
        self.assertEqual(len(breaches), 2, breaches)
        self.assertTrue(any("metadata changed" in b for b in breaches))
        self.assertTrue(any("replaced" in b for b in breaches))
        iso.unblock()

    def test_a_stale_block_refuses_to_start(self):
        iso = self.iso()
        iso.block()
        with self.assertRaises(SystemExit):
            self.iso().block()
        self.assertEqual(A.unblock_from_state(self.ab), 0)  # what `run_ab.py unblock` does after a crash
        self.assertEqual(oct(os.stat(os.path.join(self.ab, "wt")).st_mode & 0o777), "0o755")


class Quarantine(unittest.TestCase):
    def test_only_the_cells_own_new_entries_move(self):
        base = os.path.realpath(tempfile.mkdtemp(prefix="ab-q-test-"))
        ab, other = os.path.join(base, "ab"), os.path.join(base, "tmpish")
        for d in (ab, other):
            os.makedirs(d)
        before = {ab: A.top_entries(ab), other: A.top_entries(other)}
        for p in (os.path.join(ab, "notes.txt"), os.path.join(ab, "progress.txt"), os.path.join(other, "probe_out.txt"), os.path.join(other, "unrelated")):
            open(p, "w").close()
        dest = os.path.join(base, "q")
        moved = A.quarantine_new_entries({"ab_root": ab}, before, "cat > ../../tmpish/probe_out.txt", dest)
        self.assertEqual(sorted(os.path.basename(m) for m in moved), ["notes.txt"])  # ../probe_out.txt is ../../tmpish/, not "../" + name
        moved = A.quarantine_new_entries({"ab_root": ab}, before, "python3 x.py > " + os.path.join(other, "probe_out.txt"), dest)
        self.assertEqual([os.path.basename(m) for m in moved], ["probe_out.txt"])
        self.assertTrue(os.path.exists(os.path.join(other, "unrelated")))
        self.assertTrue(os.path.exists(os.path.join(ab, "progress.txt")))
        shutil.rmtree(base)


class Structure(unittest.TestCase):
    FP = {"arms": {"control": {"system_sha": "s", "slice_tools_sha": "t", "prefix_chars": 17787, "tools_count": 16},
                   "F": {"system_sha": "s", "slice_tools_sha": "t", "prefix_chars": 17787, "tools_count": 16}}}

    def row(self, header="short", tool_line="v", prefix=17787):
        return {"validity": {"tools_count": 16, "tool_lists_distinct": 1, "system_distinct": 1, "system_has_host_path": False, "compaction_events": 0,
                             "user_prompts": 1, "turn_ends": 1, "goal_messages": 0, "system_sha": "s", "slice_tools_sha": "t"},
                "prefix": {"prefix_chars": prefix}, "tape": {"header_forms": {header: 1}, "header_lengths": [76], "tool_line_forms": {tool_line: 2}},
                "in_turn": [], "delivery": []}

    def test_f_structure_from_the_gates_file(self):
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "gates-f.json")) as fh:
            ctx = {"fingerprints": self.FP, "structure": json.load(fh)["structure"]}
        turns = [{"turn": 1, "infra": False, "exit": 0, "turn_end": {"kind": "completed"}, "isolation": {"breaches": [], "strays_killed": 0}}]
        meta = {"turns": 1}
        self.assertEqual(A.validity(ctx, "F", meta, turns, self.row()), [])
        self.assertEqual(A.validity(ctx, "control", meta, turns, self.row(tool_line="long")), [])
        self.assertEqual(A.validity(ctx, "F", meta, turns, self.row(tool_line="long")), ["tool line forms {'long': 2}, expected only v"])
        r = A.validity(ctx, "F", meta, turns, self.row(prefix=17700))
        self.assertTrue(any(x.startswith("structural: request prefix differs from control") for x in r), r)
        turns[0]["isolation"]["breaches"] = ["/ab/vault: metadata changed while blocked"]
        self.assertEqual(A.validity(ctx, "F", meta, turns, self.row()), ["isolation breached in turn 1: /ab/vault: metadata changed while blocked"])

    def test_arm_order_alternates_over_batch_and_arbitration(self):
        firsts = [A.arm_order(["control", "F"], rep, seed)[0] for seed in (20261022, 20261023) for rep in (1, 2, 3)]
        self.assertEqual(firsts, ["control", "F", "control", "F", "control", "F"])

    def test_stdout_from_an_open_file(self):
        path = stdout_file([{"type": "session", "sessionId": "s9"}, {"type": "status", "phase": "step_start", "turn": 1, "step": 1}])
        with open(path) as fh:
            self.assertEqual((A.usage_from_stdout(fh)["sid"], A.usage_from_stdout(fh)["open_steps"]), ("s9", 1))  # re-read from the start
        os.remove(path)


if __name__ == "__main__":
    unittest.main(verbosity=2)
