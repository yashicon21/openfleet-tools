---
"@openfleet-tools/cli": patch
"@openfleet-tools/create": patch
---

Warn that `npx openfleet` must run inside the workspace folder: elsewhere npx would fetch an unrelated npm package that is also named `openfleet`. `init` says so after setup, `npm create @openfleet-tools <dir>` prints the `cd` to run first, and the README and site show `npx @openfleet-tools/cli <command>` for running OpenFleet from anywhere.
