---
name: openfleet-contracts
description: How OpenFleet defines cross-repo contracts as shared fixtures in contracts/, and how contract tests and contract changes work. v1 testing is contract tests only.
---

# Contracts

A **contract** is any interface that crosses a child boundary. In v1, OpenFleet verifies cross-repo correctness with **contract tests only**: each repo tests itself against the same shared fixture.

## Fixtures

The coordinator writes the fixtures to `projects/<project>/contracts/` during the grill:

- Prefer machine-checkable formats: JSON Schema (`*.schema.json`), example payloads (`*.example.json`), OpenAPI fragments, `.proto` or `.graphql` snippets, or TypeScript `.d.ts` type declarations.
- Give each fixture a sibling Markdown note (`<name>.md`). It must state the producer, the consumers, the semantics that the format cannot capture (units, nullability, ordering, error cases), and a version line.
- Keep each fixture minimal: only the fields that cross the boundary.

## Contract tests

- **Planner:** the plan must include at least one contract test for every contract that the child produces or consumes.
- **Implementer:** writes the tests. Producers assert that real output conforms to the fixture. Consumers assert that they correctly handle the fixture's example payloads, including the error cases.
- **Tester:** verifies that the tests exist, reference the shared fixture, run in the child's test command, and pass.

## Greenfield projects

In a greenfield project, `contracts/` holds the agreed shapes from the grill (for an API: one OpenAPI 3.1 fragment per service, with every endpoint, request, response and error case of the MVP slice; for events: one JSON Schema per event). The `contracts` child turns them into the shared contracts package (full schemas plus generated types and clients) before any service or the frontend is built; those children import from that package, and their contract tests validate against it. A contract change during the run updates `contracts/` **and** the contracts package: send it to the contracts child (moved back to `implementing` if it is `done`) before the children that use it.

## Changing a contract during the run

Only the top coordinator changes contracts, usually after a child asks a question. This happens during the hands-off run, so the coordinator decides without asking the user. A repo coordinator never changes a contract or the Shared approach: it escalates the question (`npx openfleet escalate <project> <child> --question '…'`), and the top coordinator decides, changes the contract here, resolves each escalated child (`escalate … --resolve --decision '…'`) and resumes the repo coordinator with <!--host:copilot-->`write_agent`<!--host:claude-->`SendMessage`<!--/host-->.

1. Decide the change. If the spec already answers the question, use that answer. Otherwise decide yourself; do not ask the user. Log the decision as an `assumption` event with `"contractChange": true` (see `openfleet-orchestrate`).
2. Update the fixture, its `.md` note and version line, and the Contracts table in `spec.md`.
3. Log `contract.changed` with every affected child.
4. **Broadcast:** send each affected child that is running (<!--host:copilot-->`write_agent`<!--host:claude-->`SendMessage`<!--/host-->; for children of a repo coordinator, send it to the repo coordinator, which forwards it) a short message: what changed, the fixture path, and what they must adjust. Log each message as `message.sent`. For affected children that are already `done`, move them back to `implementing`. Spawn a new implementer with the change as findings, then re-test.
5. **Re-plan if needed.** If a change invalidates a child's plan (for example, it has not started implementing yet, or the plan no longer fits), send the change to its planner, or spawn a new one, and patch the child `{"phase":"plan-review"}`. This clears its `consistent` flag. After you re-validate the plan and patch `{"phase":"planned"}`, `npx openfleet next` returns `check-consistency` for it: compare it with the other plans again before it continues.
