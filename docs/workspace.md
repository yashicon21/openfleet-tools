# Workspace

Everything sits in the folder you ran `npm create @openfleet-tools` in, next to `package.json` and `node_modules/`:

```
my-workspace/
  package.json  node_modules/
  openfleet.json         # workspace marker + settings, e.g. { "version": "0.5.0", "maxParallel": 6, "host": "copilot" } (commit this)
  .gitignore             # written by `init` if missing
  core/                  # installed by the CLI; replaced by `update` (gitignored)
  extensions/            # instruction-only extensions (commit this)
  extensions.lock.json   # source + pinned SHA per extension (commit this)
  extensions.config.json # optional per-workspace extension settings (commit this)
  repos.json             # known repos/packages, build and test commands (commit this)
  repos/<key>/           # repos cloned from a `url` in repos.json (gitignored)
  projects/<name>/
    spec.md  state.json  events.jsonl  contracts/  plans/
    summary.md  report.html  # written when the run finishes
    patches/<seq>.patch  # gitignored
    worktrees/<child>/   # gitignored; one per child (web:ui/button → web__ui__button),
                         # plus one integration worktree per repo with several children
```

`init` refuses a folder without `openfleet.json` that already has any of these entries; use an empty folder or a new subfolder. If a `.gitignore` already exists, `init` leaves it alone and prints the lines to add.

Repos can live anywhere: give a `path` (relative to the workspace root) or a `url`, which is cloned into `repos/<key>`.

`e2e` and `env` (names of required env vars and credentials, never values) are recorded by the grill. `copyFiles` lists git-ignored local files (for example `.env.local`) that are copied from the repo's checkout into every worktree. They are never staged or committed, and their values are redacted from the event log.

```json
{
  "v": 1,
  "repos": {
    "api": { "path": "../api", "defaultBranch": "main", "build": "pnpm build", "test": "pnpm test", "confirmed": true },
    "app": {
      "path": "../app",
      "test": "pnpm test",
      "e2e": "pnpm test:e2e",
      "env": ["AUTH_CLIENT_ID", "AUTH_CLIENT_SECRET"],
      "copyFiles": [".env.local"]
    },
    "web": {
      "url": "git@github.com:acme/web.git",
      "packages": { "ui": { "path": "packages/ui", "test": "pnpm -F ui test" } }
    }
  }
}
```

---

[← README](../README.md) · [How it works](./how-it-works.md) · [Greenfield projects](./greenfield.md) · **Workspace** · [Commands](./commands.md) · [Models and hosts](./models-and-hosts.md) · [Run report](./run-report.md) · [Limitations and troubleshooting](./limitations-and-troubleshooting.md) · [Releasing](./releasing.md)
