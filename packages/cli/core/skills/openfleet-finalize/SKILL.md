---
name: openfleet-finalize
description: Finish an OpenFleet run. Run post-run extensions, then leave changes staged for review or open cross-linked draft PRs with a run summary, according to the spec's completion mode.
---

# Finalize

Use this skill when the project `status` is `finalizing`. Finalizing is still hands-off: do not ask the user anything. Report problems in the summary.

## 1. Post-run extensions

Run `npx openfleet ext plan <project> post-run` and spawn each entry under `run` in order (for example, an audit). Pass each one the project name. Record each report with `npx openfleet ext result <project> <extension> --slot post-run --report '<json>'`. `post-run` entries are advisory. Collect any report paths they produce for the summary.

## 2. Run summary

Write `projects/<project>/summary.md`. Start it with a `# <project>` title, then use `##` headings. `npx openfleet report` copies the sections named **Coverage**, **Assumptions**, **Follow-ups** and **Lessons** into the HTML report, so use those exact headings for them:

- Goal (from the spec).
- A table of children, grouped by repo (members of a repo with several children under its integration child, with whether they were merged): child id, outcome (`done`, `failed` or `blocked`), branch, worktree, files changed, lines added/removed (from the latest `worktree.snapshot` event of each child), retries, and tester result.
- **Failed and blocked children:** for each one, the reason, the last tester findings, the worktree path, and which children it blocked (from the `child.failed` events). Say that `npx openfleet resume <project>` continues with them.
- `## Coverage`: test coverage per child or repo, if a tester or extension reported it. Leave the heading out when there is no coverage data.
- `## Assumptions`: every `assumption` event, as a list of child, question, decision and rationale. Mark the ones that changed a contract. The user did not see these during the run, so make this list complete.
- **Baselines:** for each child with a baseline, the test files, the command and the results (from `baseline.passed`), and which baseline files changed and why (`npx openfleet baseline <project> <child> --check`).
- **Local files:** copied files per child, and any `copyFiles` that were missing (from `worktree.created`).
- The contracts, and any contract changes during the run.
- The questions asked and how they were answered, including questions escalated by repo coordinators (`question.escalated`) and the decisions.
- Merge conflicts and integration failures per repo (`merge.conflict`, integration tester findings).
- Extension reports, including `extension.skipped` and `extension.failed` events.
- `## Follow-ups`: every entry in `children.<id>.followUps` (per child, grouped by extension) and the project-level `followUps`. People must act on these after the run, so list them all.
- `## Lessons`: what slowed the run down or would help the next one (for example, plans sent back, retries, flaky tests, missing setup). Keep it short; leave the heading out when there is nothing to say.

## 3. Completion mode

**Repos with several children** (path-scoped children or several packages) are finalized **once per repo**, from the repo's integration child (keyed by the repo): its `worktree` and `branch` are the integration worktree and branch, which already contain every merged child. Treat the integration child like any other child below (one staged worktree or one PR per repo), and skip its member children: their own worktrees and branches are only working copies. If the integration child is `failed` or `blocked`, the repo gets no PR; list its members' outcomes, worktrees and branches in the summary.

**Local files never get committed.** Files in a child's `copiedFiles` are hidden from git, so `git add -A` skips them. Still, after every `git add -A` below, run `git -C <worktree> diff --cached --name-only` and, if any copied file is listed, unstage it with `git -C <worktree> reset -q -- <file>` before you commit. Never print their contents.

### Children that already have a PR

An extension can open a PR mid-run (it reports an output named `prUrl`, which is recorded as the child's `prUrl`). For each `done` child that already has `prUrl`, in **either** mode, because those changes are already pushed:

1. `cd <worktree> && git add -A`. If anything is staged, commit it (`git commit -m "<type>: <Subject>"`).
2. `git push origin <branch>` to the **same** branch. Never open a second PR for the child.
3. Update the existing PR body with `gh pr edit <prUrl> --body-file <tmp>`: the child's summary, acceptance criteria and results, a link to `summary.md`, the **Related PRs** list, and a **Follow-ups** list with the child's `followUps`.

Then handle the remaining `done` children with the completion mode below.

### `staged` (default)

For each `done` child without a `prUrl`, run `cd <worktree> && git add -A`. Do **not** commit. Tell the user where each worktree is, and show `git -C <worktree> diff --cached --stat`. Leave `failed` and `blocked` worktrees untouched.

### `draft-pr`

For each `done` child without a `prUrl` (skip `failed` and `blocked` children; they get no PR):

1. `cd <worktree> && git add -A && git commit -m "<type>: <Subject>"`. Use a Conventional Commit with a sentence-case subject that describes this child's change.
2. `git push -u origin <branch>`.
3. Open a draft PR: `gh pr create --draft --base <default branch> --head <branch> --title "<title>" --body-file <tmp>`. The body has the child's summary, its acceptance criteria and their results, a link to `summary.md`, and a **Follow-ups** list with the child's `followUps` (if any).
4. Record `prUrl` on the child.

When all PRs exist (including PRs opened mid-run), edit each PR body (`gh pr edit <url> --body-file …`) to add a **Related PRs** list that links every other PR in the run. Record each `prUrl` in `summary.md`.

If a push or PR command fails, record the error in `summary.md` and in the final report. Do not retry destructively, and do not stop the other children.

### Stacked PRs (`prStack`)

With `prStack: true`, a `done` repo with two or more merged children (its integration child) opens as a **stack** of draft PRs instead of one PR, using GitHub stacked pull requests. Single-child repos and repos that already have a `prUrl` are handled as above.

1. Commit what is left in the integration worktree (step 1 of `draft-pr`, with the copied-files check).
2. Create the layers: `npx openfleet stack <project> <repo>`. It makes one branch per merged child, in merge order (setup first), each pointing at the integration branch right after that child's merge; the top layer is the integration branch itself, so it also holds the integration fixes. It prints the layers and the commands to run.
3. In the integration worktree, run the printed commands: `gh stack init --base <default branch> <layer branches…>` (bottom to top), then `gh stack submit --auto`, which pushes every layer and opens each as a draft PR based on the one below it.
4. Run `gh stack view --json` to get each layer's PR URL. Edit each PR body (`gh pr edit <url> --body-file <tmp>`): that child's summary, its acceptance criteria and results, a link to `summary.md`, and the **Follow-ups**; the top PR also lists the integration result. Record the top layer's URL as the integration child's `prUrl` and list every layer's URL in `summary.md`.
5. Include every layer in the **Related PRs** lists of the other repos' PRs.

If `gh stack` is missing or fails, record the error, fall back to one draft PR for the repo (as in `draft-pr`), and say so in the summary. Never force-push over a stack someone has started reviewing.

### Greenfield repos (`state.greenfield`)

A new repo has no base to stage against, so `staged` does not apply. Each greenfield repo is finalized once, from its result: the integration child (monorepo) or its only child. The work sits on that branch, which starts at the empty initial commit on `main`.

1. **The end-to-end flow decides.** Only when every `system` child is `done` (its e2e flow passed) does the repo's work land. Otherwise land nothing: leave every branch and worktree as it is, say in `summary.md` and the final report that the MVP is not proven yet and why (the system child's findings), and that `npx openfleet resume <project>` continues. Then go to "Done".
2. Commit what is left on the branch: `cd <worktree> && git add -A`, check for copied files as above, and `git commit -m "feat: <Subject>"` if anything is staged.
3. **`main` (no GitHub remote):** fast-forward the new repo's `main` to the branch: `git -C <repo path> merge --ff-only <branch>`. The repo's main checkout (`repos/<key>`) then holds the whole system.
4. **`draft-pr` (GitHub remote from `repo create --github`):** `git push -u origin <branch>`, then open **one** draft PR into `main` with everything after the initial commit: `gh pr create --draft --base main --head <branch> --title "feat: <Subject>" --body-file <tmp>`. The body has the goal, the stack, the services and the frontend, the end-to-end flow and its result, a link to `summary.md` and the **Follow-ups**. Record `prUrl` on the child. With `prStack` (and two or more children in the repo), open it as stacked PRs instead, as "Stacked PRs" below describes; the layers then go setup → contracts → services and frontend → system.

In `summary.md`, list the spec's **Follow-ups** under `## Follow-ups` (before any extension follow-ups), and say that `npx openfleet continue <project>` starts the next slice from them.

## 4. Done

Log `run.completed` with the mode and per-child outcome. Patch `{"status":"done"}`. Then run `npx openfleet report <project>`: it writes `projects/<project>/report.html`, a self-contained HTML report of the run (timeline, plans, agents, changes, tests, tokens). Add a line `Report: [report.html](report.html)` near the top of `summary.md`. If the command fails, record the error in `summary.md` and go on.

End the run with a final report to the user:

- where to review (worktrees or PR links),
- the path to `report.html`,
- every assumption you made (child, question, decision),
- every extension follow-up, per child,
- failed and blocked children with their findings and worktree paths,
- `npx openfleet clean <project>` removes the child and integration worktrees after merging (`--branches` also deletes the local branches),
- `npx openfleet resume <project>` continues with failed children or review feedback; or they can start a new project.
- for a greenfield project: the spec's Follow-ups, and that `npx openfleet continue <project>` starts the next slice from them.
