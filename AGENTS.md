## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (TT-Wang/dsh-slice-agent-loop), operated via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary; each label string equals its role name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). All five exist on GitHub; agents apply them, and only the maintainer creates labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `CONTEXT.md` and `docs/adr/` at the repo root, created lazily by `/domain-modeling` — absence is normal, proceed silently. See `docs/agents/domain.md`.
