import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cliSpec, initArgs } from "../../create/src/index.js";
import { readEvents } from "../src/events.js";
import { readJson } from "../src/fsutil.js";
import type { ProjectState } from "../src/state.js";
import { gitRepo, publishFixture, sh, tmpDir, writeExtension } from "./helpers.js";

type Launch = { args: string[]; ws: string; project: string };

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const CREATE = fileURLToPath(new URL("../../create/dist/index.js", import.meta.url));

function fakeCopilot(dir: string): string {
  const file = path.join(dir, "fake-copilot.mjs");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), ws: process.env.OPENFLEET_WORKSPACE, project: process.env.OPENFLEET_PROJECT ?? null }));
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

/** Fake `claude`: answers `--version` and records launches like fakeCopilot. */
function fakeClaude(dir: string, version = "2.1.280"): string {
  const file = path.join(dir, "fake-claude.mjs");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
import fs from "node:fs";
if (process.argv[2] === "--version") { console.log("${version} (Claude Code)"); process.exit(0); }
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ args: process.argv.slice(2), host: process.env.OPENFLEET_HOST, project: process.env.OPENFLEET_PROJECT ?? null }));
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

function cli(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("openfleet CLI", () => {
  it("init creates the workspace layout and is idempotent", () => {
    const root = tmpDir();
    expect(cli(root, ["init"]).code).toBe(0);
    for (const rel of [
      "repos.json",
      "extensions.lock.json",
      ".gitignore",
      "openfleet.json",
      "projects",
      "extensions",
      "core/plugin.json",
      "core/hooks.json",
      "core/lib/hooks/main.js",
      "core/agents/openfleet-coordinator.agent.md",
      "core/skills/openfleet-grill/SKILL.md",
      "core/VERSION",
    ]) {
      expect(fs.existsSync(path.join(root, rel)), rel).toBe(true);
    }
    fs.writeFileSync(path.join(root, "repos.json"), JSON.stringify({ v: 1, repos: { keep: { path: "." } } }));
    expect(cli(root, ["init"]).stdout).toContain("Refreshed");
    expect(readJson<{ repos: object }>(path.join(root, "repos.json")).repos).toHaveProperty("keep");
  });

  it("init writes openfleet.json in the root, and commands find it from subfolders", () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "package.json"), "{}\n");
    fs.mkdirSync(path.join(root, "node_modules"));
    expect(cli(root, ["init"]).code).toBe(0);
    expect(fs.existsSync(path.join(root, "openfleet"))).toBe(false);
    expect(readJson(path.join(root, "openfleet.json"))).toMatchObject({ maxParallel: 6, host: "copilot" });
    const sub = path.join(root, "projects", "deep");
    fs.mkdirSync(sub, { recursive: true });
    const r = cli(sub, ["list"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    fs.rmSync(path.join(root, "openfleet.json"));
    expect(cli(root, ["list"]).stderr).toMatch(/No OpenFleet workspace found/);
  });

  it("init refuses a folder that already holds files it would create", () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, "projects"));
    fs.writeFileSync(path.join(root, "repos.json"), "{}");
    const r = cli(root, ["init"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("projects, repos.json");
    expect(r.stderr).toMatch(/empty folder or a new subfolder/);
    expect(fs.existsSync(path.join(root, "openfleet.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, "core"))).toBe(false);
  });

  it("init writes .gitignore only when missing, else prints the lines it lacks", () => {
    const fresh = tmpDir();
    expect(cli(fresh, ["init"]).stdout).not.toContain("Consider adding");
    const written = fs.readFileSync(path.join(fresh, ".gitignore"), "utf8");
    for (const line of ["node_modules/", "repos/", "projects/*/worktrees/"]) expect(written).toContain(line);
    expect(cli(fresh, ["init"]).stdout).not.toContain("Consider adding");

    const root = tmpDir();
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n.env\n");
    const r = cli(root, ["init"]);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toBe("node_modules/\n.env\n");
    expect(r.stdout).toContain("Consider adding");
    expect(r.stdout).toContain("  repos/");
    expect(r.stdout).toContain("  projects/*/worktrees/");
    expect(r.stdout).not.toContain("  node_modules/");
  });

  it("clones url repos into repos/<key> at the workspace root", () => {
    const tmp = tmpDir();
    const remote = gitRepo(path.join(tmp, "remote"));
    const root = path.join(tmp, "ws");
    fs.mkdirSync(root);
    cli(root, ["init"]);
    fs.writeFileSync(
      path.join(root, "repos.json"),
      JSON.stringify({ v: 1, repos: { api: { url: remote, defaultBranch: "main" } } }),
    );
    const env = { OPENFLEET_COPILOT_BIN: fakeCopilot(tmp), FAKE_OUT: path.join(tmp, "launch.json") };
    expect(cli(root, ["new", "p", "Do", "it"], env).code).toBe(0);
    const wt = cli(root, ["worktree", "p", "api", "--repo", "api", "--branch", "openfleet/p"]);
    expect(wt.stderr).toBe("");
    expect(wt.code).toBe(0);
    expect(fs.existsSync(path.join(root, "repos", "api", ".git"))).toBe(true);
    expect(sh(path.join(root, "repos", "api"), "git", ["branch", "--list", "openfleet/p"])).toContain("openfleet/p");
  });

  it("commands outside a workspace fail with a friendly error", () => {
    const r = cli(tmpDir(), ["list"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^openfleet: /);
    expect(r.stderr).not.toContain("    at ");
  });

  it("new launches the coordinator; worktree/state/event helpers work; clean removes worktrees", () => {
    const tmp = tmpDir();
    const repo = gitRepo(path.join(tmp, "web"));
    const root = path.join(tmp, "ws");
    fs.mkdirSync(root);
    cli(root, ["init"]);
    fs.writeFileSync(
      path.join(root, "repos.json"),
      JSON.stringify({ v: 1, repos: { web: { path: "../web", defaultBranch: "main" } } }),
    );
    const out = path.join(tmp, "launch.json");
    const env = { OPENFLEET_COPILOT_BIN: fakeCopilot(tmp), FAKE_OUT: out };

    const r = cli(root, ["new", "dark-mode", "Add", "dark", "mode", "--", "--model", "x"], env);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const launch = readJson<Launch>(out);
    const state = readJson<ProjectState>(path.join(root, "projects/dark-mode/state.json"));
    expect(launch.args).toEqual(
      expect.arrayContaining([
        "--agent",
        "openfleet:openfleet-coordinator",
        "--session-id",
        state.sessionId,
        "--add-dir",
        repo,
        "--model",
        "x",
      ]),
    );
    expect(launch.args[launch.args.indexOf("--plugin-dir") + 1]).toBe(path.join(root, "core"));
    expect(launch.args[launch.args.indexOf("-i") + 1]).toContain("Add dark mode");
    expect(launch).toMatchObject({ ws: root, project: "dark-mode" });
    expect(launch.args).toEqual(
      expect.arrayContaining([
        "--allow-all-tools",
        "--add-dir",
        root,
        "--add-dir",
        path.join(root, "projects/dark-mode/worktrees"),
      ]),
    );
    expect(launch.args).not.toContain("--allow-all-paths");
    expect(cli(root, ["new", "dark-mode"], env).stderr).toMatch(/already exists/);

    expect(launch.args[launch.args.indexOf("--name") + 1]).toBe("openfleet: dark-mode");

    // The recorded session still exists: resume it by id, without --name (Copilot rejects the pair).
    const copilotHome = path.join(tmp, "copilot-home");
    fs.mkdirSync(path.join(copilotHome, "session-state", state.sessionId!), { recursive: true });
    const resumeEnv = { ...env, COPILOT_HOME: copilotHome };
    expect(cli(root, ["resume", "dark-mode", "--ask", "--", "--yolo"], resumeEnv).code).toBe(0);
    const resumed = readJson<Launch>(out);
    expect(resumed.args).not.toContain("--allow-all-tools");
    expect(resumed.args.at(-1)).toBe("--yolo");
    expect(resumed.args[resumed.args.indexOf("--session-id") + 1]).toBe(state.sessionId);
    expect(resumed.args).not.toContain("--name");

    // --fresh starts (and names) a new session.
    expect(cli(root, ["resume", "dark-mode", "--fresh"], resumeEnv).code).toBe(0);
    const freshArgs = readJson<Launch>(out).args;
    const freshId = freshArgs[freshArgs.indexOf("--session-id") + 1]!;
    expect(freshId).not.toBe(state.sessionId);
    expect(freshArgs).toContain("--name");

    // The recorded session is gone: fall back to a new id, record and log it.
    const gone = cli(root, ["resume", "dark-mode"], resumeEnv);
    expect(gone.code).toBe(0);
    expect(gone.stderr).toContain(`Copilot session ${freshId} no longer exists`);
    const replacedArgs = readJson<Launch>(out).args;
    const newId = readJson<ProjectState>(path.join(root, "projects/dark-mode/state.json")).sessionId;
    expect(newId).not.toBe(freshId);
    expect(replacedArgs[replacedArgs.indexOf("--session-id") + 1]).toBe(newId);
    expect(replacedArgs).toContain("--name");
    expect(readEvents({ events: path.join(root, "projects/dark-mode/events.jsonl") } as never).at(-1)).toMatchObject({
      type: "session.replaced",
      payload: { previous: freshId, sessionId: newId, reason: "missing" },
    });

    const wt = cli(root, ["worktree", "dark-mode", "web", "--repo", "web", "--branch", "openfleet/dark-mode"]);
    expect(wt.code).toBe(0);
    const child = JSON.parse(wt.stdout) as { worktree: string };
    expect(fs.existsSync(path.join(child.worktree, "README.md"))).toBe(true);
    expect(cli(root, ["worktree", "dark-mode", "web", "--repo", "web", "--branch", "openfleet/dark-mode"]).code).toBe(
      0,
    );

    expect(cli(root, ["state", "dark-mode", "--patch", '{"children":{"web":{"phase":"planning"}}}']).code).toBe(0);
    expect(cli(root, ["state", "dark-mode", "--patch", "{oops"]).stderr).toMatch(/Invalid JSON/);
    expect(cli(root, ["state", "dark-mode", "--patch", '{"status":"awaiting-approval"}']).stderr).toMatch(
      /Unknown project status/,
    );
    const assumption = {
      child: "web",
      question: "Default theme?",
      decision: "light",
      rationale: "Matches the current UI",
      contractChange: false,
    };
    expect(
      cli(root, [
        "event",
        "dark-mode",
        "--type",
        "assumption",
        "--target",
        "web",
        "--payload",
        JSON.stringify(assumption),
      ]).code,
    ).toBe(0);
    const ev = cli(root, [
      "event",
      "dark-mode",
      "--type",
      "question.asked",
      "--actor",
      "web/planner",
      "--target",
      "web",
      "--payload",
      '{"text":"Which theme?"}',
    ]);
    expect((JSON.parse(ev.stdout) as { seq: number }).seq).toBeGreaterThan(0);

    const status = cli(root, ["status", "dark-mode"]);
    expect(status.stdout).toMatch(/web\s+planning/);
    expect(cli(root, ["list"]).stdout).toContain("dark-mode");

    const projectDir = path.join(root, "projects/dark-mode");
    const types = readEvents({ events: path.join(projectDir, "events.jsonl") } as never).map((e) => e.type);
    expect(types).toEqual([
      "project.created",
      "session.replaced",
      "phase.changed",
      "worktree.created",
      "phase.changed",
      "assumption",
      "question.asked",
    ]);
    expect(
      readEvents({ events: path.join(projectDir, "events.jsonl") } as never).find((e) => e.type === "assumption")
        ?.payload,
    ).toEqual(assumption);

    const clean = cli(root, ["clean", "dark-mode", "--branches"]);
    expect(clean.code).toBe(0);
    expect(fs.existsSync(child.worktree)).toBe(false);
  });

  it("warns when another active project touches the same repo", () => {
    const root = tmpDir();
    cli(root, ["init"]);
    for (const name of ["one", "two"]) {
      const dir = path.join(root, "projects", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "state.json"),
        JSON.stringify({
          v: 1,
          name,
          status: "running",
          createdAt: "",
          updatedAt: "",
          children: { api: { repo: "api", phase: "implementing", retries: 0, dependsOn: [], agentIds: {} } },
          questions: [],
        }),
      );
    }
    expect(cli(root, ["status", "one"]).stderr).toMatch(/"two" is also active on api/);
  });

  it("add/remove extensions and dispatches extension commands", () => {
    const tmp = tmpDir();
    const root = path.join(tmp, "ws");
    fs.mkdirSync(root);
    cli(root, ["init"]);
    const ext = writeExtension(
      path.join(tmp, "ext"),
      {
        manifest: 2,
        name: "audit",
        version: "1.0.0",
        core: ">=0.0.0",
        phases: [{ slot: "post-run", instructions: "instructions.md" }],
        commands: { digest: "digest.md" },
      },
      { "digest.md": "Digest." },
    );
    const add = cli(root, ["add", ext]);
    expect(add.code).toBe(0);
    expect(add.stdout).toContain("Added extension audit@1.0.0");
    expect(add.stdout).toContain("Phase: post-run (advisory) runs as agent openfleet:openfleet-ext-audit-post-run.");
    expect(cli(root, ["extensions"]).stdout).toContain("audit@1.0.0");

    const out = path.join(tmp, "launch.json");
    expect(
      cli(root, ["digest", "--since", "yesterday"], { OPENFLEET_COPILOT_BIN: fakeCopilot(tmp), FAKE_OUT: out }).code,
    ).toBe(0);
    const launch = readJson<Launch>(out);
    expect(launch.args[launch.args.indexOf("--agent") + 1]).toBe("openfleet:openfleet-ext-audit");
    expect(launch.args[launch.args.indexOf("-i") + 1]).toContain("--since yesterday");
    expect(launch.args).toContain("--allow-all-tools");

    expect(cli(root, ["digest", "--ask"], { OPENFLEET_COPILOT_BIN: fakeCopilot(tmp), FAKE_OUT: out }).code).toBe(0);
    const asked = readJson<Launch>(out);
    expect(asked.args).not.toContain("--allow-all-tools");
    expect(asked.args[asked.args.indexOf("-i") + 1]).not.toContain("--ask");

    expect(cli(root, ["remove", "audit"]).code).toBe(0);
    expect(cli(root, ["digest"]).stderr).toMatch(/Unknown command "digest"/);
  });

  it("rejects a version 1 extension with the v2 equivalent", () => {
    const tmp = tmpDir();
    const root = path.join(tmp, "ws");
    fs.mkdirSync(root);
    cli(root, ["init"]);
    const ext = writeExtension(path.join(tmp, "v1"), {
      name: "v1",
      version: "1.0.0",
      core: "*",
      mode: "augment",
      role: "tester",
    });
    const r = cli(root, ["add", ext]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/manifest version 1/);
    expect(r.stderr).toContain('"manifest": 2');
  });

  it("runs extension slots: when.files, outputs, prUrl, follow-ups and blocking failures", () => {
    const tmp = tmpDir();
    const root = path.join(tmp, "ws");
    fs.mkdirSync(root);
    const lib = gitRepo(path.join(tmp, "lib"), { ".changeset/config.json": "{}\n", "package.json": "{}\n" });
    const web = gitRepo(path.join(tmp, "web"), { "package.json": "{}\n" });
    cli(root, ["init"]);
    fs.writeFileSync(
      path.join(root, "repos.json"),
      JSON.stringify({ v: 1, repos: { lib: { path: lib }, web: { path: web } } }),
    );
    expect(cli(root, ["add", publishFixture(path.join(tmp, "publish"))]).stdout).toContain(
      "Phase: post-test (blocking, when .changeset/config.json) runs as agent openfleet:openfleet-ext-publish-post-test.",
    );
    const unset = () =>
      (JSON.parse(cli(root, ["ext", "settings", "--unset"]).stdout) as { key: string }[]).map((r) => r.key);
    expect(unset()).toEqual(["label", "workflow"]);
    expect(cli(root, ["ext", "settings", "set", "publish", "label", "nightly"]).code).toBe(0);
    expect(cli(root, ["ext", "settings", "set", "publish", "nope", "x"]).stderr).toMatch(/does not declare setting/);
    expect(unset()).toEqual(["workflow"]);
    const env = { OPENFLEET_COPILOT_BIN: fakeCopilot(tmp), FAKE_OUT: path.join(tmp, "launch.json") };
    expect(cli(root, ["new", "pin"], env).code).toBe(0);
    for (const [id, deps] of [
      ["lib", []],
      ["web", ["lib"]],
      ["app", ["web"]],
    ] as const) {
      const repo = id === "app" ? "web" : id;
      expect(cli(root, ["worktree", "pin", id, "--repo", repo, "--branch", `openfleet/pin-${id}`]).code).toBe(0);
      cli(root, ["state", "pin", "--patch", JSON.stringify({ children: { [id]: { dependsOn: deps } } })]);
    }

    const plan = (child: string) =>
      JSON.parse(cli(root, ["ext", "plan", "pin", "post-test", "--child", child]).stdout) as {
        run: { agent: string; blocking: boolean; timeoutMinutes: number }[];
        skipped: { reason: string }[];
      };
    expect(plan("lib").run).toEqual([
      expect.objectContaining({
        agent: "openfleet:openfleet-ext-publish-post-test",
        blocking: true,
        timeoutMinutes: 45,
      }),
    ]);
    expect(plan("web")).toMatchObject({ run: [], skipped: [{ reason: "none of .changeset/config.json exist" }] });

    const report = {
      status: "done",
      summary: "Published a preview",
      outputs: { prUrl: "https://example.test/lib/pull/7", version: "1.3.0-preview.1" },
      followUps: ["Replace preview pins after release"],
    };
    const r = cli(root, [
      "ext",
      "result",
      "pin",
      "publish",
      "--slot",
      "post-test",
      "--child",
      "lib",
      "--report",
      JSON.stringify(report),
    ]);
    expect(r.code).toBe(0);
    const state = () => readJson<ProjectState & { followUps?: object }>(path.join(root, "projects/pin/state.json"));
    expect(state().children.lib).toMatchObject({
      prUrl: "https://example.test/lib/pull/7",
      outputs: { publish: report.outputs },
      followUps: { publish: report.followUps },
    });
    const bad = cli(root, [
      "ext",
      "result",
      "pin",
      "publish",
      "--slot",
      "post-test",
      "--child",
      "lib",
      "--report",
      '{"outputs":{"v":{"nested":1}}}',
    ]);
    expect(bad.stderr).toMatch(/flat values only/);
    expect(
      cli(root, ["ext", "result", "pin", "publish", "--slot", "post-run", "--report", '{"outputs":{"a":"b"}}']).stderr,
    ).toMatch(/need --child/);
    cli(root, [
      "ext",
      "result",
      "pin",
      "publish",
      "--slot",
      "post-run",
      "--report",
      '{"summary":"x","followUps":["Tidy up"]}',
    ]);
    expect(state().followUps).toEqual({ publish: ["Tidy up"] });

    expect(
      cli(root, [
        "ext",
        "fail",
        "pin",
        "publish",
        "--slot",
        "post-test",
        "--child",
        "lib",
        "--reason",
        "workflow timed out",
      ]).code,
    ).toBe(0);
    const after = state();
    expect(after.children.lib!.phase).toBe("failed");
    expect(after.children.web).toMatchObject({ phase: "blocked", notes: "dependency lib failed" });
    expect(after.children.app!.phase).toBe("blocked");

    const events = readEvents({ events: path.join(root, "projects/pin/events.jsonl") } as never);
    const ofType = (t: string) => events.filter((e) => e.type === t);
    expect(ofType("extension.skipped")).toHaveLength(1);
    expect(ofType("extension.ran").map((e) => e.payload.status)).toEqual(["done", "done"]);
    expect(ofType("extension.outputs")[0]).toMatchObject({
      target: "lib",
      payload: { extension: "publish", outputs: report.outputs },
    });
    expect(ofType("extension.failed")[0]).toMatchObject({
      target: "lib",
      payload: { blocked: ["web", "app"], attempts: 2 },
    });
    expect(ofType("child.failed")[0]!.payload.reason).toMatch(/extension publish \(post-test\) failed/);
  });

  it("runs the plan-first flow: copyFiles, next, gate, baseline and plans-ready failures", () => {
    const tmp = tmpDir();
    const root = path.join(tmp, "ws");
    fs.mkdirSync(root);
    const lib = gitRepo(path.join(tmp, "lib"), { "package.json": "{}\n" });
    const app = gitRepo(path.join(tmp, "app"), { ".gitignore": ".env.local\n", "src/a.ts": "a\n" });
    fs.writeFileSync(path.join(app, ".env.local"), "AUTH_CLIENT_SECRET=local-client-secret-1\n");
    cli(root, ["init"]);
    fs.writeFileSync(
      path.join(root, "repos.json"),
      JSON.stringify({
        v: 1,
        repos: {
          lib: { path: lib },
          app: { path: app, e2e: "pnpm test:e2e", env: ["AUTH_CLIENT_SECRET"], copyFiles: [".env.local", "nope.env"] },
        },
      }),
    );
    const env = { OPENFLEET_COPILOT_BIN: fakeCopilot(tmp), FAKE_OUT: path.join(tmp, "launch.json") };
    expect(cli(root, ["new", "auth"], env).code).toBe(0);
    const state = () => readJson<ProjectState>(path.join(root, "projects/auth/state.json"));
    const next = () =>
      JSON.parse(cli(root, ["next", "auth"]).stdout) as { gate: string; actions: { action: string; child?: string }[] };

    expect(cli(root, ["worktree", "auth", "lib", "--repo", "lib", "--branch", "openfleet/auth"]).code).toBe(0);
    const wt = cli(root, ["worktree", "auth", "app", "--repo", "app", "--branch", "openfleet/auth"]);
    expect(wt.code).toBe(0);
    expect(wt.stderr).toContain("nope.env");
    const appWt = state().children.app!.worktree!;
    expect(fs.readFileSync(path.join(appWt, ".env.local"), "utf8")).toContain("local-client-secret-1");
    expect(state().children.app).toMatchObject({ copiedFiles: [".env.local"] });
    cli(root, [
      "state",
      "auth",
      "--patch",
      JSON.stringify({
        status: "running",
        children: { app: { dependsOn: ["lib"], baseline: true, baselineCover: "login" } },
      }),
    ]);
    const ports = Object.values(state().children).map((c) => c.portBase);
    expect(new Set(ports).size).toBe(2);

    expect(next()).toMatchObject({
      gate: "planning",
      actions: [
        { action: "plan", child: "lib" },
        { action: "plan", child: "app" },
      ],
    });
    cli(root, ["state", "auth", "--patch", '{"children":{"lib":{"phase":"planned"},"app":{"phase":"plan-review"}}}']);
    expect(cli(root, ["gate", "auth", "consistent"]).stderr).toMatch(/Not every plan is validated yet: app/);
    cli(root, ["state", "auth", "--patch", '{"children":{"app":{"phase":"planned"}}}']);
    expect(next()).toMatchObject({ gate: "checking", actions: [{ action: "check-consistency" }] });
    expect(cli(root, ["gate", "auth", "open"]).stderr).toMatch(/consistency check/);
    expect(cli(root, ["gate", "auth", "consistent"]).code).toBe(0);
    expect(next()).toMatchObject({ gate: "plans-ready", actions: [{ action: "plans-ready" }] });
    expect(cli(root, ["gate", "auth", "open"]).code).toBe(0);
    expect(next()).toMatchObject({
      gate: "open",
      actions: [
        { action: "implement", child: "lib" },
        { action: "baseline", child: "app" },
      ],
    });

    fs.mkdirSync(path.join(appWt, "e2e"));
    fs.writeFileSync(path.join(appWt, "e2e/login.spec.ts"), "test('login')\n");
    cli(root, ["state", "auth", "--patch", '{"children":{"app":{"phase":"baseline"}}}']);
    expect(
      cli(root, ["baseline", "auth", "app", "--report", '{"status":"done","files":["e2e/missing.ts"]}']).stderr,
    ).toMatch(/does not exist/);
    const report = { status: "done", files: ["e2e/login.spec.ts"], command: "pnpm test:e2e", results: "1/1, 2 runs" };
    expect(cli(root, ["baseline", "auth", "app", "--report", JSON.stringify(report)]).code).toBe(0);
    expect(state().children.app).toMatchObject({
      phase: "planned",
      baselinePassed: true,
      baselineFiles: ["e2e/login.spec.ts"],
    });
    const check = () => JSON.parse(cli(root, ["baseline", "auth", "app", "--check"]).stdout) as { changed: string[] };
    expect(check().changed).toEqual([]);
    fs.writeFileSync(path.join(appWt, "e2e/login.spec.ts"), "test.skip('login')\n");
    expect(check().changed).toEqual(["e2e/login.spec.ts"]);
    expect(next().actions).toEqual([{ owner: "top", action: "implement", child: "lib" }]);

    // Re-planning after a contract change clears the consistency check without closing the gate.
    cli(root, ["state", "auth", "--patch", '{"children":{"lib":{"phase":"plan-review"}}}']);
    cli(root, ["state", "auth", "--patch", '{"children":{"lib":{"phase":"planned"}}}']);
    expect(next()).toMatchObject({ gate: "open", actions: [{ action: "check-consistency" }] });

    // A blocking plans-ready failure blocks every active child.
    expect(
      cli(root, ["ext", "fail", "auth", "gatekeeper", "--slot", "plans-ready", "--reason", "plans need sign-off"]).code,
    ).toBe(0);
    expect(Object.values(state().children).map((c) => c.phase)).toEqual(["blocked", "blocked"]);
    expect(next().actions).toEqual([{ owner: "top", action: "finalize" }]);

    const events = readEvents({ events: path.join(root, "projects/auth/events.jsonl") } as never);
    expect(events.find((e) => e.type === "worktree.created" && e.target === "app")!.payload).toMatchObject({
      copiedFiles: [".env.local"],
      missingCopyFiles: ["nope.env"],
    });
    expect(events.find((e) => e.type === "plans.consistent")!.payload).toMatchObject({
      children: ["lib", "app"],
      gateOpen: false,
    });
    expect(events.find((e) => e.type === "baseline.passed")).toMatchObject({
      actor: "app/baseline",
      target: "app",
      payload: { files: ["e2e/login.spec.ts"], command: "pnpm test:e2e" },
    });
    expect(events.find((e) => e.type === "extension.failed")).toMatchObject({ payload: { slot: "plans-ready" } });
    expect(fs.readFileSync(path.join(root, "projects/auth/events.jsonl"), "utf8")).not.toContain(
      "local-client-secret-1",
    );
  });

  it("accepts blocking phases in plans-ready and pre-implement", () => {
    const tmp = tmpDir();
    const root = path.join(tmp, "ws");
    fs.mkdirSync(root);
    cli(root, ["init"]);
    const ext = writeExtension(path.join(tmp, "gate"), {
      manifest: 2,
      name: "gate",
      version: "1.0.0",
      core: ">=0.0.0 <1.0.0",
      description: "Gate checks",
      phases: [
        { slot: "plans-ready", instructions: "a.md", blocking: true },
        { slot: "pre-implement", instructions: "b.md", blocking: true },
      ],
      augments: [{ role: "baseline", instructions: "c.md" }],
    });
    const r = cli(root, ["add", ext]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const index = readJson<Record<string, { agent: string; blocking: boolean }[]>>(
      path.join(root, "core/extensions.json"),
    );
    expect(JSON.stringify(index)).toContain("openfleet:openfleet-ext-gate-plans-ready");
    expect(JSON.stringify(index)).toContain("openfleet:openfleet-ext-gate-pre-implement");
    expect(fs.readFileSync(path.join(root, "core/agents/openfleet-baseline.agent.md"), "utf8")).toContain(
      "## Extension: gate",
    );
    const bad = writeExtension(path.join(tmp, "bad"), {
      manifest: 2,
      name: "bad",
      version: "1.0.0",
      core: ">=0.0.0 <1.0.0",
      description: "Bad",
      phases: [{ slot: "post-run", instructions: "a.md", blocking: true }],
    });
    expect(cli(root, ["add", bad]).stderr).toMatch(/only supported in the slots/);
  });

  it("update reinstalls core and keeps user data", () => {
    const root = tmpDir();
    cli(root, ["init"]);
    fs.writeFileSync(path.join(root, "core/agents/junk.agent.md"), "x");
    expect(cli(root, ["update"]).code).toBe(0);
    expect(fs.existsSync(path.join(root, "core/agents/junk.agent.md"))).toBe(false);
    expect(fs.existsSync(path.join(root, "repos.json"))).toBe(true);
  });
});

describe("@openfleet-tools/create", () => {
  it("defaults --cli to the CLI version it is released with", () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const cliVersion = readJson<{ version: string }>(path.join(root, "packages/cli/package.json")).version;
    expect(readJson<{ version: string }>(path.join(root, "packages/create/package.json")).version).toBe(cliVersion);
    expect(cliSpec()).toBe(`@openfleet-tools/cli@^${cliVersion}`);
    expect(cliSpec("1.2.3")).toBe("@openfleet-tools/cli@1.2.3");
    expect(cliSpec("file:../cli")).toBe("file:../cli");
    const config = readJson<{ fixed: string[][] }>(path.join(root, ".changeset/config.json"));
    expect(config.fixed).toContainEqual(expect.arrayContaining(["@openfleet-tools/cli", "@openfleet-tools/create"]));
    const help = spawnSync(process.execPath, [CREATE, "--help"], { encoding: "utf8" });
    expect(help.stdout).toContain(`(default: ^${cliVersion})`);
  });

  it("creates a package.json and skips install when asked", () => {
    const dir = path.join(tmpDir(), "my-fleet");
    const r = spawnSync(process.execPath, [CREATE, dir, "--skip-install"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(readJson<{ name: string; private: boolean }>(path.join(dir, "package.json"))).toEqual({
      name: "my-fleet",
      private: true,
    });
  });

  it("forwards --host to openfleet init and rejects unknown hosts", () => {
    expect(initArgs()).toEqual(["init"]);
    expect(initArgs("claude")).toEqual(["init", "--host", "claude"]);
    expect(() => initArgs("codex")).toThrow(/--host must be one of copilot, claude/);
    const dir = path.join(tmpDir(), "my-fleet");
    const r = spawnSync(process.execPath, [CREATE, dir, "--skip-install", "--host", "claude"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("npx openfleet init --host claude");
    const bad = spawnSync(process.execPath, [CREATE, path.join(tmpDir(), "x"), "--host", "codex"], {
      encoding: "utf8",
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/--host must be one of/);
    const help = spawnSync(process.execPath, [CREATE, "--help"], { encoding: "utf8" });
    expect(help.stdout).toContain("--host <host>");
  });

  it("installs a local CLI build and runs init", () => {
    const dir = path.join(tmpDir(), "fleet");
    const cliPkg = fileURLToPath(new URL("..", import.meta.url));
    const r = spawnSync(process.execPath, [CREATE, dir, "--cli", `file:${cliPkg}`, "--host", "claude"], {
      encoding: "utf8",
      env: { ...process.env, npm_config_user_agent: "npm/10" },
    });
    expect(r.stderr).not.toMatch(/ERR!/);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(dir, "core/plugin.json"))).toBe(true);
    expect(readJson<{ host: string }>(path.join(dir, "openfleet.json")).host).toBe("claude");
  }, 120_000);
});

describe("hosts", () => {
  function setup() {
    const tmp = tmpDir();
    const root = path.join(tmp, "ws");
    fs.mkdirSync(root);
    cli(root, ["init"]);
    const out = path.join(tmp, "launch.json");
    const env = {
      OPENFLEET_COPILOT_BIN: fakeCopilot(tmp),
      OPENFLEET_CLAUDE_BIN: fakeClaude(tmp),
      FAKE_OUT: out,
      CLAUDE_CONFIG_DIR: path.join(tmp, "claude-home"),
    };
    const launch = () => readJson<Launch & { host?: string }>(out);
    const state = (name: string) => readJson<ProjectState>(path.join(root, `projects/${name}/state.json`));
    return { tmp, root, env, launch, state };
  }

  it("new --host claude records the host and launches Claude Code with its plugin", () => {
    const { root, env, launch, state } = setup();
    const r = cli(root, ["new", "p", "Do", "it", "--host", "claude"], env);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(state("p").host).toBe("claude");
    const args = launch().args;
    expect(args[0]).toContain("Do it");
    expect(args[args.indexOf("--plugin-dir") + 1]).toBe(path.join(root, "core/claude"));
    expect(args).toEqual(expect.arrayContaining(["--session-id", state("p").sessionId, "--name", "openfleet: p"]));
    expect(launch().host).toBe("claude");
    const events = fs.readFileSync(path.join(root, "projects/p/events.jsonl"), "utf8");
    expect(events).toContain('"host":"claude"');
  });

  it("uses config host by default and resume keeps the recorded host", () => {
    const { root, env, launch, state } = setup();
    cli(root, ["config", "set", "host", "claude"]);
    expect(cli(root, ["new", "p"], env).code).toBe(0);
    expect(state("p").host).toBe("claude");
    const sessionId = state("p").sessionId!;
    fs.mkdirSync(path.join(env.CLAUDE_CONFIG_DIR, "projects", "-ws"), { recursive: true });
    fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, "projects", "-ws", `${sessionId}.jsonl`), "");

    cli(root, ["config", "set", "host", "copilot"]);
    const r = cli(root, ["resume", "p"], env);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/Workspace host is copilot, but project "p" runs in claude/);
    expect(launch().args).toEqual(expect.arrayContaining(["--resume", sessionId]));
    expect(launch().args).not.toContain("--name");
    expect(launch().host).toBe("claude");
  });

  it("refuses to switch a project's host on resume", () => {
    const { root, env, state } = setup();
    expect(cli(root, ["new", "p"], env).code).toBe(0);
    expect(state("p").host).toBe("copilot");
    const r = cli(root, ["resume", "p", "--host", "claude"], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/runs in Copilot CLI \(host copilot\); it cannot switch to claude mid-project/);
    expect(cli(root, ["resume", "p", "--host", "copilot"], env).code).toBe(0);
    expect(cli(root, ["new", "q", "--host", "other"], env).stderr).toMatch(/host must be one of/);
  });

  it("refuses Claude Code below the minimum version", () => {
    const { tmp, root, env } = setup();
    const r = cli(root, ["new", "p", "--host", "claude"], { ...env, OPENFLEET_CLAUDE_BIN: fakeClaude(tmp, "2.1.100") });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Claude Code 2\.1\.100 is too old/);
  });
});
