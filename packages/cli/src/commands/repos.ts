// `npx openfleet repo create | confirm`: new, empty repos for greenfield projects, and the
// commands their setup child confirmed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { checkCopyPath } from "../copyfiles.js";
import { appendEvent } from "../events.js";
import { git, tryGit } from "../git.js";
import { readRepos, validateRepoKey, writeRepos } from "../repos.js";
import { readState, updateState } from "../state.js";
import { projectPaths, requireWorkspace, UserError, validateProjectName } from "../workspace.js";
import { out } from "./output.js";

export const REPO_USAGE = `Usage:
  openfleet repo create <key> [--github <owner/name>] [--project <name>]
  Creates repos/<key> with an empty initial commit on main and registers it in repos.json (greenfield).
  --github  also create a private GitHub repo with gh and push the initial commit
  --project mark that project as greenfield and log repo.created to it

  openfleet repo confirm <key> [--package <name> [--path <dir>]] [--build <cmd>] [--test <cmd>] [--e2e <cmd>]
                         [--copy-file <file>]…
  Records confirmed build/test/e2e commands (and local copyFiles) in repos.json and sets confirmed: true.
  --package targets a monorepo package; --path registers a new one (relative to the repo root)`;

export interface RepoFlags {
  github?: string;
  project?: string;
  package?: string;
  path?: string;
  build?: string;
  test?: string;
  e2e?: string;
  "copy-file"?: string[];
}

const GITHUB_REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** GitHub CLI binary: `OPENFLEET_GH_BIN`, else `gh` on PATH. */
function ghBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENFLEET_GH_BIN || "gh";
}

function gh(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const bin = ghBin();
  const res = spawnSync(bin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new UserError(
      `Could not run \`${bin}\` (GitHub CLI). Install it from https://cli.github.com and run \`gh auth login\`, or create the repo without --github.`,
    );
  }
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function isEmptyDir(dir: string): boolean {
  return fs.readdirSync(dir).length === 0;
}

export function cmdRepo(args: string[], flags: RepoFlags): number {
  const [sub, rawKey] = args;
  if (sub === "confirm") return repoConfirm(validateRepoKey(rawKey), flags);
  if (sub !== "create") throw new UserError(REPO_USAGE);
  return repoCreate(validateRepoKey(rawKey), flags);
}

function repoCreate(key: string, flags: RepoFlags): number {
  const ws = requireWorkspace();
  const p = flags.project !== undefined ? projectPaths(ws, validateProjectName(flags.project)) : undefined;
  if (p) readState(p);
  if (flags.github !== undefined && !GITHUB_REPO.test(flags.github)) {
    throw new UserError(`Invalid --github "${flags.github}". Use <owner>/<name>.`);
  }

  const repos = readRepos(ws);
  if (repos.repos[key]) throw new UserError(`Repo "${key}" is already in repos.json.`);
  const dir = path.join(ws.repos, key);
  if (fs.existsSync(dir) && !(fs.statSync(dir).isDirectory() && isEmptyDir(dir))) {
    throw new UserError(`${dir} already exists and is not empty. Pick another key or remove it first.`);
  }
  if (flags.github !== undefined) {
    const auth = gh(["auth", "status"], ws.root);
    if (auth.status !== 0) {
      throw new UserError(
        `GitHub CLI is not signed in (gh auth status failed):\n${(auth.stderr || auth.stdout).trim()}\n\nRun \`gh auth login\`, then try again.`,
      );
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "--quiet", "-b", "main"]);
  git(dir, ["commit", "--quiet", "--no-verify", "--allow-empty", "-m", "chore: Initial commit"]);

  let remote: string | undefined;
  if (flags.github !== undefined) {
    const res = gh(["repo", "create", flags.github, "--private", "--source", dir, "--remote", "origin", "--push"], dir);
    if (res.status !== 0) {
      // The folder was missing or empty before, so undo the local repo and let the user retry cleanly.
      fs.rmSync(dir, { recursive: true, force: true });
      throw new UserError(`gh repo create ${flags.github} failed:\n${(res.stderr || res.stdout).trim()}`);
    }
    remote = tryGit(dir, ["remote", "get-url", "origin"])?.trim() || `https://github.com/${flags.github}.git`;
  }

  const rel = path.relative(ws.root, dir).split(path.sep).join("/");
  repos.repos[key] = { path: rel, ...(remote ? { url: remote } : {}), defaultBranch: "main", greenfield: true };
  writeRepos(ws, repos);

  if (p) {
    updateState(p, (s) => {
      s.greenfield = true;
    });
    appendEvent(p, {
      actor: "coordinator",
      type: "repo.created",
      target: null,
      payload: { key, path: rel, remote: remote ?? null, github: flags.github ?? null },
    });
  }
  out(JSON.stringify({ key, ...repos.repos[key] }, null, 2));
  return 0;
}

function repoConfirm(key: string, flags: RepoFlags): number {
  const ws = requireWorkspace();
  const repos = readRepos(ws);
  const entry = repos.repos[key];
  if (!entry) throw new UserError(`Repo "${key}" is not in repos.json.`);
  const commands = { build: flags.build, test: flags.test, e2e: flags.e2e };
  const set: Record<string, string> = {};
  for (const [name, cmd] of Object.entries(commands)) {
    if (cmd === undefined) continue;
    if (!cmd.trim()) throw new UserError(`--${name} must not be empty.`);
    set[name] = cmd;
  }
  const copyFiles = (flags["copy-file"] ?? []).map((raw) => {
    const c = checkCopyPath(raw);
    if ("error" in c) throw new UserError(`--copy-file "${raw}" ${c.error}.`);
    return c.rel;
  });
  if (flags.path !== undefined && flags.package === undefined) throw new UserError("--path needs --package.");
  if (flags.package !== undefined) {
    const existing = entry.packages?.[flags.package];
    const raw = flags.path ?? existing?.path;
    if (!raw) throw new UserError(`Package "${flags.package}" is new: pass --path <dir> (relative to the repo root).`);
    const c = checkCopyPath(raw);
    if ("error" in c) throw new UserError(`--path "${raw}" ${c.error}.`);
    entry.packages = { ...entry.packages, [flags.package]: { ...existing, ...set, path: c.rel } };
  } else {
    Object.assign(entry, set);
  }
  if (copyFiles.length) entry.copyFiles = [...new Set([...(entry.copyFiles ?? []), ...copyFiles])];
  entry.confirmed = true;
  writeRepos(ws, repos);
  out(JSON.stringify({ key, ...entry }, null, 2));
  return 0;
}
