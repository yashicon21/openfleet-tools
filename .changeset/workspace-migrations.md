---
"@openfleet-tools/cli": minor
---

Safe upgrades between versions.

- `state.json`, `repos.json` and `extensions.lock.json` are checked against the schema this CLI reads. A file from a newer OpenFleet is refused with "upgrade the CLI", and one with an older schema is refused with "run `npx openfleet update`", instead of being misread.
- `npx openfleet update` migrates every one of those files first, keeping a `<file>.v<N>.bak` copy of each original, and refuses to downgrade a workspace whose core is newer than the CLI.
- A test upgrades a workspace made with 0.6.0 and checks that its projects keep working.
