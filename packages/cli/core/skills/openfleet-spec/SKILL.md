---
name: openfleet-spec
description: Format of an OpenFleet project spec.md (the single source of truth that planners, implementers and testers work from) and the spec review question that ends the grill and starts the run.
---

# spec.md

Write the spec to `projects/<project>/spec.md` with exactly these sections. Children read only this file and `contracts/`, so they must not need to guess anything.

```markdown
# <Project title>

## Goal

What changes and why, in 2–5 sentences.

## Children

| Child id     | Repo | Package     | Paths                        | Path / URL | Branch                            | Depends on |
| ------------ | ---- | ----------- | ---------------------------- | ---------- | --------------------------------- | ---------- |
| api          | api  | —           | —                            | ../api     | openfleet/<project>               | —          |
| web:ui       | web  | packages/ui | —                            | ../web     | openfleet/<project>-ui            | api        |
| app/setup    | app  | —           | `components/ui/**`, `lib/**` | ../app     | openfleet/<project>--app-setup    | —          |
| app/settings | app  | —           | `app/settings/**`            | ../app     | openfleet/<project>--app-settings | app/setup  |
| app/billing  | app  | —           | `app/billing/**`             | ../app     | openfleet/<project>--app-billing  | app/setup  |

Repos with more than one child (here `app`) are merged into one integration branch, by default `openfleet/<project>`; give it under **Integration branches** if it differs. Other children can depend on the whole repo (`app`) or on one child (`app/settings`).

## Contracts

| Contract              | File                         | Producer | Consumers |
| --------------------- | ---------------------------- | -------- | --------- |
| Session token payload | contracts/session-token.json | api      | web:ui    |

## Per-child requirements

### api

- **Scope:** …
- **Build:** `pnpm build`
- **Test:** `pnpm test`
- **Acceptance criteria:**
  1. …
- **Contract tests:** produces `session-token.json`: the API response must validate against the fixture.
- **Baseline:** no

### app/settings

- **Scope:** `app/settings/**`. Allowed besides: `e2e/fixtures/**`.
- **Shared items needed:** filled in by the plans at the gate; the setup child provides them.
- …

### web:ui

- …
- **E2E:** `pnpm test:e2e`
- **Env (names only):** `AUTH_CLIENT_ID`, `AUTH_CALLBACK_URL`
- **Baseline:** yes. Cover: sign-in, sign-out and the profile page. Allowed changes: the sign-in button label.

…

## Shared approach

What must be the same in every child (config shape, patterns, env var names, versions, naming), or "None".

## Ordering

The DAG in plain words, or "All children run in parallel."

## Integration branches

Only for repos with more than one child, if not `openfleet/<project>`: `app: openfleet/<project>`.

## Completion mode

`staged` | `draft-pr` (greenfield: `main` | `draft-pr`); with `draft-pr`, add "stacked PRs: yes" if the user chose them (`prStack`)

## Out of scope

- …
```

## Greenfield specs

A greenfield project (`state.greenfield`, see `openfleet-grill` step 1b) adds these sections, after **Goal**:

```markdown
## Layout

Monorepo `invoices` (`repos/invoices`, local only | GitHub `<owner>/invoices`): `packages/contracts`, `services/invoice`, `services/payment`, `apps/web`.

## Stack

| Part                  | Choice                                  |
| --------------------- | --------------------------------------- |
| Services              | TypeScript, NestJS 11, pnpm workspaces  |
| Frontend              | Next.js 16 (App Router)                 |
| Database              | PostgreSQL 17, one schema per service   |
| Service communication | REST, OpenAPI 3.1, generated TS clients |
| Auth                  | Dev-only stub login                     |
| Local run             | docker-compose                          |

## End-to-end flow

Create invoice → record payment → invoice shows paid.
```

and, after **Out of scope**, a mandatory **Follow-ups** section with everything cut from this MVP slice (one item per line; `npx openfleet spec-check` refuses an empty one):

```markdown
## Follow-ups

- Recurring invoices
- Multi-currency
```

In **Children**, add a **Kind** column (`setup`, `contracts`, `service`, `frontend`, `system`) and register each child with `"kind"` in `state.json`. Every greenfield child has **Baseline: no**. **Shared approach** repeats the Stack choices that every child must follow (versions, package manager, lint and test tools, env var naming). The system child's acceptance criteria include the end-to-end flow, and its section lists the **E2E** command and `.env.local` under local files.

## Rules

- Every child in **Children** has a section in **Per-child requirements** with build, test, at least one acceptance criterion, and its contract tests.
- Every contract file listed exists in `contracts/` (see `openfleet-contracts`).
- **Baseline** is `yes` or `no` for every child. With `yes`, it says what to cover and which baseline behaviours may change ("Allowed changes: none" is valid).
- **E2E** and **Env** lines appear for children that need them. Env lists names only, never values.
- Branch names default to `openfleet/<project>` (and `openfleet/<project>--<child slug>` for children of a repo with several children), unless the user chose otherwise. A child branch must not equal its integration branch or start with `<integration branch>/`.
- Path-scoped children (`<repo>[:<package>]/<unit>`) list their **Paths** and depend on their repo's setup child. Their sections say what else they may change (**Scope … Allowed besides**).

## Spec review: the last grill question

The spec review is part of the grill, not a separate gate. The project stays `specifying` until the user answers.

1. Log `spec.written`. Register every child in `state.json` with `phase: "pending"`, its `dependsOn`, and, for children with a baseline, `"baseline": true` and `"baselineCover": "<what to cover>"`. Path-scoped children also get `paths` and `allowPaths`, and setup children `"setup": true`. Greenfield children get their `"kind"`; run `npx openfleet spec-check <project>` and fix every problem it lists before step 2. Set the project `completionMode` (see `openfleet-records`). `maxParallel` is a workspace setting (`npx openfleet config`), not part of the spec. For a repo with several children, register its integration branch on the integration child (`{"children":{"app":{"branch":"…"}}}`) after the children, if it differs from the default. Keep `status: "specifying"`.
2. Ask the final grill question. Show a short summary (children, contracts, ordering, completion mode, out of scope), give the path to the full spec, and ask: **"Anything to change before I start?"**
3. The user's answer ends the grill:
   - If they asked for changes, apply them to `spec.md` and `contracts/` and log `spec.written` again. Do not ask them to confirm the result. Only if a requested change is too unclear to apply, ask one short follow-up, then apply it.
   - Log `spec.approved` with `{"changes":"<what changed, or none>"}`.
   - Patch `{"status":"running","specApproved":true}`.
4. Continue straight into `openfleet-orchestrate`. From here the run is hands-off: do not ask the user anything until the run is `done`.
