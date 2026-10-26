import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendEvent, EVENT_TYPES, readEvents } from "../src/events.js";
import { writeJson } from "../src/fsutil.js";
import { mergePatch, newState, patchState, readState, updateState } from "../src/state.js";
import { projectPaths, validateProjectName, workspaceAt } from "../src/workspace.js";
import { tmpDir } from "./helpers.js";

function project() {
  const ws = workspaceAt(tmpDir());
  const p = projectPaths(ws, "demo");
  fs.mkdirSync(p.dir, { recursive: true });
  writeJson(p.state, newState("demo", "sess-1"));
  return p;
}

describe("events", () => {
  it("assigns increasing seq numbers and writes JSON lines", () => {
    const p = project();
    const a = appendEvent(p, { actor: "cli", type: "project.created" });
    const b = appendEvent(p, { actor: "coordinator", type: "spec.approved", target: null, payload: { x: 1 } });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    const lines = fs.readFileSync(p.events, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({
      v: 1,
      seq: 2,
      actor: "coordinator",
      type: "spec.approved",
      payload: { x: 1 },
    });
  });

  it("knows the hands-off event types", () => {
    for (const t of ["assumption", "child.failed", "spec.approved"]) expect(EVENT_TYPES).toContain(t);
    expect(EVENT_TYPES).not.toContain("escalation");
  });

  it("recovers seq from the log when the sidecar is missing", () => {
    const p = project();
    appendEvent(p, { actor: "cli", type: "a" });
    appendEvent(p, { actor: "cli", type: "b" });
    fs.rmSync(p.seq);
    expect(appendEvent(p, { actor: "cli", type: "c" }).seq).toBe(3);
  });

  it("stores patches out of line, redacted", () => {
    const p = project();
    const ev = appendEvent(p, {
      actor: "repo/implementer",
      type: "file.edited",
      payload: { path: "x.ts" },
      patch: "+const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';\n",
    });
    expect(ev.payload.patch).toBe("patches/1.patch");
    const patch = fs.readFileSync(path.join(p.dir, "patches", "1.patch"), "utf8");
    expect(patch).toContain("[REDACTED]");
    expect(patch).not.toContain("ghp_");
  });

  it("redacts payloads", () => {
    const p = project();
    appendEvent(p, { actor: "x", type: "agent.stopped", payload: { response: "key AKIAIOSFODNN7EXAMPLE" } });
    expect(readEvents(p)[0]!.payload.response).toBe("key [REDACTED]");
  });

  it("keeps seq unique under concurrent writers", async () => {
    const p = project();
    const { fork } = await import("node:child_process");
    const script = `
      import { appendEvent } from ${JSON.stringify(new URL("../dist/events.js", import.meta.url).href)};
      const p = JSON.parse(process.argv[2]);
      for (let i = 0; i < 25; i++) appendEvent(p, { actor: "w", type: "t" });
    `;
    const file = path.join(p.dir, "writer.mjs");
    fs.writeFileSync(file, script);
    await Promise.all(
      [0, 1, 2, 3].map(
        () =>
          new Promise<void>((resolve, reject) =>
            fork(file, [JSON.stringify(p)]).on("exit", (c) => (c ? reject(new Error(`exit ${c}`)) : resolve())),
          ),
      ),
    );
    const seqs = readEvents(p).map((e) => e.seq);
    expect(seqs).toHaveLength(100);
    expect(new Set(seqs).size).toBe(100);
    expect(Math.max(...seqs)).toBe(100);
  });
});

describe("state", () => {
  it("mergePatch follows RFC 7396", () => {
    expect(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: null, e: 4 }, f: [1] })).toEqual({
      a: 1,
      b: { d: 3, e: 4 },
      f: [1],
    });
    expect(mergePatch({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });

  it("emits phase.changed events for status and child phase transitions", () => {
    const p = project();
    patchState(p, { status: "running", children: { api: { repo: "api" } } });
    updateState(
      p,
      (s) => {
        s.children.api!.phase = "planning";
      },
      "coordinator",
    );
    const s = readState(p);
    expect(s.children.api).toMatchObject({ repo: "api", phase: "planning", retries: 0, dependsOn: [], agentIds: {} });
    const changes = readEvents(p)
      .filter((e) => e.type === "phase.changed")
      .map((e) => [e.target, e.payload.from, e.payload.to]);
    expect(changes).toEqual([
      [null, "specifying", "running"],
      ["api", null, "pending"],
      ["api", "pending", "planning"],
    ]);
  });

  it("does not emit events when nothing changes phase", () => {
    const p = project();
    patchState(p, { completionMode: "staged" });
    expect(readEvents(p)).toHaveLength(0);
  });

  it("rejects unknown project statuses and child phases", () => {
    const p = project();
    expect(() => patchState(p, { status: "awaiting-approval" })).toThrow(/Unknown project status "awaiting-approval"/);
    expect(() => patchState(p, { children: { api: { phase: "escalated" } } })).toThrow(
      /Unknown phase "escalated" for child api/,
    );
    expect(readState(p).status).toBe("specifying");
    patchState(p, {
      status: "running",
      children: { api: { phase: "failed" }, web: { phase: "blocked", dependsOn: ["api"] } },
    });
    expect(readState(p).children.web!.phase).toBe("blocked");
  });

  it("allows unrelated patches when the stored state has a legacy value", () => {
    const p = project();
    writeJson(p.state, { ...newState("demo"), status: "awaiting-approval" });
    expect(() => patchState(p, { completionMode: "staged" })).not.toThrow();
  });

  it("rejects non-object patches", () => {
    expect(() => patchState(project(), [1, 2])).toThrow(/JSON object/);
  });
});

describe("validateProjectName", () => {
  it("accepts kebab-case and rejects the rest", () => {
    expect(validateProjectName("add-auth-2")).toBe("add-auth-2");
    for (const bad of [undefined, "", "Upper", "-lead", "a/b", "a".repeat(70)]) {
      expect(() => validateProjectName(bad)).toThrow();
    }
  });
});
