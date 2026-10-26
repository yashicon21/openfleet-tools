import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pluginDir } from "../src/hosts.js";
import {
  allowedDirs,
  buildArgs,
  buildClaudeArgs,
  buildCopilotArgs,
  checkClaudeVersion,
  claudeSessionExists,
  compareVersions,
  hostBinary,
  launchEnv,
  MIN_CLAUDE_VERSION,
  parseClaudeVersion,
} from "../src/launcher.js";
import { hintFor, inheritedSandboxMessage, SANDBOX_HINT, sandboxHint } from "../src/sandbox.js";
import { projectPaths } from "../src/workspace.js";
import { gitRepo, tmpDir, workspace } from "./helpers.js";

function addDirs(args: string[]): string[] {
  return args.flatMap((a, i) => (a === "--add-dir" ? [args[i + 1]!] : []));
}

describe("buildCopilotArgs", () => {
  it("auto-approves tools but keeps path and URL verification and interactive mode", () => {
    const ws = workspace();
    const args = buildCopilotArgs({ ws, agent: "openfleet-coordinator", prompt: "hi" });
    expect(args).toContain("--allow-all-tools");
    for (const flag of ["--allow-all-paths", "--allow-all-urls", "--allow-all", "--yolo", "--autopilot", "-p"]) {
      expect(args).not.toContain(flag);
    }
    expect(args[args.indexOf("-i") + 1]).toBe("hi");
  });

  it("names only new sessions, never one resumed with --session-id", () => {
    const ws = workspace();
    const base = { ws, agent: "openfleet-coordinator", sessionId: "s-1", name: "openfleet: p" };
    const fresh = buildCopilotArgs({ ...base, newSession: true });
    expect(fresh).toEqual(expect.arrayContaining(["--session-id", "s-1", "--name", "openfleet: p"]));
    const resumed = buildCopilotArgs(base);
    expect(resumed).toEqual(expect.arrayContaining(["--session-id", "s-1"]));
    expect(resumed).not.toContain("--name");
    expect(buildCopilotArgs({ ws, agent: "x", name: "openfleet report" })).toContain("--name");
  });

  it("--ask keeps per-tool prompts", () => {
    const ws = workspace();
    expect(buildCopilotArgs({ ws, agent: "openfleet-coordinator", ask: true })).not.toContain("--allow-all-tools");
  });

  it("appends passthrough args last so users can add --yolo", () => {
    const ws = workspace();
    const args = buildCopilotArgs({ ws, agent: "openfleet-coordinator", prompt: "hi", passthrough: ["--yolo"] });
    expect(args.at(-1)).toBe("--yolo");
  });

  it("adds the workspace, project worktrees, cloned repos and local repos", () => {
    const tmp = tmpDir();
    const api = gitRepo(path.join(tmp, "api"));
    const ws = workspace({
      api: { path: api },
      gone: { path: "../does-not-exist" },
      remote: { url: "https://example.com/remote.git" },
    });
    const worktrees = projectPaths(ws, "demo").worktrees;
    fs.mkdirSync(worktrees, { recursive: true });
    const clones = ws.repos;
    fs.mkdirSync(path.join(clones, "remote"), { recursive: true });

    const dirs = addDirs(buildCopilotArgs({ ws, agent: "openfleet-coordinator", project: "demo" }));
    expect(dirs).toEqual(expect.arrayContaining([ws.root, worktrees, clones, api]));
    expect(dirs.some((d) => d.includes("does-not-exist"))).toBe(false);
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it("includes both the given and the real path when a repo path goes through a symlink", () => {
    const tmp = tmpDir();
    const real = gitRepo(path.join(tmp, "real"));
    const link = path.join(tmp, "link");
    fs.symlinkSync(real, link);
    const ws = workspace({ web: { path: link } });
    expect(allowedDirs(ws)).toEqual(expect.arrayContaining([link, real]));
  });
});

describe("buildClaudeArgs", () => {
  it("puts the prompt first and points at the generated Claude plugin", () => {
    const ws = workspace();
    const args = buildClaudeArgs({ ws, host: "claude", agent: "openfleet-coordinator", prompt: "hi" });
    expect(args[0]).toBe("hi");
    expect(args.slice(1, 5)).toEqual([
      "--plugin-dir",
      pluginDir(ws, "claude"),
      "--agent",
      "openfleet:openfleet-coordinator",
    ]);
    expect(args.join(" ")).toContain("--permission-mode acceptEdits --allowedTools Bash");
    for (const flag of ["--dangerously-skip-permissions", "bypassPermissions", "-p", "--print", "-w", "--worktree"]) {
      expect(args).not.toContain(flag);
    }
    expect(addDirs(args)).toEqual(allowedDirs(ws));
  });

  it("names only new sessions and resumes existing ones", () => {
    const ws = workspace();
    const base = {
      ws,
      host: "claude" as const,
      agent: "openfleet-coordinator",
      sessionId: "abc",
      name: "openfleet: p",
    };
    const fresh = buildClaudeArgs({ ...base, newSession: true });
    expect(fresh.join(" ")).toContain("--session-id abc --name openfleet: p");
    expect(fresh).not.toContain("--resume");
    const resumed = buildClaudeArgs(base);
    expect(resumed.join(" ")).toContain("--resume abc");
    expect(resumed).not.toContain("--session-id");
    expect(resumed).not.toContain("--name");
  });

  it("keeps the default permission mode with --ask and forwards passthrough args last", () => {
    const ws = workspace();
    const args = buildClaudeArgs({ ws, host: "claude", agent: "x", ask: true, passthrough: ["--model", "opus"] });
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--allowedTools");
    expect(args.slice(-2)).toEqual(["--model", "opus"]);
  });

  it("dispatches on the host and leaves Copilot args unchanged", () => {
    const ws = workspace();
    const opts = { ws, agent: "openfleet-coordinator", prompt: "hi" };
    expect(buildArgs(opts)).toEqual(buildCopilotArgs(opts));
    expect(buildArgs({ ...opts, host: "claude" })).toEqual(buildClaudeArgs(opts));
  });
});

describe("Claude host", () => {
  it("resolves the binary and tells the session which host it runs in", () => {
    expect(hostBinary("claude", {})).toBe("claude");
    expect(hostBinary("claude", { OPENFLEET_CLAUDE_BIN: "/x/claude" })).toBe("/x/claude");
    expect(hostBinary("copilot", { OPENFLEET_CLAUDE_BIN: "/x/claude" })).toBe("copilot");
    const ws = workspace();
    expect(launchEnv({ ws, agent: "x", host: "claude" }, {}).OPENFLEET_HOST).toBe("claude");
    expect(launchEnv({ ws, agent: "x" }, {}).OPENFLEET_HOST).toBe("copilot");
  });

  it("refuses Claude Code releases older than the minimum", () => {
    expect(parseClaudeVersion("2.1.280 (Claude Code)")).toBe("2.1.280");
    expect(compareVersions("2.1.280", MIN_CLAUDE_VERSION)).toBe(1);
    expect(compareVersions("2.1.99", "2.1.219")).toBe(-1);
    expect(compareVersions("2.1.219", "2.1.219")).toBe(0);
    expect(() => checkClaudeVersion("2.1.280 (Claude Code)")).not.toThrow();
    expect(() => checkClaudeVersion(`${MIN_CLAUDE_VERSION} (Claude Code)`)).not.toThrow();
    expect(() => checkClaudeVersion("2.0.43 (Claude Code)")).toThrow(/too old.*2\.1\.219.*claude update/s);
  });

  it("finds Claude sessions in any project dir of the config dir", () => {
    const home = tmpDir();
    expect(claudeSessionExists("s1", { CLAUDE_CONFIG_DIR: home })).toBeUndefined();
    fs.mkdirSync(path.join(home, "projects", "-ws"), { recursive: true });
    expect(claudeSessionExists("s1", { CLAUDE_CONFIG_DIR: home })).toBe(false);
    fs.writeFileSync(path.join(home, "projects", "-ws", "s1.jsonl"), "");
    expect(claudeSessionExists("s1", { CLAUDE_CONFIG_DIR: home })).toBe(true);
  });

  it("names the active host in sandbox hints", () => {
    expect(sandboxHint("copilot")).toBe(SANDBOX_HINT);
    expect(sandboxHint("claude")).toContain("Claude Code's sandbox is on");
    expect(sandboxHint("claude")).not.toContain("Copilot");
    expect(hintFor("EPERM", "claude")).toBe(sandboxHint("claude"));
    expect(inheritedSandboxMessage("claude")).toContain("nothing inside Claude Code can fix it");
  });
});
