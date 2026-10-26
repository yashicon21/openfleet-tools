---
"@openfleet-tools/cli": minor
---

Greenfield projects are capped at an MVP slice, enforced by the CLI.

- Approving a greenfield spec (`specApproved: true`) is refused, with every problem listed, when a child has no `kind`, when there are more services, children or acceptance criteria per child than allowed, or when `spec.md` has no non-empty `## Follow-ups` section listing what was cut.
- New workspace settings `greenfield.maxServices` (default 5), `greenfield.maxChildren` (12) and `greenfield.maxCriteriaPerChild` (8), changed with `npx openfleet config set greenfield.<key> <n>`.
- `plan.rejected` now requires a `reason`, and accepts the new `out-of-scope` for plans that build a Follow-ups item. Coordinators check greenfield plans against Follow-ups, and testers flag endpoints, pages or tables that no contract or acceptance criterion asks for.
