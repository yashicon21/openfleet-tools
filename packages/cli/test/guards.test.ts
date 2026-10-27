import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setConfig } from "../src/config.js";
import { readEvents } from "../src/events.js";
import { writeJson } from "../src/fsutil.js";
import { formatOutput } from "../src/hooks/adapters.js";
import { onSubagentStart, resolveContext, type HookContext } from "../src/hooks/handlers.js";
import { onPreToolUse } from "../src/hooks/guards.js";
import { newState, patchState, readState } from "../src/state.js";
import { projectPaths, type Workspace } from "../src/workspace.js";
import { gitRepo, tmpDir, workspace } from "./helpers.js";

function setup(mode: "session" | "subagent" = "session") {
  const tmp = tmpDir();
  const repo = gitRepo(path.join(tmp, "web"));
  const ws: Workspace = workspace({ web: { path: repo, defaultBranch: "main" } });
  setConfig(ws, "agentMode", mode);
  const p = projectPaths(ws, "p");
  fs.mkdirSync(p.dir, { recursive: true });
  writeJson(p.state, { ...newState("p", "coord-1", "claude"), status: "running" });
  const wt = path.join(p.worktrees, "web");
  fs.mkdirSync(wt, { recursive: true });
  patchState(p, { children: { web: { repo: "web", phase: "implementing", worktree: wt } } });
  const ctx: HookContext = { ws, project: "p" };
  const refused = () => readEvents(p).filter((e) => e.type === "guard.refused");
  return { ws, p, wt, repo, ctx, refused };
}

const write = (file: string) => ({ toolName: "Write", toolArgs: { file_path: file, content: "x\n" } });

describe("finalize guard", () => {
  it("refuses finalizing or done while children are unfinished, unless the run is halted", () => {
    const { p } = setup();
    expect(() => patchState(p, { status: "finalizing" })).toThrow(/cannot be finalizing yet.*web \(implementing\)/);
    patchState(p, { children: { web: { phase: "blocked", blockedReason: "needs-escalation" } } });
    expect(() => patchState(p, { status: "done" })).toThrow(/web \(blocked\)/);
    patchState(p, { children: { web: { phase: "failed" } } });
    expect(patchState(p, { status: "finalizing" }).status).toBe("finalizing");
  });

  it("allows a halted run to stop early", () => {
    const { p } = setup();
    patchState(p, { halt: { reason: "paused", at: new Date().toISOString() } });
    expect(patchState(p, { status: "done" }).status).toBe("done");
  });

  it("denies writing summary.md before finalize", () => {
    const { p, ctx, refused } = setup();
    const summary = path.join(p.dir, "summary.md");
    expect(onPreToolUse(ctx, write(summary)).deny).toMatch(/summary is written at finalize.*web \(implementing\)/);
    expect(refused()[0]).toMatchObject({ actor: "coordinator", payload: { guard: "summary" } });
    patchState(p, { halt: { reason: "budget", at: new Date().toISOString() } });
    expect(onPreToolUse(ctx, write(summary))).toEqual({});
  });
});

describe("greenfield kind guard", () => {
  it("refuses registering a greenfield child without a kind", () => {
    const { p } = setup();
    patchState(p, { greenfield: true });
    expect(() => patchState(p, { children: { "web:api": { repo: "web" } } })).toThrow(
      /Greenfield children need a kind \(setup, contracts, service, frontend, system\): web:api/,
    );
    expect(patchState(p, { children: { "web:api": { repo: "web", kind: "service" } } }).children["web:api"]?.kind).toBe(
      "service",
    );
    // Patching an existing child without repeating its kind is fine.
    expect(() => patchState(p, { children: { "web:api": { notes: "x" } } })).not.toThrow();
  });
});

describe("spawn guard", () => {
  const spawn = (agent: string) => ({ toolName: "Agent", toolArgs: { subagent_type: agent, prompt: "go" } });

  it("in session mode, refuses role subagents but allows a claimed repo coordinator", () => {
    const { p, ctx, refused } = setup("session");
    expect(onPreToolUse(ctx, spawn("openfleet:openfleet-implementer")).deny).toMatch(
      /runs as its own session here.*agent start p <child> --role implementer/,
    );
    expect(refused()[0]?.payload).toMatchObject({ guard: "spawn", agent: "openfleet-implementer" });
    patchState(p, {
      children: {
        "app/a": { repo: "app", paths: ["a/**"] },
        "app/b": { repo: "app", paths: ["b/**"] },
      },
    });
    expect(onPreToolUse(ctx, spawn("openfleet:openfleet-repo-coordinator")).deny).toMatch(/no child is claimed/);
    patchState(p, { children: { app: { pendingSpawn: "repo-coordinator", claimedAt: new Date().toISOString() } } });
    expect(onPreToolUse(ctx, spawn("openfleet:openfleet-repo-coordinator"))).toEqual({});
  });

  it("in subagent mode, refuses an unclaimed role spawn and logs it as unknown/<role>", () => {
    const { p, ctx, refused } = setup("subagent");
    expect(
      onPreToolUse(ctx, { toolName: "task", toolArgs: { agent_type: "openfleet:openfleet-tester" } }).deny,
    ).toMatch(/no child is claimed for tester.*claim p <child> tester/);
    expect(refused()[0]?.actor).toBe("unknown/tester");
    patchState(p, { children: { web: { pendingSpawn: "tester", claimedAt: new Date().toISOString() } } });
    expect(onPreToolUse(ctx, spawn("openfleet:openfleet-tester"))).toEqual({});
    // Other agents are not OpenFleet's business.
    expect(onPreToolUse(ctx, spawn("Explore"))).toEqual({});
  });

  it("logs guard.refused when a role subagent starts without a claim", () => {
    const { p, ctx } = setup("subagent");
    onSubagentStart(ctx, { agentName: "openfleet:openfleet-planner", agentId: "a1" });
    expect(readEvents(p).find((e) => e.type === "guard.refused")).toMatchObject({
      actor: "unknown/planner",
      payload: { guard: "claim" },
    });
  });
});

describe("worktree guard", () => {
  it("keeps a role session's writes inside its worktree (and temp files)", () => {
    const { ws, p, wt, refused } = setup();
    const ctx = resolveContext(
      { cwd: ws.root },
      {
        OPENFLEET_WORKSPACE: ws.root,
        OPENFLEET_PROJECT: "p",
        OPENFLEET_JOB: "j-0001-impl-web",
        OPENFLEET_ROLE: "implementer",
        OPENFLEET_CHILD: "web",
      },
    )!;
    expect(onPreToolUse(ctx, write(path.join(wt, "src/a.ts")))).toEqual({});
    expect(onPreToolUse(ctx, write(path.join(fs.realpathSync(os.tmpdir()), "scratch.txt")))).toEqual({});
    expect(onPreToolUse(ctx, write(path.join(ws.repos, "web", "a.ts"))).deny).toMatch(
      /web\/implementer may change files only inside its worktree/,
    );
    expect(onPreToolUse(ctx, write(path.join(p.dir, "state.json"))).deny).toMatch(/only inside its worktree/);
    expect(refused().map((e) => e.actor)).toEqual(["web/implementer", "web/implementer"]);
  });

  it("applies to role subagents by their recorded id", () => {
    const { p, ctx } = setup("subagent");
    patchState(p, { children: { web: { agentIds: { implementer: "agent-7" } } } });
    const other = path.join(p.dir, "notes.md");
    expect(onPreToolUse(ctx, { ...write(other), agentId: "agent-7" }).deny).toMatch(/only inside its worktree/);
  });

  it("refuses coordinator writes into repos, local repos and worktrees, not into project files", () => {
    const { ws, p, wt, repo, ctx } = setup();
    expect(onPreToolUse(ctx, write(path.join(repo, "src/x.ts"))).deny).toMatch(/coordinators never edit code/);
    expect(onPreToolUse(ctx, write(path.join(ws.repos, "expenses", "index.ts"))).deny).toMatch(/never edit code/);
    expect(onPreToolUse(ctx, write(path.join(wt, "a.ts"))).deny).toMatch(/never edit code/);
    expect(onPreToolUse(ctx, write(path.join(p.dir, "spec.md")))).toEqual({});
    expect(onPreToolUse(ctx, write(path.join(p.plans, "web.md")))).toEqual({});
    expect(readState(p).children.web?.phase).toBe("implementing");
  });
});

describe("preToolUse output", () => {
  it("formats a denial for each host and stays silent otherwise", () => {
    expect(JSON.parse(formatOutput("claude", "preToolUse", { deny: "no" })!)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" },
    });
    expect(JSON.parse(formatOutput("copilot", "preToolUse", { deny: "no" })!)).toEqual({
      permissionDecision: "deny",
      permissionDecisionReason: "no",
    });
    expect(formatOutput("claude", "preToolUse", {})).toBeUndefined();
  });

  it("denies through the installed Claude Code hook", () => {
    const { ws, p } = setup();
    const main = path.join(ws.core, "lib", "hooks", "main.js");
    const payload = {
      session_id: "coord-1",
      cwd: ws.root,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: path.join(p.dir, "summary.md"), content: "# Summary\n" },
    };
    const r = spawnSync(process.execPath, [main, "claude", "preToolUse"], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, OPENFLEET_WORKSPACE: ws.root, OPENFLEET_PROJECT: "p" },
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
});
