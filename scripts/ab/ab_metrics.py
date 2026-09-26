#!/usr/bin/env python3
"""ab_metrics.py: one metrics row per DSH 0.1.7 session log (P1-10 native A/B).

usage:
  ab_metrics.py <session.v4.jsonl.zstd | session.jsonl> [--workdir DIR]
                [--exam TURN:TOKEN[,TOKEN...]]... [--in-turn TURN:TOKEN[,TOKEN...]]...
                [--prices prices.json] [--pretty]

Prints one JSON object. Library use: `metrics(load_events(path), ...)`.
`.zstd` input needs system python3 with zstandard; `.jsonl` is read as is.

Metric definitions are in docs/p110-native-ab.md ("Metrics"). In short:
- usage: miss = inputTokens, hit = cacheReadTokens, out = outputTokens of every
  assistant/message (they add up to totalTokens);
- reads: `read` calls and single-file bash reads, per turn, with same-turn
  re-reads split into "unchanged" and "after the model's own edit";
- recall: calls and errors per recall tool, formatVersion rejections, the
  shape of every expand_result call and where its locator came from;
- validity: system prompt and slice tool fingerprints, tool count, host paths
  in the system prompt, compaction events, tape header and tool-line forms;
- exams: whether an oracle token reached the model through a recall tool in
  the exam turn, and whether it leaked into assistant text or tool input
  earlier.
"""
import hashlib
import json
import os
import re
import shlex
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RECALL_TOOLS = ("recall_turn", "recall_search", "recall_step", "expand_result")
LOCATOR_TOOLS = ("recall_turn", "recall_search", "recall_step")
TAPE_KIND = "plugin:slice:history"
FV_REJECT = "requires formatVersion"
# Bash access to the durable log, the oracle sidecar or the harness itself.
FLAG_PATTERNS = ("sessions/", ".zstd", ".truth", "session.v4", "/home-control", "/home-arm", "wt-harness", "scripts/ab/", "/p110ab/")
READ_COMMANDS = {"cat", "head", "tail", "nl", "less", "more", "sed"}
MUTATING_WRITE_TOOLS = ("write", "edit", "multiedit", "apply_patch")
BIG = 10 ** 9


def load_events(path):
    """Parse a session log (.zstd or plain JSONL). Returns (events, bad_line_count)."""
    if path.endswith(".zstd"):
        import zstandard
        with open(path, "rb") as fh:
            raw = zstandard.ZstdDecompressor().stream_reader(fh).read().decode("utf-8", "replace")
    else:
        with open(path, encoding="utf-8", errors="replace") as fh:
            raw = fh.read()
    events, bad = [], 0
    for line in raw.splitlines():
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except ValueError:
            bad += 1
    return events, bad


def text_of(message):
    return "".join(b.get("text", "") for b in (message or {}).get("content", []) or [] if isinstance(b, dict) and b.get("type") == "text")


def op_of(event):
    so = event.get("surfaceOp")
    if isinstance(so, str):
        return so
    return (so or {}).get("op", "append") if isinstance(so, dict) else "append"


def canon(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def as_int(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def seq_pattern(seq):
    # "seq 16", "seq=16", "\"seq\":16", "\"seq\": 16"; not "seq-16" (reply locators) or "seq 161".
    return re.compile(r'(?<![\w-])seq"?\s*[:=]?\s*%d(?!\d)' % seq)


def tsc_pattern(turn, step):
    return re.compile(r'(?<![\w-])turn"?\s*[:=]?\s*"?%d"?\D{1,16}?step"?\s*[:=]?\s*"?%d(?!\d)' % (turn, step))


def norm_path(path, cwd):
    if not isinstance(path, str) or not path.strip():
        return None
    path = path.strip()
    if path.startswith("~"):
        path = os.path.expanduser(path)
    if not os.path.isabs(path):
        path = os.path.join(cwd or "/", path)
    return os.path.normpath(path)


def split_segments(command):
    """Split a shell command on ;, &&, || and newlines (not inside quotes); pipes stay inside a segment."""
    segments, buf, quote, i = [], [], None, 0
    while i < len(command):
        ch = command[i]
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = None
            elif ch == "\\" and quote == '"' and i + 1 < len(command):
                buf.append(command[i + 1])
                i += 1
        elif ch in "'\"":
            quote = ch
            buf.append(ch)
        elif ch in ";\n" or command.startswith("&&", i) or command.startswith("||", i):
            segments.append("".join(buf))
            buf = []
            if command.startswith("&&", i) or command.startswith("||", i):
                i += 1
        else:
            buf.append(ch)
        i += 1
    segments.append("".join(buf))
    return [s.strip() for s in segments if s.strip()]


def tokens(segment):
    try:
        return shlex.split(segment, posix=True)
    except ValueError:
        return segment.split()


def bash_read_target(command):
    """Path read by a pure single-file read command (cat/head/tail/nl/less/more/sed -n), else None.

    A leading `cd DIR &&` is allowed; the path is then returned relative to DIR."""
    segs = split_segments(command)
    base = None
    if len(segs) == 2 and tokens(segs[0])[:1] == ["cd"] and len(tokens(segs[0])) == 2:
        base = tokens(segs[0])[1]
        segs = segs[1:]
    if len(segs) != 1 or re.search(r"(?<![0-9&])>", segs[0]):
        return None
    first = segs[0].split("|", 1)[0]
    toks = tokens(first)
    if not toks or toks[0] not in READ_COMMANDS:
        return None
    cmd, args = toks[0], toks[1:]
    if cmd == "sed":
        if "-n" not in args or any(a == "-i" or a.startswith("-i") for a in args):
            return None
        rest = [a for a in args if not a.startswith("-")]
        operands = rest[1:]  # first non-flag is the sed script
    else:
        operands, skip = [], False
        for a in args:
            if skip:
                skip = False
                continue
            if cmd in ("head", "tail") and a in ("-n", "-c"):
                skip = True
                continue
            if a.startswith("-"):
                continue
            operands.append(a)
    if len(operands) != 1:
        return None
    return operands[0] if base is None or os.path.isabs(operands[0]) else os.path.join(base, operands[0])


def bash_mutations(command):
    """Paths a bash command writes, moves or deletes (best effort, never raises)."""
    out = []
    for target in re.findall(r"(?<![0-9&<>])>>?\s*([^\s;&|<>]+)", command):
        if target not in ("/dev/null",) and not target.startswith("&"):
            out.append(target)
    for seg in split_segments(command):
        for piece in seg.split("|"):
            toks = tokens(piece)
            if not toks:
                continue
            cmd, args = os.path.basename(toks[0]), toks[1:]
            operands = [a for a in args if not a.startswith("-")]
            if cmd in ("rm", "rmdir", "touch", "tee", "truncate", "unlink"):
                out.extend(operands)
            elif cmd == "mv":
                out.extend(operands)
            elif cmd == "cp" and operands:
                out.append(operands[-1])
            elif cmd == "sed" and any(a == "-i" or (a.startswith("-i") and len(a) > 2) or a == "--in-place" for a in args):
                out.extend(operands[1:])
            elif cmd == "perl" and any(a.startswith("-i") or a.startswith("-pi") for a in args):
                out.extend(operands[1:])
    return out


def metrics(events, workdir=None, exams=(), in_turn=(), prices=None, bad_lines=0):
    prices = prices or load_prices()
    session = next((e for e in events if e.get("type") == "session"), {}) or {}
    cwd = workdir or session.get("cwd") or (session.get("data") or {}).get("cwd")
    row = {"session_id": session.get("id"), "cwd": cwd, "format_version": session.get("version"), "events": len(events), "bad_lines": bad_lines}

    # ------------------------------------------------------------ index
    calls, call_order, results, results_by_seq, step_results = {}, [], {}, {}, {}
    replacements, tape = [], []
    for e in events:
        t, d = e.get("type"), e.get("data") or {}
        if t == "tool/call":
            try:
                args = json.loads(d.get("arguments") or "{}")
                if not isinstance(args, dict):
                    args = {"_value": args}
            except ValueError:
                args = {"_unparsed": d.get("arguments")}
            cid = d.get("callId")
            calls[cid] = {"seq": e.get("seq"), "turn": d.get("turn"), "step": d.get("step"), "name": d.get("name"), "args": args, "raw": d.get("arguments") or ""}
            call_order.append(cid)
        elif t == "tool/result":
            m = d.get("message") or {}
            if op_of(e) == "append":
                r = {"seq": e.get("seq"), "turn": d.get("turn"), "step": d.get("step"), "error": m.get("isError") is True, "text": text_of(m), "call": m.get("toolCallId")}
                results[m.get("toolCallId")] = r
                results_by_seq[e.get("seq")] = r
                step_results.setdefault((d.get("turn"), d.get("step")), []).append(r)
            else:
                src = (e.get("sourceEventSeqs") or [None])[0]
                replacements.append({"seq": e.get("seq"), "turn": d.get("turn"), "step": d.get("step"), "source": src, "text": text_of(m)})
        elif t == "user/message" and ((d.get("source") or {}).get("kind") == TAPE_KIND):
            tape.append({"seq": e.get("seq"), "text": text_of(d)})
    call_order.sort(key=lambda c: calls[c]["seq"] if calls[c]["seq"] is not None else -1)

    # ------------------------------------------------------------ validity / prefix
    systems = [text_of((e.get("data") or {}).get("message")) for e in events if e.get("type") == "system/message"]
    headers = [((e.get("data") or {}).get("header") or {}) for e in events if e.get("type") == "request/header"]
    tools = headers[0].get("tools", []) if headers else []
    slice_tools = [tl for tl in tools if tl.get("name") in RECALL_TOOLS]
    system = systems[0] if systems else ""
    row["validity"] = {
        "system_sha": sha(system) if systems else None,
        "system_distinct": len(set(systems)),
        "slice_tools_sha": sha(canon(slice_tools)) if headers else None,
        "tools_sha": sha(canon(tools)) if headers else None,
        "tool_lists_distinct": len({canon(h.get("tools", [])) for h in headers}),
        "tools_count": len(tools),
        "tool_names": sorted(tl.get("name") for tl in tools),
        "system_has_host_path": any(("/private" in s or "/Users" in s) for s in systems),
        "compaction_events": sum(1 for e in events if "compact" in str(e.get("type", ""))),
        "provider": ((headers[0].get("config") or {}).get("provider") if headers else None),
        "model": ((headers[0].get("config") or {}).get("model") if headers else None),
    }
    row["prefix"] = {
        "system_chars": len(system),
        "tools_json_chars": len(canon(tools)),
        "slice_tools_json_chars": len(canon(slice_tools)),
        "prefix_chars": len(system) + len(canon(tools)),
    }

    # ------------------------------------------------------------ usage
    usage = {"requests": 0, "miss": 0, "hit": 0, "out": 0, "cache_write": 0, "turn_first_miss": 0, "later_step_miss": 0}
    per_turn = {}
    last_assistant = {}
    first_hit = []
    for e in events:
        if e.get("type") != "assistant/message":
            continue
        d = e.get("data") or {}
        u = d.get("usage") or {}
        miss, hit, out, cw = (u.get("inputTokens") or 0), (u.get("cacheReadTokens") or 0), (u.get("outputTokens") or 0), (u.get("cacheWriteTokens") or 0)
        usage["requests"] += 1
        usage["miss"] += miss
        usage["hit"] += hit
        usage["out"] += out
        usage["cache_write"] += cw
        if d.get("step") == 1:
            usage["turn_first_miss"] += miss
            first_hit.append(hit)
        else:
            usage["later_step_miss"] += miss
        pt = per_turn.setdefault(d.get("turn"), {"requests": 0, "miss": 0, "hit": 0, "out": 0, "max_step": 0})
        pt["requests"] += 1
        pt["miss"] += miss
        pt["hit"] += hit
        pt["out"] += out
        pt["max_step"] = max(pt["max_step"], d.get("step") or 0)
        content = (d.get("message") or {}).get("content", []) or []
        last_assistant[d.get("turn")] = {"tool": any(isinstance(b, dict) and b.get("type") == "tool-call" for b in content), "text": bool(text_of(d.get("message")).strip())}
    for sheet in ("offpeak", "peak"):
        p = prices[sheet]
        usage["cost_" + sheet] = round(((usage["miss"] + usage["cache_write"]) * p["miss"] + usage["hit"] * p["hit"] + usage["out"] * p["out"]) / 1e6, 6)
    usage["first_request_hits"] = first_hit
    row["usage"] = usage

    # ------------------------------------------------------------ finish
    turn_end = {}
    for e in events:
        if e.get("type") == "turn/end":
            d = e.get("data") or {}
            turn_end[d.get("turn")] = ((d.get("reason") or {}).get("kind"))
    kinds = {}
    for k in turn_end.values():
        kinds[k] = kinds.get(k, 0) + 1
    row["finish"] = {
        "turns": len(turn_end),
        "reasons": kinds,
        "completed": sum(1 for k in turn_end.values() if k == "completed"),
        "closeout": sum(1 for t, la in last_assistant.items() if la["text"] and not la["tool"] and turn_end.get(t) == "completed"),
        # maxStepsPerTurn refusing a step ends the turn with reason kind "blocked" (DSH 0.1.7-rc.2).
        "step_limit_cut": sum(1 for k in turn_end.values() if k == "blocked"),
        # A turn cannot end right after tool calls unless the step was refused or aborted.
        "cut_after_tool_call": sum(1 for t, la in last_assistant.items() if la["tool"] and t in turn_end),
    }
    for t, pt in per_turn.items():
        pt["reason"] = turn_end.get(t)
        la = last_assistant.get(t) or {}
        pt["closeout"] = bool(la.get("text") and not la.get("tool") and turn_end.get(t) == "completed")

    # ------------------------------------------------------------ recall tools
    rec = {n: {"calls": 0, "errors": 0, "recovered": 0} for n in RECALL_TOOLS}
    shapes = {}
    provenance = {"recall_output": 0, "fold_view": 0, "tape": 0, "none": 0}
    expand_partial = {"grep": 0, "lines": 0, "full": 0}
    turn_views = {"dialogue": 0, "full": 0, "dialogue_chars": 0, "full_chars": 0}
    fv = {"rejections": 0, "recovered": 0, "by_version": {}}
    cross = {"calls": 0, "targets": 0, "first_try_ok": 0}
    extra_hops = recall_sourced_locators = 0
    targets = {}  # cid -> target key
    group_first = {}

    def resolve_target(c):
        a = c["args"]
        if c["name"] == "expand_result":
            s = as_int(a.get("seq"))
            if s is not None:
                return ("seq", s)
            t, st, k = as_int(a.get("turn")), as_int(a.get("step")), as_int(a.get("call")) or 1
            if t is not None and st is not None:
                rs = sorted(step_results.get((t, st), []), key=lambda r: r["seq"])
                return ("seq", rs[k - 1]["seq"]) if 0 < k <= len(rs) else ("tsc", t, st, k)
            return None
        if c["name"] == "recall_step":
            t, st = as_int(a.get("turn")), as_int(a.get("step"))
            return ("step", t, st) if t is not None and st is not None else None
        if c["name"] == "recall_turn":
            t = as_int(a.get("turn"))
            return ("turn", t) if t is not None else None
        return ("search",)

    for cid in call_order:
        c = calls[cid]
        if c["name"] not in RECALL_TOOLS:
            continue
        r = results.get(cid) or {}
        rec[c["name"]]["calls"] += 1
        if r.get("error"):
            rec[c["name"]]["errors"] += 1
        targets[cid] = resolve_target(c)
        if c["name"] == "recall_turn":
            view = "full" if c["args"].get("view") == "full" else "dialogue"
            turn_views[view] += 1
            turn_views[view + "_chars"] += len(r.get("text", ""))
        if c["name"] != "expand_result":
            continue
        a = c["args"]
        s = as_int(a.get("seq"))
        if s is not None:
            v = a.get("formatVersion")
            shape = "seq+fv4" if as_int(v) == 4 else ("seq" if v is None else "seq+fv_other")
        elif as_int(a.get("turn")) is not None and as_int(a.get("step")) is not None:
            shape = "turn/step/call"
        else:
            shape = "malformed"
        shapes[shape] = shapes.get(shape, 0) + 1
        expand_partial["grep" if a.get("grep") else "lines" if a.get("lines") else "full"] += 1
        if r.get("error") and FV_REJECT in r.get("text", ""):
            fv["rejections"] += 1
            key = str(a.get("formatVersion"))
            fv["by_version"][key] = fv["by_version"].get(key, 0) + 1
        # locator provenance (first match wins) for seq and turn/step forms
        tgt = targets[cid]
        if s is not None:
            pat = seq_pattern(s)
        elif shape == "turn/step/call":
            pat = tsc_pattern(as_int(a.get("turn")), as_int(a.get("step")))
        else:
            pat = None
        src, src_tool = "none", None
        if pat is not None:
            for o in call_order:
                oc = calls[o]
                if oc["seq"] is None or oc["seq"] >= c["seq"]:
                    break
                ores = results.get(o) or {}
                if oc["name"] in LOCATOR_TOOLS and oc["turn"] == c["turn"] and ores.get("seq") is not None and ores["seq"] < c["seq"] and pat.search(ores.get("text", "")):
                    src, src_tool = "recall_output", oc["name"]
            if src == "none" and any(rp["seq"] < c["seq"] and rp["turn"] == c["turn"] and pat.search(rp["text"].split("\n", 1)[0]) for rp in replacements):
                src = "fold_view"
            on_tape = any(tp["seq"] < c["seq"] and pat.search(tp["text"]) for tp in tape)
            if src == "none" and on_tape:
                src = "tape"
            if src == "recall_output":
                recall_sourced_locators += 1
                if on_tape and src_tool in ("recall_turn", "recall_search"):
                    extra_hops += 1
        provenance[src] += 1
        if tgt and tgt[0] == "seq":
            tres = results_by_seq.get(tgt[1])
            if tres and tres.get("turn") is not None and c["turn"] is not None and tres["turn"] < c["turn"]:
                cross["calls"] += 1
                gkey = (c["turn"], tgt[1])
                if gkey not in group_first:
                    group_first[gkey] = not r.get("error")
    cross["targets"] = len(group_first)
    cross["first_try_ok"] = sum(1 for ok in group_first.values() if ok)

    # error recovery: a later successful call in the same turn on the same target
    for i, cid in enumerate(call_order):
        c = calls[cid]
        if c["name"] not in RECALL_TOOLS or not (results.get(cid) or {}).get("error"):
            continue
        tgt = targets.get(cid)
        rejected = c["name"] == "expand_result" and FV_REJECT in (results.get(cid) or {}).get("text", "")
        ok = False
        for later in call_order[i + 1:]:
            lc = calls[later]
            if lc["turn"] != c["turn"] or lc["name"] not in RECALL_TOOLS or (results.get(later) or {}).get("error"):
                continue
            ltgt = targets.get(later)
            if lc["name"] == c["name"] and ltgt == tgt:
                ok = True
            elif c["name"] == "expand_result" and lc["name"] == "recall_step" and tgt and tgt[0] == "seq" and ltgt:
                tres = results_by_seq.get(tgt[1]) or {}
                ok = ltgt == ("step", tres.get("turn"), tres.get("step"))
            if ok:
                break
        if ok:
            rec[c["name"]]["recovered"] += 1
            if rejected:
                fv["recovered"] += 1
    row["recall"] = {
        "tools": rec,
        "errors": sum(v["errors"] for v in rec.values()),
        "errors_recovered": sum(v["recovered"] for v in rec.values()),
        "fv_rejections": fv["rejections"],
        "fv_rejections_recovered": fv["recovered"],
        "fv_rejections_by_version": fv["by_version"],
        "expand_shapes": shapes,
        "expand_partial": expand_partial,
        "expand_locator_source": provenance,
        "expand_cross_turn": cross,
        "recall_turn_views": turn_views,
        "recall_sourced_locators": recall_sourced_locators,
        "extra_hops": extra_hops,
    }

    # ------------------------------------------------------------ reads
    reads = bash_reads = rr_unchanged = rr_after_edit = rr_cross = fold_then_reread = 0
    seen = {}         # turn -> path -> [ranges since the last mutation]
    pending = {}      # turn -> paths mutated and not read since
    seen_ever = {}    # path -> set(turns)
    read_calls = {}   # turn -> path -> [call seqs]
    folded_sources = {rp["source"]: rp["seq"] for rp in replacements if rp.get("source") is not None}

    def mutate(turn, path):
        if not path:
            return
        tseen = seen.setdefault(turn, {})
        for key in [k for k in tseen if k == path or k.startswith(path.rstrip("/") + "/")]:
            tseen.pop(key, None)
        pending.setdefault(turn, set()).add(path)

    for cid in call_order:
        c = calls[cid]
        t, a, name = c["turn"], c["args"], c["name"]
        key, rng = None, (1, BIG)
        if name == "read":
            key = norm_path(a.get("file_path") or a.get("path"), cwd)
            off = as_int(a.get("offset")) or 1
            lim = as_int(a.get("limit"))
            rng = (off, off + lim - 1 if lim else BIG)
        elif name == "bash":
            cmd = str(a.get("command", ""))
            target = bash_read_target(cmd)
            if target:
                key = norm_path(target, cwd)
                bash_reads += 1
            else:
                for p in bash_mutations(cmd):
                    mutate(t, norm_path(p, cwd))
                continue
        elif name in MUTATING_WRITE_TOOLS:
            mutate(t, norm_path(a.get("file_path") or a.get("path"), cwd))
            continue
        if key is None:
            continue
        reads += 1
        tseen = seen.setdefault(t, {})
        prior = tseen.get(key, [])
        if key in pending.get(t, set()):
            rr_after_edit += 1
            pending[t].discard(key)
        elif any(rng[0] <= p[1] and p[0] <= rng[1] for p in prior):
            rr_unchanged += 1
            earlier = read_calls.get(t, {}).get(key, [])
            if any(folded_sources.get((results.get(e) or {}).get("seq"), BIG) < c["seq"] for e in earlier):
                fold_then_reread += 1
        elif any(tt < t for tt in seen_ever.get(key, set())):
            rr_cross += 1
        tseen.setdefault(key, []).append(rng)
        seen_ever.setdefault(key, set()).add(t)
        read_calls.setdefault(t, {}).setdefault(key, []).append(cid)
    reminders = 0
    for e in events:
        if '"repeat-tool-reminder"' in json.dumps(e.get("data") or {}, ensure_ascii=False):
            reminders += 1
    row["reads"] = {
        "reads": reads, "bash_reads": bash_reads,
        "reread_same_turn_unchanged": rr_unchanged,
        "reread_same_turn_after_edit": rr_after_edit,
        "reread_cross_turn": rr_cross,
        "fold_then_reread": fold_then_reread,
        "repeat_tool_reminders": reminders,
        "folds": len(replacements),
    }

    # ------------------------------------------------------------ tape
    header_forms, tool_forms = {}, {}
    header_lens, tool_line_lens = [], []
    for tp in tape:
        lines = tp["text"].split("\n")
        head = lines[0] if lines else ""
        header_lens.append(len(head))
        if "recall_turn({\"turn\":\"<n>\",\"view\":\"dialogue\"}) returns a turn's dialogue" in head:
            form = "long"
        elif head.endswith(" · recall_turn / expand_result]"):
            form = "short"
        elif "details: recall_turn(" in head:
            form = "compact"
        else:
            form = "other"
        header_forms[form] = header_forms.get(form, 0) + 1
        for ln in lines:
            if not ln.startswith("[tool turn "):
                continue
            tool_line_lens.append(len(ln))
            tf = "long" if 'expand_result({"seq":' in ln else "v" if re.search(r" · v\d+\]$", ln) else "other"
            tool_forms[tf] = tool_forms.get(tf, 0) + 1
    row["tape"] = {
        "entries": len(tape),
        "entry_chars": sum(len(tp["text"]) for tp in tape),
        "header_forms": header_forms,
        "header_lengths": sorted(set(header_lens)),
        "header_chars": sum(header_lens),
        "tool_lines": len(tool_line_lens),
        "tool_line_forms": tool_forms,
        "tool_line_chars": sum(tool_line_lens),
    }

    # ------------------------------------------------------------ flags, exams, leaks
    flagged = []
    for cid in call_order:
        c = calls[cid]
        probe = str(c["args"].get("command", "")) if c["name"] == "bash" else str(c["args"].get("file_path") or c["args"].get("path") or c["args"].get("pattern") or "")
        if any(p in probe for p in FLAG_PATTERNS):
            flagged.append({"turn": c["turn"], "tool": c["name"], "arg": probe[:160]})
    row["flagged_access"] = flagged

    def has(text, toks):
        low = text.lower()
        return any(tok.lower() in low for tok in toks)

    assistant_texts = [((e.get("data") or {}).get("turn"), text_of((e.get("data") or {}).get("message"))) for e in events if e.get("type") == "assistant/message"]
    exam_rows = []
    for turn, toks in exams:
        found = None
        for cid in call_order:
            c = calls[cid]
            if c["turn"] == turn and c["name"] in RECALL_TOOLS and has((results.get(cid) or {}).get("text", ""), toks):
                found = c["name"]
                break
        exam_rows.append({
            "turn": turn,
            "tokens": list(toks),
            "recall_sourced": found is not None,
            "recall_tool": found,
            "recall_calls": sum(1 for cid in call_order if calls[cid]["turn"] == turn and calls[cid]["name"] in RECALL_TOOLS),
            "leak_assistant_turns": sorted({t for t, txt in assistant_texts if t is not None and t < turn and has(txt, toks)}),
            "leak_tool_input_turns": sorted({calls[cid]["turn"] for cid in call_order if calls[cid]["turn"] is not None and calls[cid]["turn"] < turn and has(calls[cid]["raw"], toks)}),
        })
    row["exams"] = exam_rows
    in_rows = []
    for turn, toks in in_turn:
        src = None
        for cid in call_order:
            c = calls[cid]
            if c["turn"] == turn and has((results.get(cid) or {}).get("text", ""), toks):
                src = c["name"]
                break
        folded_read = False
        for rp in replacements:
            base = results_by_seq.get(rp["source"]) or {}
            bc = calls.get(base.get("call")) or {}
            if rp["turn"] == turn and bc.get("name") == "read":
                folded_read = True
        in_rows.append({"turn": turn, "tokens": list(toks), "first_source_tool": src, "fold_of_read": folded_read})
    row["in_turn"] = in_rows
    row["per_turn"] = {str(k): v for k, v in sorted(per_turn.items(), key=lambda kv: (kv[0] is None, kv[0] or 0))}
    return row


def load_prices(path=None):
    with open(path or os.path.join(HERE, "prices.json"), encoding="utf-8") as fh:
        return json.load(fh)


def parse_spec(spec):
    turn, _, toks = spec.partition(":")
    return int(turn), [t for t in toks.split(",") if t]


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    path = argv[0]
    opts = {"--workdir": None, "--prices": None}
    exams, in_turn, pretty = [], [], False
    i = 1
    while i < len(argv):
        a = argv[i]
        if a in opts:
            opts[a] = argv[i + 1]
            i += 2
        elif a == "--exam":
            exams.append(parse_spec(argv[i + 1]))
            i += 2
        elif a == "--in-turn":
            in_turn.append(parse_spec(argv[i + 1]))
            i += 2
        elif a == "--pretty":
            pretty = True
            i += 1
        else:
            raise SystemExit(f"unknown argument {a}")
    events, bad = load_events(path)
    row = metrics(events, workdir=opts["--workdir"], exams=exams, in_turn=in_turn, prices=load_prices(opts["--prices"]), bad_lines=bad)
    row["log"] = path
    print(json.dumps(row, sort_keys=True, ensure_ascii=False, indent=1 if pretty else None))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
