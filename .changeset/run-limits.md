---
"@openfleet-tools/cli": minor
---

Spending limits and stopping a run.

- New workspace settings `budget.maxTokens` and `budget.maxCost` (USD, priced with `pricing`), set with `npx openfleet config set budget.<key> <n>`; a project can override them (`budget` in its state, offered in the grill). Before every spawn, `npx openfleet claim` reads the run's token usage from the host transcripts. It logs `budget.warning` once at 80%, and when a limit is reached it halts the run: `claim` returns `{"result":"stop"}`, `next` returns only a `halt` action, and the coordinators spawn nothing more, let running agents finish, write the summary and stop.
- New commands `npx openfleet pause <name>` and `npx openfleet cancel <name>` (both with `--reason`) halt a run from another terminal. A cancelled project is `cancelled` and frees its workspace slots; worktrees and branches are kept.
- `npx openfleet resume` clears a halt and warns if a spending limit is still reached; a cancelled project needs `--reopen`. `status` shows the halt and usage against the limits. New events `run.halted`, `run.resumed` and `budget.warning`.
- `npx openfleet report` shows the spending limits against usage, every halt, resume and 80% warning, and marks a halted run in its header.
