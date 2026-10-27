# @openfleet-tools/cli

<img src="https://raw.githubusercontent.com/yashicon21/openfleet-tools/main/docs/brand/logo-horizontal-light.png" alt="OpenFleet" height="48" />

Coordinate **one change across many repos**, or build **a new system from scratch**, with [GitHub Copilot CLI](https://github.com/github/copilot-cli) or [Claude Code](https://code.claude.com).

You describe the change once. A **coordinator** agent turns it into a spec with you, then runs a **planner → implementer → tester** pipeline for each repo, monorepo package or path-scoped unit (such as one page of an app), in parallel, each in its own git worktree. A repo with several children gets its own **repo coordinator**, which merges them into one integration branch and one PR. Every agent action is recorded in an append-only event log.

No repos yet? Describe the system instead: OpenFleet proposes the services, contracts and stack, creates the repos and builds an MVP slice that one end-to-end test proves (see [Greenfield projects](#greenfield-projects)).

OpenFleet is built from the host's own primitives (custom agents, subagents, hooks, skills). It is not a new agent runtime.

- Website: https://openfleet.tools
- Repository: https://github.com/yashicon21/openfleet-tools
- Docs: [design](https://github.com/yashicon21/openfleet-tools/blob/main/docs/design.md) · [events](https://github.com/yashicon21/openfleet-tools/blob/main/docs/events.md) · [extensions](https://github.com/yashicon21/openfleet-tools/blob/main/docs/extensions.md)

This package provides the `openfleet` command and the plugin it installs for each host (agents, skills and hooks). Create a workspace with [`@openfleet-tools/create`](https://www.npmjs.com/package/@openfleet-tools/create) rather than installing it directly.

## Workflow at a glance

1. **Grill.** `npx openfleet new <name> "<request>"` starts the coordinator. It asks you questions and writes `spec.md` (repos and children, contracts, shared approach, baselines, branches, parallelism, completion mode). Your answer to the final "anything to change?" question starts the run. Everything after that is hands-off.
2. **Plan.** Every child's planner runs at once. The coordinator validates each plan against the spec.
3. **Gate.** All plans are checked against the spec's shared approach and against each other (per repo, then across repos). Then `plans-ready` extensions run.
4. **Baseline** (optional, per child). Tests for today's behaviour are written and pass on the unchanged code.
5. **Implement → test.** These run in `dependsOn` order, with at most `maxParallel` agents working across the workspace, and failures are retried.
6. **Integrate.** A repo with several children merges them into its integration branch and runs the full build and tests there.
7. **Finalize.** Changes are staged in each worktree, or opened as cross-linked draft PRs. On GitHub, a repo with several children can open as a stack of smaller PRs instead, one per child ([stacked pull requests](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands), via `gh stack`; the grill asks). `summary.md` lists assumptions, failures and follow-ups, and `report.html` shows the whole run (see [Run report](#run-report)).

## Quick start

Requirements: Node.js 22+, git, a signed-in agent host ([Copilot CLI](https://github.com/github/copilot-cli), or [Claude Code](https://code.claude.com) 2.1.219 or later), and optionally `gh` for draft PRs. Runs on macOS and Linux; on Windows, use WSL2 (native Windows is not supported).

```sh
mkdir my-fleet && cd my-fleet
npm create @openfleet-tools@latest   # or: npx @openfleet-tools/create; asks Copilot CLI or Claude Code
npx openfleet new better-auth "Move every service to better-auth"
```

> **Run `npx openfleet` inside your workspace folder** (the one `npm create` set up). There, npx runs the OpenFleet CLI installed in it. Outside it, npx would offer to download a different, unrelated npm package that is also named `openfleet`. To run OpenFleet from anywhere, use the scoped name: `npx @openfleet-tools/cli <command>`.

To try it on a toy example first, run `pnpm demo` from a checkout of this repo. See [examples/demo](https://github.com/yashicon21/openfleet-tools/blob/main/examples/demo/README.md).

The coordinator then:

1. **Grills you** about the change, suggests repos from `repos.json`, discovers build and test commands, and confirms them with you.
2. Writes `projects/<name>/spec.md` (goal, repos, contracts, ordering, acceptance criteria, branches, completion mode). The grill ends with a spec summary and one question, "anything to change?". **Your answer starts the run; after that it is hands-off.**
3. Plans every child at once (read-only planners), validates each plan against the spec, and checks that all plans agree with the spec's shared approach and with each other before anything is implemented (the `plans-ready` gate). Then, in dependency order and with at most `maxParallel` agents working at a time across the workspace (a workspace setting, default 6), it optionally runs a baseline tester (tests for today's behaviour that must pass on the unchanged code, and that the implementer may only change where the spec allows), then an implementer and a tester. Each child gets its own port range so apps and e2e tests can run side by side. A failing test sends the findings to a new implementer, up to 3 retries. Then the coordinator reviews the findings and diff itself and makes one guided attempt; if that fails too, the child is marked `failed`, its dependents `blocked`, and the rest of the run continues.
4. Finishes in the completion mode you chose: changes **staged** in each worktree for your review (default), or **draft PRs** that link to each other.

Child questions go to the coordinator. It answers from the spec, or decides itself and logs an `assumption`. The run summary lists every assumption and every failed child (with findings and worktree paths); `npx openfleet resume <name>` lets you deal with failures later.

### Children, scoped children and repo coordinators

A **child** is one pipeline. Its id is one of:

- `api`: a whole repo;
- `web:ui`: a monorepo package;
- `web/settings` or `web:ui/button`: a **path-scoped** unit that owns `paths` globs such as `app/settings/**`.

During the grill the coordinator can look for units (pages, modules or services; for a Next.js app, the routes under `app/**/page.tsx` or `pages/**`). It proposes one child per unit and lets you group or skip them. For each repo with scoped children it also adds a `<repo>/setup` child for shared config, components and utils. Every scoped child depends on it and must not add shared items itself. A tester fails a scoped child whose diff touches files outside its paths (`npx openfleet scope <project> <child> --check`).

A repo with more than one child is run by its own **repo coordinator** (`openfleet-repo-coordinator`), a subagent of the top coordinator. It:

- runs the repo's pipelines and answers their questions;
- checks their plans against each other;
- merges each finished child into the integration branch, `openfleet/<project>` by default (the setup child first, then the others in the order they finish);
- runs the repo's full build and tests there;
- reports one result.

When a merge conflicts, it rebases the child onto the integration branch and has that child's implementer resolve the conflict. A question that changes a cross-repo contract or the shared approach is escalated to the top coordinator, and only those children wait. The repo gets one PR, from its integration branch. Single-child repos run directly under the top coordinator.

Every spawn first takes a slot with `npx openfleet claim`. It allows at most `maxParallel` working agents across the workspace (`npx openfleet config set maxParallel <n>`; the grill shows the current value and offers to change it) and keeps attribution exact when several coordinators spawn agents at once.

## What a run takes

Every child runs at least a planner, an implementer and a tester (plus a baseline tester if it has one), and each failed test adds an implementer and a tester again, up to 3 retries and one guided attempt. Agent count, time and tokens grow with the number of children, the retries and the size of each change.

For scale, the run on [openfleet.tools/how-it-works](https://openfleet.tools/how-it-works.html) moved one app to a new component library page by page: 10 children, 83 agent spawns, at most 7 agents at once, 3 retries and about 1.6 hours of active time (6 hours on the clock, including pauses).

Start with a small project to see what your host and models cost, then:

- set a spending limit (`npx openfleet config set budget.maxTokens <n>`, or `budget.maxCost` with `pricing`), so a run halts instead of overspending;
- lower `maxParallel` on a small machine or a tight plan;
- pick cheaper models for some roles (see [Models](#models));
- read `npx openfleet report <name>` afterwards for tokens, cost and the models each role used.

## Greenfield projects

OpenFleet can also build a **new system from scratch**. Describe it in the request, for example:

```sh
npx openfleet new invoices "Create an invoice and payment tracking website with microservices and a frontend"
```

The grill notices that no repo fits and switches to greenfield mode:

- **Services and contracts.** It proposes the services, the frontend and the contracts between them.
- **Layout.** It recommends **one monorepo** (one package per service, one for the frontend, one shared contracts package); several repos work too.
- **Stack.** It asks once for the whole system, recommending an answer each time: language and framework per service, frontend framework, database, service communication (REST/OpenAPI, gRPC or events), auth and local run (docker-compose).
- **GitHub remote.** It offers a private GitHub repo per repo (`gh repo create`); the default is local only.
- **MVP slice.** It cuts the request to the core flows plus **one end-to-end flow** that proves them (for the invoice tracker: create invoice → record payment → invoice shows paid). Everything else goes into the spec's `## Follow-ups`, so you see what was cut.

The scope is capped by the CLI, not just by the prompt. A greenfield spec cannot be approved with more than `greenfield.maxServices` services (default 5), `greenfield.maxChildren` children (12) or `greenfield.maxCriteriaPerChild` acceptance criteria per child (8), or without a non-empty `## Follow-ups` section. Raise a cap with `npx openfleet config set greenfield.<key> <n>`. During the run, the plan gate sends back plans that build a Follow-ups item (`plan.rejected`, reason `out-of-scope`), and testers fail endpoints, pages or tables that no contract or criterion asks for.

After you approve the spec, OpenFleet creates each repo (`npx openfleet repo create`: an empty initial commit on `main`, registered in `repos.json` with `greenfield: true`). Preflight checks that `node`, `git`, `docker` and the stack's toolchains are installed and that their package registries are reachable. Then the children run in a fixed order:

1. **setup** (one per repo): scaffolds with the official generators, run non-interactively, and adds lint, test, build and a sample test. The commands its tester confirmed are recorded in `repos.json`.
2. **contracts**: schemas (OpenAPI, event schemas) plus generated types and clients in a shared package.
3. **services** and the **frontend**, in parallel, built on the contracts package.
4. **system**: docker-compose for the whole system, dev-only credentials generated into a git-ignored `.env.local`, seed data, third-party services stubbed behind a mock provider, and the end-to-end flow.

Only when the end-to-end flow passes does the work land: on the new repo's `main` (completion mode `main`), or, with a GitHub remote, as one draft PR into `main` with everything after the initial commit.

To build the next slice, run `npx openfleet continue invoices`. It starts a new project (`invoices-2`) from the Follow-ups, reusing the repos, the stack and the contracts; the grill skips the stack questions and picks the next slice under the same caps.

## Workspace

Everything sits in the folder you ran `npm create @openfleet-tools` in, next to `package.json` and `node_modules/`:

```
my-workspace/
  package.json  node_modules/
  openfleet.json         # workspace marker + settings, e.g. { "version": "0.5.0", "maxParallel": 6, "host": "copilot" } (commit this)
  .gitignore             # written by `init` if missing
  core/                  # installed by the CLI; replaced by `update` (gitignored)
  extensions/            # instruction-only extensions (commit this)
  extensions.lock.json   # source + pinned SHA per extension (commit this)
  extensions.config.json # optional per-workspace extension settings (commit this)
  repos.json             # known repos/packages, build and test commands (commit this)
  repos/<key>/           # repos cloned from a `url` in repos.json (gitignored)
  projects/<name>/
    spec.md  state.json  events.jsonl  contracts/  plans/
    summary.md  report.html  # written when the run finishes
    patches/<seq>.patch  # gitignored
    worktrees/<child>/   # gitignored; one per child (web:ui/button → web__ui__button),
                         # plus one integration worktree per repo with several children
```

`init` refuses a folder without `openfleet.json` that already has any of these entries; use an empty folder or a new subfolder. If a `.gitignore` already exists, `init` leaves it alone and prints the lines to add.

Repos can live anywhere: give a `path` (relative to the workspace root) or a `url`, which is cloned into `repos/<key>`.

`e2e` and `env` (names of required env vars and credentials, never values) are recorded by the grill. `copyFiles` lists git-ignored local files (for example `.env.local`) that are copied from the repo's checkout into every worktree. They are never staged or committed, and their values are redacted from the event log.

```json
{
  "v": 1,
  "repos": {
    "api": { "path": "../api", "defaultBranch": "main", "build": "pnpm build", "test": "pnpm test", "confirmed": true },
    "app": {
      "path": "../app",
      "test": "pnpm test",
      "e2e": "pnpm test:e2e",
      "env": ["AUTH_CLIENT_ID", "AUTH_CLIENT_SECRET"],
      "copyFiles": [".env.local"]
    },
    "web": {
      "url": "git@github.com:acme/web.git",
      "packages": { "ui": { "path": "packages/ui", "test": "pnpm -F ui test" } }
    }
  }
}
```

## Commands

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
| `npx openfleet report <name> [--out <file>] [--open] [--gap <min>]` | Write an HTML report of the run (see [Run report](#run-report))                                                                   |
| `npx openfleet add <git-url[#ref]\|path>`                           | Install or update an extension and print its permissions                                                                          |
| `npx openfleet remove <name>`                                       | Uninstall an extension                                                                                                            |
| `npx openfleet extensions`                                          | List installed extensions                                                                                                         |
| `npx openfleet ext settings [--unset]`                              | List extension settings (`--unset`: only those without a workspace value)                                                         |
| `npx openfleet ext settings set <ext> <key> <val>`                  | Set a workspace-level extension setting in `extensions.config.json`                                                               |
| `npx openfleet <ext-command> [--ask]`                               | Run a command declared by an extension                                                                                            |

Arguments after `--` go to the host CLI (`copilot` or `claude`) unchanged, for example `npx openfleet new x -- --model claude-sonnet-5.5`.

### Permissions

OpenFleet launches the host in interactive mode so you can answer the grill questions. After the grill the coordinator keeps working without asking you anything. By default:

- **Tools are auto-approved** (`--allow-all-tools`), so you are not asked to approve every edit or shell command.
- **File access stays limited.** Path verification stays on. OpenFleet adds `--add-dir` for the workspace, the project's `worktrees/`, cloned repos in `repos/` and every local repo in `repos.json`. Access to any other path still prompts.
- **URL access still prompts** (OpenFleet does not pass `--allow-all-urls`).

Pass `--ask` to `new`, `resume` or an extension command to get Copilot's normal per-tool prompts. These defaults are for Copilot; see [Hosts](#hosts) for the Claude Code equivalents. To allow everything, pass Copilot's own flag: `npx openfleet resume x -- --yolo`.

`new`, `resume` and `status` warn when another active project touches the same repo.

The agents also use the helper commands `state`, `event`, `worktree`, `preflight`, `next`, `gate`, `baseline`, `claim`, `ack`, `scope`, `merge`, `escalate` and `ext plan|result|fail`. See `npx openfleet help`.

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

## Hosts

OpenFleet runs on [GitHub Copilot CLI](https://github.com/github/copilot-cli) and [Claude Code](https://code.claude.com). Both are fully supported and tested against the same scenarios.

- `npm create @openfleet-tools` and `npx openfleet init` ask which host the workspace uses and save it as `host` in `openfleet.json`. Pass `--host <copilot|claude>` to skip the question; without a terminal (or in CI) the host is `copilot`.
- `npx openfleet config set host <copilot|claude>` changes the host for new projects, and `npx openfleet new <name> --host <host>` overrides it for one project. A project keeps the host it was created with: `resume --host` with another host is refused.
- Requires Claude Code 2.1.219 or later. OpenFleet runs `claude --version` and refuses older versions. `OPENFLEET_CLAUDE_BIN` overrides the binary, like `OPENFLEET_COPILOT_BIN`.
- The same core generates a plugin per host: the Copilot plugin in `core/` and the Claude Code plugin in `core/claude/` (agents, skills and hooks, sharing `core/lib`). Workspaces created before host support need `npx openfleet update` first.
- Permissions: `--permission-mode acceptEdits --allowedTools Bash` and the same `--add-dir` list as Copilot. `--ask` keeps the default permission mode. OpenFleet never passes `bypassPermissions` or `--dangerously-skip-permissions`.
- Agents, skills, events, worktrees and extensions work the same way. OpenFleet still manages worktrees (Claude Code's own worktree isolation is not used). Subagents run in the background and report back through completion notifications, and coordinators reply with `SendMessage`.
- Extensions can limit phases and augments to some hosts with [`hosts`](https://github.com/yashicon21/openfleet-tools/blob/main/docs/extensions.md#phase-entries).

## Limitations and known issues

- **Hosts and models:** GitHub Copilot CLI and Claude Code. Other model servers (for example a local Ollama) work only for role sessions on Claude Code, through an Anthropic-compatible endpoint; the coordinator and repo coordinators always use the host's own provider. Local models are best kept to bounded roles (implementer, tester): weaker models skip the coordination protocol. Models per role are workspace-wide and apply from the next `new` or `resume`; whether Copilot honours a model for a subagent depends on Copilot.
- **Guards** check file tools and spawns, not shell commands: an agent can still write files with a shell command.
- **Platforms:** macOS and Linux. Windows only through WSL2.
- **Pull requests:** GitHub only (`gh`). Stacked PRs need the `gh stack` extension and stay within one repo. No GitLab or Bitbucket.
- **Spending limits** are checked when an agent is about to start, so agents already running can take a run past a limit. There is no per-child limit, and usage is only known when the host transcripts are on the machine that runs OpenFleet.
- **`pause` and `cancel`** stop new agents at once; agents already running finish their current step first.
- **Hands-off after the grill:** questions that come up during the run are decided by the coordinator and logged as assumptions, not asked. Review them in `summary.md` and the report.
- **Greenfield** runs build an MVP slice under fixed caps, need network access for the generators, and need Docker for the end-to-end flow.
- **Copilot agent prompts** have a size limit; many role-augmenting extensions on one role can be truncated (OpenFleet warns when that happens).

## Troubleshooting

### Sandbox

OpenFleet creates a git worktree per child, so git must be able to write inside each repo's `.git` directory (ref locks, `.git/worktrees/`). A sandbox can block these writes with `EPERM` ("Operation not permitted"), for example `fatal: cannot lock ref … Operation not permitted`. Copilot's `--add-dir` only affects path verification; it does not lift a sandbox.

- **Before launching**, `new`, `resume` and extension commands probe these writes from the OpenFleet process itself. If they are denied there, the sandbox is inherited from the shell that started OpenFleet and nothing inside Copilot can fix it, so OpenFleet stops before starting the session. If Copilot's command sandbox looks enabled (`--sandbox`, or `sandbox.enabled` in `~/.copilot/settings.json` or `.github/copilot/settings*.json`), it prints a warning; managed policies cannot be detected, so the in-session check below covers them.
- **In the session**, `npx openfleet preflight <project>` runs the same checks before the spec is approved, at the start of the run and first after `resume`. While it fails, the spec cannot be approved and nothing is spawned.

Likely causes of `EPERM`, in order:

1. **OpenFleet or Copilot was started from a sandboxed shell**, such as an IDE or app-embedded terminal or an agent's shell. The whole process tree is sandboxed. Start `npx openfleet` from a normal terminal.
2. **The host's own sandbox is on.** Copilot: run `/sandbox disable`, start without `--sandbox` (or pass `-- --no-sandbox`), or add the repo paths to `sandbox.userPolicy.filesystem.readwritePaths` in `~/.copilot/settings.json`. Claude Code: turn off `sandbox.enabled` (`/sandbox`) or allow writes to the repo paths in its sandbox settings. The sandbox may still protect `.git`.
3. **A managed OS policy** on the device. Ask your administrator.

macOS Full Disk Access does not fix this. `EACCES` ("Permission denied") is a plain file-permissions problem: check the owner and mode of the path.

## Run report

`npx openfleet report <name>` writes `projects/<name>/report.html`: one self-contained HTML file (no scripts, fonts or network requests) that shows what the run did. The coordinator runs it at the end of every run and links it from `summary.md`; you can also run it at any time, on a finished run or one still in progress.

It is built only from the project's files (`events.jsonl`, `state.json`, `spec.md`, `summary.md`) and git, with no agent involved:

- active time and wall-clock time, children, agent spawns, agents at once, test runs, lines changed;
- the ask (the spec's `## Goal`), how the work was split, and a timeline of every child's phases;
- the plan gate (plans submitted, validated and sent back), agents running at once and spawns by role;
- lines changed and test runs per child;
- the **Coverage**, **Assumptions**, **Follow-ups** and **Lessons** sections of `summary.md`, when it has them (assumptions fall back to the `assumption` events);
- tokens by role and model, read from the host's transcripts on this machine (Claude Code: `~/.claude/projects/`; Copilot CLI: `~/.copilot/session-state/`). Each API message is counted once, even when sessions were forked. Without transcripts the section says "not available".
- the spending limits (`budget`) against usage, and every halt, resume and 80% warning; a halted run is marked in the header.
- the model configured for each role at launch next to the models the transcripts show it used, so you can check the `models` settings took effect.

Pauses longer than 15 minutes (`--gap <min>`) are collapsed into hatched bands on the timeline. `--out <file>` writes elsewhere and `--open` opens the report in the browser.

Cost is shown only when `openfleet.json` has a `pricing` table. Prices are USD per million tokens, per model name as the host reports it (`.`/`-` and case differences are ignored). `input`, `output` and `cacheRead` are required; cache writes use `cacheWrite`, or `cacheWrite5m` and `cacheWrite1h` where the host tells them apart. OpenFleet ships no prices: copy them from your provider.

```json
{
  "version": "0.5.0",
  "maxParallel": 6,
  "pricing": {
    "claude-opus-5.5": { "input": 4, "output": 20, "cacheWrite5m": 5, "cacheWrite1h": 8, "cacheRead": 0.2 }
  }
}
```

## Events

Each project has an append-only `events.jsonl`. Hooks capture subagent starts and stops, file changes (with full patches) and a git diff snapshot of each worktree when an agent stops. The coordinator logs messages, questions, plans, test runs, contract changes, the assumptions it made on its own (`assumption`), failed children (`child.failed`), plan-gate results, baselines, extension results, escalated questions (`question.escalated`) and merges into integration branches (`child.merged`, `merge.conflict`). Secrets are redacted.

See [docs/events.md](https://github.com/yashicon21/openfleet-tools/blob/main/docs/events.md) for the schema.

## Extensions

Extensions are **instruction-only**: a folder with `openfleet.extension.json` and Markdown, and no executable code. An extension (manifest v2) can run agents at phase slots (`pre-spec`, `post-plan`, `plans-ready`, `pre-implement`, `post-test`, `post-run`), augment a role's instructions (`coordinator`, `repo-coordinator`, `planner`, `baseline`, `implementer` or `tester`), and add CLI commands. Phase entries can be blocking, can run only when certain files exist, and can report outputs (such as a published version or a PR URL) that OpenFleet injects into dependent repos' prompts. Settings are workspace-level: they live in `extensions.config.json`, you set them with `npx openfleet ext settings set`, and the grill asks you about any setting that has no value yet. Write and shell access must be declared, and the generated agent's tool allow-list enforces it.

See [docs/extensions.md](https://github.com/yashicon21/openfleet-tools/blob/main/docs/extensions.md).

## License

[MIT](https://github.com/yashicon21/openfleet-tools/blob/main/LICENSE)
