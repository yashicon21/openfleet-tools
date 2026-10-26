// The data behind `openfleet report`, derived from events.jsonl, state.json, spec.md, summary.md,
// git (when a child has no snapshot) and host transcripts.
import fs from "node:fs";
import { readConfig } from "../config.js";
import { readEvents, type OpenFleetEvent } from "../events.js";
import { tryGit } from "../git.js";
import { isDir } from "../fsutil.js";
import { DEFAULT_HOST, type Host } from "../hosts.js";
import { readState, type ChildState, type ProjectState } from "../state.js";
import { projectPaths, type Workspace } from "../workspace.js";
import { specAsk, summarySections, type SummaryKey } from "./markdown.js";
import {
  activeMs,
  agentRuns,
  childSegments,
  concurrency,
  findGaps,
  projectSegments,
  type AgentRun,
  type Gap,
  type Segment,
  type Step,
} from "./timeline.js";
import { readTokenUsage, type TokenReport } from "./tokens.js";

export const DEFAULT_GAP_MINUTES = 15;

export interface TestRun {
  ts: number;
  command: string;
  exitCode: number | null;
  passed: boolean;
  summary: string;
  actor: string;
}

export interface ChildReport {
  id: string;
  repo: string;
  /** Short label: the unit or package inside the repo, or the repo for single-child repos. */
  label: string;
  kind: "integration" | "setup" | "member" | "single";
  phase: string;
  retries: number;
  merged: boolean;
  mergedAt?: number;
  branch?: string;
  dependsOn: string[];
  diff?: { files: number; added: number; removed: number; source: "snapshot" | "git" };
  tests: TestRun[];
  segments: Segment[];
  planSubmitted?: number;
  planValidated?: number;
  planRejections: { ts: number; reason: string; details: string[] }[];
  spawns: number;
}

export interface Assumption {
  child: string;
  actor: string;
  question: string;
  decision: string;
  rationale: string;
}

export interface ReportModel {
  project: string;
  status: string;
  host: Host;
  completionMode?: string;
  /** `greenfield`, or `continues <project>` for a later slice. */
  origin?: string;
  version?: string;
  generatedAt: number;
  t0: number;
  t1: number;
  wallMs: number;
  activeMs: number;
  gapMinutes: number;
  gaps: Gap[];
  title?: string;
  goal?: string;
  projectSegments: Segment[];
  repos: { repo: string; children: ChildReport[] }[];
  children: ChildReport[];
  agents: AgentRun[];
  spawnsByRole: [string, number][];
  concurrency: Step[];
  peakAgents: number;
  plans: { submitted: number; validated: number; rejected: number; consistentAt: number[]; gateAt?: number };
  tests: { runs: number; passed: number; failed: number };
  diff: { files: number; added: number; removed: number };
  retries: number;
  assumptions: Assumption[];
  questions: { asked: number; escalated: number };
  summary: Partial<Record<SummaryKey, string>>;
  tokens?: TokenReport;
  eventCount: number;
  inProgress: boolean;
}

export interface ReportOptions {
  gapMinutes?: number;
  /** Environment for locating host transcripts (HOME, CLAUDE_CONFIG_DIR, COPILOT_HOME). */
  env?: NodeJS.ProcessEnv;
  now?: number;
  version?: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function kindOf(id: string, c: ChildState): ChildReport["kind"] {
  if (c.integration) return "integration";
  if (c.setup || id.endsWith("/setup")) return "setup";
  return id.includes("/") || id.includes(":") ? "member" : "single";
}

function labelOf(id: string, c: ChildState, kind: ChildReport["kind"]): string {
  if (kind === "integration") return `${c.repo} (integration)`;
  const unit = id.slice(c.repo.length).replace(/^[:/]/, "");
  return unit || id;
}

/** `git diff --shortstat <base>` in the child's worktree, for children without a snapshot. */
function gitDiff(c: ChildState): ChildReport["diff"] {
  if (!c.worktree || !c.baseSha || !isDir(c.worktree)) return undefined;
  const out = tryGit(c.worktree, ["diff", "--shortstat", c.baseSha]);
  if (out === undefined) return undefined;
  const n = (re: RegExp) => Number(re.exec(out)?.[1] ?? 0);
  return {
    files: n(/(\d+) files? changed/),
    added: n(/(\d+) insertions?/),
    removed: n(/(\d+) deletions?/),
    source: "git",
  };
}

function sessionIds(events: OpenFleetEvent[], state: ProjectState): string[] {
  const ids: string[] = [];
  for (const e of events) {
    for (const key of ["sessionId", "previous"]) {
      const v = e.payload[key];
      if (typeof v === "string" && v) ids.push(v);
    }
  }
  if (state.sessionId) ids.push(state.sessionId);
  return [...new Set(ids)];
}

export function buildModel(ws: Workspace, name: string, opts: ReportOptions = {}): ReportModel {
  const p = projectPaths(ws, name);
  const state = readState(p);
  const events = readEvents(p).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.seq - b.seq);
  const pricing = readConfig(ws).pricing;
  const tokens = readTokenUsage({
    host: state.host ?? DEFAULT_HOST,
    cwd: ws.root,
    sessionIds: sessionIds(events, state),
    pricing,
    env: opts.env,
  });
  return deriveModel({
    name,
    state,
    events,
    spec: readText(p.spec),
    summary: readText(`${p.dir}/summary.md`),
    tokens,
    opts,
  });
}

export interface ModelInput {
  name: string;
  state: ProjectState;
  events: OpenFleetEvent[];
  spec: string;
  summary: string;
  tokens?: TokenReport;
  opts?: ReportOptions;
}

/** Pure part of `buildModel` (git is only used for children without a snapshot). */
export function deriveModel(input: ModelInput): ReportModel {
  const { name, state, events, opts = {} } = input;
  const gapMinutes = opts.gapMinutes ?? DEFAULT_GAP_MINUTES;
  const times = events.map((e) => Date.parse(e.ts)).filter((t) => Number.isFinite(t));
  const t0 = times.length ? Math.min(...times) : Date.parse(state.createdAt);
  const t1 = times.length ? Math.max(...times) : t0;
  const gaps = findGaps(times, gapMinutes * 60_000);
  const inProgress = state.status !== "done" && state.status !== "cancelled";

  const segs = childSegments(events, t1);
  const agents = agentRuns(events, t1);
  const steps = concurrency(agents);

  const children = new Map<string, ChildReport>();
  for (const [id, c] of Object.entries(state.children)) {
    const kind = kindOf(id, c);
    children.set(id, {
      id,
      repo: c.repo,
      label: labelOf(id, c, kind),
      kind,
      phase: c.phase,
      retries: c.retries ?? 0,
      merged: c.merged === true,
      mergedAt: c.mergedAt ? Date.parse(c.mergedAt) : undefined,
      branch: c.branch,
      dependsOn: c.dependsOn ?? [],
      tests: [],
      segments: segs.get(id) ?? [],
      planRejections: [],
      spawns: 0,
    });
  }

  const snapshots = new Map<string, { files: number; added: number; removed: number }>();
  const assumptions: Assumption[] = [];
  const consistentAt: number[] = [];
  let submitted = 0;
  let validated = 0;
  let rejected = 0;
  let asked = 0;
  let escalated = 0;
  for (const e of events) {
    const t = Date.parse(e.ts);
    const child = e.target ? children.get(e.target) : undefined;
    switch (e.type) {
      case "test.run":
        child?.tests.push({
          ts: t,
          command: str(e.payload.command),
          exitCode: typeof e.payload.exitCode === "number" ? e.payload.exitCode : null,
          passed: e.payload.passed === true,
          summary: str(e.payload.summary),
          actor: e.actor,
        });
        break;
      case "worktree.snapshot": {
        const tot = e.payload.totals as { files?: number; added?: number; removed?: number } | undefined;
        if (e.target && tot) {
          snapshots.set(e.target, { files: tot.files ?? 0, added: tot.added ?? 0, removed: tot.removed ?? 0 });
        }
        break;
      }
      case "plan.submitted":
        submitted++;
        if (child) child.planSubmitted ??= t;
        break;
      case "plan.validated":
        validated++;
        if (child) child.planValidated = t;
        break;
      case "plan.rejected":
        rejected++;
        child?.planRejections.push({
          ts: t,
          reason: str(e.payload.reason),
          details: Array.isArray(e.payload.reasons) ? e.payload.reasons.map(str) : [],
        });
        break;
      case "plans.consistent":
        consistentAt.push(t);
        break;
      case "child.merged":
        if (child) {
          child.merged = true;
          child.mergedAt = t;
        }
        break;
      case "agent.spawned":
        if (child) child.spawns++;
        break;
      case "assumption":
        assumptions.push({
          child: e.target ?? str(e.payload.child),
          actor: e.actor,
          question: str(e.payload.question),
          decision: str(e.payload.decision),
          rationale: str(e.payload.rationale),
        });
        break;
      case "question.asked":
        asked++;
        break;
      case "question.escalated":
        escalated++;
        break;
    }
  }
  for (const c of children.values()) {
    const snap = snapshots.get(c.id);
    c.diff = snap ? { ...snap, source: "snapshot" } : gitDiff(state.children[c.id]!);
  }

  // Order: per repo, setup first, then members by first activity, the integration child last.
  const first = (c: ChildReport) => c.segments.find((s) => s.phase !== "pending")?.start ?? Infinity;
  const rank = { setup: 0, single: 1, member: 1, integration: 2 } as const;
  const repoNames = [...new Set([...children.values()].map((c) => c.repo))];
  const repos = repoNames.map((repo) => ({
    repo,
    children: [...children.values()]
      .filter((c) => c.repo === repo)
      .sort((a, b) => rank[a.kind] - rank[b.kind] || first(a) - first(b) || a.id.localeCompare(b.id)),
  }));

  const spawns = new Map<string, number>();
  for (const a of agents) spawns.set(a.role, (spawns.get(a.role) ?? 0) + 1);
  const allTests = [...children.values()].flatMap((c) => c.tests);
  const gateAt = [...children.values()]
    .flatMap((c) => c.segments.filter((s) => s.phase === "implementing" || s.phase === "baseline"))
    .reduce<number | undefined>((m, s) => (m === undefined || s.start < m ? s.start : m), undefined);

  const ask = specAsk(input.spec);
  return {
    project: name,
    status: state.status,
    host: state.host ?? DEFAULT_HOST,
    completionMode: state.completionMode,
    ...(state.continuedFrom
      ? { origin: `continues ${state.continuedFrom}` }
      : state.greenfield
        ? { origin: "greenfield" }
        : {}),
    version: opts.version,
    generatedAt: opts.now ?? Date.now(),
    t0,
    t1,
    wallMs: t1 - t0,
    activeMs: activeMs(t0, t1, gaps),
    gapMinutes,
    gaps,
    title: ask.title,
    goal: ask.goal,
    projectSegments: projectSegments(events, t1),
    repos,
    children: repos.flatMap((r) => r.children),
    agents,
    spawnsByRole: [...spawns.entries()].sort((a, b) => b[1] - a[1]),
    concurrency: steps,
    peakAgents: steps.reduce((m, s) => Math.max(m, s.n), 0),
    plans: { submitted, validated, rejected, consistentAt, gateAt },
    tests: {
      runs: allTests.length,
      passed: allTests.filter((t) => t.passed).length,
      failed: allTests.filter((t) => !t.passed).length,
    },
    // Per repo: the integration branch's diff when there is one, else the sum of its children.
    diff: repos
      .flatMap((r) => {
        const integ = r.children.find((c) => c.kind === "integration" && c.diff);
        return integ ? [integ] : r.children.filter((c) => c.kind !== "integration");
      })
      .reduce(
        (s, c) => ({
          files: s.files + (c.diff?.files ?? 0),
          added: s.added + (c.diff?.added ?? 0),
          removed: s.removed + (c.diff?.removed ?? 0),
        }),
        { files: 0, added: 0, removed: 0 },
      ),
    retries: [...children.values()].reduce((s, c) => s + c.retries, 0),
    assumptions,
    questions: { asked, escalated },
    summary: summarySections(input.summary),
    tokens: input.tokens,
    eventCount: events.length,
    inProgress,
  };
}
