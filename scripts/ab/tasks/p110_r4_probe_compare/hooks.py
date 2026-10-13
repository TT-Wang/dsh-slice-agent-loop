"""Harness hook: remove the probe after turn 2."""
import os
import shutil


def after_turn(n, root):
    if n == 2:
        shutil.rmtree(os.path.join(root, "tools"), ignore_errors=True)
