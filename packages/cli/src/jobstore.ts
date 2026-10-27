// Role session job records: `projects/<project>/jobs/<job>/job.json` (see jobs.ts).
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./fsutil.js";
import type { Host } from "./hosts.js";
import { withLock } from "./lock.js";
import type { WorkRole } from "./state.js";
import { UserError, type ProjectPaths } from "./workspace.js";

export const JOB_ROLES: readonly WorkRole[] = ["planner", "baseline", "implementer", "tester"];
export type JobRole = WorkRole | "extension";
export type JobState = "running" | "finished" | "failed" | "lost" | "stopped";

export interface Report {
  status?: string;
  child?: string;
  summary?: string;
  question?: string;
  [k: string]: unknown;
}

export interface Turn {
  n: number;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  /** The parsed `openfleet-report` block of the turn's final text, if any. */
  report?: Report;
  /** Final assistant text of the turn (trimmed to 20 000 chars). */
  text?: string;
  error?: string;
}

export interface Job {
  id: string;
  project: string;
  /** Child the job works on; null for a project-level extension slot (`plans-ready`, `post-run`). */
  child: string | null;
  role: JobRole;
  /** Full agent name, e.g. `openfleet:openfleet-implementer`. */
  agent: string;
  /** Extension and slot, for extension jobs. */
  extension?: string;
  slot?: string;
  host: Host;
  model?: string;
  endpoint?: string;
  /** Coordinator that acts on the job's turns: `top`, or the repo key of a repo coordinator. */
  owner?: string;
  sessionId: string;
  state: JobState;
  createdAt: string;
  endedAt?: string;
  /** Pid of the job runner and of the host process of the current turn. */
  runnerPid?: number;
  hostPid?: number;
  /** When the current runner was asked to start (a runner without a pid yet is not lost). */
  runnerAt?: string;
  turns: Turn[];
  /** Messages waiting for the next turn (`agent reply` while a turn runs). */
  queue: string[];
  /** A turn ended that the coordinator has not read yet (`agent wait` / `agent result`). */
  unread: boolean;
  /** Automatic follow-ups already sent: a missing report block, a crashed turn. */
  nudged?: boolean;
  retried?: boolean;
}

export function jobsDir(p: ProjectPaths): string {
  return p.jobs;
}

export function jobFile(p: ProjectPaths, id: string): string {
  return path.join(jobsDir(p), id, "job.json");
}

export const JOB_ID = /^j-\d{4}-[a-z0-9-]+$/;

export function readJob(p: ProjectPaths, id: string): Job {
  if (!JOB_ID.test(id) || !fs.existsSync(jobFile(p, id)))
    throw new UserError(`Unknown job "${id}" in project ${p.name}.`);
  return readJson<Job>(jobFile(p, id));
}

export function listJobs(p: ProjectPaths): Job[] {
  const dir = jobsDir(p);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => JOB_ID.test(n) && fs.existsSync(jobFile(p, n)))
    .sort()
    .map((n) => readJob(p, n));
}

/** Read-modify-write one job under its lock. */
export function updateJob(p: ProjectPaths, id: string, change: (j: Job) => void): Job {
  return withLock(`${jobFile(p, id)}.lock`, () => {
    const job = readJob(p, id);
    change(job);
    writeJson(jobFile(p, id), job);
    return job;
  });
}

/** Every job's host session, for token usage. Extension jobs count as `extensions`. */
export function jobSessions(p: ProjectPaths): { host: Host; sessionId: string; role: string }[] {
  return listJobs(p).map((j) => ({
    host: j.host,
    sessionId: j.sessionId,
    role: j.role === "extension" ? "extensions" : j.role,
  }));
}
