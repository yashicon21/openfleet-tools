---
"@openfleet-tools/cli": minor
---

Enforce run guards in the CLI instead of trusting the coordinator: a project cannot move to `finalizing` or `done` (and `summary.md` cannot be written) while children are unfinished, unless the run is halted; a greenfield child cannot be registered without a `kind`; a role agent cannot be spawned without a claim (or as a subagent when roles run as sessions); role agents write only inside their worktree, and coordinators never write into repos or worktrees. A new `preToolUse` hook (both hosts) denies those tool calls and logs `guard.refused`; shell commands are not inspected.
