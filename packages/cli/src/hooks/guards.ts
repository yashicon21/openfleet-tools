// Guards enforced by the CLI instead of trusted to the agents, from runs where a weaker coordinator
// skipped the protocol: no run summary while children are unfinished, no role agent spawned without
// a claim (or as a subagent when roles run as sessions), and no file writes outside the worktree a
// role owns (nor by a coordinator into repos or worktrees). The `preToolUse` hook denies the tool
// call and logs `guard.refused`. Shell commands are not inspected.
import os from "node:os";
import path from "node:path";
import { actorFor, bareAgentName, roleFromAgentName } from "../attribution.js";
import { CLAIM_TTL_MS } from "../claim.js";
import { agentModeOf, readConfig } from "../config.js";
import { appendEvent } from "../events.js";
import { isInside, realish } from "../fsutil.js";
import { readRepos } from "../repos.js";
import { isFinal, readState, type ChildState, type ProjectState, type Role } from "../state.js";
import { projectPaths, type ProjectPaths } from "../workspace.js";
import { fileChangesFromTool, type HookContext, type HookOutput, type HookPayload } from "./handlers.js";

/** Statuses in which the run summary may be written: finalizing or later, or a halted run (section 2b). */
const SUMMARY_OK = ["finalizing", "done", "cancelled"];

/** Children that are not finished for good (escalations count as unfinished). */
export function unfinishedChildren(state: ProjectState): string[] {
  return Object.entries(state.children)
    .filter(([, c]) => !isFinal(c))
    .map(([id]) => id);
}

/** Why the project may not move to `finalizing`/`done` (or write its summary) yet, if it may not. */
export function finalizeBlocker(state: ProjectState): string | undefined {
  if (state.halt) return undefined;
  const open = unfinishedChildren(state);
  if (!open.length) return undefined;
  return `children are not finished yet: ${open.map((id) => `${id} (${state.children[id]!.phase})`).join(", ")}`;
}

function refuse(p: ProjectPaths, actor: string, guard: string, reason: string, extra: Record<string, unknown> = {}) {
  appendEvent(p, { actor, type: "guard.refused", target: null, payload: { guard, reason, ...extra } });
  return { deny: `OpenFleet refused this: ${reason}` };
}

/** Agent name a spawn tool call asks for (Claude `Agent`/`Task`, Copilot `task`). */
function spawnedAgent(toolName: string | undefined, args: unknown): string | undefined {
  if (!toolName || !/^(agent|task)$/i.test(toolName)) return undefined;
  const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const name = a.subagent_type ?? a.agent_type ?? a.agent ?? a.agentName;
  return typeof name === "string" ? name : undefined;
}

function freshClaim(c: ChildState, role: Role, now: number): boolean {
  return c.pendingSpawn === role && (!c.claimedAt || now - Date.parse(c.claimedAt) < CLAIM_TTL_MS);
}

/** The work role this tool call acts for: the role session's, or a role subagent's by its recorded id. */
function callerRole(
  ctx: HookContext,
  state: ProjectState,
  payload: HookPayload,
): [string, ChildState, string] | undefined {
  if (ctx.job?.child) {
    const c = state.children[ctx.job.child];
    return c ? [ctx.job.child, c, ctx.job.role] : undefined;
  }
  if (!payload.agentId) return undefined;
  for (const [id, c] of Object.entries(state.children)) {
    for (const [role, agentId] of Object.entries(c.agentIds)) {
      if (agentId === payload.agentId && role !== "repo-coordinator") return [id, c, role];
    }
  }
  return undefined;
}

/** Dirs a coordinator never writes into: cloned and local repos and every worktree. */
function codeRoots(ctx: HookContext, p: ProjectPaths, state: ProjectState): string[] {
  const roots = [ctx.ws.repos, p.worktrees];
  for (const c of Object.values(state.children)) if (c.worktree) roots.push(c.worktree);
  try {
    for (const r of Object.values(readRepos(ctx.ws).repos)) if (r.path) roots.push(path.resolve(ctx.ws.root, r.path));
  } catch {
    // unreadable repos.json: check the rest
  }
  return roots.map(realish);
}

export function onPreToolUse(ctx: HookContext, payload: HookPayload): HookOutput {
  if (!ctx.project) return {};
  const p = projectPaths(ctx.ws, ctx.project);
  let state: ProjectState;
  try {
    state = readState(p);
  } catch {
    return {};
  }
  const caller = callerRole(ctx, state, payload);
  const actor = caller ? actorFor(caller[0], caller[2]) : payload.agentId ? "subagent" : "coordinator";

  // Spawns: a role agent needs a fresh claim; with role sessions only repo coordinators are subagents.
  const agent = spawnedAgent(payload.toolName, payload.toolArgs);
  const role = agent ? roleFromAgentName(agent) : undefined;
  if (agent && role && role !== "coordinator") {
    const name = bareAgentName(agent) ?? agent;
    if (role !== "repo-coordinator" && agentModeOf(readConfig(ctx.ws)) === "session") {
      return refuse(
        p,
        actor,
        "spawn",
        `${name} runs as its own session here. Start it with \`npx openfleet agent start ${p.name} <child> --role ${role}\`, not as a subagent.`,
        { agent: name },
      );
    }
    const now = Date.now();
    if (!Object.values(state.children).some((c) => freshClaim(c, role, now))) {
      return refuse(
        p,
        actorFor("unknown", role),
        "claim",
        `no child is claimed for ${role}. Run \`npx openfleet claim ${p.name} <child> ${role}\` right before the spawn.`,
        { agent: name },
      );
    }
    return {};
  }

  const files = fileChangesFromTool(payload.toolName, payload.toolArgs);
  if (!files.length) return {};
  const cwd = payload.cwd ?? ctx.ws.root;
  for (const f of files) {
    const abs = realish(path.resolve(cwd, f.path));
    // The run summary waits for every child (or a halt).
    if (abs === realish(path.join(p.dir, "summary.md")) && !SUMMARY_OK.includes(state.status)) {
      const why = finalizeBlocker(state);
      if (why) {
        return refuse(p, actor, "summary", `the run summary is written at finalize; ${why}.`, { path: f.path });
      }
    }
    if (caller) {
      const [id, child, r] = caller;
      // Extension agents may write reports; work roles change only their own worktree (and temp files).
      if (!child.worktree || r === "extension") continue;
      const inWorktree = isInside(realish(child.worktree), abs);
      const scratch = isInside(realish(os.tmpdir()), abs) && !isInside(realish(ctx.ws.root), abs);
      if (!inWorktree && !scratch) {
        return refuse(
          p,
          actor,
          "worktree",
          `${id}/${r} may change files only inside its worktree ${child.worktree} (not ${abs}).`,
          { path: f.path },
        );
      }
    } else if (!ctx.job) {
      // The coordinator (or a repo coordinator) never edits code.
      const root = codeRoots(ctx, p, state).find((dir) => isInside(dir, abs));
      if (root) {
        return refuse(
          p,
          actor,
          "coordinator-write",
          `coordinators never edit code (${abs} is inside ${root}). Start an implementer for the child instead.`,
          { path: f.path },
        );
      }
    }
  }
  return {};
}
