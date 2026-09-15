# Triage Labels

The skills speak in terms of five canonical triage roles. This file defines the desired label strings. It does not assert that all labels have been provisioned in GitHub. Read `gh label list` before applying one; use an existing label only when its meaning matches, or explicitly provision the missing role as part of a triage task.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table after verifying it exists.

Edit the right-hand column to match whatever vocabulary you actually use.
