"""R3 p110_r3_runbook_middle: two facts in the middle of a long prose runbook.

setup() writes docs/runbook.txt: 420 lines / about 28 KB of seeded prose, above
the fold's minChars (6000), so the T1 `read` result reaches the model only as a
condensed view. The digest keeps the first 10 and last 4 lines of the tool
result; the read envelope adds three lines before and three after the file
text, so file lines 1-7 and the last file line survive the fold.

- Target 1 (T1, in-turn fold recovery), prose line ~180:
  "...dial extension 64471 for the night-shift escalation desk..."
  Decoy in the kept head (line 4): "day-shift escalation desk on extension 64417".
- Target 2 (T3, cross-turn recall of the T1 read), prose line ~300:
  "...the backup datacenter is Brackenfold..."
  Decoy on the kept last line: "primary datacenter Aldergate".

No line may look structured, code-like or log-like to src/slice/result-digest.ts
(asserted below with copies of its regexes), so the targets are dropped from the
condensed view and only a retrieval (expand_result grep/lines, read with an
offset, grep) can surface them.
"""
import os
import random
import re

SEED = 20260927
TARGET_EXT = "Outside those hours, dial extension 64471 for the night-shift escalation desk and give the ticket number."
DECOY_EXT = "Weekday problems go to the day-shift escalation desk on extension 64417 until six in the evening."
TARGET_DR = "If the primary site goes dark, the backup datacenter is Brackenfold, reached over the east peering link."
DECOY_DR = "Routine customer traffic is served from the primary datacenter Aldergate on every normal day."
OPENING = [
    "This runbook describes how the operations group runs the ingest platform day to day.",
    "It is written for new responders and for anyone covering a shift at short notice.",
    "Read it once from start to finish before your first rotation.",
    DECOY_EXT,
    "Keep the ticket open until the customer confirms the fix in writing.",
    "Hand every open ticket to the next shift with a short written summary.",
    "The sections below follow the order of a normal working week.",
]
MIDDLE_EXTRA = {
    90: "The facilities desk answers on extension 30912 for badge and door problems.",
    240: "The staging datacenter is refreshed from snapshots every Sunday afternoon.",
}
TARGET_EXT_LINE = 180
TARGET_DR_LINE = 300
TOTAL_LINES = 420

SUBJECTS = ["The storage team", "Each shift lead", "The release manager", "Whoever holds the pager", "The database group",
            "Support engineers", "The network desk", "A duty manager", "The platform crew", "Any responder", "The security officer",
            "The capacity planner"]
VERBS = ["reviews", "confirms", "records", "checks", "updates", "announces", "rotates", "archives", "verifies", "summarizes",
         "escalates", "signs off"]
OBJECTS = ["the queue depth before handing over", "the change calendar at the start of the week", "open incidents in the shared tracker",
           "the certificate expiry report", "the replication lag on the reporting replicas", "the capacity forecast for the next quarter",
           "the vendor contact sheet", "stale feature flags in the admin console", "the restore drill results", "the handover notes",
           "the disk usage trend on the archive volumes", "the access review for contractors", "the latency budget for the public API",
           "the spare hardware inventory"]
TAILS = ["every morning", "once per shift", "before any deployment", "after each maintenance window", "at the end of the day",
         "whenever a customer escalates", "during the weekly review", "when the dashboard turns amber", "on the first working day of the month",
         "as soon as the night batch completes"]

# Copies of src/slice/result-digest.ts (STRUCTURED, CODE_LINE, LOG_LINE) used to assert the prose is plain data.
STRUCTURED = re.compile(r"^\s*(?:[A-Za-z_][\w.\-/]*(?: [\w.\-/]+)?\s*[=:]\s*\S|#{1,6}\s|\[[^\]]+\]\s*$|```|\|.*\||[-*•]\s+\S|\d{1,3}[.)]\s+\S)")
CODE_LINE = re.compile(r"^\s*(?:def |class |function\b|func |fn |import |from .+ import |#include|package |return\b|if\b.*[:{]\s*$|for\b.*[:{]\s*$|while\b.*[:{]\s*$|else\b|try\b|except\b|catch\b|\}\s*$|\{\s*$|export |const |let |var |public |private |static |@\w+)")
LOG_LINE = re.compile(r"^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|^\s*\[?\d{2}:\d{2}:\d{2}|\b(?:ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL|PANIC|CRITICAL)\b|\b(?:PASSED|FAILED|SKIPPED|passed|failed|error\[E\d+\]|Traceback|Exception|npm (?:ERR|WARN)!|Compiling|warning:|error:)\b|^\s+at \S+ \(|^\s+File \"|^(?:ok|not ok) \d|^\s*[✓✗]")


def runbook_lines():
    r = random.Random(SEED)
    lines = list(OPENING) + [""]
    fixed = {TARGET_EXT_LINE: TARGET_EXT, TARGET_DR_LINE: TARGET_DR, **MIDDLE_EXTRA}
    para = 0
    while len(lines) < TOTAL_LINES - 1:
        n = len(lines) + 1  # 1-based number of the line about to be written
        if n in fixed:
            lines.append(fixed[n])
            para += 1
            continue
        if para >= r.randint(5, 9):
            lines.append("")
            para = 0
            continue
        subject, verb, obj, tail = r.choice(SUBJECTS), r.choice(VERBS), r.choice(OBJECTS), r.choice(TAILS)
        lines.append("%s %s %s %s." % (subject, verb, obj, tail) if r.random() < 0.45 else "%s %s %s." % (subject, verb, obj))
        para += 1
    lines.append(DECOY_DR)
    return lines


def setup(root):
    lines = runbook_lines()
    text = "\n".join(lines) + "\n"
    assert len(lines) == TOTAL_LINES, len(lines)
    assert lines[TARGET_EXT_LINE - 1] == TARGET_EXT and lines[TARGET_DR_LINE - 1] == TARGET_DR
    assert lines[3] == DECOY_EXT and lines[-1] == DECOY_DR
    assert 22_000 <= len(text) <= 30_000, len(text)
    for line in lines:
        assert not STRUCTURED.search(line), line
        assert not CODE_LINE.search(line), line
        assert not LOG_LINE.search(line), line
        assert ":" not in line and "=" not in line and len(line) < 1500, line
    assert text.count("64471") == 1 and text.count("Brackenfold") == 1 and text.count("night-shift") == 1
    os.makedirs(os.path.join(root, "docs"), exist_ok=True)
    os.makedirs(os.path.join(root, "lib"), exist_ok=True)
    os.makedirs(os.path.join(root, "answers"), exist_ok=True)
    with open(os.path.join(root, "docs", "runbook.txt"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
