import fs from "node:fs";
import path from "node:path";
import { greenfieldLimits, readConfig } from "./config.js";
import { appendEvent } from "./events.js";
import { parseChildId, syncIntegrationChildren } from "./groups.js";
import { readJson, writeJson } from "./fsutil.js";
import { withLock } from "./lock.js";
import { greenfieldViolations } from "./greenfield.js";
import { UserError, workspaceAt, type ProjectPaths } from "./workspace.js";
import type { Host } from "./hosts.js";

export const STATE_SCHEMA_VERSION = 1;

/** `specifying` covers the whole grill, including the final spec review; the user's answer moves it to `running`. */
export const PROJECT_STATUSES = ["specifying", "running", "finalizing", "done", "cancelled"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * `planned`: the plan is validated and the child waits for the `plans-ready` gate, its
 * dependencies or its baseline. `baseline`: a baseline tester is writing tests against
 * the unchanged code. `failed`: retries and the coordinator's guided attempt both failed.
 * `blocked`: a dependency failed, or (with `blockedReason: "needs-escalation"`) the child
 * waits for the top coordinator to decide a cross-repo question.
 */
export const CHILD_PHASES = [
  "pending",
  "planning",
  "plan-review",
  "planned",
  "baseline",
  "implementing",
  "testing",
  "post-test",
  "done",
  "failed",
  "blocked",
] as const;
export type ChildPhase = (typeof CHILD_PHASES)[number];

export type WorkRole = "planner" | "baseline" | "implementer" | "tester";
export type Role = WorkRole | "repo-coordinator";

/** Each child gets `PORT_STEP` ports starting at `PORT_BASE + PORT_STEP × slot`. */
export const PORT_BASE = 4100;
export const PORT_STEP = 10;

/** `main`: greenfield repos only, commit the result on the new repo's `main` (no remote). */
export type CompletionMode = "staged" | "draft-pr" | "main";

/**
 * What a greenfield child builds. `setup` scaffolds a repo, `contracts` writes the shared
 * schemas and generated clients, `service` / `frontend` build on them and `system` wires
 * everything together with one end-to-end flow. Run order: setup → contracts → service ∥ frontend → system.
 */
export const CHILD_KINDS = ["setup", "contracts", "service", "frontend", "system"] as const;
export type ChildKind = (typeof CHILD_KINDS)[number];

export interface ChildState {
  /** Key in repos.json. */
  repo: string;
  /** Package path inside a monorepo, if this child targets one package. */
  package?: string;
  /** Absolute path of the source repository checkout. */
  repoPath?: string;
  worktree?: string;
  branch?: string;
  baseBranch?: string;
  /** Commit the worktree branched from; snapshots diff against it. */
  baseSha?: string;
  phase: ChildPhase;
  /** Role of the currently active agent for this child. */
  role?: Role;
  /** Set by `npx openfleet claim` just before spawning; consumed by the subagentStart hook. */
  pendingSpawn?: Role;
  /** When the pending claim was made. Claims older than the claim TTL are ignored. */
  claimedAt?: string;
  /** Globs (relative to the repo, or to `package`) this child owns. Path-scoped children only. */
  paths?: string[];
  /** Extra globs the spec explicitly lets this child change (for example shared test fixtures). */
  allowPaths?: string[];
  /** Shared-setup child of a repo with path-scoped children (unit `setup`). */
  setup?: boolean;
  /** Greenfield child kind; in a greenfield project it sets the child's dependencies (see `CHILD_KINDS`). */
  kind?: ChildKind;
  /** Shared items (config, components, utils) the setup child must provide for its siblings. */
  sharedItems?: string[];
  /** Integration child of a grouped repo: id = repo key, branch = the repo's integration branch. */
  integration?: boolean;
  /** Repo coordinator of an integration child: `running` from spawn to stop (reset by `resume`). */
  coordinator?: "running" | "stopped";
  /** The plan passed the repo coordinator's check against its sibling plans (grouped repos only). */
  repoConsistent?: boolean;
  /** Merged into the repo's integration branch by `npx openfleet merge`. */
  merged?: boolean;
  mergedAt?: string;
  /** When the child last reached `done`; grouped children merge in this order (setup first). */
  doneAt?: string;
  /** Set when merging conflicted: the branch was rebased onto `onto` and an implementer must resolve `files`. */
  conflict?: { files: string[]; outside: string[]; onto: string };
  /** Integration tip the branch was fast-forwarded to before implementing. */
  syncedSha?: string;
  /** Why the child is `blocked`. */
  blockedReason?: "dependency" | "needs-escalation";
  /** Open cross-repo question sent to the top coordinator, and the phase to return to. */
  escalation?: { question: string; phase: ChildPhase; at: string };
  /** Decisions the top coordinator made on this child's escalated questions; injected into its prompts. */
  decisions?: string[];
  retries: number;
  dependsOn: string[];
  agentIds: Partial<Record<Role, string>>;
  plan?: string;
  /** Integration child split into stacked PRs (`npx openfleet stack`): one layer per merged child, bottom first. */
  stack?: { child: string; branch: string; sha: string }[];
  /** Set by finalize, or mid-run by an extension output named `prUrl`. Finalize then updates this PR. */
  prUrl?: string;
  /** Extension outputs, keyed by extension name. Injected into dependents' prompts by the spawn hook. */
  outputs?: Record<string, Record<string, string>>;
  /** Extension follow-ups for people after the run, keyed by extension name. */
  followUps?: Record<string, string[]>;
  lastSnapshot?: string;
  notes?: string;
  /** The plan passed the consistency check against the spec's Shared approach and the other plans. */
  consistent?: boolean;
  /** Write baseline tests against the unchanged code before implementing (decided in the grill). */
  baseline?: boolean;
  /** What the baseline tests must cover. */
  baselineCover?: string;
  /** Baseline test files (relative to the worktree), recorded by `npx openfleet baseline`. */
  baselineFiles?: string[];
  /** sha256 of each baseline file when the baseline passed, to detect later edits. */
  baselineHashes?: Record<string, string>;
  baselinePassed?: boolean;
  /** First port of this child's range (`PORT_STEP` ports). Allocated once, never reused by another child. */
  portBase?: number;
  /** Files copied from the main checkout by `copyFiles`. Never committed, never logged. */
  copiedFiles?: string[];
}

export interface Question {
  id: string;
  from: string;
  text: string;
  status: "open" | "answered";
  answer?: string;
  /** `spec`: answered from spec.md/contracts. `coordinator`: decided by the coordinator (logged as an `assumption`). */
  answeredBy?: "spec" | "coordinator";
}

export interface ProjectState {
  v: typeof STATE_SCHEMA_VERSION;
  name: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  /** Host session id of the coordinator session, used by `resume`. */
  sessionId?: string;
  /** Agent host the project runs in, recorded at `new`. Missing means Copilot CLI. */
  host?: Host;
  completionMode?: CompletionMode;
  /** `draft-pr` on GitHub: open a repo with several children as stacked PRs (`gh stack`), one per child. */
  prStack?: boolean;
  /** The project creates its repos from scratch (`npx openfleet repo create`) instead of changing existing code. */
  greenfield?: boolean;
  specApproved?: boolean;
  /** Keyed by child id: `<repo>`, `<repo>:<package>` or `<repo>[:<package>]/<unit>`. */
  children: Record<string, ChildState>;
  questions: Question[];
  /** Follow-ups from project-level extension slots (`pre-spec`, `plans-ready`, `post-run`), keyed by extension name. */
  followUps?: Record<string, string[]>;
  /** The `plans-ready` gate is open: every plan was validated and checked for consistency, and the slot ran. */
  plansReady?: boolean;
  /** Greenfield: toolchains the chosen stack needs besides node, git and docker (for example `pnpm`, `uv`, `go`). Preflight checks them. */
  toolchains?: string[];
  /** Project this one continues (`npx openfleet continue`): its Follow-ups seeded this spec, its repos and stack are reused. */
  continuedFrom?: string;
  /** Last `npx openfleet preflight` result. `stale` is set by `resume`, until preflight runs again. */
  preflight?: { ok: boolean; at: string; stale?: boolean };
}

export function isEscalated(c: ChildState): boolean {
  return c.phase === "blocked" && c.blockedReason === "needs-escalation";
}

/** Finished for good: `done`, `failed`, or `blocked` by a failed dependency (not waiting on an escalation). */
export function isFinal(c: ChildState): boolean {
  return c.phase === "done" || c.phase === "failed" || (c.phase === "blocked" && !isEscalated(c));
}

/** Children that are still part of the run (not `failed` or permanently `blocked`). */
export function activeChildren(state: ProjectState): [string, ChildState][] {
  return Object.entries(state.children).filter(
    ([, c]) => c.phase !== "failed" && (c.phase !== "blocked" || isEscalated(c)),
  );
}

/** Lowest free port slot, so a child keeps its range for the whole project. */
export function nextPortBase(state: ProjectState): number {
  const used = new Set(Object.values(state.children).map((c) => c.portBase));
  let base = PORT_BASE;
  while (used.has(base)) base += PORT_STEP;
  return base;
}

/** Every child that depends on `id`, directly or transitively. */
export function dependentsOf(state: ProjectState, id: string): string[] {
  const out = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const [cid, c] of Object.entries(state.children)) {
      if (!out.has(cid) && cid !== id && (c.dependsOn ?? []).includes(cur)) {
        out.add(cid);
        queue.push(cid);
      }
    }
  }
  return [...out];
}

/** Every child that `id` depends on, directly or transitively, nearest first. */
export function dependenciesOf(state: ProjectState, id: string): string[] {
  const out: string[] = [];
  const queue = [...(state.children[id]?.dependsOn ?? [])];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === id || out.includes(cur)) continue;
    out.push(cur);
    queue.push(...(state.children[cur]?.dependsOn ?? []));
  }
  return out;
}

export function newState(name: string, sessionId?: string, host?: Host): ProjectState {
  const now = new Date().toISOString();
  return {
    v: STATE_SCHEMA_VERSION,
    name,
    status: "specifying",
    createdAt: now,
    updatedAt: now,
    ...(sessionId ? { sessionId } : {}),
    ...(host ? { host } : {}),
    children: {},
    questions: [],
  };
}

export function readState(p: ProjectPaths): ProjectState {
  if (!fs.existsSync(p.state)) throw new UserError(`Project "${p.name}" not found (${p.state}).`);
  return readJson<ProjectState>(p.state);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** RFC 7396 JSON merge patch: objects merge, `null` deletes, everything else replaces. */
export function mergePatch<T>(target: T, patch: unknown): T {
  if (!isPlainObject(patch)) return patch as T;
  const base: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete base[k];
    else base[k] = mergePatch(base[k], v);
  }
  return base as T;
}

const PLANNING: readonly ChildPhase[] = ["pending", "planning", "plan-review"];

/**
 * Greenfield run order, as `dependsOn` edges added to children with a `kind` (never removed):
 * every child of a repo depends on that repo's setup child, services, frontends and the system
 * child depend on every contracts child, and the system child depends on everything else.
 */
export function addGreenfieldDependencies(state: ProjectState): void {
  const kinded = Object.entries(state.children).filter(([, c]) => c.kind && !c.integration);
  const ids = (pred: (c: ChildState) => boolean) => kinded.filter(([, c]) => pred(c)).map(([id]) => id);
  const contracts = ids((c) => c.kind === "contracts");
  const built = ids((c) => c.kind !== "system");
  for (const [id, child] of kinded) {
    const needs: string[] = [];
    if (child.kind !== "setup") needs.push(...ids((c) => c.kind === "setup" && c.repo === child.repo));
    if (child.kind === "service" || child.kind === "frontend" || child.kind === "system") needs.push(...contracts);
    if (child.kind === "system") needs.push(...built);
    const deps = new Set(child.dependsOn ?? []);
    for (const dep of needs) if (dep !== id) deps.add(dep);
    child.dependsOn = [...deps];
  }
}

function normalizeChildren(prev: ProjectState, state: ProjectState): void {
  for (const [id, child] of Object.entries(state.children)) {
    child.repo ??= parseChildId(id)?.repo ?? id.split(":")[0] ?? id;
  }
  syncIntegrationChildren(state);
  if (state.greenfield) addGreenfieldDependencies(state);
  for (const [id, child] of Object.entries(state.children)) {
    child.phase ??= "pending";
    child.retries ??= 0;
    child.dependsOn ??= [];
    child.agentIds ??= {};
    child.portBase ??= nextPortBase(state);
    // A re-plan (for example after a contract change) needs a fresh consistency check.
    const before = prev.children[id]?.phase;
    if (before !== child.phase && PLANNING.includes(child.phase)) {
      delete child.consistent;
      delete child.repoConsistent;
    }
    if (before !== child.phase && child.phase === "done") child.doneAt = new Date().toISOString();
    if (child.phase !== "blocked") delete child.blockedReason;
  }
}

function validateTransitions(prev: ProjectState, next: ProjectState): void {
  if (prev.status !== next.status && !(PROJECT_STATUSES as readonly string[]).includes(next.status)) {
    throw new UserError(`Unknown project status "${next.status}". Use one of: ${PROJECT_STATUSES.join(", ")}.`);
  }
  for (const [id, child] of Object.entries(next.children)) {
    if (prev.children[id]?.phase !== child.phase && !(CHILD_PHASES as readonly string[]).includes(child.phase)) {
      throw new UserError(`Unknown phase "${child.phase}" for child ${id}. Use one of: ${CHILD_PHASES.join(", ")}.`);
    }
    if (child.kind !== undefined && !(CHILD_KINDS as readonly string[]).includes(child.kind)) {
      throw new UserError(`Unknown kind "${child.kind}" for child ${id}. Use one of: ${CHILD_KINDS.join(", ")}.`);
    }
  }
}

/**
 * Read-modify-write state.json under the project's state lock. Emits
 * `phase.changed` events for project status and child phase transitions.
 */
export function updateState(
  p: ProjectPaths,
  mutate: (s: ProjectState) => ProjectState | void,
  actor = "coordinator",
): ProjectState {
  const changes: { target: string | null; from: string | undefined; to: string }[] = [];
  const next = withLock(p.stateLock, () => {
    const prev = readState(p);
    const draft = structuredClone(prev);
    const result = mutate(draft) ?? draft;
    normalizeChildren(prev, result);
    validateTransitions(prev, result);
    result.updatedAt = new Date().toISOString();
    if (prev.status !== result.status) changes.push({ target: null, from: prev.status, to: result.status });
    for (const [id, child] of Object.entries(result.children)) {
      const before = prev.children[id]?.phase;
      if (before !== child.phase) changes.push({ target: id, from: before, to: child.phase });
    }
    writeJson(p.state, result);
    return result;
  });
  for (const c of changes) {
    appendEvent(p, {
      actor,
      type: "phase.changed",
      target: c.target,
      payload: { scope: c.target ? "child" : "project", from: c.from ?? null, to: c.to },
    });
  }
  return next;
}

/** Refuse to approve a greenfield spec that exceeds the workspace caps or has no Follow-ups. */
export function greenfieldProblems(p: ProjectPaths, state: ProjectState): string[] {
  // projects/<name> sits directly in the workspace root.
  const ws = workspaceAt(path.dirname(path.dirname(p.dir)));
  const spec = fs.existsSync(p.spec) ? fs.readFileSync(p.spec, "utf8") : undefined;
  return greenfieldViolations(state, spec, greenfieldLimits(readConfig(ws)));
}

function checkGreenfieldScope(p: ProjectPaths, state: ProjectState): void {
  const problems = greenfieldProblems(p, state);
  if (!problems.length) return;
  throw new UserError(
    `The greenfield spec for project ${p.name} cannot be approved yet:\n` +
      problems.map((m) => `- ${m}`).join("\n") +
      "\n\nCut scope in spec.md (move what you cut to ## Follow-ups) and state.json, then approve again.",
  );
}

export function patchState(p: ProjectPaths, patch: unknown, actor?: string): ProjectState {
  if (!isPlainObject(patch)) throw new UserError("State patch must be a JSON object.");
  if ("maxParallel" in patch) {
    throw new UserError(
      "maxParallel is a workspace setting, not project state. Use: npx openfleet config set maxParallel <n>",
    );
  }
  if (patch.specApproved === true) {
    const current = readState(p);
    const pf = current.preflight;
    if (pf && !pf.ok) {
      throw new UserError(
        `Preflight failed for project ${p.name}, so the spec cannot be approved yet. ` +
          `Fix the cause, then run: npx openfleet preflight ${p.name}`,
      );
    }
    const next = mergePatch(current, patch);
    if (next.greenfield || next.continuedFrom) checkGreenfieldScope(p, next);
  }
  return updateState(p, (s) => mergePatch(s, patch), actor);
}
