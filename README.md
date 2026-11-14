<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo-horizontal-dark.png" />
    <img src="docs/brand/logo-horizontal-light.png" alt="OpenFleet" height="56" />
  </picture>
</h1>

[![npm](https://img.shields.io/npm/v/@openfleet-tools/cli?label=npm&color=48A6EE)](https://www.npmjs.com/package/@openfleet-tools/cli)
[![CI](https://github.com/yashicon21/openfleet-tools/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/yashicon21/openfleet-tools/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-EE5AD6)](LICENSE)

Coordinate **one big change across many repos, or many parts of one repo**, or build **a new system from scratch**, with [GitHub Copilot CLI](https://github.com/github/copilot-cli) or [Claude Code](https://code.claude.com).

Website: [openfleet.tools](https://openfleet.tools) · Repository: [github.com/yashicon21/openfleet-tools](https://github.com/yashicon21/openfleet-tools)

<p align="center">
  <img src="docs/brand/demo-fan-out.gif" alt="One prompt fans out to eight repos. Each repo is planned, built and tested in parallel, and each ends with a draft PR." width="560" />
</p>

You describe the change once. A **coordinator** agent turns it into a spec with you, then runs a **planner → implementer → tester** pipeline for each repo, monorepo package or path-scoped unit (such as one page of an app), in parallel, each in its own git worktree. A repo with several children gets its own **repo coordinator**, which merges them into one integration branch and one PR. Every agent action is recorded in an append-only event log.

**One repo works too.** OpenFleet can split a single app into one child per package, page or module. They run in parallel and merge back into one branch and one PR. A small change that cannot be split is better left to one agent.

No repos yet? Describe the system instead: OpenFleet proposes the services, contracts and stack, creates the repos and builds an MVP slice that one end-to-end test proves (see [Greenfield projects](docs/greenfield.md)).

OpenFleet is built from the host's own primitives (custom agents, subagents, hooks, skills). It is not a new agent runtime.

## Try it in 2 minutes

You need Node.js 22+, pnpm, git and a signed-in [Copilot CLI](https://github.com/github/copilot-cli) or [Claude Code](https://code.claude.com). The demo creates two toy repos and a workspace in a temporary folder, so none of your own repos are touched.

```sh
git clone https://github.com/yashicon21/openfleet-tools && cd openfleet-tools
pnpm install && pnpm demo        # add --host claude to use Claude Code
```

It prints the commands that start a run. See [examples/demo](examples/demo/README.md) for what it sets up.

## Quick start

Requirements: Node.js 22+, git, a signed-in agent host ([Copilot CLI](https://github.com/github/copilot-cli), or [Claude Code](https://code.claude.com) 2.1.219 or later), and optionally `gh` for draft PRs. Runs on macOS and Linux; on Windows, use WSL2 (native Windows is not supported).

```sh
mkdir my-fleet && cd my-fleet
npm create @openfleet-tools@latest   # or: npx @openfleet-tools/create; asks Copilot CLI or Claude Code
npx openfleet new better-auth "Move every service to better-auth"
```

> **Run `npx openfleet` inside your workspace folder** (the one `npm create` set up). There, npx runs the OpenFleet CLI installed in it. Outside it, npx would offer to download a different, unrelated npm package that is also named `openfleet`. To run OpenFleet from anywhere, use the scoped name: `npx @openfleet-tools/cli <command>`.

After the grill, the coordinator plans, builds and tests every child on its own; you review the result. See [How it works](docs/how-it-works.md) for the whole run.

## How it differs from `/fleet`

|           | Copilot `/fleet`                                   | OpenFleet                                                         |
| --------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| Scope     | Parallel subagents inside **one** session and repo | One change across **many** repos and packages                     |
| Isolation | Shared working tree                                | One git worktree and branch per child (repo, package or unit)     |
| Process   | Free-form                                          | Spec → plan → implement → test, with retries                      |
| Contracts | —                                                  | Shared contract fixtures in `contracts/`, contract tests per repo |
| Record    | Session transcript                                 | `events.jsonl` with attribution, patches and diff snapshots       |
| Resume    | Session resume                                     | Project state in `state.json`; `openfleet resume <name>`          |

## Documentation

| Page                                                                       | What's in it                                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [How it works](docs/how-it-works.md)                                       | The workflow, the run step by step, children and repo coordinators, what a run takes    |
| [Greenfield projects](docs/greenfield.md)                                  | Building a new system from a description instead of changing existing repos             |
| [Workspace](docs/workspace.md)                                             | `openfleet.json`, `repos.json` and the project files a run writes                       |
| [Commands](docs/commands.md)                                               | Every `npx openfleet` command, and permissions                                          |
| [Models and hosts](docs/models-and-hosts.md)                               | Models per role, role sessions, step mode, model endpoints, Copilot CLI and Claude Code |
| [Run report](docs/run-report.md)                                           | `report.html`, token usage and cost                                                     |
| [Limitations and troubleshooting](docs/limitations-and-troubleshooting.md) | Known limits and sandbox errors                                                         |
| [Event log](docs/events.md)                                                | The `events.jsonl` schema                                                               |
| [Extensions](docs/extensions.md)                                           | Writing instruction-only extensions                                                     |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests and commit style, and [SECURITY.md](SECURITY.md) for reporting vulnerabilities. Maintainers release with Changesets: see [Releasing](docs/releasing.md). Design notes are in [docs/design.md](docs/design.md).

## License

[MIT](LICENSE)
