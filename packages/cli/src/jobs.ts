// Role sessions (`agentMode: "session"`): `npx openfleet agent start` claims a child for a role and
// starts a detached job runner, which runs the role as its own headless host session
// (`claude -p` / `copilot -p`) with that role's host, model and endpoint. The coordinator collects
// turns with `agent wait` and continues a session with `agent reply`. Job records live in
// `projects/<project>/jobs/<job>/job.json`; the runner outlives the coordinator's session.
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { actorFor, bareAgentName, qualifiedAgentName } from "./attribution.js";
import { claim, type ClaimResult } from "./claim.js";
import { agentModeOf, readConfig, roleTarget, splitsInSteps, type RoleTarget } from "./config.js";
import { findSlotEntry, readCoreIndex } from "./coreindex.js";
import { endpointEnv } from "./endpoints.js";
import { appendEvent } from "./events.js";
import { writeJson } from "./fsutil.js";
import { childContext, snapshotChild } from "./hooks/handlers.js";
import { DEFAULT_HOST, pluginDir, type Host } from "./hosts.js";
import { allowedDirs, hostBinary } from "./launcher.js";
import {
  JOB_ID,
  jobFile,
  JOB_ROLES,
  jobsDir,
  listJobs,
  updateJob,
  type Job,
  type JobRole,
  type JobState,
  type JobStep,
  type Report,
  type SessionRef,
} from "./jobstore.js";
import { groupOf } from "./groups.js";
import { parseSteps, PLANNER_STEPS_NOTE, stepPrompt, stepsHash, worktreeChanges, type PlanStep } from "./steps.js";
import { TOP } from "./schedule.js";
import { readState, updateState, type ChildState, type ProjectState, type WorkRole } from "./state.js";
import { projectPaths, UserError, type ProjectPaths, type Workspace } from "./workspace.js";

export * from "./jobstore.js";

/** The coordinator that owns a child's turns, as `next` assigns actions: a repo coordinator for its repo, else `top`. */
export function ownerOf(state: ProjectState, child: string | null): string {
  const c = child ? state.children[child] : undefined;
  if (!c) return TOP;
  return c.integration ? c.repo : (groupOf(state, child!) ?? TOP);
}

/** Final text without its report block, for saving a plan (`agent result --out`). */
export function withoutReport(text: string): string {
  return text.replace(/````?\n?```openfleet-report[\s\S]*$|```openfleet-report[\s\S]*$/, "").trimEnd() + "\n";
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "x"
  );
}

const SHORT: Record<JobRole, string> = {
  planner: "plan",
  baseline: "base",
  implementer: "impl",
  tester: "test",
  extension: "ext",
};

function newJobId(p: ProjectPaths, role: JobRole, child: string | null): string {
  fs.mkdirSync(jobsDir(p), { recursive: true });
  const n = fs.readdirSync(jobsDir(p)).filter((x) => JOB_ID.test(x)).length + 1;
  return `j-${String(n).padStart(4, "0")}-${SHORT[role]}-${slug(child ?? "project")}`;
}

/** The text between the last ```openfleet-report fence pair, parsed. */
export function parseReport(text: string | undefined): Report | undefined {
  if (!text) return undefined;
  const blocks = [...text.matchAll(/```openfleet-report[^\n]*\n([\s\S]*?)\n?```/g)];
  const last = blocks.at(-1)?.[1];
  if (!last) return undefined;
  try {
    const v = JSON.parse(last.trim()) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Report) : undefined;
  } catch {
    return undefined;
  }
}

export function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ---------------------------------------------------------------- start

const ROLE_LINE: Record<WorkRole, (child: string, project: string) => string> = {
  planner: (c, p) => `Plan child \`${c}\` of project \`${p}\`.`,
  baseline: (c, p) => `Write and pass baseline tests for child \`${c}\` of project \`${p}\`.`,
  implementer: (c, p) => `Implement the approved plan for child \`${c}\` of project \`${p}\`.`,
  tester: (c, p) => `Verify child \`${c}\` of project \`${p}\`.`,
};

const SESSION_NOTE = [
  "## Session",
  "",
  "You run as your own session, started by `npx openfleet agent start`; nobody watches it. Do not ask the user anything.",
  'End every turn with your `openfleet-report` block. For a question, report `status: "question"`: the coordinator answers in your next turn.',
].join("\n");

export interface StartOptions {
  ws: Workspace;
  project: string;
  child?: string;
  role?: string;
  /** Extension phase agent, e.g. `openfleet:openfleet-ext-audit-post-test` (instead of `role`). */
  agent?: string;
  /** Text added after the assignment: tester findings, guidance. */
  message?: string;
  env?: NodeJS.ProcessEnv;
  /** Do not start the runner (tests drive `runJob` themselves). */
  detach?: boolean;
}

export type StartResult =
  | ({ result: "started"; job: string; sessionId: string } & Pick<
      Job,
      "child" | "role" | "host" | "model" | "endpoint"
    >)
  | ClaimResult
  | { result: "stop"; child: string | null; role: "extension"; reason: string; detail: string | null };

function requireSessions(ws: Workspace): void {
  if (agentModeOf(readConfig(ws)) !== "session") {
    throw new UserError(
      "Role sessions are off in this workspace (agentMode is subagent): spawn role agents as subagents, or turn sessions on with `npx openfleet config set agentMode session`.",
    );
  }
}

function hostOf(ws: Workspace, project: string): Host {
  return readState(projectPaths(ws, project)).host ?? DEFAULT_HOST;
}

/** Claim the child for the role (or resolve the extension entry), write the job and start its runner. */
export function startJob(opts: StartOptions): StartResult {
  const { ws, project } = opts;
  requireSessions(ws);
  const p = projectPaths(ws, project);
  const config = readConfig(ws);
  let role: JobRole;
  let agent: string;
  let extension: string | undefined;
  let slot: string | undefined;
  let target: RoleTarget;
  let prompt: string;
  let split: ReturnType<typeof planSplit> | undefined;
  const child = opts.child ?? null;
  if (opts.agent) {
    const index = readCoreIndex(ws);
    const entry = index ? findSlotEntry(index, opts.agent) : undefined;
    if (!entry) throw new UserError(`"${opts.agent}" is not an extension phase agent in this workspace.`);
    const state = readState(p);
    if (state.halt) {
      return { result: "stop", child, role: "extension", reason: state.halt.reason, detail: state.halt.detail ?? null };
    }
    if (child && !state.children[child]) throw new UserError(`Unknown child "${child}".`);
    role = "extension";
    agent = qualifiedAgentName(entry.agent);
    extension = entry.extension;
    slot = entry.slot;
    target = roleTarget(config, hostOf(ws, project), "extensions");
    const worktree = child ? state.children[child]!.worktree : undefined;
    prompt = [
      child
        ? `Run \`${slot}\` for child \`${child}\` of project \`${project}\`.${worktree ? ` Worktree: \`${worktree}\`.` : ""}`
        : `Run \`${slot}\` for project \`${project}\`.`,
      "",
      SESSION_NOTE,
    ].join("\n");
  } else {
    if (!opts.role || !(JOB_ROLES as readonly string[]).includes(opts.role)) {
      throw new UserError(`--role must be one of ${JOB_ROLES.join(", ")} (repo coordinators stay subagents).`);
    }
    if (!child)
      throw new UserError("agent start needs a child: npx openfleet agent start <project> <child> --role <role>");
    role = opts.role as WorkRole;
    agent = qualifiedAgentName(`openfleet-${role}`);
    target = roleTarget(config, hostOf(ws, project), role);
    const res = claim(ws, project, child, role);
    if (res.result !== "claimed") return res;
    const state = readState(p);
    prompt = [ROLE_LINE[role](child, project), "", childContext(p, state, child, role), "", SESSION_NOTE].join("\n");
    if (role === "planner" && splitsInSteps(config, "implementer")) prompt += `\n\n${PLANNER_STEPS_NOTE}`;
    if (role === "implementer" && splitsInSteps(config, "implementer")) split = planSplit(state.children[child]!);
  }
  if (opts.message?.trim()) prompt += `\n\n## From the coordinator\n\n${opts.message.trim()}`;
  const id = newJobId(p, role, child);
  const owner = ownerOf(readState(p), child);
  const sessionId = crypto.randomUUID();
  const job: Job = {
    id,
    project,
    child,
    role,
    agent,
    ...(extension ? { extension, slot } : {}),
    host: target.host,
    ...(target.model ? { model: target.model } : {}),
    ...(target.endpoint ? { endpoint: target.endpoint.name } : {}),
    owner,
    sessionId,
    state: "running",
    createdAt: new Date().toISOString(),
    turns: [],
    queue: [prompt],
    unread: false,
  };
  if (split?.pending.length) {
    // Step mode: each pending step runs in its own session; the first one starts now.
    const fb = roleTarget(config, job.host, "fallback");
    job.steps = split.steps.map((s) => ({ ...s, state: split.done.includes(s.n) ? "done" : "pending", attempts: 0 }));
    job.stepsPlan = split.hash;
    if (fb.model) job.fallback = { model: fb.model, ...(fb.endpoint ? { endpoint: fb.endpoint.name } : {}) };
    if (opts.message?.trim()) job.stepMessage = opts.message.trim();
    job.queue = [];
    startStep(
      p,
      job,
      job.steps.find((s) => s.state === "pending")!,
      false,
    );
  }
  fs.mkdirSync(path.dirname(jobFile(p, id)), { recursive: true });
  writeJson(jobFile(p, id), job);
  if (role !== "extension") {
    updateState(p, (s) => {
      const c = s.children[child!]!;
      // The claim is consumed here, not by the spawn hook.
      delete c.pendingSpawn;
      delete c.claimedAt;
      c.agentIds[role] = id;
      c.role = role;
    });
  }
  appendEvent(p, {
    actor: role === "extension" ? `ext:${extension}` : actorFor(child!, role),
    type: "agent.spawned",
    target: child,
    payload: {
      agentId: id,
      agentName: agent,
      jobId: id,
      sessionId,
      host: job.host,
      model: job.model ?? null,
      endpoint: job.endpoint ?? null,
      ...(split ? { steps: job.steps ? job.steps.filter((s) => s.state === "pending").length : null } : {}),
      ...(split && !job.steps
        ? { split: split.steps.length ? "every step is done: one session for the message" : "the plan has no ## Steps" }
        : {}),
    },
  });
  if (opts.detach !== false) spawnRunner(ws, p, id, opts.env);
  return {
    result: "started",
    job: id,
    sessionId,
    child,
    role,
    host: job.host,
    ...(job.model ? { model: job.model } : {}),
    ...(job.endpoint ? { endpoint: job.endpoint } : {}),
  };
}

const BIN = fileURLToPath(new URL("./bin.js", import.meta.url));

/** Start `openfleet agent run <project> <job>` detached, so it outlives the caller. */
export function spawnRunner(ws: Workspace, p: ProjectPaths, id: string, env: NodeJS.ProcessEnv = process.env): void {
  const log = fs.openSync(path.join(jobsDir(p), id, "runner.log"), "a");
  const child = spawn(process.execPath, [BIN, "agent", "run", p.name, id], {
    cwd: ws.root,
    detached: true,
    stdio: ["ignore", log, log],
    env,
  });
  fs.closeSync(log);
  updateJob(p, id, (j) => {
    j.runnerPid = child.pid;
  });
  child.unref();
}

// ---------------------------------------------------------------- run

/** Host args for one headless turn. The first turn creates the session; later turns resume it. */
/** The session turns go to: the current step's, else the job's own. */
export function sessionOf(job: Job): SessionRef {
  return job.current ?? { sessionId: job.sessionId, model: job.model, endpoint: job.endpoint };
}

export function turnArgs(ws: Workspace, job: Job, prompt: string, first: boolean): string[] {
  const dirs = allowedDirs(ws, job.project).flatMap((d) => ["--add-dir", d]);
  const s = sessionOf(job);
  const model = s.model ? ["--model", s.model] : [];
  const session = first ? ["--session-id", s.sessionId] : ["--resume", s.sessionId];
  if (job.host === "claude") {
    return [
      "-p",
      prompt,
      "--plugin-dir",
      pluginDir(ws, "claude"),
      "--agent",
      job.agent,
      ...session,
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash",
      ...dirs,
      ...model,
    ];
  }
  return [
    "-p",
    prompt,
    "--plugin-dir",
    ws.core,
    "--agent",
    job.agent,
    ...session,
    "--allow-all-tools",
    ...dirs,
    ...model,
  ];
}

/** Env for a job's host process: the coordinator's env without its own session markers, plus the role's endpoint. */
export function jobEnv(ws: Workspace, job: Job, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  // Claude Code refuses to start inside another Claude Code session's env.
  delete next.CLAUDECODE;
  delete next.CLAUDE_CODE_ENTRYPOINT;
  Object.assign(next, {
    OPENFLEET_HOST: job.host,
    OPENFLEET_WORKSPACE: ws.root,
    OPENFLEET_PROJECT: job.project,
    OPENFLEET_JOB: job.id,
    OPENFLEET_ROLE: job.role,
    OPENFLEET_CHILD: job.child ?? "",
  });
  const s = sessionOf(job);
  if (s.endpoint) {
    const ep = readConfig(ws).endpoints?.[s.endpoint];
    if (!ep) throw new UserError(`Endpoint "${s.endpoint}" is no longer configured.`);
    delete next.CLAUDE_CODE_USE_BEDROCK;
    delete next.CLAUDE_CODE_USE_VERTEX;
    Object.assign(next, endpointEnv(ep, s.model!, env));
  }
  return next;
}

/** Final text of a turn: Claude's `--output-format json` `result`, else the plain output. */
export function turnText(host: Host, stdout: string): { text: string; error?: string } {
  if (host === "claude") {
    const lines = stdout.trim().split("\n").reverse();
    for (const line of lines) {
      try {
        const v = JSON.parse(line) as { type?: string; result?: unknown; is_error?: boolean; subtype?: string };
        if (v.type === "result") {
          const text = typeof v.result === "string" ? v.result : "";
          return v.is_error ? { text, error: v.subtype ?? "error" } : { text };
        }
      } catch {
        // not JSON
      }
    }
  }
  return { text: stdout.trim() };
}

const NUDGE =
  "Your last turn ended without an `openfleet-report` block. Reply with only that block now (status, child, summary and the other fields your instructions list).";
const TEXT_LIMIT = 200_000;

function runTurn(ws: Workspace, job: Job, prompt: string, first: boolean, env: NodeJS.ProcessEnv) {
  const p = projectPaths(ws, job.project);
  const dir = path.join(jobsDir(p), job.id);
  const n = job.turns.length + 1;
  fs.writeFileSync(path.join(dir, `turn-${n}.prompt.md`), prompt);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(hostBinary(job.host, env), turnArgs(ws, job, prompt, first), {
        cwd: ws.root,
        env: jobEnv(ws, job, env),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: (err as Error).message });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    updateJob(p, job.id, (j) => {
      j.hostPid = child.pid;
      j.turns.push({ n, startedAt: new Date().toISOString() });
    });
    child.on("error", (err) => (stderr += err.message));
    child.on("close", (code) => {
      fs.writeFileSync(path.join(dir, `turn-${n}.out`), stdout);
      if (stderr) fs.appendFileSync(path.join(dir, "stderr.log"), stderr);
      resolve({ code, stdout, stderr });
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The job runner: run queued turns until the queue is empty, then finish the job. A turn without a
 * report gets one nudge; a turn that crashes with no output is retried once (resuming the session).
 */
export async function runJob(
  ws: Workspace,
  project: string,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  retryDelayMs = 15_000,
): Promise<Job> {
  const p = projectPaths(ws, project);
  updateJob(p, id, (j) => {
    j.runnerPid = process.pid;
    j.state = "running";
  });
  for (;;) {
    let prompt: string | undefined;
    let stepped: StepChange | undefined;
    let job = updateJob(p, id, (j) => {
      prompt = j.queue.shift();
      // Step mode: the queue ran dry, so the current step's session is done; move on.
      if (prompt === undefined && j.steps) {
        stepped = advanceSteps(p, j);
        prompt = j.queue.shift();
      }
      if (prompt === undefined) {
        // Nothing left: finish under the same lock, so a concurrent `reply` sees the final state.
        const last = j.turns.at(-1);
        j.state = j.result || last?.report ? "finished" : "failed";
        j.endedAt = new Date().toISOString();
        j.unread = true;
        delete j.hostPid;
        delete j.runnerPid;
      }
    });
    if (stepped) recordStep(p, job, stepped);
    if (prompt === undefined) {
      finishJob(ws, p, job);
      return job;
    }
    const sid = sessionOf(job).sessionId;
    const first = job.started ? !job.started.includes(sid) : !job.turns.some((t) => t.exitCode === 0 || t.text);
    const res = await runTurn(ws, job, prompt, first, env);
    const { text, error } = turnText(job.host, res.stdout);
    const report = parseReport(text);
    job = updateJob(p, id, (j) => {
      const t = j.turns.at(-1)!;
      t.endedAt = new Date().toISOString();
      t.exitCode = res.code;
      if (text) t.text = text.slice(-TEXT_LIMIT);
      if (report) t.report = report;
      // The host session exists once a turn produced output; later turns resume it.
      if ((res.code === 0 || text) && !(j.started ??= []).includes(sid)) j.started.push(sid);
      const ref = sessionOf(j);
      if (!(j.sessions ??= []).some((x) => x.sessionId === ref.sessionId)) j.sessions.push(ref);
      const err =
        error ??
        (res.code === 0 ? undefined : res.stderr.trim().split("\n").slice(-5).join("\n") || `exit ${res.code}`);
      if (err) t.error = err;
      if (j.state === "stopped") return;
      if (!text && res.code !== 0 && !j.retried) {
        j.retried = true;
        j.queue.unshift(prompt!);
      } else if (!report && !j.nudged && !j.queue.length) {
        j.nudged = true;
        j.queue.push(NUDGE);
      }
    });
    appendEvent(p, {
      actor: actorOf(job),
      type: "agent.turn",
      target: job.child,
      payload: {
        jobId: id,
        turn: job.turns.length,
        exitCode: res.code,
        status: report?.status ?? null,
        ...(job.turns.at(-1)?.error ? { error: job.turns.at(-1)!.error } : {}),
      },
    });
    if (job.state === "stopped") return job;
    if (job.retried && job.queue[0] === prompt) await sleep(retryDelayMs);
  }
}

// ---------------------------------------------------------------- steps

/** The plan's steps for an implementer in step mode, and which of them earlier jobs of the same plan finished. */
function planSplit(child: ChildState): { steps: PlanStep[]; hash: string; done: number[]; pending: PlanStep[] } {
  // Merge conflicts and integration fixes are one task, not plan steps.
  const text =
    child.plan && !child.conflict && !child.integration && fs.existsSync(child.plan)
      ? fs.readFileSync(child.plan, "utf8")
      : "";
  const steps = parseSteps(text);
  const hash = stepsHash(steps);
  const done = child.stepsDone?.plan === hash ? child.stepsDone.steps : [];
  return { steps, hash, done, pending: steps.filter((s) => !done.includes(s.n)) };
}

/** Queue a step's prompt for a fresh session (on the fallback model when `fallback`). */
function startStep(p: ProjectPaths, j: Job, step: JobStep, fallback: boolean, previous?: string): void {
  const state = readState(p);
  const child = state.children[j.child!]!;
  const ref = fallback && j.fallback ? j.fallback : { model: j.model, endpoint: j.endpoint };
  j.current = {
    sessionId: crypto.randomUUID(),
    ...(ref.model ? { model: ref.model } : {}),
    ...(ref.endpoint ? { endpoint: ref.endpoint } : {}),
  };
  step.state = "running";
  delete j.nudged;
  delete j.retried;
  const steps = j.steps!;
  j.queue.push(
    stepPrompt({
      child: j.child!,
      project: p.name,
      step,
      total: steps.length,
      done: steps.filter((s) => s.state === "done"),
      assignment: childContext(p, state, j.child!, "implementer"),
      changes: worktreeChanges(child.worktree),
      ...(j.stepMessage ? { message: j.stepMessage } : {}),
      ...(previous ? { previous } : {}),
    }) + `\n\n${SESSION_NOTE}`,
  );
  delete j.stepMessage;
}

interface StepChange {
  step: JobStep;
  status: string;
  session: SessionRef;
}

/**
 * The current step's session ran out of turns: record its result and queue the next session. A
 * failed step gets one more fresh session, then one on the fallback model (if set); a question or
 * a step that still fails ends the job with that step's report.
 */
function advanceSteps(p: ProjectPaths, j: Job): StepChange | undefined {
  const steps = j.steps!;
  const step = steps.find((s) => s.state === "running" || s.state === "waiting");
  const total = steps.length;
  let change: StepChange | undefined;
  if (step) {
    const last = j.turns.at(-1);
    const rep = last?.report;
    const session = sessionOf(j);
    if (rep) step.report = rep;
    if (rep?.status === "done") {
      step.state = "done";
      change = { step, status: "done", session };
    } else if (rep?.status === "question") {
      step.state = "waiting";
      j.result = { ...rep, child: j.child!, step: step.n, of: total };
      return { step, status: "question", session };
    } else {
      step.attempts++;
      const why = rep?.summary ?? last?.error ?? "the session ended without a report";
      const previous = `Attempt ${step.attempts} (${session.model ?? "default model"}): ${String(why)}`;
      const onFallback = j.fallback && session.model === j.fallback.model && session.endpoint === j.fallback.endpoint;
      if (step.attempts < 2) startStep(p, j, step, false, previous);
      else if (j.fallback && !onFallback) startStep(p, j, step, true, previous);
      else {
        step.state = "failed";
        j.result = {
          status: "failed",
          child: j.child!,
          summary: `Step ${step.n} of ${total} (${step.title}) failed after ${step.attempts} attempts: ${String(why)}`,
          findings: rep && Array.isArray(rep.findings) ? (rep.findings as unknown[]) : [String(why)],
          step: step.n,
          of: total,
          done: steps.filter((s) => s.state === "done").map((s) => s.n),
        };
      }
      return { step, status: step.state === "failed" ? "failed" : "retry", session };
    }
  }
  const next = steps.find((s) => s.state === "pending");
  if (next) startStep(p, j, next, false);
  else if (steps.every((s) => s.state === "done")) {
    j.result = {
      status: "done",
      child: j.child!,
      summary: steps.map((s) => `${s.n}. ${s.title}: ${String(s.report?.summary ?? "done")}`).join("\n"),
      steps: total,
    };
  }
  return change;
}

/** Log `agent.step` and remember finished steps on the child, so a later job of the same plan skips them. */
function recordStep(p: ProjectPaths, job: Job, c: StepChange): void {
  appendEvent(p, {
    actor: actorOf(job),
    type: "agent.step",
    target: job.child,
    payload: {
      jobId: job.id,
      step: c.step.n,
      of: job.steps!.length,
      title: c.step.title,
      status: c.status,
      attempts: c.step.attempts,
      sessionId: c.session.sessionId,
      model: c.session.model ?? null,
      endpoint: c.session.endpoint ?? null,
    },
  });
  if (c.status !== "done") return;
  updateState(p, (s) => {
    const child = s.children[job.child!];
    if (!child) return;
    const prev = child.stepsDone?.plan === job.stepsPlan ? child.stepsDone!.steps : [];
    child.stepsDone = { plan: job.stepsPlan!, steps: [...new Set([...prev, c.step.n])].sort((a, b) => a - b) };
  });
}

export function actorOf(job: Job): string {
  return job.role === "extension" ? `ext:${job.extension}` : actorFor(job.child ?? "unknown", job.role);
}

/** Log `agent.stopped` with the final report and snapshot the child's worktree, as the subagentStop hook does. */
function finishJob(ws: Workspace, p: ProjectPaths, job: Job, stopped = false): void {
  const last = job.turns.at(-1);
  const at = new Date().toISOString();
  appendEvent(p, {
    ts: at,
    actor: actorOf(job),
    type: "agent.stopped",
    target: job.child,
    payload: {
      agentId: job.id,
      agentName: job.agent,
      jobId: job.id,
      sessionId: job.sessionId,
      state: job.state,
      turns: job.turns.length,
      response: job.result ? String(job.result.summary ?? "") : (last?.text ?? ""),
      ...(job.result ? { report: job.result } : {}),
      ...(stopped ? { stopped: true } : {}),
    },
  });
  if (job.child && job.role !== "extension") {
    const child = readState(p).children[job.child];
    if (child) snapshotChild(p, job.child, child, actorOf(job), at);
  }
}

// ---------------------------------------------------------------- wait, reply, stop

/** Mark jobs whose runner died as `lost` (logged once). */
export function sweepLost(p: ProjectPaths): Job[] {
  const lost: Job[] = [];
  for (const j of listJobs(p)) {
    if (j.state !== "running" || isAlive(j.runnerPid)) continue;
    // A runner that has not written its pid yet is still starting.
    if (!j.runnerPid && Date.now() - Date.parse(j.runnerAt ?? j.createdAt) < 30_000) continue;
    const job = updateJob(p, j.id, (x) => {
      if (x.state !== "running" || isAlive(x.runnerPid)) return;
      x.state = "lost";
      x.unread = true;
      x.endedAt = new Date().toISOString();
    });
    if (job.state !== "lost") continue;
    appendEvent(p, {
      actor: actorOf(job),
      type: "agent.lost",
      target: job.child,
      payload: { jobId: job.id, turns: job.turns.length },
    });
    lost.push(job);
  }
  return lost;
}

export interface JobView {
  job: string;
  owner: string;
  state: JobState;
  child: string | null;
  role: JobRole;
  agent: string;
  host: Host;
  model: string | null;
  endpoint: string | null;
  turns: number;
  queued: number;
  unread: boolean;
  createdAt: string;
  endedAt: string | null;
  report: Report | null;
  error: string | null;
  steps?: { n: number; title: string; state: JobStep["state"]; attempts: number }[];
}

export function view(job: Job): JobView {
  const last = job.turns.at(-1);
  return {
    job: job.id,
    owner: job.owner ?? TOP,
    state: job.state,
    child: job.child,
    role: job.role,
    agent: job.agent,
    host: job.host,
    model: job.model ?? null,
    endpoint: job.endpoint ?? null,
    turns: job.turns.length,
    queued: job.queue.length,
    unread: job.unread,
    createdAt: job.createdAt,
    endedAt: job.endedAt ?? null,
    report: job.result ?? last?.report ?? null,
    error: job.result ? null : (last?.error ?? null),
    ...(job.steps
      ? { steps: job.steps.map((x) => ({ n: x.n, title: x.title, state: x.state, attempts: x.attempts })) }
      : {}),
  };
}

/** The job's last turn, marked read: report and final text. */
export function jobResult(p: ProjectPaths, id: string): JobView & { text: string } {
  const job = updateJob(p, id, (j) => {
    if (j.state !== "running") j.unread = false;
  });
  return { ...view(job), text: job.result ? String(job.result.summary ?? "") : (job.turns.at(-1)?.text ?? "") };
}

export type WaitResult =
  ({ result: "turn" } & JobView & { text: string }) | { result: "timeout"; running: string[] } | { result: "idle" };

/** Wait for the next unread finished job (or `jobId`), up to `timeoutMs`. */
export async function waitJobs(
  p: ProjectPaths,
  {
    jobId,
    owner = TOP,
    timeoutMs = 540_000,
    pollMs = 1000,
  }: { jobId?: string; owner?: string; timeoutMs?: number; pollMs?: number } = {},
): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    sweepLost(p);
    // Each coordinator waits only for its own jobs (or the one it names).
    const jobs = listJobs(p).filter((j) => (jobId ? j.id === jobId : (j.owner ?? TOP) === owner));
    if (jobId && !jobs.length) throw new UserError(`Unknown job "${jobId}" in project ${p.name}.`);
    const done = jobs.find((j) => j.unread && j.state !== "running");
    if (done) return { result: "turn", ...jobResult(p, done.id) };
    const running = jobs.filter((j) => j.state === "running").map((j) => j.id);
    if (!running.length) return { result: "idle" };
    if (Date.now() >= deadline) return { result: "timeout", running };
    await sleep(pollMs);
  }
}

/** Send the next turn to a job's session: queued while it runs, else the runner starts again. */
export function replyJob(
  ws: Workspace,
  p: ProjectPaths,
  id: string,
  message: string,
  env?: NodeJS.ProcessEnv,
  detach = true,
): { result: "queued" | "started"; job: string } {
  if (!message.trim()) throw new UserError("agent reply needs --message or --message-file.");
  const state = readState(p);
  if (state.halt?.reason === "cancelled") throw new UserError(`Project ${p.name} is cancelled; nothing more runs.`);
  sweepLost(p);
  let restart = false;
  const job = updateJob(p, id, (j) => {
    if (j.state === "stopped") throw new UserError(`Job ${id} was stopped; start a new one.`);
    j.queue.push(message.trim());
    if (j.state !== "running") {
      restart = true;
      j.state = "running";
      j.runnerAt = new Date().toISOString();
      j.unread = false;
      delete j.endedAt;
      delete j.nudged;
      delete j.retried;
      // A step that asked a question continues; the job has no overall result yet.
      delete j.result;
    }
  });
  appendEvent(p, {
    actor: "coordinator",
    type: "message.sent",
    target: job.child,
    payload: { to: actorOf(job), jobId: id, text: message.trim() },
  });
  if (restart && detach) spawnRunner(ws, p, id, env);
  return { result: restart ? "started" : "queued", job: id };
}

/** Stop a running job: SIGTERM to its host and runner, logged as `agent.stopped` with `stopped: true`. */
export function stopJob(ws: Workspace, p: ProjectPaths, id: string, reason?: string): JobView {
  let was: JobState | undefined;
  const job = updateJob(p, id, (j) => {
    was = j.state;
    if (j.state !== "running") return;
    for (const pid of [j.hostPid, j.runnerPid]) {
      if (!isAlive(pid)) continue;
      try {
        process.kill(pid!, "SIGTERM");
      } catch {
        // already gone
      }
    }
    j.state = "stopped";
    j.queue = [];
    j.unread = true;
    j.endedAt = new Date().toISOString();
    const last = j.turns.at(-1);
    if (reason && last) last.error = `stopped: ${reason}`;
  });
  if (was === "running") finishJob(ws, p, job, true);
  return view(job);
}

/** Stop every running job of a project (on `cancel`). Returns the stopped job ids. */
export function stopAllJobs(ws: Workspace, project: string, reason: string): string[] {
  const p = projectPaths(ws, project);
  return listJobs(p)
    .filter((j) => j.state === "running")
    .map((j) => stopJob(ws, p, j.id, reason).job);
}

/** Bare agent name for display, e.g. `openfleet-implementer`. */
export function shortAgent(job: Job): string {
  return bareAgentName(job.agent) ?? job.agent;
}
