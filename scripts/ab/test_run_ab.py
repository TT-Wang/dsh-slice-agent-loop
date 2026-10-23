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


class AccountStop(unittest.TestCase):
    """An account-level provider error (QUOTA: DeepSeek's 402 Insufficient Balance) stops the run instead of retrying."""

    def test_account_error_picks_account_codes_only(self):
        turns = [{"turn": 1, "infra": False, "error_code": None}, {"turn": 2, "infra": True, "error_code": "RATE_LIMIT"},
                 {"turn": 3, "infra": True, "error_code": "QUOTA"}]
        self.assertEqual(A.account_error(turns)["turn"], 3)
        self.assertIsNone(A.account_error(turns[:2]))
        self.assertIsNone(A.account_error([{"turn": 1, "infra": False, "error_code": "QUOTA"}]))  # not infra: not an account stop

    def _run(self, index_rows, results, resume):
        d = tempfile.mkdtemp(prefix="ab-acct-test-")
        os.makedirs(os.path.join(d, "cells"))
        index = os.path.join(d, "index.jsonl")
        with open(index, "w") as fh:
            for r in index_rows:
                fh.write(json.dumps(r) + "\n")
        seen = []

        def fake_run_cell(ctx, task, rep, arm, attempt):
            seen.append(attempt)
            return {"cell": A.cell_id(task, rep, arm), "status": results.pop(0), "valid": False}
        orig = A.run_cell
        A.run_cell = fake_run_cell
        try:
            ctx = {"batch_dir": d, "index": index, "resume": resume, "max_attempts": 2,
                   "budget": A.Budget(os.path.join(d, "spend.jsonl"), 10, 0.1, 0.1, PEAK)}
            A.run_cell_with_retries(ctx, "t", 1, "arm1")
            files = sorted(os.listdir(os.path.join(d, "cells")))
        finally:
            A.run_cell = orig
            shutil.rmtree(d)
        return seen, ctx, files

    def test_account_stop_is_not_retried_and_stops_the_run(self):
        seen, ctx, files = self._run([], ["account_stop", "done"], resume=False)
        self.assertEqual(seen, [1])                                   # no second attempt against a refusing account
        self.assertTrue(ctx.get("account_stopped"))
        self.assertEqual(files, ["t.r1.arm1.account_stop.json"])      # not cells/<cell>.json: --resume reruns it

    def test_resume_reruns_without_using_up_attempts(self):
        rows = [{"cell": "t.r1.arm1", "attempt": 1, "status": "account_stop"}]
        seen, ctx, files = self._run(rows, ["invalid", "done"], resume=True)
        self.assertEqual(seen, [2, 3])                                # both attempts still available after the stop
        self.assertFalse(ctx.get("account_stopped"))
        self.assertIn("t.r1.arm1.json", files)


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

    def test_read_only_dirs_refuse_new_entries(self):
        live = os.path.join(self.ab, "live")
        os.makedirs(os.path.join(live, "c-0123456789"))
        iso = A.Isolation(self.ab, [os.path.join(self.ab, "vault")], [self.ab, live])
        iso.block()
        with self.assertRaises(PermissionError):
            open(os.path.join(self.ab, "note.txt"), "w").close()          # nothing can be left next to the cells for a later one
        with self.assertRaises(PermissionError):
            open(os.path.join(live, "note.txt"), "w").close()
        open(os.path.join(live, "c-0123456789", "own.txt"), "w").close()   # the cell's own root stays writable
        self.assertEqual(iso.check(), [])
        time.sleep(0.01)
        os.chmod(live, 0o755)                                               # a cell making live/ writable again
        breaches = iso.check()
        self.assertEqual(len(breaches), 1, breaches)
        self.assertIn("while read-only", breaches[0])
        iso.unblock()
        open(os.path.join(self.ab, "note.txt"), "w").close()
        self.assertEqual(oct(os.stat(live).st_mode & 0o777), "0o755")
        self.assertFalse(os.path.exists(os.path.join(self.ab, ".blocked.json")))

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
        moved = A.quarantine_new_entries({"ab_root": ab}, before, "cat > ../../tmpish/probe_note.txt", dest)
        self.assertEqual(sorted(os.path.basename(m) for m in moved), ["notes.txt"])  # another name: not demonstrably the cell's
        moved = A.quarantine_new_entries({"ab_root": ab}, before, "python3 x.py > " + os.path.join(other, "probe_out.txt"), dest)
        self.assertEqual([os.path.basename(m) for m in moved], ["probe_out.txt"])
        self.assertTrue(os.path.exists(os.path.join(other, "unrelated")))
        self.assertTrue(os.path.exists(os.path.join(ab, "progress.txt")))
        shutil.rmtree(base)

    def test_a_bare_name_after_cd_counts(self):
        calls = "cd /tmp && mkdir -p probeq1a2b3c && echo x > probeq1a2b3c/a.txt"
        self.assertTrue(A.named_in(calls, "/private/tmp", "probeq1a2b3c"))
        self.assertFalse(A.named_in(calls, "/private/tmp", "probeq"))      # a prefix of a word is not the name
        self.assertFalse(A.named_in("ls build", "/private/tmp", "build"))  # short bare words are too common to claim
        self.assertTrue(A.named_in("cat /tmp/build", "/private/tmp", "build"))


class StrayMarker(unittest.TestCase):
    def test_marker_names_the_cell_in_both_tmp_spellings(self):
        m = A.cell_marker("/private/tmp/x/fab/live/c-0123456789/")
        self.assertEqual(m, os.path.join("live", "c-0123456789"))
        self.assertIn(m, "PWD=/tmp/x/fab/live/c-0123456789/w-abcdefabcd")

    def test_a_process_sitting_in_the_cell_is_found(self):
        import subprocess
        d = os.path.realpath(tempfile.mkdtemp(prefix="ab-stray-test-"))
        cell = os.path.join(d, "live", "c-9876543210")
        os.makedirs(cell)
        env = {k: v for k, v in os.environ.items() if k not in ("PWD", "OLDPWD")}
        p = subprocess.Popen(["sleep", "30"], cwd=cell, env=env, start_new_session=True)   # no marker in argv or environment
        try:
            time.sleep(0.3)
            self.assertIn(p.pid, A.cell_pids(A.cell_marker(cell)))
            self.assertGreaterEqual(A.kill_strays(A.cell_marker(cell)), 1)
            p.wait(timeout=5)
            self.assertEqual(A.survivors(A.cell_marker(cell)), 0)
        finally:
            if p.poll() is None:
                p.kill()
            shutil.rmtree(d)


class WorktreeState(unittest.TestCase):
    def test_a_file_left_in_a_worktree_changes_the_state(self):
        import subprocess
        ab = os.path.realpath(tempfile.mkdtemp(prefix="ab-wt-test-"))
        repo = os.path.join(ab, "wt", "one")
        os.makedirs(os.path.join(repo, "src"))
        run = lambda *a: subprocess.run(["git", "-C", repo] + list(a), check=True, capture_output=True)  # noqa: E731
        run("init", "-q")
        with open(os.path.join(repo, "src", "a.py"), "w") as fh:
            fh.write("x = 1\n")
        run("add", ".")
        run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
        s0 = A.worktree_state(ab)
        os.makedirs(os.path.join(repo, "src", "__pycache__"))
        open(os.path.join(repo, "src", "__pycache__", "a.cpython-310.pyc"), "w").close()
        self.assertEqual(A.worktree_state(ab), s0)                        # bytecode is not a cell's note
        open(os.path.join(repo, "src", "note.txt"), "w").close()
        self.assertNotEqual(A.worktree_state(ab), s0)
        shutil.rmtree(ab)


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



class SliceVsStock(unittest.TestCase):
    """Per-arm compositions of the slice-vs-stock evaluation (2026-10-23)."""

    DUMP = ("# == @deepseek-ai/dsh-base\n- id: token-meter\n  name: '@deepseek-ai/dsh-token-meter'\n"
            "- id: compaction-basic\n  name: '@deepseek-ai/dsh-compaction-basic'\n"
            "- id: tool-result-pruner\n  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'\n  config:\n    thresholdChars: 8192\n")

    def test_compare_dumps_declared_rows(self):
        slice_dump = self.DUMP + "# == @dsh-external/dsh-slice-agent-loop\n- id: slice-agent-loop\n  name: '@dsh-external/dsh-slice-agent-loop'\n"
        differ, only_a, only_b, unexpected = A.compare_dumps(self.DUMP, slice_dump, ["slice-agent-loop"])
        self.assertEqual((differ, only_a, only_b, unexpected), ([], [], ["slice-agent-loop"], []))
        compact = self.DUMP.replace("dsh-compaction-basic'\n", "dsh-compaction-basic'\n  config:\n    thresholdRatio: 0.057344\n    retainTokens: 19660\n")
        self.assertEqual(A.compare_dumps(self.DUMP, compact, ["compaction-basic"])[3], [])
        self.assertEqual(A.compare_dumps(self.DUMP, compact, [])[3], ["compaction-basic"])         # undeclared difference
        pruner_off = self.DUMP.replace("  config:\n    thresholdChars: 8192\n", "  disabled: true\n")
        self.assertEqual(A.compare_dumps(self.DUMP, pruner_off, ["compaction-basic"])[3], ["tool-result-pruner"])
        # provenance comments alone are not a difference
        self.assertEqual(A.compare_dumps(self.DUMP, self.DUMP.replace("# == @deepseek-ai/dsh-base", "# == patched by x"))[3], [])

    def test_steps_patch_modes(self):
        h = A.steps_patch_text(12, "harness", "/ab/plugins/step-cap.mjs")
        self.assertIn("- insert:", h)
        self.assertIn("id: ab-step-cap", h)
        self.assertIn("name: '/ab/plugins/step-cap.mjs'", h)
        self.assertIn("maxStepsPerTurn: 12", h)
        self.assertNotIn("slice-agent-loop", h)
        s = A.steps_patch_text(14, "slice")
        self.assertIn("- id: slice-agent-loop", s)
        self.assertIn("maxStepsPerTurn: 14", s)

    def test_cell_specs_from_truth(self):
        d = tempfile.mkdtemp()
        try:
            truth = os.path.join(d, "w.truth.json")
            with open(truth, "w") as fh:
                json.dump({"exams": [{"turn": 57, "tokens": ["bx-1"]}], "delivery": [{"turn": 3, "tokens": ["bx-1"]}]}, fh)
            meta = {"exams": [], "delivery": [{"turn": 1, "tokens": ["x"]}], "truth_specs": True}
            sp = A.cell_specs(meta, truth)
            self.assertEqual([e["turn"] for e in sp["exams"]], [57])
            self.assertEqual([e["turn"] for e in sp["delivery"]], [1, 3])
            self.assertEqual(A.cell_specs(dict(meta, truth_specs=False), truth)["exams"], [])
        finally:
            shutil.rmtree(d)

    def test_task_seed_is_per_group_and_salted(self):
        d = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(d, A.VAULT))
            ctx = {"ab_root": d, "batch": "b1"}
            s1 = A.task_seed(ctx, "svs_f1_flood_recall", 1)
            self.assertEqual(s1, A.task_seed(ctx, "svs_f1_flood_recall", 1))     # every arm of the group gets it
            self.assertNotEqual(s1, A.task_seed(ctx, "svs_f1_flood_recall", 2))
            self.assertNotEqual(s1, A.task_seed(dict(ctx, batch="b2"), "svs_f1_flood_recall", 1))
            salt = os.path.join(d, A.VAULT, "task-seed-salt")
            self.assertEqual(oct(os.stat(salt).st_mode & 0o777), "0o600")
            os.remove(salt)
            self.assertNotEqual(s1, A.task_seed(ctx, "svs_f1_flood_recall", 1))  # a new salt, new values
        finally:
            shutil.rmtree(d)

    def row(self, tools, tape_entries=0, compaction=0):
        names = sorted(tools)
        return {"validity": {"tools_count": len(names), "tool_lists_distinct": 1, "system_distinct": 1, "system_has_host_path": False,
                             "compaction_events": compaction, "user_prompts": 1, "turn_ends": 1, "goal_messages": 0, "tool_names": names,
                             "system_sha": "s", "slice_tools_sha": "t"},
                "prefix": {"prefix_chars": 1}, "tape": {"entries": tape_entries, "header_forms": {"short": tape_entries} if tape_entries else {},
                                                        "header_lengths": [76] if tape_entries else [], "tool_line_forms": {}},
                "in_turn": [], "delivery": []}

    def test_validity_per_arm_structure(self):
        gates = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "gates-svs.json")))
        stock_tools = ["bash", "edit", "exit_plan_mode", "glob", "grep", "job_kill", "job_list", "job_output", "read", "read_image", "todo_write", "write"]
        slice_tools = stock_tools + ["expand_result", "recall_search", "recall_step", "recall_turn"]
        fps = {"arms": {"stock": {"tools_count": 12, "tool_names": sorted(stock_tools), "system_sha": "s", "slice_tools_sha": "t", "prefix_chars": 1},
                        "slice": {"tools_count": 16, "tool_names": sorted(slice_tools), "system_sha": "s", "slice_tools_sha": "t", "prefix_chars": 1}}}
        ctx = {"fingerprints": fps, "structure": gates["structure"]}
        turn = {"turn": 1, "exit": 0, "infra": False, "turn_end": {"kind": "completed"}}
        meta = {"turns": 1, "require_fold_of_read_turn": 1}
        self.assertEqual(A.validity(ctx, "stock", meta, [turn], self.row(stock_tools, compaction=3)), [])   # compaction allowed, no fold needed
        self.assertTrue(any("tape entries" in r for r in A.validity(ctx, "stock", meta, [turn], self.row(stock_tools, tape_entries=2))))
        self.assertTrue(any("tools_count" in r for r in A.validity(ctx, "stock", meta, [turn], self.row(slice_tools))))
        rs = A.validity(ctx, "slice", dict(meta, require_fold_of_read_turn=None), [turn], self.row(slice_tools, tape_entries=1))
        self.assertEqual(rs, [])
        bad = slice_tools[:-1] + ["web_fetch"]
        self.assertTrue(any("structural: tools are not stock's" in r for r in A.validity(ctx, "slice", {"turns": 1}, [turn], self.row(bad, tape_entries=1))))
        self.assertTrue(any("fold replacement" in r for r in A.validity(ctx, "slice", meta, [turn], self.row(slice_tools, tape_entries=1))))
        # the P1-10 structure keeps its rules: a compaction event makes the cell invalid
        legacy = {"fingerprints": None, "structure": None}
        self.assertTrue(any("compaction events" in r for r in A.validity(legacy, "control", {"turns": 1}, [turn], self.row(slice_tools, compaction=1))))

if __name__ == "__main__":
    unittest.main(verbosity=2)
