"""Harness hook: remove the sources of the two tool-only facts after their turns, so the build id (T3) and the lint
message (T5) exist only in those turns' tool results (and the session log)."""
import os


def after_turn(n, root):
    if n == 3:
        for rel in ("tools/inspect_build.py", ".build_seed"):
            p = os.path.join(root, rel)
            if os.path.exists(p):
                os.remove(p)
    if n == 5:
        p = os.path.join(root, "tools", "lint_frames.py")
        if os.path.exists(p):
            os.remove(p)
