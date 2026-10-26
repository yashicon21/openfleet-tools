---
"@openfleet-tools/cli": minor
---

Choose the model for each agent role.

- New workspace setting `models.<copilot|claude>.<key>`, set with `npx openfleet config set models.<host>.<key> <model>` (`""` removes one). Keys: `default`, `coordinator`, `repo-coordinator`, `planner`, `baseline`, `implementer`, `tester` and `extensions` (extension agents). A role without a model uses `default`, then the host's own default, so one model for everything and any mix per role both work.
- The models are written into the generated agent files (`model:`), as given for each host (Claude Code ids are no longer shortened), and the coordinator also gets `--model` at launch unless one is passed after `--`. `config set models.*` regenerates the agents right away; a change applies from the next `new` or `resume`.
- The grill shows the models for the project's host and how to change them.
- The coordinator's launch logs `models.configured`, and `npx openfleet report` shows a "Models by role" table: the configured model next to the models the transcripts show each role used.
