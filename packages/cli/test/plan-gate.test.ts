import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/commands/project.js";
import { baselineChanges } from "../src/commands/run.js";
import { checkCopyPath, copyIntoWorktree, secretValues } from "../src/copyfiles.js";
import { appendEvent, EVENT_TYPES, readEvents } from "../src/events.js";
import { BLOCKING_SLOTS, CHILD_SLOTS, SLOTS } from "../src/extensions.js";
import { addWorktree, headSha, snapshotWorktree } from "../src/git.js";
import { runHook, runtimeContext } from "../src/hooks/handlers.js";
import { schedule as fullSchedule } from "../src/schedule.js";
import {
  newState,
  patchState,
  PORT_BASE,
  PORT_STEP,
  readState,
  type ChildPhase,
  type ChildState,
  type ProjectState,
} from "../src/state.js";
import { projectPaths } from "../src/workspace.js";
import { gitRepo, sh, tmpDir, workspace } from "./helpers.js";

function child(phase: ChildPhase, extra: Partial<ChildState> = {}): ChildState {
  return { repo: "r", phase, dependsOn: [], retries: 0, agentIds: {}, ...extra };
}

function stateOf(children: Record<string, ChildState>, extra: Partial<ProjectState> = {}): ProjectState {
  return { ...newState("p"), status: "running", children, ...extra };
}

/** The single-repo scheduling tests predate `owner`; strip it (it is always "top" here). */
function schedule(state: ProjectState) {
  const s = fullSchedule(state);
  const strip = <T extends { owner?: string }>(x: T) => {
    const rest = { ...x };
    delete rest.owner;
    return rest;
  };
  return { ...s, actions: s.actions.map(strip), waiting: s.waiting.map(strip) };
}

describe("schedule", () => {
  it("plans every child first, ignoring dependsOn", () => {
    const s = schedule(
      stateOf({ lib: child("pending"), app: child("pending", { dependsOn: ["lib"] }), web: child("planning") }),
    );
    expect(s.gate).toBe("planning");
    expect(s.actions).toEqual([
      { action: "plan", child: "lib" },
      { action: "plan", child: "app" },
    ]);
    expect(s.waiting).toEqual([{ child: "web", reason: "planner running" }]);
  });

  it("waits for every plan before the consistency check", () => {
    const s = schedule(stateOf({ lib: child("planned"), app: child("plan-review", { dependsOn: ["lib"] }) }));
    expect(s.actions).toEqual([]);
    expect(s.waiting).toContainEqual({ child: "lib", reason: "other plans (consistency check)" });
  });

  it("checks consistency once all plans are validated, then asks for the plans-ready gate", () => {
    const checking = schedule(stateOf({ lib: child("planned"), app: child("planned", { consistent: true }) }));
    expect(checking).toMatchObject({ gate: "checking", actions: [{ action: "check-consistency", children: ["lib"] }] });

    const ready = schedule(
      stateOf({ lib: child("planned", { consistent: true }), app: child("planned", { consistent: true }) }),
    );
    expect(ready.gate).toBe("plans-ready");
    expect(ready.actions).toEqual([{ action: "plans-ready" }]);
    expect(ready.waiting.map((w) => w.reason)).toEqual(["plans-ready gate", "plans-ready gate"]);
  });

  it("after the gate runs baselines first, then implements in dependency order", () => {
    const s = stateOf(
      {
        lib: child("planned", { consistent: true }),
        app: child("planned", { consistent: true, dependsOn: ["lib"] }),
        web: child("planned", { consistent: true, baseline: true }),
        ui: child("planned", { consistent: true, baseline: true, baselinePassed: true }),
      },
      { plansReady: true },
    );
    const out = schedule(s);
    expect(out.gate).toBe("open");
    expect(out.actions).toEqual([
      { action: "implement", child: "lib" },
      { action: "baseline", child: "web" },
      { action: "implement", child: "ui" },
    ]);
    expect(out.waiting).toEqual([{ child: "app", reason: "dependencies: lib" }]);

    s.children.lib!.phase = "done";
    expect(schedule(s).actions).toContainEqual({ action: "implement", child: "app" });
  });

  it("re-checks a re-planned child after the gate without closing it", () => {
    const s = stateOf(
      { lib: child("implementing", { consistent: true }), app: child("planned", { dependsOn: ["lib"] }) },
      { plansReady: true },
    );
    expect(schedule(s)).toMatchObject({ gate: "open", actions: [{ action: "check-consistency", children: ["app"] }] });
  });

  it("blocks dependents of failed children and finalizes when everything finished", () => {
    const s = stateOf(
      { lib: child("failed"), app: child("planned", { consistent: true, dependsOn: ["lib"] }), ui: child("done") },
      { plansReady: true },
    );
    expect(schedule(s).actions).toEqual([{ action: "block", child: "app", dependency: "lib" }]);
    s.children.app!.phase = "blocked";
    expect(schedule(s).actions).toEqual([{ action: "finalize" }]);
  });

  it("does not open the gate while a failed child's dependents still need blocking", () => {
    const s = stateOf({ lib: child("failed"), app: child("planned", { consistent: true, dependsOn: ["lib"] }) });
    expect(schedule(s).actions).toEqual([{ action: "block", child: "app", dependency: "lib" }]);
  });
});

describe("state", () => {
  it("gives each child a unique, stable port range", () => {
    const ws = workspace();
    createProject(ws, "demo");
    const p = projectPaths(ws, "demo");
    patchState(p, { children: { a: child("pending", { repo: "a" }), b: child("pending", { repo: "b" }) } });
    patchState(p, { children: { c: child("pending", { repo: "c" }) } });
    const ports = () => Object.fromEntries(Object.entries(readState(p).children).map(([id, c]) => [id, c.portBase]));
    expect(ports()).toEqual({ a: PORT_BASE, b: PORT_BASE + PORT_STEP, c: PORT_BASE + 2 * PORT_STEP });
    patchState(p, { children: { b: null } });
    patchState(p, { children: { d: child("pending", { repo: "d" }), a: { phase: "planning" } } });
    expect(ports()).toEqual({ a: PORT_BASE, c: PORT_BASE + 2 * PORT_STEP, d: PORT_BASE + PORT_STEP });
  });

  it("clears consistent when a child is re-planned", () => {
    const ws = workspace();
    createProject(ws, "demo");
    const p = projectPaths(ws, "demo");
    patchState(p, { children: { a: child("planned", { consistent: true }) } });
    patchState(p, { children: { a: { phase: "implementing" } } });
    expect(readState(p).children.a!.consistent).toBe(true);
    patchState(p, { children: { a: { phase: "plan-review" } } });
    expect(readState(p).children.a!.consistent).toBeUndefined();
  });

  it("knows the new events and slots", () => {
    expect(EVENT_TYPES).toEqual(expect.arrayContaining(["plans.consistent", "baseline.passed"]));
    expect(SLOTS).toEqual(["pre-spec", "post-plan", "plans-ready", "pre-implement", "post-test", "post-run"]);
    expect(CHILD_SLOTS).toEqual(["post-plan", "pre-implement", "post-test"]);
    expect([...BLOCKING_SLOTS].sort()).toEqual(["plans-ready", "post-plan", "post-test", "pre-implement"]);
  });
});

describe("copyFiles", () => {
  function setup() {
    const tmp = tmpDir();
    const repo = gitRepo(path.join(tmp, "app"), {
      ".gitignore": ".env.local\n",
      "config/dev.json": '{ "apiKey": "tracked-placeholder" }\n',
      "src/a.ts": "export const a = 1;\n",
    });
    fs.writeFileSync(path.join(repo, ".env.local"), "AUTH_SECRET=super-secret-value-123\nDEBUG=true\nPORT=3000\n");
    fs.mkdirSync(path.join(repo, "secrets"));
    fs.writeFileSync(path.join(repo, "secrets/creds.env"), "TOKEN='another-secret-token'\n");
    fs.writeFileSync(path.join(repo, "config/dev.json"), '{ "apiKey": "real-local-api-key" }\n');
    const worktree = path.join(tmp, "wt");
    addWorktree(repo, worktree, "openfleet/x", "main");
    return { tmp, repo, worktree };
  }

  it("validates paths", () => {
    expect(checkCopyPath(".env.local")).toEqual({ rel: ".env.local" });
    expect(checkCopyPath("./a/b.env")).toEqual({ rel: "a/b.env" });
    for (const bad of ["/etc/passwd", "../x", "a/../../x", ".git/config", "", 3]) {
      expect(checkCopyPath(bad), String(bad)).toHaveProperty("error");
    }
  });

  it("copies files, warns about missing ones and keeps them out of git", () => {
    const { repo, worktree } = setup();
    const r = copyIntoWorktree(repo, worktree, [
      ".env.local",
      "secrets/creds.env",
      "config/dev.json",
      "missing.env",
      "../escape",
    ]);
    expect(r.copied).toEqual([".env.local", "secrets/creds.env", "config/dev.json"]);
    expect(r.missing).toEqual(["missing.env"]);
    expect(r.invalid).toHaveLength(1);
    expect(fs.readFileSync(path.join(worktree, "secrets/creds.env"), "utf8")).toContain("another-secret-token");
    expect(fs.readFileSync(path.join(worktree, "config/dev.json"), "utf8")).toContain("real-local-api-key");

    fs.writeFileSync(path.join(worktree, "src/a.ts"), "export const a = 2;\n");
    expect(sh(worktree, "git", ["status", "--porcelain"]).trim()).toBe("M src/a.ts");
    sh(worktree, "git", ["add", "-A"]);
    expect(sh(worktree, "git", ["diff", "--cached", "--name-only"]).trim()).toBe("src/a.ts");

    const snap = snapshotWorktree(worktree, headSha(worktree), r.copied);
    expect(snap.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(snap.patch).not.toMatch(/secret|real-local-api-key/);

    // Re-running refreshes copies and does not duplicate exclude entries.
    fs.writeFileSync(path.join(repo, ".env.local"), "AUTH_SECRET=rotated-secret-value\n");
    copyIntoWorktree(repo, worktree, [".env.local", "secrets/creds.env"]);
    expect(fs.readFileSync(path.join(worktree, ".env.local"), "utf8")).toContain("rotated-secret-value");
    const exclude = fs.readFileSync(path.join(repo, ".git/info/exclude"), "utf8");
    expect(exclude.match(/\/secrets\/creds\.env/g)).toHaveLength(1);
  });

  it("extracts secret values but not booleans, numbers or short values", () => {
    expect(
      secretValues(
        [
          "AUTH_SECRET=super-secret-value-123",
          "export TOKEN='quoted-token-value'",
          "DEBUG=true",
          "PORT=3000",
          "X=abc",
          "# comment=ignored-comment",
          'api_key: "yaml-api-key-value"',
          '  "clientSecret": "json-client-secret",',
        ].join("\n"),
      ).sort(),
    ).toEqual(["json-client-secret", "quoted-token-value", "super-secret-value-123", "yaml-api-key-value"]);
  });

  it("redacts copied secret values from events and patches", () => {
    const { repo, worktree } = setup();
    const ws = workspace({ app: { path: repo } });
    createProject(ws, "demo");
    const p = projectPaths(ws, "demo");
    const r = copyIntoWorktree(repo, worktree, [".env.local", "secrets/creds.env"]);
    patchState(p, { children: { app: child("implementing", { worktree, copiedFiles: r.copied }) } });
    const e = appendEvent(p, {
      type: "test.run",
      actor: "openfleet-tester",
      payload: { summary: "token another-secret-token and super-secret-value-123 leaked" },
      patch: "+AUTH_SECRET=super-secret-value-123\n",
    });
    expect(JSON.stringify(e.payload)).not.toMatch(/another-secret-token|super-secret-value-123/);
    const patch = fs.readFileSync(path.join(p.dir, e.payload.patch as string), "utf8");
    expect(patch).not.toContain("super-secret-value-123");
    expect(patch).toContain("[REDACTED]");
  });

  it("does not record patches for copied files in hooks and excludes them from snapshots", () => {
    const { repo, worktree } = setup();
    const ws = workspace({ app: { path: repo } });
    createProject(ws, "demo");
    const p = projectPaths(ws, "demo");
    const r = copyIntoWorktree(repo, worktree, [".env.local"]);
    patchState(p, {
      status: "running",
      children: {
        app: child("implementing", { worktree, repoPath: repo, baseSha: headSha(worktree), copiedFiles: r.copied }),
      },
    });
    const env = { OPENFLEET_WORKSPACE: ws.root, OPENFLEET_PROJECT: "demo" };
    fs.writeFileSync(path.join(worktree, ".env.local"), "AUTH_SECRET=edited-secret-value\n");
    runHook(
      "postToolUse",
      { cwd: worktree, toolName: "edit", toolArgs: { path: ".env.local", old_str: "a", new_str: "b" } },
      env,
    );
    const edit = readEvents(p).find((e) => e.type === "file.edited")!;
    expect(edit.payload).toMatchObject({ path: ".env.local", copiedFile: true });
    expect(edit.payload.patch).toBeUndefined();

    fs.writeFileSync(path.join(worktree, "src/a.ts"), "export const a = 9;\n");
    runHook("subagentStop", { agentName: "openfleet:openfleet-implementer", agentId: "i1", response: "ok" }, env);
    const snap = readEvents(p).find((e) => e.type === "worktree.snapshot")!;
    expect((snap.payload.files as { path: string }[]).map((f) => f.path)).toEqual(["src/a.ts"]);
  });
});

describe("spawn context", () => {
  it("injects ports, local files and protected baseline tests by role", () => {
    const c = child("implementing", {
      portBase: 4120,
      copiedFiles: [".env.local"],
      baselineFiles: ["e2e/login.spec.ts"],
      baselineCover: "sign-in and sign-out",
    });
    const impl = runtimeContext("demo", "web", c, "implementer");
    expect(impl).toContain("## Ports");
    expect(impl).toContain("PORT=4120 OPENFLEET_PORT_BASE=4120");
    expect(impl).toContain("4120–4129");
    expect(impl).toContain("reuseExistingServer: false");
    expect(impl).toContain("## Local files (never commit, never print)");
    expect(impl).toContain("- `.env.local`");
    expect(impl).toContain("## Baseline tests (protected)");
    expect(impl).toContain("npx openfleet baseline demo web --check");

    const baseline = runtimeContext("demo", "web", c, "baseline");
    expect(baseline).toContain("## Ports");
    expect(baseline).toContain("Cover: sign-in and sign-out");
    expect(baseline).not.toContain("Baseline tests (protected)");

    const tester = runtimeContext("demo", "web", c, "tester");
    expect(tester).toContain("Baseline tests (protected)");

    const planner = runtimeContext("demo", "web", c, "planner");
    expect(planner).not.toContain("## Ports");
  });

  it("attributes the baseline agent and injects its context", () => {
    const repo = gitRepo(path.join(tmpDir(), "web"));
    const ws = workspace({ web: { path: repo } });
    createProject(ws, "demo");
    const p = projectPaths(ws, "demo");
    patchState(p, {
      status: "running",
      children: {
        web: child("baseline", { baseline: true, baselineCover: "the login page", pendingSpawn: "baseline" }),
      },
    });
    const env = { OPENFLEET_WORKSPACE: ws.root, OPENFLEET_PROJECT: "demo" };
    const out = runHook("subagentStart", { agentName: "openfleet:openfleet-baseline" }, env);
    expect(out.additionalContext).toContain("- role: baseline");
    expect(out.additionalContext).toContain("Cover: the login page");
    expect(out.additionalContext).toContain(`PORT=${PORT_BASE}`);
    expect(readEvents(p).at(-1)).toMatchObject({ type: "agent.spawned", actor: "web/baseline" });
  });

  it("detects edited and deleted baseline files by hash", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "a.spec.ts"), "a");
    fs.writeFileSync(path.join(dir, "b.spec.ts"), "b");
    const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
    const hashes = { "a.spec.ts": hash("a"), "b.spec.ts": hash("b"), "c.spec.ts": hash("c") };
    fs.writeFileSync(path.join(dir, "b.spec.ts"), "changed");
    expect(baselineChanges(dir, hashes)).toEqual(["b.spec.ts", "c.spec.ts"]);
  });
});
