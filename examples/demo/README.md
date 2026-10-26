# Demo: one change across two repos

A repeatable toy example for watching OpenFleet run end to end.

```sh
pnpm demo                      # or: examples/demo/setup.sh [dir]
pnpm demo --host claude        # run the demo in Claude Code
```

The script:

1. Builds the packages in this checkout.
2. Creates a fresh demo directory (default `${TMPDIR:-/tmp}/openfleet-demo`). Re-running wipes it; the script refuses to wipe a non-demo directory.
3. Creates two git repos from [`template/`](template), each with an initial commit on `main` and a passing `npm test` (`node:test`, no dependencies):
   - `api`: an HTTP service with `GET /greeting` → `{ "message": "Hello" }`.
   - `web`: a client that fetches `/greeting` and renders the message (its tests mock the API).
4. Scaffolds an OpenFleet workspace in `fleet/` with the local build (`@openfleet-tools/create --cli file:…/packages/cli --host <host>`, `copilot` unless you pass `--host claude`) and pre-seeds `repos.json` with both repos and their test commands.
5. Prints the next commands.

## Run it

```sh
cd "${TMPDIR:-/tmp}/openfleet-demo/fleet"
npx openfleet new greeting-lang "Add a language field to the greeting API and show it in web"
```

The coordinator should suggest `api` and `web`, agree a contract for the new `language` field, and finish the grill by showing the spec and asking if anything should change. Your answer starts the run: it then plans, implements and tests both repos in parallel without asking you anything more. Tool use is auto-approved and file access is limited to the workspace and the two repos, so the only prompts you should see are the grill questions and any URL access (add `--ask` to approve each tool yourself).

Watch from another terminal:

```sh
npx openfleet status greeting-lang
tail -f projects/greeting-lang/events.jsonl
```

In the default completion mode, changes are staged (not committed) in each worktree:

```sh
git -C projects/greeting-lang/worktrees/api diff --cached
git -C projects/greeting-lang/worktrees/web diff --cached
```

The spec, plans and contracts are in `projects/greeting-lang/`, and full patches are in its `patches/`.

Requirements: Node.js 20+, git, pnpm and a signed-in [Copilot CLI](https://github.com/github/copilot-cli). Running the project uses Copilot requests. With `--host claude`, you need a signed-in [Claude Code](https://code.claude.com) 2.1.219 or later instead (see [Hosts](../../README.md#hosts)).

## Greenfield: build a system from scratch

```sh
pnpm demo --greenfield                 # or: examples/demo/setup.sh --greenfield [dir]
pnpm demo --host claude --greenfield
```

This variant creates no toy repos. It scaffolds an empty workspace (default `${TMPDIR:-/tmp}/openfleet-greenfield-demo/fleet`) and prints the command that starts the invoice and payment tracker from [`greenfield/prompt.txt`](greenfield/prompt.txt):

```sh
npx openfleet new invoices "Create an invoice and payment tracking website with microservices and a frontend. …"
```

The grill proposes the services, a monorepo and the stack, cuts the request to an MVP slice with one end-to-end flow (create invoice → record payment → invoice shows paid) and lists the rest as Follow-ups. After you approve, OpenFleet creates the repo in `repos/`, scaffolds it, writes the contracts, builds the services and the frontend, and proves the flow with docker-compose. The result lands on the new repo's `main` (or in one draft PR, if you chose a GitHub remote). `npx openfleet continue invoices` starts the next slice.

Requirements: the ones above plus Docker (with the compose plugin) and the toolchains of the stack you pick; preflight checks them before the run starts. See [Greenfield projects](../../README.md#greenfield-projects).
