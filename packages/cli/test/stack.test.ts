import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readEvents } from "../src/events.js";
import { readJson } from "../src/fsutil.js";
import type { ProjectState } from "../src/state.js";
import { findWorkspace, projectPaths } from "../src/workspace.js";
import { gitRepo, sh, tmpDir } from "./helpers.js";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

function cli(cwd: string, args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A grouped repo `web` (setup, a, b) whose children are done and merged into `openfleet/p`. */
function mergedRepo() {
  const root = tmpDir();
  const web = gitRepo(path.join(root, "web"), { "lib/ui.ts": "1\n", "app/a.txt": "a\n", "app/b.txt": "b\n" });
  const solo = gitRepo(path.join(root, "solo"));
  expect(cli(root, ["init"]).code).toBe(0);
  fs.writeFileSync(
    path.join(root, "repos.json"),
    JSON.stringify({ v: 1, repos: { web: { path: web, defaultBranch: "main" }, solo: { path: solo } } }),
  );
  const p = projectPaths(findWorkspace(root)!, "p");
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(
    p.state,
    JSON.stringify({
      v: 1,
      name: "p",
      status: "finalizing",
      createdAt: "",
      updatedAt: "",
      children: {},
      questions: [],
    }),
  );
  const patch = (obj: unknown) => expect(cli(root, ["state", "p", "--patch", JSON.stringify(obj)]).code).toBe(0);
  patch({
    children: {
      "web/setup": { repo: "web", setup: true, paths: ["lib/**"] },
      "web/a": { repo: "web", paths: ["app/a.txt"], dependsOn: ["web/setup"] },
      "web/b": { repo: "web", paths: ["app/b.txt"], dependsOn: ["web/setup"] },
      solo: { repo: "solo" },
    },
  });
  for (const id of ["web", "web/setup", "web/a", "web/b"]) expect(cli(root, ["worktree", "p", id]).code).toBe(0);
  const state = () => readJson<ProjectState>(p.state);
  const wt = (id: string) => state().children[id]!.worktree!;
  fs.writeFileSync(path.join(wt("web/setup"), "lib/ui.ts"), "2\n");
  fs.writeFileSync(path.join(wt("web/a"), "app/a.txt"), "A\n");
  fs.writeFileSync(path.join(wt("web/b"), "app/b.txt"), "B\n");
  for (const id of ["web/setup", "web/a", "web/b"]) {
    patch({ children: { [id]: { phase: "done" } } });
    expect(cli(root, ["merge", "p", id]).code).toBe(0);
  }
  return { root, web, p, patch, state, wt };
}

describe("stacked PRs", () => {
  it("makes one layer branch per merged child in merge order; the top layer is the integration branch", () => {
    const { root, web, p, patch, state, wt } = mergedRepo();
    expect(cli(root, ["stack", "p", "web"]).stderr).toMatch(/is "pending", not "done"/);
    // An integration fix after the last merge belongs to the top layer.
    fs.writeFileSync(path.join(wt("web"), "app/b.txt"), "B fixed\n");
    patch({ children: { web: { phase: "done" } } });
    expect(cli(root, ["stack", "p", "web"]).stderr).toMatch(/uncommitted changes/);
    sh(wt("web"), "git", ["commit", "-qam", "fix"]);

    const r = cli(root, ["stack", "p", "web"]);
    expect(r.stderr).toBe("");
    const out = JSON.parse(r.stdout) as {
      base: string;
      layers: { child: string; branch: string; sha: string }[];
      commands: string[];
    };
    expect(out.base).toBe("main");
    expect(out.layers.map((l) => [l.child, l.branch])).toEqual([
      ["web/setup", "openfleet/p--stack-1-web-setup"],
      ["web/a", "openfleet/p--stack-2-web-a"],
      ["web/b", "openfleet/p"],
    ]);
    for (const l of out.layers) expect(sh(web, "git", ["rev-parse", l.branch]).trim()).toBe(l.sha);
    const show = (branch: string, file: string) => sh(web, "git", ["show", `${branch}:${file}`]);
    expect(show("openfleet/p--stack-1-web-setup", "lib/ui.ts")).toBe("2\n");
    expect(show("openfleet/p--stack-1-web-setup", "app/a.txt")).toBe("a\n");
    expect(show("openfleet/p--stack-2-web-a", "app/a.txt")).toBe("A\n");
    expect(show("openfleet/p--stack-2-web-a", "app/b.txt")).toBe("b\n");
    expect(show("openfleet/p", "app/b.txt")).toBe("B fixed\n");
    expect(out.commands).toEqual([
      "gh stack init --base main openfleet/p--stack-1-web-setup openfleet/p--stack-2-web-a openfleet/p",
      "gh stack submit --auto",
      "gh stack view --json",
    ]);
    expect(state().children.web!.stack).toEqual(out.layers);
    expect(readEvents(p).find((e) => e.type === "stack.created")).toMatchObject({
      target: "web",
      payload: { base: "main", layers: out.layers },
    });
    // Running it again moves the layer branches to the same commits.
    expect(cli(root, ["stack", "p", "web"]).code).toBe(0);
  });

  it("refuses repos with one child", () => {
    const { root } = mergedRepo();
    expect(cli(root, ["stack", "p", "solo"]).stderr).toMatch(/has one child, so it gets one PR/);
    expect(cli(root, ["stack", "p"]).stderr).toMatch(/Usage: openfleet stack/);
  });
});
