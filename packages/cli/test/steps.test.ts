import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig, setConfig } from "../src/config.js";
import { readEvents } from "../src/events.js";
import { writeJson } from "../src/fsutil.js";
import { jobSessions, readJob, replyJob, runJob, startJob, waitJobs } from "../src/jobs.js";
import { parseSteps, stepPrompt, stepsHash } from "../src/steps.js";
import { newState, patchState, readState } from "../src/state.js";
import { projectPaths, type Workspace } from "../src/workspace.js";
import { gitRepo, tmpDir, workspace } from "./helpers.js";

const report = (status: string, extra = "") =>
  `\`\`\`openfleet-report\n{"status": "${status}", "child": "web", "summary": "${status} here"${extra}}\n\`\`\``;

const PLAN = `# Plan: web

## Files to change

1. \`add.js\` — add helpers.

## Steps

1. **Add mul** — \`add.js\`: add \`mul\`. Check: \`node add.js\`.
2. **Add sub** — \`add.js\`: add \`sub\`.
   Keep the exports sorted.
3. **Tests** — \`add.test.js\`: cover \`mul\` and \`sub\`.

## Risks

None.
`;

/** Fake `claude -p` (see jobs.test.ts): logs args, model and endpoint env, replays FAKE_REPLIES in order. */
function fakeClaude(dir: string): string {
  const file = path.join(dir, "fake-claude.mjs");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
import fs from "node:fs";
const log = process.env.FAKE_LOG;
const n = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).length : 0;
fs.appendFileSync(log, JSON.stringify({ args: process.argv.slice(2), base: process.env.ANTHROPIC_BASE_URL ?? null }) + "\\n");
const replies = JSON.parse(process.env.FAKE_REPLIES ?? "[]");
const reply = replies[Math.min(n, replies.length - 1)] ?? "";
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: reply }) + "\\n");
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

function setup(replies: string[], plan = PLAN) {
  const tmp = tmpDir();
  const repo = gitRepo(path.join(tmp, "web"));
  const ws: Workspace = workspace({ web: { path: repo, defaultBranch: "main" } });
  setConfig(ws, "agentMode", "session");
  setConfig(ws, "endpoints.ollama.baseUrl", "http://localhost:11434");
  setConfig(ws, "endpoints.ollama.token", "ollama");
  setConfig(ws, "models.claude.implementer", "ollama:qwen3-coder:30b");
  setConfig(ws, "split.implementer", "steps");
  const p = projectPaths(ws, "p");
  fs.mkdirSync(p.plans, { recursive: true });
  writeJson(p.state, { ...newState("p", "coord-1", "claude"), status: "running" });
  const planFile = path.join(p.plans, "web.md");
  fs.writeFileSync(planFile, plan);
  patchState(p, {
    preflight: { ok: true, at: new Date().toISOString() },
    children: { web: { repo: "web", phase: "planned", plan: planFile } },
  });
  const log = path.join(tmp, "calls.jsonl");
  const env = {
    ...process.env,
    OPENFLEET_CLAUDE_BIN: fakeClaude(tmp),
    FAKE_LOG: log,
    FAKE_REPLIES: JSON.stringify(replies),
  };
  const calls = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { args: string[]; base: string | null })
      : [];
  const arg = (call: { args: string[] }, flag: string) => call.args[call.args.indexOf(flag) + 1];
  const start = (message?: string) =>
    (
      startJob({
        ws,
        project: "p",
        child: "web",
        role: "implementer",
        detach: false,
        ...(message ? { message } : {}),
      }) as {
        job: string;
      }
    ).job;
  return { ws, p, env, calls, arg, start };
}

describe("plan steps", () => {
  it("parses the ## Steps list with titles and continuation lines", () => {
    const steps = parseSteps(PLAN);
    expect(steps.map((s) => [s.n, s.title])).toEqual([
      [1, "Add mul"],
      [2, "Add sub"],
      [3, "Tests"],
    ]);
    expect(steps[1]!.text).toMatch(/add `sub`\.\n {3}Keep the exports sorted\./);
    expect(parseSteps("# Plan\n\n1. not a step section")).toEqual([]);
    expect(stepsHash(steps)).toBe(stepsHash(parseSteps(PLAN)));
  });

  it("writes a step prompt with only that step and what came before", () => {
    const [one, two] = parseSteps(PLAN);
    const text = stepPrompt({
      child: "web",
      project: "p",
      step: two!,
      total: 3,
      done: [one!],
      assignment: "# OpenFleet assignment",
      changes: " M add.js",
    });
    expect(text).toMatch(/^Implement step 2 of 3 of the approved plan for child `web`/);
    expect(text).toContain("## Your step (2 of 3)\n\n**Add sub**");
    expect(text).toContain("1. Add mul (done)");
    expect(text).toContain(" M add.js");
    expect(text).not.toContain("Tests");
  });
});

describe("step mode", () => {
  it("needs role sessions and allows an endpoint fallback model", () => {
    const ws = workspace();
    setConfig(ws, "agentMode", "subagent");
    expect(() => setConfig(ws, "split.implementer", "steps")).toThrow(/needs role sessions/);
    setConfig(ws, "agentMode", "session");
    expect(() => setConfig(ws, "split.tester", "steps")).toThrow(/only implementer/);
    expect(() => setConfig(ws, "split.implementer", "yes")).toThrow(/must be "steps"/);
    setConfig(ws, "split.implementer", "steps");
    setConfig(ws, "endpoints.ollama.baseUrl", "http://localhost:11434");
    setConfig(ws, "models.claude.fallback", "sonnet");
    expect(readConfig(ws)).toMatchObject({
      split: { implementer: "steps" },
      models: { claude: { fallback: "sonnet" } },
    });
    setConfig(ws, "split.implementer", "");
    expect(readConfig(ws).split).toBeUndefined();
  });

  it("asks the planner for steps", () => {
    const { ws, p, env, calls } = setup([report("done")]);
    patchState(p, { children: { web: { phase: "pending" } } });
    const id = (startJob({ ws, project: "p", child: "web", role: "planner", detach: false }) as { job: string }).job;
    return runJob(ws, "p", id, env, 0).then(() => {
      expect(calls()[0]!.args[1]).toContain("## Steps (required)");
    });
  });

  it("runs each step in a fresh session on the role's endpoint and reports once", async () => {
    const { ws, p, env, calls, arg, start } = setup([report("done"), report("done"), report("done")]);
    const id = start();
    const job = await runJob(ws, "p", id, env, 0);
    expect(job.state).toBe("finished");
    const c = calls();
    expect(c).toHaveLength(3);
    const sessions = c.map((x) => arg(x, "--session-id"));
    expect(new Set(sessions).size).toBe(3);
    expect(c.every((x) => arg(x, "--model") === "qwen3-coder:30b" && x.base === "http://localhost:11434")).toBe(true);
    expect(c.map((x) => /Implement step (\d) of 3/.exec(x.args[1]!)?.[1])).toEqual(["1", "2", "3"]);
    expect(c[2]!.args[1]).toContain("1. Add mul (done)\n2. Add sub (done)");
    const w = await waitJobs(p, { timeoutMs: 0 });
    expect(w).toMatchObject({ result: "turn", report: { status: "done", child: "web", steps: 3 } });
    expect((w as { text: string }).text).toMatch(/^1\. Add mul: done here/);
    expect(
      readEvents(p)
        .filter((e) => e.type === "agent.step")
        .map((e) => e.payload.status),
    ).toEqual(["done", "done", "done"]);
    expect(readState(p).children.web?.stepsDone?.steps).toEqual([1, 2, 3]);
    // Tokens come from every step session.
    expect(jobSessions(p).map((s) => s.sessionId)).toEqual(sessions);
  });

  it("retries a failed step once, then hands it to the fallback model", async () => {
    const { ws, env, calls, arg, start } = setup([
      report("done"),
      report("failed"),
      report("failed"),
      report("done"),
      report("done"),
    ]);
    setConfig(ws, "models.claude.fallback", "sonnet");
    const job = await runJob(ws, "p", start(), env, 0);
    expect(job.result).toMatchObject({ status: "done" });
    const c = calls();
    expect(c.map((x) => arg(x, "--model"))).toEqual([
      "qwen3-coder:30b",
      "qwen3-coder:30b",
      "qwen3-coder:30b",
      "sonnet",
      "qwen3-coder:30b",
    ]);
    // The fallback session runs on the host's own provider, with the earlier failures in its prompt.
    expect(c[3]!.base).not.toBe("http://localhost:11434");
    expect(c[3]!.args[1]).toMatch(/Previous attempt of this step failed\n\nAttempt 2 \(qwen3-coder:30b\): failed here/);
    expect(job.steps?.map((s) => s.attempts)).toEqual([0, 2, 0]);
  });

  it("stops at a step that keeps failing, and the next job continues from it with the guidance", async () => {
    const { ws, p, env, calls, start } = setup([report("done"), report("failed"), report("failed")]);
    const first = await runJob(ws, "p", start(), env, 0);
    expect(first.result).toMatchObject({ status: "failed", step: 2, of: 3, done: [1] });
    expect(String(first.result?.summary)).toMatch(/^Step 2 of 3 \(Add sub\) failed after 2 attempts/);
    expect(readState(p).children.web?.stepsDone?.steps).toEqual([1]);
    patchState(p, { children: { web: { phase: "planned", retries: 1 } } });
    const again = start("Use a plain function for sub.");
    const n = calls().length;
    await runJob(ws, "p", again, { ...env, FAKE_REPLIES: JSON.stringify([report("done")]) }, 0);
    const later = calls().slice(n);
    expect(later.map((x) => /Implement step (\d)/.exec(x.args[1]!)?.[1])).toEqual(["2", "3"]);
    expect(later[0]!.args[1]).toContain("## From the coordinator\n\nUse a plain function for sub.");
    expect(later[1]!.args[1]).not.toContain("From the coordinator");
    expect(readJob(p, again).result).toMatchObject({ status: "done" });
  });

  it("returns a step's question and resumes that step's session with the answer", async () => {
    const { ws, p, env, calls, arg, start } = setup([
      report("question", ', "question": "Export default?"'),
      report("done"),
      report("done"),
      report("done"),
    ]);
    const id = start();
    await runJob(ws, "p", id, env, 0);
    expect(await waitJobs(p, { timeoutMs: 0 })).toMatchObject({
      report: { status: "question", question: "Export default?", step: 1, of: 3 },
    });
    replyJob(ws, p, id, "No, named exports.", env, false);
    const job = await runJob(ws, "p", id, env, 0);
    const c = calls();
    expect(arg(c[1]!, "--resume")).toBe(arg(c[0]!, "--session-id"));
    expect(c[1]!.args[1]).toBe("No, named exports.");
    expect(c.slice(2).map((x) => /Implement step (\d)/.exec(x.args[1]!)?.[1])).toEqual(["2", "3"]);
    expect(job.result).toMatchObject({ status: "done", steps: 3 });
  });

  it("runs as one session when the plan has no steps, or every step is done", async () => {
    const { ws, p, env, calls, start } = setup([report("done")], "# Plan: web\n\nJust do it.\n");
    await runJob(ws, "p", start(), env, 0);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.args[1]).toMatch(/^Implement the approved plan/);
    expect(readEvents(p).find((e) => e.type === "agent.spawned")?.payload.split).toBe("the plan has no ## Steps");
  });
});
