# Writing extensions

An extension is a folder of **instructions only**: `openfleet.extension.json` plus Markdown. It may also contain JSON, text, images, `LICENSE` and similar files. Scripts, executables and symlinks are rejected at install time.

```
my-extension/
  openfleet.extension.json
  publish.md
  pin.md
  status.md
```

## Manifest (version 2)

```json
{
  "manifest": 2,
  "name": "publish",
  "version": "1.0.0",
  "description": "Publish a preview build after tests pass",
  "core": ">=0.2.0 <1.0.0",
  "permissions": ["shell"],
  "phases": [
    {
      "slot": "post-test",
      "instructions": "publish.md",
      "blocking": true,
      "when": { "files": [".changeset/config.json"] },
      "timeoutMinutes": 45
    }
  ],
  "augments": [{ "role": "implementer", "instructions": "pin.md" }],
  "commands": { "publish-status": "status.md" },
  "settings": {
    "label": { "default": "preview", "description": "Label that triggers the preview workflow" }
  }
}
```

| Field         | Required | Notes                                                                                                                               |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `manifest`    | yes      | Must be `2`.                                                                                                                        |
| `name`        | yes      | `^[a-z0-9][a-z0-9-]*$`, unique in the workspace                                                                                     |
| `version`     | yes      | semver                                                                                                                              |
| `core`        | yes      | semver range of compatible `@openfleet-tools/cli` versions. `update` disables the extension when the new core is outside the range. |
| `description` | no       | Used in the generated agents' descriptions.                                                                                         |
| `phases`      | \*       | Phase entries (see below). Each entry runs as its own agent.                                                                        |
| `augments`    | \*       | Augment entries (see below). Each entry is appended to a role's agent prompt.                                                       |
| `commands`    | no       | `{ "<command>": "<skill>.md" }`. The command name must not collide with a built-in command.                                         |
| `permissions` | no       | Subset of `read`, `write`, `shell`, `web`. `read` is always included. Applies to every phase agent and command of the extension.    |
| `settings`    | no       | `{ "<key>": { "default": "<string>", "description": "…" } }`. See [Settings](#settings).                                            |

\* At least one `phases` or `augments` entry is required. An extension can have several of each.

### Phase entries

| Field            | Default | Notes                                                                                                                                               |
| ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slot`           | —       | `pre-spec`, `post-plan`, `plans-ready`, `pre-implement`, `post-test` or `post-run`.                                                                 |
| `instructions`   | —       | Markdown file with the agent's instructions.                                                                                                        |
| `blocking`       | `false` | Allowed in `post-plan`, `plans-ready`, `pre-implement` and `post-test`. See [Blocking phases](#blocking-phases).                                    |
| `when.files`     | —       | Relative paths. The entry runs only if at least one exists. See [Conditional phases](#conditional-phases-whenfiles).                                |
| `timeoutMinutes` | `30`    | The coordinator stops the agent after this long and treats the attempt as failed.                                                                   |
| `hosts`          | all     | `["copilot"]`, `["claude"]` or both. On other hosts the agent is not generated and `ext plan` skips the entry with a warning (`extension.skipped`). |

Each phase entry becomes the agent `openfleet:openfleet-ext-<name>-<slot>` (a second entry in the same slot gets `-2`, and so on). All phase agents of one extension share one tool allow-list, derived from `permissions`.

### Augment entries

| Field          | Notes                                                                                |
| -------------- | ------------------------------------------------------------------------------------ |
| `role`         | `coordinator`, `repo-coordinator`, `planner`, `baseline`, `implementer` or `tester`. |
| `instructions` | Markdown appended to that role's agent prompt.                                       |
| `hosts`        | Optional. Hosts whose role agent gets these instructions (default: every host).      |

`repo-coordinator` augments reach the agent that runs a repo with several children (path-scoped children or several monorepo packages): use them for rules about merging into the integration branch or deciding in-repo questions. Augments are appended under `## Extension: <name>` and use the role's own tools. Copilot limits an agent prompt to 30,000 characters, so keep augments short.

### Version 1 manifests

Manifests without `"manifest": 2` (the old `mode`/`slot`/`role` shape) are rejected. The error message shows the equivalent v2 manifest, for example:

```json
{ "mode": "phase", "slot": "post-run", "instructions": "instructions.md" }
```

becomes

```json
{ "manifest": 2, "phases": [{ "slot": "post-run", "instructions": "instructions.md" }] }
```

## How phases run

`core/extensions.json` lists every phase entry per slot, in lock-file order and then manifest order, with its `agent`, `blocking`, `when` and `timeoutMinutes`. At each slot the coordinator:

1. Runs `npx openfleet ext plan <project> <slot> [--child <id>]`. It prints the entries to run and logs `extension.skipped` for entries whose `when.files` do not exist.
2. Spawns each entry's agent in order, with the project name and (for per-child slots) the child id and worktree.
3. Records the agent's report with `npx openfleet ext result …`, which logs `extension.ran`.

| Slot            | Runs                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `pre-spec`      | Once per project, during the grill.                                                                 |
| `post-plan`     | Per child, after its plan is validated.                                                             |
| `plans-ready`   | Once per project, after every plan passed the consistency check and before anything is implemented. |
| `pre-implement` | Per child, after the gate (and its baseline, if any), right before its implementer.                 |
| `post-test`     | Per child, after the tester passes. The child is `done` only after these finish.                    |
| `post-run`      | Once per project, during finalize.                                                                  |

For a repo with several children, its repo coordinator runs the per-child slots (`post-plan`, `pre-implement`, `post-test`) for each of its children, with the same `ext plan` / `ext result` / `ext fail` commands. `when.files` is checked in that child's worktree. A blocking failure marks that child `failed`, and its dependents become `blocked`, as for any failed child.

### Reports

A phase agent ends its final reply with one fenced block:

````
```openfleet-report
{"status": "done", "summary": "…", "outputs": {"version": "1.3.0-preview.1", "prUrl": "https://…"}, "followUps": ["…"]}
```
````

- `status`: `done` or `failed`.
- `outputs` (optional): **flat string values only**. See [Outputs](#outputs).
- `followUps` (optional): strings for people to act on after the run.

### Blocking phases

`blocking: false` (the default) is advisory: a failure is reported and the run continues.

For a blocking entry, a failure, a missing report or a timeout gets **one retry with a fresh agent**. If the retry also fails, the coordinator runs `npx openfleet ext fail`, which:

- logs `extension.failed` (and `child.failed`),
- marks the child `failed`,
- marks every child that depends on it, directly or transitively, `blocked`.

The run continues with the other children, as for any failed child.

In `plans-ready` (a project slot), `npx openfleet ext fail` has no `--child`. It marks every active child `blocked` and the gate stays closed, so nothing is implemented. The user decides what to do with `npx openfleet resume`.

A child only reaches `done` after all of its `post-test` entries finish, so dependents never start before a blocking `post-test` entry succeeds.

### Conditional phases (`when.files`)

Before an entry is spawned, `ext plan` checks the listed paths:

- per-child slots: in the child's package directory and in its repo root (both, for monorepo packages);
- project slots: in every child's directories, or in the local repo checkouts from `repos.json` before any child exists.

If none exist, the entry is skipped and `extension.skipped` is logged with the directories that were checked.

### Outputs

`npx openfleet ext result` stores a report's `outputs` in `state.json` under `children.<id>.outputs.<extension>` and logs `extension.outputs`.

When the coordinator spawns a planner, baseline tester, implementer or tester for another child, the `subagentStart` hook adds an **Upstream outputs** table to its prompt. It lists the outputs of every child it depends on, **directly or transitively**, so a value published by a library reaches every repo downstream of it, including path-scoped children run by a repo coordinator. The hook does this from `state.json`, so it does not depend on the coordinator relaying values. An implementer augment can tell the implementer how to use them (for example, pin the version exactly).

An output named **`prUrl`** marks a pull request the extension opened for the child mid-run. It sets the child's `prUrl`. In finalize, OpenFleet commits anything left in the worktree, pushes to the same branch and updates the existing PR body (summary, Related PRs, follow-ups) instead of opening a second PR. This happens in `staged` mode too, because those changes are already pushed.

### Follow-ups

`followUps` are stored in `children.<id>.followUps.<extension>` (project-level slots store them in the top-level `followUps`). Finalize lists them per child in `summary.md`, in the affected PR bodies and in the final report.

## Settings

An extension declares settings with string defaults:

```json
"settings": { "label": { "default": "preview", "description": "Label that triggers the preview workflow" } }
```

A workspace overrides them in `extensions.config.json`:

```json
{ "publish": { "label": "nightly" } }
```

Override keys must be declared by the extension, and values must be strings; anything else is an error. OpenFleet resolves the values and adds a **Settings** table (key, value, description) to every prompt of the extension: its phase agents, its augment sections and its command skills. `new`, `resume` and extension commands re-sync, so edits apply to the next session.

Settings are workspace-level: one value per workspace, shared by every project. Manage them with:

```sh
npx openfleet ext settings            # every declared setting: extension, key, default, description, value, set
npx openfleet ext settings --unset    # only settings without a value in extensions.config.json
npx openfleet ext settings set <extension> <key> <value>
```

`set` validates the key against the manifest (like core does), writes `extensions.config.json` under a lock and regenerates the extension's agents. During the grill, the coordinator runs `ext settings --unset` and asks the user about each unset setting (keep the default or give a value), then writes every answer with `ext settings set`. Once a key is set, later projects do not ask again; the grill skips the step when nothing is unset. Settings are stored in plain text, so do not use them for secrets.

## Commands

Each `commands` entry becomes a skill. `npx openfleet <command> [args]` launches the workspace host (Copilot by default) with the extension's command agent (`openfleet:openfleet-ext-<name>`) and tells it to follow that skill, passing the arguments.

## Permissions

Permissions are mapped to each host's tool names in the generated agents' `tools` allow-list:

| Permission | Copilot tools    | Claude Code tools       |
| ---------- | ---------------- | ----------------------- |
| `read`     | `read`, `search` | `Read`, `Grep`, `Glob`  |
| `write`    | `edit`           | `Edit`, `Write`         |
| `shell`    | `execute`        | `Bash`                  |
| `web`      | `web`            | `WebFetch`, `WebSearch` |

`npx openfleet add` prints the declared permissions, phases, augments and settings so you can review them.

## Installing

```sh
npx openfleet add ../my-extension                       # local path
npx openfleet add https://github.com/acme/audit.git#v1  # git URL, optional #ref
npx openfleet remove audit
```

Git sources are pinned to a commit SHA in `extensions.lock.json`. Running `add` again with the same name updates the extension. Commit `extensions/`, `extensions.lock.json` and `extensions.config.json`.
