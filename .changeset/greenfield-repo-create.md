---
"@openfleet-tools/cli": minor
---

First building blocks for greenfield projects (new systems built from scratch).

- New helper `npx openfleet repo create <key> [--github <owner/name>] [--project <name>]` creates `repos/<key>` with an empty initial commit on `main` and registers it in `repos.json` with `greenfield: true`. It refuses a non-empty folder or an existing key. `--github` also creates a private GitHub repo with `gh` and pushes the initial commit, with clear errors when `gh` is missing or not signed in. `--project` marks the project as greenfield and logs a `repo.created` event.
- Project state gains `greenfield` and children gain `kind` (`setup`, `contracts`, `service`, `frontend`, `system`). In a greenfield project OpenFleet adds the run order to `dependsOn`: setup → contracts → services and frontend → system.
