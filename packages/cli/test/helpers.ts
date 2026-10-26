import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { initWorkspace } from "../src/commands/workspace.js";
import { realish, writeJson } from "../src/fsutil.js";
import type { Workspace } from "../src/workspace.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

export function tmpDir(prefix = "openfleet-test-"): string {
  const dir = realish(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

export function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function gitRepo(dir: string, files: Record<string, string> = { "README.md": "hello\n" }): string {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  sh(dir, "git", ["config", "user.email", "test@example.com"]);
  sh(dir, "git", ["config", "user.name", "Test"]);
  sh(dir, "git", ["config", "commit.gpgsign", "false"]);
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  sh(dir, "git", ["add", "-A"]);
  sh(dir, "git", ["commit", "-qm", "init"]);
  return dir;
}

/** Fresh workspace with core installed (requires `pnpm build` for core/lib). */
export function workspace(repos: Record<string, object> = {}): Workspace {
  const root = tmpDir();
  const { ws } = initWorkspace(root);
  if (Object.keys(repos).length) writeJson(ws.reposFile, { v: 1, repos });
  return ws;
}

export function writeExtension(
  dir: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "openfleet.extension.json"), JSON.stringify(manifest, null, 2));
  const all = { "instructions.md": `# ${String(manifest.name)}\nDo the thing.\n`, ...files };
  for (const entry of [
    ...((manifest.phases as { instructions?: string }[]) ?? []),
    ...((manifest.augments as { instructions?: string }[]) ?? []),
  ]) {
    const rel = entry.instructions;
    if (rel && !rel.includes("..") && !(rel in all)) (all as Record<string, string>)[rel] = `# ${rel}\nDo the thing.\n`;
  }
  for (const [name, body] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

/**
 * Generic fixture shaped like a real use case: a blocking post-test phase that
 * publishes something and reports outputs (including `prUrl`), an implementer
 * augment that consumes upstream outputs, follow-ups and settings.
 */
export function publishFixture(dir: string, overrides: Record<string, unknown> = {}): string {
  return writeExtension(
    dir,
    {
      manifest: 2,
      name: "publish",
      version: "1.0.0",
      core: ">=0.0.0 <1.0.0",
      description: "Publish a preview build after tests pass",
      permissions: ["shell"],
      phases: [
        {
          slot: "post-test",
          instructions: "publish.md",
          blocking: true,
          when: { files: [".changeset/config.json"] },
          timeoutMinutes: 45,
        },
      ],
      augments: [{ role: "implementer", instructions: "pin.md" }],
      settings: {
        label: { default: "preview", description: "Label that triggers the preview workflow" },
        workflow: { default: "preview.yml", description: "Workflow to wait for" },
      },
      commands: { "publish-status": "status.md" },
      ...overrides,
    },
    {
      "publish.md": "# Publish\nCommit, push, open a draft PR, wait for the preview workflow, report the version.\n",
      "pin.md": "Pin upstream preview versions from Upstream outputs exactly.\n",
      "status.md": "# Status\nShow preview builds.\n",
    },
  );
}
