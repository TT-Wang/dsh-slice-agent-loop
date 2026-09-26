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
        self.assertEqual(m["exams"][0]["leak_tool_input_turns"], [2])
        self.assertEqual(len(m["flagged_access"]), 1)

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
                self.assertEqual(m["validity"]["tools_count"], 19)
                self.assertFalse(m["validity"]["system_has_host_path"])
                self.assertEqual(m["finish"]["turns"], len(c["turns"]))
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
