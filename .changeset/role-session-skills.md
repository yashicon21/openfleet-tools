---
"@openfleet-tools/cli": minor
---

Coordinators drive role sessions. With `agentMode: "session"` (the default for new workspaces; existing workspaces keep subagents until `config set agentMode session`), the coordinator and repo coordinators start planners, baseline testers, implementers, testers and extension agents with `npx openfleet agent start`, collect their turns with `agent wait` (in the background on Claude Code), answer questions and send plan revisions with `agent reply`, and save plans with `agent result --out`. Repo coordinators stay subagents and wait only for their repo's jobs (`agent wait --repo`). Skills and agents keep both versions behind agent-mode blocks, rendered when core is installed.
