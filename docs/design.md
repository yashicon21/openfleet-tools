# OpenFleet — Design Decisions (grill sessions 2026-10-13/14)

## Positioning

- Open-source (MIT) framework that coordinates one change across many repos (or a new system built from scratch) using GitHub Copilot CLI or Claude Code.
- Layers on each host's own primitives (custom agents, subagents, hooks, skills; `write_agent` on Copilot, `SendMessage` on Claude Code). Not a new runtime.
- README contrasts with built-in `/fleet` (cross-repo vs in-session).

## Terminology

- **Project** = a unit of work the user wants done (e.g. "refactor auth to use better-auth").
- **Repo / package** = code target touched by a project (a repo, or a package inside a monorepo).
- **Child** = one planner → implementer → tester pipeline with its own worktree and branch. Id: `<repo>` (whole repo), `<repo>:<package>` (monorepo package, the key in `repos.json` `packages`) or `<repo>[:<package>]/<unit>` (path-scoped unit owning `paths` globs, e.g. one page).
- **Repo coordinator** = subagent of the top coordinator that runs every child of one repo when that repo has more than one child.
- **Extension** = instruction-only add-on.

## Distribution & CLI

- npm name `openfleet` is taken → scoped `@openfleet-tools/create` (init, `npm create @openfleet-tools`) + `@openfleet-tools/cli`; npm org `@openfleet-tools` (matches https://openfleet.tools). After init, `npx openfleet …` resolves to the local install.
- Commands: `init`, `update`, `config` / `config set <key> <value>` (workspace settings), `new <name>`, `resume <name>`, `status [name]` (children grouped by repo), `list`, `clean <name>` (child and integration worktrees, optional branches), `report <name>` (HTML run report), `add <git-url|path>`, `remove <ext>`, `extensions`, `ext settings [--unset]` / `ext settings set <ext> <key> <value>`, plus extension-declared commands.
- Agent helpers (deterministic, used by the agents instead of hand-editing files): `state`, `event`, `worktree`, `next`, `gate`, `baseline`, `claim`, `ack`, `scope`, `merge`, `escalate`, `ext plan|result|fail`.
- CLI launches the host itself (`copilot --agent openfleet-coordinator` + plugin dir = `core`). No global install. The same launcher starts `claude` for the Claude Code host (see Hosts).
- Launch permissions: interactive (not `--autopilot`), `--allow-all-tools`; path verification stays on with `--add-dir` for the workspace root, the project's `worktrees/`, `repos/` and the local repos in `repos.json`; URLs still prompt (no `--allow-all-urls`). `--ask` on `new`/`resume`/extension commands keeps per-tool prompts; args after `--` (e.g. `--yolo`) pass through.

## Workspace layout (`npm create @openfleet-tools` in any cwd)

Everything is flat in the workspace root (the folder `npm create` ran in), next to `package.json` and `node_modules/`. `openfleet.json` marks the root: commands walk up from the cwd until they find it.

```
<workspace>/
  package.json  node_modules/
  openfleet.json        # root marker: core `version` + settings, e.g. { "maxParallel": 6, "host": "copilot" } (committed; `npx openfleet config set`)
  .gitignore            # written by `init` only if missing; otherwise init prints the lines it lacks
  core/                 # installed app, fully replaced by `update`; users never edit (gitignored)
  extensions/           # instruction-only extensions (committed)
  extensions.lock.json  # git URL + SHA per extension (committed)
  repos.json            # known repos/packages + confirmed build/test cmds (committed)
  repos/<key>/          # clones of `url` repos (gitignored)
  projects/<name>/      # committed except worktrees/ and patches/
    spec.md
    state.json
    contracts/
    plans/<child>.md
    events.jsonl
    patches/<seq>.patch # gitignored
    worktrees/<child>/  # gitignored (`:` and `/` in the id become `__`)
```

- Repos may live anywhere (path or git URL to clone); init cwd = default search root for the grill.
- `repos.json` entries may add `e2e` (command), `env` (required env var / credential **names**, never values) and `copyFiles` (git-ignored local files, e.g. `.env.local`, copied from the repo's main checkout into each worktree).

## Hosts

- Host = the agent CLI a project runs in: `copilot` or `claude`, both fully supported. Workspace setting `host` in `openfleet.json`, chosen at `init` (prompt on a TTY, `--host` to skip it, `copilot` without a TTY or in CI) and changed with `npx openfleet config set host`, `--host` on `new`/`resume` for one run. `state.host` is recorded at `new`; `resume` refuses to switch hosts mid-project. `OPENFLEET_HOST` tells in-session helpers which host they run in (sandbox hints name it).
- One `core/` source; the build of the installed core generates a plugin per host. Copilot output (`plugin.json`, `hooks.json`, `agents/*.agent.md`, `skills/`) is unchanged. Claude output lives in `core/claude/`: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `agents/*.md` and `skills/`, sharing `core/lib` via `${CLAUDE_PLUGIN_ROOT}/../lib` (works with `--plugin-dir`). Agents register as `openfleet:<agent>` on both hosts.
- Host differences in skills and agent templates are inline build-time blocks: `<!--host:copilot-->…<!--host:claude-->…<!--/host-->` (`task`/`read_agent`/`write_agent`/`ask_user` vs `Agent`/completion notifications/`SendMessage`/`AskUserQuestion`). Agent tools map read → `Read`; search → `Grep, Glob`; edit → `Edit, Write`; execute → `Bash`; web → `WebFetch, WebSearch`; agent → `Agent, SendMessage`. Extension agents are generated for every host their entry allows (`hosts`).
- Hooks: one handler, a per-host adapter (`main.js <host> <event>`; plain `main.js <event>` means Copilot) normalises payloads (Claude's snake_case `session_id`, `agent_id`, `agent_type`, `tool_input`, `last_assistant_message`) into the internal shape and formats output (Claude: `hookSpecificOutput.additionalContext`). Claim consumption and attribution by agent id are identical. Claude matchers are anchored (`^(openfleet:)?openfleet-`).
- Claude launch: `claude "<prompt>" --plugin-dir core/claude --agent openfleet:openfleet-coordinator`, `--session-id <uuid> --name` for new sessions and `--resume <id>` otherwise, `--permission-mode acceptEdits --allowedTools Bash` unless `--ask`, the same `--add-dir` list. Never `bypassPermissions`/`--dangerously-skip-permissions`. Minimum Claude Code 2.1.219 (`agent_id` in hooks, `SendMessage`, nested subagents on by default), checked with `claude --version`.
- Role sessions (`agentMode: "session"`, default for new workspaces; design and decisions in [role-sessions.md](role-sessions.md)): planners, baseline testers, implementers, testers and extension agents run as their own headless host sessions started by `npx openfleet agent start` (claim, `agent.spawned`, detached runner, `claude -p`/`copilot -p` with the role's host, model and endpoint env), collected with `agent wait`, continued with `agent reply`. Repo coordinators stay subagents. Endpoints (`endpoints.<name>`, `<endpoint>:<model>`) are Claude Code only; `roleHosts.<role>` runs a role on another host. Skills carry `<!--mode:session-->…<!--mode:subagent-->…<!--/mode-->` blocks, rendered at install like host blocks. CLI guards (`preToolUse` hook + state checks): no finalize or `summary.md` with unfinished children, greenfield children need a kind, no unclaimed role spawns, role agents write only in their worktree, coordinators never write into repos or worktrees.
- Claude orchestration (subagent mode): spawn with `Agent` in the background, end the turn, act on completion notifications, then `npx openfleet next`; `SendMessage` for replies, send-backs and contract broadcasts; never block on one child. OpenFleet keeps managing worktrees (no `isolation: worktree`/`-w`).

## Core contents

- Agents: `openfleet-coordinator`, `openfleet-repo-coordinator`, `openfleet-planner`, `openfleet-baseline`, `openfleet-implementer`, `openfleet-tester` (planner/tester read-only on source; the baseline tester edits tests only; coordinators never edit code). Nesting is at most top coordinator → repo coordinator → role agent (depth 3 of Copilot's 4).
- Skills, hooks (Node scripts), per-host adapter → normalized event schema, event capture/writer.

## Flow

1. `npx openfleet new <name>` → coordinator grill session (suggests repos from `repos.json`, auto-discovers build/test cmds, confirms with user, adds new repos to `repos.json`). It can split a repo into path-scoped units (pages, modules or services; e.g. Next.js routes under `app/**/page.tsx` or `pages/**`), proposing one child per unit that the user may group or skip, and shows the workspace `maxParallel` (default 6, in `openfleet.json`), offering to change it with `npx openfleet config set maxParallel <n>`; it applies to every project, so it is not part of the spec. It also asks about every installed extension setting with no workspace value (`ext settings --unset`), writing answers with `ext settings set`; values are workspace-level, so set keys are not asked again.
2. Output `projects/<name>/spec.md`: goal, children (repo, package, paths), cross-repo contracts, Shared approach, baselines, ordering deps, per-child acceptance criteria, build/test cmds, branch names (asked; default `openfleet/<project>` per repo, `<integration branch>--<child slug>` for members of a grouped repo), parallelism, completion mode, out-of-scope.
3. User input happens only in the grill. Its last question shows the spec summary and asks "anything to change?"; the answer ends the grill (changes applied, `spec.approved`, `status: running`). After that the run is fully hands-off until `done`.
   - **Preflight.** Before the grill's last question the coordinator runs `npx openfleet preflight <project>`: for every repo it checks that git can create a ref lock (`.git/refs/heads/`) and a worktree admin dir (`.git/worktrees/`), that `copyFiles` can be opened (never read) and that the project's worktrees dir is writable. It records `state.preflight` and logs `preflight.passed`/`preflight.failed`. While it fails, `specApproved` cannot be set, `next` returns only a `preflight` action and `claim` refuses spawns; it runs again at run start and after `resume` (which marks it `stale`). `EPERM` means a sandbox: an inherited one from a sandboxed launching shell (most likely), Copilot's command sandbox, or a managed OS policy; never Full Disk Access. The launcher runs the same probe from its own process before starting Copilot and fails fast if writes are denied there (the sandbox is inherited); it warns when Copilot's command sandbox looks enabled (`--sandbox`, `sandbox.enabled` in settings files) and never adds a bypass. Agents never open, read or grep `copyFiles` entries or `.env*` files (except committed examples); env var names come from code, `.env.example` or the user. Git failures print git's stderr (with the sandbox hint for "Operation not permitted"), never a stack trace.
4. **Plan everything first.** Every child's planner runs in parallel, ignoring `dependsOn` (dependent plans rely on the contracts). The coordinator validates each plan vs the spec (bounces on mismatch, `plan.rejected` `reason: invalid`).
5. **`plans-ready` gate.** When every plan is validated, the coordinator compares all plans with the spec's **Shared approach** section and with each other, sends revisions to differing planners (`plan.rejected` `reason: inconsistent`) until they agree, then logs `plans.consistent`. The project-level `plans-ready` extension slot runs, then the gate opens (`plansReady`). A contract change later re-plans the affected children; their plans go through the consistency check again, without closing the gate. `npx openfleet next` computes the schedule deterministically.
6. **Baseline (optional per child, decided in the grill).** After the gate, a baseline tester (`openfleet-baseline`) writes tests (e.g. Playwright e2e) for the behaviour about to change and runs them on the unchanged code until they pass, fixing tests only. `baseline.passed` records the files; core stores a hash per file. The implementer may change baseline tests only for behaviour changes the spec lists; the tester runs `npx openfleet baseline <p> <child> --check` and fails unlisted edits. Then the per-child `pre-implement` slot runs.
7. Per child after the gate: [baseline →] implementer → tester, in `dependsOn` order. `dependsOn` can name a child or a whole grouped repo (its integration result). Every spawn first runs `npx openfleet claim <project> <child> <role>`, which sets `pendingSpawn` under a workspace lock, keeps at most one unconsumed claim per role (so the `subagentStart` hook attributes the spawn exactly, even with several coordinators spawning at once) and enforces the workspace-wide `maxParallel` from `openfleet.json` (children in `planning`, `baseline`, `implementing` or `testing` across all running projects). With no free slot it returns `wait` and the coordinator retries.
8. Tester failure → new implementer with findings, max 3 retries → coordinator reviews findings + diff, writes guidance, spawns one more implementer → if that fails, child `failed` (`child.failed` event), dependents `blocked`, other children continue. Final summary reports failures; user handles them later via `resume`.
9. Child questions → their coordinator (write_agent/read_agent) → answers from spec, otherwise decides itself and logs an `assumption` event (listed in the final summary); contract changes broadcast to affected children. A repo coordinator decides questions within its repo; one that changes a cross-repo contract or the Shared approach is escalated (`npx openfleet escalate --question`: the affected children become `blocked` with `blockedReason: needs-escalation`, `question.escalated` is logged, the rest continues). The top coordinator decides, changes the contract if needed, runs `escalate --resolve` and resumes that repo coordinator with `write_agent`. No coordinator ends its turn while children are pending or running.
10. Completion mode chosen in grill: default staged changes for review; optional draft PRs cross-linked with run summary.

- Monorepo: one worktree + branch per package; a repo whose only child is one package gets one PR for it.

## Path-scoped children & repo coordinators

- A repo with more than one child (path-scoped units or several monorepo packages) is **grouped**: core adds an integration child with the repo key as id, and the top coordinator spawns one `openfleet:openfleet-repo-coordinator` background subagent for it. Single-child repos stay directly under the top coordinator.
- **Setup child.** For each repo with scoped children the grill adds `<repo>[:<package>]/setup` for shared config, components and utils; every scoped child `dependsOn` it. At the gate each plan lists the shared items it needs; the coordinator adds them to the setup child's `sharedItems` and re-validates its plan. Scoped children never add shared items themselves.
- **Two-level gate.** Each repo coordinator checks its children's plans against each other (`gate consistent --repo`, sets `repoConsistent`); the top coordinator checks across repos against the Shared approach (`gate consistent`).
- **Scope check.** `npx openfleet scope <project> <child> --check` lists changed files outside the child's `paths` and spec-allowed `allowPaths` (relative to the package); the tester fails the child on any.
- **Merging.** `npx openfleet merge` merges a `done` child into the integration branch in the repo coordinator's own worktree: the setup child first, then in `doneAt` order (`child.merged`). On a conflict (`merge.conflict`) the child branch is rebased onto the integration branch and that child's implementer resolves it within its own paths, then its tester runs again; a conflict in a file the child does not own is a scope violation. Before implementing, a member branch is fast-forwarded to the integration tip (`worktree.synced`).
- **Integration.** The repo coordinator runs the repo's full build and tests on the merged integration branch. On failure it spawns an integration implementer and tester (3 retries + 1 guided attempt); if those fail the repo is `failed`, dependents `blocked`, and child branches and worktrees are kept. One PR per grouped repo, from the integration branch; Related PRs still link across repos.
- `npx openfleet next` returns actions with an `owner` (`top` or a repo key); the top coordinator's output also lists `delegated` repo actions. `resume` restarts repo coordinators from `state.json`; `status` groups children under their repo; `clean` removes child and integration worktrees.
- **Ports:** each child gets a unique range of 10 ports, `4100 + 10 × k` (lowest free `k`, assigned when the child is registered, stable for the run). The spawn hook injects `PORT` and `OPENFLEET_PORT_BASE` (both the first port) into baseline, implementer and tester prompts, with rules: start servers on `$PORT`, read ports and auth callback URLs from env, Playwright `webServer` with `reuseExistingServer: false`, stop servers afterwards.
- **Local files (`copyFiles`):** `npx openfleet worktree` copies each listed file (relative, inside the repo, no `.git`) from the main checkout, warns about missing ones, and hides them from git: tracked files get `skip-worktree`, untracked ones go into the repo's shared `info/exclude` (also hides them in the main checkout, where they are usually ignored already). They are never staged or committed (finalize also checks), are left out of snapshots and file patches, and their values are redacted from every event.
- Multiple projects may be active concurrently, even on same repo; CLI warns on overlap.

## Greenfield projects

- **In the grill, not a separate command.** The user describes a new system; the coordinator detects that no repo fits, patches `greenfield: true`, proposes services and contracts, recommends one monorepo (package per service + frontend + shared contracts package; multi-repo allowed), asks the stack once per system with recommendations (framework per service, frontend, DB, communication, auth, local run) into the spec's **Stack** / **Shared approach**, records `toolchains`, and offers a private GitHub remote. Completion mode follows: `main` (no remote) or `draft-pr`.
- **Scope guard (CLI).** A greenfield run is an MVP slice. `specApproved: true` is refused (every problem listed) while a child has no `kind`, services > `greenfield.maxServices` (5), children > `greenfield.maxChildren` (12), any child's acceptance criteria > `greenfield.maxCriteriaPerChild` (8), or `## Follow-ups` is missing or empty. `npx openfleet spec-check` shows the same before the last grill question; caps are raised only with `config set greenfield.<key>`. Drift: `plan.rejected` `reason: out-of-scope` for plans that build a Follow-ups item; testers fail endpoints, pages or tables outside the contracts and criteria.
- **Repos.** After approval, `npx openfleet repo create <key> --project <p> [--github <owner/name>]`: `git init -b main` in `repos/<key>`, an empty initial commit, `repos.json` entry with `greenfield: true` (`gh repo create --private --source --push` with `--github`; refuses a non-empty folder). Preflight treats a greenfield project's repos that do not exist yet as pending and also checks toolchains on PATH and registry reachability (npm / PyPI / Go proxy, mirrors honoured).
- **Child kinds and order.** `kind`: `setup` (per repo; official generators, non-interactive; lint/test/build + sample test; tester-confirmed commands written with `npx openfleet repo confirm`), `contracts` (schemas + committed generated clients in a shared package), `service` / `frontend`, `system` (docker-compose, generated dev-only creds in git-ignored `.env.local` added to `copyFiles`, seed data, mock third-party providers, one e2e flow). State updates add the order to `dependsOn`: setup → contracts → services ∥ frontend → system. The spawn hook injects a `## Greenfield: <kind> child` section per role into the assignment.
- **Completion.** Work lands only when every system child is `done` (e2e passed): fast-forward the new repo's `main`, or with a remote one draft PR into `main` with everything after the initial commit. Otherwise nothing lands and the summary says why; `status` still reaches `done` so `resume` works as usual.
- **Next slice.** `npx openfleet continue <project> [name]` (finished greenfield or continued project with Follow-ups): new project with `continuedFrom`, spec draft (Layout, Stack, Shared approach, Follow-ups backlog), copied `contracts/` and `toolchains`; its repos flip to `greenfield: false`, so it runs as a normal change, under the same caps (`project.continued`).

## Upgrades

- Each JSON file has a schema version (`v`): `state.json`, `repos.json` and `extensions.lock.json` are v1. Readers refuse a newer version ("upgrade the CLI") or an older one ("run `npx openfleet update`"). `update` migrates every file through the steps in `src/migrate.ts`, keeping `<file>.v<N>.bak`, and refuses to downgrade a workspace whose core is newer than the CLI. `events.jsonl` is never rewritten; events only gain fields.
- A test upgrades a workspace made with 0.6.0. Every schema change adds a migration step and extends that test.

## Testing

- v1 contract tests only. Coordinator writes shared fixtures to `contracts/`; planners include contract tests; implementers write; testers verify existence + pass.
- Optional per-child **baseline tests** (usually e2e, e.g. Playwright) written before implementation and passed on the unchanged code; protected afterwards (edits only for behaviour changes the spec lists, checked by the tester via file hashes).

## State & resume

- `state.json`: per child phase (`pending → planning → plan-review → planned → [baseline] → implementing → testing → post-test → done | failed | blocked`), worktree, branch, agent ids, `pendingSpawn`/`claimedAt`, port range, copied files, consistency/baseline flags, `paths`/`allowPaths`/`setup`/`sharedItems`, `integration`/`coordinator`/`merged`/`doneAt`/`conflict`, `blockedReason`/`escalation`, extension outputs and follow-ups, open questions; project `plansReady` and `preflight` (`ok`, `at`, `stale`). Written only through the locked `npx openfleet state` (and the other helpers); `resume` continues from it. `resume` reopens the recorded Copilot session with `--session-id` and never passes `--name` with it (Copilot rejects naming an existing session); only new sessions (`new`, `resume --fresh`, extension commands) are named. If `$COPILOT_HOME/session-state/<id>` is gone, `resume` starts a new session id, records it and logs `session.replaced`.

## Events / audit (core, always on)

- `events.jsonl` append-only, `v: 1`: `ts, seq (global, file-locked), actor (coordinator | <child>/<role> | <repo>/repo-coordinator | ext:<name> | cli | user), type, target, payload`.
- Types: see [events.md](events.md) (agents, messages, files, worktrees, phases, questions and escalations, plans and the gate, baselines, tests, extensions, merges, run completion).
- Full patches in `patches/<seq>.patch`; messages logged in full with secret redaction.
- Capture: hooks (`subagentStart/Stop`, `postToolUse`; attribution cwd→worktree→repo, role via agentName/state.json) + git diff snapshot per worktree on agent stop (ground truth) + coordinator logs messages.
- Hooks no-op unless cwd is under an OpenFleet workspace.
- No live viewer; `npx openfleet report` renders a finished or running project as a static HTML report (see Run report).

## Run report

- `npx openfleet report <name> [--out <file>] [--open] [--gap <min>]` → `projects/<name>/report.html` (default). Deterministic, no agent: derived from `events.jsonl`, `state.json`, `spec.md` (`## Goal`), `summary.md` and git (`--shortstat` only for children without a `worktree.snapshot`). Finalize runs it after `run.completed` and links it from `summary.md`.
- One self-contained file: inline CSS and SVG, no JS, no web fonts (system fallbacks for the site's fonts), no network. Charts scroll inside their card on narrow screens.
- Timeline: child bars from child-scoped `phase.changed` (a final phase ends the bar; a non-final last phase stays open to the last event); project bands from project-scoped `phase.changed`. Event gaps over `--gap` minutes (default 15) are collapsed into fixed-width hatched bands, and active time (wall clock minus gaps) is reported next to wall-clock time.
- Agents: `agent.spawned`/`agent.stopped` matched by `agentId`. A spawn without a stop ends at the next `session.started`, the next spawn for the same child and role, or the last event, and is flagged as inferred. The top coordinator session is not counted.
- Plan gate from `plan.submitted|validated|rejected` and `plans.consistent`; first code = the first `implementing`/`baseline` phase. Diffs from each child's last `worktree.snapshot` (repo totals use the integration child). Tests from `test.run`.
- `summary.md` sections `## Coverage`, `## Assumptions`, `## Follow-ups`, `## Lessons` are rendered when present (finalize writes them); the report's markdown renderer is a safe subset and escapes everything else.
- Tokens: session ids from `session.started`/`session.replaced`/`project.created` and `state.sessionId`. Claude Code: `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<workspace root, non-alphanumerics → '-'>/<id>.jsonl` (coordinator) + `<id>/subagents/*.jsonl` (role from `*.meta.json` `agentType`). Copilot CLI: `<COPILOT_HOME or ~/.copilot>/session-state/<id>/events.jsonl` `session.usage_record` (role via `subagent.started` agent ids, best effort). Messages are de-duplicated by id (forked sessions and streamed lines repeat them; the largest count of each field wins); `<synthetic>` messages are dropped.
- Cost only with `pricing` in `openfleet.json` (USD per million tokens per model; `input`, `output`, `cacheRead` required; `cacheWrite`, `cacheWrite5m`, `cacheWrite1h` optional). No built-in prices. Models without a usable price are listed and left out of the total. `config set` refuses `pricing`; edit the file.

## Extensions (instruction-only)

- Folder with `openfleet.extension.json` + Markdown skills/agent instructions. No executable scripts.
- Manifest v2 (`"manifest": 2`; v1 `mode`/`slot`/`role` manifests are rejected with the v2 equivalent in the error): `core` semver range; `phases: [{slot, instructions, blocking?=false, when?: {files}, timeoutMinutes?=30}]` (slot `pre-spec|post-plan|plans-ready|pre-implement|post-test|post-run`, each entry runs as its own agent `openfleet-ext-<name>-<slot>`); `augments: [{role, instructions}]` (role `coordinator|repo-coordinator|planner|baseline|implementer|tester`; appended to the role's prompt); at least one phase or augment entry. Top-level `commands: {name: skill.md}` (CLI launches Copilot with that skill) and `permissions` (default read-only; write/shell must be declared, enforced via one tool allow-list for all of the extension's phase agents; augments use the role's own tools).
- Blocking phases (`post-plan`/`plans-ready`/`pre-implement`/`post-test`): a failure or timeout gets one retry with a fresh agent, then `extension.failed`, the child is `failed` and its dependents `blocked` (for `plans-ready`: every active child `blocked`, gate stays closed). A child is `done` only after its `post-test` entries finish, so dependents wait for blocking post-test work. Advisory phases never block.
- `when.files`: `npx openfleet ext plan` checks the paths in the child's package dir and repo root; no match → the entry is skipped and `extension.skipped` is logged.
- Outputs: a phase report may include flat string `outputs` and `followUps`. `npx openfleet ext result` stores them in `state.json` (`children[id].outputs[ext]`, `followUps`) and logs `extension.outputs`. The `subagentStart` hook injects an "Upstream outputs" table into the planner/implementer/tester prompts of every child that depends on it, directly or transitively (including scoped children under a repo coordinator). An output `prUrl` sets the child's `prUrl`; finalize then commits, pushes to the same branch and updates that PR (also in `staged` mode) instead of opening a second one. Follow-ups are listed in `summary.md`, PR bodies and the final report.
- Settings: the manifest declares `settings: {key: {default, description}}`; the workspace overrides them in `extensions.config.json` (`{ext: {key: value}}`, undeclared keys rejected), written with `npx openfleet ext settings set` (the grill asks about unset ones). Core injects a `## Settings` table into the extension's phase agents, augment sections and command skills.
- Install from git URL or local path; `add` pins SHA in lock file and prints declared permissions. Same-slot ordering = lock order, then manifest order.
- `update` disables incompatible extensions (core semver range) with a warning.
- Planned official extensions:
  - **audit**: post-run summary / replay narrative over `events.jsonl`.
  - **pattern-extractor**: post-run phase detecting duplicated code across changed repos → suggests shared npm package (report); optional "make it a project" feeds into `new`.

## Known facts (research)

- Copilot CLI hooks via plugin `hooks.json`; tool hooks lack agent id; built-in `general-purpose` agent emits no subagent hooks (→ custom agents). Nested subagents (depth 4, 32 concurrent default); `write_agent` multi-turn supported.
- Claude Code tool hooks include `agent_id`/`agent_type`; plugin hooks supported.
- Copilot namespaces plugin agents as `<plugin>:<agent>` (e.g. `openfleet:openfleet-coordinator`) in `--agent`, the task tool's `agent_type`, and hook `agentName`. `${PLUGIN_ROOT}` and the launcher's env vars are available to plugin hooks (verified with Copilot CLI 1.0.95).
