# How it works

## Workflow at a glance

1. **Grill.** `npx openfleet new <name> "<request>"` starts the coordinator. It asks you questions and writes `spec.md` (repos and children, contracts, shared approach, baselines, branches, parallelism, completion mode). Your answer to the final "anything to change?" question starts the run. Everything after that is hands-off.
2. **Plan.** Every child's planner runs at once. The coordinator validates each plan against the spec.
3. **Gate.** All plans are checked against the spec's shared approach and against each other (per repo, then across repos). Then `plans-ready` extensions run.
4. **Baseline** (optional, per child). Tests for today's behaviour are written and pass on the unchanged code.
5. **Implement → test.** These run in `dependsOn` order, with at most `maxParallel` agents working across the workspace, and failures are retried.
6. **Integrate.** A repo with several children merges them into its integration branch and runs the full build and tests there.
7. **Finalize.** Changes are staged in each worktree, or opened as cross-linked draft PRs. On GitHub, a repo with several children can open as a stack of smaller PRs instead, one per child ([stacked pull requests](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands), via `gh stack`; the grill asks). `summary.md` lists assumptions, failures and follow-ups, and `report.html` shows the whole run (see [Run report](./run-report.md)).

## The run

After `npx openfleet new`, the coordinator:

1. **Grills you** about the change, suggests repos from `repos.json`, discovers build and test commands, and confirms them with you.
2. Writes `projects/<name>/spec.md` (goal, repos, contracts, ordering, acceptance criteria, branches, completion mode). The grill ends with a spec summary and one question, "anything to change?". **Your answer starts the run; after that it is hands-off.**
3. Plans every child at once (read-only planners), validates each plan against the spec, and checks that all plans agree with the spec's shared approach and with each other before anything is implemented (the `plans-ready` gate). Then, in dependency order and with at most `maxParallel` agents working at a time across the workspace (a workspace setting, default 6), it optionally runs a baseline tester (tests for today's behaviour that must pass on the unchanged code, and that the implementer may only change where the spec allows), then an implementer and a tester. Each child gets its own port range so apps and e2e tests can run side by side. A failing test sends the findings to a new implementer, up to 3 retries. Then the coordinator reviews the findings and diff itself and makes one guided attempt; if that fails too, the child is marked `failed`, its dependents `blocked`, and the rest of the run continues.
4. Finishes in the completion mode you chose: changes **staged** in each worktree for your review (default), or **draft PRs** that link to each other.

Child questions go to the coordinator. It answers from the spec, or decides itself and logs an `assumption`. The run summary lists every assumption and every failed child (with findings and worktree paths); `npx openfleet resume <name>` lets you deal with failures later.

## Children, scoped children and repo coordinators

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

For scale, the run on [openfleet.tools/how-it-works](https://openfleet.tools/how-it-works.html?run=ui-migration) moved one app to a new component library page by page: 10 children, 83 agent spawns, at most 7 agents at once, 3 retries and about 2.1 hours of active time (6 hours on the clock, including pauses).

Start with a small project to see what your host and models cost, then:

- set a spending limit (`npx openfleet config set budget.maxTokens <n>`, or `budget.maxCost` with `pricing`), so a run halts instead of overspending;
- lower `maxParallel` on a small machine or a tight plan;
- pick cheaper models for some roles (see [Models](./models-and-hosts.md#models));
- read `npx openfleet report <name>` afterwards for tokens, cost and the models each role used.

## Events

Each project has an append-only `events.jsonl`. Hooks capture subagent starts and stops, file changes (with full patches) and a git diff snapshot of each worktree when an agent stops. The coordinator logs messages, questions, plans, test runs, contract changes, the assumptions it made on its own (`assumption`), failed children (`child.failed`), plan-gate results, baselines, extension results, escalated questions (`question.escalated`) and merges into integration branches (`child.merged`, `merge.conflict`). Secrets are redacted.

See [docs/events.md](./events.md) for the schema.

## Extensions

Extensions are **instruction-only**: a folder with `openfleet.extension.json` and Markdown, and no executable code. An extension (manifest v2) can run agents at phase slots (`pre-spec`, `post-plan`, `plans-ready`, `pre-implement`, `post-test`, `post-run`), augment a role's instructions (`coordinator`, `repo-coordinator`, `planner`, `baseline`, `implementer` or `tester`), and add CLI commands. Phase entries can be blocking, can run only when certain files exist, and can report outputs (such as a published version or a PR URL) that OpenFleet injects into dependent repos' prompts. Settings are workspace-level: they live in `extensions.config.json`, you set them with `npx openfleet ext settings set`, and the grill asks you about any setting that has no value yet. Write and shell access must be declared, and the generated agent's tool allow-list enforces it.

See [docs/extensions.md](./extensions.md).

---

[← README](../README.md) · **How it works** · [Greenfield projects](./greenfield.md) · [Workspace](./workspace.md) · [Commands](./commands.md) · [Models and hosts](./models-and-hosts.md) · [Run report](./run-report.md) · [Limitations and troubleshooting](./limitations-and-troubleshooting.md) · [Releasing](./releasing.md)
