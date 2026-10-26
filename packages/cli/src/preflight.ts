// `npx openfleet preflight <project>`: before the spec is approved, when a run starts and on
// `resume`, check from inside the Copilot session that git can create ref locks and worktree
// admin dirs in every repo, that the worktrees dir is writable and that copyFiles can be
// opened. Copilot CLI's command sandbox can block these (EPERM) even though `--add-dir`
// allows the paths, and the failure would otherwise only show once worktrees are created.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkCopyPath } from "./copyfiles.js";
import { appendEvent } from "./events.js";
import { isFile } from "./fsutil.js";
import { tryGit } from "./git.js";
import { readRepos, type RepoEntry } from "./repos.js";
import { hintFor } from "./sandbox.js";
import { readState, updateState, type ProjectState } from "./state.js";
import { installHint, onPath, probeUrl, registriesFor, toolchainsFor, type UrlProbe } from "./toolchains.js";
import { projectPaths, type Workspace } from "./workspace.js";

/** File system operations the probes use; injectable for tests. */
export interface ProbeFs {
  mkdir(dir: string): void;
  rmdir(dir: string): void;
  writeFile(file: string): void;
  rm(file: string): void;
  /** Open for reading and close at once. Never reads or prints the contents. */
  openRead(file: string): void;
  exists(p: string): boolean;
}

export const realProbeFs: ProbeFs = {
  mkdir: (dir) => fs.mkdirSync(dir),
  rmdir: (dir) => fs.rmdirSync(dir),
  writeFile: (file) => fs.writeFileSync(file, "", { flag: "wx" }),
  rm: (file) => fs.rmSync(file, { force: true }),
  openRead: (file) => fs.closeSync(fs.openSync(file, "r")),
  exists: (p) => fs.existsSync(p),
};

export type PreflightCheck =
  | "repo"
  | "ref-lock"
  | "worktree-admin"
  | "info-exclude"
  | "copy-file"
  | "worktrees-dir"
  | "clone-dir"
  | "toolchain"
  | "registry";

export interface CheckResult {
  repo: string | null;
  check: PreflightCheck;
  path: string;
  ok: boolean;
  code?: string;
  error?: string;
}

export interface PreflightReport {
  ok: boolean;
  project: string;
  repos: string[];
  checks: CheckResult[];
  /** Set when a check failed: the most likely cause and how to fix it. */
  hint?: string;
}

function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? "ERROR";
}

function attempt(repo: string | null, check: PreflightCheck, p: string, fn: () => void): CheckResult {
  try {
    fn();
    return { repo, check, path: p, ok: true };
  } catch (err) {
    return { repo, check, path: p, ok: false, code: errCode(err), error: (err as Error).message };
  }
}

const probeName = () => `.openfleet-preflight-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;

/** Create and remove a file in `dir`, the way git creates `<ref>.lock`. */
function probeFile(io: ProbeFs, dir: string): void {
  const file = path.join(dir, `${probeName()}.lock`);
  io.writeFile(file);
  io.rm(file);
}

/** Create and remove a dir under `parent` (created first if missing, then removed again). */
function probeDir(io: ProbeFs, parent: string): void {
  const created = !io.exists(parent);
  if (created) io.mkdir(parent);
  const dir = path.join(parent, probeName());
  try {
    io.mkdir(dir);
    io.rmdir(dir);
  } finally {
    if (created) io.rmdir(parent);
  }
}

function gitCommonDir(repoPath: string): string | undefined {
  const out = tryGit(repoPath, ["rev-parse", "--git-common-dir"])?.trim();
  return out ? path.resolve(repoPath, out) : undefined;
}

function checkRepo(ws: Workspace, key: string, entry: RepoEntry, io: ProbeFs): CheckResult[] {
  const repoPath = entry.path ? path.resolve(ws.root, entry.path) : entry.url ? path.join(ws.repos, key) : undefined;
  if (!repoPath) return [{ repo: key, check: "repo", path: "", ok: false, error: 'needs a "path" or "url"' }];
  const gitDir = gitCommonDir(repoPath);
  if (!gitDir) {
    if (entry.path) return [{ repo: key, check: "repo", path: repoPath, ok: false, error: "not a git repository" }];
    // Not cloned yet: the clone goes to repos/<key>.
    const reposDir = path.dirname(repoPath);
    return [
      attempt(key, "clone-dir", reposDir, () => {
        if (!io.exists(reposDir)) fs.mkdirSync(reposDir, { recursive: true });
        probeDir(io, reposDir);
      }),
    ];
  }
  const results = [
    attempt(key, "ref-lock", path.join(gitDir, "refs", "heads"), () =>
      probeFile(io, path.join(gitDir, "refs", "heads")),
    ),
    attempt(key, "worktree-admin", path.join(gitDir, "worktrees"), () => probeDir(io, path.join(gitDir, "worktrees"))),
  ];
  const copies = (entry.copyFiles ?? []).flatMap((raw) => {
    const c = checkCopyPath(raw);
    return "rel" in c ? [c.rel] : [];
  });
  if (copies.length) {
    results.push(
      attempt(key, "info-exclude", path.join(gitDir, "info"), () => probeDir(io, path.join(gitDir, "info"))),
    );
    for (const rel of copies) {
      const src = path.join(repoPath, rel);
      if (isFile(src)) results.push(attempt(key, "copy-file", src, () => io.openRead(src)));
    }
  }
  return results;
}

function overallHint(failed: CheckResult[]): string | undefined {
  if (failed.length && failed.every((c) => c.check === "toolchain" || c.check === "registry")) {
    return "Install the missing tools and check the network or registry mirror (see each check), then run preflight again.";
  }
  for (const code of ["EPERM", "EACCES"]) {
    if (failed.some((c) => c.code === code || c.error?.includes(code))) return hintFor(code);
  }
  return failed.length ? "Fix the failed checks above, then run preflight again." : undefined;
}

/** The repos a project touches: its children's repos, or every known repo before children exist. */
export function projectRepos(ws: Workspace, project: string): string[] {
  const state = readState(projectPaths(ws, project));
  const fromChildren = [...new Set(Object.values(state.children).map((c) => c.repo))].filter(Boolean);
  return fromChildren.length ? fromChildren.sort() : Object.keys(readRepos(ws).repos).sort();
}

/** Run every probe without recording anything. Without a project, only the known repos are probed. */
export function runChecks(ws: Workspace, project: string | undefined, io: ProbeFs = realProbeFs): CheckResult[] {
  const repos = readRepos(ws).repos;
  const checks: CheckResult[] = [];
  if (project) {
    const worktrees = projectPaths(ws, project).worktrees;
    checks.push(
      attempt(null, "worktrees-dir", worktrees, () => {
        if (!io.exists(worktrees)) fs.mkdirSync(worktrees, { recursive: true });
        probeDir(io, worktrees);
      }),
    );
  }
  // A greenfield project creates its repos (`npx openfleet repo create`) after the spec is approved.
  const greenfield = project ? readState(projectPaths(ws, project)).greenfield === true : false;
  for (const key of project ? projectRepos(ws, project) : Object.keys(repos).sort()) {
    const entry = repos[key];
    if (!entry && greenfield) {
      checks.push(
        attempt(key, "clone-dir", ws.repos, () => {
          if (!io.exists(ws.repos)) fs.mkdirSync(ws.repos, { recursive: true });
          probeDir(io, ws.repos);
        }),
      );
    } else if (!entry) checks.push({ repo: key, check: "repo", path: "", ok: false, error: "not in repos.json" });
    else checks.push(...checkRepo(ws, key, entry, io));
  }
  return checks;
}

/** Failed checks caused by the OS denying access (a sandbox or file permissions), not by configuration. */
export function deniedChecks(checks: readonly CheckResult[]): CheckResult[] {
  return checks.filter((c) => !c.ok && (c.code === "EPERM" || c.code === "EACCES" || c.code === "EROFS"));
}

export interface EnvChecks {
  env?: NodeJS.ProcessEnv;
  probe?: UrlProbe;
}

/** Greenfield projects: every toolchain on PATH and every package registry reachable. */
export function greenfieldChecks(
  state: ProjectState,
  { env = process.env, probe = probeUrl }: EnvChecks = {},
): CheckResult[] {
  if (!state.greenfield) return [];
  const tools = toolchainsFor(state.toolchains);
  const checks: CheckResult[] = tools.map((cmd) =>
    onPath(cmd, env)
      ? { repo: null, check: "toolchain", path: cmd, ok: true }
      : {
          repo: null,
          check: "toolchain",
          path: cmd,
          ok: false,
          code: "ENOENT",
          error: `not found on PATH. ${installHint(cmd)}`,
        },
  );
  for (const url of registriesFor(tools, env)) {
    const r = probe(url);
    checks.push(
      r.ok
        ? { repo: null, check: "registry", path: url, ok: true }
        : {
            repo: null,
            check: "registry",
            path: url,
            ok: false,
            code: "UNREACHABLE",
            error: `not reachable (${r.error ?? "no response"}). Check the network, a proxy or the registry mirror setting.`,
          },
    );
  }
  return checks;
}

export function preflight(
  ws: Workspace,
  project: string,
  io: ProbeFs = realProbeFs,
  envChecks: EnvChecks = {},
): PreflightReport {
  const p = projectPaths(ws, project);
  const keys = projectRepos(ws, project);
  const checks = [...runChecks(ws, project, io), ...greenfieldChecks(readState(p), envChecks)];
  const failed = checks.filter((c) => !c.ok);
  const hint = overallHint(failed);
  const report: PreflightReport = { ok: !failed.length, project, repos: keys, checks, ...(hint ? { hint } : {}) };
  const at = new Date().toISOString();
  updateState(p, (s) => {
    s.preflight = { ok: report.ok, at };
  });
  appendEvent(p, {
    actor: "cli",
    type: report.ok ? "preflight.passed" : "preflight.failed",
    payload: report.ok
      ? { repos: keys, checks: checks.length }
      : {
          repos: keys,
          failed: failed.map(({ repo, check, path: fp, code }) => ({ repo, check, path: fp, code })),
          hint,
        },
  });
  return report;
}

/** Human-readable failure summary for stderr. */
export function formatFailure(report: PreflightReport): string {
  const lines = report.checks
    .filter((c) => !c.ok)
    .map(
      (c) =>
        `  - ${c.repo ?? "workspace"}: ${c.check} ${c.path}${c.code ? ` (${c.code})` : ""}` +
        (c.check === "toolchain" || c.check === "registry" ? `: ${c.error}` : ""),
    );
  return [`Preflight failed for project ${report.project}:`, ...lines, "", report.hint ?? ""].join("\n").trimEnd();
}
