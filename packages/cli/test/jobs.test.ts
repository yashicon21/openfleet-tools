import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { setConfig } from "../src/config.js";
import { readEvents } from "../src/events.js";
import { writeJson } from "../src/fsutil.js";
import { onPostToolUse, resolveContext } from "../src/hooks/handlers.js";
import {
  jobEnv,
  listJobs,
  parseReport,
  readJob,
  replyJob,
  runJob,
  startJob,
  stopJob,
  sweepLost,
  turnArgs,
  turnText,
  updateJob,
  waitJobs,
} from "../src/jobs.js";
import { readTokenUsage } from "../src/report/tokens.js";
import { newState, patchState, readState, updateState } from "../src/state.js";
import { projectPaths, type Workspace } from "../src/workspace.js";
import { gitRepo, tmpDir, workspace } from "./helpers.js";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

function cli(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const report = (status: string, extra = "") =>
  `Done.\n\n\`\`\`openfleet-report\n{"status": "${status}", "child": "web", "summary": "ok"${extra}}\n\`\`\``;

/**
 * Fake `claude -p`: logs each call (args and the env OpenFleet sets) to FAKE_LOG and prints the
 * next reply from FAKE_REPLIES as `--output-format json`. A reply "CRASH" exits 1 with no output;
 * "SLEEP" waits 30 s (to be stopped).
 */
function fakeClaude(dir: string): string {
  const file = path.join(dir, "fake-claude.mjs");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
import fs from "node:fs";
const log = process.env.FAKE_LOG;
const n = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).length : 0;
const pick = (k) => process.env[k] ?? null;
fs.appendFileSync(log, JSON.stringify({ args: process.argv.slice(2), env: Object.fromEntries(["OPENFLEET_JOB","OPENFLEET_ROLE","OPENFLEET_CHILD","OPENFLEET_PROJECT","ANTHROPIC_BASE_URL","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_API_KEY","ANTHROPIC_DEFAULT_HAIKU_MODEL","CLAUDECODE"].map((k) => [k, pick(k)])) }) + "\\n");
const replies = JSON.parse(process.env.FAKE_REPLIES ?? "[]");
const reply = replies[Math.min(n, replies.length - 1)] ?? "";
if (reply === "CRASH") process.exit(1);
if (reply === "SLEEP") await new Promise((r) => setTimeout(r, 30000));
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: reply, session_id: "x" }) + "\\n");
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

/** A session-mode workspace with a running Claude project whose child `web` is planned. */
function setup(replies: string[] = [report("done")]) {
  const tmp = tmpDir();
  const repo = gitRepo(path.join(tmp, "web"));
  const ws: Workspace = workspace({ web: { path: repo, defaultBranch: "main" } });
  setConfig(ws, "agentMode", "session");
  const p = projectPaths(ws, "p");
  fs.mkdirSync(p.dir, { recursive: true });
  writeJson(p.state, { ...newState("p", "coord-1", "claude"), status: "running" });
  patchState(p, {
    preflight: { ok: true, at: new Date().toISOString() },
    children: { web: { repo: "web", phase: "planned" } },
  });
  const log = path.join(tmp, "calls.jsonl");
  const env = {
    ...process.env,
    OPENFLEET_CLAUDE_BIN: fakeClaude(tmp),
    FAKE_LOG: log,
    FAKE_REPLIES: JSON.stringify(replies),
    CLAUDECODE: "1",
    CLAUDE_CONFIG_DIR: path.join(tmp, "claude-home"),
  };
  const calls = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { args: string[]; env: Record<string, string | null> })
      : [];
  return { ws, p, env, calls, tmp };
}

describe("role session jobs", () => {
  it("starts a job: claims the child, logs agent.spawned, runs one turn and records the report", async () => {
    const { ws, p, env, calls } = setup();
    const res = startJob({ ws, project: "p", child: "web", role: "implementer", message: "Fix X.", detach: false });
    expect(res).toMatchObject({ result: "started", child: "web", role: "implementer", host: "claude" });
    const id = (res as { job: string }).job;
    expect(id).toBe("j-0001-impl-web");
    const child = readState(p).children.web!;
    expect(child).toMatchObject({ phase: "implementing", role: "implementer" });
    expect(child.pendingSpawn).toBeUndefined();
    expect(child.agentIds.implementer).toBe(id);
    const job = await runJob(ws, "p", id, env, 0);
    expect(job.state).toBe("finished");
    expect(job.turns[0]!.report).toMatchObject({ status: "done", child: "web" });
    const [call] = calls();
    expect(call!.args.slice(0, 2)[0]).toBe("-p");
    expect(call!.args[1]).toMatch(/Implement the approved plan for child `web`/);
    expect(call!.args[1]).toMatch(/# OpenFleet assignment/);
    expect(call!.args[1]).toMatch(/## From the coordinator\n\nFix X\./);
    expect(call!.args).toEqual(
      expect.arrayContaining(["--agent", "openfleet:openfleet-implementer", "--session-id", job.sessionId]),
    );
    expect(call!.env).toMatchObject({
      OPENFLEET_JOB: id,
      OPENFLEET_ROLE: "implementer",
      OPENFLEET_CHILD: "web",
      CLAUDECODE: null,
    });
    const types = readEvents(p).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["agent.spawned", "agent.turn", "agent.stopped"]));
    const stopped = readEvents(p).find((e) => e.type === "agent.stopped")!;
    expect(stopped.actor).toBe("web/implementer");
    expect(stopped.payload).toMatchObject({ jobId: id, state: "finished" });
    const w = await waitJobs(p, { timeoutMs: 0 });
    expect(w).toMatchObject({ result: "turn", job: id, report: { status: "done" } });
    expect(await waitJobs(p, { timeoutMs: 0 })).toEqual({ result: "idle" });
  });

  it("returns claim results unchanged and refuses when sessions are off", () => {
    const { ws, p } = setup();
    patchState(p, { children: { web: { phase: "done" } } });
    expect(() => startJob({ ws, project: "p", child: "web", role: "tester", detach: false })).toThrow(/is "done"/);
    patchState(p, {
      children: { web: { phase: "planned" } },
      halt: { reason: "paused", at: new Date().toISOString() },
    });
    expect(startJob({ ws, project: "p", child: "web", role: "tester", detach: false })).toMatchObject({
      result: "stop",
      reason: "paused",
    });
    expect(listJobs(p)).toHaveLength(0);
    expect(() => startJob({ ws, project: "p", child: "web", role: "repo-coordinator", detach: false })).toThrow(
      /repo coordinators stay subagents/,
    );
    setConfig(ws, "agentMode", "subagent");
    expect(() => startJob({ ws, project: "p", child: "web", role: "tester", detach: false })).toThrow(
      /Role sessions are off/,
    );
  });

  it("nudges once for a missing report, retries a crashed turn once, and resumes the session", async () => {
    const { ws, env, calls } = setup(["CRASH", "no block here", report("done")]);
    const id = (startJob({ ws, project: "p", child: "web", role: "tester", detach: false }) as { job: string }).job;
    const job = await runJob(ws, "p", id, env, 0);
    expect(job.state).toBe("finished");
    expect(job.turns).toHaveLength(3);
    const c = calls();
    // The crash made no session, so the retry creates it; the nudge resumes it.
    expect(c[0]!.args).toContain("--session-id");
    expect(c[1]!.args).toContain("--session-id");
    expect(c[2]!.args).toContain("--resume");
    expect(c[2]!.args[1]).toMatch(/without an `openfleet-report` block/);
  });

  it("fails a job whose turns never report", async () => {
    const { ws, env } = setup(["nothing", "still nothing"]);
    const id = (startJob({ ws, project: "p", child: "web", role: "tester", detach: false }) as { job: string }).job;
    expect((await runJob(ws, "p", id, env, 0)).state).toBe("failed");
  });

  it("answers a question with reply: the same session gets the next turn", async () => {
    const { ws, p, env, calls } = setup([report("question", ', "question": "Which port?"'), report("done")]);
    const id = (startJob({ ws, project: "p", child: "web", role: "planner", detach: false }) as { job: string }).job;
    await runJob(ws, "p", id, env, 0);
    const q = await waitJobs(p, { timeoutMs: 0 });
    expect(q).toMatchObject({ result: "turn", report: { status: "question", question: "Which port?" } });
    expect(replyJob(ws, p, id, "Use 4000.", env, false)).toEqual({ result: "started", job: id });
    await runJob(ws, "p", id, env, 0);
    const c = calls();
    expect(c[1]!.args).toEqual(expect.arrayContaining(["--resume", readJob(p, id).sessionId]));
    expect(c[1]!.args[1]).toBe("Use 4000.");
    expect(readJob(p, id)).toMatchObject({ state: "finished", unread: true });
    expect(readEvents(p).some((e) => e.type === "message.sent" && e.payload.text === "Use 4000.")).toBe(true);
  });

  it("queues a reply to a running job for its next turn", () => {
    const { ws, p } = setup();
    const id = (startJob({ ws, project: "p", child: "web", role: "tester", detach: false }) as { job: string }).job;
    expect(replyJob(ws, p, id, "Contract changed: use v2.", undefined, false)).toEqual({ result: "queued", job: id });
    expect(readJob(p, id).queue).toHaveLength(2);
  });

  it("marks jobs whose runner died as lost, and reply resumes them", () => {
    const { ws, p } = setup();
    const id = (startJob({ ws, project: "p", child: "web", role: "implementer", detach: false }) as { job: string })
      .job;
    updateJob(p, id, (j) => {
      j.runnerPid = 999_999_999;
      j.queue = [];
      j.turns.push({ n: 1, startedAt: new Date().toISOString(), text: "partial" });
    });
    expect(sweepLost(p).map((j) => j.id)).toEqual([id]);
    expect(readEvents(p).filter((e) => e.type === "agent.lost")).toHaveLength(1);
    expect(sweepLost(p)).toEqual([]);
    expect(replyJob(ws, p, id, "Continue.", undefined, false).result).toBe("started");
    expect(turnArgs(ws, readJob(p, id), "Continue.", false)).toContain("--resume");
  });

  it("runs through the CLI: start returns at once, wait collects the turn, cancel stops running jobs", () => {
    const { ws, p, env } = setup([report("done")]);
    const started = cli(ws.root, ["agent", "start", "p", "web", "--role", "implementer"], env);
    expect(started.code).toBe(0);
    const id = (JSON.parse(started.stdout) as { job: string }).job;
    const waited = cli(ws.root, ["agent", "wait", "p", "--timeout", "20"], env);
    expect(waited.code).toBe(0);
    expect(JSON.parse(waited.stdout)).toMatchObject({ result: "turn", job: id, state: "finished" });
    expect((JSON.parse(cli(ws.root, ["agent", "status", "p"], env).stdout) as { jobs: unknown[] }).jobs).toHaveLength(
      1,
    );
    // A long turn, stopped by cancel.
    const slow = { ...env, FAKE_REPLIES: JSON.stringify(["SLEEP"]), FAKE_LOG: path.join(ws.root, "slow.jsonl") };
    const second = JSON.parse(cli(ws.root, ["agent", "start", "p", "web", "--role", "tester"], slow).stdout) as {
      job: string;
    };
    const deadline = Date.now() + 10_000;
    while (!readJob(p, second.job).hostPid && Date.now() < deadline) spawnSync("sleep", ["0.1"]);
    const cancel = cli(ws.root, ["cancel", "p"], env);
    expect(cancel.stdout).toMatch(new RegExp(`Stopped role sessions: ${second.job}`));
    expect(readJob(p, second.job).state).toBe("stopped");
    expect(readEvents(p).some((e) => e.type === "agent.stopped" && e.payload.stopped === true)).toBe(true);
  }, 30_000);

  it("stop on a finished job changes nothing", async () => {
    const { ws, p, env } = setup();
    const id = (startJob({ ws, project: "p", child: "web", role: "tester", detach: false }) as { job: string }).job;
    await runJob(ws, "p", id, env, 0);
    expect(stopJob(ws, p, id).state).toBe("finished");
  });

  it("gives an endpoint role its endpoint env", () => {
    const { ws, p } = setup();
    setConfig(ws, "endpoints.ollama.baseUrl", "http://localhost:11434");
    setConfig(ws, "endpoints.ollama.token", "ollama");
    setConfig(ws, "models.claude.implementer", "ollama:qwen3-coder:30b");
    const res = startJob({ ws, project: "p", child: "web", role: "implementer", detach: false });
    expect(res).toMatchObject({ endpoint: "ollama", model: "qwen3-coder:30b" });
    const job = readJob(p, (res as { job: string }).job);
    const env = jobEnv(ws, job, { ANTHROPIC_API_KEY: "sk-real", CLAUDE_CODE_USE_BEDROCK: "1" });
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://localhost:11434",
      ANTHROPIC_AUTH_TOKEN: "ollama",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3-coder:30b",
    });
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(turnArgs(ws, job, "x", true)).toEqual(expect.arrayContaining(["--model", "qwen3-coder:30b"]));
  });

  it("runs a role on Copilot with copilot -p args", () => {
    const { ws, p } = setup();
    updateState(p, (st) => {
      st.host = "copilot";
    });
    const id = (startJob({ ws, project: "p", child: "web", role: "tester", detach: false }) as { job: string }).job;
    const args = turnArgs(ws, readJob(p, id), "Verify.", true);
    expect(args.slice(0, 2)).toEqual(["-p", "Verify."]);
    expect(args).toEqual(expect.arrayContaining(["--agent", "openfleet:openfleet-tester", "--allow-all-tools"]));
  });

  it("attributes a role session's file edits by its env, and reads its tokens as that role", async () => {
    const { ws, p, env } = setup();
    const id = (startJob({ ws, project: "p", child: "web", role: "implementer", detach: false }) as { job: string })
      .job;
    await runJob(ws, "p", id, env, 0);
    const job = readJob(p, id);
    const wt = path.join(p.worktrees, "web");
    fs.mkdirSync(wt, { recursive: true });
    patchState(p, { children: { web: { worktree: wt, role: "tester" } } });
    const ctx = resolveContext(
      { cwd: ws.root },
      {
        OPENFLEET_WORKSPACE: ws.root,
        OPENFLEET_PROJECT: "p",
        OPENFLEET_JOB: id,
        OPENFLEET_ROLE: "implementer",
        OPENFLEET_CHILD: "web",
      },
    )!;
    expect(ctx.job).toEqual({ id, role: "implementer", child: "web" });
    onPostToolUse(ctx, {
      toolName: "Write",
      toolArgs: { file_path: path.join(wt, "a.ts"), content: "x\n" },
      cwd: ws.root,
    });
    expect(readEvents(p).find((e) => e.type === "file.added")?.actor).toBe("web/implementer");
    // Tokens: the job's main transcript counts for its role.
    const dir = path.join(env.CLAUDE_CONFIG_DIR, "projects", ws.root.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    const line = {
      type: "assistant",
      message: { id: "m1", model: "qwen3-coder:30b", usage: { input_tokens: 10, output_tokens: 5 } },
    };
    fs.writeFileSync(path.join(dir, `${job.sessionId}.jsonl`), JSON.stringify(line) + "\n");
    const tokens = readTokenUsage({
      host: "claude",
      cwd: ws.root,
      sessionIds: [],
      jobs: [{ host: "claude", sessionId: job.sessionId, role: "implementer" }],
      env: { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR },
    });
    expect(tokens?.byRole.implementer?.input).toBe(10);
    expect(tokens?.byRole.coordinator).toBeUndefined();
  });
});

describe("job ownership and plans", () => {
  it("wait returns only the caller's jobs: repo coordinators pass --repo", async () => {
    const { ws, p, env } = setup();
    // Two children in one repo get an integration child and a repo coordinator.
    patchState(p, {
      children: {
        "app/home": { repo: "app", paths: ["src/home/**"], phase: "planned" },
        "app/about": { repo: "app", paths: ["src/about/**"], phase: "planned" },
      },
    });
    const top = (startJob({ ws, project: "p", child: "web", role: "tester", detach: false }) as { job: string }).job;
    const repo = (startJob({ ws, project: "p", child: "app/home", role: "tester", detach: false }) as { job: string })
      .job;
    expect(readJob(p, repo).owner).toBe("app");
    await runJob(ws, "p", repo, env, 0);
    expect(await waitJobs(p, { timeoutMs: 0 })).toMatchObject({ result: "timeout", running: [top] });
    expect(await waitJobs(p, { owner: "app", timeoutMs: 0 })).toMatchObject({ result: "turn", job: repo });
  });

  it("result --out saves the final text without its report block", async () => {
    const plan = "# Plan: web\n\n1. Do it.";
    const { ws, p, env } = setup([`${plan}\n\n\`\`\`openfleet-report\n{"status": "done"}\n\`\`\``]);
    const id = (startJob({ ws, project: "p", child: "web", role: "planner", detach: false }) as { job: string }).job;
    await runJob(ws, "p", id, env, 0);
    const file = path.join(p.plans, "web.md");
    const r = cli(ws.root, ["agent", "result", "p", id, "--out", file], env);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(`${plan}\n`);
  });
});

describe("job helpers", () => {
  it("parses the last report block and Claude's json output", () => {
    expect(parseReport(`a\n${report("question")}\nb\n${report("done")}`)?.status).toBe("done");
    expect(parseReport("```openfleet-report\nnot json\n```")).toBeUndefined();
    expect(turnText("claude", '{"type":"result","result":"hi","is_error":false}\n')).toEqual({ text: "hi" });
    expect(turnText("claude", '{"type":"result","result":"","is_error":true,"subtype":"error_max_turns"}')).toEqual({
      text: "",
      error: "error_max_turns",
    });
    expect(turnText("copilot", " plain \n")).toEqual({ text: "plain" });
  });
});
