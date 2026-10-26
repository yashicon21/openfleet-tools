# @openfleet-tools/cli

## 1.0.0

### Major Changes

- [#5](https://github.com/yashicon21/openfleet-tools/pull/5) [`26144fc`](https://github.com/yashicon21/openfleet-tools/commit/26144fc2dc78277762f4c7bed9ec176aece3af3e) Thanks [@yashicon21](https://github.com/yashicon21)! - Node.js 22 or later is now required (Node 20 reached end of life in April 2026), and the supported platforms are documented: macOS and Linux, and Windows through WSL2 (native Windows is not supported). CI tests Linux and macOS on Node 22 and 24.

- [#7](https://github.com/yashicon21/openfleet-tools/pull/7) [`4347049`](https://github.com/yashicon21/openfleet-tools/commit/434704900e5c62ce6cf34c335892c4681948c5fc) Thanks [@yashicon21](https://github.com/yashicon21)! - **OpenFleet 1.0.** One coordinator agent drives a change across many repos, monorepo packages or parts of an app, on GitHub Copilot CLI or Claude Code. It interviews you once, writes a spec, plans every part at once, checks that the plans agree, then runs a planner → implementer → tester pipeline per part in its own git worktree, hands-off, and ends with staged changes, draft PRs or GitHub stacked PRs, a run summary and an HTML report.
  
  What 1.0 covers:
  
  - **Changes to existing repos:** repos, monorepo packages and path-scoped units (such as one page of an app), with repo coordinators that merge a repo's parts into one integration branch, contract tests over shared fixtures, optional baseline tests, retries with one guided attempt, and assumptions logged instead of questions mid-run.
  - **New systems from scratch (greenfield):** the grill proposes services, contracts, a monorepo and the stack, cuts the request to an MVP slice with one end-to-end flow, and OpenFleet creates the repos and builds setup → contracts → services and frontend → system. `npx openfleet continue` builds the next slice from the Follow-ups.
  - **Control and cost:** spending limits (`budget.maxTokens`, `budget.maxCost`), `pause` and `cancel`, a model per agent role (`models.<host>.<role>`), and a run report with tokens, cost and the models each role used.
  - **Stable workspaces:** schema checks on every workspace file, and `npx openfleet update` migrates them, so a 1.x workspace keeps working across upgrades.
  
  Breaking changes since 0.8: Node.js 22 or later is required, and native Windows is not supported (use WSL2).

### Patch Changes

- [#6](https://github.com/yashicon21/openfleet-tools/pull/6) [`3a66c0d`](https://github.com/yashicon21/openfleet-tools/commit/3a66c0dcad2c2b75b4f1eb88ae6f95f312297c60) Thanks [@yashicon21](https://github.com/yashicon21)! - Warn that `npx openfleet` must run inside the workspace folder: elsewhere npx would fetch an unrelated npm package that is also named `openfleet`. `init` says so after setup, `npm create @openfleet-tools <dir>` prints the `cd` to run first, and the README and site show `npx @openfleet-tools/cli <command>` for running OpenFleet from anywhere.

- [#8](https://github.com/yashicon21/openfleet-tools/pull/8) [`3bfb11a`](https://github.com/yashicon21/openfleet-tools/commit/3bfb11aa25b72b580ec667e4e67ab547761743da) Thanks [@yashicon21](https://github.com/yashicon21)! - Package descriptions and npm keywords mention Claude Code next to GitHub Copilot CLI; `@openfleet-tools/create` gets keywords.

- [#10](https://github.com/yashicon21/openfleet-tools/pull/10) [`1de6a16`](https://github.com/yashicon21/openfleet-tools/commit/1de6a16da35ed5a8232310d8a88dab84797dd051) Thanks [@yashicon21](https://github.com/yashicon21)! - The README covers both stories up front (existing repos and new systems), says what a run takes (agents, time, and how to keep cost in check) and lists the limitations and known issues of v1, including that Ollama and other providers are not supported.

- [#13](https://github.com/yashicon21/openfleet-tools/pull/13) [`c626f1f`](https://github.com/yashicon21/openfleet-tools/commit/c626f1fcb4a1079b1a20dc8b1cdc5523e5b6dacb) Thanks [@yashicon21](https://github.com/yashicon21)! - Both packages now ship the MIT `LICENSE` file.

## 0.8.0

### Minor Changes

- [#3](https://github.com/yashicon21/openfleet-tools/pull/3) [`44e3081`](https://github.com/yashicon21/openfleet-tools/commit/44e30810521abd9fe7c63e52799a2d7703f2aac1) Thanks [@yashicon21](https://github.com/yashicon21)! - Choose the model for each agent role.
  
  - New workspace setting `models.<copilot|claude>.<key>`, set with `npx openfleet config set models.<host>.<key> <model>` (`""` removes one). Keys: `default`, `coordinator`, `repo-coordinator`, `planner`, `baseline`, `implementer`, `tester` and `extensions` (extension agents). A role without a model uses `default`, then the host's own default, so one model for everything and any mix per role both work.
  - The models are written into the generated agent files (`model:`), as given for each host (Claude Code ids are no longer shortened), and the coordinator also gets `--model` at launch unless one is passed after `--`. `config set models.*` regenerates the agents right away; a change applies from the next `new` or `resume`.
  - The grill shows the models for the project's host and how to change them.
  - The coordinator's launch logs `models.configured`, and `npx openfleet report` shows a "Models by role" table: the configured model next to the models the transcripts show each role used.

- [#2](https://github.com/yashicon21/openfleet-tools/pull/2) [`969a23e`](https://github.com/yashicon21/openfleet-tools/commit/969a23e0a0ca553f233c041047e4aee749772a58) Thanks [@yashicon21](https://github.com/yashicon21)! - Spending limits and stopping a run.
  
  - New workspace settings `budget.maxTokens` and `budget.maxCost` (USD, priced with `pricing`), set with `npx openfleet config set budget.<key> <n>`; a project can override them (`budget` in its state, offered in the grill). Before every spawn, `npx openfleet claim` reads the run's token usage from the host transcripts. It logs `budget.warning` once at 80%, and when a limit is reached it halts the run: `claim` returns `{"result":"stop"}`, `next` returns only a `halt` action, and the coordinators spawn nothing more, let running agents finish, write the summary and stop.
  - New commands `npx openfleet pause <name>` and `npx openfleet cancel <name>` (both with `--reason`) halt a run from another terminal. A cancelled project is `cancelled` and frees its workspace slots; worktrees and branches are kept.
  - `npx openfleet resume` clears a halt and warns if a spending limit is still reached; a cancelled project needs `--reopen`. `status` shows the halt and usage against the limits. New events `run.halted`, `run.resumed` and `budget.warning`.
  - `npx openfleet report` shows the spending limits against usage, every halt, resume and 80% warning, and marks a halted run in its header.

- [#2](https://github.com/yashicon21/openfleet-tools/pull/2) [`849fbdf`](https://github.com/yashicon21/openfleet-tools/commit/849fbdf5fb681bc003a71fddb586f4c1e8905497) Thanks [@yashicon21](https://github.com/yashicon21)! - Safe upgrades between versions.
  
  - `state.json`, `repos.json` and `extensions.lock.json` are checked against the schema this CLI reads. A file from a newer OpenFleet is refused with "upgrade the CLI", and one with an older schema is refused with "run `npx openfleet update`", instead of being misread.
  - `npx openfleet update` migrates every one of those files first, keeping a `<file>.v<N>.bak` copy of each original, and refuses to downgrade a workspace whose core is newer than the CLI.
  - A test upgrades a workspace made with 0.6.0 and checks that its projects keep working.

## 0.7.0

### Minor Changes

- [`d7504b4`](https://github.com/yashicon21/openfleet-tools/commit/d7504b4aff58239c7e444077eb4a3d22dd18b3b9) Thanks [@yashicon21](https://github.com/yashicon21)! - Greenfield preflight, completion and `continue`.
  
  - Preflight for greenfield projects checks that `node`, `git`, `docker` and the toolchains the stack needs (`state.toolchains`, for example `pnpm`, `uv`, `go`) are on PATH, and that their package registries are reachable (honouring `npm_config_registry`, `PIP_INDEX_URL`/`UV_INDEX_URL` and `GOPROXY`). Failures name the tool or registry with an install hint.
  - Greenfield completion: when the end-to-end flow (the system child) passed, the result is committed on the new repo's `main` (new completion mode `main`), or, with a GitHub remote, pushed as one draft PR into `main` with everything after the initial commit. Otherwise nothing lands and the summary says why.
  - New command `npx openfleet continue <project> [name]` starts the next slice of a finished greenfield project: a new project (default `<project>-2`) whose spec draft holds the previous Layout, Stack and Follow-ups backlog and whose contracts are copied over. Its repos are reused (no longer greenfield), the grill skips the stack questions, and the same scope caps apply. Logs `project.continued`.
  - The run report shows `greenfield` or `continues <project>` in its header.

- [`d7504b4`](https://github.com/yashicon21/openfleet-tools/commit/d7504b4aff58239c7e444077eb4a3d22dd18b3b9) Thanks [@yashicon21](https://github.com/yashicon21)! - The coordinator can now run greenfield projects end to end.
  
  - The grill detects a request for a new system, proposes services and contracts, recommends one monorepo, asks the stack questions once with a recommendation each, offers a GitHub remote, shows the greenfield caps and cuts the request to an MVP slice with one end-to-end flow, moving the rest to `## Follow-ups`. The spec gains **Layout**, **Stack**, **End-to-end flow**, a **Kind** column and **Follow-ups**.
  - New helper `npx openfleet spec-check <project>` lists what would block approving a greenfield spec, so the grill fixes it before the last question.
  - After approval the coordinator creates the repos with `npx openfleet repo create`; preflight accepts a greenfield project's repos that do not exist yet.
  - Each greenfield child's agents get kind-specific instructions in their assignment: the setup child scaffolds with official generators run non-interactively, the contracts child writes schemas and generated clients, services and the frontend build on them, and the system child adds docker-compose, generated dev-only credentials in a git-ignored `.env.local`, seed data and the end-to-end flow.
  - New helper `npx openfleet repo confirm <key> [--package <name> [--path <dir>]] [--build|--test|--e2e <cmd>] [--copy-file <f>]` records the commands the setup and system children's testers confirmed in `repos.json`.

- [`d7504b4`](https://github.com/yashicon21/openfleet-tools/commit/d7504b4aff58239c7e444077eb4a3d22dd18b3b9) Thanks [@yashicon21](https://github.com/yashicon21)! - First building blocks for greenfield projects (new systems built from scratch).
  
  - New helper `npx openfleet repo create <key> [--github <owner/name>] [--project <name>]` creates `repos/<key>` with an empty initial commit on `main` and registers it in `repos.json` with `greenfield: true`. It refuses a non-empty folder or an existing key. `--github` also creates a private GitHub repo with `gh` and pushes the initial commit, with clear errors when `gh` is missing or not signed in. `--project` marks the project as greenfield and logs a `repo.created` event.
  - Project state gains `greenfield` and children gain `kind` (`setup`, `contracts`, `service`, `frontend`, `system`). In a greenfield project OpenFleet adds the run order to `dependsOn`: setup → contracts → services and frontend → system.

- [`d7504b4`](https://github.com/yashicon21/openfleet-tools/commit/d7504b4aff58239c7e444077eb4a3d22dd18b3b9) Thanks [@yashicon21](https://github.com/yashicon21)! - Greenfield projects are capped at an MVP slice, enforced by the CLI.
  
  - Approving a greenfield spec (`specApproved: true`) is refused, with every problem listed, when a child has no `kind`, when there are more services, children or acceptance criteria per child than allowed, or when `spec.md` has no non-empty `## Follow-ups` section listing what was cut.
  - New workspace settings `greenfield.maxServices` (default 5), `greenfield.maxChildren` (12) and `greenfield.maxCriteriaPerChild` (8), changed with `npx openfleet config set greenfield.<key> <n>`.
  - `plan.rejected` now requires a `reason`, and accepts the new `out-of-scope` for plans that build a Follow-ups item. Coordinators check greenfield plans against Follow-ups, and testers flag endpoints, pages or tables that no contract or acceptance criterion asks for.

- [`d7504b4`](https://github.com/yashicon21/openfleet-tools/commit/d7504b4aff58239c7e444077eb4a3d22dd18b3b9) Thanks [@yashicon21](https://github.com/yashicon21)! - Draft PRs can open as GitHub stacked pull requests.
  
  - With the `draft-pr` completion mode on GitHub, the grill asks whether a repo with several children (including a greenfield monorepo) should open as a stack of smaller PRs, one per child in merge order, instead of one PR. It checks for the `gh stack` extension and offers to install it. The choice is saved as `prStack`.
  - New helper `npx openfleet stack <project> <repo>` creates one branch per merged child from the integration branch's history (the top layer is the integration branch, with any integration fixes), records the layers and logs `stack.created`. Finalize then opens them with `gh stack init` and `gh stack submit --auto`, and falls back to one PR if `gh stack` fails.

### Patch Changes

- [`d7504b4`](https://github.com/yashicon21/openfleet-tools/commit/d7504b4aff58239c7e444077eb4a3d22dd18b3b9) Thanks [@yashicon21](https://github.com/yashicon21)! - Document greenfield projects in the READMEs, the design notes, the flow diagram source and the site's quick start, and add a greenfield demo (`pnpm demo --greenfield`) with the invoice and payment tracker prompt.

## 0.6.0

### Minor Changes

- [#35](https://github.com/yashicon21/openfleet/pull/35) [`bece92d`](https://github.com/yashicon21/openfleet/commit/bece92d5181c2ef0d47e11497801e3d1e9b6b553) Thanks [@yashicon21](https://github.com/yashicon21)! - Claude Code is now a fully supported host alongside GitHub Copilot CLI.
  
  - `npx openfleet init` asks which host the workspace uses (Copilot CLI or Claude Code) and saves it as `host` in `openfleet.json`. Pass `--host <copilot|claude>` to skip the question; without a terminal (or in CI) the host is `copilot`. Re-running `init` keeps the saved host unless `--host` is given.
  - Launching Claude Code no longer prints a warning. Docs, help text and the grill skill describe both hosts equally.
  - New parity tests run the same scenarios against both hosts: launch args, generated plugins, hook payloads and the host binary and version checks.

## 0.5.0

### Minor Changes

- [#30](https://github.com/yashicon21/openfleet/pull/30) [`32e5251`](https://github.com/yashicon21/openfleet/commit/32e52512e6aa0a4df644c7a2d55315dd6f4603c5) Thanks [@yashicon21](https://github.com/yashicon21)! - Flatten the workspace layout. `npm create @openfleet-tools` and `npx openfleet init` no longer create an `openfleet/` subfolder: `core/`, `extensions/`, `projects/`, `repos.json`, `extensions.lock.json` and `extensions.config.json` now sit in the workspace root, next to `package.json` and `node_modules/`. Repos cloned from a `url` go to `repos/<key>`.
  
  - A new root file, `openfleet.json`, marks the workspace (commands walk up from the current folder to find it) and records the core `version`. It replaces `config.json`: workspace settings such as `maxParallel` and `host` live in it, and `npx openfleet config` / `config set` read and write it.
  - `init` refuses a folder without `openfleet.json` that already contains any of the entries it would create, and lists them. Use an empty folder or a new subfolder.
  - `init` writes a root `.gitignore` (including `node_modules/`, `repos/` and `projects/*/worktrees/`) only if none exists. Otherwise it leaves the file unchanged and prints the lines it lacks.
  
  Existing workspaces are not migrated automatically. To move one by hand, from the workspace root:
  
  1. Move everything in `openfleet/` up one level (`core/` can be deleted instead; `npx openfleet update` reinstalls it).
  2. Rename `config.json` to `openfleet.json` (create `{}` if you had no `config.json`), then run `npx openfleet update` to record the version.
  3. Cloned repos move from `openfleet/repos/` to `repos/` with step 1. Moving `projects/` and `repos/` breaks the links of existing worktrees: run `git worktree repair <worktree paths>` in each repo, or `npx openfleet clean` finished projects before moving.
  4. Merge `openfleet/.gitignore` into the root `.gitignore`, add `node_modules/`, and delete the empty `openfleet/` folder.

- [#34](https://github.com/yashicon21/openfleet/pull/34) [`47a54d0`](https://github.com/yashicon21/openfleet/commit/47a54d08a8eae2f668c0026ff1e0b36a9ebf2696) Thanks [@yashicon21](https://github.com/yashicon21)! - Add `npx openfleet report <project> [--out <file>] [--open] [--gap <min>]`. It writes `projects/<project>/report.html`, a single self-contained HTML report of a finished or running project, built from `events.jsonl`, `state.json`, `spec.md`, `summary.md` and git without an agent: active and wall-clock time (pauses longer than `--gap` minutes, default 15, are collapsed), how the work was split, a timeline of every child's phases, the plan gate, agents at once and spawns by role, lines changed and test runs per child, and the `Coverage`, `Assumptions`, `Follow-ups` and `Lessons` sections of `summary.md`.
  
  - Token usage by role and model is read from the host's transcripts on this machine (Claude Code or Copilot CLI) and counts each API message once. Cost is shown only when `openfleet.json` has a new optional `pricing` table (USD per million tokens per model); OpenFleet ships no prices.
  - Finalize now writes the summary under the `## Coverage`, `## Assumptions`, `## Follow-ups` and `## Lessons` headings, runs `openfleet report` at the end of every run, and links `report.html` from `summary.md`.

## 0.4.0

### Minor Changes

- [#28](https://github.com/yashicon21/openfleet/pull/28) [`bf8d7f6`](https://github.com/yashicon21/openfleet/commit/bf8d7f694c87efa31214eaa519400dda77868541) Thanks [@yashicon21](https://github.com/yashicon21)! - Add Claude Code as an experimental second host (`npx openfleet config set host claude` or `--host claude`). Copilot CLI stays the default and is unchanged.

## 0.3.1

### Patch Changes

- [#26](https://github.com/yashicon21/openfleet/pull/26) [`016fa50`](https://github.com/yashicon21/openfleet/commit/016fa5035e4f9586eaa55318d44002aaa413c969) Thanks [@yashicon21](https://github.com/yashicon21)! - Fix `npx openfleet resume`: it no longer passes `--name` together with the recorded `--session-id`, which Copilot rejects. Only new sessions are named. When Copilot no longer has the recorded session, `resume` starts a new one, records its id and logs `session.replaced`.

- [#26](https://github.com/yashicon21/openfleet/pull/26) [`b02c3ab`](https://github.com/yashicon21/openfleet/commit/b02c3ab2a003619b068548f5c01c4a0576ad0a5a) Thanks [@yashicon21](https://github.com/yashicon21)! - Detect sandbox write blocks before a run starts. New `npx openfleet preflight <project>` checks that git can write ref locks and worktree admin dirs in every repo; the grill runs it before spec approval, and the run runs it at start and after `resume`. The launcher probes the same writes before starting Copilot and stops when the sandbox is inherited from the launching shell, and warns when Copilot's command sandbox looks enabled. Git failures show git's stderr with a sandbox hint instead of a stack trace. Agents never read `copyFiles` or `.env*` files.

## 0.3.0

### Minor Changes

- [#14](https://github.com/yashicon21/openfleet/pull/14) [`0807b15`](https://github.com/yashicon21/openfleet/commit/0807b159bc239a225b38f0faf4136591e780a052) Thanks [@yashicon21](https://github.com/yashicon21)! - Plan every child up front behind a `plans-ready` gate with a cross-plan consistency check, add optional baseline tests that pass on the unchanged code and stay protected, copy local env files into worktrees (`copyFiles`, never committed or logged), give each child its own port range, and add the `plans-ready` and `pre-implement` extension slots.

- [#19](https://github.com/yashicon21/openfleet/pull/19) [`40896ed`](https://github.com/yashicon21/openfleet/commit/40896ede2ae5f76d9e1c3502f7bd49f2090c4ef1) Thanks [@yashicon21](https://github.com/yashicon21)! - Add path-scoped children and repo coordinators: a repo can have many children (`<repo>/<unit>` with `paths`), run by a repo coordinator that merges them into one integration branch and opens one PR per repo. Adds `claim` (workspace-wide `maxParallel`), `ack`, `scope --check`, `merge` and `escalate`, repo-level and child-level `dependsOn`, and a `repo-coordinator` extension role.

## 0.2.0

### Minor Changes

- [#11](https://github.com/yashicon21/openfleet/pull/11) [`3af02ac`](https://github.com/yashicon21/openfleet/commit/3af02ac0a77ab2c241680eb68ebf9c7bd56e163b) Thanks [@yashicon21](https://github.com/yashicon21)! - Add extension manifest v2: multiple `phases` and `augments` per extension, blocking phases with one retry, `when.files` conditions, timeouts, report `outputs` injected into dependent children as "Upstream outputs", mid-run PRs via a `prUrl` output, `followUps`, and per-workspace `settings` in `openfleet/extensions.config.json`. Version 1 manifests are rejected with their v2 equivalent.

## 0.1.1

### Patch Changes

- [#6](https://github.com/yashicon21/openfleet/pull/6) [`5b05b27`](https://github.com/yashicon21/openfleet/commit/5b05b275de4acadf558221285e7553803149f42a) Thanks [@yashicon21](https://github.com/yashicon21)! - Add package READMEs for npm.

## 0.1.0

### Minor Changes

- [#2](https://github.com/yashicon21/openfleet/pull/2) [`ac32d3c`](https://github.com/yashicon21/openfleet/commit/ac32d3cd5081692ee725a0b4f2bde0cc2f94e412) Thanks [@yashicon21](https://github.com/yashicon21)! - Initial release of OpenFleet: coordinate one change across many repos with GitHub Copilot CLI.
