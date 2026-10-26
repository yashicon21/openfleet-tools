---
name: openfleet-grill
description: Interview ("grill") the user to turn a free-text cross-repo request into a complete OpenFleet spec. Suggests repos from repos.json, discovers build/test commands, confirms them with the user, and ends with the spec review question. The grill is the only time OpenFleet asks the user anything.
---

# Grill session

The goal is to collect everything that `openfleet-spec` needs, so that no child has to guess later. **The grill is the user's only input.** After it, the run is hands-off: you will resolve every open point yourself and log it as an assumption. So ask now about anything a child is likely to need: edge cases, error handling, naming, defaults, compatibility. Ask questions in short rounds of 1–4 focused questions. Prefer multiple choice. Recommend a default when you have one. Do not interrogate the user about things you can find yourself in the repos.

## 0. Setup

- Read `repos.json` (known repos and packages, with confirmed build/test commands).
- Read the project's `state.json`. If `spec.md` already exists, you are refining it. Start from it.
- If `core/extensions.json` lists `pre-spec` agents, run that slot after step 4 with `npx openfleet ext plan <project> pre-spec` (see the coordinator rules).

## 1. Goal

Restate the user's request in one or two sentences and confirm it. Ask what "done" looks like from the user's point of view.

## 1b. Greenfield: a new system

If the user asks for something new ("create", "build a new …", "from scratch") and no repo in `repos.json` or the workspace fits, this is a **greenfield** project: OpenFleet creates the repos and builds the system. Confirm it with the user, then patch `{"greenfield":true}`. For a greenfield project, this section replaces steps 2, 2b, 3, 3b and 5c; steps 4, 5, 5b, 6 and 6b still apply. Ask each question once for the whole system, with a recommended answer.

1. **Services and contracts.** Propose the services (each owns its data), the frontend and the contracts between them, from the user's description. Keep it small.
2. **Layout.** Recommend **one monorepo** (one package per service, one for the frontend and one shared contracts package). Several repos are possible if the user wants them. Pick the repo key(s) (for example the project name).
3. **Stack**, one question per item, each with a recommendation: language and framework per service; frontend framework; database; service communication (REST/OpenAPI, gRPC or events); auth (recommend a dev-only stub login for the MVP); local run (recommend docker-compose). The answers go into the spec's **Stack** and **Shared approach** sections.
   Record the toolchains the stack needs besides `node`, `git` and `docker` (for example `pnpm`, `python3`, `uv`, `go`): patch `{"toolchains":["pnpm"]}`. Preflight checks that each one is on PATH and that their package registries are reachable, and fails with an install hint.
4. **GitHub remote (opt-in).** Ask whether to create a private GitHub repo per repo (`<owner>/<name>`). Default: local only. The completion mode follows from it: `main` without a remote (the result is committed on the new repo's `main`), `draft-pr` with one (one PR into `main` with everything after the initial commit). Do not ask about `staged`; it does not apply to a new repo.
5. **MVP slice.** Run `npx openfleet config` and show the greenfield caps (`greenfield.maxServices`, default 5; `greenfield.maxChildren`, 12; `greenfield.maxCriteriaPerChild`, 8). Propose a slice of the core flows that fits them (about 3–5 services plus the frontend), and **one end-to-end flow** that proves it (for an invoice tracker: create invoice → record payment → invoice shows paid). Move everything else into **Follow-ups** and show that list to the user, so they see what was cut. The user may raise a cap with `npx openfleet config set greenfield.<key> <n>`; never raise one yourself.
6. **Children.** One child per unit of work, each with a `kind`:
   - `setup` per repo (`<repo>/setup`): scaffolds with the official generators, adds lint/test/build and a sample test.
   - `contracts` (`<repo>:contracts` in a monorepo): schemas plus generated types and clients in a shared package.
   - `service` per service and `frontend` for the UI (`<repo>:<package>`).
   - `system` (`<repo>/system`): docker-compose, dev credentials, seed data and the end-to-end flow.

   OpenFleet adds the order to `dependsOn` itself (setup → contracts → services ∥ frontend → system). Baseline is `no` for every child (there is no existing behaviour). Build and test commands are not known yet: write the ones the setup child will create (for example `pnpm --filter <package> build`); the setup child confirms them.

7. **Env and secrets.** There are no real secrets: databases get dev-only credentials that the system child generates into a git-ignored `.env.local`, and third-party services (payments, email) are stubbed behind an interface with a mock provider. Record `.env.local` under the repo's local files in the spec.

Do **not** create any repo during the grill. The repos are created after the user approves the spec (see `openfleet-orchestrate`, section 0).

## 1c. Continuing a greenfield project

A project started with `npx openfleet continue <previous>` has `continuedFrom` in `state.json`. Its `spec.md` is a draft with the previous **Layout**, **Stack** and **Shared approach** and a **Backlog** of the previous Follow-ups; `contracts/` holds the previous contracts. It is a normal change to existing repos (they are in `repos.json` now, no longer greenfield), so steps 2–6b apply as usual, except:

- Do not ask the stack or layout questions again; keep the Stack and Layout sections.
- Show the backlog and the caps (`npx openfleet config`), and agree on the next MVP slice with the user. Everything in the backlog that is not in this slice goes to this spec's `## Follow-ups`: the same caps and the same Follow-ups rule apply, and `npx openfleet spec-check <project>` checks them.
- The backlog section is not part of the final spec: replace it with Children, Per-child requirements and Follow-ups as `openfleet-spec` describes.

## 2. Repos and packages

- Suggest likely repos from `repos.json`, based on names, descriptions and a quick search of their code.
- Ask about any other repos the change needs. Accept local paths or git URLs. Repos can live anywhere. The default search root is the workspace root (the folder the user ran `init` in). Look there for sibling checkouts before you ask for a path.
- For monorepos, identify the **packages** involved. Each package becomes its own child (own worktree and branch). The child id is `<repo>:<package-name>`.

## 2b. Units: path-scoped children

When one repo (or package) needs the same kind of change in many independent places, split it into **units** such as pages, modules or services, with one child (and one agent pipeline) per unit:

- Find candidate units in the code. For example, in a Next.js app each route is a unit: `app/**/page.tsx` (App Router) or `pages/**` (Pages Router). For other stacks, use modules, services or feature folders.
- Propose one child per unit, with its `paths` (globs relative to the repo or package root, for example `app/settings/**`). Show the list and let the user **group** units into one child or **skip** units before the spec review.
- The child id is `<repo>[:<package>]/<unit>`, for example `web/settings` (unit: lowercase letters, digits, `.`, `_`, `-`).
- Add a **setup child** `<repo>[:<package>]/setup` for shared setup (config, shared components, utils, dependencies), and make every unit child depend on it. Unit children never change shared files: their plans list the shared items they need, and the setup child provides them.
- Ask which extra files a unit may change besides its `paths` (for example shared test fixtures); record them as `allowPaths`.

A repo with more than one child (units or several packages) gets a **repo coordinator**: it runs that repo's children, merges them into one integration branch, runs the full build and tests there, and opens one PR for the repo. Other children can depend on a whole repo (`dependsOn: ["web"]`) or on one unit (`dependsOn: ["web/settings"]`).

## 3. Build and test commands

For each repo or package, discover the commands from `package.json` scripts, `Makefile`, `pyproject.toml`, `Cargo.toml`, `go.mod`, CI workflows, and similar files. Present what you found. Ask the user to confirm or correct it. Record the confirmed commands in `repos.json` (set `"confirmed": true`). Add new repos with `path` or `url`, and with `defaultBranch`. Keep the existing entries unchanged except for corrections that the user confirmed.

## 3b. Running the apps: e2e, env and local files

For each repo or package that has a UI or a server that tests must start:

- **E2E command:** discover it (for example a `test:e2e` or `playwright` script) and confirm it. Record it as `e2e` on the repo or package in `repos.json`.
- **Env vars and credentials:** find which env vars and credentials the app needs to run locally and in tests. Take the names only from code (`process.env.X`, `import.meta.env.X`, config schemas), from committed example files such as `.env.example`, or from the user. Record **names only** in `env` (for example `["AUTH_CLIENT_ID", "AUTH_CLIENT_SECRET"]`). **Never ask for, record, print or repeat values.**
- **Local files:** ask which git-ignored files from the user's main checkout the worktrees need (for example `.env.local`). Record them as `copyFiles` (paths relative to the repo root, no `..`). `npx openfleet worktree` copies them into every worktree and keeps them out of git and the logs.

**Never open local secret files.** Do not open, read, `cat`, `grep`, `sed`, `head`, `tail`, `awk` or otherwise inspect any `copyFiles` entry or any `.env*` file (`.env`, `.env.local`, `.env.production`, …), not even to list the names in it. The only exceptions are committed example files (`.env.example`, `.env.sample`, `.env.template`). If you need names you cannot find in code, ask the user.

## 4. Cross-repo contracts and ordering

- Identify every interface that crosses a repo boundary: API shapes, events, shared types, config keys, CLI flags, DB schemas.
- For each contract, agree on the exact shape (use `openfleet-contracts`), who produces it, and who consumes it.
- Agree on ordering dependencies (for example, "the SDK depends on the API"). The default is fully parallel.

## 5. Acceptance criteria

For each child, agree on concrete, verifiable acceptance criteria. The tester checks every criterion.

## 5b. Shared approach

When several children make the same kind of change (for example, several apps move to the same library), agree on what must be the **same** everywhere: config shape, file layout, patterns, env var names, library versions, naming. This becomes the spec's **Shared approach** section. All children are planned at once, and the coordinator rejects plans that differ from it or from each other.

## 5c. Baseline tests

For each child, decide whether it needs a **baseline**: tests (usually e2e) that a baseline tester writes and passes on the **unchanged** code before implementation starts. Recommend it when existing behaviour must be preserved and current test coverage is thin. If yes, agree on:

- what the baseline covers (flows, pages, endpoints), and
- which baseline behaviours the change is **allowed** to alter. The implementer may edit baseline tests only for these; any other edit fails the tester.

## 6. Branches, completion mode, scope

- **Branch names:** propose `openfleet/<project>` for each repo (for a repo with several children, this is its integration branch and the PR branch; each child's own branch defaults to `openfleet/<project>--<child slug>`). Ask the user to confirm or override.
- **Parallel agents:** run `npx openfleet config` and show the current `maxParallel`: how many planners, baseline testers, implementers and testers may run at once. Say it is a workspace setting shared by every project (not part of this spec), and offer to keep it or change it. Suggest fewer on a small machine or when apps start heavy dev servers. To change it, run `npx openfleet config set maxParallel <n>`; never edit `openfleet.json` by hand.
- **Host:** the project runs in the host recorded as `host` in `state.json` (missing means `copilot`; `claude` is Claude Code). Mention it in the spec summary. It cannot change mid-project; to use another host, the user starts a new project with `npx openfleet new <name> --host <host>`.
- **Completion mode:** `staged` (default: changes are left staged in each worktree for review) or `draft-pr` (commit, push, and open draft PRs that link to each other and include a run summary).
- **Stacked PRs** (only with `draft-pr`, when the repos are on GitHub and a repo has two or more children, including a greenfield monorepo): ask whether each such repo should open as a **stack of smaller PRs** (GitHub stacked pull requests, one PR per child in merge order, each based on the one below) instead of one PR for the whole repo. Recommend it when a repo has several children that a reviewer would read separately. It needs the `gh stack` extension: check with `gh extension list`; if `github/gh-stack` is missing, ask whether to install it (`gh extension install github/gh-stack`) and run that only on a yes. On a yes to stacks, patch `{"prStack":true}`. Repos with one child always get one PR, and a stack never spans repos (cross-repo PRs still link to each other).
- **Out of scope:** list explicitly what this project must NOT change.

## 6b. Extension settings

Run `npx openfleet ext settings --unset`. It prints, as JSON, every setting that an installed extension declares and that has no value yet in `extensions.config.json`. If the list is empty, skip this step. Settings that are already set are never asked again.

Otherwise ask about each unset setting (group them per extension, at most 4 per round). Show its extension, key, description and default, and say that the value applies to the **whole workspace** (every project), not just this one. Offer "Keep the default (`<default>`)" as the recommended choice; the user can also type a value. For every answer, including "keep the default", write it with:

```sh
npx openfleet ext settings set <extension> <key> '<value>'
```

This validates the key the same way core does and regenerates the extension agents. Never edit `extensions.config.json` by hand. Do not ask for secrets here; settings are stored in plain text.

## 7. Spec review (final question)

When all of this is answered, write the spec with `openfleet-spec` and register the children in `state.json`. Then run the preflight check:

```sh
npx openfleet preflight <project>
```

It checks that git can write ref locks and worktree admin dirs in every repo, that the worktrees dir is writable and that `copyFiles` can be opened (it never reads them). For a greenfield project, repos that do not exist yet only need a writable `repos/` folder. **Do not ask for approval while it fails**: `state --patch '{"specApproved":true}'` is rejected until it passes. Show the user its message as it is. `EPERM` ("Operation not permitted") means a sandbox blocks the writes. The likely causes, in order: OpenFleet or Copilot was started from a sandboxed shell (an IDE or app-embedded terminal, or an agent's shell): start `npx openfleet` from a normal terminal; Copilot's command sandbox is on: `/sandbox disable`, or add the repo paths to `sandbox.userPolicy.filesystem.readwritePaths` in `~/.copilot/settings.json`; a managed OS policy. It is **not** fixed by macOS Full Disk Access; never suggest that. `EACCES` is a plain file-permissions problem. After the user fixes it, run preflight again.

For a greenfield project, also run `npx openfleet spec-check <project>` before the final question. Approval is refused while the spec is over the greenfield caps, a child has no `kind`, or `## Follow-ups` is missing or empty; `spec-check` lists every such problem. Cut scope (move the cut items to Follow-ups), update `spec.md` and `state.json`, and run it again until it prints `"ok": true`. Ask the user to raise a cap only if cutting would lose the end-to-end flow.

When preflight passes, ask the final question from "Spec review" in `openfleet-spec`: show the summary and ask **"Anything to change before I start?"** The user's answer ends the grill. Apply any changes, log `spec.approved`, set `status: "running"`, and start the run immediately.
