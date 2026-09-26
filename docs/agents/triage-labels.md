# Triage Labels

The skills speak in terms of five canonical triage roles. All five labels in the table exist in this repo's GitHub tracker: `wontfix` is a GitHub default, and the maintainer created the other four on 2026-09-27 (GitHub records 2026-09-26 17:01 UTC). Agents apply and remove these labels. Creating, renaming or deleting a label is a repository setting that the maintainer owns; if `gh` reports a missing label, stop and tell the maintainer.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

If the vocabulary changes, the maintainer changes the GitHub labels and this table together.
