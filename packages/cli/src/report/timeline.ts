// Time handling for `openfleet report`: pauses, a time axis that leaves them out, per-child phase
// segments and the number of agents running at once.
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

/**
 * The parts of `gaps` not covered by `busy` spans (agents known to be running), keeping only parts
 * longer than `minGapMs`. A quiet stretch while an agent works is not a pause.
 */
export function withoutBusy(gaps: Gap[], busy: Gap[], minGapMs: number): Gap[] {
  const out: Gap[] = [];
  for (const g of gaps) {
    let parts = [{ ...g }];
    for (const b of busy) {
      parts = parts.flatMap((p) =>
        b.end <= p.start || b.start >= p.end
          ? [p]
          : [
              { start: p.start, end: b.start },
              { start: b.end, end: p.end },
            ].filter((q) => q.end > q.start),
      );
    }
    out.push(...parts.filter((p) => p.end - p.start > minGapMs));
  }
  return out;
}

/**
 * Pauses from `npx openfleet pause` (and budget halts): from the last event after the halt, once
 * running agents have finished, until `run.resumed`. A halt that was never resumed adds nothing.
 */
export function haltGaps(events: OpenFleetEvent[]): Gap[] {
  const gaps: Gap[] = [];
  let haltedAt: number | undefined;
  let last = 0;
  for (const e of [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t)) continue;
    if (e.type === "run.halted" && (e.payload.reason === "paused" || e.payload.reason === "budget")) {
      haltedAt ??= t;
    } else if (e.type === "run.resumed" && haltedAt !== undefined) {
      if (t > last) gaps.push({ start: last, end: t });
      haltedAt = undefined;
    }
    last = t;
  }
  return gaps;
}

/** Sorted, non-overlapping gaps. */
export function mergeGaps(gaps: Gap[]): Gap[] {
  const out: Gap[] = [];
  for (const g of [...gaps].sort((a, b) => a.start - b.start)) {
    const prev = out[out.length - 1];
    if (prev && g.start <= prev.end) prev.end = Math.max(prev.end, g.end);
    else out.push({ ...g });
  }
  return out;
}

/** Time from `a` to `b` without the pauses in between. */
export function activeBetween(a: number, b: number, gaps: Gap[]): number {
  const paused = gaps.reduce((sum, g) => sum + Math.max(0, Math.min(b, g.end) - Math.max(a, g.start)), 0);
  return Math.max(0, b - a - paused);
}

export function activeMs(t0: number, t1: number, gaps: Gap[]): number {
  return activeBetween(t0, t1, gaps);
}

export interface Axis {
  t0: number;
  t1: number;
  gaps: Gap[];
  /** Map a time to [0, 1]. Active time is linear; pauses take no space. */
  frac(t: number): number;
}

export function makeAxis(t0: number, t1: number, gaps: Gap[]): Axis {
  const total = Math.max(1, activeMs(t0, t1, gaps));
  return {
    t0,
    t1,
    gaps,
    frac: (t) => Math.min(1, Math.max(0, activeBetween(t0, Math.min(t1, Math.max(t0, t)), gaps) / total)),
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
  /** A role session started by `agent start` (not a subagent). */
  job?: boolean;
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
  /** The last run of each role session job, so a reply after it stopped starts a new segment. */
  const jobs = new Map<string, AgentRun>();
  for (const e of events) {
    const t = Date.parse(e.ts);
    const id = typeof e.payload.agentId === "string" ? e.payload.agentId : null;
    const jobId = typeof e.payload.jobId === "string" ? e.payload.jobId : null;
    if (e.type === "agent.spawned") {
      const run: AgentRun = { agentId: id, role: roleOf(e.payload.agentName, e.actor), child: e.target, start: t, end };
      if (jobId) run.job = true;
      runs.push(run);
      if (id) open.set(id, run);
      if (jobId) jobs.set(jobId, run);
    } else if (e.type === "message.sent" && jobId && !open.has(jobId)) {
      // `agent reply` to a finished job: its session runs again from here.
      const last = jobs.get(jobId);
      if (!last) continue;
      const run: AgentRun = { ...last, start: t, end, job: true };
      delete run.inferred;
      runs.push(run);
      open.set(jobId, run);
      jobs.set(jobId, run);
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
    // Role sessions outlive the coordinator's session; only subagents end with it.
    const nextSession = run.job ? Infinity : (sessions.find((s) => s > run.start) ?? Infinity);
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
