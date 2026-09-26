"""Harness hook: remove the fingerprint's source after turn 2 (replaces r2b's user-requested deletion turn P4)."""
import os
import shutil


def after_turn(n, root):
    if n == 2:
        tool = os.path.join(root, "tools", "check_fixtures.py")
        if os.path.exists(tool):
            os.remove(tool)
        shutil.rmtree(os.path.join(root, "fixtures"), ignore_errors=True)
