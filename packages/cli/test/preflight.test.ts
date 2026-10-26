import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claim } from "../src/claim.js";
import { errorMessage } from "../src/cli.js";
import { createProject } from "../src/commands/project.js";
import { readEvents } from "../src/events.js";
import { git, GitError } from "../src/git.js";
import { inheritedSandboxCheck } from "../src/launcher.js";
import { preflight, realProbeFs, runChecks, type ProbeFs } from "../src/preflight.js";
import { detectSandbox, hintFor, INHERITED_SANDBOX_MESSAGE, PERMISSIONS_HINT, SANDBOX_HINT } from "../src/sandbox.js";
import { schedule } from "../src/schedule.js";
import { patchState, readState } from "../src/state.js";
import { projectPaths, UserError } from "../src/workspace.js";
import { gitRepo, tmpDir, workspace } from "./helpers.js";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

function cli(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function eperm(p: string): never {
  throw Object.assign(new Error(`EPERM: operation not permitted, open '${p}'`), { code: "EPERM" });
}

/** Like a sandbox that denies writes inside `.git` but allows everything else. */
const sandboxedGit: ProbeFs = {
  ...realProbeFs,
  writeFile: (f) => (f.includes(`${path.sep}.git${path.sep}`) ? eperm(f) : realProbeFs.writeFile(f)),
  mkdir: (d) => (d.includes(`${path.sep}.git${path.sep}`) ? eperm(d) : realProbeFs.mkdir(d)),
};

function setup() {
  const root = tmpDir();
  const repo = gitRepo(path.join(root, "web"), { "README.md": "hi\n", ".env.local": "SECRET=shh\n" });
  const ws = workspace({ web: { path: repo, defaultBranch: "main", copyFiles: [".env.local"] } });
  createProject(ws, "p");
  return { ws, repo, p: projectPaths(ws, "p") };
}

describe("preflight", () => {
  it("passes on a writable repo, leaves nothing behind and records it", () => {
    const { ws, repo, p } = setup();
    const report = preflight(ws, "p");
    expect(report.ok).toBe(true);
    expect(report.repos).toEqual(["web"]);
    expect(report.checks.map((c) => c.check)).toEqual([
      "worktrees-dir",
      "ref-lock",
      "worktree-admin",
      "info-exclude",
      "copy-file",
    ]);
    expect(fs.readdirSync(path.join(repo, ".git/refs/heads"))).toEqual(["main"]);
    expect(fs.existsSync(path.join(repo, ".git/worktrees"))).toBe(false);
    expect(readState(p).preflight).toMatchObject({ ok: true });
    expect(readEvents(p).at(-1)).toMatchObject({ type: "preflight.passed" });
    expect(JSON.stringify(readEvents(p))).not.toContain("shh");
  });

  it("fails with the sandbox hint on EPERM and blocks approval, scheduling and claims", () => {
    const { ws, p } = setup();
    patchState(p, { children: { web: { repo: "web", phase: "pending", dependsOn: [], retries: 0, agentIds: {} } } });
    const report = preflight(ws, "p", sandboxedGit);
    expect(report.ok).toBe(false);
    expect(report.hint).toBe(SANDBOX_HINT);
    expect(report.checks.filter((c) => !c.ok).map((c) => [c.check, c.code])).toEqual([
      ["ref-lock", "EPERM"],
      ["worktree-admin", "EPERM"],
      ["info-exclude", "EPERM"],
    ]);
    expect(readEvents(p).at(-1)).toMatchObject({ type: "preflight.failed", payload: { hint: SANDBOX_HINT } });
    expect(() => patchState(p, { specApproved: true })).toThrow(/Preflight failed/);
    expect(schedule(readState(p)).actions).toEqual([{ owner: "top", action: "preflight", reason: "failed" }]);
    expect(() => claim(ws, "p", "web", "planner")).toThrow(/Preflight failed/);

    expect(preflight(ws, "p").ok).toBe(true);
    expect(() => patchState(p, { specApproved: true })).not.toThrow();
    expect(claim(ws, "p", "web", "planner")).toMatchObject({ result: "claimed" });
  });

  it("lists the causes in order and never suggests Full Disk Access as the fix", () => {
    const causes = ["sandboxed shell", "command sandbox", "managed OS policy"].map((s) => SANDBOX_HINT.indexOf(s));
    expect(causes.every((i) => i > 0)).toBe(true);
    expect([...causes].sort((a, b) => a - b)).toEqual(causes);
    expect(SANDBOX_HINT).toContain("sandbox.userPolicy.filesystem.readwritePaths");
    expect(SANDBOX_HINT).toMatch(/Full Disk Access does not fix this/);
  });

  it("gives a file-permissions hint on EACCES", () => {
    if (process.getuid?.() === 0) return;
    const { ws, repo } = setup();
    const heads = path.join(repo, ".git/refs/heads");
    fs.chmodSync(heads, 0o555);
    try {
      const report = preflight(ws, "p");
      expect(report.ok).toBe(false);
      expect(report.checks.find((c) => c.check === "ref-lock")).toMatchObject({ ok: false, code: "EACCES" });
      expect(report.hint).toBe(PERMISSIONS_HINT);
    } finally {
      fs.chmodSync(heads, 0o755);
    }
  });

  it("CLI exits 1 with the hint on stderr and no stack trace", () => {
    const { ws, repo } = setup();
    const heads = path.join(repo, ".git/refs/heads");
    if (process.getuid?.() === 0) return;
    fs.chmodSync(heads, 0o555);
    try {
      const r = cli(ws.root, ["preflight", "p"]);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, project: "p" });
      expect(r.stderr).toContain("Preflight failed for project p");
      expect(r.stderr).toContain(PERMISSIONS_HINT);
      expect(r.stderr).not.toMatch(/^\s+at /m);
    } finally {
      fs.chmodSync(heads, 0o755);
    }
    expect(cli(ws.root, ["preflight", "p"]).code).toBe(0);
  });

  it("resume marks preflight stale so nothing spawns until it runs again", () => {
    const { ws, p } = setup();
    preflight(ws, "p");
    const tmp = tmpDir();
    const fake = path.join(tmp, "copilot.mjs");
    fs.writeFileSync(fake, "#!/usr/bin/env node\n");
    fs.chmodSync(fake, 0o755);
    expect(cli(ws.root, ["resume", "p"], { OPENFLEET_COPILOT_BIN: fake }).code).toBe(0);
    expect(readState(p).preflight).toMatchObject({ ok: true, stale: true });
    expect(schedule(readState(p)).actions).toEqual([{ owner: "top", action: "preflight", reason: "stale" }]);
    preflight(ws, "p");
    expect(readState(p).preflight?.stale).toBeUndefined();
  });
});

describe("inherited sandbox", () => {
  it("fails fast before launching when OpenFleet itself cannot write", () => {
    const { ws } = setup();
    expect(() => inheritedSandboxCheck(ws, "p")).not.toThrow();
    const denied = runChecks(ws, "p", sandboxedGit);
    expect(denied.some((c) => c.code === "EPERM")).toBe(true);
  });

  it("explains the inherited sandbox and the App Sandbox container", () => {
    if (process.getuid?.() === 0) return;
    const { ws, repo } = setup();
    const heads = path.join(repo, ".git/refs/heads");
    fs.chmodSync(heads, 0o555);
    try {
      let err: unknown;
      try {
        inheritedSandboxCheck(ws, "p", { APP_SANDBOX_CONTAINER_ID: "com.example.terminal" });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(UserError);
      const msg = (err as Error).message;
      expect(msg).toContain(INHERITED_SANDBOX_MESSAGE);
      expect(msg).toContain("macOS App Sandbox (container com.example.terminal)");
      expect(msg).toMatch(/web: ref-lock .*\(EACCES\)/);
    } finally {
      fs.chmodSync(heads, 0o755);
    }
  });

  it("the launcher refuses to start Copilot from a sandboxed process", () => {
    if (process.getuid?.() === 0) return;
    const { ws, repo } = setup();
    const tmp = tmpDir();
    const marker = path.join(tmp, "launched");
    const fake = path.join(tmp, "copilot.mjs");
    fs.writeFileSync(
      fake,
      `#!/usr/bin/env node\nimport fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "");\n`,
    );
    fs.chmodSync(fake, 0o755);
    const heads = path.join(repo, ".git/refs/heads");
    fs.chmodSync(heads, 0o555);
    try {
      const r = cli(ws.root, ["resume", "p"], { OPENFLEET_COPILOT_BIN: fake });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("the sandbox is inherited");
      expect(r.stderr).not.toMatch(/^\s+at /m);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.chmodSync(heads, 0o755);
    }
  });
});

describe("git errors", () => {
  it("wraps git failures with stderr only", () => {
    const repo = gitRepo(path.join(tmpDir(), "r"));
    let err: unknown;
    try {
      git(repo, ["rev-parse", "--verify", "no-such-ref"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GitError);
    expect(errorMessage(err)).toMatch(/^git rev-parse --verify no-such-ref failed:\nfatal: /);
    expect(errorMessage(err)).not.toMatch(/^\s+at /m);
  });

  it("adds the sandbox hint to 'Operation not permitted' git errors", () => {
    const err = new GitError(
      ["worktree", "add"],
      "fatal: cannot lock ref 'refs/heads/x': Unable to create '/r/.git/refs/heads/x.lock': Operation not permitted",
      "",
      128,
    );
    expect(errorMessage(err)).toContain(SANDBOX_HINT);
    expect(hintFor("Permission denied")).toBe(PERMISSIONS_HINT);
  });

  it("prints EPERM fs errors with the hint and no stack", () => {
    const err = Object.assign(new Error("EPERM: operation not permitted, mkdir '/x'"), { code: "EPERM" });
    const msg = errorMessage(err);
    expect(msg).toContain(SANDBOX_HINT);
    expect(msg).not.toMatch(/^\s+at /m);
  });
});

describe("detectSandbox", () => {
  it("reads flags first, then settings files", () => {
    const root = tmpDir();
    const home = tmpDir();
    const env = { COPILOT_HOME: home };
    expect(detectSandbox(["--sandbox"], root, env)).toEqual({ enabled: true, source: "--sandbox" });
    expect(detectSandbox(["--no-sandbox"], root, env)).toEqual({ enabled: false, source: "--no-sandbox" });
    expect(detectSandbox([], root, env).enabled).toBeUndefined();
    fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ sandbox: { enabled: true } }));
    expect(detectSandbox([], root, env)).toEqual({ enabled: true, source: path.join(home, "settings.json") });
    fs.mkdirSync(path.join(root, ".github/copilot"), { recursive: true });
    fs.writeFileSync(path.join(root, ".github/copilot/settings.json"), '{ // jsonc\n "sandbox.enabled": false }');
    expect(detectSandbox([], root, env).enabled).toBe(false);
  });
});
