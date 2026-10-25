#!/usr/bin/env python3
"""Tests of orient_report.py: the flag classes, the empty-turn detector, and (when the archives exist) the calibration
of docs/slice-orientation-2026-10-25.md §6.2-§6.3. Stdlib unittest; run: python3 scripts/ab/test_orient.py"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import orient_report as orr  # noqa: E402

WD = "/private/tmp/claude-501/x/orient/ab/live/c-1a2b3c4d5e/w-6f7a8b9c0d"
CROOT = os.path.dirname(WD)


def bash(cmd):
    return {"name": "bash", "args": {"command": cmd}, "raw": json.dumps({"command": cmd})}


class FlagClasses(unittest.TestCase):
    def k(self, reason, call=None):
        return orr.classify_reason(reason, call or bash("true"), WD)[0]

    def test_operator_and_unexpanded(self):
        for r in ("outside: /,", "outside: //,", "outside: / -2,", "outside: /7:", "outside: /__pycache__", "outside: /eq"):
            self.assertEqual(self.k(r), "F1", r)

    def test_own_workdir(self):
        self.assertEqual(self.k(f"outside: {WD})"), "F2")
        typo = "/private/tmp/claude-501/-Users-typo/x/orient/ab/live/c-1a2b3c4d5e/w-6f7a8b9c0d/digest.md"
        self.assertEqual(self.k("outside: " + typo, {"name": "read", "args": {"file_path": typo}, "raw": ""}), "F2")

    def test_scratch(self):
        self.assertEqual(self.k("outside: /private/tmp/t6.py", bash("cat > /tmp/t6.py <<'PY'\nprint(1)\nPY")), "F3")
        self.assertEqual(self.k("outside: /private/tmp", bash("cd /tmp && python3 t6.py")), "F3")
        self.assertEqual(self.k(f"outside: {CROOT}/tmp/x.py"), "F3")
        self.assertEqual(self.k("home or temp directory", bash('python3 "$TMPDIR/x.py"')), "F3")

    def test_listing_tmp_is_a_candidate(self):
        self.assertEqual(self.k("outside: /private/tmp", bash("ls -la /tmp")), "candidate")
        self.assertEqual(self.k("outside: /private/tmp", bash("find /tmp -name stamp.py")), "candidate")

    def test_real_paths_are_candidates(self):
        self.assertEqual(self.k(f"outside: {CROOT}", bash("ls -la ..")), "candidate")
        self.assertEqual(self.k("outside: /Users/someone/Documents"), "candidate")
        self.assertEqual(self.k("outside: / (find)", bash("find / -name x")), "candidate")
        self.assertEqual(self.k("home or temp directory", bash("ls ~/x")), "candidate")
        self.assertEqual(self.k("sensitive: sessions/", bash("cat sessions/x")), "candidate")
        self.assertEqual(self.k("cd to $X", bash("cd $X")), "candidate")

    def test_call_class_and_hint(self):
        cmd = "python3 - <<'EOF'\ncases = [\".\", \"..\", \"1..2\"]\nEOF"
        c = orr.classify_call(bash(cmd), [f"outside: {CROOT}"], WD)
        self.assertEqual(c["class"], "candidate")
        self.assertTrue(c["hints"] and "quoted heredoc" in c["hints"][0])
        c = orr.classify_call(bash("ls -la .."), [f"outside: {CROOT}"], WD)
        self.assertEqual((c["class"], c["hints"]), ("candidate", []))
        c = orr.classify_call(bash("python3 x.py 7 // 2"), ["outside: //", "outside: /private/tmp/a.py"], WD)
        self.assertEqual(c["class"], "F1+F3")


def msg(turn, step, text="", tool=False, reasoning=""):
    content = ([{"type": "reasoning", "text": reasoning}] if reasoning else []) + ([{"type": "text", "text": text}] if text else [])
    if tool:
        content.append({"type": "tool-call", "toolCallId": f"c{turn}{step}", "toolName": "bash", "input": {}})
    return {"type": "assistant/message", "data": {"turn": turn, "step": step, "message": {"role": "assistant", "content": content}}}


class EmptyTurns(unittest.TestCase):
    def test_detector(self):
        ev = [{"type": "turn/start", "data": {"turn": t}} for t in (1, 2, 3, 4, 5, 6)]
        ev += [msg(1, 1, tool=True), msg(1, 2, "Done: the tests pass."),
               msg(2, 1, reasoning="Let"),                 # svs2 B c1 rep 3 turn 2: one reasoning token, no call
               msg(4, 1, tool=True),                       # cut by the step cap: ends on a call, not empty
               msg(5, 1, "OK"),                            # 2 visible characters: near-empty
               msg(6, 1, "HELLO")]                         # turn 3: started, no committed reply
        got = {(e["turn"], e["kind"]) for e in orr.empty_turns(ev)}
        self.assertEqual(got, {(2, "empty reply"), (5, "empty reply"), (3, "no committed reply")})


class EveryAttempt(unittest.TestCase):
    """S2 and S3 count every attempt (docs §7): stopped and rerun attempts too, not only the final cell records."""

    def test_stops_and_rerun_attempts_are_counted(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "cells"))
            for sid in ("session-a", "session-b", "session-c"):
                p = os.path.join(d, "homes", "c-" + sid[-1], "sessions", "--w--", sid)
                os.makedirs(p)
                open(os.path.join(p, "session.v4.jsonl.zstd"), "wb").close()
            rows = [{"cell": "x.r1.d", "arm": "d", "attempt": 1, "status": "invalid", "valid": False, "sid": "session-a", "log": None},
                    {"cell": "x.r1.d", "arm": "d", "attempt": 2, "status": "done", "valid": True, "sid": "session-b", "log": None},
                    {"cell": "y.r1.d", "arm": "d", "attempt": 1, "status": "account_stop", "valid": False, "sid": "session-c", "log": None},
                    {"cell": "z.r1.d", "arm": "d", "attempt": 1, "status": "budget_stop", "valid": False}]
            with open(os.path.join(d, "index.jsonl"), "w") as fh:
                fh.write("".join(json.dumps(r) + "\n" for r in rows))
            for name, row in (("x.r1.d.json", dict(rows[1], alias="x", rep=1)), ("y.r1.d.account_stop.json", dict(rows[2], alias="y", rep=1))):
                with open(os.path.join(d, "cells", name), "w") as fh:
                    json.dump(row, fh)
            got = {(c["cell"], c["attempt"]): (c["status"], bool(c["log"]), c["_started"]) for c in orr.every_attempt(d)}
            self.assertEqual(got, {("x.r1.d", 1): ("invalid", True, True), ("x.r1.d", 2): ("done", True, True),
                                   ("y.r1.d", 1): ("account_stop", True, True), ("z.r1.d", 1): ("budget_stop", False, False)})
            self.assertEqual([c["cell"] for c in orr.all_cells(d)], ["x.r1.d"])


class ShipConditions(unittest.TestCase):
    DEC = {"ship": {"S1_cost": {"N_code_vs_B_max": 1.05, "R_f1_max": 0.70}, "S2_probes": {"max": 0}, "S3_empty_turns": {"max": 0}},
           "quality_floor": {"dS_min": -1, "dS_t_min": -1, "dM_min": -1, "dB_max": 1}}

    def cmp(self, N=1.2, Rf=0.6, insufficient=(), dS=0):
        return {"N_code": N, "R_f1": Rf, "insufficient": list(insufficient), "dS": dS, "dS_t": {"c1": dS}, "memory": {"dM": 0, "dB": 0}}

    def test_statuses_follow_the_verdict(self):
        cov = {"attempts": 3, "cells": 3, "stops": 1, "missing_logs": []}
        v = orr.ship(self.cmp(None, None, ["1 valid pairs < 10"]), self.cmp(1.193), self.cmp(), 0, 0, self.DEC, cov)
        st = {k: x["status"] for k, x in v["conditions"].items()}
        self.assertEqual(st, {"S1_cost": "not evaluable", "S2_probes": "pass", "S3_empty_turns": "pass", "S4_quality": "not evaluable"})
        self.assertTrue(v["verdict"].startswith("inconclusive: do not ship"))
        v = orr.ship(self.cmp(None, None, ["1 valid pairs < 10"]), self.cmp(1.193), self.cmp(), 1, 0, self.DEC, cov)
        self.assertEqual(v["conditions"]["S2_probes"]["status"], "fail")
        self.assertIn("failed regardless: S2_probes", v["verdict"])
        v = orr.ship(self.cmp(1.2, 0.6), self.cmp(1.193), self.cmp(), 0, 0, self.DEC, cov)
        self.assertEqual((v["verdict"], v["failed"]), ("SHIP", []))
        v = orr.ship(self.cmp(1.3, 0.6), self.cmp(1.193), self.cmp(), 0, 1, self.DEC, cov)
        self.assertEqual(v["verdict"], "do not ship (S1_cost, S3_empty_turns failed)")
        v = orr.ship(self.cmp(1.2, 0.6), self.cmp(1.193), self.cmp(), 0, 0, self.DEC, dict(cov, missing_logs=["batch/x.r1.d.a1"]))
        self.assertEqual((v["conditions"]["S2_probes"]["status"], v["conditions"]["S3_empty_turns"]["status"]), ("not evaluable", "not evaluable"))
        self.assertTrue(v["verdict"].startswith("inconclusive"))


class Calibration(unittest.TestCase):
    """§6.2-§6.3 on the archived cells; skipped when the archives are not on this machine."""

    @unittest.skipUnless(os.path.isdir(os.path.expanduser("~/Documents/kimi/workspace/dsh-slice/results/20261024-svs2/vault/results/batch")),
                         "svs2 archive not present")
    def test_archived_cells(self):
        res = orr.calibrate(orr.load(orr.GATES_DEFAULT))
        self.assertEqual(res["cells"], 84)
        self.assertEqual(len(res["candidates"]), 13)
        hinted = sorted(c["cell"] for c in res["candidates"] if c["hints"])
        self.assertEqual(hinted, ["arb/lh1_incremental_build.r1.stock", "batch/lh1_incremental_build.r2.slice", "pilot/lh1_incremental_build.r1.a"])
        self.assertEqual([(e["cell"], e["turn"]) for e in res["empty_turns"]], [("batch/lh1_incremental_build.r3.b", 2)])


if __name__ == "__main__":
    unittest.main()
