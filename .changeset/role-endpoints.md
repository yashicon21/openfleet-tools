---
"@openfleet-tools/cli": minor
---

Add model endpoints for role sessions. `config set endpoints.<name>.<key>` names an Anthropic-compatible server (for example a local Ollama), a role model `<endpoint>:<model>` sends that role's Claude Code session there, `roleHosts.<role>` runs a role on another host than the coordinator, and `agentMode` chooses between subagents and role sessions. `preflight` checks each endpoint: reachable, model present, tool calls and context length.
