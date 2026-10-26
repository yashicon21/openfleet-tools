import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { budgetStatus } from "../src/budget.js";
import { readConfig, setConfig } from "../src/config.js";
import { readEvents } from "../src/events.js";
import { writeJson } from "../src/fsutil.js";
import { scheduleFor } from "../src/schedule.js";
import { newState, patchState, readState } from "../src/state.js";
import { projectPaths, type Workspace } from "../src/workspace.js";
import { tmpDir, workspace } from "./helpers.js";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

function cli(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A running project with two pending children, a passed preflight and a fake Copilot home. */
function running(ws: Workspace, name = "p") {
  const p = projectPaths(ws, name);
  fs.mkdirSync(p.dir, { recursive: true });
  writeJson(p.state, { ...newState(name, "sess-1"), status: "running" });
  patchState(p, {
    preflight: { ok: true, at: new Date().toISOString() },
    children: { api: { repo: "api" }, web: { repo: "web" } },
  });
  const home = tmpDir();
  const env = { COPILOT_HOME: home };
  /** Write the Copilot session transcript with `tokens` of usage. */
  const spend = (tokens: number) => {
    const dir = path.join(home, "session-state", "sess-1");
    fs.mkdirSync(dir, { recursive: true });
    const record = {
      type: "session.usage_record",
      data: { usage: { apiCallId: "call-1", model: "m", inputTokens: tokens, outputTokens: 0 } },
    };
    fs.writeFileSync(path.join(dir, "events.jsonl"), JSON.stringify(record) + "\n");
  };
  const claim = (child = "api", role = "planner") =>
    JSON.parse(cli(ws.root, ["claim", name, child, role], env).stdout) as { result: string; reason?: string };
  return { p, env, spend, claim };
}

describe("spending limits", () => {
  it("halts the run when maxTokens is reached, warning once at 80%", () => {
    const ws = workspace();
    const { p, env, spend, claim } = running(ws);
    setConfig(ws, "budget.maxTokens", "1000");
    spend(500);
    expect(claim()).toMatchObject({ result: "claimed" });
    spend(850);
    patchState(p, { children: { api: { pendingSpawn: null } } });
    expect(claim("web")).toMatchObject({ result: "claimed" });
    expect(readEvents(p).filter((e) => e.type === "budget.warning")).toHaveLength(1);
    spend(1200);
    patchState(p, { children: { api: { phase: "planned" }, web: { phase: "planned" } } });
    const stop = claim("api", "implementer");
    expect(stop).toMatchObject({ result: "stop", reason: "budget" });
    expect(readState(p).halt).toMatchObject({ reason: "budget", detail: "1.2k tokens of 1.0k tokens used" });
    expect(readEvents(p).filter((e) => e.type === "run.halted")).toHaveLength(1);
    expect(claim("web", "implementer")).toMatchObject({ result: "stop", reason: "budget" });
    expect(readEvents(p).filter((e) => e.type === "run.halted")).toHaveLength(1);
    expect(budgetStatus(ws, p, readState(p), env)).toMatchObject({ tokens: 1200, limits: { maxTokens: 1000 } });
    const status = cli(ws.root, ["status", "p"], env).stdout;
    expect(status).toMatch(/Halted \(budget\): 1\.2k tokens of 1\.0k tokens used\./);
    expect(status).toMatch(/Budget: 1200 of 1000 tokens\./);
  });

  it("lets a project override the workspace limit and prices maxCost", () => {
    const ws = workspace();
    const { p, env, spend, claim } = running(ws);
    setConfig(ws, "budget.maxTokens", "100");
    patchState(p, { budget: { maxTokens: 10_000 } });
    spend(5000);
    expect(claim()).toMatchObject({ result: "claimed" });
    fs.writeFileSync(
      ws.marker,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(ws.marker, "utf8")),
        pricing: { m: { input: 1000, output: 0, cacheRead: 0 } },
      }),
    );
    patchState(p, { budget: { maxCost: 4 } });
    expect(budgetStatus(ws, p, readState(p), env)).toMatchObject({ cost: 5, over: "$5.00 of $4.00 used" });
  });

  it("validates budget settings", () => {
    const ws = workspace();
    expect(() => setConfig(ws, "budget.maxTokens", "1.5")).toThrow(/positive integer/);
    expect(() => setConfig(ws, "budget.maxCost", "-1")).toThrow(/positive number \(USD\)/);
    expect(() => setConfig(ws, "budget.maxHours", "1")).toThrow(/Unknown budget setting/);
    expect(() => setConfig(ws, "budget", "1")).toThrow(/one budget limit at a time/);
    setConfig(ws, "budget.maxCost", "12.5");
    expect(readConfig(ws).budget).toEqual({ maxCost: 12.5 });
  });

  it("reads nothing and never halts without limits", () => {
    const ws = workspace();
    const { spend, claim } = running(ws);
    spend(10_000_000);
    expect(claim()).toMatchObject({ result: "claimed" });
  });
});

describe("pause, cancel and resume", () => {
  function fakeCopilot(): Record<string, string> {
    const dir = tmpDir();
    const bin = path.join(dir, "fake-copilot.mjs");
    fs.writeFileSync(bin, "#!/usr/bin/env node\n");
    fs.chmodSync(bin, 0o755);
    return { OPENFLEET_COPILOT_BIN: bin };
  }

  it("pause halts spawns and every coordinator's next; resume continues", () => {
    const ws = workspace();
    const { p, env, claim } = running(ws);
    const r = cli(ws.root, ["pause", "p", "--reason", "lunch"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Paused project p\. Nothing new will be spawned/);
    expect(cli(ws.root, ["pause", "p"]).stderr).toMatch(/already halted \(paused\)/);
    expect(claim()).toMatchObject({ result: "stop", reason: "paused" });
    const state = readState(p);
    expect(state).toMatchObject({ status: "running", halt: { reason: "paused", detail: "lunch" } });
    expect(scheduleFor(state).actions).toEqual([{ owner: "top", action: "halt", reason: "paused", detail: "lunch" }]);
    expect(scheduleFor(state, "web").actions).toEqual([
      { owner: "top", action: "halt", reason: "paused", detail: "lunch" },
    ]);
    expect(cli(ws.root, ["resume", "p"], { ...env, ...fakeCopilot() }).code).toBe(0);
    expect(readState(p).halt).toBeUndefined();
    expect(readEvents(p).map((e) => e.type)).toEqual(expect.arrayContaining(["run.halted", "run.resumed"]));
  });

  it("cancel wins over an earlier halt and refuses repeats", () => {
    const ws = workspace();
    const { p, spend, claim } = running(ws);
    setConfig(ws, "budget.maxTokens", "10");
    spend(50);
    expect(claim()).toMatchObject({ result: "stop", reason: "budget" });
    expect(cli(ws.root, ["cancel", "p", "--reason", "wrong repo"]).code).toBe(0);
    const s = readState(p);
    expect(s).toMatchObject({
      status: "cancelled",
      halt: { reason: "cancelled", detail: "wrong repo", from: "running" },
    });
    expect(cli(ws.root, ["cancel", "p"]).stderr).toMatch(/already cancelled/);
    expect(cli(ws.root, ["pause", "p"]).stderr).toMatch(/already cancelled/);
  });

  it("resume refuses a cancelled project unless --reopen, which restores its status", () => {
    const ws = workspace();
    const { p } = running(ws);
    cli(ws.root, ["cancel", "p"]);
    const env = fakeCopilot();
    expect(cli(ws.root, ["resume", "p"], env).stderr).toMatch(
      /was cancelled\. Resume it anyway with `npx openfleet resume p --reopen`/,
    );
    expect(cli(ws.root, ["resume", "p", "--reopen"], env).code).toBe(0);
    expect(readState(p)).toMatchObject({ status: "running" });
    expect(readState(p).halt).toBeUndefined();
  });

  it("frees the workspace slots of a cancelled project", () => {
    const ws = workspace();
    setConfig(ws, "maxParallel", "1");
    const a = running(ws, "a");
    const b = running(ws, "b");
    expect(a.claim()).toMatchObject({ result: "claimed" });
    expect(b.claim()).toMatchObject({ result: "wait" });
    cli(ws.root, ["cancel", "a"]);
    expect(b.claim()).toMatchObject({ result: "claimed" });
  });
});

describe("report", () => {
  it("shows the limits against usage, the halts and warnings, and a halted header", () => {
    const ws = workspace();
    const { env, spend, claim } = running(ws);
    setConfig(ws, "budget.maxTokens", "1000");
    spend(900);
    expect(claim()).toMatchObject({ result: "claimed" });
    spend(1500);
    expect(claim("web", "tester")).toMatchObject({ result: "stop" });
    const out = path.join(tmpDir(), "r.html");
    expect(cli(ws.root, ["report", "p", "--out", out], env).code).toBe(0);
    const html = fs.readFileSync(out, "utf8");
    expect(html).toContain("<h3>Spending limits</h3>");
    expect(html).toMatch(/<td>Tokens<\/td><td class="n">1\.5k<\/td><td class="n">1\.0k<\/td><td class="n">150%<\/td>/);
    expect(html).toMatch(/Spending warning \(80% of a limit\): 900 tokens of 1\.0k tokens used/);
    expect(html).toMatch(/Halted: spending limit reached: 1\.5k tokens of 1\.0k tokens used/);
    expect(html).toContain("running, halted (spending limit reached)");
  });
});
