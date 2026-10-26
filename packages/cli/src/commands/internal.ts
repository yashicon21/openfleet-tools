// Helper commands used by OpenFleet agents (see the openfleet-records skill).
import fs from "node:fs";
import path from "node:path";
import { copyIntoWorktree } from "../copyfiles.js";
import { appendEvent, PLAN_REJECTION_REASONS } from "../events.js";
import { addWorktree, git, headSha, isGitRepo } from "../git.js";
import { defaultBranch, requireChildId } from "../groups.js";
import { readRepos } from "../repos.js";
import { greenfieldLimits, readConfig } from "../config.js";
import { greenfieldProblems, patchState, readState, updateState } from "../state.js";
import { projectPaths, requireWorkspace, UserError, validateProjectName, type Workspace } from "../workspace.js";
import { out, warn } from "./output.js";

function parseJson(raw: string | undefined, what: string): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new UserError(`Invalid JSON for ${what}: ${(err as Error).message}`);
  }
}

export interface EventFlags {
  type?: string;
  actor?: string;
  target?: string;
  payload?: string;
  "patch-file"?: string;
}

export function cmdEvent(args: string[], flags: EventFlags): number {
  const ws = requireWorkspace();
  const name = validateProjectName(args[0]);
  const p = projectPaths(ws, name);
  readState(p);
  if (!flags.type) throw new UserError("--type is required");
  const payload = parseJson(flags.payload, "--payload") ?? {};
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new UserError("--payload must be a JSON object");
  }
  const reason = (payload as Record<string, unknown>).reason;
  if (flags.type === "plan.rejected" && !(PLAN_REJECTION_REASONS as readonly unknown[]).includes(reason)) {
    throw new UserError(
      `plan.rejected needs payload.reason: one of ${PLAN_REJECTION_REASONS.join(", ")} (got ${JSON.stringify(reason ?? null)}).`,
    );
  }
  const patch = flags["patch-file"] ? fs.readFileSync(flags["patch-file"], "utf8") : undefined;
  const ev = appendEvent(p, {
    actor: flags.actor ?? "coordinator",
    type: flags.type,
    target: flags.target ?? null,
    payload: payload as Record<string, unknown>,
    ...(patch !== undefined ? { patch } : {}),
  });
  out(JSON.stringify({ seq: ev.seq }));
  return 0;
}

export function cmdState(args: string[], flags: { patch?: string; actor?: string }): number {
  const ws = requireWorkspace();
  const name = validateProjectName(args[0]);
  const p = projectPaths(ws, name);
  const state =
    flags.patch !== undefined ? patchState(p, parseJson(flags.patch, "--patch"), flags.actor) : readState(p);
  out(JSON.stringify(state, null, 2));
  return 0;
}

export interface WorktreeFlags {
  repo?: string;
  branch?: string;
  package?: string;
  base?: string;
}

/** Resolve a repos.json entry to a local checkout, cloning `url` into `repos/<key>` if needed. */
function resolveRepoPath(ws: Workspace, key: string, entry: { path?: string; url?: string }): string {
  if (entry.path) {
    const abs = path.resolve(ws.root, entry.path);
    if (!isGitRepo(abs)) throw new UserError(`repos.json "${key}".path is not a git repository: ${abs}`);
    return abs;
  }
  if (!entry.url) throw new UserError(`repos.json "${key}" needs a "path" or "url".`);
  const dest = path.join(ws.repos, key);
  if (!isGitRepo(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    git(ws.root, ["clone", "--quiet", entry.url, dest]);
  }
  return dest;
}

export function cmdWorktree(args: string[], flags: WorktreeFlags): number {
  const ws = requireWorkspace();
  const name = validateProjectName(args[0]);
  const childId = args[1];
  if (!childId)
    throw new UserError("Usage: openfleet worktree <project> <child id> [--repo <key>] [--branch <branch>]");
  const parts = requireChildId(childId);
  const p = projectPaths(ws, name);
  const state = readState(p);
  const repoKey = flags.repo ?? state.children[childId]?.repo ?? parts.repo;
  const entry = readRepos(ws).repos[repoKey];
  if (!entry) throw new UserError(`Repo "${repoKey}" is not in repos.json.`);
  const integration = state.children[repoKey]?.integration ? state.children[repoKey] : undefined;
  const branch = flags.branch ?? state.children[childId]?.branch ?? defaultBranch(name, childId, integration?.branch);
  if (integration && childId !== repoKey) {
    const ib = integration.branch ?? `openfleet/${name}`;
    if (branch === ib || branch.startsWith(`${ib}/`)) {
      throw new UserError(
        `Branch "${branch}" clashes with the integration branch "${ib}" of repo ${repoKey}. Use "${defaultBranch(name, childId, ib)}".`,
      );
    }
  }
  const repoPath = resolveRepoPath(ws, repoKey, entry);
  const worktree = path.join(p.worktrees, childId.replace(/[:/]/g, "__"));
  const base = flags.base ?? entry.defaultBranch;
  const existed = fs.existsSync(worktree);
  if (!existed) addWorktree(repoPath, worktree, branch, base);
  const baseSha = state.children[childId]?.baseSha ?? headSha(worktree);
  const copy = copyIntoWorktree(repoPath, worktree, entry.copyFiles ?? []);
  for (const bad of copy.invalid) warn(`repos.json "${repoKey}".copyFiles: "${bad.path}" ${bad.error}; skipped.`);
  for (const rel of copy.missing) warn(`copyFiles: ${rel} does not exist in ${repoPath}; skipped.`);
  const next = updateState(p, (s) => {
    const prev = s.children[childId];
    s.children[childId] = {
      phase: "pending",
      retries: 0,
      dependsOn: [],
      agentIds: {},
      ...prev,
      repo: repoKey,
      repoPath,
      worktree,
      branch,
      ...(base ? { baseBranch: base } : {}),
      ...(baseSha ? { baseSha } : {}),
      ...((flags.package ?? prev?.package) ? { package: flags.package ?? prev?.package } : {}),
      ...(copy.copied.length || prev?.copiedFiles?.length
        ? { copiedFiles: [...new Set([...(prev?.copiedFiles ?? []), ...copy.copied])] }
        : {}),
    };
  });
  if (!existed) {
    appendEvent(p, {
      actor: "coordinator",
      type: "worktree.created",
      target: childId,
      payload: {
        repo: repoKey,
        repoPath,
        worktree,
        branch,
        base: base ?? null,
        baseSha: baseSha ?? null,
        copiedFiles: copy.copied,
        missingCopyFiles: copy.missing,
      },
    });
  }
  out(JSON.stringify(next.children[childId], null, 2));
  return 0;
}

/** `npx openfleet spec-check <project>`: the greenfield scope problems that would block approval (exit 1 if any). */
export function cmdSpecCheck(args: string[]): number {
  const ws = requireWorkspace();
  const p = projectPaths(ws, validateProjectName(args[0]));
  const state = readState(p);
  const problems = state.greenfield || state.continuedFrom ? greenfieldProblems(p, state) : [];
  const limits = greenfieldLimits(readConfig(ws));
  out(JSON.stringify({ ok: !problems.length, greenfield: state.greenfield === true, limits, problems }, null, 2));
  return problems.length ? 1 : 0;
}
