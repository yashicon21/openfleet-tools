---
name: openfleet-orchestrate
description: The hands-off OpenFleet run loop after the grill. Create worktrees, plan every child in parallel, check the plans for consistency at the plans-ready gate, then run optional baselines, implementers and testers in dependency order. Repos with several children get a repo coordinator that merges them into an integration branch. The coordinator answers child questions itself (logged as assumptions), broadcasts contract changes, retries up to 3 times plus one guided attempt, and marks children failed without asking the user.
---

# Orchestrate the run

Use this skill when the project `status` is `running`. Use `openfleet-records` for every state change and log entry.

**This loop is hands-off.** The user is not watching. Never ask the user anything and never use <!--host:copilot-->`ask_user`. Do not end your turn while any child is still pending or in progress: keep waiting with `read_agent` and acting on reports until every child is `done`, `failed` or `blocked`, then go to completion.<!--host:claude-->`AskUserQuestion`. Spawn agents with the `Agent` tool in the background, then end your turn: each finished agent arrives as a completion notification that starts your next turn. On every notification, act on the report, run `npx openfleet next <project>` and spawn what it returns. Never block waiting on one child. Keep going until every child is `done`, `failed` or `blocked`, then go to completion.<!--/host-->

## 0. Greenfield repos

For a greenfield project (`state.greenfield`), first create every repo from the spec's **Layout** that is not in `repos.json` yet, before preflight and before any worktree:

```sh
npx openfleet repo create <key> --project <project> [--github <owner>/<name>]
```

Pass `--github` only if the user opted into a GitHub remote in the grill. It makes an empty initial commit on `main` and registers the repo with `greenfield: true`. If it fails, report its message to the user as it is and stop. Never create a repo by hand, and never re-run it for a key that is already in `repos.json`.

## 0b. Preflight

At the start of the run, and first thing after `resume`, run `npx openfleet preflight <project>`. It checks that git can write in every repo (ref locks, worktree admin dirs) and that the worktrees dir is writable. Until it passes, `next` returns only `{"action":"preflight"}` and `claim` refuses every spawn. If it fails, do not create worktrees or spawn anything: report its message to the user as it is and stop. `EPERM` means a sandbox blocks the writes (most likely OpenFleet was started from a sandboxed shell; see the README's "Sandbox" section). Never blame or suggest macOS Full Disk Access.

## 1. Worktrees

Make sure every child from the spec is in `state.children` (with `repo`, `package`, `paths`, `allowPaths`, `setup`, `baseline`, `dependsOn`). A repo with two or more children automatically gets an **integration child** keyed by the repo (for example `web`), which depends on all of them; it stands for the repo's merged result, and its repo coordinator runs that repo (section 2a).

For each child that has no `worktree` yet and is **not** part of a repo with a repo coordinator:

```sh
npx openfleet worktree <project> <child id> [--branch <branch from spec>] [--package <pkg path>]
```

`--repo` defaults to the child id's repo and `--branch` to `openfleet/<project>`. Repo coordinators create the worktrees of their own children and their integration worktree.

The command also copies the repo's `copyFiles` (local env and credential files from `repos.json`) from the main checkout into the worktree and hides them from git. It warns about files that are missing; mention those in the final summary, but do not stop. Never open, read, `cat`, `grep`, `sed`, print or commit these files, or any `.env*` file.

## 2. Scheduling

Every run plans first:

1. **Plan everything.** Plan every child at the same time, ignoring `dependsOn`. Planners of dependent children plan against `contracts/`, because their dependencies are not implemented yet.
2. **`plans-ready` gate.** When every plan is validated, check that the plans are consistent with each other (section 3, "Consistency check"), run the project-level `plans-ready` extension slot, and open the gate.
3. **Implement in order.** After the gate, a child starts (baseline if it has one, then implementation) once every id in its `dependsOn` is `done`.

Do not work this out by hand. Run this whenever something changes (a report arrives, a phase changes):

```sh
npx openfleet next <project>
```

It prints `{"gate": "planning"|"checking"|"plans-ready"|"open", "actions": [...], "waiting": [...]}`. Do every action, <!--host:copilot-->then wait for the next report with `read_agent`:<!--host:claude-->then end your turn and act on the next completion notification:<!--/host-->

Every action has an `owner`: `top` (you) or a repo key. `next <project>` returns your actions, plus `delegated`: actions that belong to a repo coordinator (read them, but do not act on them). A repo coordinator runs `next <project> --repo <repo>` for its own.

| Action                                         | What to do                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `{"action":"repo-coordinator","repo":r}`       | Spawn that repo's coordinator (section 2a).                                                 |
| `{"action":"plan","child":id}`                 | Spawn its planner ("Plan" below).                                                           |
| `{"action":"check-consistency","children":…}`  | Run the consistency check for those children ("Consistency check" below).                   |
| `{"action":"plans-ready"}`                     | Run the `plans-ready` slot, then `npx openfleet gate <project> open` ("Gate" below).        |
| `{"action":"baseline","child":id}`             | Spawn its baseline tester ("Baseline" below).                                               |
| `{"action":"implement","child":id}`            | Run the child's `pre-implement` slot, then spawn its implementer ("Implement" below).       |
| `{"action":"block","child":id,"dependency":d}` | A dependency failed: patch the child `{"phase":"blocked","notes":"dependency <d> failed"}`. |
| `{"action":"finalize"}`                        | Every child is finished: go to section 5.                                                   |
| `{"action":"preflight","reason":…}`            | Run `npx openfleet preflight <project>` (section 0b); stop and report if it fails.          |

Repo coordinators also get `check-repo-consistency`, `merge`, `resolve-conflict` and `integrate` (section 2a).

<!--host:copilot-->Use background subagents and collect results with `read_agent`. Do not block on one child while others could make progress.<!--host:claude-->Spawn every agent with the `Agent` tool in the background (`subagent_type` is the full agent name, e.g. `openfleet:openfleet-planner`), then end your turn. Results arrive as completion notifications; after each one, run `npx openfleet next <project>`, which stays the source of truth. Do not block on one child while others could make progress. Never use the `Agent` tool's worktree isolation: OpenFleet creates the worktrees and passes their paths in the assignment.<!--/host-->

**Claim every spawn.** Right before you spawn any OpenFleet agent, run `npx openfleet claim <project> <child> <role>` (role: `planner`, `baseline`, `implementer`, `tester` or `repo-coordinator`). It sets the child's phase for that role (`planning`, `baseline`, `implementing`, `testing`) and `pendingSpawn`, which the spawn hook consumes to attribute the agent and inject its context.

- `{"result":"claimed",…}`: spawn that agent **now**, before any other claim. The `subagentStart` hook records its agent id on the child (`agentIds.<role>`); you do not patch it.
- `{"result":"wait","reason":…,"retryAfterSeconds":5}`: do not spawn. Either another claim for the same role is not consumed yet (spawn that one first), or `maxParallel` agents are already running across the workspace (workspace setting, `npx openfleet config`; default 6). <!--host:copilot-->Do other work or wait for a running agent with `read_agent`, then claim again.<!--host:claude-->Do other work, or end your turn and claim again after the next completion notification.<!--/host-->

## 2a. Repo coordinators

A repo with more than one child (path-scoped children such as pages or modules, or several monorepo packages) is run by a **repo coordinator**, `openfleet:openfleet-repo-coordinator`. Repos with one child stay with you, exactly as described in section 3.

1. **Spawn.** When `next` returns `repo-coordinator`, claim it (`npx openfleet claim <project> <repo> repo-coordinator`) and spawn it in the background: "Coordinate repo `<repo>` of project `<project>`." Repo coordinators do not count toward `maxParallel`. Nesting is you → repo coordinator → role agents.
2. **What it does.** It runs its children's planners, baselines, implementers and testers (and their extension slots), answers their questions, and merges each `done` child into the repo's integration branch (`openfleet/<project>` or the spec's branch) with `npx openfleet merge`: the setup child first, then the others in the order they reached `done`. A merge conflict sends the child back to its implementer (rebased onto the integration branch) and tester. Once every child is merged, an integration tester runs the repo's full build and tests on the integration branch; failures go to an integration implementer with the usual retries (3 plus one guided attempt). Then it sets the integration child (`<repo>`) to `done` or `failed` and reports once.
3. **Two-level gate.** The repo coordinator checks its own children's plans against each other and the **Shared approach** (`gate <project> consistent --repo <repo>`), and adds every plan's **Shared items needed** to the setup child's scope. Then `next` gives you `check-consistency` for them: you check across repos as usual (section 3) and open the gate. Scoped children never add shared items themselves.
4. **Dependencies.** `dependsOn: ["<repo>"]` waits for the whole repo (its integration child); `dependsOn: ["<repo>/<unit>"]` waits for one child. A failed or blocked integration child blocks its dependents.
5. **Escalations.** A repo coordinator decides questions inside its repo itself. A question that changes a cross-repo contract or the Shared approach is escalated: the child is `blocked` with `blockedReason: "needs-escalation"` (`question.escalated`) and the coordinator lists it under `escalated` in its report. Decide it as in section 4, change the contract if needed (`openfleet-contracts`), then run `npx openfleet escalate <project> <child> --resolve --decision '<decision>'` for each child and resume the repo coordinator with <!--host:copilot-->`write_agent`<!--host:claude-->`SendMessage`<!--/host--> ("Escalations decided: … Continue."). Escalated children are not final: the run does not finalize while any is open.
6. **Its report.** When it reports `done` or `failed`, the integration child already has that phase. If it stopped while work remains (for example after `resume`), `next` returns `repo-coordinator` for it again.

## 3. Per-child pipeline

### Plan

1. Claim it (`npx openfleet claim <project> <id> planner`). Spawn `openfleet:openfleet-planner` with: "Plan child `<id>` of project `<project>`." Log the prompt as `message.sent`.
2. When it reports `done`, save the plan to `projects/<project>/plans/<child id>.md`. Patch `{"phase":"plan-review","plan":"<abs path>"}` and log `plan.submitted`.
3. **Validate the plan against the spec yourself:**
   - Every acceptance criterion for this child is mapped.
   - Every contract it produces or consumes has a contract test.
   - It follows the spec's **Shared approach** section.
   - If the child has a baseline, every planned change to baseline behaviour is one the spec explicitly lists.
   - Nothing is out of scope or touches another child's repo.
   - **Greenfield projects** (`state.greenfield`): nothing in the plan implements an item from the spec's `## Follow-ups` section, and it adds no endpoints, pages or tables beyond the contracts and this child's acceptance criteria.
   - The build and test commands match the spec.

   If the plan fails, log `plan.rejected` with `{"reason":"invalid","reasons":["…"]}`, or `{"reason":"out-of-scope","reasons":["<the Follow-ups item or extra endpoint/page/table>"]}` when it builds something the greenfield MVP slice cut. Send the reasons to the **same** <!--host:copilot-->planner with `write_agent`<!--host:claude-->planner with `SendMessage` (to its agent id)<!--/host-->. Log that message. Wait for the revision. Repeat until the plan passes. Do not ask the user.

   If the plan passes, log `plan.validated`.

4. Run the `post-plan` slot for the child (see "Extension slots" below). Then patch `{"phase":"planned"}`. Keep the planner's agent id: you may need it for revisions.

### Consistency check

Run it when `next` returns `check-consistency`. Before the gate opens, that happens only after **every** child's plan is validated. After the gate, it happens for a child that was re-planned (for example after a contract change).

1. Read every listed plan, the spec's **Shared approach** section, and the other children's plans (including ones already checked).
2. Compare them. Plans must agree on everything the Shared approach lists (config shape, patterns, env var names, library versions, naming) and on anything two plans both touch (a shared interface, a value one child produces and another reads).
3. For each plan that differs: log `plan.rejected` with `{"reason":"inconsistent","reasons":["<what differs and what to use instead>"],"with":["<other child ids>"]}`. Patch the child `{"phase":"plan-review"}`. Send the revision to the **same** <!--host:copilot-->planner with `write_agent`<!--host:claude-->planner with `SendMessage` (to its agent id)<!--/host--> and log it. When the revision arrives, save it, re-validate it (step 3 of "Plan") and patch `{"phase":"planned"}` again. Pick one approach and send the same decision to every differing planner; record the choice as an `assumption` if the spec did not settle it.
4. Repeat until no plan differs. Then run:

   ```sh
   npx openfleet gate <project> consistent [--child <id>,<id>]
   ```

   It marks the checked plans consistent and logs `plans.consistent`. Without `--child` it marks every validated plan that is waiting for the check.

### Gate

When `next` returns `plans-ready`:

1. Run the project-level `plans-ready` slot (see "Extension slots" below; no `--child`).
2. If every blocking entry succeeded, run `npx openfleet gate <project> open`. From now on, `next` returns baselines and implementations.
3. If a blocking `plans-ready` entry failed twice, `npx openfleet ext fail <project> <extension> --slot plans-ready --reason '…'` marks every active child `blocked` and the gate stays closed. Go to completion: the user continues later with `npx openfleet resume`.

### Baseline

Only for children whose spec section has **Baseline: yes** (`baseline: true` in state).

1. Claim it (`claim <project> <id> baseline`). Spawn `openfleet:openfleet-baseline` with: "Write and pass baseline tests for child `<id>` of project `<project>`." The spawn hook injects what to cover, the ports and the local files.
2. **Pass** (`status: "done"`): record it from the workspace root:

   ```sh
   npx openfleet baseline <project> <child id> --report '<json from the openfleet-report block>'
   ```

   It stores the file list and a hash of each file, sets `baselinePassed`, logs `baseline.passed`, and sets the phase back to `planned`. Run `next` again: the child now gets `implement` once its dependencies are `done`.

3. **Fail**: handle it like a failed test run (step 8 of "Test"), but patch `{"retries":n}`, claim `baseline` again and spawn a **new baseline tester** with the findings instead of an implementer. The guided attempt and "Failed children" apply the same way. Never let the baseline tester change app code to make a test pass.

### Implement

5. Run the `pre-implement` slot for the child (see "Extension slots" below). Then claim it (`claim <project> <id> implementer`). Spawn `openfleet:openfleet-implementer`: "Implement the approved plan for child `<id>` of project `<project>`." On a retry, append the tester's findings verbatim.

### Test

6. When the implementer reports `done`, claim `tester` and spawn `openfleet:openfleet-tester`: "Verify child `<id>` of project `<project>`."
7. **Pass** (`status: "done"`): patch `{"phase":"post-test"}` and run the `post-test` slot for the child (see "Extension slots" below). Patch `{"phase":"done"}` only after every `post-test` entry has finished. If a blocking entry failed twice, the child is already `failed`; do not mark it `done`.
   **Greenfield `setup` and `system` children:** before patching `done`, record the commands from the tester's report `commands` (the ones it ran and saw pass) in `repos.json`, per package where they differ, and update the spec's build/test/e2e lines to match (log `spec.written`). For the system child, add `.env.local` as a local file:

   ```sh
   npx openfleet repo confirm <repo> [--package <name> --path <dir>] [--build '<cmd>'] [--test '<cmd>'] [--e2e '<cmd>'] [--copy-file .env.local]
   ```

   Never edit `repos.json` by hand.

8. **Fail**: increment `retries`.
   - If `retries < 3`: patch `{"retries":n}`, claim `implementer` and spawn a **new** implementer with the findings (step 5).
   - If `retries` reaches 3: **guided attempt.** Do not ask the user. Review the problem yourself:
     1. Read the tester findings from all three attempts and the diff (`git -C <worktree> diff <baseSha>`).
     2. Work out the root cause. Is the implementation wrong, a test wrong, the plan wrong, or does the spec or a contract conflict with the code?
     3. Write concrete guidance: the cause, the approach to take, the files to change, and what to stop doing. If the fix needs a decision the spec does not cover, make it and log an `assumption` (see section 4).
     4. Patch `{"retries":3}`, claim `implementer` and spawn **one** more new implementer with your guidance and the latest findings. Log the prompt as `message.sent`.
   - If the guided attempt also fails (`retries` reaches 4): the child has **failed**. Follow "Failed children" below.

### Extension slots

`post-plan`, `pre-implement` and `post-test` run per child (`--child <id>`). `plans-ready` runs once per project (no `--child`).

1. `npx openfleet ext plan <project> <slot> --child <id>`. Run only the entries under `run`; skipped entries are already logged as `extension.skipped`.
2. For each entry, in order: spawn its `agent` with "Run `<slot>` for child `<id>` of project `<project>`. Worktree: `<worktree>`." <!--host:copilot-->Wait for it with `read_agent`. If it is still running after `timeoutMinutes`, stop it<!--host:claude-->End your turn and wait for its completion notification. If it is still running after `timeoutMinutes`, stop it with `TaskStop`<!--/host--> and treat the attempt as failed.
3. Record its `openfleet-report` block: `npx openfleet ext result <project> <extension> --slot <slot> --child <id> --report '<json from the block>'`. Pass `outputs` and `followUps` through exactly as reported; the helper validates them (flat string values only). An output named `prUrl` becomes the child's `prUrl`.
4. If the attempt failed (report `status: "failed"`, no report, or a timeout):
   - **advisory** entry: record it and continue.
   - **blocking** entry: spawn one **fresh** agent for the same entry and try again. If the retry also fails, run `npx openfleet ext fail <project> <extension> --slot <slot> --child <id> --reason '<why>'` and stop this child's pipeline. The helper marks the child `failed`, marks its not-yet-done dependents `blocked`, and logs `extension.failed` and `child.failed`.

For `plans-ready`, the blocking failure helper call has no `--child`; it marks every active child `blocked` (see "Gate").

Dependents are implemented only when this child is `done`, so they start after every blocking `post-test` entry succeeds. The spawn hook then injects the recorded outputs into their implementer and tester prompts under **Upstream outputs** (direct and transitive dependencies). Planners run before the gate, so they normally see no outputs; plans rely on the contracts instead. You do not need to relay outputs yourself.

### Failed children

1. Patch the child `{"phase":"failed","retries":4,"notes":"<one-line cause>"}`. (`next` returns `block` actions for its dependents too.)
2. Find every child that depends on it, directly or transitively. Patch each one that is not `done` to `{"phase":"blocked","notes":"dependency <id> failed"}`. If one of them has an agent running, stop it.
3. Log `child.failed` with `{"reason":"…","retries":4,"findings":["…"],"worktree":"<abs path>","blocked":["<dependent ids>"]}`.
4. Keep the worktree as it is. Continue with every other child. Do not ask the user. The final summary reports the failure, and the user can deal with it later with `npx openfleet resume`.

## 4. Questions from children

When a child reports `status: "question"`:

1. Add the question to `questions` with status `open`, and log `question.asked`.
2. **If `spec.md` or `contracts/` answers it,** reply with <!--host:copilot-->`write_agent`<!--host:claude-->`SendMessage`<!--/host-->, quoting the relevant spec lines. Set `answeredBy: "spec"`.
3. **Otherwise, decide yourself.** Do not ask the user. Choose the option that best fits the goal, the existing code, the contracts and the out-of-scope list. When in doubt, prefer the smallest, most conventional and backward-compatible choice. Reply with <!--host:copilot-->`write_agent`<!--host:claude-->`SendMessage`<!--/host--> and set `answeredBy: "coordinator"`. Log an `assumption` event:

   ```sh
   npx openfleet event <project> --type assumption --target <child id> --payload '{"child":"<child id>","question":"…","decision":"…","rationale":"…","contractChange":false}'
   ```

4. Mark the question `answered` and log `question.answered`. Log the reply as `message.sent`.
5. If your decision changes a contract (`contractChange: true`), follow "Changing a contract" in `openfleet-contracts`, including the broadcast to affected children. If it changes the scope, update `spec.md` and log `spec.written`.

Answer questions as they arrive. Do not hold a question back while you wait for others.

## 5. Completion

When every child is `done`, `failed` or `blocked` (not counting children waiting on an escalation) and every repo coordinator has reported, patch the project `{"status":"finalizing"}` and use `openfleet-finalize`. Do this even when some children failed: finalize the ones that are `done`.

## Resuming

On resume, run `npx openfleet preflight <project>` first (section 0b): `resume` marks the last result stale, and nothing can be claimed until it passes. Then read `state.json` and answer any `open` questions. For each child:

- `planning`, `baseline`, `implementing` or `testing` with a recorded agent id: <!--host:copilot-->try `read_agent` on that id. If the agent is gone,<!--host:claude-->send it a `SendMessage` ("Continue.") on that id. If the agent cannot be found,<!--/host--> re-spawn that role. Implementers and baseline testers continue from the worktree's current contents.
- `plan-review`: re-validate the saved plan.
- `planned`: nothing to do; `next` decides.
- Integration children (repo coordinators): `resume` marks them stopped and clears every unconsumed claim. `next` returns `repo-coordinator` for each repo that is not finished: spawn them again; they continue from `state.json`.

Then run `npx openfleet next <project>` and continue the loop. It knows whether the gate is open (`plansReady` in state), which plans still need the consistency check, and which children are ready.
