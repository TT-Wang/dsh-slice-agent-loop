#!/usr/bin/env python3
"""Unit tests for ab_metrics.py.

    python3 scripts/ab/test_ab_metrics.py            # synthetic events only
    AB_OFFLINE_BATCH=<AB>/results/offline \\
    AB_RAFT_LOGS=<raft-1.jsonl>:<raft-2.jsonl> \\
    python3 scripts/ab/test_ab_metrics.py            # plus the mock and real-log checks

The real-log expectations are the numbers in the P1-10 record (two Raft slicey-dsh V4
sessions from 2026-09-25, rendered by the ba12a5b plugin): 360/408 requests, 73/95 turns,
72/94 tape entries, recall_search 8 / recall_turn 1 / recall_step 1 in raft-1, and 14
expand_result calls in raft-2 (all {seq, formatVersion 4}, all successful, 4 of them
cross-turn from a tape tool line).
"""
import glob
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ab_metrics as M  # noqa: E402

CWD = "/w"


class Log:
    """Builds a minimal V4-shaped event list."""

    def __init__(self):
        self.ev = [{"type": "session", "version": 4, "id": "s", "cwd": CWD}]
        self.seq = 0
        self.n = 0

    def add(self, type_, data, **extra):
        self.seq += 1
        e = {"type": type_, "seq": self.seq, "data": data}
        e.update(extra)
        self.ev.append(e)
        return self.seq

    def assistant(self, turn, step, text="", tools=(), usage=(10, 100, 5)):
        content = ([{"type": "text", "text": text}] if text else []) + [{"type": "tool-call", "id": cid, "name": n, "arguments": "{}"} for cid, n in tools]
        return self.add("assistant/message", {"turn": turn, "step": step, "message": {"role": "assistant", "content": content},
                                              "usage": {"inputTokens": usage[0], "cacheReadTokens": usage[1], "outputTokens": usage[2], "totalTokens": sum(usage)}}, surfaceOp="append")

    def call(self, turn, step, name, args, result="ok", error=False):
        self.n += 1
        cid = f"c{self.n}"
        self.assistant(turn, step, tools=[(cid, name)])
        self.add("tool/call", {"turn": turn, "step": step, "callId": cid, "name": name, "arguments": json.dumps(args)})
        rseq = self.add("tool/result", {"turn": turn, "step": step, "message": {"role": "tool", "toolCallId": cid, "isError": error, "content": [{"type": "text", "text": result}]}}, surfaceOp="append")
        return rseq

    def fold(self, turn, step, source_seq, header):
        return self.add("tool/result", {"turn": turn, "step": step, "message": {"role": "tool", "content": [{"type": "text", "text": header + "\n…[+10 lines / 900 chars]…"}]}},
                        surfaceOp={"op": "replace", "startSeq": source_seq, "endSeq": source_seq}, sourceEventSeqs=[source_seq])

    def tape(self, text):
        return self.add("user/message", {"content": [{"type": "text", "text": text}], "source": {"kind": "plugin:slice:history"}, "role": "user"}, surfaceOp={"op": "replace", "startSeq": 1, "endSeq": 2})

    def end(self, turn, kind="completed"):
        return self.add("turn/end", {"turn": turn, "reason": {"kind": kind}})


class Reads(unittest.TestCase):
    def test_same_turn_unchanged_after_edit_cross_turn_and_fold(self):
        g = Log()
        first = g.call(1, 1, "read", {"file_path": "a.py"})
        g.fold(1, 2, first, "[read · data · 400 lines, 14 kept · expand_result({\"seq\": %d, \"formatVersion\": 4}) returns the full text]" % first)
        g.call(1, 2, "read", {"file_path": "/w/a.py", "offset": 10, "limit": 5})     # overlaps, after its fold: unchanged + fold_then_reread
        g.call(1, 3, "read", {"file_path": "b.py", "offset": 1, "limit": 10})
        g.call(1, 3, "read", {"file_path": "b.py", "offset": 11, "limit": 10})       # no overlap: not a re-read
        g.call(1, 4, "edit", {"file_path": "a.py", "old_string": "x", "new_string": "y"})
        g.call(1, 5, "bash", {"command": "cat a.py"})                                   # first read after the edit
        g.call(1, 6, "bash", {"command": "echo z > b.py"})
        g.call(1, 7, "bash", {"command": "cd /w && sed -n '1,5p' b.py"})               # after the redirect write
        g.assistant(1, 8, text="done")
        g.end(1)
        g.call(2, 1, "read", {"file_path": "a.py"})                                    # cross-turn
        g.assistant(2, 2, text="ok")
        g.end(2)
        r = M.metrics(g.ev, prices=M.load_prices())["reads"]
        self.assertEqual(r["reads"], 7)
        self.assertEqual(r["bash_reads"], 2)
        self.assertEqual(r["reread_same_turn_unchanged"], 1)
        self.assertEqual(r["fold_then_reread"], 1)
        self.assertEqual(r["reread_same_turn_after_edit"], 2)
        self.assertEqual(r["reread_cross_turn"], 1)
        self.assertEqual(r["folds"], 1)

    def test_directory_removal_clears_reads_below_it(self):
        g = Log()
        g.call(1, 1, "read", {"file_path": "docs/x.txt"})
        g.call(1, 2, "bash", {"command": "rm -rf docs"})
        g.call(1, 3, "read", {"file_path": "docs/x.txt"})
        r = M.metrics(g.ev, prices=M.load_prices())["reads"]
        self.assertEqual(r["reread_same_turn_unchanged"], 0)


class ReadRanges(unittest.TestCase):
    def count(self, *cmds):
        g = Log()
        for i, c in enumerate(cmds, 1):
            name, args = c if isinstance(c, tuple) else ("bash", {"command": c})
            g.call(1, i, name, args)
        g.end(1)
        return M.metrics(g.ev, prices=M.load_prices())["reads"]["reread_same_turn_unchanged"]

    def test_line_ranges(self):
        self.assertEqual(self.count("sed -n '1,10p' f.py", "sed -n '50,60p' f.py"), 0)   # disjoint pages
        self.assertEqual(self.count("sed -n '1,10p' f.py", "sed -n '5,20p' f.py"), 1)
        self.assertEqual(self.count("head -20 f.py", "tail -20 f.py"), 0)                 # tail: unknown position
        self.assertEqual(self.count("tail -20 f.py", "tail -20 f.py"), 0)
        self.assertEqual(self.count("head -n 50 f.py", "tail -n +100 f.py"), 0)          # 1-50 vs 100-end
        self.assertEqual(self.count("head -n 50 f.py", "tail -n +40 f.py"), 1)
        self.assertEqual(self.count("cat f.py | head -20", "sed -n '10,30p' f.py"), 1)
        self.assertEqual(self.count("cat -n f.py", "sed -n '/def /p' f.py"), 0)          # a regex print is a range of unknown position
        self.assertEqual(self.count(("read", {"file_path": "f.py", "offset": 1, "limit": 40}), "sed -n '30,60p' f.py"), 1)

    def test_bash_workdir_parameter(self):
        self.assertEqual(self.count(("read", {"file_path": "sub/x.py"}), ("bash", {"command": "cat x.py", "workdir": "sub"})), 1)
        self.assertEqual(self.count(("read", {"file_path": "x.py"}), ("bash", {"command": "cat x.py", "workdir": "sub"})), 0)
        self.assertEqual(self.count(("read", {"file_path": "sub/x.py"}), ("bash", {"command": "cat x.py", "workdir": "/w/sub"})), 1)


class Flags(unittest.TestCase):
    W = "/private/tmp/c/impl/p110ab/results/p110-20260927/work/w-abc123"

    def flags(self, name, args):
        call = {"seq": 1, "turn": 1, "step": 1, "name": name, "args": args, "raw": json.dumps(args)}
        return M.access_flags({"c": call}, ["c"], self.W)

    def test_inside_the_workdir_is_not_flagged(self):
        for name, args in [
            ("read", {"file_path": self.W + "/docs/runbook.txt"}),                       # the old '/p110ab/' false positive
            ("read", {"file_path": "/tmp/c/impl/p110ab/results/p110-20260927/work/w-abc123/docs/runbook.txt"}),
            ("bash", {"command": "cd %s && python3 tools/probe.py --region us" % self.W}),
            ("bash", {"command": "python3 -m pytest -v 2>&1 | tail -20"}),
            ("bash", {"command": "sed -n '/night/p' docs/runbook.txt"}),
            ("bash", {"command": "python3 -c \"print(1 / 3)\""}),
            ("bash", {"command": "mkdir -p answers && echo 64471 > answers/ext.txt 2>/dev/null"}),
            ("bash", {"command": "cat x.py", "workdir": "sub"}),
            ("bash", {"command": "ls -la /usr/bin/python3 && /usr/bin/env python3 -V"}),
            ("bash", {"command": "python3 -c \"import os; print(os.environ.get('X'))\""}),
            ("glob", {"pattern": "**/*.py"}),
            ("grep", {"pattern": "def ", "path": "textkit"}),
        ]:
            with self.subTest(args=args):
                self.assertEqual(self.flags(name, args), [])

    def test_outside_home_sensitive_and_secret(self):
        cases = [
            ("bash", {"command": "find / -name runbook.txt"}, "outside"),
            ("bash", {"command": "grep -i backup ../../../../selfcheck/r3-untouched/docs/runbook.txt"}, "outside"),
            ("bash", {"command": "cd .. && ls"}, "outside"),
            ("bash", {"command": "cat x.py", "workdir": "/tmp"}, "workdir outside"),
            ("bash", {"command": "python3 tools/probe.py > /tmp/out.txt"}, "outside"),
            ("bash", {"command": "ls ~"}, "home"),
            ("bash", {"command": "mdfind -name probe.py"}, "sensitive"),
            ("grep", {"pattern": "Brackenfold", "path": ".."}, "outside"),
            ("glob", {"pattern": "/**/probe.py"}, "outside"),
            ("read", {"file_path": "../w-other/tools/probe.py"}, "outside"),
            ("bash", {"command": "cat ../w-abc123.truth.json"}, "sensitive"),
            ("bash", {"command": "cat $DSH_HOME/.env"}, "secret"),
            ("read", {"file_path": "/Users/u/.dsh/.env"}, "secret"),
        ]
        for name, args, why in cases:
            with self.subTest(args=args):
                f = self.flags(name, args)
                self.assertEqual(len(f), 1)
                self.assertTrue(any(why in r for r in f[0]["reasons"]), f[0]["reasons"])
        self.assertTrue(self.flags("bash", {"command": "cat $DSH_HOME/.env"})[0]["secret"])
        self.assertFalse(self.flags("bash", {"command": "find / -name x"})[0]["secret"])


class Recall(unittest.TestCase):
    def build(self, tool_line):
        g = Log()
        res1 = g.call(1, 1, "bash", {"command": "python3 tools/probe.py"}, result="PRB-us-1234abcd\nshipping 1 2")
        g.assistant(1, 2, text="PROBE-US-OK")
        g.end(1)
        g.tape("[slice tape v1 · turns 1-1 · 1 turn(s) sealed · recall_turn / expand_result]\n[turn 1]\n" + tool_line % {"s": res1})
        g.call(2, 1, "expand_result", {"seq": res1, "formatVersion": 3}, result="Error: expand_result: numeric seq requires formatVersion 4 from a fresh locator", error=True)
        g.call(2, 2, "expand_result", {"seq": res1, "formatVersion": 4}, result="PRB-us-1234abcd\nshipping 1 2")
        g.call(2, 3, "recall_turn", {"turn": "1"}, result="[sealed turn 1]\n[tool turn 1 step 1 seq %d · bash · 30 chars]" % res1)
        g.call(2, 4, "expand_result", {"seq": res1, "formatVersion": 4, "grep": "shipping"}, result="shipping 1 2")
        g.call(2, 5, "expand_result", {"seq": 999, "formatVersion": 4}, result="Error: no such seq", error=True)
        g.call(2, 6, "recall_turn", {"turn": "1", "view": "full"}, result="x" * 50)
        g.assistant(2, 7, text="answer written")
        g.end(2)
        g.call(3, 1, "bash", {"command": "ls"})
        g.end(3, kind="blocked")
        return M.metrics(g.ev, exams=[(2, ["PRB-us-1234abcd"])], prices=M.load_prices())

    def test_locators_rejections_and_hops_with_the_v4_tool_line(self):
        m = self.build("[tool turn 1 step 1 seq %(s)d · bash · 30 chars · v4]")
        rc = m["recall"]
        self.assertEqual(rc["fv_rejections"], 1)
        self.assertEqual(rc["fv_rejections_recovered"], 1)
        self.assertEqual(rc["fv_rejections_by_version"], {"3": 1})
        self.assertEqual(rc["expand_shapes"], {"seq+fv_other": 1, "seq+fv4": 3})
        self.assertEqual(rc["expand_partial"], {"grep": 1, "lines": 0, "full": 3})
        # tape, tape, recall_output (recall_turn listed seq S after the tape already had it: an extra hop), none
        self.assertEqual(rc["expand_locator_source"], {"recall_output": 1, "fold_view": 0, "tape": 2, "none": 1})
        self.assertEqual(rc["extra_hops"], 1)
        self.assertEqual(rc["expand_cross_turn"], {"calls": 3, "targets": 1, "first_try_ok": 0})
        self.assertEqual(rc["tools"]["expand_result"], {"calls": 4, "errors": 2, "recovered": 1})
        self.assertEqual(rc["recall_turn_views"]["full"], 1)
        self.assertEqual(rc["recall_turn_views"]["full_chars"], 50)
        self.assertEqual(m["tape"]["tool_line_forms"], {"v": 1})
        self.assertEqual(m["tape"]["header_forms"], {"short": 1})
        self.assertEqual(m["tape"]["header_lengths"], [76])
        ex = m["exams"][0]
        self.assertTrue(ex["recall_sourced"])
        self.assertEqual(ex["recall_tool"], "expand_result")
        self.assertEqual(ex["leak_assistant_turns"], [])
        self.assertEqual(m["finish"]["step_limit_cut"], 1)
        self.assertEqual(m["finish"]["closeout"], 2)

    def test_long_tool_line_is_the_same_locator(self):
        m = self.build('[tool turn 1 step 1 seq %(s)d · bash · 30 chars · expand_result({"seq":%(s)d,"formatVersion":4})]')
        self.assertEqual(m["recall"]["expand_locator_source"]["tape"], 2)
        self.assertEqual(m["tape"]["tool_line_forms"], {"long": 1})

    def test_leaks_and_flags(self):
        g = Log()
        g.call(1, 1, "bash", {"command": "python3 tools/check_fixtures.py | tee out.txt"}, result="bundle fingerprint: FX-8b69ed6e")
        g.assistant(1, 2, text="It printed FX-8b69ed6e.")
        g.end(1)
        g.call(2, 1, "bash", {"command": "echo 8b69ed6e > keep.txt"})
        g.call(2, 2, "bash", {"command": "zstd -dc ~/.dsh/sessions/x/session.v4.jsonl.zstd | grep FX"})
        g.end(2)
        m = M.metrics(g.ev, exams=[(3, ["8b69ed6e"])], prices=M.load_prices())
        self.assertEqual(m["exams"][0]["leak_assistant_turns"], [1])
        self.assertEqual(m["exams"][0]["leak_write_turns"], [2])
        self.assertEqual(len(m["flagged_access"]), 1)
        self.assertNotIn("tokens", m["exams"][0])  # oracle tokens never land in cells/*.json

    def test_tool_inputs_leak_only_when_they_write_the_answer(self):
        g = Log()
        # R5 shape: running one failing test by name is not a leak (tool inputs never reach the tape) ...
        g.call(1, 1, "bash", {"command": "python3 -m pytest tests/test_tokens.py::test_tokens_f3_0 -q"}, result="1 failed")
        g.call(1, 2, "edit", {"file_path": "textkit/tokens.py", "old_string": "n + 1", "new_string": "n"})
        g.assistant(1, 3, text="DONE: 400 passed")
        g.end(1)
        spec = {"turn": 2, "tokens": ["test_tokens_f3_0"], "leak": {"regex": ["(?<![A-Za-z0-9])tokens_f3(?!\\d)"]}}
        m = M.metrics(g.ev, exams=[spec], prices=M.load_prices())
        self.assertEqual((m["exams"][0]["leak_assistant_turns"], m["exams"][0]["leak_write_turns"]), ([], []))
        # ... but naming the fixed function in assistant text is (the tape keeps it verbatim), and so is writing it to a file
        g2 = Log()
        g2.call(1, 1, "bash", {"command": "echo test_tokens_f3_0 >> notes.txt"})
        g2.assistant(1, 2, text="Fixed tokens_f3; 400 passed.")
        g2.assistant(1, 3, text="tokens_f30 is fine")
        g2.end(1)
        m2 = M.metrics(g2.ev, exams=[spec], prices=M.load_prices())
        self.assertEqual((m2["exams"][0]["leak_assistant_turns"], m2["exams"][0]["leak_write_turns"]), ([1], [1]))

    def test_oracle_via_the_file_system(self):
        W = "/private/tmp/x/p110ab/results/b/work/w-abc123"

        def build(first):
            g = Log()
            g.ev[0]["cwd"] = W
            g.call(1, 1, "read", {"file_path": "docs/runbook.txt"}, result="... backup datacenter is Brackenfold ...")
            g.end(1)
            first(g)
            g.call(2, 9, "bash", {"command": "cat answers/dr.txt"}, result="Brackenfold")
            g.end(2)
            return M.metrics(g.ev, exams=[(2, ["Brackenfold"])], prices=M.load_prices())

        # a relative escape into another copy of the task: flagged by path and by content
        m = build(lambda g: g.call(2, 1, "bash", {"command": "grep -i backup ../../../../selfcheck/r3-untouched/docs/runbook.txt"}, result="the backup datacenter is Brackenfold"))
        self.assertTrue(m["exams"][0]["oracle_via_fs"])
        self.assertEqual(m["exams"][0]["oracle_via_fs_call"]["tool"], "bash")
        self.assertTrue(any("outside" in r for f in m["flagged_access"] for r in f["reasons"]))
        # the grep tool on '..' (no path in any command string): content still catches it
        m = build(lambda g: g.call(2, 1, "grep", {"pattern": "backup", "path": ".."}, result="w-9/docs/runbook.txt:300: Brackenfold"))
        self.assertTrue(m["exams"][0]["oracle_via_fs"])
        # recall first, then the model's own answer file read back: not via the file system, not flagged
        def recalled(g):
            g.call(2, 1, "expand_result", {"seq": 3, "formatVersion": 4, "grep": "backup"}, result="the backup datacenter is Brackenfold")
            g.call(2, 2, "write", {"file_path": "answers/dr.txt", "content": "Brackenfold\n"})
        m = build(recalled)
        self.assertFalse(m["exams"][0]["oracle_via_fs"])
        self.assertTrue(m["exams"][0]["recall_sourced"])
        self.assertEqual(m["flagged_access"], [])
        # the model writes the answer (from the tape, say) and then cats it: authored first, not via fs
        m = build(lambda g: g.call(2, 1, "write", {"file_path": "answers/dr.txt", "content": "Brackenfold"}))
        self.assertFalse(m["exams"][0]["oracle_via_fs"])

    def test_delivery(self):
        # the pilot's failure mode: T1 ran the script with its output sent to /dev/null, so nothing reached the model
        g = Log()
        g.call(1, 1, "bash", {"command": "python3 tools/probe.py --region us > /dev/null 2>&1; echo exit=$?"}, result="exit=0")
        g.end(1)
        g.call(2, 1, "bash", {"command": "python3 tools/probe.py --region eu"}, result="probe region=eu\nshipping         43     291\n")
        g.end(2)
        g.call(3, 1, "expand_result", {"seq": 3, "formatVersion": 4}, result="shipping        177     690")  # recall never counts as delivery
        g.end(3)
        m = M.metrics(g.ev, delivery=[(1, ["shipping        177     690"]), (2, ["shipping         43     291"])], prices=M.load_prices())
        self.assertEqual([(d["turn"], d["delivered"], d["tool"]) for d in m["delivery"]], [(1, False, None), (2, True, "bash")])
        self.assertNotIn("shipping", json.dumps(m["delivery"]))  # no oracle token in the row
        self.assertEqual(M.metrics(g.ev, prices=M.load_prices())["delivery"], [])

    def test_attempt_usage_is_billed_but_not_a_request(self):
        g = Log()
        g.add("assistant/attempt", {"turn": 1, "step": 1, "stream": [{"type": "chunk", "chunk": {"type": "usage", "usage": {"inputTokens": 500, "cacheReadTokens": 0, "outputTokens": 3}}}]})
        g.add("assistant/attempt", {"turn": 1, "step": 1, "stream": [{"type": "text-chunks", "texts": ["par"]}]})  # no sample
        g.assistant(1, 1, text="ok", usage=(10, 100, 5))
        g.end(1)
        u = M.metrics(g.ev, prices=M.load_prices())["usage"]
        self.assertEqual((u["requests"], u["attempts_failed"], u["unpriced_records"]), (1, 2, 1))
        self.assertEqual((u["miss"], u["hit"], u["out"]), (510, 100, 8))
        self.assertEqual((u["attempt_miss"], u["attempt_out"]), (500, 3))
        self.assertEqual(M.usage_totals(g.ev, turns={1}), {"miss": 510, "hit": 100, "out": 8, "cache_write": 0, "messages": 1, "attempts": 2, "unpriced": 1})

    def test_prompt_turn_alignment(self):
        g = Log()
        g.add("user/message", {"content": [{"type": "text", "text": "go"}], "source": {"kind": "user"}, "role": "user"})
        g.add("turn/start", {"turn": 1})
        g.assistant(1, 1, text="done")
        g.end(1)
        g.add("user/message", {"content": [{"type": "text", "text": "<goal_round>"}], "source": {"kind": "goal"}, "role": "user"})
        g.add("turn/start", {"turn": 2})
        g.end(2, kind="error")
        v = M.metrics(g.ev, prices=M.load_prices())["validity"]
        self.assertEqual((v["user_prompts"], v["goal_messages"], v["turn_ends"]), (1, 1, 2))

    def test_usage_and_costs(self):
        g = Log()
        g.assistant(1, 1, text="a", usage=(1_000_000, 0, 0))
        g.assistant(1, 2, text="b", usage=(0, 1_000_000, 1_000_000))
        g.end(1)
        u = M.metrics(g.ev, prices=M.load_prices())["usage"]
        self.assertEqual((u["requests"], u["miss"], u["hit"], u["out"], u["turn_first_miss"], u["later_step_miss"]), (2, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 0))
        self.assertAlmostEqual(u["cost_offpeak"], 0.22 + 0.007 + 0.66)
        self.assertAlmostEqual(u["cost_peak"], 0.44 + 0.014 + 1.32)


@unittest.skipUnless(os.environ.get("AB_OFFLINE_BATCH"), "set AB_OFFLINE_BATCH=<AB>/results/offline")
class MockLogs(unittest.TestCase):
    """The offline dry run: every log is readable and agrees with the --json stdout of its turns."""

    def test_offline_cells(self):
        batch = os.environ["AB_OFFLINE_BATCH"]
        cells = []
        for path in sorted(glob.glob(os.path.join(batch, "cells", "*.json"))):
            with open(path, encoding="utf-8") as fh:
                cells.append(json.load(fh))
        self.assertGreater(len(cells), 0)
        forms = {"control": ("long", "long"), "arm1": ("short", "long"), "arm2": ("short", "v")}
        for c in cells:
            with self.subTest(cell=c["cell"]):
                events, bad = M.load_events(c["log"])
                m = M.metrics(events, prices=M.load_prices(), bad_lines=bad)
                self.assertEqual(bad, 0)
                self.assertEqual(m["validity"]["tools_count"], 16)
                self.assertFalse(m["validity"]["system_has_host_path"])
                self.assertEqual(m["finish"]["turns"], len(c["turns"]))
                self.assertEqual((m["validity"]["user_prompts"], m["validity"]["turn_ends"], m["validity"]["goal_messages"]), (len(c["turns"]), len(c["turns"]), 0))
                # the scripted mock only touches its own workdir and never restates an oracle
                self.assertEqual(m["flagged_access"], [])
                self.assertFalse(c.get("g2_excluded"))
                # the cell's workdir and truth sidecar were packed away at the end of the cell
                self.assertFalse(os.path.exists(c["workdir"]) or os.path.exists(c["workdir"] + ".truth.json"))
                # the log's assistant messages are exactly the step_end events of the turns' stdout
                self.assertEqual(m["usage"]["requests"], sum(t["steps"] for t in c["turns"]))
                self.assertEqual(m["usage"]["miss"], sum(t["usage"]["inputTokens"] for t in c["turns"]))
                self.assertEqual(m["usage"]["hit"], sum(t["usage"]["cacheReadTokens"] for t in c["turns"]))
                if m["tape"]["entries"]:
                    self.assertEqual(set(m["tape"]["header_forms"]), {forms[c["arm"]][0]})
                if m["tape"]["tool_lines"]:
                    self.assertEqual(set(m["tape"]["tool_line_forms"]), {forms[c["arm"]][1]})
                # the mock only ever expands the newest tape tool line, with the right version
                self.assertEqual(m["recall"]["fv_rejections"], 0)
                self.assertEqual(m["recall"]["expand_locator_source"]["none"], 0)


@unittest.skipUnless(os.environ.get("AB_RAFT_LOGS"), "set AB_RAFT_LOGS=<raft-1.jsonl>:<raft-2.jsonl>")
class RealLogs(unittest.TestCase):
    def load(self, i):
        path = os.environ["AB_RAFT_LOGS"].split(":")[i]
        events, bad = M.load_events(path)
        return events, M.metrics(events, prices=M.load_prices(), bad_lines=bad)

    def test_usage_fields_add_up(self):
        for i in (0, 1):
            events, m = self.load(i)
            total = sum((e["data"].get("usage") or {}).get("totalTokens", 0) for e in events if e["type"] == "assistant/message")
            self.assertEqual(m["usage"]["miss"] + m["usage"]["hit"] + m["usage"]["out"] + m["usage"]["cache_write"], total)

    def test_raft_1(self):
        _, m = self.load(0)
        self.assertEqual((m["usage"]["requests"], m["finish"]["turns"], m["tape"]["entries"]), (360, 73, 72))
        self.assertEqual({k: v["calls"] for k, v in m["recall"]["tools"].items()}, {"recall_turn": 1, "recall_search": 8, "recall_step": 1, "expand_result": 0})
        self.assertEqual(m["usage"]["hit"], 16_526_208)
        self.assertEqual(m["tape"]["header_forms"], {"long": 72})
        self.assertEqual(m["tape"]["header_lengths"], [188, 190])
        self.assertAlmostEqual(m["tape"]["tool_lines"] / m["tape"]["entries"], 5.31, places=2)
        self.assertEqual(m["recall"]["errors"], 0)

    def test_raft_2(self):
        _, m = self.load(1)
        self.assertEqual((m["usage"]["requests"], m["finish"]["turns"], m["tape"]["entries"]), (408, 95, 94))
        self.assertEqual(m["recall"]["tools"]["expand_result"], {"calls": 14, "errors": 0, "recovered": 0})
        self.assertEqual(m["recall"]["expand_shapes"], {"seq+fv4": 14})
        self.assertEqual(m["recall"]["fv_rejections"], 0)
        self.assertEqual(m["recall"]["expand_locator_source"], {"recall_output": 0, "fold_view": 10, "tape": 4, "none": 0})
        self.assertEqual(m["recall"]["expand_cross_turn"], {"calls": 4, "targets": 4, "first_try_ok": 4})
        self.assertEqual(m["usage"]["hit"], 13_126_656)
        self.assertAlmostEqual(m["tape"]["tool_lines"] / m["tape"]["entries"], 2.94, places=2)
        self.assertEqual(m["reads"]["folds"], 22)


if __name__ == "__main__":
    unittest.main(verbosity=2)
