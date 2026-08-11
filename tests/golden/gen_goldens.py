"""Golden generator for the Python->TS slice-engine port (task #8).

Reads cases.json (shared with the vitest suite), constructs ctx/blocks/tape entries
EXACTLY as the TS side will, runs the real Python engine, and writes expected.json
mapping case name -> expected output string. Dev artifact; do not hand-edit outputs.

Run:
  npm run goldens

scripts/gen-goldens.mjs locates the sliceagent checkout ($SLICEAGENT_REPO, else
~/code/sliceagent) and its interpreter ($SLICEAGENT_PYTHON, else the repo venv,
else python3), then invokes this script with PYTHONPATH already set. Only the
maintainer needs it — `npm test` asserts against the checked-in expectations.
"""
from __future__ import annotations

import json
import os
from types import SimpleNamespace

from sliceagent_core.context import (ContextBlock, ContextUnfitError, ElasticityController,
                                     EpistemicRole, Fidelity, FreshnessClass, InstructionClass,
                                     RepresentationLoss, SeedPlan)
from sliceagent_core.regions import (assert_placement_law, build_context_blocks, context_block,
                                     render_context_selection, render_current_request,
                                     render_findings, render_now, render_regions)
from sliceagent_core.tape import (apply_unified, base_entry, compact_tape, compose_after,
                                  digest_entry, external_entry, finding_entry, finding_hash,
                                  knowledge_entry, knowledge_hash, patch_entry, reply_entry,
                                  reasoning_entry, tape_render, unified_patch, TapeEntry)

HERE = os.path.dirname(os.path.abspath(__file__))


def expand(v):
    """Recursively expand {"__repeat__": [s, n], "__prefix__": p, "__suffix__": q} -> p + s*n + q."""
    if isinstance(v, dict) and "__repeat__" in v:
        body = str(v["__repeat__"][0]) * int(v["__repeat__"][1])
        return str(v.get("__prefix__", "")) + body + str(v.get("__suffix__", ""))
    if isinstance(v, dict):
        return {k: expand(x) for k, x in v.items()}
    if isinstance(v, list):
        return [expand(x) for x in v]
    return v


def build_contract(spec):
    if spec is None:
        return None
    spec = expand(spec)

    def ns(d):
        if d is None:
            return None
        return SimpleNamespace(**{k: (tuple(v) if isinstance(v, list) and k in (
            "source_needs", "requested_modes", "targets", "tools") else v)
            for k, v in d.items()})

    return SimpleNamespace(
        grounding=spec.get("grounding", "none"),
        source_needs=tuple(spec.get("source_needs", ())),
        evidence_query=ns(spec.get("evidence_query")),
        quality_evidence_query=ns(spec.get("quality_evidence_query")),
        delegation_requirement=ns(spec.get("delegation_requirement")),
        requested_modes=tuple(spec.get("requested_modes", ())),
        actor=ns(spec.get("actor")),
        target=ns(spec.get("target")),
        evidence_continuation=spec.get("evidence_continuation", False),
        focus_repairs=tuple(spec.get("focus_repairs", ())),
        effect_grants=tuple(ns(g) for g in spec.get("effect_grants", ())),
        authority_spans=tuple(tuple(x) for x in spec.get("authority_spans", ())),
        attributed_spans=tuple(tuple(x) for x in spec.get("attributed_spans", ())),
        referents=tuple(
            {**r, "anchor": ns(r["anchor"])} if isinstance(r, dict) and r.get("anchor") else r
            for r in spec.get("referents", ())),
        effect_authority=spec.get("effect_authority", "none"),
    )


def build_entry(op):
    op = expand(op)
    kind = op["op"]
    if kind == "digest":
        return digest_entry(op["rendered"], op.get("ref", ""))
    if kind == "base":
        return base_entry(op["path"], op["body"])
    if kind == "patch":
        return patch_entry(op["path"], op["before"], op["after"])
    if kind == "external":
        return external_entry(op["path"], op["new_hash"], op["reason"])
    if kind == "reply":
        return reply_entry(op["artifact_id"], op["text"])
    if kind == "reasoning":
        return reasoning_entry(op["artifact_id"], op["text"])
    if kind == "finding":
        return finding_entry(op["line"], task=op.get("task", ""))
    if kind == "knowledge":
        return knowledge_entry(op["text"], task=op.get("task", ""))
    if kind == "epoch":
        return TapeEntry(kind="epoch", rendered=op["rendered"],
                         ref=op.get("ref", ""), ref_end=op.get("ref_end", ""))
    raise ValueError(f"unknown entry op {kind!r}")


def build_ctx(spec):
    spec = expand(spec)
    s_spec = spec.get("s", {}) or {}
    intent_spec = s_spec.get("intent") or {}
    entries = [SimpleNamespace(
        verbatim_clause=e.get("verbatim_clause", ""),
        status=e.get("status", "active"),
        authority=e.get("authority", "legacy"),
        kind=e.get("kind", "constraint"),
        source_artifact=e.get("source_artifact", ""),
        source_range=tuple(e["source_range"]) if e.get("source_range") is not None else None,
    ) for e in intent_spec.get("entries", [])]
    intent = SimpleNamespace(
        entries=entries,
        resident_entries=lambda: list(entries),
        current_request=intent_spec.get("current_request", ""),
        current_source=intent_spec.get("current_source", ""),
        turn_contract=build_contract(intent_spec.get("turn_contract")),
    )
    task_spec = s_spec.get("task") or {}
    task = SimpleNamespace(
        goal=task_spec.get("goal", ""),
        goal_source=task_spec.get("goal_source", ""),
        objective_status=task_spec.get("objective_status", "active"),
        progress_signals=[SimpleNamespace(kind=p["kind"], detail=p["detail"],
                                          count=p.get("count", 1))
                          for p in task_spec.get("progress_signals", [])],
        deliverable_requirement=task_spec.get("deliverable_requirement"),
    )
    cont_spec = s_spec.get("continuity") or {}
    continuity = SimpleNamespace(
        tape_finding_hashes=set(tuple(x) for x in cont_spec.get("tape_finding_hashes", [])),
        tape_knowledge_hashes=set(tuple(x) for x in cont_spec.get("tape_knowledge_hashes", [])),
        tape_task_id=cont_spec.get("tape_task_id", ""),
        last_knowledge_render=cont_spec.get("last_knowledge_render", ""),
    )
    aw = s_spec.get("active_work")
    s = SimpleNamespace(
        intent=intent,
        task=task,
        findings=list(s_spec.get("findings", [])),
        finding_source=dict(s_spec.get("finding_source", {})),
        session_tape=[e for e in (build_entry(op) for op in s_spec.get("session_tape", []))
                      if e is not None],
        active_files=list(s_spec.get("active_files", [])),
        active_skills=[dict(x) for x in s_spec.get("active_skills", [])],
        world=dict(s_spec.get("world", {})),
        open_report=s_spec.get("open_report", ""),
        last_error=s_spec.get("last_error", ""),
        reconciliation_required=s_spec.get("reconciliation_required", ""),
        reconciliation_targets=tuple(s_spec.get("reconciliation_targets", [])),
        continuity=continuity,
        active_work=None if aw is None else SimpleNamespace(items=aw.get("items", [])),
        conversation=[dict(r) for r in s_spec.get("conversation", [])],
    )
    # freeze flags: mark findings/knowledge as already frozen on the tape (P8 suppression)
    task_id = continuity.tape_task_id
    for text in spec.get("freeze_findings", []) or []:
        line = render_findings([text], s.finding_source)
        continuity.tape_finding_hashes.add((task_id, finding_hash(line)))
    if spec.get("freeze_knowledge"):
        continuity.tape_knowledge_hashes.add((task_id, knowledge_hash(spec.get("memory", ""))))
    ctx = {
        "s": s,
        "artifacts": spec.get("artifacts", ""),
        "discovery": spec.get("discovery", ""),
        "memory": spec.get("memory", ""),
        "threads": spec.get("threads", ""),
        "worktree": spec.get("worktree", ""),
        "focus": spec.get("focus", ""),
        "repo_map": spec.get("repo_map", ""),
        "open_file_paths": tuple(spec["open_file_paths"]) if "open_file_paths" in spec
        else tuple(s.active_files),
        "max_findings": spec.get("max_findings", 8),
    }
    return ctx


def build_block(spec):
    spec = expand(spec)
    b = dict(spec.get("block", spec))
    kw = dict(
        block_id=b.get("block_id", "x"),
        item_id=spec.get("item", b.get("item_id", "")),
        alternative_group=b.get("alternative_group", "g"),
        priority=b.get("priority", 5),
        instruction_class=InstructionClass(b.get("instruction_class", "task_state")),
        freshness=FreshnessClass(b.get("freshness", "derived")),
        fidelity=Fidelity(b.get("fidelity", "full")),
        representation_loss=RepresentationLoss(b.get("representation_loss", "none")),
        content=b.get("content", ""),
        handles=tuple(b.get("handles", ())),
        mandatory=b.get("mandatory", False),
        reobservable=b.get("reobservable", False),
        order=b.get("order", 0),
    )
    if "slot" in (spec if "block" in spec else {}):
        kw["slot"] = spec["slot"]
    elif "slot" in b:
        kw["slot"] = b["slot"]
    if "epistemic_role" in b:
        kw["epistemic_role"] = EpistemicRole(b["epistemic_role"])
    return ContextBlock(**kw)


def err_text(exc):
    return f"{type(exc).__name__}: {exc}"


def run_case(case):
    kind = case["kind"]
    if kind == "render":
        return render_regions(build_ctx(case.get("ctx", {})))
    if kind == "render_capacity":
        ctx = build_ctx(case.get("ctx", {}))
        blocks = build_context_blocks(ctx)
        sel = ElasticityController().select(blocks, capacity_chars=case.get("capacity"))
        return render_context_selection(sel)
    if kind == "assemble":
        ctx = build_ctx(case.get("ctx", {}))
        plan = SeedPlan(
            system=case.get("system", ""),
            blocks=build_context_blocks(ctx),
            render_blocks=render_context_selection,
            request_block=render_current_request(case.get("request", "")),
            now_block=render_now(case.get("hints", "")),
        )
        return plan.project(case.get("capacity"))[1]["content"]
    if kind == "tape_render":
        return tape_render([build_entry(op) for op in case["entries"]])
    if kind == "tape_patch_diff":
        case = expand(case)
        return unified_patch(case["path"], case["before"], case["after"])
    if kind == "tape_compose":
        case = expand(case)
        entries = [base_entry(case["path"], case["base_body"])]
        content = case["base_body"]
        for before, after in case["steps"]:
            assert content == before, "compose chain diverged in fixture"
            e = patch_entry(case["path"], before, after)
            entries.append(e)
            content = compose_after(e, content)
        return json.dumps({
            "rendered": [e.rendered for e in entries],
            "final": content,
        }, ensure_ascii=False)
    if kind == "tape_compact":
        case = expand(case)
        tape = [build_entry(op) for op in case["entries"]]
        files = {p: {"hash": "", "content": v["content"]}
                 for p, v in case.get("files", {}).items()}
        info = compact_tape(tape, files, budget=case["budget"])
        return json.dumps({"info": info, "tape": tape_render(tape)}, ensure_ascii=False)
    if kind == "elasticity":
        blocks = []
        try:
            blocks = [build_block(b) for b in case.get("blocks", [])]
        except Exception as exc:  # constructor rejection is part of the contract
            return json.dumps({"error": err_text(exc)}, ensure_ascii=False)
        try:
            sel = ElasticityController().select(blocks, capacity_chars=case.get("capacity"))
        except Exception as exc:
            return json.dumps({"error": err_text(exc)}, ensure_ascii=False)
        return json.dumps({
            "blocks": [b.block_id for b in sel.blocks],
            "pressure": sel.pressure.value,
            "used_chars": sel.used_chars,
            "capacity_chars": sel.capacity_chars,
        }, ensure_ascii=False)
    if kind == "placement":
        out = []
        for step in case["steps"]:
            op = step["op"]
            try:
                if op == "factory":
                    kw = {k: v for k, v in expand(step["block"]).items()}
                    kw.setdefault("instruction_class", InstructionClass.DATA)
                    kw.setdefault("freshness", FreshnessClass.LIVE)
                    kw.setdefault("fidelity", Fidelity.FULL)
                    kw.setdefault("representation_loss", RepresentationLoss.NONE)
                    if "slot" in step:
                        kw["slot"] = step["slot"]
                    blk = context_block(step["item"], **kw)
                    out.append(f"ok slot={blk.slot}")
                elif op == "direct":
                    blk = build_block(step)
                    out.append(f"ok slot={blk.slot}")
                elif op == "assert":
                    blocks = [build_block(b) for b in step["blocks"]]
                    assert_placement_law(blocks)
                    out.append("ok")
            except Exception as exc:
                out.append(f"error {err_text(exc)}")
        return "\n".join(out) + "\n"
    if kind == "seedplan":
        blocks = [build_block(b) for b in case.get("blocks", [])]
        plan = SeedPlan(
            system=case.get("system", ""),
            blocks=blocks,
            render_blocks=lambda selection: "".join(b.content for b in selection.blocks),
            request_block=case.get("request_block", ""),
            now_block=case.get("now_block", ""),
        )
        mode = case.get("capacity_mode")
        fixed = plan._fixed_user_chars(1)
        if mode == "fixed":
            capacity = fixed
        elif mode == "fixed_minus_1":
            capacity = fixed - 1
        elif mode and mode.startswith("fixed_plus_block_"):
            capacity = fixed + len(blocks[int(mode.rsplit("_", 1)[1])].content)
        else:
            capacity = None
        try:
            return plan.project(capacity)[1]["content"]
        except Exception as exc:
            return json.dumps({"error": err_text(exc)}, ensure_ascii=False)
    raise ValueError(f"unknown case kind {kind!r}")


def main():
    with open(os.path.join(HERE, "cases.json"), encoding="utf-8") as f:
        cases = json.load(f)["cases"]
    expected = {}
    for case in cases:
        try:
            expected[case["name"]] = run_case(case)
        except Exception as exc:
            expected[case["name"]] = json.dumps({"error": err_text(exc)}, ensure_ascii=False)
    out = os.path.join(HERE, "expected.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(expected, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")
    print(f"wrote {len(expected)} goldens -> {out}")
    for name in expected:
        print(f"  {name}: {len(expected[name])} chars")


if __name__ == "__main__":
    main()
