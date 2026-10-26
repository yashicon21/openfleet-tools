---
"@openfleet-tools/cli": minor
---

The coordinator can now run greenfield projects end to end.

- The grill detects a request for a new system, proposes services and contracts, recommends one monorepo, asks the stack questions once with a recommendation each, offers a GitHub remote, shows the greenfield caps and cuts the request to an MVP slice with one end-to-end flow, moving the rest to `## Follow-ups`. The spec gains **Layout**, **Stack**, **End-to-end flow**, a **Kind** column and **Follow-ups**.
- New helper `npx openfleet spec-check <project>` lists what would block approving a greenfield spec, so the grill fixes it before the last question.
- After approval the coordinator creates the repos with `npx openfleet repo create`; preflight accepts a greenfield project's repos that do not exist yet.
- Each greenfield child's agents get kind-specific instructions in their assignment: the setup child scaffolds with official generators run non-interactively, the contracts child writes schemas and generated clients, services and the frontend build on them, and the system child adds docker-compose, generated dev-only credentials in a git-ignored `.env.local`, seed data and the end-to-end flow.
- New helper `npx openfleet repo confirm <key> [--package <name> [--path <dir>]] [--build|--test|--e2e <cmd>] [--copy-file <f>]` records the commands the setup and system children's testers confirmed in `repos.json`.
