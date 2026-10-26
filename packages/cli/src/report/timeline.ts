// Time handling for `openfleet report`: pauses between events, a time axis that collapses them,
// per-child phase segments and the number of agents running at once.
import type { OpenFleetEvent } from "../events.js";

export interface Gap {
  start: number;
  end: number;
}

/** Spans longer than `minGapMs` between consecutive event times (ms, any order). */
export function findGaps(times: number[], minGapMs: number): Gap[] {
  const sorted = [...times].sort((a, b) => a - b);
  const gaps: Gap[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (b - a > minGapMs) gaps.push({ start: a, end: b });
  }
  return gaps;
}

export function activeMs(t0: number, t1: number, gaps: Gap[]): number {
  return t1 - t0 - gaps.reduce((sum, g) => sum + (g.end - g.start), 0);
}

export interface Axis {
  t0: number;
  t1: number;
  gaps: Gap[];
  /** Map a time to [0, 1]. Active time is linear; each gap takes a fixed small band. */
  frac(t: number): number;
}

/** Width of one collapsed pause, as a share of the active time. */
export const GAP_BAND_SHARE = 0.04;

export function makeAxis(t0: number, t1: number, gaps: Gap[]): Axis {
  const active = Math.max(1, activeMs(t0, t1, gaps));
  const band = Math.max(1, active * GAP_BAND_SHARE);
  const total = active + band * gaps.length;
  const display = (t: number): number => {
    let removed = 0;
    for (const g of gaps) {
      const len = g.end - g.start;
      if (t >= g.end) removed += len - band;
      else if (t > g.start) return g.start - t0 - removed + ((t - g.start) / len) * band;
    }
    return t - t0 - removed;
  };
  return {
    t0,
    t1,
    gaps,
    frac: (t) => Math.min(1, Math.max(0, display(Math.min(t1, Math.max(t0, t))) / total)),
  };
}

export interface Segment {
  phase: string;
  start: number;
  end: number;
  /** Still in this phase at the end of the data (in-progress run). */
  open?: boolean;
}

const FINAL = new Set(["done", "failed", "cancelled"]);

function segmentsOf(changes: { t: number; to: string }[], end: number): Segment[] {
  changes.sort((a, b) => a.t - b.t);
  const segs: Segment[] = [];
  changes.forEach((c, i) => {
    const next = changes[i + 1];
    if (next) {
      if (next.t > c.t) segs.push({ phase: c.to, start: c.t, end: next.t });
    } else if (!FINAL.has(c.to)) segs.push({ phase: c.to, start: c.t, end: Math.max(c.t, end), open: true });
  });
  return segs;
}

/**
 * Phase segments per child from child-scoped `phase.changed` events. The last phase runs to `end`
 * (marked `open`), unless it is final (`done`/`failed`), which ends the bar.
 */
export function childSegments(events: OpenFleetEvent[], end: number): Map<string, Segment[]> {
  const changes = new Map<string, { t: number; to: string }[]>();
  for (const e of events) {
    if (e.type !== "phase.changed" || e.payload.scope !== "child" || !e.target) continue;
    const to = e.payload.to;
    if (typeof to !== "string") continue;
    const list = changes.get(e.target) ?? [];
    list.push({ t: Date.parse(e.ts), to });
    changes.set(e.target, list);
  }
  const out = new Map<string, Segment[]>();
  for (const [id, list] of changes) out.set(id, segmentsOf(list, end));
  return out;
}

/** Project status bands from `project.created` and project-scoped `phase.changed` events. */
export function projectSegments(events: OpenFleetEvent[], end: number): Segment[] {
  const changes: { t: number; to: string }[] = [];
  for (const e of events) {
    if (e.type === "project.created") changes.push({ t: Date.parse(e.ts), to: "specifying" });
    else if (e.type === "phase.changed" && e.payload.scope === "project" && typeof e.payload.to === "string") {
      changes.push({ t: Date.parse(e.ts), to: e.payload.to });
    }
  }
  return segmentsOf(changes, end);
}

/** Role of an agent: `openfleet:openfleet-planner` → `planner`; otherwise the actor's last part. */
export function roleOf(agentName: unknown, actor = ""): string {
  if (typeof agentName === "string") {
    const m = /(?:^|[:/])openfleet-([a-z-]+)$/.exec(agentName);
    if (m) return m[1]!;
  }
  if (actor.startsWith("ext:")) return "extension";
  const parts = actor.split("/");
  return parts.length > 1 ? parts[parts.length - 1]! : "other";
}

export interface AgentRun {
  agentId: string | null;
  role: string;
  child: string | null;
  start: number;
  end: number;
  /** No matching `agent.stopped` was logged, so `end` is inferred. */
  inferred?: boolean;
}

/**
 * Agent lifetimes from `agent.spawned`/`agent.stopped` (matched by agentId). A spawn without a stop
 * ends at the next session start (subagents do not survive a session), the next spawn for the same
 * child and role, or `end`, whichever comes first.
 */
export function agentRuns(events: OpenFleetEvent[], end: number): AgentRun[] {
  const sessions = events.filter((e) => e.type === "session.started").map((e) => Date.parse(e.ts));
  const runs: AgentRun[] = [];
  const open = new Map<string, AgentRun>();
  const stopped = new Set<AgentRun>();
  for (const e of events) {
    const t = Date.parse(e.ts);
    const id = typeof e.payload.agentId === "string" ? e.payload.agentId : null;
    if (e.type === "agent.spawned") {
      const run: AgentRun = { agentId: id, role: roleOf(e.payload.agentName, e.actor), child: e.target, start: t, end };
      runs.push(run);
      if (id) open.set(id, run);
    } else if (e.type === "agent.stopped" && id) {
      const run = open.get(id);
      if (run) {
        run.end = Math.max(run.start, t);
        stopped.add(run);
        open.delete(id);
      }
    }
  }
  for (const run of runs) {
    if (stopped.has(run)) continue;
    const nextSession = sessions.find((s) => s > run.start) ?? Infinity;
    const nextSame =
      runs.find((r) => r.start > run.start && r.child === run.child && r.role === run.role)?.start ?? Infinity;
    run.end = Math.max(run.start, Math.min(end, nextSession, nextSame));
    run.inferred = true;
  }
  return runs;
}

export interface Step {
  t: number;
  n: number;
}

/** Number of agents running from each change point on. */
export function concurrency(runs: AgentRun[]): Step[] {
  const deltas: [number, number][] = [];
  for (const r of runs) deltas.push([r.start, 1], [r.end, -1]);
  deltas.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const steps: Step[] = [];
  let n = 0;
  for (const [t, d] of deltas) {
    n += d;
    const last = steps[steps.length - 1];
    if (last && last.t === t) last.n = n;
    else steps.push({ t, n });
  }
  return steps;
}
