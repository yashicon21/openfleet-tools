# Greenfield projects

OpenFleet can also build a **new system from scratch**. Describe it in the request, for example:

```sh
npx openfleet new invoices "Create an invoice and payment tracking website with microservices and a frontend"
```

The grill notices that no repo fits and switches to greenfield mode:

- **Services and contracts.** It proposes the services, the frontend and the contracts between them.
- **Layout.** It recommends **one monorepo** (one package per service, one for the frontend, one shared contracts package); several repos work too.
- **Stack.** It asks once for the whole system, recommending an answer each time: language and framework per service, frontend framework, database, service communication (REST/OpenAPI, gRPC or events), auth and local run (docker-compose).
- **GitHub remote.** It offers a private GitHub repo per repo (`gh repo create`); the default is local only.
- **MVP slice.** It cuts the request to the core flows plus **one end-to-end flow** that proves them (for the invoice tracker: create invoice → record payment → invoice shows paid). Everything else goes into the spec's `## Follow-ups`, so you see what was cut.

The scope is capped by the CLI, not just by the prompt. A greenfield spec cannot be approved with more than `greenfield.maxServices` services (default 5), `greenfield.maxChildren` children (12) or `greenfield.maxCriteriaPerChild` acceptance criteria per child (8), or without a non-empty `## Follow-ups` section. Raise a cap with `npx openfleet config set greenfield.<key> <n>`. During the run, the plan gate sends back plans that build a Follow-ups item (`plan.rejected`, reason `out-of-scope`), and testers fail endpoints, pages or tables that no contract or criterion asks for.

After you approve the spec, OpenFleet creates each repo (`npx openfleet repo create`: an empty initial commit on `main`, registered in `repos.json` with `greenfield: true`). Preflight checks that `node`, `git`, `docker` and the stack's toolchains are installed and that their package registries are reachable. Then the children run in a fixed order:

1. **setup** (one per repo): scaffolds with the official generators, run non-interactively, and adds lint, test, build and a sample test. The commands its tester confirmed are recorded in `repos.json`.
2. **contracts**: schemas (OpenAPI, event schemas) plus generated types and clients in a shared package.
3. **services** and the **frontend**, in parallel, built on the contracts package.
4. **system**: docker-compose for the whole system, dev-only credentials generated into a git-ignored `.env.local`, seed data, third-party services stubbed behind a mock provider, and the end-to-end flow.

Only when the end-to-end flow passes does the work land: on the new repo's `main` (completion mode `main`), or, with a GitHub remote, as one draft PR into `main` with everything after the initial commit.

To build the next slice, run `npx openfleet continue invoices`. It starts a new project (`invoices-2`) from the Follow-ups, reusing the repos, the stack and the contracts; the grill skips the stack questions and picks the next slice under the same caps.

---

[← README](../README.md) · [How it works](./how-it-works.md) · **Greenfield projects** · [Workspace](./workspace.md) · [Commands](./commands.md) · [Models and hosts](./models-and-hosts.md) · [Run report](./run-report.md) · [Limitations and troubleshooting](./limitations-and-troubleshooting.md) · [Releasing](./releasing.md)
