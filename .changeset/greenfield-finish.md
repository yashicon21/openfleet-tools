---
"@openfleet-tools/cli": minor
---

Greenfield preflight, completion and `continue`.

- Preflight for greenfield projects checks that `node`, `git`, `docker` and the toolchains the stack needs (`state.toolchains`, for example `pnpm`, `uv`, `go`) are on PATH, and that their package registries are reachable (honouring `npm_config_registry`, `PIP_INDEX_URL`/`UV_INDEX_URL` and `GOPROXY`). Failures name the tool or registry with an install hint.
- Greenfield completion: when the end-to-end flow (the system child) passed, the result is committed on the new repo's `main` (new completion mode `main`), or, with a GitHub remote, pushed as one draft PR into `main` with everything after the initial commit. Otherwise nothing lands and the summary says why.
- New command `npx openfleet continue <project> [name]` starts the next slice of a finished greenfield project: a new project (default `<project>-2`) whose spec draft holds the previous Layout, Stack and Follow-ups backlog and whose contracts are copied over. Its repos are reused (no longer greenfield), the grill skips the stack questions, and the same scope caps apply. Logs `project.continued`.
- The run report shows `greenfield` or `continues <project>` in its header.
