"""Harness hook: remove the stamp's sources after turn 4 (replaces r2d's user-requested deletion turn P8)."""
import os
import shutil


def after_turn(n, root):
    if n == 4:
        shutil.rmtree(os.path.join(root, "config"), ignore_errors=True)
        tool = os.path.join(root, "tools", "stamp.py")
        if os.path.exists(tool):
            os.remove(tool)
