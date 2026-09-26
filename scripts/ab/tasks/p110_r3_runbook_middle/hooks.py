"""Harness hook: remove the runbook after turn 1."""
import os
import shutil


def after_turn(n, root):
    if n == 1:
        shutil.rmtree(os.path.join(root, "docs"), ignore_errors=True)
