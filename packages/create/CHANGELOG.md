# @openfleet-tools/create

## 0.6.0

### Minor Changes

- [#35](https://github.com/yashicon21/openfleet/pull/35) [`bece92d`](https://github.com/yashicon21/openfleet/commit/bece92d5181c2ef0d47e11497801e3d1e9b6b553) Thanks [@yashicon21](https://github.com/yashicon21)! - Add `--host <copilot|claude>`, forwarded to `openfleet init`. Without it, `init` asks which agent host the workspace uses (Copilot CLI or Claude Code); without a terminal (or in CI) the host is `copilot`.

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
