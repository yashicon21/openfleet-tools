// Deterministic run scheduling: every plan first, then the `plans-ready` gate, then
// baselines and implementation in `dependsOn` order. Repos with several children are
// run by a repo coordinator, which merges them into an integration branch.
// `npx openfleet next` prints this.
import { groupOf, isSetup, membersOf } from "./groups.js";
import { activeChildren, isEscalated, isFinal, type ChildPhase, type ProjectState } from "./state.js";

/** `top` for the top coordinator, otherwise the repo key of the repo coordinator that acts on it. */
export type Owner = string;

export type Action = { owner: Owner } & (
  | { action: "repo-coordinator"; repo: string }
  | { action: "plan"; child: string }
  | { action: "check-repo-consistency"; repo: string; children: string[] }
  | { action: "check-consistency"; children: string[] }
  | { action: "plans-ready" }
  | { action: "baseline"; child: string }
  | { action: "implement"; child: string }
  | { action: "resolve-conflict"; child: string; files: string[]; outside: string[] }
  | { action: "merge"; child: string; into: string }
  | { action: "integrate"; child: string }
  | { action: "block"; child: string; dependency: string }
  | { action: "finalize" }
  | { action: "preflight"; reason: "failed" | "stale" }
);

export interface Waiting {
  child: string;
  owner: Owner;
  reason: string;
}

export type GateState = "planning" | "checking" | "plans-ready" | "open";

export interface Schedule {
  gate: GateState;
  actions: Action[];
  waiting: Waiting[];
}

export const TOP = "top";
const PLANNING: readonly ChildPhase[] = ["pending", "planning", "plan-review"];

/** Next merge for a grouped repo: setup first, then children in the order they reached `done`. */
export function nextMerge(state: ProjectState, repo: string): string | undefined {
  const members = membersOf(state, repo).map((id) => [id, state.children[id]!] as const);
  const setup = members.find(([id, c]) => isSetup(id, c) && !c.merged && c.phase !== "failed" && c.phase !== "blocked");
  if (setup) return setup[1].phase === "done" ? setup[0] : undefined;
  return members
    .filter(([, c]) => c.phase === "done" && !c.merged)
    .sort(([, a], [, b]) => (a.doneAt ?? "").localeCompare(b.doneAt ?? ""))[0]?.[0];
}

/** What the coordinators should do next. Only meaningful while the project is `running`. */
export function schedule(state: ProjectState): Schedule {
  const pf = state.preflight;
  if (pf && (!pf.ok || pf.stale)) {
    // Nothing may spawn until git can write in every repo (see `npx openfleet preflight`).
    const gate: GateState = state.plansReady ? "open" : "planning";
    return { gate, actions: [{ owner: TOP, action: "preflight", reason: pf.stale ? "stale" : "failed" }], waiting: [] };
  }
  const actions: Action[] = [];
  const waiting: Waiting[] = [];
  const needsCheck: string[] = [];
  const repoChecks = new Map<string, string[]>();
  const gateOpen = state.plansReady === true;
  const ownerOf = (id: string): Owner => {
    const c = state.children[id]!;
    return c.integration ? c.repo : (groupOf(state, id) ?? TOP);
  };
  const failedDep = (deps: string[]) =>
    deps.find((d) => {
      const c = state.children[d];
      return c !== undefined && (c.phase === "failed" || (c.phase === "blocked" && !isEscalated(c)));
    });

  for (const [id, c] of Object.entries(state.children)) {
    if (isFinal(c)) continue;
    const owner = ownerOf(id);
    if (c.integration && c.coordinator !== "running" && !c.pendingSpawn) {
      actions.push({ owner: TOP, action: "repo-coordinator", repo: id });
    }
    if (isEscalated(c)) {
      waiting.push({ child: id, owner: TOP, reason: `escalated: ${c.escalation?.question ?? "question"}` });
      continue;
    }
    const bad = failedDep(c.dependsOn);
    if (bad) {
      actions.push({ owner, action: "block", child: id, dependency: bad });
      continue;
    }
    if (c.integration) {
      if (c.phase !== "pending") {
        waiting.push({ child: id, owner, reason: `integration ${c.phase} in progress` });
        continue;
      }
      const unmerged = c.dependsOn.filter((m) => !state.children[m]?.merged);
      const next = nextMerge(state, id);
      if (next) actions.push({ owner, action: "merge", child: next, into: id });
      if (!unmerged.length) actions.push({ owner, action: "integrate", child: id });
      else if (!next) waiting.push({ child: id, owner, reason: `members: ${unmerged.join(", ")}` });
      continue;
    }
    switch (c.phase) {
      case "pending":
        actions.push({ owner, action: "plan", child: id });
        break;
      case "planning":
        waiting.push({ child: id, owner, reason: "planner running" });
        break;
      case "plan-review":
        waiting.push({ child: id, owner, reason: "plan under review" });
        break;
      case "planned": {
        const group = groupOf(state, id);
        if (group && !c.repoConsistent) {
          repoChecks.set(group, [...(repoChecks.get(group) ?? []), id]);
          break;
        }
        if (!c.consistent) {
          needsCheck.push(id);
          break;
        }
        if (!gateOpen) {
          waiting.push({ child: id, owner, reason: "plans-ready gate" });
          break;
        }
        if (c.conflict) {
          actions.push({
            owner,
            action: "resolve-conflict",
            child: id,
            files: c.conflict.files,
            outside: c.conflict.outside,
          });
          break;
        }
        if (c.baseline && !c.baselinePassed) {
          actions.push({ owner, action: "baseline", child: id });
          break;
        }
        // Siblings in the same group must be merged, so this child can build on them.
        const open = c.dependsOn.filter((d) => {
          const dep = state.children[d];
          if (dep?.phase !== "done") return true;
          return group !== undefined && groupOf(state, d) === group && !dep.merged;
        });
        if (open.length) waiting.push({ child: id, owner, reason: `dependencies: ${open.join(", ")}` });
        else actions.push({ owner, action: "implement", child: id });
        break;
      }
      case "baseline":
        waiting.push({ child: id, owner, reason: "baseline tester running" });
        break;
      default:
        waiting.push({ child: id, owner, reason: `${c.phase} in progress` });
    }
  }

  // Planning and the gate only concern real children, not integration children.
  const active = activeChildren(state).filter(([, c]) => !c.integration);
  const blocking = new Set(actions.filter((a) => a.action === "block").map((a) => (a as { child: string }).child));
  const stillPlanning = active.filter(([id, c]) => !blocking.has(id) && PLANNING.includes(c.phase));

  for (const [repo, children] of repoChecks) {
    const siblingsPlanning = stillPlanning.some(([id]) => groupOf(state, id) === repo);
    if (gateOpen || !siblingsPlanning) {
      actions.push({ owner: repo, action: "check-repo-consistency", repo, children });
    } else {
      for (const id of children)
        waiting.push({ child: id, owner: repo, reason: "sibling plans (repo consistency check)" });
    }
  }

  let gate: GateState = gateOpen ? "open" : "planning";
  if (needsCheck.length) {
    if (gateOpen || (!stillPlanning.length && !repoChecks.size)) {
      actions.push({ owner: TOP, action: "check-consistency", children: needsCheck });
      if (!gateOpen) gate = "checking";
    } else {
      for (const id of needsCheck) {
        waiting.push({ child: id, owner: TOP, reason: "other plans (consistency check)" });
      }
    }
  } else if (!gateOpen && active.length && !stillPlanning.length && !repoChecks.size && !blocking.size) {
    actions.push({ owner: TOP, action: "plans-ready" });
    gate = "plans-ready";
  }

  const all = Object.values(state.children);
  if (all.length && all.every(isFinal)) actions.push({ owner: TOP, action: "finalize" });
  return { gate, actions, waiting };
}

/** The part of the schedule one coordinator acts on: `top`, or a repo key for a repo coordinator. */
export function scheduleFor(state: ProjectState, owner: Owner = TOP): Schedule & { delegated?: Action[] } {
  const s = schedule(state);
  const mine = s.actions.filter((a) => a.owner === owner);
  if (owner !== TOP) return { gate: s.gate, actions: mine, waiting: s.waiting.filter((w) => w.owner === owner) };
  return { ...s, actions: mine, delegated: s.actions.filter((a) => a.owner !== TOP) };
}
