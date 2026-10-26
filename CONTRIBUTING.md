# Contributing to OpenFleet

Thanks for helping. Bug reports, docs fixes, extensions and code are all welcome.

## Before you start

- **Bugs and features:** open an issue with the matching template first, so we can agree on the change before you write it. Small fixes (typos, broken links) can go straight to a PR.
- **Questions and ideas:** use [Discussions](https://github.com/yashicon21/openfleet-tools/discussions), so issues stay for bugs and agreed features.
- **Security issues:** never in a public issue. See [SECURITY.md](SECURITY.md).

## Setup

You need Node.js 22+, pnpm (`corepack enable pnpm`) and git.

```sh
pnpm install     # also sets up the git hooks
pnpm test        # builds, then runs vitest
pnpm typecheck
pnpm lint
pnpm format      # `pnpm format:check` is what CI runs
```

The repo has two packages:

- `packages/cli` is `@openfleet-tools/cli`: the `openfleet` command, plus `core/`, the plugin it installs for each host (agent templates, skills, hooks).
- `packages/create` is `@openfleet-tools/create`: `npm create @openfleet-tools`.

Design notes are in [docs/design.md](docs/design.md); read them before changing the run flow.

## Tests

Tests never call a real agent host. They run fake host binaries:

- `OPENFLEET_COPILOT_BIN` / `OPENFLEET_CLAUDE_BIN` point at a small Node script that records the arguments it was launched with (see `fakeCopilot` and `fakeClaude` in `packages/cli/test/cli.test.ts`).
- `OPENFLEET_GH_BIN` points at a fake `gh` for repo and PR commands.
- Token usage is tested with fake host transcripts under a temporary `COPILOT_HOME` or `CLAUDE_CONFIG_DIR`.

Behaviour that differs per host is covered by `packages/cli/test/host-parity.test.ts`; keep both hosts passing. Add a test for every bug fix and new command.

To try a local build end to end, create a scratch workspace from this checkout:

```sh
node packages/create/dist/index.js ../my-fleet --cli file:$PWD/packages/cli
```

`pnpm demo` does the same with two toy repos (`pnpm demo --greenfield` for a new system).

## Agent prompts and skills

Agent templates live in `packages/cli/core/templates/agents/` and skills in `packages/cli/core/skills/`. Text that differs per host goes in host blocks:

```md
<!--host:copilot-->Copilot wording<!--host:claude-->Claude Code wording<!--/host-->
```

Keep both hosts' wording equivalent. Agents never ask the user anything after the grill, and never read `.env*` or `copyFiles` entries.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/) with a sentence-case subject and a header of at most 72 characters, for example `feat: Add draft PR support`. commitlint checks this on commit.
- Add a changeset for every user-facing change: `pnpm changeset`, pick the packages and the bump, and write the release note in plain words. Use `pnpm changeset --empty` for changes that need no release.
- Keep PRs focused, and fill in the PR template. CI (lint, format, typecheck, build, tests on Linux and macOS) must pass.
- Don't put company or customer names in code, docs or examples.

## Releases

Maintainers release with [changesets](https://github.com/changesets/changesets): merging the "Version Packages" PR publishes both packages to npm with provenance. See "Releasing" in the [README](README.md#releasing).
