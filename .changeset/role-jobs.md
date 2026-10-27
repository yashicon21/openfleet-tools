---
"@openfleet-tools/cli": minor
---

Add role sessions: `npx openfleet agent start <project> <child> --role <role>` claims the child and runs the role as its own headless Claude Code or Copilot CLI session, with the role's host, model and endpoint, and returns a job id at once. `agent wait`, `result`, `reply`, `status` and `stop` collect reports and continue sessions. Jobs log `agent.spawned`, `agent.turn` and `agent.stopped`, survive the coordinator's session, are marked `lost` when their runner dies, and are stopped by `cancel`. Their tokens count for their role in reports and spending limits.
