import crypto from "node:crypto";
import fs from "node:fs";
import { appendEvent, readEvents } from "../events.js";
import { deleteBranch, removeWorktree, tryGit } from "../git.js";
import { syncExtensions } from "../core.js";
import { groupOf, membersOf } from "../groups.js";
import { parseHost, readConfig } from "../config.js";
import { DEFAULT_HOST, HOST_LABEL, type Host } from "../hosts.js";
import { launch, sessionExists } from "../launcher.js";
import { specFollowUps, specSection } from "../greenfield.js";
import { readRepos, writeRepos } from "../repos.js";
import { newState, readState, updateState, type ProjectState } from "../state.js";
import { writeJson } from "../fsutil.js";
import {
  listProjectNames,
  projectPaths,
  requireWorkspace,
  UserError,
  validateProjectName,
  type Workspace,
} from "../workspace.js";
import { out, warn } from "./output.js";

const INACTIVE = new Set(["done", "cancelled"]);

function childRepos(state: ProjectState): Set<string> {
  return new Set(Object.values(state.children).map((c) => c.repo));
}

/** Other active projects touching any of the same repos. */
export function findOverlaps(ws: Workspace, name: string): { project: string; repos: string[] }[] {
  const mine = childRepos(readState(projectPaths(ws, name)));
  if (!mine.size) return [];
  const result: { project: string; repos: string[] }[] = [];
  for (const other of listProjectNames(ws)) {
    if (other === name) continue;
    let state: ProjectState;
    try {
      state = readState(projectPaths(ws, other));
    } catch {
      continue;
    }
    if (INACTIVE.has(state.status)) continue;
    const shared = [...childRepos(state)].filter((r) => mine.has(r));
    if (shared.length) result.push({ project: other, repos: shared });
  }
  return result;
}

function warnOverlaps(ws: Workspace, name: string): void {
  for (const o of findOverlaps(ws, name)) {
    warn(`Project "${o.project}" is also active on ${o.repos.join(", ")}. Changes may conflict.`);
  }
}

export function createProject(ws: Workspace, name: string, host: Host = DEFAULT_HOST): ProjectState {
  const p = projectPaths(ws, name);
  if (fs.existsSync(p.state)) {
    throw new UserError(`Project "${name}" already exists. Use \`npx openfleet resume ${name}\`.`);
  }
  fs.mkdirSync(p.contracts, { recursive: true });
  fs.mkdirSync(p.plans, { recursive: true });
  const state = newState(name, crypto.randomUUID(), host);
  writeJson(p.state, state);
  appendEvent(p, {
    actor: "cli",
    type: "project.created",
    target: null,
    payload: { sessionId: state.sessionId, host },
  });
  return state;
}

export function cmdNew(args: string[], passthrough: string[], opts: { ask?: boolean; host?: string } = {}): number {
  const ws = requireWorkspace();
  const [rawName, ...promptParts] = args;
  const name = validateProjectName(rawName);
  // Re-sync so edits to extensions.config.json reach the generated agents.
  const host = opts.host !== undefined ? parseHost(opts.host) : readConfig(ws).host;
  syncExtensions(ws, warn);
  const state = createProject(ws, name, host);
  const request = promptParts.join(" ").trim();
  out(`Created project ${name} at ${projectPaths(ws, name).dir}. Launching the coordinator…`);
  const prompt = [
    `Start OpenFleet project \`${name}\` (projects/${name}/).`,
    request ? `The user's request: ${request}` : "Ask the user what they want to change.",
    "Begin the grill session (skill openfleet-grill).",
  ].join("\n");
  return launch({
    ws,
    agent: "openfleet-coordinator",
    prompt,
    sessionId: state.sessionId,
    newSession: true,
    name: `openfleet: ${name}`,
    project: name,
    passthrough,
    ask: opts.ask,
    host,
  });
}

/** The project's recorded host. `--host` may only repeat it: a project never switches hosts. */
export function resumeHost(ws: Workspace, state: ProjectState, flag?: string): Host {
  const recorded = state.host ?? DEFAULT_HOST;
  if (flag !== undefined && parseHost(flag) !== recorded) {
    throw new UserError(
      `Project "${state.name}" runs in ${HOST_LABEL[recorded]} (host ${recorded}); it cannot switch to ` +
        `${flag} mid-project. Resume it without --host, or start a new project with --host ${flag}.`,
    );
  }
  const configured = readConfig(ws).host;
  if (configured !== recorded) {
    warn(`Workspace host is ${configured}, but project "${state.name}" runs in ${recorded}; resuming in ${recorded}.`);
  }
  return recorded;
}

export function cmdResume(
  args: string[],
  passthrough: string[],
  opts: { fresh?: boolean; ask?: boolean; host?: string } = {},
): number {
  const ws = requireWorkspace();
  const name = validateProjectName(args[0]);
  const p = projectPaths(ws, name);
  let state = readState(p);
  const host = resumeHost(ws, state, opts.host);
  syncExtensions(ws, warn);
  const previous = state.sessionId;
  const missing = !opts.fresh && previous !== undefined && sessionExists(host, previous) === false;
  const newSession = opts.fresh || !previous || missing;
  const sessionId = newSession ? crypto.randomUUID() : previous;
  if (missing) {
    warn(
      `${host === "copilot" ? "Copilot" : HOST_LABEL[host]} session ${previous} no longer exists; starting a new session ${sessionId}.`,
    );
    appendEvent(p, {
      actor: "cli",
      type: "session.replaced",
      target: null,
      payload: { previous, sessionId, reason: "missing" },
    });
  }
  // Subagents (repo coordinators included) do not survive the session: drop their claims and running marks.
  state = updateState(
    p,
    (s) => {
      s.sessionId = sessionId;
      // Re-check git writes before anything spawns: the new session may run in a different sandbox.
      s.preflight = { ...(s.preflight ?? { ok: false, at: new Date().toISOString() }), stale: true };
      for (const c of Object.values(s.children)) {
        delete c.pendingSpawn;
        delete c.claimedAt;
        if (c.coordinator === "running") c.coordinator = "stopped";
      }
    },
    "cli",
  );
  const repoCoordinators = Object.entries(state.children)
    .filter(([, c]) => c.integration && c.phase !== "done" && c.phase !== "failed")
    .map(([id]) => id);
  warnOverlaps(ws, name);
  out(`Resuming project ${name} (status: ${state.status})…`);
  return launch({
    ws,
    agent: "openfleet-coordinator",
    prompt: [
      `Resume OpenFleet project \`${name}\`. Read projects/${name}/state.json and continue from where it left off.`,
      `First run \`npx openfleet preflight ${name}\`; spawn nothing until it passes.`,
      repoCoordinators.length
        ? `Start the repo coordinators again (\`npx openfleet next ${name}\` lists them): ${repoCoordinators.join(", ")}.`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    sessionId: state.sessionId,
    newSession,
    name: `openfleet: ${name}`,
    project: name,
    passthrough,
    ask: opts.ask,
    host,
  });
}

/** First free `<base>-<n>` project name (n ≥ 2). */
function nextSliceName(ws: Workspace, base: string): string {
  const taken = new Set(listProjectNames(ws));
  const stem = base.replace(/-\d+$/, "").slice(0, 58);
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

/** Draft spec for the next slice: the previous Layout, Stack and Shared approach, and its Follow-ups as the backlog. */
export function continuationSpec(from: string, previous: string, followUps: string[]): string {
  const keep = ["Layout", "Stack", "Shared approach"].flatMap((h) => {
    const body = specSection(previous, h);
    return body ? [`## ${h}`, "", body, ""] : [];
  });
  return [
    `# Next slice of ${from}`,
    "",
    `Draft seeded by \`npx openfleet continue\` from projects/${from}/spec.md. The grill picks the next MVP slice from the backlog below and rewrites this file with \`openfleet-spec\`.`,
    "",
    ...keep,
    `## Backlog (Follow-ups of ${from})`,
    "",
    ...followUps.map((f) => `- ${f}`),
    "",
  ].join("\n");
}

/**
 * `npx openfleet continue <project> [name]`: a new project for the next slice of a finished
 * greenfield project. Its spec draft holds the previous Follow-ups, Layout and Stack; the repos are
 * reused (no longer greenfield), and the same scope caps apply.
 */
export function cmdContinue(
  args: string[],
  passthrough: string[],
  opts: { ask?: boolean; host?: string } = {},
): number {
  const ws = requireWorkspace();
  const from = validateProjectName(args[0]);
  const prev = projectPaths(ws, from);
  const source = readState(prev);
  if (!source.greenfield && !source.continuedFrom) {
    throw new UserError(`Project "${from}" is not a greenfield project; start a new one with \`npx openfleet new\`.`);
  }
  if (source.status !== "done") {
    throw new UserError(
      `Project "${from}" is "${source.status}", not "done". Finish it first (\`npx openfleet resume ${from}\`).`,
    );
  }
  const previous = fs.existsSync(prev.spec) ? fs.readFileSync(prev.spec, "utf8") : "";
  const followUps = specFollowUps(previous) ?? [];
  if (!followUps.length) throw new UserError(`projects/${from}/spec.md lists no Follow-ups to continue with.`);
  const name = args[1] !== undefined ? validateProjectName(args[1]) : nextSliceName(ws, from);
  const host = opts.host !== undefined ? parseHost(opts.host) : (source.host ?? readConfig(ws).host);
  syncExtensions(ws, warn);

  const created = createProject(ws, name, host);
  const p = projectPaths(ws, name);
  fs.writeFileSync(p.spec, continuationSpec(from, previous, followUps));
  if (fs.existsSync(prev.contracts)) fs.cpSync(prev.contracts, p.contracts, { recursive: true });
  const repoKeys = [...childRepos(source)].filter(Boolean).sort();
  const state = updateState(
    p,
    (s) => {
      s.continuedFrom = from;
      if (source.toolchains?.length) s.toolchains = [...source.toolchains];
    },
    "cli",
  );
  // The repos exist now: the next slice changes them like any other repo.
  const repos = readRepos(ws);
  for (const key of repoKeys) if (repos.repos[key]?.greenfield) repos.repos[key].greenfield = false;
  writeRepos(ws, repos);
  appendEvent(p, {
    actor: "cli",
    type: "project.continued",
    target: null,
    payload: { from, repos: repoKeys, followUps: followUps.length },
  });

  out(`Created project ${name}, continuing ${from} (${followUps.length} follow-ups). Launching the coordinator…`);
  return launch({
    ws,
    agent: "openfleet-coordinator",
    prompt: [
      `Start OpenFleet project \`${name}\` (projects/${name}/), the next slice of \`${from}\`.`,
      `projects/${name}/spec.md is a draft with the previous Layout, Stack and the Follow-ups backlog; contracts/ holds ${from}'s contracts.`,
      `Begin the grill session (skill openfleet-grill, "Continuing a greenfield project"): reuse the repos (${repoKeys.join(", ")}) and the stack without asking about them again, and pick the next MVP slice under the same caps.`,
    ].join("\n"),
    sessionId: created.sessionId ?? state.sessionId,
    newSession: true,
    name: `openfleet: ${name}`,
    project: name,
    passthrough,
    ask: opts.ask,
    host,
  });
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows
    .map((r) =>
      r
        .map((c, i) => pad(c, widths[i]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function cmdList(): number {
  const ws = requireWorkspace();
  const names = listProjectNames(ws);
  if (!names.length) {
    out("No projects yet. Start one with `npx openfleet new <name>`.");
    return 0;
  }
  const rows = [["PROJECT", "STATUS", "CHILDREN", "UPDATED"]];
  for (const name of names) {
    const s = readState(projectPaths(ws, name));
    const children = Object.values(s.children);
    const done = children.filter((c) => c.phase === "done").length;
    const failed = children.filter((c) => c.phase === "failed" || c.phase === "blocked").length;
    const progress = children.length
      ? `${done}/${children.length} done${failed ? `, ${failed} failed/blocked` : ""}`
      : "-";
    rows.push([name, s.status, progress, s.updatedAt]);
  }
  out(table(rows));
  return 0;
}

export function cmdStatus(args: string[], opts: { json?: boolean } = {}): number {
  const ws = requireWorkspace();
  if (!args[0]) return cmdList();
  const name = validateProjectName(args[0]);
  const p = projectPaths(ws, name);
  const s = readState(p);
  if (opts.json) {
    out(JSON.stringify(s, null, 2));
    return 0;
  }
  out(`Project ${name}: ${s.status}${s.completionMode ? ` (completion: ${s.completionMode})` : ""}`);
  const children = Object.entries(s.children);
  if (children.length) {
    out("");
    const rows = [["CHILD", "PHASE", "ROLE", "RETRIES", "BRANCH", "DEPENDS ON"]];
    const row = (label: string, id: string) => {
      const c = s.children[id]!;
      const role = c.integration ? `repo-coordinator (${c.coordinator ?? "not started"})` : (c.role ?? "-");
      const deps = c.integration ? "(its children)" : c.dependsOn.join(",") || "-";
      const phase = c.phase === "done" && groupOf(s, id) ? (c.merged ? "done, merged" : "done") : c.phase;
      rows.push([label, phase, role, String(c.retries), c.branch ?? "-", deps]);
    };
    for (const [id, c] of children) {
      if (groupOf(s, id)) continue;
      row(id, id);
      if (c.integration) for (const m of membersOf(s, id)) row(`  ${m}`, m);
    }
    out(table(rows));
  }
  const open = s.questions.filter((q) => q.status === "open");
  if (open.length) {
    out("");
    out("Open questions:");
    for (const q of open) out(`  [${q.id}] ${q.from}: ${q.text}`);
  }
  const events = readEvents(p);
  out("");
  out(
    `${events.length} events recorded${events.length ? `, last: ${events.at(-1)!.type} at ${events.at(-1)!.ts}` : ""}.`,
  );
  warnOverlaps(ws, name);
  return 0;
}

export function cmdClean(args: string[], opts: { branches?: boolean; force?: boolean } = {}): number {
  const ws = requireWorkspace();
  const name = validateProjectName(args[0]);
  const p = projectPaths(ws, name);
  const s = readState(p);
  let failures = 0;
  for (const [id, c] of Object.entries(s.children)) {
    if (c.worktree && fs.existsSync(c.worktree)) {
      const repoPath =
        c.repoPath ??
        tryGit(c.worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
          ?.trim()
          .replace(/\/\.git$/, "");
      try {
        if (!repoPath) throw new Error("unknown source repo");
        removeWorktree(repoPath, c.worktree, opts.force);
        out(`Removed worktree ${c.worktree}`);
        appendEvent(p, { actor: "cli", type: "worktree.removed", target: id, payload: { worktree: c.worktree } });
      } catch (err) {
        failures++;
        const msg = String((err as { stderr?: string | Buffer }).stderr ?? (err as Error).message).trim();
        warn(
          `Could not remove worktree for ${id}: ${msg}${opts.force ? "" : " (use --force to discard uncommitted changes)"}`,
        );
        continue;
      }
    }
    if (opts.branches && c.branch && c.repoPath) {
      try {
        // A merged member's commits live on its integration branch, which `-d` does not check.
        deleteBranch(c.repoPath, c.branch, opts.force || c.merged === true);
        out(`Deleted branch ${c.branch} in ${c.repoPath}`);
      } catch (err) {
        failures++;
        const msg = String((err as { stderr?: string | Buffer }).stderr ?? (err as Error).message).trim();
        warn(`Could not delete branch ${c.branch}: ${msg}`);
      }
    }
  }
  if (fs.existsSync(p.worktrees) && fs.readdirSync(p.worktrees).length === 0) fs.rmdirSync(p.worktrees);
  updateState(
    p,
    (st) => {
      for (const c of Object.values(st.children)) {
        if (c.worktree && !fs.existsSync(c.worktree)) delete c.worktree;
      }
    },
    "cli",
  );
  out(failures ? `Cleaned ${name} with ${failures} problem(s).` : `Cleaned ${name}.`);
  return failures ? 1 : 0;
}
