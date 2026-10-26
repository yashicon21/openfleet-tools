import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claim, CLAIM_TTL_MS } from "../src/claim.js";
import { readConfig, setConfig } from "../src/config.js";
import { createProject } from "../src/commands/project.js";
import { packageVersion } from "../src/core.js";
import { readEvents } from "../src/events.js";
import { readJson } from "../src/fsutil.js";
import { defaultBranch, globToRegExp, outOfScope, parseChildId, requireChildId } from "../src/groups.js";
import { runHook } from "../src/hooks/handlers.js";
import { schedule, scheduleFor, TOP } from "../src/schedule.js";
import { patchState, readState, type ChildPhase, type ChildState, type ProjectState } from "../src/state.js";
import { findWorkspace, projectPaths, type Workspace } from "../src/workspace.js";
import { gitRepo, sh, tmpDir, workspace } from "./helpers.js";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

function cli(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function json<T = Record<string, unknown>>(r: { code: number | null; stdout: string; stderr: string }): T {
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout) as T;
}

function child(repo: string, phase: ChildPhase = "pending", extra: Partial<ChildState> = {}): ChildState {
  return { repo, phase, dependsOn: [], retries: 0, agentIds: {}, ...extra };
}

/** Builds a normalized state (integration children included) through patchState. */
function stateWith(ws: Workspace, children: Record<string, ChildState>, extra: Partial<ProjectState> = {}) {
  createProject(ws, "p");
  const p = projectPaths(ws, "p");
  patchState(p, { status: "running", ...extra, children });
  return { p, state: () => readState(p) };
}

describe("child ids and scope", () => {
  it("parses repo, package and unit ids", () => {
    expect(parseChildId("web")).toEqual({ repo: "web" });
    expect(parseChildId("web:ui")).toEqual({ repo: "web", package: "ui" });
    expect(parseChildId("web/settings")).toEqual({ repo: "web", unit: "settings" });
    expect(parseChildId("web:ui/button")).toEqual({ repo: "web", package: "ui", unit: "button" });
    expect(parseChildId("web/Settings")).toBeUndefined();
    expect(() => requireChildId("web//x")).toThrow(/Invalid child id/);
  });

  it("derives branches that cannot clash with the integration branch", () => {
    expect(defaultBranch("p", "web")).toBe("openfleet/p");
    expect(defaultBranch("p", "web/settings")).toBe("openfleet/p--web-settings");
    expect(defaultBranch("p", "web:ui/button", "feat/x")).toBe("feat/x--web-ui-button");
  });

  it("matches globs", () => {
    const m = (g: string, f: string) => globToRegExp(g).test(f);
    expect(m("app/settings/**", "app/settings/page.tsx")).toBe(true);
    expect(m("app/settings/**", "app/settings/a/b.tsx")).toBe(true);
    expect(m("app/settings/**", "app/settingsx/page.tsx")).toBe(false);
    expect(m("app/settings", "app/settings/page.tsx")).toBe(true);
    expect(m("app/*/page.tsx", "app/a/page.tsx")).toBe(true);
    expect(m("app/*/page.tsx", "app/a/b/page.tsx")).toBe(false);
    expect(m("**/*.{ts,tsx}", "a/b.tsx")).toBe(true);
    expect(m("lib/?.ts", "lib/a.ts")).toBe(true);
    expect(m("a.b", "aXb")).toBe(false);
  });

  it("finds files outside a child's paths, allowPaths and baseline files", () => {
    const c = child("web", "testing", {
      package: "apps/site",
      paths: ["app/settings/**"],
      allowPaths: ["e2e/fixtures/**"],
      baselineFiles: ["apps/site/e2e/settings.spec.ts"],
    });
    expect(
      outOfScope(c, [
        "apps/site/app/settings/page.tsx",
        "apps/site/e2e/fixtures/user.json",
        "apps/site/e2e/settings.spec.ts",
        "apps/site/app/billing/page.tsx",
        "package.json",
      ]),
    ).toEqual(["apps/site/app/billing/page.tsx", "package.json"]);
    expect(outOfScope(child("web"), ["anything"])).toEqual([]);
  });
});

describe("integration children", () => {
  it("adds one per repo with several children and removes it again while untouched", () => {
    const ws = workspace();
    const { p, state } = stateWith(ws, {
      api: child("api"),
      "web/setup": child("web", "pending", { setup: true }),
      "web/settings": child("web", "pending", { dependsOn: ["web/setup"] }),
    });
    expect(state().children.web).toMatchObject({
      integration: true,
      repo: "web",
      dependsOn: ["web/setup", "web/settings"],
    });
    expect(state().children.api!.integration).toBeUndefined();
    patchState(p, { children: { "web/settings": null } });
    expect(state().children.web).toBeUndefined();
    expect(() => patchState(p, { children: { web: child("web"), "web/a": child("web") } })).toThrow(/reserved/);
  });
});

describe("schedule with repo coordinators", () => {
  function plan(children: Record<string, ChildState>, extra: Partial<ProjectState> = {}): ProjectState {
    const ws = workspace();
    return stateWith(ws, children, extra).state();
  }

  it("delegates a grouped repo to its repo coordinator and plans everything first", () => {
    const s = plan({
      api: child("api"),
      "web/setup": child("web", "pending", { setup: true }),
      "web/a": child("web", "pending", { dependsOn: ["web/setup", "api"] }),
    });
    const top = scheduleFor(s, TOP);
    expect(top.actions).toEqual(
      expect.arrayContaining([
        { owner: TOP, action: "repo-coordinator", repo: "web" },
        { owner: TOP, action: "plan", child: "api" },
      ]),
    );
    expect(top.actions.some((a) => "child" in a && a.child === "web/a")).toBe(false);
    expect(scheduleFor(s, "web").actions).toEqual([
      { owner: "web", action: "plan", child: "web/setup" },
      { owner: "web", action: "plan", child: "web/a" },
    ]);
  });

  it("runs the repo check before the top check, then honours repo- and child-level dependsOn", () => {
    const planned = (repo: string, extra: Partial<ChildState> = {}) =>
      child(repo, "planned", { consistent: true, ...extra });
    let s = plan({
      api: child("api", "planned"),
      "web/setup": child("web", "planned", { setup: true }),
      "web/a": child("web", "planned", { dependsOn: ["web/setup"] }),
      sdk: child("sdk", "planned", { dependsOn: ["web"] }),
      docs: child("docs", "planned", { dependsOn: ["web/a"] }),
    });
    expect(scheduleFor(s, "web").actions).toEqual([
      { owner: "web", action: "check-repo-consistency", repo: "web", children: ["web/setup", "web/a"] },
    ]);
    expect(scheduleFor(s, TOP).actions.find((a) => a.action === "check-consistency")).toBeUndefined();

    s = plan(
      {
        api: planned("api"),
        "web/setup": planned("web", { setup: true, repoConsistent: true }),
        "web/a": planned("web", { dependsOn: ["web/setup"], repoConsistent: true }),
        sdk: planned("sdk", { dependsOn: ["web"] }),
        docs: planned("docs", { dependsOn: ["web/a"] }),
      },
      { plansReady: true },
    );
    const all = schedule(s);
    const implement = (a: { action: string }) => a.action === "implement";
    expect(all.actions.filter(implement)).toEqual([
      { owner: TOP, action: "implement", child: "api" },
      { owner: "web", action: "implement", child: "web/setup" },
    ]);
    expect(all.waiting).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ child: "sdk", reason: expect.stringContaining("web") as string }),
        expect.objectContaining({ child: "docs", reason: expect.stringContaining("web/a") as string }),
      ]),
    );
  });

  it("merges the setup child first, then in done order, and waits for merged siblings", () => {
    const done = (at: string, extra: Partial<ChildState> = {}) =>
      child("web", "done", { consistent: true, repoConsistent: true, doneAt: at, ...extra });
    let s = plan(
      {
        "web/setup": child("web", "testing", { setup: true, consistent: true, repoConsistent: true }),
        "web/b": done("2024-01-02T00:00:00Z", { dependsOn: ["web/setup"] }),
        "web/a": done("2024-01-01T00:00:00Z", { dependsOn: ["web/setup"] }),
      },
      { plansReady: true },
    );
    expect(scheduleFor(s, "web").actions.find((a) => a.action === "merge")).toBeUndefined();
    s = plan(
      {
        "web/setup": done("2024-01-03T00:00:00Z", { setup: true }),
        "web/b": done("2024-01-02T00:00:00Z", { dependsOn: ["web/setup"] }),
        "web/a": done("2024-01-01T00:00:00Z", { dependsOn: ["web/setup"] }),
        "web/c": child("web", "planned", { consistent: true, repoConsistent: true, dependsOn: ["web/a"] }),
      },
      { plansReady: true },
    );
    // Core stamps doneAt when a child becomes done; set the order explicitly.
    s.children["web/a"]!.doneAt = "2024-01-01T00:00:00Z";
    s.children["web/b"]!.doneAt = "2024-01-02T00:00:00Z";
    expect(scheduleFor(s, "web").actions).toContainEqual({
      owner: "web",
      action: "merge",
      child: "web/setup",
      into: "web",
    });
    expect(scheduleFor(s, "web").actions.some((a) => a.action === "implement")).toBe(false);
    s.children["web/setup"]!.merged = true;
    expect(scheduleFor(s, "web").actions).toContainEqual({
      owner: "web",
      action: "merge",
      child: "web/a",
      into: "web",
    });
    s.children["web/a"]!.merged = true;
    const next = scheduleFor(s, "web").actions;
    expect(next).toContainEqual({ owner: "web", action: "merge", child: "web/b", into: "web" });
    expect(next).toContainEqual({ owner: "web", action: "implement", child: "web/c" });
  });

  it("integrates once every member is merged, and blocks dependents of a failed repo", () => {
    const merged = (extra: Partial<ChildState> = {}) =>
      child("web", "done", { consistent: true, repoConsistent: true, merged: true, ...extra });
    const s = plan(
      {
        "web/setup": merged({ setup: true }),
        "web/a": merged({ dependsOn: ["web/setup"] }),
        sdk: child("sdk", "planned", { consistent: true, dependsOn: ["web"] }),
      },
      { plansReady: true },
    );
    expect(scheduleFor(s, "web").actions).toContainEqual({ owner: "web", action: "integrate", child: "web" });
    s.children.web!.phase = "failed";
    expect(schedule(s).actions).toContainEqual({ owner: TOP, action: "block", child: "sdk", dependency: "web" });
  });

  it("keeps an escalated child open without blocking its dependents", () => {
    const s = plan(
      {
        "web/setup": child("web", "planned", { setup: true, consistent: true, repoConsistent: true }),
        "web/a": child("web", "planned", { consistent: true, repoConsistent: true, dependsOn: ["web/setup"] }),
      },
      { plansReady: true },
    );
    s.children["web/setup"] = {
      ...s.children["web/setup"]!,
      phase: "blocked",
      blockedReason: "needs-escalation",
      escalation: { question: "Rename the token field?", phase: "implementing", at: "2024-01-01T00:00:00Z" },
    };
    const out = schedule(s);
    expect(out.actions.some((a) => a.action === "block" || a.action === "finalize")).toBe(false);
    expect(out.waiting).toContainEqual(expect.objectContaining({ child: "web/setup", owner: TOP }));
  });
});

describe("claim", () => {
  function setup(maxParallel?: number) {
    const ws = workspace();
    const ids = ["a", "b", "c", "d"];
    if (maxParallel) setConfig(ws, "maxParallel", String(maxParallel));
    const { p, state } = stateWith(ws, Object.fromEntries(ids.map((id) => [id, child(id)])));
    return { ws, p, state };
  }

  it("sets the phase and pendingSpawn, and waits for an unconsumed claim of the same role", () => {
    const { ws, p, state } = setup();
    expect(claim(ws, "p", "a", "planner")).toMatchObject({
      result: "claimed",
      phase: "planning",
      busy: 1,
      maxParallel: 6,
    });
    expect(state().children.a).toMatchObject({ phase: "planning", pendingSpawn: "planner" });
    expect(claim(ws, "p", "b", "planner")).toMatchObject({
      result: "wait",
      reason: expect.stringContaining("p/a") as string,
    });
    expect(claim(ws, "p", "b", "tester")).toMatchObject({ result: "claimed", phase: "testing" });

    // The hook consumes the claim, so the next planner can be claimed and is attributed correctly.
    const env = { OPENFLEET_WORKSPACE: ws.root, OPENFLEET_PROJECT: "p" };
    runHook("subagentStart", { agentName: "openfleet:openfleet-planner" }, env);
    expect(state().children.a!.pendingSpawn).toBeUndefined();
    expect(claim(ws, "p", "c", "planner")).toMatchObject({ result: "claimed" });
    runHook("subagentStart", { agentName: "openfleet:openfleet-planner" }, env);
    runHook("subagentStart", { agentName: "openfleet:openfleet-tester" }, env);
    expect(state().children.c).toMatchObject({ role: "planner" });
    expect(state().children.b).toMatchObject({ role: "tester" });
    expect(state().children.c!.pendingSpawn).toBeUndefined();

    // A stale claim (spawn never happened) does not block.
    patchState(p, {
      children: {
        d: { pendingSpawn: "implementer", claimedAt: new Date(Date.now() - CLAIM_TTL_MS - 1000).toISOString() },
      },
    });
    expect(claim(ws, "p", "a", "implementer")).toMatchObject({ result: "claimed" });
  });

  it("enforces the workspace maxParallel across projects; repo coordinators do not count", () => {
    const { ws, state } = setup(2);
    expect(claim(ws, "p", "a", "planner").result).toBe("claimed");
    expect(claim(ws, "p", "b", "tester").result).toBe("claimed");
    const wait = claim(ws, "p", "c", "implementer");
    expect(wait).toMatchObject({ result: "wait", retryAfterSeconds: 5 });
    expect(state().children.c!.phase).toBe("pending");

    createProject(ws, "q");
    const q = projectPaths(ws, "q");
    patchState(q, { status: "running", children: { x: child("x") } });
    expect(claim(ws, "q", "x", "baseline").result).toBe("wait");
    patchState(projectPaths(ws, "p"), { children: { a: { phase: "planned", pendingSpawn: null } } });
    expect(claim(ws, "q", "x", "baseline")).toMatchObject({ result: "claimed", busy: 2, maxParallel: 2 });
  });

  it("allows repo coordinators only on integration children and rejects bad roles", () => {
    const ws = workspace();
    setConfig(ws, "maxParallel", "1");
    stateWith(ws, { "web/a": child("web"), "web/b": child("web") });
    expect(() => claim(ws, "p", "web/a", "repo-coordinator")).toThrow(/integration child/);
    expect(() => claim(ws, "p", "web", "planner")).toThrow(/no planner/);
    expect(() => claim(ws, "p", "web/a", "boss")).toThrow(/Unknown role/);
    expect(claim(ws, "p", "web/a", "planner").result).toBe("claimed");
    expect(claim(ws, "p", "web", "repo-coordinator")).toMatchObject({ result: "claimed", phase: "pending" });
  });

  it("records agent ids at start so parallel planners' stops are attributed exactly", () => {
    const { ws, p, state } = setup();
    const env = { OPENFLEET_WORKSPACE: ws.root, OPENFLEET_PROJECT: "p" };
    const ids = ["a", "b", "c", "d"];
    for (const id of ids) {
      expect(claim(ws, "p", id, "planner").result).toBe("claimed");
      runHook("subagentStart", { agentName: "openfleet:openfleet-planner", agentId: `planner-${id}` }, env);
    }
    for (const id of ids) expect(state().children[id]!.agentIds).toEqual({ planner: `planner-${id}` });
    for (const id of ["c", "a", "d", "b"]) {
      runHook("subagentStop", { agentName: "openfleet:openfleet-planner", agentId: `planner-${id}` }, env);
    }
    const events = readEvents(p);
    const spawned = events.filter((e) => e.type === "agent.spawned");
    expect(spawned.map((e) => [e.target, e.payload.agentId])).toEqual(ids.map((id) => [id, `planner-${id}`]));
    const stopped = events.filter((e) => e.type === "agent.stopped");
    expect(stopped.map((e) => [e.actor, e.target, e.payload.agentId])).toEqual(
      ["c", "a", "d", "b"].map((id) => [`${id}/planner`, id, `planner-${id}`]),
    );
  });

  it("binds the agent id from an ack command", () => {
    const { ws, state } = setup();
    const env = { OPENFLEET_WORKSPACE: ws.root, OPENFLEET_PROJECT: "p" };
    runHook(
      "postToolUse",
      { agentId: "agent-7", toolName: "bash", toolArgs: { command: "npx openfleet ack p b implementer" } },
      env,
    );
    expect(state().children.b!.agentIds).toEqual({ implementer: "agent-7" });
  });
});

describe("repo coordinator flow (CLI)", () => {
  function setup() {
    const root = tmpDir();
    const web = gitRepo(path.join(root, "web"), {
      "lib/ui.ts": "export const ui = 1;\n",
      "app/a/page.tsx": "a\n",
      "app/b/page.tsx": "b\n",
      "shared.txt": "base\n",
    });
    expect(cli(root, ["init"]).code).toBe(0);
    fs.writeFileSync(
      path.join(root, "repos.json"),
      JSON.stringify({ v: 1, repos: { web: { path: web, defaultBranch: "main" } } }),
    );
    const fake = path.join(root, "fake.mjs");
    fs.writeFileSync(
      fake,
      `#!/usr/bin/env node\nimport fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(path.join(root, "launch.json"))}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    fs.chmodSync(fake, 0o755);
    const env = { OPENFLEET_COPILOT_BIN: fake };
    expect(cli(root, ["new", "p"], env).code).toBe(0);
    const state = () => readJson<ProjectState>(path.join(root, "projects/p/state.json"));
    const patch = (obj: unknown) => expect(cli(root, ["state", "p", "--patch", JSON.stringify(obj)]).code).toBe(0);
    patch({
      status: "running",
      children: {
        "web/setup": { repo: "web", setup: true, paths: ["lib/**"] },
        "web/a": { repo: "web", paths: ["app/a/**"], dependsOn: ["web/setup"] },
        "web/b": { repo: "web", paths: ["app/b/**"], dependsOn: ["web/setup"] },
      },
    });
    for (const id of ["web", "web/setup", "web/a", "web/b"]) expect(cli(root, ["worktree", "p", id]).code).toBe(0);
    return { root, web, env, state, patch };
  }

  it("creates worktrees with derived branches and reports scope violations", () => {
    const { root, state } = setup();
    expect(state().children.web).toMatchObject({ integration: true, branch: "openfleet/p" });
    expect(state().children["web/a"]).toMatchObject({ branch: "openfleet/p--web-a" });
    expect(cli(root, ["worktree", "p", "web/x", "--branch", "openfleet/p/x"]).stderr).toMatch(/clashes/);

    const wt = state().children["web/a"]!.worktree!;
    fs.writeFileSync(path.join(wt, "app/a/page.tsx"), "A\n");
    fs.writeFileSync(path.join(wt, "shared.txt"), "changed\n");
    expect(json(cli(root, ["scope", "p", "web/a", "--check"]))).toMatchObject({
      scoped: true,
      scope: ["app/a/**"],
      changed: ["app/a/page.tsx", "shared.txt"],
      outside: ["shared.txt"],
      ok: false,
    });
  });

  it("merges setup first, rebases a conflicting child, and groups status", () => {
    const { root, web, state, patch } = setup();
    const wt = (id: string) => state().children[id]!.worktree!;
    const p = projectPaths(findWorkspace(root)!, "p");

    fs.writeFileSync(path.join(wt("web/setup"), "lib/ui.ts"), "export const ui = 2;\n");
    fs.writeFileSync(path.join(wt("web/a"), "app/a/page.tsx"), "A\n");
    fs.writeFileSync(path.join(wt("web/a"), "shared.txt"), "from a\n");
    fs.writeFileSync(path.join(wt("web/b"), "shared.txt"), "from b\n");
    fs.writeFileSync(path.join(wt("web/b"), "app/b/page.tsx"), "B\n");
    patch({ children: { "web/setup": { phase: "done" }, "web/a": { phase: "done" }, "web/b": { phase: "done" } } });

    expect(cli(root, ["merge", "p", "web/a"]).stderr).toMatch(/setup child web\/setup first/);
    expect(json(cli(root, ["merge", "p", "web/setup"]))).toMatchObject({ result: "merged", into: "openfleet/p" });
    expect(json(cli(root, ["merge", "p", "web/a"]))).toMatchObject({ result: "merged" });
    expect(fs.readFileSync(path.join(wt("web"), "shared.txt"), "utf8")).toBe("from a\n");

    const conflict = json(cli(root, ["merge", "p", "web/b"]));
    expect(conflict).toMatchObject({
      result: "conflict",
      files: ["shared.txt"],
      outside: ["shared.txt"],
      phase: "planned",
    });
    expect(state().children["web/b"]).toMatchObject({
      phase: "planned",
      conflict: { files: ["shared.txt"], outside: ["shared.txt"], onto: "openfleet/p" },
    });
    expect(state().children["web/b"]!.merged).toBeUndefined();
    const ev = readEvents(p).filter((e) => e.type === "child.merged" || e.type === "merge.conflict");
    expect(ev.map((e) => [e.type, e.target])).toEqual([
      ["child.merged", "web/setup"],
      ["child.merged", "web/a"],
      ["merge.conflict", "web/b"],
    ]);
    expect(ev[2]!.payload).toMatchObject({ scopeViolation: true });

    // The implementer resolves the conflict (keeping the integration version), then it merges cleanly.
    fs.writeFileSync(path.join(wt("web/b"), "shared.txt"), "from a\n");
    patch({ children: { "web/b": { phase: "done" } } });
    expect(json(cli(root, ["merge", "p", "web/b"]))).toMatchObject({ result: "merged" });
    expect(sh(web, "git", ["log", "--oneline", "openfleet/p"])).toContain("openfleet(p): web/b");
    expect(sh(web, "git", ["show", "openfleet/p:app/b/page.tsx"])).toBe("B\n");
    expect(sh(web, "git", ["show", "openfleet/p:shared.txt"])).toBe("from a\n");

    const status = cli(root, ["status", "p"]).stdout;
    expect(status).toMatch(/^web\s+pending\s+repo-coordinator \(not started\)/m);
    expect(status).toMatch(/^ {2}web\/a\s+done, merged/m);
  });

  it("syncs a member onto the integration branch when its implementer is claimed", () => {
    const { root, state, patch } = setup();
    const wt = (id: string) => state().children[id]!.worktree!;
    fs.writeFileSync(path.join(wt("web/setup"), "lib/ui.ts"), "export const ui = 2;\n");
    patch({ children: { "web/setup": { phase: "done" }, "web/a": { phase: "planned" } } });
    json(cli(root, ["merge", "p", "web/setup"]));
    const out = json<{ result: string; synced?: string }>(cli(root, ["claim", "p", "web/a", "implementer"]));
    expect(out.result).toBe("claimed");
    expect(out.synced).toBeTruthy();
    expect(fs.readFileSync(path.join(wt("web/a"), "lib/ui.ts"), "utf8")).toContain("ui = 2");
    expect(state().children["web/a"]).toMatchObject({ phase: "implementing", baseSha: out.synced });
  });

  it("escalates and resolves a question", () => {
    const { root, state, patch } = setup();
    patch({ children: { "web/a": { phase: "implementing" } } });
    expect(json(cli(root, ["escalate", "p", "web/a", "--question", "Change the token shape?"]))).toMatchObject({
      phase: "blocked",
      blockedReason: "needs-escalation",
    });
    expect(
      json<{ actions: { action: string }[] }>(cli(root, ["next", "p"])).actions.some((a) => a.action === "block"),
    ).toBe(false);
    expect(cli(root, ["escalate", "p", "web/b", "--resolve", "--decision", "x"]).stderr).toMatch(/no open escalation/);
    json(cli(root, ["escalate", "p", "web/a", "--resolve", "--decision", "Keep it"]));
    expect(state().children["web/a"]).toMatchObject({ phase: "planned", decisions: ["Keep it"] });
    expect(state().children["web/a"]!.blockedReason).toBeUndefined();
    const types = readEvents(projectPaths(findWorkspace(root)!, "p")).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["question.escalated", "question.answered"]));
  });

  it("resume restarts repo coordinators; clean removes child and integration worktrees and branches", () => {
    const { root, web, env, state, patch } = setup();
    patch({ children: { web: { coordinator: "running" }, "web/a": { pendingSpawn: "planner" } } });
    expect(cli(root, ["resume", "p"], env).code).toBe(0);
    expect(state().children.web!.coordinator).toBe("stopped");
    expect(state().children["web/a"]!.pendingSpawn).toBeUndefined();
    expect(fs.readFileSync(path.join(root, "launch.json"), "utf8")).toContain("Start the repo coordinators again");
    expect(json<{ actions: unknown[] }>(cli(root, ["next", "p"])).actions).toEqual([
      { owner: "top", action: "preflight", reason: "stale" },
    ]);
    expect(cli(root, ["preflight", "p"]).code).toBe(0);
    expect(json<{ actions: unknown[] }>(cli(root, ["next", "p"])).actions).toContainEqual({
      owner: "top",
      action: "repo-coordinator",
      repo: "web",
    });

    const worktrees = ["web", "web/setup", "web/a", "web/b"].map((id) => state().children[id]!.worktree!);
    expect(cli(root, ["clean", "p", "--branches"]).code).toBe(0);
    for (const w of worktrees) expect(fs.existsSync(w)).toBe(false);
    expect(sh(web, "git", ["branch", "--list", "openfleet/*"]).trim()).toBe("");
  });
});

describe("workspace config", () => {
  it("defaults maxParallel to 6, and config set validates and writes it into openfleet.json", () => {
    const ws = workspace();
    const file = ws.marker;
    const version = packageVersion();
    expect(readJson(file)).toEqual({ version, maxParallel: 6, host: "copilot" });
    fs.writeFileSync(file, JSON.stringify({ version }));
    expect(readConfig(ws)).toEqual({ maxParallel: 6, host: "copilot" });
    expect(json(cli(ws.root, ["config"]))).toEqual({ maxParallel: 6, host: "copilot" });
    expect(json(cli(ws.root, ["config", "set", "maxParallel", "3"]))).toEqual({ maxParallel: 3, host: "copilot" });
    expect(readJson(file)).toEqual({ version, maxParallel: 3 });
    expect(cli(ws.root, ["config", "set", "version", "9.9.9"]).stderr).toMatch(/Unknown config key/);
    expect(cli(ws.root, ["config", "set", "maxParallel", "0"]).stderr).toMatch(/positive integer/);
    expect(cli(ws.root, ["config", "set", "maxParalel", "2"]).stderr).toMatch(/Unknown config key/);
    expect(cli(ws.root, ["config", "get"]).stderr).toMatch(/Usage/);
    fs.writeFileSync(file, JSON.stringify({ maxParallel: 2, other: 1 }));
    expect(() => readConfig(ws)).toThrow(/unknown key/);
  });

  it("config set host accepts copilot or claude and rejects anything else", () => {
    const ws = workspace();
    const file = ws.marker;
    expect(readConfig(ws).host).toBe("copilot");
    expect(json(cli(ws.root, ["config", "set", "host", "claude"]))).toEqual({ maxParallel: 6, host: "claude" });
    expect(readJson(file)).toEqual({ version: packageVersion(), maxParallel: 6, host: "claude" });
    const bad = cli(ws.root, ["config", "set", "host", "other"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/host must be one of copilot, claude/);
    fs.writeFileSync(file, JSON.stringify({ host: "nope" }));
    expect(() => readConfig(ws)).toThrow(/host must be one of/);
  });
});

describe("state helpers", () => {
  it("keeps escalated children active and records doneAt", () => {
    const ws = workspace();
    const { p, state } = stateWith(ws, { api: child("api", "testing") });
    expect(() => patchState(p, { maxParallel: 2 })).toThrow(/config set maxParallel/);
    patchState(p, { children: { api: { phase: "done" } } });
    expect(state().children.api!.doneAt).toBeTruthy();
  });
});
