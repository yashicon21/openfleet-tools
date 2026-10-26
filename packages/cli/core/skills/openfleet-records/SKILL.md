---
name: openfleet-records
description: How OpenFleet agents update state.json, append events.jsonl entries and create worktrees through the `npx openfleet` helper commands. Use whenever you change project state or need to log something.
---

# OpenFleet records

Run every command below **from the workspace root** (the session's starting directory). Never edit `state.json` or `events.jsonl` by hand. The helpers take file locks, which concurrent hooks and agents depend on.

## State

```sh
npx openfleet state <project>                      # print state.json
npx openfleet state <project> --patch '<json>'     # RFC 7396 merge patch (null deletes a key)
```

Useful patches:

```sh
# project status: specifying | running | finalizing | done | cancelled  (unknown values are rejected)
npx openfleet state p --patch '{"status":"running","specApproved":true,"completionMode":"staged"}'
# draft PRs as GitHub stacked PRs for repos with several children (chosen in the grill)
npx openfleet state p --patch '{"completionMode":"draft-pr","prStack":true}'

# register a child (child id = "<repo>", "<repo>:<package>" or "<repo>[:<package>]/<unit>")
npx openfleet state p --patch '{"children":{"api":{"repo":"api","phase":"pending","dependsOn":[],"retries":0,"agentIds":{}}}}'

# register path-scoped children (a setup child plus one per unit); "web" (the integration child) is created for you
npx openfleet state p --patch '{"children":{"web/setup":{"repo":"web","setup":true,"paths":["components/ui/**","lib/**","package.json"]},"web/settings":{"repo":"web","paths":["app/settings/**"],"dependsOn":["web/setup"]}}}'

# open / answer questions
npx openfleet state p --patch '{"questions":[ … full array … ]}'
```

Arrays replace the old value. To change `questions` or `dependsOn`, send the full new array.

Child phases: `pending → planning → plan-review → planned → [baseline → planned] → implementing → testing → post-test → done`. `planned` means the plan is validated; the child then waits for the `plans-ready` gate and its dependencies. A child can also be `failed` (retries and the guided attempt failed) or `blocked`: a dependency failed, or `blockedReason: "needs-escalation"` (waiting for the top coordinator; not final). A grouped child that hits a merge conflict goes from `done` back to `planned` with `conflict` set. Integration children (keyed by the repo) skip planning: `pending → testing ⇄ implementing → done | failed`. Unknown phases are rejected. A phase change in a patch logs a `phase.changed` event automatically. Moving a child back to `pending`, `planning` or `plan-review` clears its `consistent` flag, so its new plan goes through the consistency check again.

Fields that core sets (do not patch them): `portBase` (the child's port range, assigned when the child is registered), `copiedFiles`, `consistent`, `repoConsistent`, `baselineFiles`, `baselineHashes`, `baselinePassed`, `pendingSpawn`, `claimedAt`, `agentIds` (recorded by the `subagentStart` hook), `coordinator`, `merged`, `mergedAt`, `doneAt`, `conflict`, `syncedSha`, `escalation`, `decisions`, `blockedReason`, the integration children themselves, and the project's `plansReady` and `preflight` (written by `npx openfleet preflight`; `resume` marks it `stale`). Set `baseline`, `baselineCover`, `paths`, `allowPaths` and `setup` when you register a child; repo coordinators set `sharedItems` on the setup child.

## Scheduling, spawns and the gate

```sh
npx openfleet preflight <project>                              # can git write in every repo? before approval, at run start, on resume
npx openfleet next <project> [--repo <repo>]                   # next actions (top, or one repo coordinator's)
npx openfleet claim <project> <child> <role>                   # before every spawn: "claimed" (spawn now) or "wait"
npx openfleet config [set maxParallel <n>]                     # workspace settings (maxParallel caps busy children across all projects)
npx openfleet ack <project> <child> <role>                     # optional: re-prints a subagent's assignment (binds its id if the hook could not)
npx openfleet gate <project> consistent [--child <id>,<id>]    # plans passed the consistency check; logs plans.consistent
npx openfleet gate <project> consistent --repo <repo>          # a repo coordinator's sibling check (repoConsistent)
npx openfleet gate <project> open                              # open the plans-ready gate (all plans consistent)
npx openfleet baseline <project> <child> --report '<json>'     # baseline passed; logs baseline.passed, phase back to planned
npx openfleet baseline <project> <child> --check               # baseline files changed since the baseline passed
npx openfleet scope <project> <child> --check                  # changed files outside a path-scoped child's paths
npx openfleet merge <project> <child>                          # merge a done child into its repo's integration branch
npx openfleet escalate <project> <child> --question '<text>'   # cross-repo question: child blocked (needs-escalation)
npx openfleet escalate <project> <child> --resolve --decision '<text>'  # top coordinator's decision; child resumes
```

## Worktrees

```sh
npx openfleet worktree <project> <child id> [--repo <repos.json key>] [--branch <branch>] [--package <path>] [--base <ref>]
```

`--repo` defaults to the child id's repo. `--branch` defaults to `openfleet/<project>` (the repo's integration branch for a grouped repo) and to `<integration branch>--<child slug>` for a child of a grouped repo, for example `openfleet/p--web-settings`.

This command creates `projects/<project>/worktrees/<child id>/` from the repo's local checkout (it clones `url` first if there is no local `path`). It also records `worktree`, `branch`, `baseSha` and `repoPath` on the child and logs `worktree.created`. If the worktree already exists, it is reused.

Every run of the command also copies the repo's `copyFiles` from its main checkout into the worktree (refreshing older copies), records them as `copiedFiles`, and hides them from git: tracked files get `git update-index --skip-worktree`, untracked ones are added to the repo's `info/exclude`. Their contents are redacted from events and excluded from snapshots and patches. Missing files are reported as warnings.

## Extension slots

```sh
# slots: pre-spec, post-plan, plans-ready, pre-implement, post-test, post-run
npx openfleet ext plan <project> <slot> [--child <id>]                                   # entries to run; logs extension.skipped
npx openfleet ext result <project> <ext> --slot <slot> [--child <id>] --report '<json>'  # logs extension.ran (+ extension.outputs)
npx openfleet ext fail <project> <ext> --slot <slot> [--child <id>] --reason '<text>'    # child failed, dependents blocked
```

`ext result` stores the report's `outputs` in `children.<id>.outputs.<ext>` and its `followUps` in `children.<id>.followUps.<ext>` (or the project-level `followUps` without `--child`). An output named `prUrl` also sets `children.<id>.prUrl`. Do not write these fields with `state --patch`.

## Events

```sh
npx openfleet event <project> --type <type> [--actor <actor>] [--target <child id>] [--payload '<json>'] [--patch-file <path>]
```

- `actor` defaults to `coordinator`. Children use `<child id>/<role>`; repo coordinators use `<repo>/repo-coordinator`. Extensions use `ext:<name>`.
- The helper redacts secrets before it writes.
- **Do not log file edits or agent start/stop events.** The hooks capture those automatically.

Events the coordinator must log:

| When                                                                | type                                                  | payload                                                                                                                                                           |
| ------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| You send a child a message (spawn prompt, answer, broadcast, retry) | `message.sent`                                        | `{"from":"coordinator","to":"<child>/<role>","text":"<full message>"}`                                                                                            |
| A child replies                                                     | `message.sent`                                        | `{"from":"<child>/<role>","to":"coordinator","text":"<full reply>"}`                                                                                              |
| A question arrives                                                  | `question.asked`                                      | `{"id":"q3","from":"<child>/<role>","text":"…"}`                                                                                                                  |
| A question is answered                                              | `question.answered`                                   | `{"id":"q3","answeredBy":"spec\|coordinator","text":"…"}`                                                                                                         |
| You decide something the spec does not cover                        | `assumption`                                          | `{"child":"<child id>","question":"…","decision":"…","rationale":"…","contractChange":false}`                                                                     |
| `spec.md` is written or changed                                     | `spec.written`                                        | `{"path":"spec.md","summary":"…"}`                                                                                                                                |
| The user answers the spec review question (end of the grill)        | `spec.approved`                                       | `{"changes":"<what changed, or none>"}`                                                                                                                           |
| A plan is received, accepted or bounced                             | `plan.submitted` / `plan.validated` / `plan.rejected` | `{"plan":"plans/<child>.md","reasons":[…]}`; `plan.rejected` adds `"reason":"invalid\|inconsistent\|out-of-scope"` (required) (and `"with":[…]` for inconsistent) |
| Plans pass the consistency check                                    | `plans.consistent`                                    | logged by `npx openfleet gate <project> consistent`                                                                                                               |
| A baseline passes                                                   | `baseline.passed`                                     | logged by `npx openfleet baseline <project> <child> --report`                                                                                                     |
| A child is merged into its integration branch / a merge conflicts   | `child.merged` / `merge.conflict`                     | logged by `npx openfleet merge`                                                                                                                                   |
| A question is escalated to the top coordinator / decided            | `question.escalated` / `question.answered`            | logged by `npx openfleet escalate` (`--resolve`)                                                                                                                  |
| Preflight passes / fails                                            | `preflight.passed` / `preflight.failed`               | logged by `npx openfleet preflight`                                                                                                                               |
| A contract changes                                                  | `contract.changed`                                    | `{"contract":"contracts/…","affected":["…"],"summary":"…"}`                                                                                                       |
| A child fails after the guided attempt                              | `child.failed`                                        | `{"reason":"…","retries":4,"findings":["…"],"worktree":"…","blocked":["…"]}`                                                                                      |
| An extension agent finishes                                         | `extension.ran` (+ `extension.outputs`)               | logged by `npx openfleet ext result` (see below)                                                                                                                  |
| An extension entry is skipped by `when.files`                       | `extension.skipped`                                   | logged by `npx openfleet ext plan`                                                                                                                                |
| A blocking extension entry fails twice                              | `extension.failed` (+ `child.failed`)                 | logged by `npx openfleet ext fail`                                                                                                                                |
| The run is finished                                                 | `run.completed`                                       | `{"mode":"staged\|draft-pr\|main","children":{…}}`                                                                                                                |
