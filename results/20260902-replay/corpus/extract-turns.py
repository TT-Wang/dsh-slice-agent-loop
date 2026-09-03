#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extract-turns.py -- offline corpus extraction for an agent-loop replay benchmark.

stdlib only, no network, no API calls.  The source repos are only touched by
transient `git worktree add --detach` / `git worktree remove --force` under the
scratch directory; the tool snapshots `git status` / `git worktree list` / HEAD /
reflog head before it starts and verifies they are unchanged when it finishes.

Pipeline
  1. Scan Claude Code session transcripts (JSONL) under --projects-root for the
     configured project dirs (top-level *.jsonl only; the <session>/ subdirs hold
     offloaded tool results, not conversation entries).
  2. Segment each transcript into turns.  A turn starts at a human-originated user
     entry (plain text string or text block(s); not a tool_result, not isMeta)
     and runs until the next such entry.  Injected notices (<task-notification>,
     <system-reminder>, ...) do not split turns.  Slash-command echoes and
     "[Request interrupted ...]" markers split turns but are not tasks.
     Turns whose prompt begins "This session is being continued" are skipped.
  3. Filters (a turn is kept only if all hold; defaults are the spec values):
       F1 tools used are a subset of {Bash, Read, Edit, Write, Grep, Glob}
       F2 12 <= total tool calls <= 90            (--min-tools / --max-tools)
       F3 >= 2 successful in-repo Edit/Write calls
       F4 no Bash command matching: git push, git commit, npm/pnpm publish,
          docker push, rm -rf /<abs path>, curl, wget, sudo, ssh, scp
          (single-word rules are matched on word boundaries so that e.g.
          `grep curly` does not trip the curl rule)
       F5 prompt is a self-contained task: >= 20 chars, not a bare greeting,
          no image attachment                     (--min-prompt-chars / --cjk-weight)
       F6 every successful Edit/Write targets the repo (writes to the Claude
          memory dir or the scratchpad/tmp are tolerated and recorded; edits to
          any other location reject the turn because the oracle cannot represent
          them)
     Optional relaxations (off by default; every use is recorded per turn in
     meta.specDeviations and in the INDEX):
       --allow-trailing-commit  if the only forbidden commands are `git commit`
                                and all of them come after the last in-repo edit,
                                cut the turn right before the first one (the
                                dropped tail is recorded); the oracle is the
                                pre-commit file state.
       --cjk-weight 2           count CJK characters twice for the F5 length
                                threshold (a 10-character Chinese sentence carries
                                about as much as 20 English characters).
       --max-tools N            raise the F2 ceiling.
       --relaxed                shorthand for --allow-trailing-commit --cjk-weight 2
  4. Starting state: the newest `git reflog --date=iso` entry whose timestamp is
     <= the turn's prompt timestamp (ISO Z converted to an aware datetime and
     compared against the +0800 reflog dates).  The turn is also rejected if
     HEAD differs at the first tool call or at the end of the (kept part of the)
     turn.
  5. Replay: a detached throwaway worktree of that commit is created and the
     recorded Edit/Write calls are applied IN ORDER (failed calls, i.e. tool
     results with is_error, are skipped since they changed nothing).
       Write: create/overwrite with `content`.
       Edit : `old_string` must occur exactly once (any number with
              replace_all); a curly/straight quote normalised match is accepted
              as a fallback, mirroring the Edit tool.  Not found -> the starting
              state differs from the commit -> turn dropped.
     Strict guard (default on, --no-strict to disable): when the transcript
     recorded the pre-edit file content (toolUseResult.originalFile) it must
     equal the worktree file byte-for-byte; a whitespace-only difference is
     recorded as a warning, anything else drops the turn.
  6. Output under --out/<--out-name>/ (default corpus/):
       <repo>-<turnIndex>-<shortsha>/prompt.txt   human message verbatim
       <repo>-<turnIndex>-<shortsha>/context.txt  the preceding human/assistant
                                                  exchanges of the same session
                                                  (additive; helps when the
                                                  prompt answers questions the
                                                  agent asked one turn earlier)
       <repo>-<turnIndex>-<shortsha>/meta.json    see build_meta()
       <repo>-<turnIndex>-<shortsha>/oracle/...   final content of every touched
                                                  file (relative path preserved)
       INDEX.md                                   all replayable turns, all
                                                  rejections, near misses
       summary.json                               machine-readable counts
     Every candidate is replayed; corpus dirs are written for the best
     --max-keep turns by score (prefers 25-80 tool calls, several touched files,
     concrete engineering prompts, no starting-state warnings).  --keep-all
     writes a dir for every replayable turn.
"""

import argparse
import collections
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

# --------------------------------------------------------------------------- #
# configuration
# --------------------------------------------------------------------------- #

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = HERE
DEFAULT_PROJECTS_ROOT = os.path.expanduser("~/.claude/projects")
DEFAULT_PROJECTS = [
    "-Users-tongtao-code-dsh-slice-agent-loop",
    "-Users-tongtao-code-dsh-assembler",
]

ALLOWED_TOOLS = {"Bash", "Read", "Edit", "Write", "Grep", "Glob"}
EDIT_TOOLS = {"Edit", "Write"}
SPEC_MIN_TOOLS, SPEC_MAX_TOOLS = 12, 90
SPEC_MIN_EDITS = 2
SPEC_MIN_PROMPT_CHARS = 20
PREFERRED_TOOL_RANGE = (25, 80)
CONTEXT_TURNS = 4
CONTINUATION_PREFIX = "This session is being continued"

# user entries injected by the harness while a turn is running: never split.
NOTICE_PREFIXES = ("<task-notification>", "<system-reminder>", "<user-prompt-submit-hook>")
# user-originated but not a task (slash command echo, local command output,
# interrupt marker): split the previous turn, never a candidate.
EVENT_PREFIXES = (
    "<command-name>", "<command-message>", "<local-command-stdout>",
    "<local-command-caveat>", "[Request interrupted", "<ide_",
)
GREETING_RE = re.compile(
    r"^(hi|hello|hey|yo|ok|okay|yes|no|thanks|thank you|test|ping|你好|嗨|哈喽|好的|好|嗯|继续|谢谢|收到)"
    r"[\s!.,。！～~]*$", re.I)
# "一. 要吧 二. 好 三. 不需要" -- an answer sheet to questions asked in the previous turn
REPLY_LIST_RE = re.compile(r"^\s*(?:[一二三四五六七八九十\dA-Za-z]{1,2}[.、．)]\s*[^\s一二三四五六七八九十\d]{1,15}\s+){2,}")
CJK_RE = re.compile(r"[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]")

# `git [-C p] [--flag[=v]] ... <verb>`
GIT_PREFIX = r"\bgit(?:\s+(?:-C|-c|--git-dir|--work-tree)(?:=|\s+)\S+|\s+--?[\w-]+(?:=\S+)?)*\s+"
FORBIDDEN_BASH = [
    ("git push", re.compile(GIT_PREFIX + r"push\b")),
    ("git commit", re.compile(GIT_PREFIX + r"commit\b")),
    ("npm publish", re.compile(r"\b(?:npm|pnpm|yarn)\s+publish\b")),
    ("docker push", re.compile(r"\bdocker\s+push\b")),
    ("rm -rf /", re.compile(r"\brm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:-[a-zA-Z]+\s+)*/")),
    ("curl", re.compile(r"(?<![\w.-])curl(?![\w-])")),
    ("wget", re.compile(r"(?<![\w.-])wget(?![\w-])")),
    ("sudo", re.compile(r"(?<![\w.-])sudo(?![\w-])")),
    ("ssh", re.compile(r"(?<![\w.-])ssh(?![\w-])")),
    ("scp", re.compile(r"(?<![\w.-])scp(?![\w-])")),
]
# recorded in meta.flags and used for ranking only (never reject on their own)
SOFT_FLAGS = [
    ("git-head-mutation", re.compile(
        GIT_PREFIX + r"(?:checkout|switch|reset|stash|am|merge|rebase|cherry-pick|revert|apply|clean|restore|worktree|branch\s+-[dDmM])\b")),
    ("git-network", re.compile(GIT_PREFIX + r"(?:pull|fetch|clone|ls-remote|remote\s+add)\b")),
    ("pkg-install", re.compile(r"\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add)\b|\bpip3?\s+install\b|\bbrew\s+install\b")),
    ("build", re.compile(r"\b(?:npm|pnpm|yarn|bun)\s+run\s+build\b|\b(?:npx\s+)?tsc\b|\bpnpm\s+build\b")),
    ("shell-file-mutation", re.compile(
        r"\bsed\s+-[a-zA-Z]*i\b|(?<![&\d<])>{1,2}\s*(?!/dev/null|&)[\w./~$\"'-]|\btee\b|\bmv\s|\bcp\s|\brm\s|\bmkdir\s|\btouch\s|\bchmod\s|\bln\s")),
    ("inline-script-write", re.compile(
        r"\bopen\([^)]*,\s*['\"][wa]b?['\"]\)|\.write_text\(|\bwriteFileSync\(|\bfs\.writeFile|\bnode\s+-e\b"
        r"|\bpython3?\s+-\s*<<|\bpython3?\s+-c\b|\bperl\s+-[a-z]*i")),
    ("gh-cli", re.compile(r"\bgh\s+(?:pr|issue|repo|api|release|run)\b")),
]
QUOTE_MAP = {0x2018: "'", 0x2019: "'", 0x201A: "'", 0x201B: "'",
             0x201C: '"', 0x201D: '"', 0x201E: '"', 0x201F: '"'}

# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #

def log(msg):
    print(msg, file=sys.stderr, flush=True)


def parse_iso_utc(ts):
    """'2026-08-24T10:01:22.493Z' -> aware datetime (UTC)."""
    m = re.match(r"^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d:?\d\d)$", ts or "")
    if not m:
        return None
    y, mo, d, h, mi, s, frac, tz = m.groups()
    micro = int((frac or "0").ljust(6, "0"))
    if tz == "Z":
        tzinfo = dt.timezone.utc
    else:
        sign = 1 if tz[0] == "+" else -1
        hh, mm = int(tz[1:3]), int(tz[-2:])
        tzinfo = dt.timezone(sign * dt.timedelta(hours=hh, minutes=mm))
    return dt.datetime(int(y), int(mo), int(d), int(h), int(mi), int(s), micro, tzinfo=tzinfo)


def to_local(d, offset_hours=8):
    return d.astimezone(dt.timezone(dt.timedelta(hours=offset_hours))).strftime("%Y-%m-%d %H:%M:%S %z")


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def normalize_quotes(s):
    return s.translate(QUOTE_MAP)


def git(root, *args, check=True):
    p = subprocess.run(["git", "-C", root, *args], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if check and p.returncode != 0:
        raise RuntimeError("git %s failed (%d): %s" % (" ".join(args), p.returncode, p.stderr.strip()))
    return p.stdout


def md_cell(s, limit=None):
    s = (s or "").replace("\r", "").replace("\n", " ").replace("|", "\\|").strip()
    if limit is not None and len(s) > limit:
        s = s[:limit]
    return s


def first_chars(s, n=80):
    return md_cell(" ".join((s or "").split()), n)


def weighted_len(s, cjk_weight):
    s = " ".join((s or "").split())
    if cjk_weight == 1:
        return len(s)
    return sum(cjk_weight if CJK_RE.match(ch) else 1 for ch in s)


REASON_LABELS = {
    "F1": "F1 disallowed tool(s)",
    "F2": "F2 tool calls out of range",
    "F3": "F3 fewer than 2 in-repo Edit/Write calls",
    "F4": "F4 forbidden bash command",
    "F5": "F5 prompt not a self-contained task",
    "F6": "F6 Edit/Write outside repo",
    "H": "H starting commit ambiguous (HEAD moved / no reflog entry)",
    "R": "R not replayable (recorded edits do not apply to the commit)",
}


def canonical_reason(r):
    return REASON_LABELS.get(r.split(" ", 1)[0], r)


def tool_bucket(n):
    if n == 0:
        return "0"
    if n < SPEC_MIN_TOOLS:
        return "1-%d" % (SPEC_MIN_TOOLS - 1)
    if n < PREFERRED_TOOL_RANGE[0]:
        return "%d-%d" % (SPEC_MIN_TOOLS, PREFERRED_TOOL_RANGE[0] - 1)
    if n <= PREFERRED_TOOL_RANGE[1]:
        return "%d-%d" % PREFERRED_TOOL_RANGE
    if n <= SPEC_MAX_TOOLS:
        return "%d-%d" % (PREFERRED_TOOL_RANGE[1] + 1, SPEC_MAX_TOOLS)
    return ">%d" % SPEC_MAX_TOOLS

# --------------------------------------------------------------------------- #
# transcript parsing
# --------------------------------------------------------------------------- #

def load_entries(path):
    out = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def classify_user_entry(e):
    """-> (kind, text, has_image); kind in tool_result|meta|continuation|notice|event|human|other"""
    m = e.get("message") or {}
    c = m.get("content")
    has_image = False
    if isinstance(c, str):
        text = c
    elif isinstance(c, list):
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
            return "tool_result", "", False
        texts = [b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text"]
        has_image = any(isinstance(b, dict) and b.get("type") == "image" for b in c)
        text = "\n\n".join(t for t in texts if t)
    else:
        return "other", "", False
    s = text.strip()
    if e.get("isMeta"):
        return "meta", text, has_image
    if e.get("isCompactSummary") or s.startswith(CONTINUATION_PREFIX):
        return "continuation", text, has_image
    if s.startswith(NOTICE_PREFIXES):
        return "notice", text, has_image
    if s.startswith(EVENT_PREFIXES) or (not s and not has_image):
        return "event", text, has_image
    return "human", text, has_image


def segment_turns(entries):
    turns, cur = [], None
    for e in entries:
        t = e.get("type")
        if t == "user":
            kind, text, img = classify_user_entry(e)
            if kind in ("human", "continuation", "event"):
                cur = {"kind": kind, "prompt": text, "has_image": img, "start": e, "entries": []}
                turns.append(cur)
                continue
        if t in ("user", "assistant") and cur is not None:
            cur["entries"].append(e)
    return turns


def collect_tool_calls(turn):
    calls, by_id = [], {}
    for e in turn["entries"]:
        m = e.get("message") or {}
        c = m.get("content")
        if not isinstance(c, list):
            continue
        if e.get("type") == "assistant":
            for b in c:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    call = {"id": b.get("id"), "name": b.get("name") or "?", "input": b.get("input") or {},
                            "ts": e.get("timestamp"), "executed": False, "error": False, "result": None}
                    calls.append(call)
                    by_id[call["id"]] = call
        elif e.get("type") == "user":
            for b in c:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    call = by_id.get(b.get("tool_use_id"))
                    if call is not None:
                        call["executed"] = True
                        call["error"] = bool(b.get("is_error"))
                        call["result"] = e.get("toolUseResult")
    return calls


def assistant_text(turn):
    out = []
    for e in turn["entries"]:
        if e.get("type") != "assistant":
            continue
        c = (e.get("message") or {}).get("content")
        if isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and b.get("type") == "text" and b.get("text"):
                    out.append(b["text"])
    return "\n\n".join(out)

# --------------------------------------------------------------------------- #
# repo helpers
# --------------------------------------------------------------------------- #

class Repo:
    def __init__(self, root):
        self.root = root
        self.name = os.path.basename(root.rstrip("/"))
        self.reflog = self._load_reflog()
        self.baseline = self.snapshot()
        self.final_check = "not checked"

    def _load_reflog(self):
        out = git(self.root, "reflog", "--date=iso", "--format=%H%x09%gd%x09%gs")
        entries = []
        for line in out.splitlines():
            parts = line.split("\t", 2)
            if len(parts) < 2:
                continue
            sha, gd = parts[0], parts[1]
            subj = parts[2] if len(parts) > 2 else ""
            m = re.search(r"\{(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) ([+-]\d{4})\}", gd)
            if not m:
                continue
            when = dt.datetime.strptime(m.group(1) + " " + m.group(2), "%Y-%m-%d %H:%M:%S %z")
            entries.append((when, sha, subj))
        entries.sort(key=lambda x: x[0], reverse=True)  # newest first
        return entries

    def head_at(self, when):
        for ts, sha, subj in self.reflog:
            if ts <= when:
                return sha, subj, ts
        return None, None, None

    def snapshot(self):
        return {
            "status": git(self.root, "status", "--porcelain=v1", "--untracked-files=all"),
            "worktrees": git(self.root, "worktree", "list", "--porcelain"),
            "head": git(self.root, "rev-parse", "HEAD").strip(),
            "reflog_head": git(self.root, "reflog", "-1", "--format=%H %gd %gs").strip(),
        }

    def verify_clean(self, what="worktrees"):
        now = self.snapshot()
        keys = ["worktrees"] if what == "worktrees" else ["status", "worktrees", "head", "reflog_head"]
        problems = [k for k in keys if now[k] != self.baseline[k]]
        return problems, now


_ROOT_CACHE = {}


def repo_root_for(cwd):
    if cwd in _ROOT_CACHE:
        return _ROOT_CACHE[cwd]
    root = None
    if cwd and os.path.isdir(cwd):
        p = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"], capture_output=True, text=True)
        if p.returncode == 0:
            root = p.stdout.strip()
    _ROOT_CACHE[cwd] = root
    return root

# --------------------------------------------------------------------------- #
# per-turn analysis
# --------------------------------------------------------------------------- #

def classify_path(path, root, projects_root):
    """in-repo | memory | scratch | external"""
    if not path or not os.path.isabs(path):
        return "external"
    norm = os.path.normpath(path)
    if norm == root or norm.startswith(root + os.sep):
        return "in-repo"
    if norm.startswith(os.path.normpath(projects_root) + os.sep) and "/memory/" in norm + "/":
        return "memory"
    if norm.startswith("/private/tmp/") or norm.startswith("/tmp/") or norm.startswith("/var/folders/"):
        return "scratch"
    return "external"


def prompt_problem(prompt, has_image, min_chars, cjk_weight):
    """'' if the prompt looks like a self-contained task, else the reason."""
    if has_image:
        return "prompt has an image attachment"
    s = " ".join((prompt or "").split())
    n = weighted_len(s, cjk_weight)
    if n < min_chars:
        return "prompt shorter than %d chars (%d%s)" % (min_chars, n, "" if cjk_weight == 1 else " cjk-weighted")
    if GREETING_RE.match(s):
        return "prompt is a bare greeting/ack"
    return ""


def prompt_score(p):
    s = 0.0
    n = len(p)
    if 40 <= n <= 3000:
        s += 1
    if re.search(r"[`/]|\.(?:ts|js|mjs|md|json|ya?ml|py|sh)\b|\b(?:src|lib|tests?|docs|scripts?)\b", p):
        s += 1
    if (re.search(r"\b(?:fix|add|implement|refactor|write|update|remove|rename|make|change|create|delete|move|split|extract|build|rewrite|migrate|wire|land)\b", p, re.I)
            or re.search(r"(?:修|改|加|实现|写|删|重构|新增|拆|合并|落地|补|把|让|做|换|收|迁移|升级|接|建|造|去掉|加上|整理|清理|统一)", p)):
        s += 1
    if p.rstrip().endswith(("?", "？")) or re.search(r"(?:为什么|怎么回事|是什么|什么意思|啥意思|why|what is|explain|解释|看看|看下|分析一下)", p, re.I):
        s -= 1
    if re.match(r"^(?:继续|接着|然后|那|那么|再|ok|好|嗯|对)", p.strip()):
        s -= 1
    if REPLY_LIST_RE.match(p):
        s -= 1
    return s


def forbidden_labels(cmd):
    return {label for label, rx in FORBIDDEN_BASH if rx.search(cmd)}


def analyze_turn(turn, repo_root, projects_root, cfg):
    """Populate turn['calls'], turn['reasons'] (filter failures), turn['edits'], turn['deviations'] ..."""
    calls = collect_tool_calls(turn)
    deviations = []

    def is_repo_edit(c):
        return (c["name"] in EDIT_TOOLS and c["executed"] and not c["error"]
                and classify_path(c["input"].get("file_path") or "", repo_root, projects_root) == "in-repo")

    hits = [(i, forbidden_labels(c["input"].get("command") or "")) for i, c in enumerate(calls) if c["name"] == "Bash"]
    hits = [(i, labels) for i, labels in hits if labels]
    last_edit = max((i for i, c in enumerate(calls) if is_repo_edit(c)), default=-1)
    dropped = []
    if cfg.allow_trailing_commit and hits and all(labels == {"git commit"} for _, labels in hits) and hits[0][0] > last_edit:
        cut = hits[0][0]
        dropped, calls = calls[cut:], calls[:cut]
        deviations.append("trailing-commit-truncated: dropped %d trailing call(s) starting at `git commit`" % len(dropped))
        hits = []
    turn["calls"] = calls
    turn["dropped_calls"] = dropped
    reasons = []

    names = collections.Counter(c["name"] for c in calls)
    turn["tool_counts"] = dict(sorted(names.items()))
    bad_tools = sorted(n for n in names if n not in ALLOWED_TOOLS)
    if bad_tools:
        reasons.append("F1 disallowed tool(s): " + ", ".join(bad_tools))

    total = len(calls)
    turn["tool_total"] = total
    if not (cfg.min_tools <= total <= cfg.max_tools):
        reasons.append("F2 tool calls out of range (%d)" % total)
    elif not (SPEC_MIN_TOOLS <= total <= SPEC_MAX_TOOLS):
        deviations.append("F2 relaxed: %d tool calls (spec range %d..%d, configured %d..%d)"
                          % (total, SPEC_MIN_TOOLS, SPEC_MAX_TOOLS, cfg.min_tools, cfg.max_tools))

    edits, external, tolerated = [], [], []
    failed_edits = 0
    for c in calls:
        if c["name"] not in EDIT_TOOLS:
            continue
        if not c["executed"] or c["error"]:
            failed_edits += 1
            continue
        path = c["input"].get("file_path") or ""
        kind = classify_path(path, repo_root, projects_root)
        if kind == "in-repo":
            edits.append(c)
        elif kind == "external":
            external.append(path)
        else:
            tolerated.append({"path": path, "kind": kind, "tool": c["name"]})
    turn["edits"] = edits
    turn["failed_edits"] = failed_edits
    turn["external_edits"] = external
    turn["tolerated_writes"] = tolerated
    if len(edits) < SPEC_MIN_EDITS:
        reasons.append("F3 fewer than %d in-repo Edit/Write calls (%d)" % (SPEC_MIN_EDITS, len(edits)))

    bash_cmds = [c["input"].get("command") or "" for c in calls if c["name"] == "Bash"]
    turn["bash_commands"] = bash_cmds
    forbidden = set()
    for _, labels in hits:
        forbidden |= labels
    if forbidden:
        reasons.append("F4 forbidden bash: " + ", ".join(sorted(forbidden)))
    soft = collections.OrderedDict()
    for cmd in bash_cmds:
        for label, rx in SOFT_FLAGS:
            if rx.search(cmd):
                soft[label] = soft.get(label, 0) + 1
    turn["soft_flags"] = dict(soft)

    why = prompt_problem(turn["prompt"], turn["has_image"], cfg.min_prompt_chars, cfg.cjk_weight)
    if why:
        reasons.append("F5 " + why)
    else:
        spec_why = prompt_problem(turn["prompt"], turn["has_image"], SPEC_MIN_PROMPT_CHARS, 1)
        if spec_why:
            deviations.append("F5 relaxed: " + spec_why)
    turn["prompt_flags"] = ["reply-list"] if REPLY_LIST_RE.match(turn["prompt"]) else []

    if external:
        reasons.append("F6 Edit/Write outside repo: " + ", ".join(sorted(set(external)))[:200])

    ext_reads = []
    for c in calls:
        if c["name"] in ("Read", "Grep", "Glob"):
            p = c["input"].get("file_path") or c["input"].get("path") or ""
            if p and classify_path(p, repo_root, projects_root) == "external":
                ext_reads.append(p)
    turn["external_reads"] = sorted(set(ext_reads))

    # timestamps
    turn["ts"] = parse_iso_utc(turn["start"].get("timestamp"))
    first_action = next((c["ts"] for c in calls if c["ts"]), None)
    turn["first_action_ts"] = parse_iso_utc(first_action) if first_action else None
    if dropped:
        last = next((c["ts"] for c in reversed(calls) if c["ts"]), None)
    else:
        last = None
        for e in turn["entries"]:
            if e.get("timestamp"):
                last = e["timestamp"]
    turn["end_ts"] = parse_iso_utc(last) if last else None
    turn["reasons"] = reasons
    turn["deviations"] = deviations
    return reasons

# --------------------------------------------------------------------------- #
# replay
# --------------------------------------------------------------------------- #

class ReplayError(Exception):
    pass


def read_text(path):
    with open(path, "rb") as fh:
        return fh.read().decode("utf-8", errors="surrogateescape")


def write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(text.encode("utf-8", errors="surrogateescape"))


def apply_edit(path, old, new, replace_all):
    """Returns 'exact' | 'quote-normalized' | 'created'."""
    if not os.path.isfile(path):
        if old == "":
            write_text(path, new)
            return "created"
        raise ReplayError("Edit target does not exist in worktree")
    if old == "":
        raise ReplayError("Edit with empty old_string on an existing file")
    if old == new:
        return "exact"  # the real tool refuses no-op edits; nothing to do
    text = read_text(path)
    n = text.count(old)
    mode = "exact"
    if n == 0:
        nt, no = normalize_quotes(text), normalize_quotes(old)
        n = nt.count(no)
        if n == 0:
            raise ReplayError("old_string not found")
        if n > 1 and not replace_all:
            raise ReplayError("old_string ambiguous (%d matches)" % n)
        mode = "quote-normalized"
        pieces, i = [], 0
        while True:
            j = nt.find(no, i)
            if j < 0:
                break
            pieces.append(text[i:j])
            pieces.append(new)
            i = j + len(no)
            if not replace_all:
                break
        pieces.append(text[i:])
        text = "".join(pieces)
    else:
        if n > 1 and not replace_all:
            raise ReplayError("old_string ambiguous (%d matches)" % n)
        text = text.replace(old, new) if replace_all else text.replace(old, new, 1)
    write_text(path, text)
    return mode


def whitespace_only_diff(a, b):
    return re.sub(r"\s+", "", a) == re.sub(r"\s+", "", b)


def replay_turn(turn, repo, wt_dir, strict):
    """Apply the turn's in-repo edits inside a fresh worktree. Fills turn['files'], turn['replay'].
    Raises ReplayError on starting-state mismatch.  The caller removes the worktree."""
    if os.path.exists(wt_dir):
        shutil.rmtree(wt_dir)
    git(repo.root, "worktree", "add", "--detach", wt_dir, turn["sha"])
    files = collections.OrderedDict()   # relpath -> info
    stats = collections.Counter()
    warnings = []
    for n, c in enumerate(turn["edits"], 1):
        inp = c["input"]
        abspath = os.path.normpath(inp.get("file_path"))
        rel = os.path.relpath(abspath, repo.root)
        if rel.startswith(".."):
            raise ReplayError("path escapes repo: " + rel)
        target = os.path.join(wt_dir, rel)
        exists = os.path.isfile(target)
        before = read_text(target) if exists else None
        if rel not in files:
            files[rel] = {"path": rel, "existedAtCommit": exists,
                          "sha256Before": sha256_bytes(before.encode("utf-8", "surrogateescape")) if exists else None}
        res = c["result"] if isinstance(c["result"], dict) else {}
        where = "edit #%d %s %s" % (n, c["name"], rel)
        # strict starting-state guard using the recorded pre-edit content
        recorded = res.get("originalFile")
        if strict:
            if isinstance(recorded, str):
                if before is None:
                    raise ReplayError("%s: transcript recorded pre-edit content but the file is absent at the commit" % where)
                if recorded != before:
                    if whitespace_only_diff(recorded, before):
                        warnings.append("%s: pre-edit content differs only in whitespace" % where)
                        stats["strict-whitespace"] += 1
                    else:
                        raise ReplayError("%s: pre-edit content differs from the commit (recorded %d chars vs %d in worktree)"
                                          % (where, len(recorded), len(before)))
                else:
                    stats["strict-verified"] += 1
            elif c["name"] == "Write" and res.get("type") == "create" and exists:
                raise ReplayError("%s: recorded as a fresh create but the file exists at the commit" % where)
        if res.get("userModified"):
            stats["user-modified"] += 1
        try:
            if c["name"] == "Write":
                content = inp.get("content")
                if isinstance(res.get("content"), str) and res.get("content") != content:
                    content = res["content"]   # what actually landed on disk
                    stats["content-from-result"] += 1
                if not isinstance(content, str):
                    raise ReplayError("Write without string content")
                write_text(target, content)
                stats["write"] += 1
            else:
                mode = apply_edit(target, inp.get("old_string", ""), inp.get("new_string", ""),
                                  bool(inp.get("replace_all")))
                stats["edit"] += 1
                if mode == "quote-normalized":
                    stats["quote-normalized"] += 1
        except ReplayError as exc:
            raise ReplayError("%s: %s" % (where, exc))
    for rel, info in files.items():
        target = os.path.join(wt_dir, rel)
        if os.path.isfile(target):
            with open(target, "rb") as fh:
                data = fh.read()
            info["sha256After"] = sha256_bytes(data)
            info["bytes"] = len(data)
            info["status"] = "modified" if info["existedAtCommit"] else "created"
            info["_src"] = target
        else:
            info["sha256After"], info["bytes"], info["status"] = None, 0, "missing"
    turn["files"] = list(files.values())
    turn["replay"] = {"stats": dict(stats), "warnings": warnings}


def remove_worktree(repo, wt_dir):
    if not os.path.exists(wt_dir):
        return
    try:
        git(repo.root, "worktree", "remove", "--force", wt_dir)
    except RuntimeError as exc:
        log("  ! worktree remove failed: %s" % exc)
    if os.path.exists(wt_dir):
        shutil.rmtree(wt_dir, ignore_errors=True)
        git(repo.root, "worktree", "prune", check=False)


def annotate_bash_mentions(turn):
    """Per touched file: how many Bash commands of the turn mention it (and how many of those look mutating).
    A file the oracle says was only Edit/Write-ed but that Bash also rewrote is worth a second look."""
    mut_rxs = [rx for label, rx in SOFT_FLAGS if label in ("shell-file-mutation", "inline-script-write")]
    for f in turn["files"]:
        rel, base = f["path"], os.path.basename(f["path"])
        hits = [cmd for cmd in turn["bash_commands"] if rel in cmd or base in cmd]
        f["bashMentions"] = len(hits)
        f["bashMutatingMentions"] = sum(1 for cmd in hits if any(rx.search(cmd) for rx in mut_rxs))


def next_commit_check(turn, repo, all_turns):
    """Informational cross-check (read-only): compare the oracle with the first commit recorded after the
    turn.  Meaningful when no other edit-making turn sits between the two (interveningTurnsWithEdits == 0);
    otherwise later work is expected to differ."""
    end = turn.get("end_ts")
    if end is None:
        return None
    later = [(ts, sha, subj) for ts, sha, subj in reversed(repo.reflog) if ts > end and subj.startswith("commit")]
    if not later:
        return None
    ts, sha, subj = later[0]
    intervening = sum(1 for o in all_turns if o is not turn and o["repo"] is repo and o.get("ts")
                      and end < o["ts"] < ts and len(o.get("edits", [])) > 0)
    res = collections.OrderedDict([
        ("sha", sha), ("subject", subj), ("time", to_local(ts)),
        ("secondsAfterTurnEnd", int((ts - end).total_seconds())),
        ("interveningTurnsWithEdits", intervening),
        ("match", []), ("differ", []), ("absent", []),
    ])
    for f in turn["files"]:
        p = subprocess.run(["git", "-C", repo.root, "show", "%s:%s" % (sha, f["path"])], capture_output=True)
        if p.returncode != 0:
            res["absent"].append(f["path"])
        elif sha256_bytes(p.stdout) == f["sha256After"]:
            res["match"].append(f["path"])
        else:
            res["differ"].append(f["path"])
    return res


def next_commit_cell(t):
    nc = t.get("next_commit")
    if not nc:
        return "-"
    return "%d/%d match %s (+%ds, %d intervening edit-turn%s)" % (
        len(nc["match"]), len(t["files"]), nc["sha"][:7], nc["secondsAfterTurnEnd"],
        nc["interveningTurnsWithEdits"], "" if nc["interveningTurnsWithEdits"] == 1 else "s")

# --------------------------------------------------------------------------- #
# scoring / output
# --------------------------------------------------------------------------- #

def score_turn(turn):
    s = 0.0
    n = turn["tool_total"]
    s += 2.0 if PREFERRED_TOOL_RANGE[0] <= n <= PREFERRED_TOOL_RANGE[1] else 0.5
    s += 0.5 * min(len(turn.get("files", [])), 6)
    s += prompt_score(turn["prompt"])
    flags = turn.get("soft_flags", {})
    if "git-head-mutation" in flags:
        s -= 2.0
    if "git-network" in flags:
        s -= 1.0
    if "build" in flags:
        s -= 0.5
    if "shell-file-mutation" in flags:
        s -= 0.5
    if "inline-script-write" in flags:
        s -= 0.5
    # oracle files that Bash may also have rewritten: the Edit/Write replay cannot see those changes
    s -= 0.5 * min(sum(1 for f in turn.get("files", []) if f.get("bashMutatingMentions")), 4)
    st = turn.get("replay", {}).get("stats", {})
    s -= 1.0 * st.get("strict-whitespace", 0)
    s -= 0.5 * st.get("quote-normalized", 0)
    s -= 1.0 * st.get("user-modified", 0)
    s -= 0.5 * min(len(turn.get("external_reads", [])), 4)
    s += 0.5 * min(st.get("strict-verified", 0), 4)
    s -= 0.5 * len(turn.get("deviations", []))
    return round(s, 2)


def build_meta(turn, repo):
    st = turn["replay"]["stats"]
    return collections.OrderedDict([
        ("id", turn["id"]),
        ("repo", repo.name),
        ("cwd", turn["start"].get("cwd")),
        ("repoRoot", repo.root),
        ("sessionId", turn["session"]),
        ("turnIndex", turn["index"]),
        ("sha", turn["sha"]),
        ("shaReflogEntry", turn["sha_subject"]),
        ("shaReflogTime", to_local(turn["sha_time"])),
        ("gitBranch", turn["start"].get("gitBranch")),
        ("timestamp", turn["start"].get("timestamp")),
        ("timestampLocal", to_local(turn["ts"])),
        ("firstToolCallTimestamp", turn["first_action_ts"].isoformat() if turn["first_action_ts"] else None),
        ("endTimestamp", turn["end_ts"].isoformat() if turn["end_ts"] else None),
        ("durationSec", round((turn["end_ts"] - turn["ts"]).total_seconds(), 1) if turn["end_ts"] else None),
        ("toolCalls", turn["tool_counts"]),
        ("toolCallTotal", turn["tool_total"]),
        ("editCount", len(turn["edits"])),
        ("failedToolCalls", sum(1 for c in turn["calls"] if c["error"] or not c["executed"])),
        ("failedEditCalls", turn["failed_edits"]),
        ("bashCommands", turn["bash_commands"]),
        ("droppedTrailingCalls", [{"name": c["name"], "command": c["input"].get("command")} for c in turn["dropped_calls"]]),
        ("touchedFiles", [f["path"] for f in turn["files"]]),
        ("files", [{k: v for k, v in f.items() if not k.startswith("_")} for f in turn["files"]]),
        ("nextCommitCheck", turn.get("next_commit")),
        ("toleratedExternalWrites", turn["tolerated_writes"]),
        ("externalReads", turn["external_reads"]),
        ("specDeviations", turn["deviations"]),
        ("flags", collections.OrderedDict([
            ("bash", turn["soft_flags"]),
            ("prompt", turn["prompt_flags"]),
            ("replay", st),
            ("warnings", turn["replay"]["warnings"]),
        ])),
        ("promptChars", len(turn["prompt"])),
        ("contextTurns", len(turn.get("prev_turns", []))),
        ("score", turn["score"]),
        ("rank", turn["rank"]),
        ("selected", turn["selected"]),
    ])


def context_text(turn):
    prev = turn.get("prev_turns") or []
    if not prev:
        return None
    L = ["# Context: the %d human/assistant exchange(s) that preceded this turn in the same session." % len(prev),
         "# prompt.txt is the turn's own message; this file is additive background (the prompt may answer",
         "# questions the assistant asked here).  Tool calls of those turns are summarised, not replayed.",
         ""]
    for k, p in enumerate(prev):
        off = len(prev) - k
        L.append("## [-%d] human  (%s, %d tool calls in that turn)" % (off, p["start"].get("timestamp"), p["tool_total"]))
        L.append(p["prompt"].rstrip())
        L.append("")
        a = assistant_text(p)
        if a:
            if len(a) > 6000:
                a = a[:6000] + "\n[... truncated ...]"
            L.append("## [-%d] assistant" % off)
            L.append(a.rstrip())
            L.append("")
    return "\n".join(L)


def write_corpus_dir(turn, repo, corpus_dir):
    d = os.path.join(corpus_dir, turn["id"])
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "prompt.txt"), "w", encoding="utf-8") as fh:
        fh.write(turn["prompt"])
    ctx = context_text(turn)
    if ctx:
        with open(os.path.join(d, "context.txt"), "w", encoding="utf-8") as fh:
            fh.write(ctx)
    for f in turn["files"]:
        src = f.get("_src")
        if src and os.path.isfile(src):
            dst = os.path.join(d, "oracle", f["path"])
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copyfile(src, dst)
    with open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(build_meta(turn, repo), fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def write_index(path, replayable, rejected, ignored, summary, repos, cfg):
    L = []
    L.append("# Replay corpus index")
    L.append("")
    L.append("Generated %s by `extract-turns.py %s`." % (
        dt.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %z"), md_cell(" ".join(sys.argv[1:]))))
    L.append("")
    L.append("## Summary")
    L.append("")
    for k, v in summary.items():
        if isinstance(v, dict):
            continue
        L.append("- %s: %s" % (k, v))
    L.append("")
    L.append("## Replayable turns")
    L.append("")
    L.append("`sel` = written to `%s/<id>/` (top %s by score; `--keep-all` writes every replayable turn).  "
             "`deviations` lists the opt-in relaxations a turn needed (empty = passes the spec filters literally)."
             % (os.path.basename(os.path.dirname(path)), summary.get("maxKeep")))
    L.append("")
    L.append("| sel | id | repo | sha | timestamp (UTC) | tools | edits | files | score | deviations | flags | oracle vs next commit | prompt (80) |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for t in replayable:
        flags = list(t["soft_flags"].keys()) + t["prompt_flags"] + [
            "replay:%s=%s" % (k, v) for k, v in t["replay"]["stats"].items()
            if k in ("strict-whitespace", "quote-normalized", "user-modified", "content-from-result")]
        L.append("| %s | %s | %s | %s | %s | %d | %d | %d | %.1f | %s | %s | %s | %s |" % (
            "x" if t["selected"] else "", ("[%s](%s/)" % (t["id"], t["id"])) if t["selected"] else t["id"],
            t["repo"].name, t["sha"][:7], t["start"].get("timestamp"), t["tool_total"], len(t["edits"]),
            len(t["files"]), t["score"], md_cell("; ".join(t["deviations"])) or "-", md_cell(", ".join(flags)) or "-",
            next_commit_cell(t), first_chars(t["prompt"], 80)))
    L.append("")
    L.append("## Rejected turns")
    L.append("")
    L.append("### Counts per primary reason")
    L.append("")
    counts = collections.Counter(canonical_reason(t["primary"]) for t in rejected)
    L.append("| primary reason (first failing filter) | count |")
    L.append("|---|---|")
    for r, n in sorted(counts.items(), key=lambda x: (-x[1], x[0])):
        L.append("| %s | %d |" % (md_cell(r), n))
    L.append("")
    L.append("Counts per filter code, all failures (a turn may fail several): " + ", ".join(
        "%s=%d" % (k, v) for k, v in sorted(summary.get("rejectCodeCounts", {}).items())))
    L.append("")
    L.append("Tool calls per human turn: " + ", ".join(
        "%s: %d" % (k, v) for k, v in sorted(summary.get("toolCountBuckets", {}).items(),
                                             key=lambda kv: int(re.sub(r"[^\d].*", "", kv[0]) or "0"))))
    L.append("")
    detailed = collections.Counter(t["primary"] for t in rejected)
    L.append("<details><summary>Detailed primary reasons (top 25)</summary>")
    L.append("")
    L.append("| reason | count |")
    L.append("|---|---|")
    for r, n in sorted(detailed.items(), key=lambda x: (-x[1], x[0]))[:25]:
        L.append("| %s | %d |" % (md_cell(r), n))
    L.append("")
    L.append("</details>")
    L.append("")
    near = [t for t in rejected if t["tool_total"] >= SPEC_MIN_TOOLS and len(t.get("edits", [])) >= SPEC_MIN_EDITS]
    L.append("### Near misses (>= %d tool calls and >= %d in-repo edits, but rejected)" % (SPEC_MIN_TOOLS, SPEC_MIN_EDITS))
    L.append("")
    if near:
        L.append("| id | repo | tools | edits | reasons | prompt (60) |")
        L.append("|---|---|---|---|---|---|")
        for t in near:
            L.append("| %s | %s | %d | %d | %s | %s |" % (
                t["id"], t["repo"].name, t["tool_total"], len(t["edits"]), md_cell("; ".join(t["reasons"]), 220),
                first_chars(t["prompt"], 60)))
    else:
        L.append("(none)")
    L.append("")
    L.append("### List")
    L.append("")
    L.append("| id | repo | tools | edits | primary reason | all reasons | prompt (60) |")
    L.append("|---|---|---|---|---|---|---|")
    for t in rejected:
        L.append("| %s | %s | %d | %d | %s | %s | %s |" % (
            t["id"], t["repo"].name, t["tool_total"], len(t.get("edits", [])), md_cell(t["primary"]),
            md_cell("; ".join(t["reasons"]), 220), first_chars(t["prompt"], 60)))
    L.append("")
    L.append("### Skipped user entries (not counted as turns)")
    L.append("")
    for k, v in sorted(ignored.items()):
        L.append("- %s: %d" % (k, v))
    L.append("")
    L.append("## Repo integrity check")
    L.append("")
    for r in repos.values():
        L.append("- `%s`: %s" % (r.root, r.final_check))
    L.append("")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(L))

# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=DEFAULT_OUT, help="output root (<out-name>/ and worktrees/ are created here)")
    ap.add_argument("--out-name", default="corpus", help="name of the corpus directory under --out")
    ap.add_argument("--projects-root", default=DEFAULT_PROJECTS_ROOT)
    ap.add_argument("--project", action="append", help="project dir name under projects root (repeatable)")
    ap.add_argument("--max-keep", type=int, default=15, help="corpus dirs to write (best by score)")
    ap.add_argument("--keep-all", action="store_true", help="write a corpus dir for every replayable turn")
    ap.add_argument("--dry-run", action="store_true", help="filters + HEAD lookup only, no worktrees, no corpus")
    ap.add_argument("--no-strict", action="store_true", help="disable the recorded pre-edit content guard")
    ap.add_argument("--min-tools", type=int, default=SPEC_MIN_TOOLS)
    ap.add_argument("--max-tools", type=int, default=SPEC_MAX_TOOLS)
    ap.add_argument("--min-prompt-chars", type=int, default=SPEC_MIN_PROMPT_CHARS)
    ap.add_argument("--cjk-weight", type=int, default=1, help="weight of a CJK character for the prompt length (spec: 1)")
    ap.add_argument("--allow-trailing-commit", action="store_true",
                    help="truncate a turn before a trailing `git commit` instead of rejecting it")
    ap.add_argument("--relaxed", action="store_true", help="= --allow-trailing-commit --cjk-weight 2")
    ap.add_argument("--verbose", "-v", action="store_true")
    cfg = ap.parse_args()
    if cfg.relaxed:
        cfg.allow_trailing_commit = True
        cfg.cjk_weight = max(cfg.cjk_weight, 2)

    projects = cfg.project or DEFAULT_PROJECTS
    out_root = os.path.abspath(cfg.out)
    corpus_dir = os.path.join(out_root, cfg.out_name)
    wt_root = os.path.join(out_root, "worktrees")
    os.makedirs(wt_root, exist_ok=True)
    if not cfg.dry_run:
        if os.path.isdir(corpus_dir):
            shutil.rmtree(corpus_dir)
        os.makedirs(corpus_dir)

    # ---- gather turns ------------------------------------------------------
    repos = {}          # root -> Repo
    all_turns = []
    ignored = collections.Counter()
    per_repo_counter = collections.Counter()
    for proj in projects:
        pdir = os.path.join(cfg.projects_root, proj)
        if not os.path.isdir(pdir):
            log("!! project dir missing: %s" % pdir)
            continue
        sessions = []
        for f in os.listdir(pdir):
            if f.endswith(".jsonl"):
                entries = load_entries(os.path.join(pdir, f))
                first_ts = next((e.get("timestamp") for e in entries if e.get("timestamp")), "")
                sessions.append((first_ts, os.path.join(pdir, f), entries))
        sessions.sort(key=lambda x: x[0])
        for first_ts, f, entries in sessions:
            session_id = os.path.splitext(os.path.basename(f))[0]
            turns = segment_turns(entries)
            log("scan %s: %d entries, %d user turn starts" % (os.path.basename(f), len(entries), len(turns)))
            session_human = []
            for t in turns:
                cwd = t["start"].get("cwd") or ""
                if t["kind"] == "event":
                    ignored["non-task user event (slash command / interrupt marker)"] += 1
                    continue
                if t["kind"] == "continuation":
                    ignored["continuation summary (This session is being continued)"] += 1
                    continue
                root = repo_root_for(cwd)
                if not root:
                    ignored["cwd not a git repo"] += 1
                    continue
                if root not in repos:
                    repos[root] = Repo(root)
                    log("repo %s: %d reflog entries, baseline HEAD %s" % (root, len(repos[root].reflog), repos[root].baseline["head"][:7]))
                repo = repos[root]
                per_repo_counter[repo.name] += 1
                t["repo"] = repo
                t["session"] = session_id
                t["index"] = per_repo_counter[repo.name]
                t["id"] = "%s-%03d" % (repo.name, t["index"])
                analyze_turn(t, root, cfg.projects_root, cfg)
                t["prev_turns"] = session_human[-CONTEXT_TURNS:]
                session_human.append(t)
                all_turns.append(t)

    # ---- HEAD reconstruction + replay --------------------------------------
    replayable, rejected = [], []
    code_counts = collections.Counter()
    for t in all_turns:
        repo = t["repo"]
        reasons = list(t["reasons"])
        for r in reasons:
            code_counts[r.split(" ", 1)[0]] += 1
        t["sha"] = None
        if t["ts"] is not None:
            sha, subj, when = repo.head_at(t["ts"])
            if sha is None:
                reasons.append("H no reflog entry at/before the turn timestamp")
            else:
                t["sha"], t["sha_subject"], t["sha_time"] = sha, subj, when
                t["id"] = "%s-%s" % (t["id"], sha[:7])
                if t["first_action_ts"] is not None:
                    sha2 = repo.head_at(t["first_action_ts"])[0]
                    if sha2 != sha:
                        reasons.append("H HEAD moved between prompt and first tool call (%s -> %s)" % (sha[:7], (sha2 or "?")[:7]))
                if t["end_ts"] is not None:
                    sha3 = repo.head_at(t["end_ts"])[0]
                    if sha3 != sha:
                        reasons.append("H HEAD moved during the turn (%s -> %s)" % (sha[:7], (sha3 or "?")[:7]))
        else:
            reasons.append("H turn has no timestamp")
        if reasons:
            t["reasons"] = reasons
            t["primary"] = reasons[0]
            rejected.append(t)
            if cfg.verbose:
                log("reject %s: %s" % (t["id"], reasons[0]))
            continue
        if cfg.dry_run:
            t["files"] = []
            t["replay"] = {"stats": {}, "warnings": []}
            t["next_commit"] = None
            replayable.append(t)
            log("candidate %s tools=%d edits=%d :: %s" % (t["id"], t["tool_total"], len(t["edits"]), first_chars(t["prompt"], 70)))
            continue
        wt_dir = os.path.join(wt_root, t["id"])
        try:
            replay_turn(t, repo, wt_dir, strict=not cfg.no_strict)
            # stage the oracle before the worktree disappears
            stage = os.path.join(wt_root, t["id"] + ".oracle")
            if os.path.exists(stage):
                shutil.rmtree(stage)
            for f in t["files"]:
                src = f.get("_src")
                if src and os.path.isfile(src):
                    dst = os.path.join(stage, f["path"])
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.copyfile(src, dst)
                    f["_src"] = dst
            annotate_bash_mentions(t)
            t["next_commit"] = next_commit_check(t, repo, all_turns)
            replayable.append(t)
            log("replay OK %s tools=%d edits=%d files=%d :: %s" % (
                t["id"], t["tool_total"], len(t["edits"]), len(t["files"]), first_chars(t["prompt"], 60)))
        except ReplayError as exc:
            t["reasons"] = ["R not replayable: %s" % exc]
            t["primary"] = t["reasons"][0]
            code_counts["R"] += 1
            rejected.append(t)
            log("replay FAIL %s: %s" % (t["id"], exc))
        finally:
            remove_worktree(repo, wt_dir)
            problems, _ = repo.verify_clean("worktrees")
            if problems:
                log("!! worktree list of %s changed after cleanup: %s" % (repo.root, problems))
                sys.exit(2)

    # ---- select + write ----------------------------------------------------
    for t in replayable:
        t["score"] = score_turn(t)
    replayable.sort(key=lambda t: (-t["score"], t["start"].get("timestamp") or ""))
    for i, t in enumerate(replayable, 1):
        t["rank"] = i
        t["selected"] = cfg.keep_all or i <= cfg.max_keep
    if not cfg.dry_run:
        for t in replayable:
            if t["selected"]:
                write_corpus_dir(t, t["repo"], corpus_dir)
        for t in replayable:
            stage = os.path.join(wt_root, t["id"] + ".oracle")
            if os.path.isdir(stage):
                shutil.rmtree(stage)

    # ---- integrity ---------------------------------------------------------
    all_clean = True
    for r in repos.values():
        problems, now = r.verify_clean("all")
        if problems:
            all_clean = False
            r.final_check = "CHANGED: %s (before/after HEAD %s/%s)" % (problems, r.baseline["head"][:7], now["head"][:7])
        else:
            r.final_check = "unchanged (status, worktree list, HEAD %s, reflog head)" % now["head"][:7]

    rejected.sort(key=lambda t: (t["repo"].name, t["index"]))
    summary = collections.OrderedDict([
        ("projects", ", ".join(projects)),
        ("humanTurnsScanned", len(all_turns)),
        ("replayable", len(replayable)),
        ("replayableSpecLiteral", sum(1 for t in replayable if not t["deviations"])),
        ("replayableViaRelaxation", sum(1 for t in replayable if t["deviations"])),
        ("selected", sum(1 for t in replayable if t["selected"])),
        ("rejected", len(rejected)),
        ("maxKeep", "all" if cfg.keep_all else cfg.max_keep),
        ("filters", "tools %d..%d, prompt >= %d chars (cjk weight %d), trailing-commit truncation %s, strict guard %s"
         % (cfg.min_tools, cfg.max_tools, cfg.min_prompt_chars, cfg.cjk_weight,
            "on" if cfg.allow_trailing_commit else "off", "off" if cfg.no_strict else "on")),
        ("dryRun", cfg.dry_run),
        ("reposClean", all_clean),
        ("toolCountBuckets", dict(collections.Counter(tool_bucket(t["tool_total"]) for t in all_turns))),
        ("rejectCodeCounts", dict(code_counts)),
        ("rejectPrimaryCounts", dict(collections.Counter(canonical_reason(t["primary"]) for t in rejected))),
        ("rejectPrimaryCountsDetailed", dict(collections.Counter(t["primary"] for t in rejected))),
        ("skippedUserEntries", dict(ignored)),
    ])
    if not cfg.dry_run:
        write_index(os.path.join(corpus_dir, "INDEX.md"), replayable, rejected, ignored, summary, repos, cfg)
        with open(os.path.join(corpus_dir, "summary.json"), "w", encoding="utf-8") as fh:
            json.dump(summary, fh, ensure_ascii=False, indent=2)
            fh.write("\n")

    # ---- stdout report -----------------------------------------------------
    print("scanned human turns: %d | replayable: %d (spec-literal %d, via relaxation %d; selected %d) | rejected: %d | skipped user entries: %s" % (
        len(all_turns), len(replayable), summary["replayableSpecLiteral"], summary["replayableViaRelaxation"],
        summary["selected"], len(rejected), dict(ignored)))
    print("reject codes: %s" % dict(sorted(code_counts.items())))
    for r in repos.values():
        print("repo %s: %s" % (r.root, r.final_check))
    print()
    print("tool calls per human turn: %s" % dict(sorted(summary["toolCountBuckets"].items(),
                                                        key=lambda kv: int(re.sub(r"[^\d].*", "", kv[0]) or "0"))))
    print("primary reject reasons: %s" % dict(sorted(summary["rejectPrimaryCounts"].items(), key=lambda kv: -kv[1])))
    print()
    print("| sel | id | tools | edits | files | score | deviations | oracle vs next commit | prompt |")
    for t in replayable:
        print("| %s | %s | %d | %d | %d | %.1f | %s | %s | %s |" % (
            "x" if t["selected"] else " ", t["id"], t["tool_total"], len(t["edits"]), len(t["files"]), t["score"],
            "; ".join(t["deviations"]) or "-", next_commit_cell(t), first_chars(t["prompt"], 80)))
    return 0 if all_clean else 3


if __name__ == "__main__":
    sys.exit(main())
