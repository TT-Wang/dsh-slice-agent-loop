#!/usr/bin/env python3
"""ab_metrics.py: one metrics row per DSH 0.1.7 session log (P1-10 native A/B).

usage:
  ab_metrics.py <session.v4.jsonl.zstd | session.jsonl> [--workdir DIR]
                [--exam TURN:TOKEN[,TOKEN...]]... [--in-turn TURN:TOKEN[,TOKEN...]]...
                [--delivery TURN:TOKEN[,TOKEN...]]...
                [--prices prices.json] [--pretty]

Prints one JSON object. Library use: `metrics(load_events(path), ...)`.
`.zstd` input needs system python3 with zstandard; `.jsonl` is read as is.

Metric definitions are in docs/p110-native-ab.md ("Metrics"). In short:
- usage: miss = inputTokens, hit = cacheReadTokens, out = outputTokens of every
  assistant/message and every failed assistant/attempt (billed tokens of retried
  attempts live only in the attempt's stream); requests = committed messages;
- reads: `read` calls and single-file bash reads with their line ranges (sed -n
  ranges, head -n N; tail is a range of unknown position), per turn, with
  same-turn re-reads split into "unchanged" and "after the model's own edit";
  the bash tool's `workdir` parameter is honoured;
- recall: calls and errors per recall tool, formatVersion rejections, the
  shape of every expand_result call and where its locator came from;
- validity: system prompt and slice tool fingerprints, tool count, host paths
  in the system prompt, compaction events, tape header and tool-line forms,
  prompt/turn alignment (no goal rounds);
- access flags: every path argument, bash command and bash workdir resolved
  against the cell's workdir; reaching outside it, the session log, the oracle
  sidecar, the harness or the model key is flagged;
- exams: whether an oracle token reached the model through a recall tool in
  the exam turn, through the file system instead (a non-recall result naming it
  first), and whether an answer-sufficient token leaked earlier into assistant
  text or a tool input that writes a file;
- delivery: whether the fact an exam asks for reached the model at all, i.e. a
  non-recall tool result of its delivery turn carried it (a run whose output was
  redirected to /dev/null leaves nothing to recall).
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
READ_COMMANDS = {"cat", "head", "tail", "nl", "less", "more", "sed"}
MUTATING_WRITE_TOOLS = ("write", "edit", "multiedit", "apply_patch")
BIG = 10 ** 9

# ---- access flags. The sandbox confines writes only; reads are allowed anywhere on disk. Every path
# argument, bash command and bash `workdir` is therefore resolved against the cell's workdir and flagged
# when it leaves it. Locations an ordinary program run touches are exempt.
SYSTEM_PREFIXES = ("/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/fd/", "/dev/zero", "/dev/urandom", "/dev/random",
                   "/usr/", "/bin/", "/sbin/", "/System/", "/Library/", "/opt/homebrew/", "/opt/local/", "/private/etc/", "/proc/")
# Flagged wherever they resolve: the durable session log, the oracle sidecar, the harness, whole-disk search.
SENSITIVE_RE = re.compile(r"sessions/|/sessions\b|\.zstd\b|\.truth\b|session\.v4|/home-(?:control|arm\d)\b|wt-harness|scripts/ab/|(?:^|[\s;&|(])(?:mdfind|locate)\s")
# Flagged, and held back from the archive until the owner has looked: anything that can reach the model key.
SECRET_RE = re.compile(r"\bDSH_HOME\b|\bDSH_PROFILE_DIR\b|(?<![\w.])\.env(?![\w])|/\.dsh[\w-]*\b")
HOME_RE = re.compile(r"(?:^|[\s'\"=:(])~(?:/|$|[\s'\")])|\$\{?(?:HOME|TMPDIR|OLDPWD)\b")
PATH_IN_TEXT = re.compile(r"(?<![\w.~$:/\\-])(/[\w.@+~-][^\s'\"`;|&<>(),]*)")
PARENT_IN_TEXT = re.compile(r"(?<![\w.])(\.\.(?:/[^\s'\"`;|&<>(),]*)?)(?![\w.])")
PATTERN_FIRST = {"sed", "awk", "gawk", "perl", "grep", "egrep", "fgrep", "rg", "jq"}
FS_WALKERS = {"find", "ls", "du", "tree", "grep", "egrep", "fgrep", "rg", "cat", "head", "tail", "stat", "file", "cd", "pushd", "less", "more", "open"}
WRITE_TEXT_RE = re.compile(r"(?:^|[;&|\n(]\s*)(?:echo|printf|cat)\b[^\n]*?(?:>>?|\btee\b)|<<")


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


def split_top(command, seps=(";", "\n", "&&", "||")):
    """Split a shell command on the given separators outside quotes."""
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
            i += 1
            continue
        if ch in "'\"":
            quote = ch
            buf.append(ch)
            i += 1
            continue
        sep = next((s for s in seps if command.startswith(s, i)), None)
        if sep:
            segments.append("".join(buf))
            buf = []
            i += len(sep)
            continue
        buf.append(ch)
        i += 1
    segments.append("".join(buf))
    return [s.strip() for s in segments if s.strip()]


def split_segments(command):
    """Split a shell command on ;, &&, || and newlines (not inside quotes); pipes stay inside a segment."""
    return split_top(command)


def split_pipes(segment):
    """Split one segment into its pipeline stages (| outside quotes; || was split earlier)."""
    return split_top(segment, ("|",))


def tokens(segment):
    try:
        return shlex.split(segment, posix=True)
    except ValueError:
        return segment.split()


def _num(s):
    return int(s) if isinstance(s, str) and s.isdigit() else None


def sed_ranges(scripts):
    """Line ranges printed by `sed -n` scripts made only of `Np`, `a,bp` and `a,$p` commands, else None (unknown)."""
    out = []
    for script in scripts:
        for part in re.split(r"[;\n]", script):
            part = part.strip()
            if not part:
                continue
            m = re.fullmatch(r"(\d+)(?:\s*,\s*(\d+|\$))?\s*p", part)
            if not m:
                return None
            a = int(m.group(1))
            b = a if m.group(2) is None else (BIG if m.group(2) == "$" else int(m.group(2)))
            out.append((a, max(a, b)))
    return out or None


def head_range(args):
    """(1, N) for head -n N / -N / --lines=N (default 10); None for byte counts."""
    n, i = 10, 0
    while i < len(args):
        a = args[i]
        if a in ("-c", "--bytes") or a.startswith(("-c", "--bytes=")):
            return None
        if a in ("-n", "--lines") and i + 1 < len(args):
            n = _num(args[i + 1].lstrip("+")) or n
            i += 2
            continue
        if a.startswith("--lines="):
            n = _num(a.split("=", 1)[1]) or n
        elif re.fullmatch(r"-n?\d+", a):
            n = int(a.lstrip("-n"))
        i += 1
    return [(1, n)]


def tail_range(args):
    """`tail -n +N` reads from line N to the end; any other tail is a range of unknown position (None)."""
    for i, a in enumerate(args):
        v = args[i + 1] if a in ("-n", "--lines") and i + 1 < len(args) else (a[2:] if a.startswith("-n+") else a.split("=", 1)[1] if a.startswith("--lines=") else None)
        if v and v.startswith("+") and _num(v[1:]):
            return [(int(v[1:]), BIG)]
    return None


def operands_of(cmd, args):
    """Non-option operands; skips the values of head/tail -n/-c and sed -e."""
    operands, skip = [], False
    for a in args:
        if skip:
            skip = False
            continue
        if cmd in ("head", "tail") and a in ("-n", "-c", "--lines", "--bytes"):
            skip = True
            continue
        if cmd == "sed" and a in ("-e", "--expression"):
            skip = True
            continue
        if a.startswith("-") or (cmd == "tail" and a.startswith("+")):
            continue
        operands.append(a)
    return operands


def bash_read(command, workdir=None):
    """(path, ranges) read by a pure single-file read command, else None.

    Commands: cat/nl/less/more (whole file), head (lines 1..N), tail (unknown position unless -n +N),
    sed -n with numeric `p` ranges; optionally piped into head/sed -n/tail, which narrows the range.
    `ranges` is a list of 1-based inclusive line ranges, or None for a range of unknown position (it
    never overlaps another read). A leading `cd DIR &&` and the bash tool's own `workdir` parameter are
    honoured: the path is returned joined to them (relative to the session cwd when they are relative)."""
    segs = split_segments(command)
    base = workdir if isinstance(workdir, str) and workdir.strip() else None
    if len(segs) == 2 and tokens(segs[0])[:1] == ["cd"] and len(tokens(segs[0])) == 2:
        cd = tokens(segs[0])[1]
        base = cd if base is None or os.path.isabs(cd) else os.path.join(base, cd)
        segs = segs[1:]
    if len(segs) != 1 or re.search(r"(?<![0-9&])>", segs[0]):
        return None
    stages = split_pipes(segs[0])
    toks = tokens(stages[0])
    if not toks or toks[0] not in READ_COMMANDS:
        return None
    cmd, args = toks[0], toks[1:]
    if cmd == "sed":
        if not any(a == "-n" or re.fullmatch(r"-n[a-zA-Z]*", a) or a == "--quiet" for a in args) or any(a == "-i" or a.startswith(("-i", "--in-place")) for a in args):
            return None
        scripts = [args[i + 1] for i, a in enumerate(args) if a in ("-e", "--expression") and i + 1 < len(args)]
        ops = operands_of(cmd, args)
        if not scripts:
            if not ops:
                return None
            scripts, ops = [ops[0]], ops[1:]
        ranges = sed_ranges(scripts)
    elif cmd == "head":
        ops, ranges = operands_of(cmd, args), head_range(args)
    elif cmd == "tail":
        ops, ranges = operands_of(cmd, args), tail_range(args)
    else:
        ops, ranges = operands_of(cmd, args), [(1, BIG)]
    if len(ops) != 1:
        return None
    for stage in stages[1:2]:  # the first downstream stage may narrow a whole-file read
        st = tokens(stage)
        if not st:
            break
        if st[0] == "head" and ranges == [(1, BIG)]:
            ranges = head_range(st[1:])
        elif st[0] == "sed" and ranges == [(1, BIG)] and "-n" in st:
            ranges = sed_ranges([a for a in st[1:] if not a.startswith("-")][:1])
        elif st[0] == "tail" and ranges == [(1, BIG)]:
            ranges = tail_range(st[1:])
    path = ops[0]
    return (path if base is None or os.path.isabs(path) else os.path.join(base, path)), ranges


def bash_read_target(command, workdir=None):
    """Path of bash_read(), or None (kept for callers that only need the path)."""
    r = bash_read(command, workdir)
    return r[0] if r else None


def bash_mutations(command):
    """Paths a bash command writes, moves or deletes (best effort, never raises)."""
    out = []
    for target in re.findall(r"(?<![0-9&<>])>>?\s*([^\s;&|<>]+)", command):
        if target not in ("/dev/null",) and not target.startswith("&"):
            out.append(target)
    for seg in split_segments(command):
        for piece in split_pipes(seg):
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


# ---------------------------------------------------------------------------- access flags

def canon_path(p):
    """normpath plus macOS's /tmp, /var and /etc symlinks, so /tmp/x and /private/tmp/x compare equal."""
    p = os.path.normpath(p)
    for a, b in (("/tmp", "/private/tmp"), ("/var", "/private/var"), ("/etc", "/private/etc")):
        if p == a or p.startswith(a + "/"):
            return b + p[len(a):]
    return p


def is_under(p, root):
    root = root.rstrip("/") or "/"
    return p == root or p.startswith(root + "/")


def outside(p, root):
    """True when the resolved path p leaves the workdir root and is not an exempt system location."""
    if root is None:
        return False
    if is_under(p, root):
        return False
    return not any(p == s.rstrip("/") or p.startswith(s) for s in SYSTEM_PREFIXES)


def resolve_arg(p, cwd):
    """Absolute canonical path of a path argument resolved against cwd; None for ~ (home) forms."""
    if not isinstance(p, str) or not p.strip():
        return None
    p = p.strip()
    if p.startswith("~"):
        return None
    return canon_path(p if os.path.isabs(p) else os.path.join(cwd or "/", p))


def text_paths(text, whole=False):
    """Path-like substrings of one shell word: absolute paths and ../ escapes embedded in it, plus the word
    itself when it looks like a path (whole=True: it contains a slash or is `..`)."""
    out = []
    if whole and (text.startswith(("/", "..", "./")) or "/" in text or text == ".."):
        out.append(text)
    out += PATH_IN_TEXT.findall(text)
    out += PARENT_IN_TEXT.findall(text)
    return out


def bash_access(command, cwd, root):
    """Reasons a bash command reaches outside the workdir root, following `cd` segments."""
    reasons = []
    if HOME_RE.search(command):
        reasons.append("home or temp directory")
    for seg in split_segments(command):
        for piece in split_pipes(seg):
            toks = tokens(piece)
            while toks and re.match(r"^[A-Za-z_]\w*=", toks[0]):
                for p in text_paths(toks[0].split("=", 1)[1], whole=True):
                    r = resolve_arg(p, cwd)
                    if r and outside(r, root):
                        reasons.append("outside: " + r)
                toks = toks[1:]
            if not toks:
                continue
            cmd = os.path.basename(toks[0])
            if cmd in ("cd", "pushd"):
                target = toks[1] if len(toks) > 1 else "~"
                r = resolve_arg(target, cwd)
                if r is None or target.startswith("$"):
                    reasons.append("cd to " + target)
                    cwd = None
                else:
                    if outside(r, root):
                        reasons.append("outside: " + r)
                    cwd = r
                continue
            skip_pattern = cmd in PATTERN_FIRST and not any(a in ("-e", "--regexp", "--expression", "-f") for a in toks[1:])
            skip_next = False
            for i, a in enumerate(toks):
                if skip_next:
                    skip_next = False
                    continue
                if i > 0 and cmd in PATTERN_FIRST and a in ("-e", "--regexp", "--expression"):
                    skip_next = True
                    continue
                if i > 0 and skip_pattern and not a.startswith("-"):
                    skip_pattern = False
                    continue
                if a in ("/", "/.", "/..") or re.fullmatch(r"/+\.?", a):
                    if cmd in FS_WALKERS:
                        reasons.append("outside: / (%s)" % cmd)
                    continue
                for p in text_paths(a, whole=True):
                    if cwd is None and not os.path.isabs(p):
                        reasons.append("relative path after cd to an unknown directory: " + p)
                        continue
                    r = resolve_arg(p, cwd)
                    if r and outside(r, root):
                        reasons.append("outside: " + r)
    return reasons


def access_flags(calls, call_order, cwd):
    """Tool calls that reach outside the workdir (cwd), touch the session log, oracle sidecar or harness,
    or can reach the model key. One entry per flagged call."""
    root = canon_path(cwd) if cwd else None
    flagged = []
    for cid in call_order:
        c = calls[cid]
        a, name, raw = c["args"], c["name"], c["raw"] or ""
        reasons = []
        if name == "bash":
            command = str(a.get("command", ""))
            bcwd = root
            wd = a.get("workdir")
            if isinstance(wd, str) and wd.strip():
                bcwd = resolve_arg(wd, root)
                if bcwd is None or outside(bcwd, root):
                    reasons.append("bash workdir outside: %s" % wd)
            reasons += bash_access(command, bcwd, root)
            probe = command + " " + (wd or "")
        else:
            probe = raw
            for key in ("file_path", "path", "notebook_path"):
                v = a.get(key)
                if isinstance(v, str) and v.strip():
                    if v.strip().startswith("~"):
                        reasons.append("home: " + v)
                        continue
                    r = resolve_arg(v, root)
                    if r and outside(r, root):
                        reasons.append("outside: " + r)
            if name == "glob" and isinstance(a.get("pattern"), str):
                pat = a["pattern"]
                prefix = re.split(r"[*?\[{]", pat, 1)[0]
                if pat.startswith("~"):
                    reasons.append("home: " + pat)
                elif prefix and (os.path.isabs(prefix) or ".." in prefix):
                    base = resolve_arg(a.get("path") or ".", root) or root
                    r = resolve_arg(prefix, base)
                    if r and outside(r, root):
                        reasons.append("outside: " + r)
        if SENSITIVE_RE.search(probe):
            reasons.append("sensitive: " + SENSITIVE_RE.search(probe).group(0).strip())
        secret = bool(SECRET_RE.search(probe))
        if secret:
            reasons.append("secret: " + SECRET_RE.search(probe).group(0))
        if reasons:
            flagged.append({"turn": c["turn"], "tool": name, "arg": probe[:160], "reasons": sorted(set(reasons))[:6], "secret": secret})
    return flagged


# ---------------------------------------------------------------------------- oracle specs

class Matcher:
    """Case-insensitive substring tokens plus regexes; built from an exam spec part {tokens, regex}."""

    def __init__(self, spec):
        spec = spec or {}
        self.tokens = [t.lower() for t in spec.get("tokens", [])]
        self.regex = [re.compile(r, re.I) for r in spec.get("regex", [])]

    def __bool__(self):
        return bool(self.tokens or self.regex)

    def __call__(self, text):
        if not text:
            return False
        low = text.lower()
        return any(t in low for t in self.tokens) or any(r.search(text) for r in self.regex)


def exam_spec(e):
    """Normalize an exam given as (turn, tokens) or {turn, tokens, leak, fs}.

    tokens: a recall result naming one of them sources the answer (recall_sourced);
    leak:   enough to answer; in assistant text, or written by a tool, before the exam turn = leak (default: tokens);
    fs:     in a non-recall tool result of the exam turn before any recall result has it and before the model
            itself wrote it = the oracle came from the file system (default: tokens)."""
    if isinstance(e, dict):
        turn, toks = e["turn"], list(e.get("tokens", []))
        leak, fs = e.get("leak") or {"tokens": toks}, e.get("fs") or {"tokens": toks}
    else:
        turn, toks = e[0], list(e[1])
        leak = fs = {"tokens": toks}
    return {"turn": turn, "tokens": toks, "leak": Matcher(leak), "fs": Matcher(fs), "recall": Matcher({"tokens": toks})}


def write_like(call):
    """Tool input that writes literal text to a file: write/edit content, or bash echo/printf/cat into a file or tee."""
    if call["name"] in MUTATING_WRITE_TOOLS:
        return True
    return call["name"] == "bash" and bool(WRITE_TEXT_RE.search(str(call["args"].get("command", ""))))


def stream_usage(stream):
    """The last usage chunk of an assistant stream (the adapter-reported sample), if any."""
    for rec in reversed(stream or []):
        if isinstance(rec, dict) and rec.get("type") == "chunk" and (rec.get("chunk") or {}).get("type") == "usage":
            return (rec.get("chunk") or {}).get("usage")
    return None


def usage_of(event):
    """Usage of one assistant/message (data.usage, else its stream) or assistant/attempt (its stream)."""
    d = event.get("data") or {}
    if event.get("type") == "assistant/message" and d.get("usage") is not None:
        return d["usage"]
    return stream_usage(d.get("stream"))


def usage_totals(events, turns=None):
    """Billed tokens of every assistant/message and assistant/attempt (optionally only those turns):
    {miss, hit, out, cache_write, messages, attempts, unpriced} where unpriced counts records without a sample."""
    tot = {"miss": 0, "hit": 0, "out": 0, "cache_write": 0, "messages": 0, "attempts": 0, "unpriced": 0}
    for e in events:
        if e.get("type") not in ("assistant/message", "assistant/attempt"):
            continue
        if turns is not None and (e.get("data") or {}).get("turn") not in turns:
            continue
        tot["messages" if e["type"] == "assistant/message" else "attempts"] += 1
        u = usage_of(e)
        if u is None:
            tot["unpriced"] += 1
            continue
        tot["miss"] += u.get("inputTokens") or 0
        tot["hit"] += u.get("cacheReadTokens") or 0
        tot["out"] += u.get("outputTokens") or 0
        tot["cache_write"] += u.get("cacheWriteTokens") or 0
    return tot


def metrics(events, workdir=None, exams=(), in_turn=(), prices=None, bad_lines=0, delivery=()):
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
        # Prompt/turn alignment: exams are addressed by turn number = prompt index, which holds only when every
        # turn was started by one harness prompt (no goal rounds or other self-started turns).
        "user_prompts": sum(1 for e in events if e.get("type") == "user/message" and ((e.get("data") or {}).get("source") or {}).get("kind") == "user"),
        "goal_messages": sum(1 for e in events if e.get("type") == "user/message" and ((e.get("data") or {}).get("source") or {}).get("kind") == "goal"),
        "turn_starts": sum(1 for e in events if e.get("type") == "turn/start"),
        "turn_ends": sum(1 for e in events if e.get("type") == "turn/end"),
        "goal_tool_calls": sum(1 for e in events if e.get("type") == "tool/call" and (e.get("data") or {}).get("name") in ("create_goal", "update_goal", "get_goal")),
    }
    row["prefix"] = {
        "system_chars": len(system),
        "tools_json_chars": len(canon(tools)),
        "slice_tools_json_chars": len(canon(slice_tools)),
        "prefix_chars": len(system) + len(canon(tools)),
    }

    # ------------------------------------------------------------ usage
    # Billed tokens include failed attempts (assistant/attempt keeps a retried attempt's usage only in its
    # stream); `requests` counts committed messages only, so retries (provider weather) stay out of G4.requests.
    usage = {"requests": 0, "miss": 0, "hit": 0, "out": 0, "cache_write": 0, "turn_first_miss": 0, "later_step_miss": 0,
             "attempts_failed": 0, "attempt_miss": 0, "attempt_hit": 0, "attempt_out": 0, "unpriced_records": 0}
    per_turn = {}
    last_assistant = {}
    first_hit = []
    for e in events:
        if e.get("type") not in ("assistant/message", "assistant/attempt"):
            continue
        d = e.get("data") or {}
        u = usage_of(e)
        if u is None:
            usage["unpriced_records"] += 1
            u = {}
        miss, hit, out, cw = (u.get("inputTokens") or 0), (u.get("cacheReadTokens") or 0), (u.get("outputTokens") or 0), (u.get("cacheWriteTokens") or 0)
        usage["miss"] += miss
        usage["hit"] += hit
        usage["out"] += out
        usage["cache_write"] += cw
        pt = per_turn.setdefault(d.get("turn"), {"requests": 0, "miss": 0, "hit": 0, "out": 0, "max_step": 0, "attempts_failed": 0})
        pt["miss"] += miss
        pt["hit"] += hit
        pt["out"] += out
        if e.get("type") == "assistant/attempt":
            usage["attempts_failed"] += 1
            usage["attempt_miss"] += miss
            usage["attempt_hit"] += hit
            usage["attempt_out"] += out
            pt["attempts_failed"] += 1
            continue
        usage["requests"] += 1
        if d.get("step") == 1:
            usage["turn_first_miss"] += miss
            first_hit.append(hit)
        else:
            usage["later_step_miss"] += miss
        pt["requests"] += 1
        pt["max_step"] = max(pt["max_step"], d.get("step") or 0)
        content = (d.get("message") or {}).get("content", []) or []
        last_assistant[d.get("turn")] = {"tool": any(isinstance(b, dict) and b.get("type") == "tool-call" for b in content), "text": bool(text_of(d.get("message")).strip())}
    for sheet in ("offpeak", "peak"):
        p = prices[sheet]
        usage["cost_" + sheet] = round(((usage["miss"] + usage["cache_write"]) * p["miss"] + usage["hit"] * p["hit"] + usage["out"] * p["out"]) / 1e6, 6)
    usage["first_request_hits"] = first_hit
    row["usage"] = usage

    # ------------------------------------------------------------ finish
    turn_end, error_codes = {}, {}
    for e in events:
        if e.get("type") == "turn/end":
            d = e.get("data") or {}
            reason = d.get("reason") or {}
            turn_end[d.get("turn")] = reason.get("kind")
            if reason.get("kind") == "error":
                code = str((reason.get("error") or {}).get("code"))
                error_codes[code] = error_codes.get(code, 0) + 1
    kinds = {}
    for k in turn_end.values():
        kinds[k] = kinds.get(k, 0) + 1
    row["finish"] = {
        "turns": len(turn_end),
        "reasons": kinds,
        "error_codes": error_codes,
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
        key, rngs = None, [(1, BIG)]  # rngs None: a range of unknown position (tail, sed /re/p, head -c)
        if name == "read":
            key = norm_path(a.get("file_path") or a.get("path"), cwd)
            off = as_int(a.get("offset")) or 1
            lim = as_int(a.get("limit"))
            rngs = [(off, off + lim - 1 if lim else BIG)]
        elif name == "bash":
            cmd = str(a.get("command", ""))
            bwd = a.get("workdir") if isinstance(a.get("workdir"), str) and a.get("workdir").strip() else None
            target = bash_read(cmd, bwd)
            if target:
                key, rngs = norm_path(target[0], cwd), target[1]
                bash_reads += 1
            else:
                base = norm_path(bwd, cwd) if bwd else cwd
                for p in bash_mutations(cmd):
                    mutate(t, norm_path(p, base))
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
        elif rngs is not None and any(r[0] <= p[1] and p[0] <= r[1] for r in rngs for p in prior):
            rr_unchanged += 1
            earlier = read_calls.get(t, {}).get(key, [])
            if any(folded_sources.get((results.get(e) or {}).get("seq"), BIG) < c["seq"] for e in earlier):
                fold_then_reread += 1
        elif any(tt < t for tt in seen_ever.get(key, set())):
            rr_cross += 1
        tseen.setdefault(key, []).extend(rngs or [])
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
    row["flagged_access"] = access_flags(calls, call_order, cwd)

    def has(text, toks):
        low = text.lower()
        return any(tok.lower() in low for tok in toks)

    assistant_texts = [((e.get("data") or {}).get("turn"), text_of((e.get("data") or {}).get("message"))) for e in events if e.get("type") == "assistant/message"]
    exam_rows = []
    for spec in (exam_spec(e) for e in exams):
        turn = spec["turn"]
        found = None
        for cid in call_order:
            c = calls[cid]
            if c["turn"] == turn and c["name"] in RECALL_TOOLS and spec["recall"]((results.get(cid) or {}).get("text", "")):
                found = c["name"]
                break
        # Content-based: walk the exam turn in log order. The oracle reached the model through the file system
        # when a non-recall tool result names it before any recall result did and before the model itself
        # wrote it (in assistant text or a tool input, e.g. its own answer file read back).
        recalled = authored = False
        via_fs = None
        for e in events:
            d = e.get("data") or {}
            if d.get("turn") != turn:
                continue
            if e.get("type") == "assistant/message" and spec["fs"](text_of(d.get("message"))):
                authored = True
            elif e.get("type") == "tool/call" and spec["fs"](d.get("arguments") or ""):
                authored = True
            elif e.get("type") == "tool/result" and op_of(e) == "append":
                m = d.get("message") or {}
                c = calls.get(m.get("toolCallId")) or {}
                text = text_of(m)
                if c.get("name") in RECALL_TOOLS:
                    recalled = recalled or spec["fs"](text) or spec["recall"](text)
                elif not recalled and not authored and via_fs is None and spec["fs"](text):
                    via_fs = {"tool": c.get("name"), "arg": (c.get("raw") or "")[:160]}
        exam_rows.append({
            "turn": turn,
            "n_tokens": len(spec["tokens"]),  # the tokens themselves stay out of cells/*.json (no oracle copies on disk)
            "recall_sourced": found is not None,
            "recall_tool": found,
            "recall_calls": sum(1 for cid in call_order if calls[cid]["turn"] == turn and calls[cid]["name"] in RECALL_TOOLS),
            "leak_assistant_turns": sorted({t for t, txt in assistant_texts if t is not None and t < turn and spec["leak"](txt)}),
            # Tool inputs never reach the tape (tool lines carry name, size and locator); only a tool input that
            # writes the answer to a file can shortcut the exam, so only write-like inputs count.
            "leak_write_turns": sorted({calls[cid]["turn"] for cid in call_order if calls[cid]["turn"] is not None and calls[cid]["turn"] < turn
                                        and write_like(calls[cid]) and spec["leak"](calls[cid]["raw"])}),
            "oracle_via_fs": via_fs is not None,
            "oracle_via_fs_call": via_fs,
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
        in_rows.append({"turn": turn, "n_tokens": len(toks), "first_source_tool": src, "fold_of_read": folded_read})
    row["in_turn"] = in_rows
    # Delivery: the exam's fact must have reached the model in its delivery turn through a non-recall tool
    # result (the tokens themselves stay out of the row, like the exam tokens).
    deliv_rows = []
    for turn, toks in delivery:
        src = None
        for cid in call_order:
            c = calls[cid]
            if c["turn"] == turn and c["name"] not in RECALL_TOOLS and has((results.get(cid) or {}).get("text", ""), toks):
                src = c["name"]
                break
        deliv_rows.append({"turn": turn, "n_tokens": len(toks), "delivered": src is not None, "tool": src})
    row["delivery"] = deliv_rows
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
    exams, in_turn, delivery, pretty = [], [], [], False
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
        elif a == "--delivery":
            delivery.append(parse_spec(argv[i + 1]))
            i += 2
        elif a == "--pretty":
            pretty = True
            i += 1
        else:
            raise SystemExit(f"unknown argument {a}")
    events, bad = load_events(path)
    row = metrics(events, workdir=opts["--workdir"], exams=exams, in_turn=in_turn, prices=load_prices(opts["--prices"]), bad_lines=bad,
                  delivery=delivery)
    row["log"] = path
    print(json.dumps(row, sort_keys=True, ensure_ascii=False, indent=1 if pretty else None))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
