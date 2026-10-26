# OpenFleet

Coordinate **one change across many repos** with [GitHub Copilot CLI](https://github.com/github/copilot-cli) or [Claude Code](https://code.claude.com).

Website: [openfleet.tools](https://openfleet.tools) · Repository: [github.com/yashicon21/openfleet-tools](https://github.com/yashicon21/openfleet-tools)

You describe the change once. A **coordinator** agent turns it into a spec with you, then runs a **planner → implementer → tester** pipeline for each repo, monorepo package or path-scoped unit (such as one page of an app), in parallel, each in its own git worktree. A repo with several children gets its own **repo coordinator**, which merges them into one integration branch and one PR. Every agent action is recorded in an append-only event log.

OpenFleet is built from the host's own primitives (custom agents, subagents, hooks, skills). It is not a new agent runtime.

## Workflow at a glance

1. **Grill.** `npx openfleet new <name> "<request>"` starts the coordinator. It asks you questions and writes `spec.md` (repos and children, contracts, shared approach, baselines, branches, parallelism, completion mode). Your answer to the final "anything to change?" question starts the run. Everything after that is hands-off.
2. **Plan.** Every child's planner runs at once. The coordinator validates each plan against the spec.
3. **Gate.** All plans are checked against the spec's shared approach and against each other (per repo, then across repos). Then `plans-ready` extensions run.
4. **Baseline** (optional, per child). Tests for today's behaviour are written and pass on the unchanged code.
5. **Implement → test.** These run in `dependsOn` order, with at most `maxParallel` agents working across the workspace, and failures are retried.
6. **Integrate.** A repo with several children merges them into its integration branch and runs the full build and tests there.
7. **Finalize.** Changes are staged in each worktree, or opened as cross-linked draft PRs. On GitHub, a repo with several children can open as a stack of smaller PRs instead, one per child ([stacked pull requests](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands), via `gh stack`; the grill asks). `summary.md` lists assumptions, failures and follow-ups, and `report.html` shows the whole run (see [Run report](#run-report)).

See the [flow diagram](docs/flow.png) for the details.

## How it differs from `/fleet`

|           | Copilot `/fleet`                                   | OpenFleet                                                         |
| --------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| Scope     | Parallel subagents inside **one** session and repo | One change across **many** repos and packages                     |
| Isolation | Shared working tree                                | One git worktree and branch per child (repo, package or unit)     |
| Process   | Free-form                                          | Spec → plan → implement → test, with retries                      |
| Contracts | —                                                  | Shared contract fixtures in `contracts/`, contract tests per repo |
| Record    | Session transcript                                 | `events.jsonl` with attribution, patches and diff snapshots       |
| Resume    | Session resume                                     | Project state in `state.json`; `openfleet resume <name>`          |

## Quick start

Requirements: Node.js 20+, git, a signed-in agent host ([Copilot CLI](https://github.com/github/copilot-cli), or [Claude Code](https://code.claude.com) 2.1.219 or later), and optionally `gh` for draft PRs.

```sh
mkdir my-fleet && cd my-fleet
npm create @openfleet-tools@latest   # or: npx @openfleet-tools/create; asks Copilot CLI or Claude Code
npx openfleet new better-auth "Move every service to better-auth"
```

To try it on a toy example first, run `pnpm demo` from a checkout of this repo. See [examples/demo](examples/demo/README.md).

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

| Command                                                             | What it does                                                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `npx openfleet init [--host <copilot\|claude>]`                     | Create the workspace here, install core and choose the host (asks; CI: `copilot`)   |
| `npx openfleet update`                                              | Replace `core` with the installed CLI version; disable incompatible extensions      |
| `npx openfleet config`                                              | Show workspace settings (`openfleet.json`)                                          |
| `npx openfleet config set maxParallel <n>`                          | Cap working agents across all projects (default 6)                                  |
| `npx openfleet config set host <copilot\|claude>`                   | Agent host for new projects (`copilot` or `claude`; set by `init`)                  |
| `npx openfleet config set greenfield.<key> <n>`                     | Greenfield caps: `maxServices` (5), `maxChildren` (12), `maxCriteriaPerChild` (8)   |
| `npx openfleet new <name> ["<request>"] [--ask] [--host <h>]`       | Create a project and launch the coordinator (`--host` overrides the workspace host) |
| `npx openfleet resume <name> [--fresh] [--ask]`                     | Continue a project in its host session (`--fresh`, or a missing session: a new one) |
| `npx openfleet continue <name> [new-name]`                          | Start the next slice of a finished greenfield project from its Follow-ups           |
| `npx openfleet status [name] [--json]`                              | Children grouped by repo, phases, retries and open questions                        |
| `npx openfleet list`                                                | All projects                                                                        |
| `npx openfleet clean <name> [--branches] [--force]`                 | Remove the project's child and integration worktrees (and branches)                 |
| `npx openfleet report <name> [--out <file>] [--open] [--gap <min>]` | Write an HTML report of the run (see [Run report](#run-report))                     |
| `npx openfleet add <git-url[#ref]\|path>`                           | Install or update an extension and print its permissions                            |
| `npx openfleet remove <name>`                                       | Uninstall an extension                                                              |
| `npx openfleet extensions`                                          | List installed extensions                                                           |
| `npx openfleet ext settings [--unset]`                              | List extension settings (`--unset`: only those without a workspace value)           |
| `npx openfleet ext settings set <ext> <key> <val>`                  | Set a workspace-level extension setting in `extensions.config.json`                 |
| `npx openfleet <ext-command> [--ask]`                               | Run a command declared by an extension                                              |

Arguments after `--` go to the host CLI (`copilot` or `claude`) unchanged, for example `npx openfleet new x -- --model claude-sonnet-5.5`.

### Permissions

OpenFleet launches the host in interactive mode so you can answer the grill questions. After the grill the coordinator keeps working without asking you anything. By default:

- **Tools are auto-approved** (`--allow-all-tools`), so you are not asked to approve every edit or shell command.
- **File access stays limited.** Path verification stays on. OpenFleet adds `--add-dir` for the workspace, the project's `worktrees/`, cloned repos in `repos/` and every local repo in `repos.json`. Access to any other path still prompts.
- **URL access still prompts** (OpenFleet does not pass `--allow-all-urls`).

Pass `--ask` to `new`, `resume` or an extension command to get Copilot's normal per-tool prompts. These defaults are for Copilot; see [Hosts](#hosts) for the Claude Code equivalents. To allow everything, pass Copilot's own flag: `npx openfleet resume x -- --yolo`.

`new`, `resume` and `status` warn when another active project touches the same repo.

The agents also use the helper commands `state`, `event`, `worktree`, `preflight`, `next`, `gate`, `baseline`, `claim`, `ack`, `scope`, `merge`, `escalate` and `ext plan|result|fail`. See `npx openfleet help`.

## Hosts

OpenFleet runs on [GitHub Copilot CLI](https://github.com/github/copilot-cli) and [Claude Code](https://code.claude.com). Both are fully supported and tested against the same scenarios.

- `npm create @openfleet-tools` and `npx openfleet init` ask which host the workspace uses and save it as `host` in `openfleet.json`. Pass `--host <copilot|claude>` to skip the question; without a terminal (or in CI) the host is `copilot`.
- `npx openfleet config set host <copilot|claude>` changes the host for new projects, and `npx openfleet new <name> --host <host>` overrides it for one project. A project keeps the host it was created with: `resume --host` with another host is refused.
- Requires Claude Code 2.1.219 or later. OpenFleet runs `claude --version` and refuses older versions. `OPENFLEET_CLAUDE_BIN` overrides the binary, like `OPENFLEET_COPILOT_BIN`.
- The same core generates a plugin per host: the Copilot plugin in `core/` and the Claude Code plugin in `core/claude/` (agents, skills and hooks, sharing `core/lib`). Workspaces created before host support need `npx openfleet update` first.
- Permissions: `--permission-mode acceptEdits --allowedTools Bash` and the same `--add-dir` list as Copilot. `--ask` keeps the default permission mode. OpenFleet never passes `bypassPermissions` or `--dangerously-skip-permissions`.
- Agents, skills, events, worktrees and extensions work the same way. OpenFleet still manages worktrees (Claude Code's own worktree isolation is not used). Subagents run in the background and report back through completion notifications, and coordinators reply with `SendMessage`.
- Extensions can limit phases and augments to some hosts with [`hosts`](docs/extensions.md#phase-entries).

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

See [docs/events.md](docs/events.md) for the schema.

## Extensions

Extensions are **instruction-only**: a folder with `openfleet.extension.json` and Markdown, and no executable code. An extension (manifest v2) can run agents at phase slots (`pre-spec`, `post-plan`, `plans-ready`, `pre-implement`, `post-test`, `post-run`), augment a role's instructions (`coordinator`, `repo-coordinator`, `planner`, `baseline`, `implementer` or `tester`), and add CLI commands. Phase entries can be blocking, can run only when certain files exist, and can report outputs (such as a published version or a PR URL) that OpenFleet injects into dependent repos' prompts. Settings are workspace-level: they live in `extensions.config.json`, you set them with `npx openfleet ext settings set`, and the grill asks you about any setting that has no value yet. Write and shell access must be declared, and the generated agent's tool allow-list enforces it.

See [docs/extensions.md](docs/extensions.md).

## Development

```sh
pnpm install
pnpm test        # builds, then runs vitest
pnpm typecheck
pnpm lint        # ESLint (typescript-eslint, type-aware)
pnpm format      # Prettier; `pnpm format:check` is what CI runs
```

`pnpm install` sets up [husky](https://typicode.github.io/husky/) git hooks. On commit, [lint-staged](https://github.com/lint-staged/lint-staged) runs `eslint --fix` and Prettier on the staged files, and [commitlint](https://commitlint.js.org/) checks the message. Use [Conventional Commits](https://www.conventionalcommits.org/) with a sentence-case subject and a header of at most 72 characters, for example `feat: Add draft PR support`. Set `HUSKY=0` to skip the hooks.

Packages:

- `packages/cli` is `@openfleet-tools/cli`: the `openfleet` binary, plus `core/` (Copilot plugin: agents, skills, hooks).
- `packages/create` is `@openfleet-tools/create`: the `npm create @openfleet-tools` initializer.

To try a local build, run `node packages/create/dist/index.js ../my-fleet --cli file:$PWD/packages/cli`. Set `OPENFLEET_COPILOT_BIN` to use a different `copilot` binary.

Design notes are in [docs/design.md](docs/design.md), and the flow is in [docs/flow.mmd](docs/flow.mmd).

The website ([openfleet.tools](https://openfleet.tools)) is a single static page in `site/index.html`, with no build step. Pushes to `main` that touch `site/` deploy it to GitHub Pages through [`pages.yml`](.github/workflows/pages.yml).

## Releasing

Releases use [Changesets](https://changesets.dev). `@openfleet-tools/cli` and `@openfleet-tools/create` are a `fixed` group, so they always share a version. `@openfleet-tools/create` installs `@openfleet-tools/cli@^<its own version>` by default.

1. In a PR that changes a package, run `pnpm changeset` and commit the generated file. CI warns (without failing) when a PR has no changeset; use `pnpm changeset --empty` for changes that need no release.
2. On every push to `main`, [`release.yml`](.github/workflows/release.yml) opens or updates a **Version Packages** PR that bumps the versions and writes the `CHANGELOG.md` files.
3. Merging that PR publishes both packages to npm with [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, provenance, no `NPM_TOKEN`) and creates GitHub Releases.

### One-time setup

Trusted publishing can only be configured for a package that already exists on npm. So each package needs one manual placeholder publish at `0.0.0` before the first CI release. The repo is at `0.0.0` with an initial `minor` changeset, so the first Version Packages PR releases `0.1.0`.

1. Publish placeholders from an empty directory, signed in with `npm login` as a member of the `openfleet-tools` npm org:

   ```sh
   cd "$(mktemp -d)"
   for name in @openfleet-tools/cli @openfleet-tools/create; do
     printf '{"name":"%s","version":"0.0.0","description":"Placeholder. See https://openfleet.tools","repository":{"type":"git","url":"git+https://github.com/yashicon21/openfleet-tools.git"}}\n' "$name" > package.json
     npm publish --access public
   done
   ```

2. For **each** package on npmjs.com, go to **Settings → Trusted publishing → GitHub Actions** and enter:
   - Organization or user: `yashicon21`
   - Repository: `openfleet`
   - Workflow filename: `release.yml`
   - Environment: leave empty

   A new trusted publisher must complete a publish within 2 days, or it expires and must be recreated. So configure it just before you merge the first Version Packages PR.

3. Optional, recommended: in each package's **Settings → Publishing access**, choose **Require two-factor authentication and disallow tokens**.
4. In the GitHub repo, under **Settings → Actions → General**, enable **Allow GitHub Actions to create and approve pull requests**.
5. The initializer used to be published as `create-openfleet`. Deprecate it so users are pointed to the new name:

   ```sh
   npm deprecate create-openfleet "Renamed to @openfleet-tools/create — use: npm create @openfleet-tools"
   ```

`pnpm release` builds and runs `changeset publish` for a manual local publish. CI does not use it.

## License

[MIT](LICENSE)
