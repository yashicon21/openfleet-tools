# Security policy

## Reporting a vulnerability

Please report security issues privately, never in a public issue or pull request: use **[Report a vulnerability](https://github.com/yashicon21/openfleet-tools/security/advisories/new)** on the repository's Security tab. Include what you found, how to reproduce it, and the OpenFleet and host versions.

You'll get a reply within a few days. Once a fix is released, the advisory is published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Security fixes go into the latest 1.x release. Update with `npm install -D @openfleet-tools/cli@latest`, then `npx openfleet update`.

## What OpenFleet can touch

OpenFleet launches coding agents that run commands on your machine, so it is worth knowing its boundaries:

- **Tools run without prompts** inside the workspace, the project's worktrees and the repos in `repos.json` (Copilot CLI: `--allow-all-tools` with `--add-dir` for those folders; Claude Code: `--permission-mode acceptEdits --allowedTools Bash` with the same folders). Every other path and every URL still prompts. Pass `--ask` to `new` or `resume` to approve every tool yourself. OpenFleet never uses `--dangerously-skip-permissions` or `bypassPermissions`.
- **Secrets:** `repos.json` stores the _names_ of env vars, never values. Local files such as `.env.local` (`copyFiles`) are copied into worktrees, hidden from git and never committed. Agents are told never to open them, and values that appear in tool output are redacted from `events.jsonl` and the patches.
- **Greenfield projects** generate dev-only database credentials into a git-ignored `.env.local`, and stub third-party services (payments, email) behind a mock provider. They never need real secrets.
- **Extensions** are instruction-only: Markdown and JSON, no code. `npx openfleet add` prints the permissions an extension asks for before it is enabled.
- **Network:** OpenFleet itself only talks to npm (install and update), GitHub through `gh` when you choose draft PRs or a GitHub remote, and package registries during greenfield preflight. What the agents fetch is up to your host's URL permissions.

If you find a way around any of these, that is a vulnerability: please report it as above.
