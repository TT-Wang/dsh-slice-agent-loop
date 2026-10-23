#!/usr/bin/env python3
"""Unit tests of the svs2 ablation harness (docs/svs2-ablation-2026-10-24.md):  python3 scripts/ab/test_svs2.py

Covers the run_ab.py additions (rotation per task and rep, baseline seed keys and the salt guard, the run-arms and
stand-in guards, top-level worktrees and A/B-root extras, tool-name and system-marker validity, the content digest),
ab_metrics.reread_classes, svs2_report.py (pairing by rep index, side means, the interpretation rule, the arbitration
test, the steps, the import's stored-metric check) and svs2_plan.py (priors, ladder, affordability)."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ab_metrics as M  # noqa: E402
import run_ab as A  # noqa: E402
import svs2_plan as P  # noqa: E402
import svs2_report as R  # noqa: E402

with open(os.path.join(HERE, "gates-svs2.json"), encoding="utf-8") as _fh:
    GATES = json.load(_fh)
SLICE_TOOLS = GATES["structure"]["a"]["tool_names"]


class Rotation(unittest.TestCase):
    def test_every_arm_first_once_per_three_reps_and_across_tasks(self):
        arms = GATES["arms"]
        for alias in GATES["unit"]["tasks"]:
            off = A.rotation_offset(GATES, alias)
            firsts = [A.arm_order(arms, rep, 20261024, off)[0] for rep in (1, 2, 3)]
            self.assertEqual(sorted(firsts), sorted(arms), alias)
        for rep in (1, 2, 3, 4):
            firsts = [A.arm_order(arms, rep, 20261024, A.rotation_offset(GATES, t))[0] for t in ("c1", "c2", "r2")]
            self.assertEqual(sorted(firsts), sorted(arms), rep)

    def test_earlier_gates_keep_the_per_rep_rotation(self):
        with open(os.path.join(HERE, "gates-svs.json"), encoding="utf-8") as fh:
            g = json.load(fh)
        self.assertEqual({A.rotation_offset(g, t) for t in g["unit"]["tasks"]}, {0})
        self.assertEqual(A.arm_order(["stock", "slice"], 1, 20261023), ["slice", "stock"])


class SeedKeys(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.d, A.VAULT))
        with open(os.path.join(self.d, A.VAULT, "task-seed-salt"), "w") as fh:
            fh.write("00112233445566778899aabbccddeeff\n")
        self.tasks = {"svs_f1_flood_recall": {"alias": "f1"}, "lh1_incremental_build": {"alias": "c1"}}

    def tearDown(self):
        shutil.rmtree(self.d)

    def test_mapped_rep_takes_the_baseline_cells_seed(self):
        ctx = {"ab_root": self.d, "batch": "batch-svs2", "tasks": self.tasks, "seed_keys": GATES["pairing"]["seed_keys"]}
        base = {"ab_root": self.d, "tasks": self.tasks}
        # rep 3 of f1 is the baseline's arbitration cell (arb, rep 1); the new batch's name does not matter
        self.assertEqual(A.seed_key(ctx, "svs_f1_flood_recall", 3), ("arb", 1))
        self.assertEqual(A.task_seed(ctx, "svs_f1_flood_recall", 3), A.task_seed(dict(base, batch="arb"), "svs_f1_flood_recall", 1))
        self.assertEqual(A.task_seed(dict(ctx, batch="arb2"), "svs_f1_flood_recall", 2), A.task_seed(dict(base, batch="batch"), "svs_f1_flood_recall", 2))
        # unmapped tasks and reps keep the cell's own (batch, rep)
        self.assertEqual(A.seed_key(ctx, "lh1_incremental_build", 1), ("batch-svs2", 1))
        self.assertEqual(A.seed_key(ctx, "svs_f1_flood_recall", 9), ("batch-svs2", 9))

    def test_salt_guard(self):
        want = A.salt_sha256(self.d)
        g = {"pairing": {"salt_sha256": want}}
        self.assertIn("is the baseline's", A.salt_guard(g, self.d, ["f1"], offline=False))
        self.assertIsNone(A.salt_guard(g, self.d, [], offline=False))                    # no seeded task selected
        g2 = {"pairing": {"salt_sha256": "0" * 64}}
        self.assertIn("offline dry run", A.salt_guard(g2, self.d, ["f1"], offline=True))
        with self.assertRaises(SystemExit):
            A.salt_guard(g2, self.d, ["f1"], offline=False)
        os.remove(os.path.join(self.d, A.VAULT, "task-seed-salt"))
        with self.assertRaises(SystemExit):
            A.salt_guard(g, self.d, ["f1"], offline=False)


class Guards(unittest.TestCase):
    def test_paid_run_only_the_new_arms(self):
        self.assertEqual(A.run_guards(GATES, ["a", "b", "c"], offline=False), {})
        with self.assertRaises(SystemExit):
            A.run_guards(GATES, ["a", "slice"], offline=False)
        with self.assertRaises(SystemExit):
            A.run_guards(GATES, ["stock"], offline=False)
        self.assertEqual(A.run_guards(GATES, ["stock", "a"], offline=True), {})          # an offline dry run may

    def test_structure_as_offline_only(self):
        self.assertEqual(A.run_guards(GATES, ["a"], True, ["a=slice"]), {"a": "slice"})
        with self.assertRaises(SystemExit):
            A.run_guards(GATES, ["a"], False, ["a=slice"])
        ctx = {"structure": GATES["structure"], "structure_as": {"a": "slice"}}
        self.assertIs(A.expected_structure(ctx, "a"), GATES["structure"]["slice"])
        self.assertIs(A.expected_structure(dict(ctx, structure_as={}), "a"), GATES["structure"]["a"])

    def test_markers_from_the_structure(self):
        self.assertEqual(A.structure_markers(GATES["structure"]), ["You are sliceagent", "A recorded file read is not a current file"])


class Layout(unittest.TestCase):
    def test_top_level_worktrees_and_extras(self):
        d = tempfile.mkdtemp()
        try:
            for sub in ("host", "vault", "wt/old/scripts", "wt-harness/scripts", "wt-harness/docs", "build-ab", "plain"):
                os.makedirs(os.path.join(d, sub))
            with open(os.path.join(d, "wt-harness", ".git"), "w") as fh:
                fh.write("gitdir: /x\n")
            open(os.path.join(d, "c1r1slice.jsonl"), "w").close()
            open(os.path.join(d, "progress.txt"), "w").close()
            os.symlink("/tmp", os.path.join(d, "link"))
            wts = A.worktree_dirs(d)
            self.assertEqual([os.path.relpath(w, d) for w in wts], ["wt/old", "wt-harness"])
            self.assertEqual([A.worktree_label(d, w) for w in wts], ["old", "wt-harness"])
            self.assertEqual(sorted(os.path.relpath(p, d) for p in A.worktree_blocks(d)), ["wt-harness/docs", "wt-harness/scripts", "wt/old/scripts"])
            self.assertEqual(sorted(os.path.basename(p) for p in A.ab_extras(d)), ["build-ab", "c1r1slice.jsonl", "plain"])
        finally:
            shutil.rmtree(d)

    def test_content_digest_ignores_mtimes_and_sees_links(self):
        d = tempfile.mkdtemp()
        try:
            for h in ("h1", "h2"):
                os.makedirs(os.path.join(d, h, "node_modules", "x"))
                with open(os.path.join(d, h, "node_modules", "x", "a.js"), "w") as fh:
                    fh.write("1")
                os.symlink("../x/a.js", os.path.join(d, h, "node_modules", "l"))
            os.utime(os.path.join(d, "h2", "node_modules", "x", "a.js"), (1, 1))
            c1, c2 = A.host_content_digest(os.path.join(d, "h1")), A.host_content_digest(os.path.join(d, "h2"))
            self.assertEqual(c1, c2)
            self.assertEqual(c1[1:], (1, 1))
            self.assertNotEqual(A.host_digest(None, os.path.join(d, "h1")), A.host_digest(None, os.path.join(d, "h2")))
            os.remove(os.path.join(d, "h2", "node_modules", "l"))
            os.symlink("../x/b.js", os.path.join(d, "h2", "node_modules", "l"))
            self.assertNotEqual(c1[0], A.host_content_digest(os.path.join(d, "h2"))[0])
        finally:
            shutil.rmtree(d)


class MarkerValidity(unittest.TestCase):
    def row(self, markers, tools=SLICE_TOOLS):
        return {"validity": {"tools_count": len(tools), "tool_lists_distinct": 1, "system_distinct": 1, "system_has_host_path": False, "compaction_events": 0,
                             "user_prompts": 1, "turn_ends": 1, "goal_messages": 0, "tool_names": sorted(tools), "system_sha": "s", "slice_tools_sha": "t",
                             "system_markers": markers},
                "prefix": {"prefix_chars": 1}, "tape": {"entries": 1, "header_forms": {"short": 1}, "header_lengths": [76], "tool_line_forms": {"long": 1}},
                "in_turn": [], "delivery": []}

    def test_per_arm_markers(self):
        ctx = {"fingerprints": None, "structure": GATES["structure"]}
        turn = {"turn": 1, "exit": 0, "infra": False, "turn_end": {"kind": "completed"}}
        persona, rule = "You are sliceagent", "A recorded file read is not a current file"
        meta = {"turns": 1}
        self.assertEqual(A.validity(ctx, "a", meta, [turn], self.row({persona: True, rule: False})), [])
        self.assertEqual(A.validity(ctx, "b", meta, [turn], self.row({persona: False, rule: False})), [])
        self.assertEqual(A.validity(ctx, "c", meta, [turn], self.row({persona: False, rule: False})), [])
        r = A.validity(ctx, "a", meta, [turn], self.row({persona: True, rule: True}))       # the main build: A must not carry the rule
        self.assertTrue(any("excluded marker" in x for x in r), r)
        r = A.validity(ctx, "b", meta, [turn], self.row({persona: True, rule: False}))      # B without persona
        self.assertTrue(any("excluded marker 'You are sliceagent'" in x for x in r), r)
        r = A.validity(ctx, "a", meta, [turn], self.row({}))                                # markers not computed: fails closed
        self.assertTrue(any("not computed" in x for x in r), r)
        r = A.validity(ctx, "a", meta, [turn], self.row({persona: True, rule: False}, tools=SLICE_TOOLS[:-1] + ["web_fetch"]))
        self.assertTrue(any("are not the declared 16" in x for x in r), r)

    def test_metrics_compute_markers(self):
        ev = [{"type": "session", "cwd": "/w"}, {"type": "system/message", "data": {"message": {"content": [{"type": "text", "text": "You are sliceagent, x"}]}}}]
        v = M.metrics(ev, system_markers=["You are sliceagent", "nope"])["validity"]["system_markers"]
        self.assertEqual(v, {"You are sliceagent": True, "nope": False})


def call(turn, name, **args):
    return {"type": "tool/call", "data": {"turn": turn, "name": name, "callId": f"c{id(args)}", "arguments": json.dumps(args)}}


def result(turn, text):
    return {"type": "tool/result", "data": {"turn": turn, "message": {"content": [{"type": "text", "text": text}]}}}


class Rereads(unittest.TestCase):
    def test_classes(self):
        ev = [{"type": "turn/start", "data": {"turn": 1}},
              call(1, "read", file_path="calc.py"),                     # first
              call(1, "read", file_path="/w/calc.py"),                  # same turn (same file, absolute)
              call(1, "edit", file_path="calc.py", old_string="a", new_string="b"),
              call(1, "read", file_path="calc.py"),                     # after own edit
              call(1, "read", file_path="calc.py"),                     # still after own edit (edited earlier in the turn)
              result(1, "Error: file has not been read — read the file, then retry"),
              {"type": "turn/start", "data": {"turn": 2}},
              call(2, "bash", command='cd "/w" && cat calc.py'),        # cross turn (bash read, quoted cd)
              call(2, "read", file_path="README.md"),                   # first
              call(2, "bash", command="cat > notes.txt <<'EOF'\nx\nEOF"),  # a bash write, not a read
              call(2, "bash", command="python3 -m pytest -q | tail -3"),   # neither
              result(2, "file changed since it was read — re-read the file, then retry"),
              {"type": "turn/start", "data": {"turn": 3}},
              call(3, "write", file_path="new.py", content="x"),
              call(3, "read", file_path="new.py"),                      # after own edit (never read before)
              call(3, "read", file_path="/tmp/calc.py")]                # first: another file with the same name
        r = M.reread_classes(ev, "/w")
        self.assertEqual({k: r[k] for k in M.REREAD_CLASSES}, {"first": 3, "cross_turn": 1, "same_turn": 1, "after_own_edit": 3})
        self.assertEqual((r["reads"], r["edits_writes"], r["bash_writes"], r["fs_not_observed"], r["fs_stale_version"]), (8, 2, 1, 1, 1))
        self.assertEqual(r["per_turn"]["2"], {"cross_turn": 1, "first": 1})

    def test_replacements_do_not_count_refusals_twice(self):
        ev = [result(1, "file has not been read"), dict(result(1, "file has not been read"), surfaceOp={"op": "replace"})]
        self.assertEqual(M.reread_classes(ev, "/w")["fs_not_observed"], 1)


def cell(alias, rep, arm, cost, ok=True, mem=None, excluded=False, valid=True, batch="b"):
    c = {"cell": f"{alias}.r{rep}.{arm}", "alias": alias, "task": alias, "rep": rep, "arm": arm, "valid": valid, "pass": ok, "g2_excluded": excluded,
         "invalid_reasons": [] if valid else ["x"], "wall_s": 10, "_batch": batch,
         "metrics": {"usage": {"cost_offpeak": cost, "cost_peak": 2 * cost, "miss": 1, "hit": 1, "out": 1, "requests": 3, "cache_hit_rate": 0.9},
                     "finish": {"closeout": 1, "step_limit_cut": 0}, "reads": {"reread_same_turn_unchanged": 0, "reread_same_turn_after_edit": 0},
                     "compaction": {"summaries": 0, "failed": 0, "prunes": 0, "turns": [], "context_limit_errors": 0},
                     "context": {"peak_request_tokens": 1000}, "per_turn": {"1": {"max_step": 3}}, "exams": [],
                     "rereads": {"first": 1, "cross_turn": 2, "same_turn": 0, "after_own_edit": 1, "reads": 4, "edits_writes": 3}, "tape": {}}}
    if alias == "f1":
        c["verify_info"] = {"memory_classes": mem or {"build_id": "correct", "lint_error": "correct", "deploy": "correct", "trap": "correct"}}
        c["exam_class"] = "correct"
    elif alias == "r2":
        c["exam_class"] = mem or ("correct" if ok else "wrong")
    return c


def cellmap(cells):
    out = {}
    for c in cells:
        out.setdefault((c["alias"], c["rep"], c["arm"]), []).append(c)
    return out


def design(costs, over=None):
    """Every planned cell: costs[arm][task] (default 1.0); over[(arm, task, rep)] = cell kwargs."""
    out, over = [], over or {}
    for t, reps in GATES["pairing"]["baseline_cells"].items():
        for r in map(int, reps):
            for arm in ("stock", "slice", "a", "b", "c"):
                out.append(cell(t, r, arm, costs.get(arm, {}).get(t, 1.0), **over.get((arm, t, r), {})))
    return out


class Report(unittest.TestCase):
    def test_pairs_by_rep_index_and_ratios(self):
        cells = cellmap(design({"a": {"c1": 1.2, "c2": 1.0, "f1": 0.6, "r2": 1.1}}))
        cmp = R.compare(cells, GATES, "a", "stock")
        self.assertEqual(cmp["pairs"], 15)
        self.assertEqual((cmp["tasks"]["c1"]["R"], cmp["R_f1"]), (1.2, 0.6))
        self.assertAlmostEqual(cmp["N_code"], (1.2 * 1.0) ** 0.5, places=4)
        self.assertAlmostEqual(cmp["N_code3"], (1.2 * 1.0 * 1.1) ** (1 / 3), places=4)
        self.assertEqual(cmp["insufficient"], [])
        self.assertEqual(cmp["memory"]["items"], 4 * 3 + 4)

    def test_side_means_after_arbitration(self):
        cs = design({"a": {"c1": 1.0}})
        cs.append(cell("c1", 1, "a", 3.0, batch="arb"))                     # a second cell at rep 1 (the arbitration)
        cmp = R.compare(cellmap(cs), GATES, "a", "stock")
        self.assertEqual(cmp["tasks"]["c1"]["paired_ratios"][0], 2.0)        # (1 + 3) / 2 over 1
        self.assertEqual(cmp["arm_cells_per_pair"], [1, 2])

    def test_interpretation_rules(self):
        self.assertEqual(R.interpret(True, 1.05, 0.70, [])[0], "fixes the short-session overhead")
        self.assertEqual(R.interpret(True, 1.05, 0.85, [])[0], "fixes the short-session overhead but loses the long-session saving")
        self.assertEqual(R.interpret(True, 1.20, 0.70, [])[0], "does not fix the short-session overhead")
        self.assertEqual(R.interpret(True, 1.20, 0.90, [])[0], "neither")
        self.assertEqual(R.interpret(False, 1.0, 0.5, [])[0], "quality floor fails")
        self.assertEqual(R.interpret(False, 1.0, 0.5, ["c1: 1 pairs < 2"])[0], "inconclusive")   # minimums first
        self.assertEqual(R.interpret(True, None, 0.5, [])[0], "inconclusive")

    def test_quality_floor_and_minimums(self):
        over = {("a", "c1", 1): {"ok": False}, ("a", "c1", 2): {"ok": False}}
        cmp = R.compare(cellmap(design({}, over)), GATES, "a", "stock")
        self.assertEqual(cmp["dS_t"]["c1"], -2)
        self.assertFalse(R.quality(cmp, GATES["decision"]))
        over = {("a", "c1", r): {"valid": False} for r in (1, 2, 3)}
        cmp = R.compare(cellmap(design({}, over)), GATES, "a", "stock")
        self.assertIn("c1: 1 pairs < 2", cmp["insufficient"])
        over = {("a", "f1", 1): {"mem": {"build_id": "wrong", "lint_error": "decoy", "deploy": "correct", "trap": "correct"}}}
        cmp = R.compare(cellmap(design({}, over)), GATES, "a", "stock")
        self.assertEqual((cmp["memory"]["dM"], cmp["memory"]["dB"]), (-2, 2))
        self.assertFalse(R.quality(cmp, GATES["decision"]))
        over = {("stock", "r2", 2): {"excluded": True}}
        cmp = R.compare(cellmap(design({}, over)), GATES, "a", "stock")
        self.assertEqual(cmp["memory"]["items"], 12 + 3)

    def test_arbitration_trigger(self):
        cmp = R.compare(cellmap(design({"a": {"c1": 1.12, "c2": 1.12, "f1": 0.6}})), GATES, "a", "stock")
        trig = R.arbitration_needed(cmp, GATES)
        self.assertEqual([q for q, _, _ in trig], ["N_code"])
        self.assertEqual(trig[0][2], ["c1", "c2"])
        cmp = R.compare(cellmap(design({"a": {"c1": 1.0, "c2": 1.0, "f1": 0.78}})), GATES, "a", "stock")
        self.assertEqual([(q, ts) for q, _, ts in R.arbitration_needed(cmp, GATES)], [("R_f1", ["f1"])])
        cmp = R.compare(cellmap(design({"a": {"c1": 0.9, "c2": 0.9, "f1": 0.5}})), GATES, "a", "stock")
        self.assertEqual(R.arbitration_needed(cmp, GATES), [])
        over = {("a", "r2", 1): {"ok": False}}
        cmp = R.compare(cellmap(design({"a": {"c1": 0.9, "c2": 0.9, "f1": 0.5}}, over)), GATES, "a", "stock")
        self.assertEqual([(q, ts) for q, _, ts in R.arbitration_needed(cmp, GATES)], [("quality", ["r2"])])

    def test_summary_steps_and_rereads(self):
        d = tempfile.mkdtemp()
        try:
            new, base = os.path.join(d, "batch"), os.path.join(d, "baseline")
            for root, arms in ((new, ("a", "b", "c")), (base, ("stock", "slice"))):
                os.makedirs(os.path.join(root, "cells"))
                for c in design({"a": {"c1": 1.2}, "b": {"c1": 1.1}, "c": {"c1": 0.9}, "slice": {"c1": 1.6}}):
                    if c["arm"] in arms:
                        with open(os.path.join(root, "cells", c["cell"] + ".json"), "w") as fh:
                            json.dump(c, fh)
            s = R.build_summary([new], base, GATES)
            self.assertEqual(sorted(s["interpretation"]), ["a", "b", "c"])
            self.assertEqual(s["steps"]["a/slice"]["kind"], "cross-batch (baseline of 2026-10-23)")
            self.assertAlmostEqual(s["steps"]["c/b"]["N_code"], (0.9 / 1.1) ** 0.5, places=4)
            self.assertEqual(s["steps"]["c/b"]["N_code_label"], "moves the cost down")
            self.assertEqual(s["steps"]["b/a"]["N_code_label"], "no measurable effect at this n")
            self.assertEqual(s["rereads"]["a"]["c1"]["cross_turn"], 8)
            self.assertIn("cross-batch", s["caveat"])
            self.assertIn("| a |", R.render_md(s))
        finally:
            shutil.rmtree(d)

    def test_import_diff_ignores_new_keys_only(self):
        stored = {"usage": {"cost_offpeak": 1.0, "requests": 3}, "exams": [{"turn": 6, "oracle_via_fs": False}]}
        same = {"usage": {"cost_offpeak": 1.0, "requests": 3, "new": 1}, "exams": [{"turn": 6, "oracle_via_fs": False, "x": 2}], "rereads": {}}
        self.assertEqual(R.diff_stored(stored, same), [])
        changed = {"usage": {"cost_offpeak": 1.1, "requests": 3}, "exams": []}
        self.assertEqual(len(R.diff_stored(stored, changed)), 2)
        self.assertEqual(R.rebase("/old/root/batch/homes/c-1/x.zstd", "/old/root", "/arch"), "/arch/batch/homes/c-1/x.zstd")


class Plan(unittest.TestCase):
    def test_priors_ladder_and_affordability(self):
        res = P.plan(GATES)
        pr = res["per_cell_prior"]
        self.assertAlmostEqual(pr["c1"], 0.1624 * 1.2, places=4)                 # max(SLICE, STOCK) x 1.2
        self.assertAlmostEqual(pr["f1"], 0.2619 * 1.2, places=4)                 # SLICE's for the long task
        self.assertAlmostEqual(pr["r2"], 0.0215 * 1.2, places=4)
        self.assertEqual([s["cells"] for s in res["stages"]], [6, 24, 6, 3, 6, 6])
        self.assertEqual(res["planning_ladder_dropped"], [])
        self.assertLessEqual(res["planned_with_arbitration_usd"], GATES["budget"]["planning_target_usd"])
        self.assertTrue(all(s["affordable"] for s in res["stages"]))
        tight = json.loads(json.dumps(GATES))
        tight["budget"]["planning_target_usd"] = 5.0
        res2 = P.plan(tight)
        self.assertEqual(res2["planning_ladder_dropped"], ["S5", "S4", "S3"])    # cut from the end
        self.assertFalse(any(s["affordable"] for s in res2["stages"] if s["id"] in res2["planning_ladder_dropped"]))

    def test_measured_costs_and_a_spent_ledger(self):
        d = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(d, "b", "cells"))
            for arm in ("a", "b", "c"):
                for r in (1, 2):
                    c = cell("f1", r, arm, 0.5)
                    c["status"] = "done"
                    with open(os.path.join(d, "b", "cells", c["cell"] + ".json"), "w") as fh:
                        json.dump(c, fh)
            ledger = os.path.join(d, "spend.jsonl")
            with open(ledger, "w") as fh:
                fh.write(json.dumps({"batch": "b", "usd": 7.5}) + "\n")
            res = P.plan(GATES, batch_dirs=[os.path.join(d, "b")], ledger=ledger)
            self.assertEqual(res["per_cell_estimate"]["a:f1"], {"usd": 1.0, "from": "measured"})   # peak = 2 x off-peak
            s1 = next(s for s in res["stages"] if s["id"] == "S1")
            self.assertEqual(s1["cells_to_run"], 24 - 6)
            self.assertFalse(s1["affordable"])                                     # 7.5 spent: S1's rest no longer fits
            self.assertFalse(any(s["affordable"] for s in res["stages"][1:]))
        finally:
            shutil.rmtree(d)


class Conditions(unittest.TestCase):
    @unittest.skipUnless(subprocess.run(["git", "-C", HERE, "cat-file", "-t", GATES["pairing"]["baseline_conditions"]["scripts_ab_tree"]],
                                        capture_output=True).returncode == 0, "baseline tree not in this repository")
    def test_task_definitions_equal_the_baseline_tree(self):
        import svs2_checks
        res = svs2_checks.check_conditions(GATES, GATES["pairing"]["baseline_conditions"]["scripts_ab_tree"])
        bad = [i for i in res["items"] if not i["ok"] and not i["what"].startswith("step cap")]
        self.assertEqual(bad, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
