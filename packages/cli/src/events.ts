import fs from "node:fs";
import path from "node:path";
import { copiedSecrets } from "./copyfiles.js";
import { withLock } from "./lock.js";
import { redact, redactString } from "./redact.js";
import type { ProjectPaths } from "./workspace.js";

export const EVENT_SCHEMA_VERSION = 1;

export const EVENT_TYPES = [
  "project.created",
  "session.started",
  "session.ended",
  "session.replaced",
  "agent.spawned",
  "agent.stopped",
  "message.sent",
  "file.added",
  "file.edited",
  "file.deleted",
  "worktree.snapshot",
  "worktree.created",
  "worktree.removed",
  "phase.changed",
  "question.asked",
  "question.answered",
  "contract.changed",
  "plan.submitted",
  "plan.validated",
  "plan.rejected",
  "test.run",
  "spec.written",
  "spec.approved",
  "assumption",
  "child.failed",
  "run.completed",
  "extension.ran",
  "extension.skipped",
  "extension.outputs",
  "extension.failed",
  "plans.consistent",
  "baseline.passed",
  "question.escalated",
  "child.merged",
  "merge.conflict",
  "worktree.synced",
  "preflight.passed",
  "preflight.failed",
  "repo.created",
  "project.continued",
  "stack.created",
] as const;

export type KnownEventType = (typeof EVENT_TYPES)[number];

/**
 * `plan.rejected` reasons: `invalid` (fails the spec), `inconsistent` (differs from the Shared approach
 * or another plan) and `out-of-scope` (implements a greenfield `## Follow-ups` item).
 */
export const PLAN_REJECTION_REASONS = ["invalid", "inconsistent", "out-of-scope"] as const;

/**
 * Actor: `coordinator`, `<child>/<role>` (child may be `<repo>:<package>` or
 * `<repo>[:<package>]/<unit>`; role may be `repo-coordinator`),
 * `ext:<name>`, `cli` or `user`.
 */
export interface EventInput {
  actor: string;
  type: KnownEventType | (string & {});
  target?: string | null;
  payload?: Record<string, unknown>;
  /** Full patch text, stored as patches/<seq>.patch (redacted). */
  patch?: string;
  ts?: string;
}

export interface OpenFleetEvent {
  v: typeof EVENT_SCHEMA_VERSION;
  ts: string;
  seq: number;
  actor: string;
  type: string;
  target: string | null;
  payload: Record<string, unknown>;
}

function lastSeqFromLog(eventsFile: string): number {
  let content: string;
  try {
    content = fs.readFileSync(eventsFile, "utf8");
  } catch {
    return 0;
  }
  const lines = content.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const seq = (JSON.parse(line) as { seq?: unknown }).seq;
      if (typeof seq === "number") return seq;
    } catch {
      // ignore torn/invalid line
    }
  }
  return 0;
}

function readSeq(p: ProjectPaths): number {
  try {
    const n = Number(fs.readFileSync(p.seq, "utf8").trim());
    if (Number.isInteger(n) && n >= 0) return n;
  } catch {
    // fall through
  }
  return lastSeqFromLog(p.events);
}

/** Append one event under the project's events lock. Returns the written event. */
export function appendEvent(p: ProjectPaths, input: EventInput): OpenFleetEvent {
  fs.mkdirSync(p.dir, { recursive: true });
  return withLock(p.eventsLock, () => {
    const seq = readSeq(p) + 1;
    const secrets = copiedSecrets(p);
    const payload: Record<string, unknown> = redact({ ...(input.payload ?? {}) }, secrets);
    if (input.patch !== undefined && input.patch.length > 0) {
      fs.mkdirSync(p.patches, { recursive: true });
      const rel = path.posix.join("patches", `${seq}.patch`);
      fs.writeFileSync(path.join(p.dir, rel), redactString(input.patch, secrets));
      payload.patch = rel;
    }
    const event: OpenFleetEvent = {
      v: EVENT_SCHEMA_VERSION,
      ts: input.ts ?? new Date().toISOString(),
      seq,
      actor: input.actor,
      type: input.type,
      target: input.target ?? null,
      payload,
    };
    fs.appendFileSync(p.events, JSON.stringify(event) + "\n");
    fs.writeFileSync(p.seq, String(seq));
    return event;
  });
}

export function readEvents(p: ProjectPaths): OpenFleetEvent[] {
  let content: string;
  try {
    content = fs.readFileSync(p.events, "utf8");
  } catch {
    return [];
  }
  const out: OpenFleetEvent[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as OpenFleetEvent);
    } catch {
      // skip invalid line
    }
  }
  return out;
}
