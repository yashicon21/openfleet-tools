# Commands

| Command                                                             | What it does                                                                                                                      |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `npx openfleet init [--host <copilot\|claude>]`                     | Create the workspace here, install core and choose the host (asks; CI: `copilot`)                                                 |
| `npx openfleet update`                                              | Replace `core` with the installed CLI version; disable incompatible extensions                                                    |
| `npx openfleet config`                                              | Show workspace settings (`openfleet.json`)                                                                                        |
| `npx openfleet config set maxParallel <n>`                          | Cap working agents across all projects (default 6)                                                                                |
| `npx openfleet config set host <copilot\|claude>`                   | Agent host for new projects (`copilot` or `claude`; set by `init`)                                                                |
| `npx openfleet config set greenfield.<key> <n>`                     | Greenfield caps: `maxServices` (5), `maxChildren` (12), `maxCriteriaPerChild` (8)                                                 |
| `npx openfleet config set budget.<maxTokens\|maxCost> <n>`          | Spending limit per run (tokens, or USD with `pricing`); a run that reaches it halts                                               |
| `npx openfleet config set models.<host>.<role> <model>`             | Model per agent role (`default`, `coordinator`, `planner`, `implementer`, `tester`, …) for `copilot` or `claude`; `""` removes it |
| `npx openfleet config set agentMode <subagent\|session>`            | How child roles run: subagents of the coordinator's session, or their own sessions                                                |
| `npx openfleet config set endpoints.<name>.<key> <value>`           | Model server for role sessions: `baseUrl`, `token` (local only) or `tokenEnv`, `minContext`; `endpoints.<name> ""` removes it     |
| `npx openfleet config set split.implementer steps`                  | Step mode: run the plan's `## Steps` one fresh session each (`models.<host>.fallback` for failed steps)                           |
| `npx openfleet config set roleHosts.<role> <copilot\|claude>`       | Host for one session role when it differs from the coordinator's                                                                  |
| `npx openfleet new <name> ["<request>"] [--ask] [--host <h>]`       | Create a project and launch the coordinator (`--host` overrides the workspace host)                                               |
| `npx openfleet resume <name> [--fresh] [--ask]`                     | Continue a project in its host session (`--fresh`, or a missing session: a new one)                                               |
| `npx openfleet continue <name> [new-name]`                          | Start the next slice of a finished greenfield project from its Follow-ups                                                         |
| `npx openfleet pause <name> [--reason <text>]`                      | Stop spawning agents; running ones finish their step (`resume` continues)                                                         |
| `npx openfleet cancel <name> [--reason <text>]`                     | Stop the run for good (`cancelled`); worktrees and branches are kept (`resume --reopen` continues)                                |
| `npx openfleet status [name] [--json]`                              | Children grouped by repo, phases, retries and open questions                                                                      |
| `npx openfleet list`                                                | All projects                                                                                                                      |
| `npx openfleet clean <name> [--branches] [--force]`                 | Remove the project's child and integration worktrees (and branches)                                                               |
| `npx openfleet report <name> [--out <file>] [--open] [--gap <min>]` | Write an HTML report of the run (see [Run report](./run-report.md))                                                               |
| `npx openfleet add <git-url[#ref]\|path>`                           | Install or update an extension and print its permissions                                                                          |
| `npx openfleet remove <name>`                                       | Uninstall an extension                                                                                                            |
| `npx openfleet extensions`                                          | List installed extensions                                                                                                         |
| `npx openfleet ext settings [--unset]`                              | List extension settings (`--unset`: only those without a workspace value)                                                         |
| `npx openfleet ext settings set <ext> <key> <val>`                  | Set a workspace-level extension setting in `extensions.config.json`                                                               |
| `npx openfleet <ext-command> [--ask]`                               | Run a command declared by an extension                                                                                            |

Arguments after `--` go to the host CLI (`copilot` or `claude`) unchanged, for example `npx openfleet new x -- --model claude-sonnet-5.5`.

## Permissions

OpenFleet launches the host in interactive mode so you can answer the grill questions. After the grill the coordinator keeps working without asking you anything. By default:

- **Tools are auto-approved** (`--allow-all-tools`), so you are not asked to approve every edit or shell command.
- **File access stays limited.** Path verification stays on. OpenFleet adds `--add-dir` for the workspace, the project's `worktrees/`, cloned repos in `repos/` and every local repo in `repos.json`. Access to any other path still prompts.
- **URL access still prompts** (OpenFleet does not pass `--allow-all-urls`).

Pass `--ask` to `new`, `resume` or an extension command to get Copilot's normal per-tool prompts. These defaults are for Copilot; see [Hosts](./models-and-hosts.md#hosts) for the Claude Code equivalents. To allow everything, pass Copilot's own flag: `npx openfleet resume x -- --yolo`.

`new`, `resume` and `status` warn when another active project touches the same repo.

The agents also use the helper commands `state`, `event`, `worktree`, `preflight`, `next`, `gate`, `baseline`, `claim`, `ack`, `scope`, `merge`, `escalate` and `ext plan|result|fail`. See `npx openfleet help`.

---

[← README](../README.md) · [How it works](./how-it-works.md) · [Greenfield projects](./greenfield.md) · [Workspace](./workspace.md) · **Commands** · [Models and hosts](./models-and-hosts.md) · [Run report](./run-report.md) · [Limitations and troubleshooting](./limitations-and-troubleshooting.md) · [Releasing](./releasing.md)
