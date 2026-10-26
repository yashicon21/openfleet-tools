import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePricing } from "../src/config.js";
import type { OpenFleetEvent } from "../src/events.js";
import { writeJson } from "../src/fsutil.js";
import { buildModel, deriveModel, generateReport, renderReport } from "../src/report/index.js";
import { specAsk, summarySections } from "../src/report/markdown.js";
import { activeMs, agentRuns, childSegments, concurrency, findGaps, makeAxis } from "../src/report/timeline.js";
import { aggregate, claudeMessages, copilotMessages, costOf, readTokenUsage } from "../src/report/tokens.js";
import type { ProjectState } from "../src/state.js";
import { tmpDir, workspace } from "./helpers.js";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/report-run", import.meta.url));
const MIN = 60_000;
const T0 = Date.parse("2026-01-01T10:00:00.000Z");

let seq = 0;
function ev(
  min: number,
  type: string,
  target: string | null,
  payload: Record<string, unknown> = {},
  actor = "coordinator",
): OpenFleetEvent {
  return { v: 1, ts: new Date(T0 + min * MIN).toISOString(), seq: ++seq, actor, type, target, payload };
}
const phase = (min: number, child: string, to: string) =>
  ev(min, "phase.changed", child, { scope: "child", from: null, to });

function state(
  children: Record<string, Partial<ProjectState["children"][string]>>,
  extra: Partial<ProjectState> = {},
): ProjectState {
  return {
    v: 1,
    name: "demo",
    status: "done",
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    host: "claude",
    children,
    ...extra,
  } as ProjectState;
}

/** Workspace with the anonymized fixture run copied in as project `demo-run`. */
function fixtureWorkspace(config: Record<string, unknown> = {}) {
  const ws = workspace();
  const dir = path.join(ws.root, "projects", "demo-run");
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const cfgFile = path.join(ws.root, "openfleet.json");
  writeJson(cfgFile, { ...(JSON.parse(fs.readFileSync(cfgFile, "utf8")) as object), ...config });
  return { ws, dir };
}

describe("report timeline", () => {
  it("finds gaps longer than the threshold and reports active time", () => {
    const times = [0, 5, 10, 40, 41, 120].map((m) => T0 + m * MIN);
    const gaps = findGaps(times, 15 * MIN);
    expect(gaps).toEqual([
      { start: T0 + 10 * MIN, end: T0 + 40 * MIN },
      { start: T0 + 41 * MIN, end: T0 + 120 * MIN },
    ]);
    expect(activeMs(T0, T0 + 120 * MIN, gaps)).toBe(11 * MIN);
    expect(findGaps(times, 120 * MIN)).toEqual([]);
  });

  it("collapses each gap on the axis into a small band", () => {
    const gaps = [{ start: T0 + 10 * MIN, end: T0 + 250 * MIN }];
    const ax = makeAxis(T0, T0 + 260 * MIN, gaps);
    expect(ax.frac(T0)).toBe(0);
    expect(ax.frac(T0 + 260 * MIN)).toBeCloseTo(1);
    const band = ax.frac(T0 + 250 * MIN) - ax.frac(T0 + 10 * MIN);
    // 20 active minutes with one 4% band: the 4-hour pause takes under 5% of the axis.
    expect(band).toBeLessThan(0.05);
    expect(ax.frac(T0 + 5 * MIN)).toBeCloseTo(ax.frac(T0 + 260 * MIN) - ax.frac(T0 + 255 * MIN));
  });

  it("derives per-child phase segments", () => {
    const events = [
      phase(0, "r/a", "pending"),
      phase(2, "r/a", "planning"),
      phase(5, "r/a", "implementing"),
      phase(9, "r/a", "done"),
      phase(1, "r/b", "planning"),
      ev(3, "phase.changed", null, { scope: "project", from: null, to: "running" }),
    ].sort((a, b) => a.ts.localeCompare(b.ts));
    const segs = childSegments(events, T0 + 20 * MIN);
    // A final phase ends the bar; a non-final last phase stays open to the end of the data.
    expect(segs.get("r/a")?.map((s) => [s.phase, (s.start - T0) / MIN, (s.end - T0) / MIN, Boolean(s.open)])).toEqual([
      ["pending", 0, 2, false],
      ["planning", 2, 5, false],
      ["implementing", 5, 9, false],
    ]);
    expect(segs.get("r/b")).toEqual([{ phase: "planning", start: T0 + MIN, end: T0 + 20 * MIN, open: true }]);
    expect(segs.has("null")).toBe(false);
  });

  it("matches agent stops by id, infers missing stops and counts agents at once", () => {
    const name = (role: string) => `openfleet:openfleet-${role}`;
    const events = [
      ev(0, "session.started", null, { sessionId: "s1" }),
      ev(1, "agent.spawned", "r/a", { agentId: "p1", agentName: name("planner") }),
      ev(2, "agent.spawned", "r/b", { agentId: "p2", agentName: name("planner") }),
      ev(4, "agent.stopped", "r/a", { agentId: "p1", agentName: name("planner") }),
      ev(5, "agent.spawned", "r/a", { agentId: "i1", agentName: name("implementer") }),
      ev(8, "session.started", null, { sessionId: "s2" }),
      ev(9, "agent.spawned", "r/a", { agentId: "i2", agentName: name("implementer") }),
      ev(12, "agent.stopped", "r/a", { agentId: "i2", agentName: name("implementer") }),
    ];
    const runs = agentRuns(events, T0 + 20 * MIN);
    expect(runs.map((r) => [r.agentId, r.role, (r.end - T0) / MIN, Boolean(r.inferred)])).toEqual([
      ["p1", "planner", 4, false],
      ["p2", "planner", 8, true], // no stop: ends at the next session start
      ["i1", "implementer", 8, true],
      ["i2", "implementer", 12, false],
    ]);
    const steps = concurrency(runs);
    expect(steps.map((s) => [(s.t - T0) / MIN, s.n])).toEqual([
      [1, 1],
      [2, 2],
      [4, 1],
      [5, 2],
      [8, 0],
      [9, 1],
      [12, 0],
    ]);
    expect(steps.at(-1)?.n).toBe(0);
  });
});

describe("report tokens", () => {
  function claudeLine(id: string, usage: Record<string, unknown>, model = "claude-opus-5-5") {
    return JSON.stringify({ type: "assistant", message: { id, model, usage } }) + "\n";
  }
  const usage = (out: number) => ({
    input_tokens: 2,
    output_tokens: out,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 300,
    cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 },
  });

  /** A Claude config dir with one main session, its subagent, and a forked copy sharing messages. */
  function claudeHome(cwd: string) {
    const home = tmpDir();
    const dir = path.join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(path.join(dir, "s1", "subagents"), { recursive: true });
    // msg_1 is streamed as two lines with growing output; the fork repeats msg_1 and adds msg_3.
    fs.writeFileSync(
      path.join(dir, "s1.jsonl"),
      claudeLine("msg_1", usage(5)) + claudeLine("msg_1", usage(40)) + "{torn",
    );
    fs.writeFileSync(path.join(dir, "s2.jsonl"), claudeLine("msg_1", usage(40)) + claudeLine("msg_3", usage(10)));
    fs.writeFileSync(
      path.join(dir, "s1", "subagents", "agent-a.jsonl"),
      claudeLine("msg_2", usage(20)) + claudeLine("syn", {}, "<synthetic>"),
    );
    fs.writeFileSync(
      path.join(dir, "s1", "subagents", "agent-a.meta.json"),
      JSON.stringify({ agentType: "openfleet:openfleet-implementer" }),
    );
    return home;
  }

  it("counts each message id once, keeping the largest counts, by role and model", () => {
    const cwd = "/work/space";
    const env = { CLAUDE_CONFIG_DIR: claudeHome(cwd), HOME: "/nowhere" };
    const t = readTokenUsage({ host: "claude", cwd, sessionIds: ["s1", "s2", "s1"], env })!;
    expect(t.messages).toBe(3);
    expect(t.duplicates).toBe(2);
    expect(t.files).toHaveLength(3);
    expect(t.total).toMatchObject({
      calls: 3,
      input: 6,
      output: 70,
      cacheRead: 3000,
      cacheWrite5m: 600,
      cacheWrite1h: 300,
    });
    expect(t.byRole.coordinator?.calls).toBe(2);
    expect(t.byRole.implementer?.output).toBe(20);
    expect(Object.keys(t.byModel)).toEqual(["claude-opus-5-5"]);
    expect(t.cost).toBeUndefined();
  });

  it("shows cost only with pricing, and lists models without a price", () => {
    const cwd = "/work/space";
    const env = { CLAUDE_CONFIG_DIR: claudeHome(cwd), HOME: "/nowhere" };
    const pricing = { "claude-opus-5.5": { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 } };
    const t = readTokenUsage({ host: "claude", cwd, sessionIds: ["s1", "s2"], env, pricing })!;
    const expected = (6 * 4 + 70 * 20 + 600 * 5 + 300 * 8 + 3000 * 0.2) / 1e6;
    expect(t.cost?.total).toBeCloseTo(expected, 10);
    expect(t.cost?.unpriced).toEqual([]);

    const other = readTokenUsage({
      host: "claude",
      cwd,
      sessionIds: ["s1"],
      env,
      pricing: { "gpt-x": { input: 1, output: 1, cacheRead: 1 } },
    })!;
    expect(other.cost?.total).toBe(0);
    expect(other.cost?.unpriced).toEqual(["claude-opus-5-5"]);
  });

  it("needs a price for every token kind used", () => {
    const u = { calls: 1, input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 1e6 };
    expect(costOf(u, { input: 3, output: 15, cacheRead: 0.3 })).toBeUndefined();
    expect(costOf(u, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 })).toBe(9);
  });

  it("returns nothing when no transcript is found", () => {
    const env = { CLAUDE_CONFIG_DIR: tmpDir(), COPILOT_HOME: tmpDir(), HOME: "/nowhere" };
    expect(readTokenUsage({ host: "claude", cwd: "/x", sessionIds: ["s1"], env })).toBeUndefined();
    expect(readTokenUsage({ host: "copilot", cwd: "/x", sessionIds: ["s1"], env })).toBeUndefined();
  });

  it("reads Copilot usage records and attributes subagent calls", () => {
    const home = tmpDir();
    const dir = path.join(home, "session-state", "c1");
    fs.mkdirSync(dir, { recursive: true });
    const rec = (apiCallId: string, agentId?: string) =>
      JSON.stringify({
        type: "session.usage_record",
        ...(agentId ? { agentId } : {}),
        data: {
          usage: {
            model: "claude-opus-5.5",
            inputTokens: 1100,
            outputTokens: 50,
            cacheReadTokens: 1000,
            cacheWriteTokens: 90,
            apiCallId,
          },
        },
      });
    fs.writeFileSync(
      path.join(dir, "events.jsonl"),
      [
        JSON.stringify({ type: "subagent.started", agentId: "x1", data: { agentName: "openfleet-tester" } }),
        rec("a1"),
        rec("a1"),
        rec("a2", "x1"),
      ].join("\n"),
    );
    const msgs = copilotMessages(path.join(dir, "events.jsonl"));
    const t = aggregate("copilot", ["f"], msgs);
    expect(t.messages).toBe(2);
    expect(t.total).toMatchObject({ input: 20, output: 100, cacheRead: 2000, cacheWrite: 180 });
    expect(t.byRole.coordinator?.calls).toBe(1);
    expect(t.byRole.tester?.calls).toBe(1);
    expect(
      readTokenUsage({ host: "copilot", cwd: "/x", sessionIds: ["c1"], env: { COPILOT_HOME: home } })?.messages,
    ).toBe(2);
  });

  it("skips non-assistant and usage-less lines", () => {
    const file = path.join(tmpDir(), "t.jsonl");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "user", message: { id: "u" } }),
        JSON.stringify({ type: "assistant", message: { id: "a" } }),
      ].join("\n"),
    );
    expect(claudeMessages(file, "coordinator")).toEqual([]);
  });
});

describe("report pricing config", () => {
  it("validates the pricing table", () => {
    expect(parsePricing({ m: { input: 1, output: 2, cacheRead: 0.1, cacheWrite5m: 1.25 } })).toEqual({
      m: { input: 1, output: 2, cacheRead: 0.1, cacheWrite5m: 1.25 },
    });
    expect(() => parsePricing([])).toThrow(/object keyed by model/);
    expect(() => parsePricing({ m: { input: 1, output: 2 } })).toThrow(/cacheRead/);
    expect(() => parsePricing({ m: { input: -1, output: 2, cacheRead: 0 } })).toThrow(/input/);
    expect(() => parsePricing({ m: { input: 1, output: 2, cacheRead: 0, extra: 1 } })).toThrow(/extra/);
  });
});

describe("report markdown", () => {
  it("picks the goal from the spec and known headings from the summary", () => {
    expect(specAsk("# T\n\n## Goal\n\nDo it.\n\n## Scope\n\nx")).toEqual({ title: "T", goal: "Do it." });
    expect(specAsk("# T\n\nFirst para.\n\nSecond.").goal).toBe("First para.");
    const s = summarySections(
      "# S\n\n## Coverage\n\n80%\n\n## Assumptions and decisions\n\n- a\n\n## Follow-ups\n\n- f\n\n## Other\n\nx",
    );
    expect(Object.keys(s).sort()).toEqual(["assumptions", "coverage", "followUps"]);
    expect(s.coverage).toBe("80%");
  });
});

describe("report model and HTML", () => {
  const children = {
    "r/setup": { phase: "done", repo: "r", setup: true, dependsOn: [], retries: 0 },
    "r/a": { phase: "testing", repo: "r", dependsOn: ["r/setup"], retries: 1 },
    r: { phase: "pending", repo: "r", integration: true, dependsOn: ["r/setup", "r/a"], retries: 0 },
  } as Record<string, Partial<ProjectState["children"][string]>>;
  const events = () => [
    ev(0, "project.created", null),
    phase(1, "r/setup", "planning"),
    phase(1, "r/a", "planning"),
    ev(2, "agent.spawned", "r/a", { agentId: "p", agentName: "openfleet:openfleet-planner" }),
    ev(3, "assumption", "r/a", {
      child: "r/a",
      question: "<script>alert(1)</script>?",
      decision: "Use <b>",
      rationale: "",
    }),
    phase(4, "r/setup", "implementing"),
    phase(60, "r/setup", "done"),
    ev(61, "test.run", "r/a", { command: "pnpm test", exitCode: 1, passed: false, summary: "1 failed" }, "r/a/tester"),
    ev(62, "test.run", "r/a", { command: "pnpm test", exitCode: 0, passed: true, summary: "ok" }, "r/a/tester"),
    phase(63, "r/a", "testing"),
  ];

  it("derives children, gaps, tests and the plan gate", () => {
    const m = deriveModel({
      name: "demo",
      state: state(children, { status: "running" }),
      events: events(),
      spec: "",
      summary: "",
    });
    expect(m.children.map((c) => [c.id, c.kind])).toEqual([
      ["r/setup", "setup"],
      ["r/a", "member"],
      ["r", "integration"],
    ]);
    expect(m.gaps).toHaveLength(1);
    expect(m.wallMs).toBe(63 * MIN);
    expect(m.activeMs).toBe(7 * MIN);
    expect(m.tests).toEqual({ runs: 2, passed: 1, failed: 1 });
    expect(m.plans.gateAt).toBe(T0 + 4 * MIN);
    expect(m.inProgress).toBe(true);
    expect(
      deriveModel({
        name: "demo",
        state: state(children),
        events: events(),
        spec: "",
        summary: "",
        opts: { gapMinutes: 120 },
      }).gaps,
    ).toEqual([]);
  });

  it("renders optional sections only when summary.md has them, and escapes run data", () => {
    const base = {
      name: "demo",
      state: state(children),
      events: events(),
      spec: "# Demo\n\n## Goal\n\nShip <it>.",
      tokens: undefined,
    };
    const plain = renderReport(deriveModel({ ...base, summary: "# S\n\nAll done." }));
    expect(plain).not.toContain('id="coverage"');
    expect(plain).not.toContain('id="follow-ups"');
    expect(plain).not.toContain('id="lessons"');
    expect(plain).toContain('id="assumptions"'); // from events
    expect(plain).toContain("Token usage: not available.");
    expect(plain).toContain("Ship &lt;it&gt;.");
    expect(plain).not.toContain("<script>alert");
    expect(plain).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");

    const full = renderReport(
      deriveModel({ ...base, summary: "# S\n\n## Coverage\n\n90%\n\n## Follow-ups\n\n- one\n\n## Lessons\n\n- two\n" }),
    );
    expect(full).toContain('id="coverage"');
    expect(full).toContain('id="follow-ups"');
    expect(full).toContain('id="lessons"');
  });

  it("builds a self-contained report from the fixture run", () => {
    const { ws } = fixtureWorkspace();
    const env = { HOME: tmpDir(), CLAUDE_CONFIG_DIR: tmpDir() };
    const m = buildModel(ws, "demo-run", { env });
    expect(m.children).toHaveLength(11);
    expect(m.children.filter((c) => c.kind === "member")).toHaveLength(9);
    expect(m.agents).toHaveLength(83);
    expect(m.agents.filter((a) => a.inferred)).toHaveLength(5);
    expect(m.peakAgents).toBe(7);
    expect(m.tests).toMatchObject({ runs: 88, passed: 72 });
    expect(m.plans).toMatchObject({ submitted: 11, validated: 11, rejected: 1 });
    expect(m.gaps).toHaveLength(2);
    expect(m.activeMs).toBeLessThan(m.wallMs - 4 * 60 * MIN);
    expect(m.tokens).toBeUndefined();

    const html = generateReport(ws, "demo-run", { env });
    for (const id of [
      "ask",
      "split",
      "run",
      "plans",
      "agents",
      "change",
      "tests",
      "coverage",
      "tokens",
      "assumptions",
      "follow-ups",
      "lessons",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).not.toMatch(/<script|<link|https?:\/\/(?!www\.w3\.org)/);
  });
});

describe("openfleet report CLI", () => {
  function cli(cwd: string, args: string[]) {
    const r = spawnSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, HOME: tmpDir(), CLAUDE_CONFIG_DIR: tmpDir(), COPILOT_HOME: tmpDir() },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it("writes projects/<name>/report.html, or --out", () => {
    const { ws, dir } = fixtureWorkspace();
    const r = cli(ws.root, ["report", "demo-run"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(dir, "report.html"), "utf8")).toMatch(/^<!doctype html>/);

    const out = path.join(tmpDir(), "r.html");
    expect(cli(path.join(ws.root, "projects"), ["report", "demo-run", "--out", out, "--gap", "300"]).code).toBe(0);
    expect(fs.readFileSync(out, "utf8")).not.toContain("paused");
  });

  it("rejects a bad --gap and an unknown project", () => {
    const { ws } = fixtureWorkspace();
    expect(cli(ws.root, ["report", "demo-run", "--gap", "0"]).stderr).toMatch(/--gap must be a positive number/);
    expect(cli(ws.root, ["report", "nope"]).code).not.toBe(0);
    expect(cli(ws.root, ["report"]).stderr).toMatch(/Usage: npx openfleet report/);
  });

  it("fails clearly on an invalid pricing table", () => {
    const { ws } = fixtureWorkspace({ pricing: { m: { input: 1 } } });
    const r = cli(ws.root, ["report", "demo-run"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/pricing/);
  });
});
