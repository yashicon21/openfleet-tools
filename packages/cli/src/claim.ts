// `npx openfleet claim`: the spawn lock. Before spawning any planner, baseline,
// implementer, tester or repo coordinator, a coordinator claims the child for that
// role. The claim enforces the workspace-wide `maxParallel` (openfleet.json) and keeps at most
// one fresh claim per role, so the subagentStart hook attributes the spawn exactly.
import path from "node:path";
import { readConfig } from "./config.js";
import { appendEvent } from "./events.js";
import { headSha, tryGit } from "./git.js";
import { groupOf } from "./groups.js";
import { withLock } from "./lock.js";
import { isFinal, readState, updateState, type ChildPhase, type ProjectState, type Role } from "./state.js";
import { listProjectNames, projectPaths, UserError, type Workspace } from "./workspace.js";

export const ROLES: readonly Role[] = ["planner", "baseline", "implementer", "tester", "repo-coordinator"];
const WORK_PHASE: Record<Exclude<Role, "repo-coordinator">, ChildPhase> = {
  planner: "planning",
  baseline: "baseline",
  implementer: "implementing",
  tester: "testing",
};
const BUSY: readonly ChildPhase[] = ["planning", "baseline", "implementing", "testing"];
/** A claim nobody consumed within this time is ignored (the spawn failed or was never made). */
export const CLAIM_TTL_MS = 5 * 60_000;
export const RETRY_AFTER_SECONDS = 5;

export type ClaimResult =
  | {
      result: "claimed";
      child: string;
      role: Role;
      phase: ChildPhase;
      busy: number;
      maxParallel: number;
      synced?: string;
    }
  | { result: "wait"; child: string; role: Role; reason: string; retryAfterSeconds: number };

function fresh(claimedAt: string | undefined, now: number): boolean {
  return !claimedAt || now - Date.parse(claimedAt) < CLAIM_TTL_MS;
}

function liveStates(ws: Workspace): [string, ProjectState][] {
  const out: [string, ProjectState][] = [];
  for (const name of listProjectNames(ws)) {
    try {
      const s = readState(projectPaths(ws, name));
      if (s.status === "running" || s.status === "specifying") out.push([name, s]);
    } catch {
      // Unreadable projects do not count.
    }
  }
  return out;
}

/** Children (across every live project) with a running or freshly claimed planner, baseline, implementer or tester. */
export function busyChildren(ws: Workspace, now = Date.now(), except?: [string, string]): string[] {
  const busy: string[] = [];
  for (const [project, s] of liveStates(ws)) {
    for (const [id, c] of Object.entries(s.children)) {
      if (except && except[0] === project && except[1] === id) continue;
      const claimed = c.pendingSpawn && c.pendingSpawn !== "repo-coordinator" && fresh(c.claimedAt, now);
      if (BUSY.includes(c.phase) || claimed) busy.push(`${project}/${id}`);
    }
  }
  return busy;
}

function checkRole(role: string | undefined): Role {
  if (!role || !(ROLES as readonly string[]).includes(role)) {
    throw new UserError(`Unknown role "${role ?? ""}". Use one of: ${ROLES.join(", ")}.`);
  }
  return role as Role;
}

/** Bring a grouped child's branch up to the integration branch before it is implemented. */
function syncWithIntegration(state: ProjectState, id: string): string | undefined {
  const c = state.children[id]!;
  const group = groupOf(state, id);
  if (!group || c.conflict || c.syncedSha || !c.worktree) return undefined;
  const integration = state.children[group]!;
  if (!integration.branch || !integration.worktree) return undefined;
  const tip = tryGit(c.worktree, ["rev-parse", integration.branch])?.trim();
  if (!tip || tip === headSha(c.worktree)) return undefined;
  if (tryGit(c.worktree, ["merge", "--ff-only", "--quiet", integration.branch]) === undefined) return undefined;
  return tip;
}

export function claim(ws: Workspace, project: string, childId: string, roleArg: string | undefined): ClaimResult {
  const role = checkRole(roleArg);
  const p = projectPaths(ws, project);
  return withLock(path.join(ws.root, ".claim.lock"), () => {
    const now = Date.now();
    const state = readState(p);
    const c = state.children[childId];
    if (!c) throw new UserError(`Unknown child "${childId}".`);
    if (isFinal(c) || c.phase === "blocked") throw new UserError(`Child ${childId} is "${c.phase}".`);
    if (role === "repo-coordinator" && !c.integration) {
      throw new UserError(
        `Only a repo's integration child (the repo key) gets a repo coordinator; "${childId}" is not one.`,
      );
    }
    const pf = state.preflight;
    if (pf && (!pf.ok || pf.stale)) {
      throw new UserError(
        `Preflight ${pf.stale ? "has not run since resume" : "failed"} for project ${project}. ` +
          `Run \`npx openfleet preflight ${project}\` and fix any failure before spawning agents.`,
      );
    }
    if ((role === "planner" || role === "baseline") && c.integration) {
      throw new UserError(`Integration child ${childId} has no ${role}.`);
    }
    const wait = (reason: string): ClaimResult => ({
      result: "wait",
      child: childId,
      role,
      reason,
      retryAfterSeconds: RETRY_AFTER_SECONDS,
    });
    for (const [name, s] of liveStates(ws)) {
      for (const [id, other] of Object.entries(s.children)) {
        if (name === project && id === childId) continue;
        if (other.pendingSpawn === role && fresh(other.claimedAt, now)) {
          return wait(`${name}/${id} has an unconsumed ${role} claim; spawn that agent first`);
        }
      }
    }
    const { maxParallel } = readConfig(ws);
    const busy = busyChildren(ws, now, [project, childId]);
    if (role !== "repo-coordinator" && busy.length >= maxParallel) {
      return wait(`${busy.length} of ${maxParallel} agents are running: ${busy.join(", ")}`);
    }
    let synced: string | undefined;
    const next = updateState(p, (s) => {
      const child = s.children[childId]!;
      child.pendingSpawn = role;
      child.claimedAt = new Date(now).toISOString();
      if (role === "repo-coordinator") return;
      if (role === "implementer" && child.phase === "planned") {
        synced = syncWithIntegration(s, childId);
        if (synced) {
          child.syncedSha = synced;
          child.baseSha = synced;
          delete child.lastSnapshot;
        }
      }
      child.phase = WORK_PHASE[role];
    });
    if (synced) {
      appendEvent(p, {
        actor: "coordinator",
        type: "worktree.synced",
        target: childId,
        payload: { onto: next.children[groupOf(next, childId)!]?.branch ?? null, sha: synced },
      });
    }
    return {
      result: "claimed",
      child: childId,
      role,
      phase: next.children[childId]!.phase,
      busy: busy.length + (role === "repo-coordinator" ? 0 : 1),
      maxParallel,
      ...(synced ? { synced } : {}),
    };
  });
}
