// The same scenarios run against every host so Copilot CLI and Claude Code stay at parity.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claim } from "../src/claim.js";
import { createProject } from "../src/commands/project.js";
import { hostFromAnswer, resolveInitHost } from "../src/commands/workspace.js";
import { readEvents } from "../src/events.js";
import { readJson } from "../src/fsutil.js";
import { addWorktree, headSha } from "../src/git.js";
import { HOSTS, pluginDir, type Host } from "../src/hosts.js";
import { allowedDirs, buildArgs, MIN_CLAUDE_VERSION } from "../src/launcher.js";
import { patchState, readState, type ProjectState } from "../src/state.js";
import { projectPaths, type Workspace } from "../src/workspace.js";
import { gitRepo, tmpDir, workspace } from "./helpers.js";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const AGENTS = [
  "openfleet-coordinator",
  "openfleet-repo-coordinator",
  "openfleet-planner",
  "openfleet-baseline",
  "openfleet-implementer",
  "openfleet-tester",
];

type Payload = Record<string, unknown>;

/** What differs between hosts; every scenario below is otherwise identical. */
interface HostCase {
  host: Host;
  binEnv: string;
  /** Flags that auto-approve tools unless `--ask`. */
  autoApprove: string[];
  /** Flag that resumes an existing session. */
  resumeFlag: string;
  manifest: (ws: Workspace) => string;
  hooksFile: (ws: Workspace) => string;
  agentFile: (ws: Workspace, name: string) => string;
  tools: Record<string, RegExp>;
  /** argv for core/lib/hooks/main.js. */
  hookArgv: (event: string) => string[];
  /** Raw payload the host sends for an event. */
  payload: (event: string, body: Payload) => Payload;
  /** The context string a hook wrote back, if any. */
  context: (stdout: string) => string | undefined;
  writeFile: (file: string, content: string) => Payload;
}

const PASCAL: Record<string, string> = {
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  subagentStart: "SubagentStart",
  subagentStop: "SubagentStop",
  postToolUse: "PostToolUse",
};

const CASES: Record<Host, HostCase> = {
  copilot: {
    host: "copilot",
    binEnv: "OPENFLEET_COPILOT_BIN",
    autoApprove: ["--allow-all-tools"],
    resumeFlag: "--session-id",
    manifest: (ws) => path.join(ws.core, "plugin.json"),
    hooksFile: (ws) => path.join(ws.core, "hooks.json"),
    agentFile: (ws, name) => path.join(ws.core, "agents", `${name}.agent.md`),
    tools: {
      "openfleet-planner": /^tools: \["read", "search"\]$/m,
      "openfleet-implementer": /^tools: \["read", "search", "edit", "execute"\]$/m,
      "openfleet-tester": /^tools: \["read", "search", "execute"\]$/m,
    },
    hookArgv: (event) => [event],
    payload: (_event, body) => ({
      sessionId: body.sessionId,
      ...(body.agentId ? { agentId: body.agentId, agentName: body.agentName } : {}),
      ...(body.source ? { source: body.source } : {}),
      ...(body.response ? { response: body.response } : {}),
      ...(body.tool ?? {}),
    }),
    context: (stdout) =>
      stdout ? (JSON.parse(stdout) as { additionalContext?: string }).additionalContext : undefined,
    writeFile: (file, content) => ({ toolName: "create", toolArgs: { path: file, file_text: content } }),
  },
  claude: {
    host: "claude",
    binEnv: "OPENFLEET_CLAUDE_BIN",
    autoApprove: ["--permission-mode", "acceptEdits", "--allowedTools", "Bash"],
    resumeFlag: "--resume",
    manifest: (ws) => path.join(pluginDir(ws, "claude"), ".claude-plugin", "plugin.json"),
    hooksFile: (ws) => path.join(pluginDir(ws, "claude"), "hooks", "hooks.json"),
    agentFile: (ws, name) => path.join(pluginDir(ws, "claude"), "agents", `${name}.md`),
    tools: {
      "openfleet-planner": /^tools: Read, Grep, Glob$/m,
      "openfleet-implementer": /^tools: Read, Grep, Glob, Edit, Write, Bash$/m,
      "openfleet-tester": /^tools: Read, Grep, Glob, Bash$/m,
    },
    hookArgv: (event) => ["claude", PASCAL[event]!],
    payload: (event, body) => ({
      session_id: body.sessionId,
      hook_event_name: PASCAL[event],
      ...(body.agentId ? { agent_id: body.agentId, agent_type: body.agentName } : {}),
      ...(body.source ? { source: body.source } : {}),
      ...(body.response ? { last_assistant_message: body.response } : {}),
      ...(body.tool ?? {}),
    }),
    context: (stdout) =>
      stdout
        ? (JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
            ?.additionalContext
        : undefined,
    writeFile: (file, content) => ({ tool_name: "Write", tool_input: { file_path: file, content } }),
  },
};

/** Fake host binary: answers `--version` and records each launch. */
function fakeHost(dir: string, host: Host, version = "2.1.280"): string {
  const file = path.join(dir, `fake-${host}.mjs`);
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
import fs from "node:fs";
if (process.argv[2] === "--version") { console.log("${version}${host === "claude" ? " (Claude Code)" : ""}"); process.exit(0); }
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ args: process.argv.slice(2), host: process.env.OPENFLEET_HOST, ws: process.env.OPENFLEET_WORKSPACE, project: process.env.OPENFLEET_PROJECT ?? null }));
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

function cli(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function projectSetup() {
  const repo = gitRepo(path.join(tmpDir(), "api"), { "src/a.ts": "export const a = 1;\n" });
  const ws = workspace({ api: { path: repo, defaultBranch: "main", confirmed: true } });
  createProject(ws, "demo");
  const p = projectPaths(ws, "demo");
  const worktree = path.join(p.worktrees, "api");
  addWorktree(repo, worktree, "openfleet/demo", "main");
  patchState(p, {
    status: "running",
    children: {
      api: {
        repo: "api",
        repoPath: repo,
        worktree,
        branch: "openfleet/demo",
        baseSha: headSha(worktree),
        phase: "implementing",
      },
    },
  });
  return { ws, p, worktree, env: { OPENFLEET_WORKSPACE: ws.root, OPENFLEET_PROJECT: "demo" } };
}

describe.each(HOSTS.map((h) => CASES[h]))("host parity: $host", (c) => {
  describe("launch args", () => {
    it("loads the host's plugin and coordinator, names new sessions and auto-approves tools", () => {
      const ws = workspace();
      const args = buildArgs({
        ws,
        host: c.host,
        agent: "openfleet-coordinator",
        prompt: "Do it",
        sessionId: "sid",
        name: "openfleet: p",
        newSession: true,
        project: "p",
        passthrough: ["--model", "m"],
      });
      expect(args[args.indexOf("--plugin-dir") + 1]).toBe(pluginDir(ws, c.host));
      expect(args[args.indexOf("--agent") + 1]).toBe("openfleet:openfleet-coordinator");
      expect(args.join(" ")).toContain("--session-id sid --name openfleet: p");
      expect(args.join(" ")).toContain(c.autoApprove.join(" "));
      expect(args).toContain("Do it");
      expect(args.flatMap((a, i) => (a === "--add-dir" ? [args[i + 1]] : []))).toEqual(allowedDirs(ws, "p"));
      expect(args.slice(-2)).toEqual(["--model", "m"]);
      for (const flag of ["--yolo", "--allow-all-urls", "--dangerously-skip-permissions", "bypassPermissions"]) {
        expect(args).not.toContain(flag);
      }
    });

    it("resumes without renaming and drops auto-approval with --ask", () => {
      const ws = workspace();
      const base = { ws, host: c.host, agent: "openfleet-coordinator", sessionId: "sid", name: "openfleet: p" };
      const resumed = buildArgs(base);
      expect(resumed[resumed.indexOf(c.resumeFlag) + 1]).toBe("sid");
      expect(resumed).not.toContain("--name");
      const asked = buildArgs({ ...base, ask: true });
      for (const flag of c.autoApprove.filter((f) => f.startsWith("--"))) expect(asked).not.toContain(flag);
    });
  });

  describe("generated plugin", () => {
    it("has a manifest, every core agent and skill, and hooks for every event", () => {
      const ws = workspace();
      expect(readJson<Payload>(c.manifest(ws))).toMatchObject({ name: "openfleet", license: "MIT" });
      for (const name of AGENTS) {
        const text = fs.readFileSync(c.agentFile(ws, name), "utf8");
        expect(text, name).not.toMatch(/<!--\s*(host:|\/host)/);
        if (c.tools[name]) expect(text, name).toMatch(c.tools[name]);
      }
      const skills = fs.readdirSync(path.join(pluginDir(ws, c.host), "skills")).sort();
      expect(skills).toEqual(fs.readdirSync(path.join(ws.core, "skills")).sort());
      expect(skills).toEqual(
        expect.arrayContaining(["openfleet-grill", "openfleet-orchestrate", "openfleet-finalize"]),
      );
      const hooks = Object.keys(readJson<{ hooks: Payload }>(c.hooksFile(ws)).hooks).map((k) => k.toLowerCase());
      expect(hooks.sort()).toEqual(
        Object.keys(PASCAL)
          .map((k) => k.toLowerCase())
          .sort(),
      );
    });
  });

  describe("hook payloads", () => {
    it("records the same session through the installed entrypoint", () => {
      const { ws, p, worktree, env } = projectSetup();
      const main = path.join(ws.core, "lib", "hooks", "main.js");
      const run = (event: string, body: Payload) =>
        execFileSync(process.execPath, [main, ...c.hookArgv(event)], {
          input: JSON.stringify({ cwd: ws.root, ...c.payload(event, { sessionId: "s1", ...body }) }),
          env: { ...process.env, ...env },
          encoding: "utf8",
        });

      expect(c.context(run("sessionStart", { source: "startup" }))).toContain("Active OpenFleet project: demo");
      expect(claim(ws, "demo", "api", "implementer")).toMatchObject({ result: "claimed" });
      const agent = { agentId: "agent-1", agentName: "openfleet:openfleet-implementer" };
      expect(c.context(run("subagentStart", agent))).toContain(worktree);
      expect(readState(p).children.api!.pendingSpawn).toBeUndefined();

      const file = path.join(worktree, "src", "b.ts");
      fs.writeFileSync(file, "export const b = 2;\n");
      expect(run("postToolUse", { ...agent, tool: c.writeFile(file, "export const b = 2;\n") })).toBe("");
      expect(run("subagentStop", { ...agent, response: "implemented" })).toBe("");
      run("sessionEnd", {});

      const events = readEvents(p);
      expect(events.find((e) => e.type === "session.started")!.payload).toMatchObject({ host: c.host });
      expect(events.find((e) => e.type === "agent.spawned")).toMatchObject({ actor: "api/implementer", target: "api" });
      expect(events.find((e) => e.type === "file.added")).toMatchObject({ target: "api" });
      expect(events.find((e) => e.type === "agent.stopped")).toMatchObject({
        target: "api",
        payload: { agentId: "agent-1", response: "implemented" },
      });
      expect(events.at(-1)!.type).toBe("session.ended");
      expect(readState(p).children.api!.agentIds.implementer).toBe("agent-1");
    });

    it("never fails on input it cannot parse", () => {
      const { ws, env } = projectSetup();
      const main = path.join(ws.core, "lib", "hooks", "main.js");
      const out = execFileSync(process.execPath, [main, ...c.hookArgv("postToolUse")], {
        input: "not json",
        env: { ...process.env, ...env },
        encoding: "utf8",
      });
      expect(out).toBe("");
    });
  });

  describe("CLI with a fake host binary", () => {
    function setup(binary?: string) {
      const tmp = tmpDir();
      const root = path.join(tmp, "ws");
      fs.mkdirSync(root);
      expect(cli(root, ["init", "--host", c.host]).code).toBe(0);
      const out = path.join(tmp, "launch.json");
      const env = {
        [c.binEnv]: binary ?? fakeHost(tmp, c.host),
        FAKE_OUT: out,
        CLAUDE_CONFIG_DIR: path.join(tmp, "claude-home"),
      };
      return { tmp, root, env, out };
    }

    it("init --host saves the host and `new` launches it without warnings", () => {
      const { root, env, out } = setup();
      expect(readJson<Payload>(path.join(root, "openfleet.json")).host).toBe(c.host);
      const r = cli(root, ["new", "p", "Do", "it"], env);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      const state = readJson<ProjectState>(path.join(root, "projects/p/state.json"));
      expect(state.host).toBe(c.host);
      const launch = readJson<{ args: string[]; host: string; ws: string; project: string }>(out);
      expect(launch).toMatchObject({ host: c.host, ws: root, project: "p" });
      expect(launch.args.join(" ")).toContain("Do it");
      expect(launch.args.join(" ")).toContain(`--session-id ${state.sessionId} --name openfleet: p`);
      expect(fs.readFileSync(path.join(root, "projects/p/events.jsonl"), "utf8")).toContain(`"host":"${c.host}"`);
    });

    it("reports a missing host binary with install instructions", () => {
      const { root, env } = setup("/nonexistent/openfleet-host-bin");
      const r = cli(root, ["new", "p", "Do", "it"], env);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/Could not find `\/nonexistent\/openfleet-host-bin`\. Install/);
    });

    it.runIf(c.host === "claude")("refuses host releases older than the minimum", () => {
      const tmp = tmpDir();
      const { root, env } = setup(fakeHost(tmp, c.host, "2.0.1"));
      const r = cli(root, ["new", "p", "Do", "it"], env);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`needs ${MIN_CLAUDE_VERSION} or later`);
    });
  });
});

describe("init host choice", () => {
  it("--host wins, existing workspaces keep theirs, and non-interactive runs use copilot", () => {
    const never = () => {
      throw new Error("must not ask");
    };
    expect(resolveInitHost(true, { host: "claude", interactive: true, ask: never })).toBe("claude");
    expect(resolveInitHost(false, { host: "copilot", ask: never })).toBe("copilot");
    expect(resolveInitHost(false, { interactive: true, ask: never })).toBeUndefined();
    expect(resolveInitHost(true, { interactive: false, ask: never })).toBe("copilot");
    expect(() => resolveInitHost(true, { host: "codex" })).toThrow(/host must be one of copilot, claude/);
  });

  it("asks until it gets a valid answer; end of input means copilot", () => {
    const answers = ["nope", "2"];
    const asked: string[] = [];
    const ask = (q: string) => {
      asked.push(q);
      return answers.shift();
    };
    expect(resolveInitHost(true, { interactive: true, ask })).toBe("claude");
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain("1) Copilot CLI (copilot)");
    expect(asked[0]).toContain("2) Claude Code (claude)");
    expect(resolveInitHost(true, { interactive: true, ask: () => undefined })).toBe("copilot");
    for (const [answer, host] of [
      ["", "copilot"],
      ["1", "copilot"],
      ["2", "claude"],
      [" Claude ", "claude"],
      ["copilot", "copilot"],
      ["3", null],
      ["x", null],
    ] as const) {
      expect(hostFromAnswer(answer), answer).toBe(host);
    }
  });

  it("CLI init without a terminal defaults to copilot, rejects bad hosts and keeps the host on re-init", () => {
    const root = tmpDir();
    const r = cli(root, ["init"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Host: Copilot CLI");
    expect(readJson<Payload>(path.join(root, "openfleet.json")).host).toBe("copilot");
    expect(cli(root, ["init", "--host", "claude"]).stdout).toContain("Host: Claude Code");
    expect(cli(root, ["init"]).stdout).toContain("Host: Claude Code");
    expect(readJson<Payload>(path.join(root, "openfleet.json")).host).toBe("claude");

    const fresh = tmpDir();
    const bad = cli(fresh, ["init", "--host", "codex"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/host must be one of copilot, claude/);
    expect(fs.existsSync(path.join(fresh, "openfleet.json"))).toBe(false);
  });
});
