#!/usr/bin/env python3
"""orient_report.py: the slice-orientation test of 2026-10-25 (docs/slice-orientation-2026-10-25.md).

One new arm, D, against cells imported read-only: STOCK and SLICE of 2026-10-23 (svs2_report.py import-baseline with
gates-orient.json) and B of the svs2 batch of 2026-10-24 (import-b). The pairing, the cost ratios, the quality floor and
the re-read classes are svs2_report.py's, unchanged; this file adds the import of B, the ship rule, the classes of
flagged calls and the empty-turn count.

usage:
  orient_report.py import-b --out DIR [--gates scripts/ab/gates-orient.json]
      Read-only import of B's svs2 batch cells (gates cross_batch.b): every metrics row recomputed from its archived
      session log with this ab_metrics (svs2_report.import_baseline with B's archive and pairing). Exit 1 if a stored
      metric or memory-exclusion flag is not reproduced.

  orient_report.py report <batch-dir> [<warm-dir> ...] --baseline DIR --b DIR [--gates G] [--ledger FILE] [--out DIR]
      D against STOCK, B and SLICE per task (R_t, paired ratios, pass, memory), N_code, R_f1, N_code(D)/N_code(B), the
      quality floor, the four ship conditions, re-read classes, cost structure, flagged calls with their commands and
      classes, empty turns. B against STOCK is recomputed beside it (it must reproduce the svs2 record: N_code 1.193,
      R_f1 0.555). Writes summary.json and summary.md to --out (default: the first dir).

  orient_report.py calibrate [--gates G]
      The flag classifier and the empty-turn detector on the archived svs2 (batch, arb, pilot) and 2026-10-23 (batch,
      arb) cells of c1, c2, r2 and f1: every flagged call that the automatic classes do not clear, and every empty turn.

Flagged calls (ab_metrics flagged_access; docs §6.2). The automatic classes are final:
  F1 operator   a flagged path whose first component does not exist at the file-system root: Python's / and //
                operators, a regex delimiter, an unexpanded "$(pwd)/x" (svs2 §16, the baseline's c1 cells)
  F2 own        the path, trailing punctuation stripped, lies in the workdir, or names the cell's own c-<id>/w-<id>
                (a mistyped absolute spelling of the workdir; svs2 §16, C arb f1 rep 3)
  F3 scratch    the cell's own TMPDIR, or a path below /tmp outside the session scratch tree /private/tmp/claude-501 (a
                scratch script the model wrote; svs2 §16), or `cd /tmp`, as long as the call lists or searches no /tmp
                directory (ls, find, du, tree, grep, rg, stat, the glob and grep tools)
Every other flagged call is a candidate: checked by hand from its full command, it is a real probe unless the command
shows that the flagged text is only data that no command or code in the call uses as a file-system path (F4 data, e.g.
a ".." or "~" inside a string literal or comment of a script; the 2026-10-23 STOCK c1 arb rep 1 and SLICE c1 rep 2
cells). The hand check can only clear a candidate as F4; it never clears a call the automatic classes left.
"""
import argparse
import copy
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ab_metrics  # noqa: E402
import run_ab  # noqa: E402
import svs2_report  # noqa: E402

GATES_DEFAULT = os.path.join(HERE, "gates-orient.json")
SESSION_TMP = "/private/tmp/claude-501"
EMPTY_MIN_CHARS = 3
TMP_WALKERS = {"ls", "find", "du", "tree", "rg", "grep", "egrep", "fgrep", "stat", "mdfind", "locate"}
TRAIL = ")]}\"',:;"
QUOTED_HEREDOC = re.compile(r"<<-?\s*(['\"])(\w+)\1[^\n]*\n(.*?)(?:\n\2(?=\s|$)|\Z)", re.S)
SINGLE_QUOTED = re.compile(r"'[^']*'")


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


# ---------------------------------------------------------------------------- import of B

def import_b(gates, out):
    cb = gates["cross_batch"]["b"]
    g = copy.deepcopy(gates)
    g["pairing"] = dict(gates["pairing"], baseline_archive=cb["archive"], baseline_old_root=cb["old_root"], baseline_cells=cb["cells"])
    g["baseline_arms"] = ["b"]
    return svs2_report.import_baseline(g, out)


# ---------------------------------------------------------------------------- session-log helpers

def cell_log(c):
    log = c.get("log")
    if log and os.path.exists(log):
        return log
    src = ((c.get("_baseline") or {}).get("log"))
    return src if src and os.path.exists(src) else None


def calls_of(events):
    calls, order = {}, []
    for e in events:
        if e.get("type") != "tool/call":
            continue
        d = e.get("data") or {}
        try:
            args = json.loads(d.get("arguments") or "{}")
            if not isinstance(args, dict):
                args = {"_value": args}
        except ValueError:
            args = {"_unparsed": d.get("arguments")}
        cid = d.get("callId")
        calls[cid] = {"seq": e.get("seq"), "turn": d.get("turn"), "step": d.get("step"), "name": d.get("name"), "args": args, "raw": d.get("arguments") or ""}
        order.append(cid)
    order.sort(key=lambda c: calls[c]["seq"] if calls[c]["seq"] is not None else -1)
    return calls, order


def session_cwd(events):
    s = next((e for e in events if e.get("type") == "session"), {}) or {}
    return s.get("cwd") or (s.get("data") or {}).get("cwd")


# ---------------------------------------------------------------------------- flagged calls

def tmp_walk(call):
    """True when the call lists or searches a /tmp directory (as opposed to naming one scratch file there)."""
    name, a = call["name"], call["args"]
    if name in ("glob", "grep"):
        for key in ("path", "pattern"):
            v = a.get(key)
            if isinstance(v, str) and ab_metrics.is_under(ab_metrics.canon_path(v.strip() or "."), "/private/tmp") and os.path.isabs(v.strip()):
                return True
        return False
    if name != "bash":
        return False
    for seg in ab_metrics.split_segments(str(a.get("command", ""))):
        for piece in ab_metrics.split_pipes(seg):
            toks = ab_metrics.tokens(piece)
            while toks and re.match(r"^[A-Za-z_]\w*=", toks[0]):
                toks = toks[1:]
            if not toks or os.path.basename(toks[0]) not in TMP_WALKERS:
                continue
            for t in toks[1:]:
                if t.startswith("-") or not t.startswith("/"):
                    continue
                p = ab_metrics.canon_path(t.split("*", 1)[0].rstrip("/") or "/")
                if ab_metrics.is_under(p, "/private/tmp") and (p == "/private/tmp" or os.path.isdir(p) or "*" in t):
                    return True
    return False


def data_hint(call, needle):
    """Reported with a candidate only: whether the flagged text occurs only inside a quoted heredoc body or a
    single-quoted string (where the shell neither expands nor resolves it). The hand check decides."""
    if call["name"] != "bash":
        return None
    cmd = str(call["args"].get("command", ""))
    if needle not in cmd:
        return None
    rest = SINGLE_QUOTED.sub("''", QUOTED_HEREDOC.sub("", cmd))
    return "only inside a quoted heredoc or single-quoted string" if needle not in rest else None


def classify_reason(reason, call, workdir):
    wd = ab_metrics.canon_path(workdir)
    croot = os.path.dirname(wd)
    if reason.startswith("outside: / ("):
        return "candidate", "whole-disk walk"
    m = re.match(r"(?:outside|bash workdir outside): (.*)$", reason, re.S)
    if m:
        p = m.group(1)
        if ab_metrics.is_under(p.rstrip(TRAIL), wd):
            return "F2", "own workdir"
        if f"/{os.path.basename(croot)}/{os.path.basename(wd)}" in p:
            return "F2", "own workdir, mistyped absolute path"
        if ab_metrics.is_under(p, croot + "/tmp"):
            return "F3", "the cell's TMPDIR"
        if ab_metrics.is_under(p, "/private/tmp") and not ab_metrics.is_under(p, SESSION_TMP):
            if tmp_walk(call):
                return "candidate", "lists or searches /tmp"
            return "F3", "scratch file in /tmp" if p != "/private/tmp" else "cd /tmp"
        first = p.split("/")[1] if p.startswith("/") and len(p) > 1 else ""
        if first == "" or not os.path.lexists("/" + first):
            return "F1", "no such top-level path (operator or unexpanded text)"
        return "candidate", "a real path outside the workdir"
    if reason == "home or temp directory" and call["name"] == "bash":
        cmd = str(call["args"].get("command", ""))
        found = [x.group(0) for x in ab_metrics.HOME_RE.finditer(cmd)]
        if found and all("TMPDIR" in x for x in found):
            return "F3", "the cell's TMPDIR"
        return "candidate", "home directory form"
    return "candidate", reason.split(":")[0]


def classify_call(call, reasons, workdir):
    per = [(r,) + classify_reason(r, call, workdir) for r in reasons]
    auto = "candidate" if any(k == "candidate" for _, k, _ in per) else "+".join(sorted({k for _, k, _ in per}))
    hints = []
    if auto == "candidate":
        for r, k, _ in per:
            if k != "candidate":
                continue
            m = re.match(r"(?:outside|bash workdir outside): (.*)$", r, re.S)
            needle = None
            if m and call["name"] == "bash":
                cmd = str(call["args"].get("command", ""))
                needle = ".." if ".." in cmd else m.group(1)
            elif r == "home or temp directory":
                needle = "~"
            h = data_hint(call, needle) if needle else None
            if h:
                hints.append(f"{needle!r}: {h}")
    return {"class": auto, "reasons": [{"reason": r, "class": k, "why": w} for r, k, w in per], "hints": hints}


def flagged_calls(c):
    """Every flagged call of a cell with its full command (or arguments) and its class."""
    log = cell_log(c)
    if not log:
        return None
    events, _ = ab_metrics.load_events(log)
    calls, order = calls_of(events)
    cwd = session_cwd(events) or c.get("workdir")
    out = []
    for cid in order:
        f = ab_metrics.access_flags({cid: calls[cid]}, [cid], cwd)
        if not f:
            continue
        call = calls[cid]
        full = str(call["args"].get("command", "")) if call["name"] == "bash" else call["raw"]
        k = classify_call(call, f[0]["reasons"], cwd)
        out.append({"turn": call["turn"], "step": call["step"], "tool": call["name"], "command": full, "secret": f[0]["secret"]} | k)
    return out


# ---------------------------------------------------------------------------- empty turns

def empty_turns(events):
    """Turns whose last committed assistant message has no tool call and fewer than EMPTY_MIN_CHARS non-whitespace
    visible characters, and turns that started but committed no assistant message. Returns [(turn, kind, detail)]."""
    last, started = {}, set()
    for e in events:
        t, d = e.get("type"), e.get("data") or {}
        if t == "turn/start":
            started.add(d.get("turn"))
        if t != "assistant/message":
            continue
        msg = d.get("message") or {}
        content = msg.get("content") or []
        tool = any(isinstance(b, dict) and b.get("type") == "tool-call" for b in content)
        reasoning = sum(len(b.get("text", "") or "") for b in content if isinstance(b, dict) and b.get("type") in ("reasoning", "thinking"))
        last[d.get("turn")] = {"tool": tool, "chars": len("".join(ab_metrics.text_of(msg).split())), "step": d.get("step"), "reasoning_chars": reasoning}
    out = []
    for t, la in sorted(last.items(), key=lambda kv: (kv[0] is None, kv[0])):
        if t is None:
            continue
        if not la["tool"] and la["chars"] < EMPTY_MIN_CHARS:
            out.append({"turn": t, "kind": "empty reply", "visible_chars": la["chars"], "steps": la["step"], "reasoning_chars": la["reasoning_chars"]})
    for t in sorted(x for x in started - set(last) if x is not None):
        out.append({"turn": t, "kind": "no committed reply", "visible_chars": 0, "steps": 0, "reasoning_chars": 0})
    return out


def cell_empty_turns(c):
    log = cell_log(c)
    if not log:
        return None
    return empty_turns(ab_metrics.load_events(log)[0])


# ---------------------------------------------------------------------------- the report

def all_cells(d):
    """Every cell record of a batch dir, every attempt (index.jsonl order is not needed), stops left out."""
    cdir = os.path.join(d, "cells") if os.path.isdir(os.path.join(d, "cells")) else d
    out = []
    for path in sorted(glob.glob(os.path.join(cdir, "*.json"))):
        if path.endswith((".budget_stop.json", ".account_stop.json")):
            continue
        c = load(path)
        if "alias" in c and "arm" in c:
            c["_batch"] = os.path.basename(os.path.normpath(d))
            c["_path"] = path
            out.append(c)
    return out


def attempts_of(batch_dir, cell):
    """The earlier attempts of a cell that index.jsonl records (invalid attempts are kept there, not in cells/)."""
    idx = os.path.join(batch_dir, "index.jsonl")
    rows = []
    if os.path.exists(idx):
        with open(idx, encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    r = json.loads(line)
                    if r.get("cell") == cell:
                        rows.append(r)
    return rows


def ship(cmp_ds, cmp_bs, cmp_db, flags_real, empties, dec):
    s = dec["ship"]
    insufficient = (cmp_ds["insufficient"] or []) + [f"vs B: {x}" for x in (cmp_db["insufficient"] or [])]
    N_d, N_b, Rf = cmp_ds["N_code"], cmp_bs["N_code"], cmp_ds["R_f1"]
    ratio = svs2_report.rnd(N_d / N_b) if N_d and N_b else None
    s1 = ratio is not None and Rf is not None and ratio <= s["S1_cost"]["N_code_vs_B_max"] and Rf <= s["S1_cost"]["R_f1_max"]
    s2 = flags_real <= s["S2_probes"]["max"]
    s3 = empties <= s["S3_empty_turns"]["max"]
    s4 = svs2_report.quality(cmp_ds, dec)
    conds = {"S1_cost": {"holds": s1, "N_code_d": N_d, "N_code_b": N_b, "N_code_d_over_b": ratio, "R_f1_d": Rf,
                         "rule": f"N_code(d)/N_code(b) <= {s['S1_cost']['N_code_vs_B_max']} and R_f1(d) <= {s['S1_cost']['R_f1_max']}"},
             "S2_probes": {"holds": s2, "real_probes": flags_real}, "S3_empty_turns": {"holds": s3, "empty_turns": empties},
             "S4_quality": {"holds": s4, "dS": cmp_ds["dS"], "dS_t": cmp_ds["dS_t"], "dM": cmp_ds["memory"]["dM"], "dB": cmp_ds["memory"]["dB"]}}
    if insufficient:
        verdict = "inconclusive: do not ship (" + "; ".join(insufficient) + ")"
    else:
        verdict = "SHIP" if all(v["holds"] for v in conds.values()) else "do not ship (" + ", ".join(k for k, v in conds.items() if not v["holds"]) + " failed)"
    return {"verdict": verdict, "conditions": conds, "insufficient": insufficient}


def build(batch_dirs, baseline_dir, b_dir, gates, ledger=None, hand=None):
    new = svs2_report.merge(*[svs2_report.collect_dir(d) for d in batch_dirs])
    new = {k: v for k, v in new.items() if k[2] in gates["arms"]}
    base = {k: v for k, v in svs2_report.collect_dir(baseline_dir).items() if k[2] in gates["baseline_arms"]}
    bb = {k: v for k, v in svs2_report.collect_dir(b_dir).items() if k[2] == "b"}
    cells = svs2_report.merge(new, base, bb)
    dec = gates["decision"]
    cmp = {f"{x} vs {y}": svs2_report.compare(cells, gates, x, y) for x, y in
           (("d", "stock"), ("d", "b"), ("d", "slice"), ("b", "stock"), ("b", "slice"))}
    # flagged calls and empty turns: every attempt of every D cell (warmup included), plus the imported arms for reference
    hand = hand or {}
    d_cells = [c for d in batch_dirs for c in all_cells(d) if c["arm"] in gates["arms"]]
    flags, empties = [], []
    for c in d_cells:
        for f in flagged_calls(c) or []:
            key = f"{c['_batch']}/{c['cell']}.a{c.get('attempt')}/t{f['turn']}s{f['step']}"
            f = dict(f, cell=c["cell"], batch=c["_batch"], attempt=c.get("attempt"), valid=c.get("valid"), key=key)
            if f["class"] == "candidate":
                h = hand.get(key)
                f["final"] = ("F4 (hand check: " + h + ")") if h else "real probe"
            else:
                f["final"] = f["class"]
            flags.append(f)
        for e in cell_empty_turns(c) or []:
            empties.append(dict(e, cell=c["cell"], batch=c["_batch"], attempt=c.get("attempt"), valid=c.get("valid")))
    ref_empty = {}
    for (t, r, a), cs in sorted(svs2_report.merge(base, bb).items()):
        for c in cs:
            for e in cell_empty_turns(c) or []:
                ref_empty.setdefault(a, []).append(dict(e, cell=c["cell"]))
    real = sum(1 for f in flags if f["final"] == "real probe")
    verdict = ship(cmp["d vs stock"], cmp["b vs stock"], cmp["d vs b"], real, len(empties), dec)
    spend = None
    if ledger and os.path.exists(ledger):
        with open(ledger, encoding="utf-8") as fh:
            rows = [json.loads(line) for line in fh if line.strip()]
        by = {}
        for r in rows:
            by[r["batch"]] = round(by.get(r["batch"], 0) + r.get("usd", 0), 6)
        spend = {"total_usd_peak_sheet": round(sum(r.get("usd", 0) for r in rows), 6), "by_batch": by, "turns": len(rows),
                 "unpriced": sum(1 for r in rows if r.get("unpriced_steps"))}
    warm = []
    for (t, r, a), cs in sorted(new.items()):
        for c in cs:
            if t == "hello" and c.get("metrics"):
                hits = c["metrics"]["usage"]["first_request_hits"]
                need = (gates["structure"].get(a) or {}).get("warm_min_cache_read", 4000)
                warm.append({"batch": c["_batch"], "rep": r, "valid": c.get("valid"), "step1_cache_read": hits[0] if hits else None, "min": need,
                             "ok": r < 2 or bool(hits and hits[0] >= need)})
    invalid = [{"cell": c["cell"], "batch": c["_batch"], "attempt": c.get("attempt"), "infra": c.get("infra"), "reasons": c.get("invalid_reasons")}
               for c in d_cells if not c.get("valid")]
    per_cell = []
    for c in d_cells:
        if c["alias"] == "hello":
            continue
        m = c.get("metrics") or {}
        us = m.get("usage") or {}
        per_cell.append({"cell": c["cell"], "batch": c["_batch"], "attempt": c.get("attempt"), "valid": c.get("valid"), "pass": c.get("pass"),
                         "cost_peak": us.get("cost_peak"), "requests": us.get("requests"), "step_cap_cuts": (m.get("finish") or {}).get("step_limit_cut"),
                         "flag_count": c.get("flag_count"), "g2_excluded": c.get("g2_excluded"), "quarantined": c.get("quarantined"),
                         "wall_s": c.get("wall_s"), "rereads": m.get("rereads")})
    return {
        "batches": [os.path.realpath(b) for b in batch_dirs], "baseline": os.path.realpath(baseline_dir), "b_import": os.path.realpath(b_dir),
        "ship": verdict, "comparisons": cmp, "rereads": svs2_report.reread_table(cells), "describe": svs2_report.describe(cells),
        "flagged_calls": flags, "empty_turns": empties, "empty_turns_reference": ref_empty, "warmup": warm, "invalid_d_attempts": invalid,
        "d_cells": per_cell, "spend": spend,
        "caveat": "cross-batch: STOCK and SLICE ran on 2026-10-23, B on 2026-10-24/25, D on 2026-10-25; no concurrent control. "
                  "Provider-side variance between the days is not separable from an arm effect. n = 3-4 per task.",
    }


def fmt(x, nd=3):
    if x is None:
        return "-"
    return f"{x:.{nd}f}" if isinstance(x, float) else str(x)


def short(cmd, n=220):
    one = " ".join(str(cmd).split())
    return one if len(one) <= n else one[:n] + " …"


def render(s):
    v = s["ship"]
    L = ["# slice-orientation test: D against STOCK, B and SLICE", "",
         f"D cells: {', '.join(os.path.basename(b) for b in s['batches'])}; imported: STOCK and SLICE (2026-10-23), B (svs2 batch).", "",
         f"Caveat: {s['caveat']}", ""]
    if s["spend"]:
        L.append(f"Spend (peak sheet): ${s['spend']['total_usd_peak_sheet']:.4f} over {s['spend']['turns']} turns; by batch {s['spend']['by_batch']}.")
    L += ["", f"## Verdict: **{v['verdict']}**", "", "| condition | holds | value |", "|---|---|---|"]
    c = v["conditions"]
    L.append(f"| S1 cost | {c['S1_cost']['holds']} | N_code(d) {fmt(c['S1_cost']['N_code_d'])} / N_code(b) {fmt(c['S1_cost']['N_code_b'])} = "
             f"{fmt(c['S1_cost']['N_code_d_over_b'])} (<= 1.05); R_f1(d) {fmt(c['S1_cost']['R_f1_d'])} (<= 0.70) |")
    L.append(f"| S2 probes | {c['S2_probes']['holds']} | {c['S2_probes']['real_probes']} real out-of-workspace probes (max 0) |")
    L.append(f"| S3 empty turns | {c['S3_empty_turns']['holds']} | {c['S3_empty_turns']['empty_turns']} (max 0) |")
    L.append(f"| S4 quality floor | {c['S4_quality']['holds']} | dS {c['S4_quality']['dS']}, dS_t {c['S4_quality']['dS_t']}, dM {c['S4_quality']['dM']}, dB {c['S4_quality']['dB']} |")
    for k, cm in s["comparisons"].items():
        m = cm["memory"]
        L += ["", f"## {k}", "",
              f"Pairs {cm['pairs']}; N_code {fmt(cm['N_code'])}, R_f1 {fmt(cm['R_f1'])}, N_code3 {fmt(cm['N_code3'])}; dS {cm['dS']}; memory "
              f"{m['correct_arm']} vs {m['correct_base']} of {m['items']} items (dM {m['dM']}), bad {m['bad_arm']} vs {m['bad_base']} (dB {m['dB']})."
              + (f" Insufficient: {'; '.join(cm['insufficient'])}." if cm["insufficient"] else ""), "",
              "| task | pairs | R | median paired | paired ratios | pass arm/base | dS_t |", "|---|---|---|---|---|---|---|"]
        for t, tv in cm["tasks"].items():
            L.append(f"| {t} | {tv['pairs']} | {fmt(tv['R'])} | {fmt(tv['median_paired_ratio'])} | {tv['paired_ratios']} | {tv['pass_arm']}/{tv['pass_base']} | {tv['dS']} |")
        if cm["dropped_pairs"] or m["dropped"]:
            L += [""] + [f"- dropped: {x}" for x in cm["dropped_pairs"] + m["dropped"]]
    L += ["", "## Re-read classes (sums over valid cells)", "",
          "| arm | task | cells | turns | first | cross-turn | same-turn | after own edit | reads | edits/writes | bash writes | FS_NOT_OBSERVED | FS_STALE_VERSION |",
          "|" + "---|" * 13]
    for a in ("d", "b", "slice", "stock"):
        for t, r in sorted((s["rereads"].get(a) or {}).items()):
            L.append(f"| {a} | {t} | {r['cells']} | {r['turns']} | {r['first']} | {r['cross_turn']} | {r['same_turn']} | {r['after_own_edit']} | {r['reads']} | "
                     f"{r['edits_writes']} | {r['bash_writes']} | {r['fs_not_observed']} | {r['fs_stale_version']} |")
    L += ["", "## Cost structure (valid cells)", "",
          "| arm | task | cells | pass | mean $ peak | req/turn | step-cap cuts (of turns) | cache hit | peak / mean req tokens | memory correct/total (bad) | median wall s |",
          "|" + "---|" * 11]
    for a in ("d", "b", "slice", "stock"):
        for t, r in sorted((s["describe"].get(a) or {}).items()):
            L.append(f"| {a} | {t} | {r['cells']} | {r['pass']} | {fmt(r['mean_cost_peak'], 4)} | {fmt(r['median_requests_per_turn'])} | {r['step_limit_turns']} of {r['turns']} | "
                     f"{fmt(r['median_cache_hit_rate'])} | {fmt(r['median_peak_request_tokens'])} / {fmt(r['median_mean_request_tokens'], 0)} | "
                     f"{r['memory_correct']}/{r['memory_total']} ({r['memory_bad']}) | {fmt(r['median_wall_s'], 0)} |")
    L += ["", "## D cells", "", "| cell | batch | attempt | valid | pass | $ peak | requests | step-cap cuts | flagged | memory-excluded | quarantined | wall s |",
          "|" + "---|" * 12]
    for r in s["d_cells"]:
        L.append(f"| {r['cell']} | {r['batch']} | {r['attempt']} | {r['valid']} | {r['pass']} | {fmt(r['cost_peak'], 4)} | {r['requests']} | {r['step_cap_cuts']} | "
                 f"{r['flag_count']} | {r['g2_excluded']} | {len(r['quarantined'] or [])} | {fmt(r['wall_s'], 0)} |")
    L += ["", f"## Flagged calls of D ({len(s['flagged_calls'])}; real probes: {v['conditions']['S2_probes']['real_probes']})", ""]
    if s["flagged_calls"]:
        L += ["| cell | turn | tool | automatic class | final | why | command |", "|---|---|---|---|---|---|---|"]
        for f in s["flagged_calls"]:
            why = "; ".join(f"{x['class']}: {x['why']}" for x in f["reasons"]) + ("; hint " + "; ".join(f["hints"]) if f["hints"] else "")
            L.append(f"| {f['cell']} a{f['attempt']} | {f['turn']} | {f['tool']} | {f['class']} | {f['final']} | {why} | `{short(f['command']).replace('|', '¦').replace('`', '´')}` |")
    else:
        L.append("None.")
    L += ["", f"## Empty turns of D ({len(s['empty_turns'])})", ""]
    L += [f"- {e['cell']} ({e['batch']}, attempt {e['attempt']}) turn {e['turn']}: {e['kind']}, {e['visible_chars']} visible characters, step {e['steps']}"
          for e in s["empty_turns"]] or ["None."]
    L += ["", "Reference (imported cells): " + (", ".join(f"{a}: " + "; ".join(f"{e['cell']} t{e['turn']} ({e['kind']})" for e in es)
                                                   for a, es in sorted(s["empty_turns_reference"].items())) or "none")]
    if s["invalid_d_attempts"]:
        L += ["", "## Invalid D attempts (not counted)", ""] + [f"- {c['cell']} ({c['batch']}, attempt {c['attempt']}), infra {c['infra']}: "
                                                                 f"{'; '.join(c['reasons'] or [])[:300]}" for c in s["invalid_d_attempts"]]
    if s["warmup"]:
        L += ["", "## Warmup (hello): step-1 cache read", ""] + [f"- rep {w['rep']} ({w['batch']}): {w['step1_cache_read']} (min {w['min']} from rep 2), "
                                                                 f"{'ok' if w['ok'] else 'LOW'}, valid {w['valid']}" for w in s["warmup"]]
    L += ["", "Ratios are the named arm over the other, on the off-peak sheet (peak is exactly 2x). The arm side of a pair is the mean of its valid "
          "cells at that rep index (one each here)."]
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------------------- calibration on archived cells

def calibrate(gates):
    roots = [(os.path.expanduser(gates["cross_batch"]["b"]["archive"]), gates["cross_batch"]["b"]["old_root"], ("batch", "arb", "pilot")),
             (os.path.expanduser(gates["pairing"]["baseline_archive"]), gates["pairing"]["baseline_old_root"], ("batch", "arb"))]
    out = {"candidates": [], "auto": {}, "empty_turns": [], "cells": 0}
    for archive, old, batches in roots:
        archive = os.path.realpath(archive)
        for b in batches:
            for c in all_cells(os.path.join(archive, b)):
                if c["alias"] not in ("c1", "c2", "r2", "f1"):
                    continue
                c["log"] = svs2_report.rebase(c.get("log"), old, archive)
                out["cells"] += 1
                for f in flagged_calls(c) or []:
                    out["auto"][f["class"]] = out["auto"].get(f["class"], 0) + 1
                    if f["class"] == "candidate":
                        out["candidates"].append({"cell": f"{b}/{c['cell']}", "turn": f["turn"], "tool": f["tool"], "command": short(f["command"], 160),
                                                  "why": [x["why"] for x in f["reasons"] if x["class"] == "candidate"], "hints": f["hints"]})
                for e in cell_empty_turns(c) or []:
                    out["empty_turns"].append(dict(e, cell=f"{b}/{c['cell']}"))
    return out


def main(argv):
    sub = argv[0] if argv and argv[0] in ("import-b", "report", "calibrate") else "report"
    rest = argv[1:] if argv and argv[0] in ("import-b", "report", "calibrate") else argv
    ap = argparse.ArgumentParser(prog="orient_report.py " + sub, description=__doc__.split("\n\n")[0])
    ap.add_argument("--gates", default=GATES_DEFAULT)
    if sub == "import-b":
        ap.add_argument("--out", required=True)
        a = ap.parse_args(rest)
        rep = import_b(load(a.gates), a.out)
        print(json.dumps({k: rep[k] for k in ("archive", "ok", "mismatches")} | {"cells": len(rep["cells"]), "rereads": rep["rereads"]}, indent=1))
        return 0 if rep["ok"] else 1
    if sub == "calibrate":
        a = ap.parse_args(rest)
        print(json.dumps(calibrate(load(a.gates)), indent=1, ensure_ascii=False))
        return 0
    ap.add_argument("dirs", nargs="+", help="the D batch dir first, then any other D dirs (warmup)")
    ap.add_argument("--baseline", required=True)
    ap.add_argument("--b", required=True, help="the import-b output directory")
    ap.add_argument("--ledger")
    ap.add_argument("--hand", help="JSON {flag key: reason} of candidates cleared as F4 by the hand check")
    ap.add_argument("--out")
    a = ap.parse_args(rest)
    s = build(a.dirs, a.baseline, a.b, load(a.gates), a.ledger, load(a.hand) if a.hand else None)
    s["gates_file"] = os.path.realpath(a.gates)
    s["harness_commit"] = run_ab.git_head()
    out = a.out or a.dirs[0]
    os.makedirs(out, exist_ok=True)
    run_ab.write_json(os.path.join(out, "summary.json"), s)
    text = render(s)
    with open(os.path.join(out, "summary.md"), "w", encoding="utf-8") as fh:
        fh.write(text)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
