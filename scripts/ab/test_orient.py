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
