import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { packageVersion } from "../src/core.js";
import { readJson, writeJson } from "../src/fsutil.js";
import { checkSchema, migrateFile, migrateWorkspace, type Migration } from "../src/migrate.js";
import { newState } from "../src/state.js";
import { projectPaths } from "../src/workspace.js";
import { gitRepo, tmpDir, workspace } from "./helpers.js";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

function cli(cwd: string, args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A pretend v1 → v2 state step: renames `notes` to `memo` and adds `migrated`. */
const STEP: Migration = {
  from: 1,
  up: (doc) => {
    const out: Record<string, unknown> = { ...doc, migrated: true };
    if ("notes" in out) {
      out.memo = out.notes;
      delete out.notes;
    }
    return out;
  },
};

describe("schema checks", () => {
  it("refuses newer, older and unversioned files with the fix", () => {
    expect(() => checkSchema("state", "s.json", { v: 2 }, 1)).toThrow(
      /written by a newer OpenFleet \(project state schema v2; this CLI reads v1\)\. Upgrade the CLI/,
    );
    expect(() => checkSchema("repos", "r.json", { v: 1 }, 2)).toThrow(
      /older repos\.json schema \(v1; this CLI reads v2\)\. Run `npx openfleet update`/,
    );
    expect(() => checkSchema("lock", "l.json", {}, 1)).toThrow(/has no schema version/);
    expect(() => checkSchema("state", "s.json", { v: 1 })).not.toThrow();
  });

  it("commands refuse a project written by a newer OpenFleet", () => {
    const ws = workspace();
    const p = projectPaths(ws, "p");
    fs.mkdirSync(p.dir, { recursive: true });
    writeJson(p.state, { ...newState("p"), v: 99 });
    const r = cli(ws.root, ["status", "p"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/newer OpenFleet \(project state schema v99/);
    expect(r.stderr).not.toContain("    at ");
  });
});

describe("migrations", () => {
  it("migrates a file step by step and keeps a backup of the original", () => {
    const dir = tmpDir();
    const file = path.join(dir, "state.json");
    writeJson(file, { v: 1, name: "p", notes: "hi" });
    const m = migrateFile("state", file, [STEP], 2);
    expect(m).toEqual({ file, kind: "state", from: 1, to: 2, backup: `${file}.v1.bak` });
    expect(readJson(file)).toEqual({ v: 2, name: "p", memo: "hi", migrated: true });
    expect(readJson(`${file}.v1.bak`)).toEqual({ v: 1, name: "p", notes: "hi" });
    expect(migrateFile("state", file, [STEP], 2)).toBeUndefined();
    expect(() => migrateFile("state", file, [], 3)).toThrow(/No migration for project state schema v2 → v3/);
    expect(migrateFile("state", path.join(dir, "missing.json"), [STEP], 2)).toBeUndefined();
  });

  it("migrates every project, repos.json and the lock file of a workspace", () => {
    const ws = workspace();
    for (const name of ["a", "b"]) {
      const p = projectPaths(ws, name);
      fs.mkdirSync(p.dir, { recursive: true });
      writeJson(p.state, newState(name));
    }
    const reposStep: Migration = { from: 1, up: (d) => ({ ...d, note: "r" }) };
    const done = migrateWorkspace(ws, { state: [STEP], repos: [reposStep], lock: [] }, { state: 2, repos: 2, lock: 1 });
    expect(done.map((m) => [m.kind, path.relative(ws.root, m.file)])).toEqual([
      ["repos", "repos.json"],
      ["state", "projects/a/state.json"],
      ["state", "projects/b/state.json"],
    ]);
    expect(readJson<{ migrated: boolean }>(projectPaths(ws, "b").state).migrated).toBe(true);
  });

  it("upgrades a workspace made with 0.6.0 and keeps it working", () => {
    const tmp = tmpDir();
    const repo = gitRepo(path.join(tmp, "api"));
    const ws = workspace({ api: { path: repo, defaultBranch: "main", test: "npm test", confirmed: true } });
    // What 0.6.0 left behind: its version in openfleet.json and core/, and a project in its state shape.
    writeJson(ws.marker, { version: "0.6.0", maxParallel: 4, host: "copilot" });
    fs.writeFileSync(path.join(ws.core, "VERSION"), "0.6.0\n");
    const p = projectPaths(ws, "old");
    fs.mkdirSync(p.dir, { recursive: true });
    writeJson(p.state, {
      v: 1,
      name: "old",
      status: "running",
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-20T10:00:00.000Z",
      sessionId: "sess-old",
      completionMode: "staged",
      specApproved: true,
      children: {
        api: { repo: "api", phase: "planned", retries: 0, dependsOn: [], agentIds: {}, portBase: 4100 },
      },
      questions: [],
      preflight: { ok: true, at: "2026-10-20T10:00:00.000Z" },
    });

    const up = cli(ws.root, ["update"]);
    expect(up.stderr).toBe("");
    expect(up.stdout).toContain(`Updated OpenFleet core 0.6.0 → ${packageVersion()}.`);
    expect(readJson(ws.marker)).toMatchObject({ version: packageVersion(), maxParallel: 4, host: "copilot" });
    expect(cli(ws.root, ["status", "old"]).stdout).toMatch(/Project old: running/);
    expect(JSON.parse(cli(ws.root, ["next", "old"]).stdout)).toMatchObject({ gate: "checking" });
    expect(JSON.parse(cli(ws.root, ["config"]).stdout)).toEqual({ maxParallel: 4, host: "copilot" });
  });

  it("refuses to downgrade a workspace to an older CLI", () => {
    const ws = workspace();
    fs.writeFileSync(path.join(ws.core, "VERSION"), "99.0.0\n");
    const r = cli(ws.root, ["update"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/runs OpenFleet core 99\.0\.0, newer than this CLI/);
  });
});
