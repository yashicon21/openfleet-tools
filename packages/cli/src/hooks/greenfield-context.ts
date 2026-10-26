// Kind-specific instructions for the agents of a greenfield child (`state.greenfield`, child `kind`),
// injected into their assignment by the spawn hook. The same text goes to every host.
import type { ChildKind, ProjectState, Role } from "../state.js";

type Lines = Partial<Record<Role | "all", string[]>>;

const COMMON = [
  "This project builds a new system from scratch. It is capped at an MVP slice: build only what the spec's acceptance criteria and `contracts/` ask for. Anything under the spec's `## Follow-ups` is out of scope, and so is any endpoint, page or table nobody asked for.",
  "Use the stack, layout and versions from the spec's **Stack**, **Layout** and **Shared approach** sections. Do not pick other frameworks or libraries.",
  "Never put real secrets anywhere. Dev-only credentials come from a git-ignored `.env.local` that a committed script generates; `.env.example` lists the names. Third-party services (payments, email, …) sit behind an interface with a mock provider as the default.",
];

const KINDS: Record<ChildKind, Lines> = {
  setup: {
    all: [
      "You are the **setup** child: scaffold the repo so every other child starts from a working, empty app. No product features.",
    ],
    planner: [
      "Plan the scaffold with the **official generators** for the chosen stack (for example `create-next-app`, `nest new`, the framework's FastAPI template, `go mod init`), each run non-interactively, plus the workspace layout from the spec (for a monorepo: the workspace config and one package per service, the frontend and the shared contracts package).",
      "List the exact **build**, **test**, **lint** and (if any) **e2e** commands, per package where they differ, and the one sample test per package.",
    ],
    implementer: [
      "Run every generator **non-interactively**: pass explicit flags (`--yes`, `--use-pnpm`, `--typescript`, `--skip-git`, …) and `CI=1`; never wait on a prompt. A generator that refuses a non-empty folder runs into a temporary sub-folder whose contents you then move into place.",
      "Do not create a nested git repo (`--skip-git` or delete the generated `.git`). Add lint, test and build scripts, one passing sample test per package, and a `.gitignore` that covers `.env.local`, build output and dependencies.",
      "End your report's `summary` with the commands, as `Commands: build <cmd>; test <cmd>; e2e <cmd>` (per package if they differ).",
    ],
    tester: [
      "Run build, lint and test on the empty app; all must pass, including the sample tests. Check that nothing beyond the scaffold was built and that no generated `.git` folder or secret was committed.",
      'Add `"commands": {"build": "…", "test": "…", "e2e": "…"}` (per package: `{"<package>": {…}}`) to your report with the commands you ran and saw pass.',
    ],
  },
  contracts: {
    all: [
      "You are the **contracts** child: turn the spec's `contracts/` into machine-readable schemas plus generated types and clients in the shared contracts package, **before** any service or the frontend is built. They import from it.",
    ],
    planner: [
      "Plan one schema per contract: OpenAPI 3.1 for REST APIs, JSON Schema or AsyncAPI for events, `.proto` for gRPC, as the spec's communication choice says. Plan a pinned code generator for the types and clients and a `generate` script.",
    ],
    implementer: [
      "Write the schemas exactly as `contracts/` describes them, nothing more. Generate the types and clients and commit the generated code, so dependents build without running the generator.",
      "Add tests that the schemas are valid and that the generated code compiles.",
    ],
    tester: [
      "Validate every schema. Run the `generate` script and check that it leaves no diff (the generated code is current). Every contract in `contracts/` must be covered, and no endpoint, event or field may be added beyond it.",
    ],
  },
  service: {
    all: [
      "You are a **service** child. Implement exactly the endpoints and events the contracts assign to this service, using the generated types from the shared contracts package. Never edit the contracts package: ask the coordinator for a contract change.",
    ],
    implementer: [
      "Keep data in the database the spec chose, configured only through env var names. Add the schema/migrations for this service's tables only. Contract tests check every endpoint's request and response against the schema.",
    ],
    tester: [
      "Check every endpoint and event this service owns against its schema in the contracts package (contract tests must exist and pass).",
    ],
  },
  frontend: {
    all: [
      "You are the **frontend** child. Build only the pages the acceptance criteria name, calling the services through the generated clients from the shared contracts package. Never edit the contracts package: ask the coordinator for a contract change.",
    ],
    tester: [
      "Check that every call to a service goes through the generated client and matches the contract, and that every page the criteria name exists and works.",
    ],
  },
  system: {
    all: [
      "You are the **system** child: wire the whole system together and prove it with **one end-to-end flow**, the one the spec's acceptance criteria name. The run is only done when this flow passes.",
    ],
    planner: [
      "Plan a `docker-compose.yml` for the database, the other dependencies and every service and the frontend; a committed script that generates dev-only credentials into the git-ignored `.env.local` (and `.env.example` with the names); seed data; and one e2e test with a single **e2e** command that starts the system, seeds it, runs the flow and stops it again.",
    ],
    implementer: [
      "Implement the plan. The e2e command must work from a clean checkout: it generates `.env.local` if it is missing, starts docker-compose, waits for health checks, seeds, runs the flow and tears everything down. Use the ports from your `## Ports` section for anything exposed on the host.",
      "End your report's `summary` with `Commands: e2e <cmd>`.",
    ],
    tester: [
      "Run the e2e command from the spec on a clean state and check that the flow passes end to end. Check that `.env.local` is git-ignored and never committed, and that third-party services use the mock provider.",
      'Add `"commands": {"e2e": "…"}` to your report with the command you ran and saw pass.',
    ],
  },
};

/** The `## Greenfield` section of a greenfield child's assignment, or "" for any other child. */
export function greenfieldContext(state: ProjectState, childId: string, role: Role): string {
  const child = state.children[childId];
  if (!state.greenfield || !child?.kind || role === "repo-coordinator") return "";
  const kind = KINDS[child.kind];
  const lines = [...COMMON, ...(kind.all ?? []), ...(kind[role] ?? [])];
  return [`## Greenfield: ${child.kind} child`, "", ...lines.map((l) => `- ${l}`)].join("\n");
}
