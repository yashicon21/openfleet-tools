import path from "node:path";
import { isInside, realish } from "./fsutil.js";
import { readState, type ChildPhase, type ChildState, type ProjectState, type Role } from "./state.js";
import { listProjectNames, projectPaths, type ProjectPaths, type Workspace } from "./workspace.js";

const PHASE_ROLE: Partial<Record<ChildPhase, Role>> = {
  planning: "planner",
  "plan-review": "planner",
  baseline: "baseline",
  implementing: "implementer",
  testing: "tester",
};

export function roleOf(child: ChildState): Role | undefined {
  return child.role ?? PHASE_ROLE[child.phase];
}

/** Copilot namespaces plugin agents as `<plugin>:<agent>`. */
export const PLUGIN_NAME = "openfleet";

export function bareAgentName(agentName: string | undefined): string | undefined {
  return agentName?.startsWith(`${PLUGIN_NAME}:`) ? agentName.slice(PLUGIN_NAME.length + 1) : agentName;
}

export function qualifiedAgentName(agent: string): string {
  return agent.includes(":") ? agent : `${PLUGIN_NAME}:${agent}`;
}

export function roleFromAgentName(agentName: string | undefined): Role | "coordinator" | undefined {
  switch (bareAgentName(agentName)) {
    case "openfleet-planner":
      return "planner";
    case "openfleet-baseline":
      return "baseline";
    case "openfleet-implementer":
      return "implementer";
    case "openfleet-tester":
      return "tester";
    case "openfleet-repo-coordinator":
      return "repo-coordinator";
    case "openfleet-coordinator":
      return "coordinator";
    default:
      return undefined;
  }
}

export function actorFor(childId: string, role: string | undefined): string {
  return `${childId}/${role ?? "unknown"}`;
}

export interface Located {
  project: ProjectPaths;
  state: ProjectState;
  childId: string;
  child: ChildState;
  /** Path relative to the child's worktree. */
  rel: string;
}

function safeState(p: ProjectPaths): ProjectState | undefined {
  try {
    return readState(p);
  } catch {
    return undefined;
  }
}

/** Candidate projects: the explicit one if given, otherwise every project in the workspace. */
export function candidateProjects(ws: Workspace, project?: string): ProjectPaths[] {
  const names = project ? [project] : listProjectNames(ws);
  return names.map((n) => projectPaths(ws, n));
}

/** Attribute an absolute file path to project → child worktree (longest match wins). */
export function locatePath(ws: Workspace, absPath: string, project?: string): Located | undefined {
  let best: Located | undefined;
  let bestLen = -1;
  const target = realish(absPath);
  for (const p of candidateProjects(ws, project)) {
    const state = safeState(p);
    if (!state) continue;
    for (const [childId, child] of Object.entries(state.children)) {
      if (!child.worktree) continue;
      const wt = realish(child.worktree);
      if (!isInside(wt, target) || wt.length <= bestLen) continue;
      bestLen = wt.length;
      best = { project: p, state, childId, child, rel: path.relative(wt, target) };
    }
  }
  return best;
}
