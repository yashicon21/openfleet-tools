import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { greenfieldLimits, readConfig, setConfig } from "../src/config.js";
import { readEvents } from "../src/events.js";
import { readJson, writeJson } from "../src/fsutil.js";
import { specCriteria, specFollowUps } from "../src/greenfield.js";
import { isSetup } from "../src/groups.js";
import { childContext } from "../src/hooks/handlers.js";
import { formatFailure, greenfieldChecks, preflight } from "../src/preflight.js";
import { buildModel } from "../src/report/model.js";
import { onPath, registriesFor, toolchainsFor } from "../src/toolchains.js";
import type { ReposFile } from "../src/repos.js";
import { newState, patchState, readState, type ProjectState } from "../src/state.js";
import { projectPaths, type Workspace } from "../src/workspace.js";
import { sh, tmpDir, workspace } from "./helpers.js";

/** A PATH with fake executables and a registry probe that always answers. */
function fakeBin(names: string[]): string {
  const dir = tmpDir();
  for (const n of names) {
    fs.writeFileSync(path.join(dir, n), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(dir, n), 0o755);
  }
  return dir;
}
const okEnv = () => ({ env: { PATH: fakeBin(["node", "git", "docker"]) }, probe: () => ({ ok: true }) });

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
};

function cli(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Fake `gh`: records its args; `auth status` fails with FAKE_GH_AUTH=fail; `repo create` adds origin. */
function fakeGh(dir: string): { bin: string; log: string } {
  const bin = path.join(dir, "fake-gh.mjs");
  const log = path.join(dir, "gh.log");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "auth") {
  if (process.env.FAKE_GH_AUTH === "fail") { console.error("You are not logged into any GitHub hosts."); process.exit(1); }
  process.exit(0);
}
if (args[0] === "repo" && args[1] === "create") {
  if (process.env.FAKE_GH_CREATE === "fail") { console.error("GraphQL: Name already exists on this account"); process.exit(1); }
  const src = args[args.indexOf("--source") + 1];
  execFileSync("git", ["remote", "add", "origin", "git@github.com:" + args[2] + ".git"], { cwd: src });
  process.exit(0);
}
process.exit(2);
`,
  );
  fs.chmodSync(bin, 0o755);
  return { bin, log };
}

function project(ws: Workspace, name = "invoices") {
  const p = projectPaths(ws, name);
  fs.mkdirSync(p.dir, { recursive: true });
  writeJson(p.state, newState(name, "sess-1"));
  return p;
}

describe("repo create", () => {
  it("creates an empty repo with an initial commit on main and registers it as greenfield", () => {
    const ws = workspace();
    const p = project(ws);
    const r = cli(ws.root, ["repo", "create", "invoices", "--project", "invoices"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const dir = path.join(ws.repos, "invoices");
    expect(sh(dir, "git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
    expect(sh(dir, "git", ["log", "--format=%s"]).trim()).toBe("chore: Initial commit");
    expect(sh(dir, "git", ["ls-tree", "-r", "HEAD"]).trim()).toBe("");
    expect(readJson<ReposFile>(ws.reposFile).repos.invoices).toEqual({
      path: "repos/invoices",
      defaultBranch: "main",
      greenfield: true,
    });
    expect(readState(p).greenfield).toBe(true);
    expect(readEvents(p).find((e) => e.type === "repo.created")).toMatchObject({
      payload: { key: "invoices", path: "repos/invoices", remote: null, github: null },
    });
  });

  it("works without a project and accepts an existing empty folder", () => {
    const ws = workspace();
    fs.mkdirSync(path.join(ws.repos, "web"), { recursive: true });
    expect(cli(ws.root, ["repo", "create", "web"]).code).toBe(0);
    expect(readJson<ReposFile>(ws.reposFile).repos.web?.greenfield).toBe(true);
  });

  it("refuses a non-empty folder, a known key and an invalid key", () => {
    const ws = workspace({ api: { path: "../api" } });
    fs.mkdirSync(path.join(ws.repos, "web"), { recursive: true });
    fs.writeFileSync(path.join(ws.repos, "web", "index.html"), "<p>hi</p>");
    const busy = cli(ws.root, ["repo", "create", "web"]);
    expect(busy.code).toBe(1);
    expect(busy.stderr).toMatch(/already exists and is not empty/);
    expect(fs.existsSync(path.join(ws.repos, "web", ".git"))).toBe(false);
    expect(cli(ws.root, ["repo", "create", "api"]).stderr).toMatch(/already in repos\.json/);
    expect(cli(ws.root, ["repo", "create", "../x"]).stderr).toMatch(/Invalid repo key/);
    expect(cli(ws.root, ["repo", "list"]).stderr).toMatch(/Usage:\n {2}openfleet repo create/);
  });

  it("--github creates a private repo with gh and records the remote", () => {
    const ws = workspace();
    const gh = fakeGh(tmpDir());
    const r = cli(ws.root, ["repo", "create", "invoices", "--github", "someone/invoices"], {
      OPENFLEET_GH_BIN: gh.bin,
    });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const calls = fs
      .readFileSync(gh.log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);
    expect(calls[0]).toEqual(["auth", "status"]);
    expect(calls[1]).toEqual([
      "repo",
      "create",
      "someone/invoices",
      "--private",
      "--source",
      path.join(ws.repos, "invoices"),
      "--remote",
      "origin",
      "--push",
    ]);
    expect(readJson<ReposFile>(ws.reposFile).repos.invoices).toMatchObject({
      url: "git@github.com:someone/invoices.git",
      greenfield: true,
    });
  });

  it("--github fails clearly when gh is missing, signed out or create fails, leaving nothing behind", () => {
    const ws = workspace();
    const gh = fakeGh(tmpDir());
    const missing = cli(ws.root, ["repo", "create", "a", "--github", "o/a"], {
      OPENFLEET_GH_BIN: path.join(tmpDir(), "no-gh"),
    });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/GitHub CLI/);
    const signedOut = cli(ws.root, ["repo", "create", "a", "--github", "o/a"], {
      OPENFLEET_GH_BIN: gh.bin,
      FAKE_GH_AUTH: "fail",
    });
    expect(signedOut.stderr).toMatch(/not signed in[\s\S]*not logged into any GitHub hosts[\s\S]*gh auth login/);
    const failed = cli(ws.root, ["repo", "create", "a", "--github", "o/a"], {
      OPENFLEET_GH_BIN: gh.bin,
      FAKE_GH_CREATE: "fail",
    });
    expect(failed.stderr).toMatch(/Name already exists/);
    expect(cli(ws.root, ["repo", "create", "a", "--github", "bad"]).stderr).toMatch(/Use <owner>\/<name>/);
    expect(fs.existsSync(path.join(ws.repos, "a"))).toBe(false);
    expect(readJson<ReposFile>(ws.reposFile).repos.a).toBeUndefined();
  });

  it("creates worktrees off the empty initial commit and snapshots them", () => {
    const ws = workspace();
    const p = project(ws);
    expect(cli(ws.root, ["repo", "create", "invoices", "--project", "invoices"]).code).toBe(0);
    const wt = cli(ws.root, ["worktree", "invoices", "invoices/setup", "--branch", "openfleet/invoices--setup"]);
    expect(wt.stderr).toBe("");
    const child = JSON.parse(wt.stdout) as { worktree: string; baseBranch: string; baseSha: string };
    expect(child.baseBranch).toBe("main");
    expect(child.baseSha).toBe(sh(path.join(ws.repos, "invoices"), "git", ["rev-parse", "main"]).trim());
    fs.writeFileSync(path.join(child.worktree, "package.json"), "{}\n");
    const scope = cli(ws.root, ["scope", "invoices", "invoices/setup", "--check"]);
    expect(JSON.parse(scope.stdout)).toMatchObject({ changed: ["package.json"], ok: true });
    expect(readState(p).children["invoices/setup"]?.phase).toBe("pending");
  });
});

describe("greenfield child kinds", () => {
  function greenfieldProject(children: Record<string, object>, greenfield = true): ProjectState {
    const ws = workspace();
    const p = project(ws);
    return patchState(p, { greenfield, children });
  }

  it("adds setup → contracts → services ∥ frontend → system to dependsOn", () => {
    const s = greenfieldProject({
      "app/setup": { kind: "setup" },
      "app:contracts": { kind: "contracts" },
      "app:invoices": { kind: "service" },
      "app:payments": { kind: "service", dependsOn: ["app:invoices"] },
      "app:web": { kind: "frontend" },
      "app/system": { kind: "system" },
    });
    const deps = (id: string) => [...s.children[id]!.dependsOn].sort();
    expect(deps("app/setup")).toEqual([]);
    expect(deps("app:contracts")).toEqual(["app/setup"]);
    expect(deps("app:invoices")).toEqual(["app/setup", "app:contracts"]);
    expect(deps("app:payments")).toEqual(["app/setup", "app:contracts", "app:invoices"]);
    expect(deps("app:web")).toEqual(["app/setup", "app:contracts"]);
    expect(deps("app/system")).toEqual(["app/setup", "app:contracts", "app:invoices", "app:payments", "app:web"]);
    expect(s.children.app?.integration).toBe(true);
    expect(isSetup("app/setup", s.children["app/setup"]!)).toBe(true);
  });

  it("keeps setup per repo in a multi-repo layout", () => {
    const s = greenfieldProject({
      "api/setup": { kind: "setup" },
      "web/setup": { kind: "setup" },
      "api/contracts": { kind: "contracts" },
      "web/ui": { kind: "frontend" },
    });
    expect([...s.children["web/ui"]!.dependsOn].sort()).toEqual(["api/contracts", "web/setup"]);
    expect(s.children["api/contracts"]!.dependsOn).toEqual(["api/setup"]);
  });

  it("leaves dependsOn alone outside greenfield projects and rejects unknown kinds", () => {
    const s = greenfieldProject({ "app/setup": { kind: "setup" }, "app/web": { kind: "frontend" } }, false);
    expect(s.children["app/web"]!.dependsOn).toEqual([]);
    const ws = workspace();
    const p = project(ws);
    expect(() => patchState(p, { children: { app: { kind: "database" } } })).toThrow(/Unknown kind "database"/);
  });
});

const MVP_SPEC = (criteria = 2, followUps = "- Recurring invoices\n- Multi-currency\n") => `# Invoices

## Goal

Track invoices and payments.

## Per-child requirements

### app/setup

- **Build:** \`pnpm build\`
- **Acceptance criteria:**
  1. Build and test pass on the empty app.

### app:invoices

- **Scope:** invoice service.
- **Acceptance criteria:**
${Array.from({ length: criteria }, (_, i) => `  ${i + 1}. Criterion ${i + 1}.`).join("\n")}
- **Contract tests:** produces \`invoices.yaml\`.

### app/system

- **Acceptance criteria:**
  - Create invoice → record payment → invoice shows paid.

## Shared approach

None.

\`\`\`markdown
## Follow-ups
\`\`\`

## Follow-ups

${followUps}
## Completion mode

\`staged\`
`;

describe("greenfield scope guard", () => {
  function setup(spec: string | undefined, children: Record<string, object> = {}) {
    const ws = workspace();
    const p = project(ws);
    if (spec !== undefined) fs.writeFileSync(p.spec, spec);
    patchState(p, {
      greenfield: true,
      children: {
        "app/setup": { kind: "setup" },
        "app:invoices": { kind: "service" },
        "app/system": { kind: "system" },
        ...children,
      },
    });
    return { ws, p, approve: () => patchState(p, { status: "running", specApproved: true }) };
  }

  it("approves a spec within the caps that lists Follow-ups", () => {
    const { approve } = setup(MVP_SPEC());
    expect(approve().specApproved).toBe(true);
  });

  it("parses Follow-ups and acceptance criteria from spec.md", () => {
    expect(specFollowUps(MVP_SPEC())).toEqual(["Recurring invoices", "Multi-currency"]);
    expect(specFollowUps(MVP_SPEC(2, "None.\n"))).toEqual([]);
    expect(specFollowUps("# x\n\n## Goal\n\nHi.\n")).toBeUndefined();
    expect(Object.fromEntries(specCriteria(MVP_SPEC(3)))).toEqual({
      "app/setup": 1,
      "app:invoices": 3,
      "app/system": 1,
    });
  });

  it("refuses a missing or empty Follow-ups section", () => {
    const missing = setup(MVP_SPEC().replace(/\n## Follow-ups\n\n[^#]*/, "\n"));
    expect(() => missing.approve()).toThrow(/no ## Follow-ups section/);
    const empty = setup(MVP_SPEC(2, "None\n"));
    expect(() => empty.approve()).toThrow(/Follow-ups section is empty/);
    expect(readState(empty.p).specApproved).toBeUndefined();
  });

  it("refuses too many services, children and criteria, listing every violation", () => {
    const services = Object.fromEntries(["a", "b", "c", "d", "e"].map((s) => [`app:svc-${s}`, { kind: "service" }]));
    const { approve } = setup(MVP_SPEC(9), { ...services, "app:web": { kind: "frontend" }, "app:x": {} });
    let message = "";
    try {
      approve();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/Missing: app:x/);
    expect(message).toMatch(/6 services .*limit is 5.*greenfield\.maxServices/);
    expect(message).not.toMatch(/children, but the limit/);
    expect(message).toMatch(/app:invoices has 9 acceptance criteria, but the limit is 8/);
    expect(message.split("\n- ")).toHaveLength(4);
  });

  it("uses greenfield limits from openfleet.json", () => {
    const { ws, approve } = setup(MVP_SPEC(3));
    setConfig(ws, "greenfield.maxCriteriaPerChild", "2");
    expect(() => approve()).toThrow(/3 acceptance criteria, but the limit is 2/);
    setConfig(ws, "greenfield.maxChildren", "2");
    expect(() => approve()).toThrow(/3 children, but the limit is 2/);
    setConfig(ws, "greenfield.maxCriteriaPerChild", "3");
    setConfig(ws, "greenfield.maxChildren", "12");
    expect(approve().specApproved).toBe(true);
  });

  it("does not check brownfield projects", () => {
    const ws = workspace();
    const p = project(ws);
    patchState(p, { children: { api: {} } });
    expect(patchState(p, { specApproved: true }).specApproved).toBe(true);
  });

  it("config set greenfield.<key> validates and keeps other limits", () => {
    const ws = workspace();
    const c = (args: string[]) => cli(ws.root, ["config", ...args]);
    expect(c(["set", "greenfield.maxServices", "3"]).code).toBe(0);
    expect(c(["set", "greenfield.maxChildren", "10"]).code).toBe(0);
    expect(readJson<{ greenfield: object }>(ws.marker).greenfield).toEqual({ maxServices: 3, maxChildren: 10 });
    expect(greenfieldLimits(readConfig(ws))).toEqual({ maxServices: 3, maxChildren: 10, maxCriteriaPerChild: 8 });
    expect(c(["set", "greenfield.maxServices", "0"]).stderr).toMatch(/greenfield\.maxServices must be a positive/);
    expect(c(["set", "greenfield.maxPages", "3"]).stderr).toMatch(/Unknown greenfield setting "maxPages"/);
    expect(c(["set", "greenfield", "3"]).stderr).toMatch(/one greenfield limit at a time/);
    fs.writeFileSync(ws.marker, JSON.stringify({ maxParallel: 6, greenfield: { maxServices: "x" } }));
    expect(c([]).stderr).toMatch(/openfleet\.json: greenfield\.maxServices must be a positive integer/);
  });

  it("plan.rejected needs a known reason, including out-of-scope", () => {
    const ws = workspace();
    const p = project(ws);
    const ev = (payload: object) =>
      cli(ws.root, [
        "event",
        "invoices",
        "--type",
        "plan.rejected",
        "--target",
        "app:web",
        "--payload",
        JSON.stringify(payload),
      ]);
    expect(ev({ reason: "out-of-scope", reasons: ["Implements recurring invoices (Follow-ups)"] }).code).toBe(0);
    expect(ev({ reason: "invalid", reasons: [] }).code).toBe(0);
    expect(ev({ reasons: ["x"] }).stderr).toMatch(/needs payload\.reason: one of invalid, inconsistent, out-of-scope/);
    expect(ev({ reason: "too-big" }).code).toBe(1);
    expect(
      readEvents(p)
        .filter((e) => e.type === "plan.rejected")
        .map((e) => e.payload.reason),
    ).toEqual(["out-of-scope", "invalid"]);
  });
});

describe("greenfield prompts and helpers", () => {
  it("repo confirm records commands for a repo and its packages", () => {
    const ws = workspace();
    expect(cli(ws.root, ["repo", "create", "app"]).code).toBe(0);
    const ok = cli(ws.root, ["repo", "confirm", "app", "--build", "pnpm -r build", "--test", "pnpm -r test"]);
    expect(ok.stderr).toBe("");
    expect(
      cli(ws.root, ["repo", "confirm", "app", "--package", "web", "--path", "apps/web", "--e2e", "pnpm e2e"]).code,
    ).toBe(0);
    expect(cli(ws.root, ["repo", "confirm", "app", "--package", "web", "--test", "pnpm --filter web test"]).code).toBe(
      0,
    );
    for (const f of [".env.local", ".env.local"])
      expect(cli(ws.root, ["repo", "confirm", "app", "--copy-file", f]).code).toBe(0);
    expect(readJson<ReposFile>(ws.reposFile).repos.app).toEqual({
      path: "repos/app",
      defaultBranch: "main",
      greenfield: true,
      build: "pnpm -r build",
      test: "pnpm -r test",
      confirmed: true,
      packages: { web: { path: "apps/web", e2e: "pnpm e2e", test: "pnpm --filter web test" } },
      copyFiles: [".env.local"],
    });
    expect(cli(ws.root, ["repo", "confirm", "app", "--package", "api"]).stderr).toMatch(/is new: pass --path/);
    expect(cli(ws.root, ["repo", "confirm", "app", "--path", "x"]).stderr).toMatch(/--path needs --package/);
    expect(cli(ws.root, ["repo", "confirm", "app", "--copy-file", "../x"]).stderr).toMatch(/must stay inside the repo/);
    expect(cli(ws.root, ["repo", "confirm", "app", "--build", " "]).stderr).toMatch(/--build must not be empty/);
    expect(cli(ws.root, ["repo", "confirm", "nope", "--build", "x"]).stderr).toMatch(/not in repos\.json/);
  });

  it("preflight treats a greenfield project's repos that do not exist yet as pending", () => {
    const ws = workspace();
    const p = project(ws);
    patchState(p, { greenfield: true, children: { "app/setup": { kind: "setup" } } });
    const report = preflight(ws, "invoices", undefined, okEnv());
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.repo === "app")).toMatchObject({ check: "clone-dir", ok: true });
    patchState(p, { greenfield: null });
    expect(preflight(ws, "invoices").checks.find((c) => c.repo === "app")).toMatchObject({
      ok: false,
      error: "not in repos.json",
    });
  });

  it("spec-check lists what blocks approval", () => {
    const ws = workspace();
    const p = project(ws);
    patchState(p, { greenfield: true, children: { "app/setup": { kind: "setup" }, "app:api": {} } });
    const bad = cli(ws.root, ["spec-check", "invoices"]);
    expect(bad.code).toBe(1);
    const report = JSON.parse(bad.stdout) as { ok: boolean; limits: object; problems: string[] };
    expect(report.ok).toBe(false);
    expect(report.limits).toEqual({ maxServices: 5, maxChildren: 12, maxCriteriaPerChild: 8 });
    expect(report.problems.join("\n")).toMatch(/Missing: app:api[\s\S]*spec\.md is missing/);
    fs.writeFileSync(p.spec, MVP_SPEC());
    patchState(p, { children: { "app:api": { kind: "service" } } });
    expect(cli(ws.root, ["spec-check", "invoices"]).code).toBe(0);
  });

  it("injects kind-specific instructions into greenfield assignments only", () => {
    const ws = workspace();
    const p = project(ws);
    const state = patchState(p, {
      greenfield: true,
      children: {
        "app/setup": { kind: "setup" },
        "app:contracts": { kind: "contracts" },
        "app/system": { kind: "system" },
      },
    });
    const setupImpl = childContext(p, state, "app/setup", "implementer");
    expect(setupImpl).toContain("## Greenfield: setup child");
    expect(setupImpl).toMatch(/non-interactively/);
    expect(setupImpl).toMatch(/## Follow-ups/);
    expect(childContext(p, state, "app/setup", "tester")).toMatch(/"commands"/);
    expect(childContext(p, state, "app:contracts", "tester")).toMatch(/leaves no diff/);
    expect(childContext(p, state, "app/system", "planner")).toMatch(/docker-compose/);
    expect(childContext(p, state, "app/system", "planner")).not.toMatch(/Commands: e2e/);
    const brown = patchState(p, { greenfield: null });
    expect(childContext(p, brown, "app/setup", "implementer")).not.toContain("## Greenfield");
  });
});

describe("greenfield preflight toolchains", () => {
  it("knows toolchains, PATH lookups and registries", () => {
    expect(toolchainsFor(["pnpm", "node", "bad name"])).toEqual(["node", "git", "docker", "pnpm"]);
    const bin = fakeBin(["uv"]);
    fs.writeFileSync(path.join(bin, "notexec"), "");
    expect(onPath("uv", { PATH: bin })).toBe(true);
    expect(onPath("notexec", { PATH: bin })).toBe(false);
    expect(onPath("go", { PATH: bin })).toBe(false);
    expect(registriesFor(["node", "uv", "go"], {})).toEqual([
      "https://registry.npmjs.org/",
      "https://pypi.org/simple/",
      "https://proxy.golang.org/",
    ]);
    expect(
      registriesFor(["pnpm", "python3", "go"], {
        npm_config_registry: "http://mirror.local/npm/",
        PIP_INDEX_URL: "http://mirror.local/pypi/",
        GOPROXY: "off",
      }),
    ).toEqual(["http://mirror.local/npm/", "http://mirror.local/pypi/"]);
  });

  it("fails greenfield preflight on a missing toolchain or an unreachable registry, with hints", () => {
    const ws = workspace();
    const p = project(ws);
    patchState(p, { greenfield: true, toolchains: ["uv"], children: { "app/setup": { kind: "setup" } } });
    const probed: string[] = [];
    const report = preflight(ws, "invoices", undefined, {
      env: { PATH: fakeBin(["node", "git"]) },
      probe: (url) => (probed.push(url), url.includes("pypi") ? { ok: false, error: "ENOTFOUND" } : { ok: true }),
    });
    expect(report.ok).toBe(false);
    expect(probed).toEqual(["https://registry.npmjs.org/", "https://pypi.org/simple/"]);
    const text = formatFailure(report);
    expect(text).toMatch(/toolchain docker \(ENOENT\): not found on PATH\. Install docker: .*docs\.docker\.com/);
    expect(text).toMatch(/toolchain uv \(ENOENT\): .*astral\.sh/);
    expect(text).toMatch(/registry https:\/\/pypi\.org\/simple\/ \(UNREACHABLE\): not reachable \(ENOTFOUND\)/);
    expect(report.hint).toMatch(/Install the missing tools/);
    expect(readState(p).preflight?.ok).toBe(false);
    expect(() => patchState(p, { specApproved: true })).toThrow(/Preflight failed/);
    expect(greenfieldChecks({ ...readState(p), greenfield: false })).toEqual([]);
  });
});

describe("continue", () => {
  function finished(): { ws: Workspace; out: string; env: Record<string, string> } {
    const ws = workspace();
    const p = project(ws);
    expect(cli(ws.root, ["repo", "create", "app", "--project", "invoices"]).code).toBe(0);
    const spec = MVP_SPEC().replace(
      "## Per-child requirements",
      "## Layout\n\nMonorepo `app`.\n\n## Stack\n\n| Part | Choice |\n| --- | --- |\n| Services | NestJS |\n\n## Per-child requirements",
    );
    fs.writeFileSync(p.spec, spec);
    fs.mkdirSync(p.contracts, { recursive: true });
    fs.writeFileSync(path.join(p.contracts, "invoices.yaml"), "openapi: 3.1.0\n");
    patchState(p, {
      toolchains: ["pnpm"],
      children: {
        "app/setup": { kind: "setup" },
        "app:invoices": { kind: "service" },
        "app/system": { kind: "system" },
      },
    });
    patchState(p, { status: "done", completionMode: "main" });
    const dir = tmpDir();
    const out = path.join(dir, "launch.json");
    const bin = path.join(dir, "fake-copilot.mjs");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env node\nimport fs from "node:fs";\nfs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ args: process.argv.slice(2) }));\n`,
    );
    fs.chmodSync(bin, 0o755);
    return { ws, out, env: { OPENFLEET_COPILOT_BIN: bin, FAKE_OUT: out } };
  }

  it("starts the next slice seeded from the Follow-ups, reusing repos and stack", () => {
    const { ws, out, env } = finished();
    const r = cli(ws.root, ["continue", "invoices"], env);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const next = projectPaths(ws, "invoices-2");
    const state = readState(next);
    expect(state).toMatchObject({ continuedFrom: "invoices", toolchains: ["pnpm"], status: "specifying" });
    expect(state.greenfield).toBeUndefined();
    const spec = fs.readFileSync(next.spec, "utf8");
    expect(spec).toMatch(/## Layout\n\nMonorepo `app`\./);
    expect(spec).toMatch(/## Stack\n\n\| Part/);
    expect(spec).toMatch(/## Backlog \(Follow-ups of invoices\)\n\n- Recurring invoices\n- Multi-currency/);
    expect(fs.readFileSync(path.join(next.contracts, "invoices.yaml"), "utf8")).toContain("openapi");
    expect(readJson<ReposFile>(ws.reposFile).repos.app?.greenfield).toBe(false);
    expect(readEvents(next).find((e) => e.type === "project.continued")?.payload).toEqual({
      from: "invoices",
      repos: ["app"],
      followUps: 2,
    });
    const prompt = readJson<{ args: string[] }>(out).args.join(" ");
    expect(prompt).toMatch(
      /next slice of `invoices`[\s\S]*Continuing a greenfield project[\s\S]*reuse the repos \(app\)/,
    );
    // The next slice is under the same caps.
    expect(cli(ws.root, ["spec-check", "invoices-2"]).code).toBe(1);
    expect(cli(ws.root, ["continue", "invoices"], env).code).toBe(0);
    expect(readState(projectPaths(ws, "invoices-3")).continuedFrom).toBe("invoices");
    expect(cli(ws.root, ["continue", "invoices", "billing"], env).code).toBe(0);
    expect(buildModel(ws, "invoices-2").origin).toBe("continues invoices");
    expect(buildModel(ws, "invoices").origin).toBe("greenfield");
  });

  it("refuses unfinished, brownfield or Follow-ups-free projects", () => {
    const { ws, env } = finished();
    const p = projectPaths(ws, "invoices");
    patchState(p, { status: "running" });
    expect(cli(ws.root, ["continue", "invoices"], env).stderr).toMatch(/is "running", not "done"/);
    patchState(p, { status: "done" });
    fs.writeFileSync(p.spec, MVP_SPEC(2, "None\n"));
    expect(cli(ws.root, ["continue", "invoices"], env).stderr).toMatch(/lists no Follow-ups/);
    patchState(p, { greenfield: null });
    expect(cli(ws.root, ["continue", "invoices"], env).stderr).toMatch(/not a greenfield project/);
    expect(fs.existsSync(projectPaths(ws, "invoices-2").state)).toBe(false);
  });
});

describe("greenfield demo", () => {
  const SETUP = fileURLToPath(new URL("../../../examples/demo/setup.sh", import.meta.url));

  it("launches the invoice tracker prompt on both hosts", () => {
    const printed = spawnSync("bash", [SETUP, "--host", "claude", "--greenfield"], {
      encoding: "utf8",
      env: { ...process.env, OPENFLEET_DEMO_PRINT_PROMPT: "1" },
    }).stdout.trim();
    expect(printed).toMatch(/^Create an invoice and payment tracking website with microservices and a frontend\./);
    for (const host of ["copilot", "claude"] as const) {
      const ws = workspace();
      const dir = tmpDir();
      const out = path.join(dir, "launch.json");
      const bin = path.join(dir, `fake-${host}.mjs`);
      fs.writeFileSync(
        bin,
        `#!/usr/bin/env node\nimport fs from "node:fs";\nif (process.argv[2] === "--version") { console.log("2.1.280 (Claude Code)"); process.exit(0); }\nfs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ args: process.argv.slice(2) }));\n`,
      );
      fs.chmodSync(bin, 0o755);
      const env = { [host === "claude" ? "OPENFLEET_CLAUDE_BIN" : "OPENFLEET_COPILOT_BIN"]: bin, FAKE_OUT: out };
      const r = cli(ws.root, ["new", "invoices", printed, "--host", host], env);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(readJson<{ args: string[] }>(out).args.join(" ")).toContain(`The user's request: ${printed}`);
      expect(readJson<ReposFile>(ws.reposFile).repos).toEqual({});
    }
  });
});
