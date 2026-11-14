# Models and hosts

## Models

Each agent role can run on its own model, for each host. Set one model for everything, or a different one per role:

```sh
npx openfleet config set models.claude.default sonnet
npx openfleet config set models.claude.implementer claude-opus-5-5
npx openfleet config set models.claude.tester haiku
npx openfleet config set models.copilot.planner "Claude Sonnet 5.5"
```

The keys under `models.<copilot|claude>` are `default` and the roles `coordinator`, `repo-coordinator`, `planner`, `baseline`, `implementer`, `tester` and `extensions` (extension agents). A role without a model uses `default`, then the host's own default. Use each host's model names: aliases such as `sonnet` or full ids such as `claude-opus-5-5` on Claude Code, model names as Copilot lists them on Copilot CLI. They are written into the generated agents as `model:`, and the coordinator also gets `--model` at launch (a `--model` you pass after `--` wins). Models are workspace settings, read when a session starts: a change applies from the next `new` or `resume`. `""` removes a model.

### Role sessions

New workspaces use role sessions (`agentMode: "session"`); workspaces created before keep subagents until you run `npx openfleet config set agentMode session`, and `config set agentMode subagent` goes back. With `agentMode: "session"`, each planner, baseline tester, implementer, tester and extension agent runs as its own headless session (`claude -p` or `copilot -p`), started by the CLI instead of as a subagent of the coordinator. The coordinator drives them with `npx openfleet agent`:

| Command                                                                                        | What it does                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent start <project> <child> --role <role> [--message <text>]`                               | Claim the child (same `maxParallel`, halt and preflight rules as `claim`) and start the role's session; prints the job id at once. `--agent <ext agent>` starts an extension slot entry |
| `agent wait <project> [--job <job>] [--timeout <s>]`                                           | Wait for the next finished turn (default 540 s) and print its `openfleet-report`                                                                                                        |
| `agent reply <project> <job> --message <text>`                                                 | Next turn in the same session: answers, plan revisions, contract changes (queued while a turn runs)                                                                                     |
| `agent status <project> [job]` · `agent result <project> <job>` · `agent stop <project> <job>` | Jobs, the last report again, stop one                                                                                                                                                   |

The coordinator and repo coordinators follow the session version of their skills (`config set agentMode` renders them again). Each session gets its role's host, model and endpoint, and its own transcript (counted per role in the report and for spending limits). Jobs live in `projects/<name>/jobs/` and keep running if the coordinator's session ends; a job whose runner died is `lost`, and `agent reply … --message Continue.` resumes its session. `cancel` stops running jobs.

### Step mode

Local models have small context windows. In step mode the planner (on a strong model) ends its plan with a `## Steps` list of small steps, and the implementer job runs **each step in a fresh session**: the session sees only its step, the titles of the steps before it and the files on disk, never the history of earlier steps.

```sh
npx openfleet config set split.implementer steps
npx openfleet config set models.claude.fallback sonnet   # optional: a cloud model for steps the local model cannot finish
```

A failed step gets one more fresh session, then one on the `fallback` model (if set); a step that still fails ends the job, and the next implementer job of the same plan starts at that step. A step that asks a question waits for the coordinator's `agent reply`. The coordinator gets one result per job, and the tester checks the whole child afterwards. Merge conflicts, integration fixes and fixes after a failed test run as one session.

### Model endpoints

A role that runs as its own session (`agentMode: "session"`) can use another model server, for example a local Ollama, with no proxy. Name the endpoint, then give the role an `<endpoint>:<model>` model:

```sh
npx openfleet config set agentMode session
npx openfleet config set endpoints.ollama.baseUrl http://localhost:11434
npx openfleet config set endpoints.ollama.token ollama
npx openfleet config set models.claude.implementer ollama:qwen3-coder:30b
```

Endpoints work with Claude Code sessions (they get `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and the model in their own env). Only `planner`, `baseline`, `implementer`, `tester` and `extensions` can use one; the coordinator and repo coordinators stay on the host's own provider. A literal `token` is allowed only for local servers, because `openfleet.json` is committed; use `tokenEnv` (an env var name) for anything else. Under a Copilot coordinator, run the role on Claude Code: `config set roleHosts.implementer claude`, then set `models.claude.implementer`. `npx openfleet preflight` checks that each endpoint answers, has the model, supports tool calls and has at least `minContext` tokens of context (default 32768; for Ollama also the server's `OLLAMA_CONTEXT_LENGTH`).

The intended split: coordination, planning and testing on cloud models with large context windows, and the small, bounded edits on local models. **Step mode** (`npx openfleet config set split.implementer steps`) makes that work with small contexts: the planner writes a `## Steps` list and each step runs in its own fresh session, with an optional cloud `fallback` model for steps the local model cannot finish.

## Hosts

OpenFleet runs on [GitHub Copilot CLI](https://github.com/github/copilot-cli) and [Claude Code](https://code.claude.com). Both are fully supported and tested against the same scenarios.

- `npm create @openfleet-tools` and `npx openfleet init` ask which host the workspace uses and save it as `host` in `openfleet.json`. Pass `--host <copilot|claude>` to skip the question; without a terminal (or in CI) the host is `copilot`.
- `npx openfleet config set host <copilot|claude>` changes the host for new projects, and `npx openfleet new <name> --host <host>` overrides it for one project. A project keeps the host it was created with: `resume --host` with another host is refused.
- Requires Claude Code 2.1.219 or later. OpenFleet runs `claude --version` and refuses older versions. `OPENFLEET_CLAUDE_BIN` overrides the binary, like `OPENFLEET_COPILOT_BIN`.
- The same core generates a plugin per host: the Copilot plugin in `core/` and the Claude Code plugin in `core/claude/` (agents, skills and hooks, sharing `core/lib`). Workspaces created before host support need `npx openfleet update` first.
- Permissions: `--permission-mode acceptEdits --allowedTools Bash` and the same `--add-dir` list as Copilot. `--ask` keeps the default permission mode. OpenFleet never passes `bypassPermissions` or `--dangerously-skip-permissions`.
- Agents, skills, events, worktrees and extensions work the same way. OpenFleet still manages worktrees (Claude Code's own worktree isolation is not used). Subagents run in the background and report back through completion notifications, and coordinators reply with `SendMessage`.
- Extensions can limit phases and augments to some hosts with [`hosts`](./extensions.md#phase-entries).

---

[← README](../README.md) · [How it works](./how-it-works.md) · [Greenfield projects](./greenfield.md) · [Workspace](./workspace.md) · [Commands](./commands.md) · **Models and hosts** · [Run report](./run-report.md) · [Limitations and troubleshooting](./limitations-and-troubleshooting.md) · [Releasing](./releasing.md)
