import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { actorFor, bareAgentName, candidateProjects, locatePath, roleFromAgentName, roleOf } from "../attribution.js";
import type { Host } from "../hosts.js";
import { findSlotEntry, readCoreIndex } from "../coreindex.js";
import { appendEvent } from "../events.js";
import { filePatch, snapshotWorktree, type FileKind } from "../git.js";
import { groupOf, isSetup, membersOf, scopeGlobs } from "../groups.js";
import { greenfieldContext } from "./greenfield-context.js";
import {
  dependenciesOf,
  PORT_STEP,
  readState,
  updateState,
  type ChildState,
  type ProjectState,
  type Role,
} from "../state.js";
import { findWorkspace, projectPaths, type ProjectPaths, type Workspace } from "../workspace.js";

export interface HookPayload {
  /** Host that fired the hook, set by the adapter. */
  host?: Host;
  sessionId?: string;
  timestamp?: number | string;
  cwd?: string;
  source?: string;
  reason?: string;
  toolName?: string;
  toolArgs?: unknown;
  agentId?: string;
  agentName?: string;
  agentDisplayName?: string;
  agentType?: string;
  response?: string;
  [k: string]: unknown;
}

export interface HookContext {
  ws: Workspace;
  /** Project from OPENFLEET_PROJECT, if the session was launched by the CLI. */
  project?: string;
}

export interface HookOutput {
  additionalContext?: string;
}

/** Hooks are a no-op unless the session is inside (or launched for) an OpenFleet workspace. */
export function resolveContext(payload: HookPayload, env: NodeJS.ProcessEnv = process.env): HookContext | undefined {
  const fromEnv = env.OPENFLEET_WORKSPACE ? findWorkspace(env.OPENFLEET_WORKSPACE) : undefined;
  const ws = fromEnv ?? (payload.cwd ? findWorkspace(payload.cwd) : undefined);
  if (!ws) return undefined;
  const project = env.OPENFLEET_PROJECT || undefined;
  if (project && !fs.existsSync(projectPaths(ws, project).state)) return { ws };
  return { ws, ...(project ? { project } : {}) };
}

function ts(payload: HookPayload): string {
  const t = payload.timestamp;
  if (typeof t === "number") return new Date(t).toISOString();
  if (typeof t === "string" && !Number.isNaN(Date.parse(t))) return new Date(t).toISOString();
  return new Date().toISOString();
}

/** Single active project: explicit, or the only non-finished project in the workspace. */
function activeProject(ctx: HookContext): ProjectPaths | undefined {
  if (ctx.project) return projectPaths(ctx.ws, ctx.project);
  const live = candidateProjects(ctx.ws).filter((p) => {
    try {
      const s = readState(p).status;
      return s !== "done" && s !== "cancelled";
    } catch {
      return false;
    }
  });
  return live.length === 1 ? live[0] : undefined;
}

// ---------------------------------------------------------------- session

export function onSessionStart(ctx: HookContext, payload: HookPayload): HookOutput {
  const p = ctx.project ? projectPaths(ctx.ws, ctx.project) : undefined;
  if (p) {
    appendEvent(p, {
      ts: ts(payload),
      actor: "coordinator",
      type: "session.started",
      payload: {
        sessionId: payload.sessionId ?? null,
        source: payload.source ?? null,
        host: payload.host ?? "copilot",
      },
    });
  }
  const index = readCoreIndex(ctx.ws);
  const lines = [
    `OpenFleet workspace root: ${ctx.ws.root}`,
    p ? `Active OpenFleet project: ${p.name} (${p.dir})` : "No OpenFleet project is active in this session.",
  ];
  if (index) {
    const host = payload.host ?? "copilot";
    const slots = Object.entries(index.slots)
      .map(([slot, list]) => [slot, list.filter((e) => !e.hosts || e.hosts.includes(host))] as const)
      .filter(([, list]) => list.length)
      .map(([slot, list]) => `${slot}: ${list.map((e) => e.agent).join(", ")}`);
    lines.push(`Phase extensions — ${slots.length ? slots.join("; ") : "none"}.`);
  }
  return { additionalContext: lines.join("\n") };
}

export function onSessionEnd(ctx: HookContext, payload: HookPayload): HookOutput {
  if (!ctx.project) return {};
  appendEvent(projectPaths(ctx.ws, ctx.project), {
    ts: ts(payload),
    actor: "coordinator",
    type: "session.ended",
    payload: { sessionId: payload.sessionId ?? null, reason: payload.reason ?? null },
  });
  return {};
}

// ---------------------------------------------------------------- subagents

/** Extension name for an `openfleet-ext-*` agent: phase agents via the core index, else the command agent. */
function extName(ctx: HookContext, agentName: string | undefined): string | undefined {
  const bare = bareAgentName(agentName);
  if (!bare?.startsWith("openfleet-ext-")) return undefined;
  const index = readCoreIndex(ctx.ws);
  if (index) {
    const entry = findSlotEntry(index, bare);
    if (entry) return entry.extension;
    const cmd = Object.values(index.commands).find((c) => bareAgentName(c.agent) === bare);
    if (cmd) return cmd.extension;
  }
  return bare.slice("openfleet-ext-".length);
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Outputs that extensions recorded on the children this child depends on, directly
 * or transitively. Injected deterministically so planners, implementers and testers
 * of dependents see them without relying on the coordinator to relay them.
 */
export function upstreamOutputs(state: ProjectState, childId: string): string {
  const rows: string[] = [];
  for (const dep of dependenciesOf(state, childId)) {
    for (const [ext, values] of Object.entries(state.children[dep]?.outputs ?? {})) {
      for (const [key, value] of Object.entries(values)) {
        rows.push(`| ${cell(dep)} | ${cell(ext)} | \`${cell(key)}\` | ${cell(value)} |`);
      }
    }
  }
  if (!rows.length) return "";
  return [
    "## Upstream outputs",
    "",
    "Values recorded by extensions on the children this child depends on (directly or transitively).",
    "Use them exactly as given (for example, pin a published version). Do not guess other values.",
    "",
    "| Child | Extension | Key | Value |",
    "| ----- | --------- | --- | ----- |",
    ...rows,
  ].join("\n");
}

/** The child claimed for `role`. `npx openfleet claim` allows one fresh claim per role, so this is unambiguous. */
function pickPending(state: ProjectState, role: Role): string | undefined {
  const ids = Object.entries(state.children)
    .filter(([, c]) => c.pendingSpawn === role)
    .sort(([, a], [, b]) => (a.claimedAt ?? "").localeCompare(b.claimedAt ?? ""))
    .map(([id]) => id);
  return ids[0];
}

/** Scope, escalation decisions, merge conflicts and the integration task for a child's agents. */
export function scopeContext(project: string, state: ProjectState, childId: string, role: Role): string {
  const child = state.children[childId]!;
  const parts: string[] = [];
  const globs = scopeGlobs(child);
  if (globs) {
    parts.push(
      [
        "## Scope",
        "",
        "This child owns only these paths (globs relative to the repo root). Change nothing else: shared config, components and utils belong to the repo's setup child.",
        ...globs.map((g) => `- \`${g}\``),
        child.baselineFiles?.length ? "Its baseline test files are allowed too." : "",
        role === "tester" || role === "implementer"
          ? `Check it (from the workspace root): \`npx openfleet scope ${project} ${childId} --check\` lists changed files outside the scope. Any outside file fails the tester.`
          : "",
        role === "planner"
          ? "List every shared item (config, component, util, dependency) this child needs under a **Shared items needed** heading in the plan. Do not plan to add shared items yourself."
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (isSetup(childId, child) && child.sharedItems?.length) {
    parts.push(
      [
        "## Shared items to provide",
        "",
        "Sibling children need these. Provide every one of them:",
        ...child.sharedItems.map((i) => `- ${i}`),
      ].join("\n"),
    );
  }
  if (child.decisions?.length) {
    parts.push(["## Coordinator decisions", "", ...child.decisions.map((d) => `- ${d}`)].join("\n"));
  }
  if (child.conflict && role === "implementer") {
    parts.push(
      [
        "## Merge conflict",
        "",
        `Your branch is being rebased onto the integration branch (\`${child.conflict.onto}\`) and stopped with conflicts in:`,
        ...child.conflict.files.map((f) => `- \`${f}\``),
        child.conflict.outside.length
          ? `These files are outside your scope; take the integration branch version unchanged (during a rebase that is \`git checkout --ours -- <file>\`): ${child.conflict.outside.map((f) => `\`${f}\``).join(", ")}.`
          : "",
        "Resolve each conflict so both your change and the integration branch's changes survive. Stage the files (`git add`), but do not run `git rebase --continue` or commit: the repo coordinator continues the rebase when it merges.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (child.integration && (role === "implementer" || role === "tester")) {
    parts.push(
      [
        "## Integration",
        "",
        `The worktree holds the repo's integration branch with every child merged: ${child.dependsOn.map((d) => `\`${d}\``).join(", ")}.`,
        role === "tester"
          ? "Run the repo's full build and full test suite. Report failures with the commands and output."
          : "The merged branch fails the full build or tests. Fix the integration problems with the smallest change, commit nothing.",
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

/** Context for a repo coordinator: its children, integration worktree and the commands it drives. */
export function repoContext(p: ProjectPaths, state: ProjectState, repo: string): string {
  const integration = state.children[repo]!;
  const rows = membersOf(state, repo).map((id) => {
    const c = state.children[id]!;
    return `| ${cell(id)} | ${c.phase} | ${cell((c.paths ?? []).join(", ") || "(whole package)")} | ${cell(c.dependsOn.join(", "))} | ${c.merged ? "yes" : "no"} |`;
  });
  return [
    `# OpenFleet assignment`,
    `- project: ${p.name}`,
    `- role: repo-coordinator for repo \`${repo}\``,
    integration.worktree
      ? `- integration worktree: ${integration.worktree}`
      : `- integration worktree: not created yet`,
    integration.branch ? `- integration branch: ${integration.branch}` : "",
    `- spec: ${p.spec}`,
    `- contracts: ${p.contracts}`,
    "",
    "| Child | Phase | Paths | Depends on | Merged |",
    "| ----- | ----- | ----- | ---------- | ------ |",
    ...rows,
    "",
    `Your actions: \`npx openfleet next ${p.name} --repo ${repo}\`. Never edit code yourself.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Port range, copied local files and protected baseline tests for agents that run code. */
export function runtimeContext(project: string, childId: string, child: ChildState, role: Role): string {
  const parts: string[] = [];
  if (role !== "planner" && child.portBase !== undefined) {
    const last = child.portBase + PORT_STEP - 1;
    parts.push(
      [
        "## Ports",
        "",
        `This child owns ports ${child.portBase}–${last}; other children run at the same time on other ports.`,
        `Prefix every command that starts a server or runs e2e tests with \`PORT=${child.portBase} OPENFLEET_PORT_BASE=${child.portBase}\`.`,
        `- \`PORT=${child.portBase}\`: the app's dev server. Use ${child.portBase + 1}–${last} for anything else it needs.`,
        `- \`OPENFLEET_PORT_BASE=${child.portBase}\`: first port of the range.`,
        "Read ports and auth callback URLs from the environment, never hard-code them. With Playwright, use `webServer` with this port and `reuseExistingServer: false`. Stop every server you start before you finish.",
      ].join("\n"),
    );
  }
  if (child.copiedFiles?.length) {
    parts.push(
      [
        "## Local files (never commit, never print)",
        "",
        "Copied from the repo's main checkout for builds and tests. Do not edit, stage, commit, print or quote them:",
        ...child.copiedFiles.map((f) => `- \`${f}\``),
      ].join("\n"),
    );
  }
  if (role === "baseline") {
    parts.push(
      [
        "## Baseline",
        "",
        `Cover: ${child.baselineCover ?? "the behaviour this child's spec section says will change"}`,
      ].join("\n"),
    );
  }
  if ((role === "implementer" || role === "tester") && child.baselineFiles?.length) {
    parts.push(
      [
        "## Baseline tests (protected)",
        "",
        "These tests passed against the unchanged code. Edit them only for behaviour changes that the spec explicitly lists for this child.",
        ...child.baselineFiles.map((f) => `- \`${f}\``),
        "",
        `Paths are relative to the worktree. List the ones that changed since the baseline passed (from the workspace root): \`npx openfleet baseline ${project} ${childId} --check\``,
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

/** Optional for agents with a shell: re-prints the assignment and binds the agent id if the hook could not. */
function ackLine(project: string, childId: string, role: Role): string {
  return `- to re-print this assignment (from the workspace root): \`npx openfleet ack ${project} ${childId} ${role}\``;
}

/** The role a recorded agent id holds on this child, if any. */
function roleByAgentId(child: ChildState, agentId: string | undefined): Role | undefined {
  if (!agentId) return undefined;
  return (Object.entries(child.agentIds) as [Role, string | undefined][]).find(([, id]) => id === agentId)?.[0];
}

export function childContext(p: ProjectPaths, state: ProjectState, childId: string, role: Role): string {
  const child = state.children[childId]!;
  const upstream = upstreamOutputs(state, childId);
  const runtime = runtimeContext(p.name, childId, child, role);
  const scope = scopeContext(p.name, state, childId, role);
  const greenfield = greenfieldContext(state, childId, role);
  const group = groupOf(state, childId);
  return [
    `# OpenFleet assignment`,
    `- project: ${p.name}`,
    `- child: ${childId} (repo \`${child.repo}\`${child.package ? `, package \`${child.package}\`` : ""})`,
    `- role: ${role}`,
    child.worktree ? `- worktree (work ONLY here): ${child.worktree}` : `- worktree: not created yet`,
    child.branch ? `- branch: ${child.branch}` : "",
    `- spec: ${p.spec}`,
    `- contracts: ${p.contracts}`,
    child.plan ? `- approved plan: ${child.plan}` : "",
    group ? `- repo coordinator: ${group} (it answers your questions and merges your branch)` : "",
    role !== "planner" ? ackLine(p.name, childId, role) : "",
    scope ? `\n${scope}` : "",
    greenfield ? `\n${greenfield}` : "",
    upstream ? `\n${upstream}` : "",
    runtime ? `\n${runtime}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function onSubagentStart(ctx: HookContext, payload: HookPayload): HookOutput {
  const role = roleFromAgentName(payload.agentName);
  const ext = extName(ctx, payload.agentName);
  if (!role && !ext) return {};
  const p = activeProject(ctx);
  if (!p) return {};
  if (ext) {
    appendEvent(p, {
      ts: ts(payload),
      actor: `ext:${ext}`,
      type: "agent.spawned",
      payload: { agentName: payload.agentName ?? null },
    });
    return {};
  }
  if (role === "coordinator") return {};
  let childId: string | undefined;
  const state = updateState(p, (s) => {
    childId = pickPending(s, role!);
    if (!childId) return;
    const child = s.children[childId]!;
    delete child.pendingSpawn;
    delete child.claimedAt;
    if (payload.agentId) child.agentIds[role as Role] = payload.agentId;
    if (role === "repo-coordinator") child.coordinator = "running";
    else child.role = role;
  });
  appendEvent(p, {
    ts: ts(payload),
    actor: actorFor(childId ?? "unknown", role),
    type: "agent.spawned",
    target: childId ?? null,
    payload: {
      agentId: payload.agentId ?? null,
      agentName: payload.agentName ?? null,
      agentDisplayName: payload.agentDisplayName ?? null,
    },
  });
  if (!childId) return {};
  if (role === "repo-coordinator") {
    return {
      additionalContext: `${repoContext(p, state, childId)}\n${ackLine(p.name, childId, role)}`,
    };
  }
  return { additionalContext: childContext(p, state, childId, role as Role) };
}

function snapshotChild(p: ProjectPaths, childId: string, child: ChildState, actor: string, at: string): void {
  if (!child.worktree || !fs.existsSync(child.worktree)) return;
  let snap;
  try {
    snap = snapshotWorktree(child.worktree, child.baseSha ?? "HEAD", child.copiedFiles ?? []);
  } catch {
    return;
  }
  const hash = crypto.createHash("sha256").update(snap.patch).digest("hex");
  if (hash === child.lastSnapshot) return;
  appendEvent(p, {
    ts: at,
    actor,
    type: "worktree.snapshot",
    target: childId,
    payload: {
      worktree: child.worktree,
      base: child.baseSha ?? "HEAD",
      files: snap.files,
      totals: {
        files: snap.files.length,
        added: snap.files.reduce((n, f) => n + f.added, 0),
        removed: snap.files.reduce((n, f) => n + f.removed, 0),
      },
    },
    patch: snap.patch,
  });
  updateState(p, (s) => {
    const c = s.children[childId];
    if (c) c.lastSnapshot = hash;
  });
}

export function onSubagentStop(ctx: HookContext, payload: HookPayload): HookOutput {
  const role = roleFromAgentName(payload.agentName);
  const ext = extName(ctx, payload.agentName);
  if (!role && !ext) return {};
  const p = activeProject(ctx);
  if (!p) return {};
  const at = ts(payload);
  if (ext) {
    appendEvent(p, {
      ts: at,
      actor: `ext:${ext}`,
      type: "agent.stopped",
      payload: {
        agentId: payload.agentId ?? null,
        agentName: payload.agentName ?? null,
        response: payload.response ?? "",
      },
    });
    return {};
  }
  if (role === "coordinator") return {};
  const state = readState(p);
  const entries = Object.entries(state.children);
  let match = entries.find(([, c]) => payload.agentId && c.agentIds[role as Role] === payload.agentId);
  if (!match) {
    const byRole =
      role === "repo-coordinator"
        ? entries.filter(([, c]) => c.coordinator === "running")
        : entries.filter(([, c]) => roleOf(c) === role && c.phase !== "done");
    if (byRole.length === 1) match = byRole[0];
  }
  const childId = match?.[0];
  const actor = actorFor(childId ?? "unknown", role);
  appendEvent(p, {
    ts: at,
    actor,
    type: "agent.stopped",
    target: childId ?? null,
    payload: {
      agentId: payload.agentId ?? null,
      agentName: payload.agentName ?? null,
      response: payload.response ?? "",
    },
  });
  if (childId && payload.agentId && !match![1].agentIds[role as Role]) {
    updateState(p, (s) => {
      const c = s.children[childId];
      if (c) c.agentIds[role as Role] = payload.agentId!;
    });
  }
  if (role === "repo-coordinator") {
    if (childId) {
      updateState(p, (s) => {
        const c = s.children[childId];
        if (c) c.coordinator = "stopped";
      });
    }
    return {};
  }
  // Ground truth: diff snapshot of the attributed worktree, or every worktree when unattributed.
  const targets = childId ? [[childId, match![1]] as const] : entries;
  for (const [id, child] of targets) snapshotChild(p, id, child, childId ? actor : actorFor(id, roleOf(child)), at);
  return {};
}

// ---------------------------------------------------------------- tools

interface ToolFileChange {
  path: string;
  kind: FileKind;
  added: number;
  removed: number;
}

function countLines(s: unknown): number {
  if (typeof s !== "string" || s.length === 0) return 0;
  return s.split("\n").length - (s.endsWith("\n") ? 1 : 0);
}

function parseArgs(args: unknown): unknown {
  if (typeof args === "string") {
    const t = args.trim();
    if (t.startsWith("{")) {
      try {
        return JSON.parse(t);
      } catch {
        return args;
      }
    }
  }
  return args;
}

function parseApplyPatch(text: string): ToolFileChange[] {
  const out: ToolFileChange[] = [];
  let cur: ToolFileChange | undefined;
  for (const line of text.split("\n")) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) {
      cur = {
        path: m[2]!.trim(),
        kind: m[1] === "Add" ? "added" : m[1] === "Delete" ? "deleted" : "edited",
        added: 0,
        removed: 0,
      };
      out.push(cur);
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && cur) {
      out.push({ path: cur.path, kind: "deleted", added: 0, removed: 0 });
      cur.path = move[1]!.trim();
      cur.kind = "added";
      continue;
    }
    if (!cur || line.startsWith("***")) continue;
    if (line.startsWith("+")) cur.added++;
    else if (line.startsWith("-")) cur.removed++;
  }
  return out;
}

/** Extract file changes from a postToolUse payload. Only file-mutating tools are recognised. */
export function fileChangesFromTool(toolName: string | undefined, rawArgs: unknown): ToolFileChange[] {
  const name = (toolName ?? "").toLowerCase();
  const args = parseArgs(rawArgs);
  const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const file = (a.path ?? a.file_path ?? a.filePath) as string | undefined;
  switch (name) {
    case "create":
    case "write":
      return file ? [{ path: file, kind: "added", added: countLines(a.file_text ?? a.content), removed: 0 }] : [];
    case "edit":
    case "str_replace":
    case "str_replace_editor":
    case "multiedit":
    case "multi_edit": {
      if (!file) return [];
      if (a.command === "create") return [{ path: file, kind: "added", added: countLines(a.file_text), removed: 0 }];
      const edits = Array.isArray(a.edits) ? (a.edits as Record<string, unknown>[]) : [a];
      let added = 0;
      let removed = 0;
      for (const e of edits) {
        added += countLines(e.new_str ?? e.new_string ?? e.newString);
        removed += countLines(e.old_str ?? e.old_string ?? e.oldString);
      }
      return [{ path: file, kind: "edited", added, removed }];
    }
    case "apply_patch": {
      const text = typeof args === "string" ? args : (a.input ?? a.patch);
      return typeof text === "string" ? parseApplyPatch(text) : [];
    }
    default:
      return [];
  }
}

const ACK = /openfleet\s+ack\s+(\S+)\s+(\S+)\s+(\S+)/;

/** Command text of a shell tool call, if any. */
function shellCommand(toolName: string | undefined, rawArgs: unknown): string | undefined {
  if (!toolName || !/^(bash|shell|powershell|run_in_terminal)$/i.test(toolName)) return undefined;
  const args = parseArgs(rawArgs);
  if (typeof args === "string") return args;
  if (args && typeof args === "object") {
    const cmd = (args as Record<string, unknown>).command;
    if (typeof cmd === "string") return cmd;
  }
  return undefined;
}

/**
 * Fallback binding: subagentStart records the id when it consumes the claim. If the
 * runtime sent no id then, `npx openfleet ack` binds it from a later tool call.
 */
function bindAck(ctx: HookContext, payload: HookPayload): void {
  if (!payload.agentId) return;
  const m = ACK.exec(shellCommand(payload.toolName, payload.toolArgs) ?? "");
  if (!m) return;
  const [, project, childId, role] = m as unknown as [string, string, string, string];
  if (ctx.project && ctx.project !== project) return;
  const p = projectPaths(ctx.ws, project);
  if (!fs.existsSync(p.state)) return;
  updateState(p, (s) => {
    const c = s.children[childId];
    if (c) c.agentIds[role as Role] = payload.agentId!;
  });
}

export function onPostToolUse(ctx: HookContext, payload: HookPayload): HookOutput {
  try {
    bindAck(ctx, payload);
  } catch {
    // Attribution falls back to role matching.
  }
  const changes = fileChangesFromTool(payload.toolName, payload.toolArgs);
  if (!changes.length) return {};
  const cwd = payload.cwd ?? ctx.ws.root;
  for (const change of changes) {
    const abs = path.resolve(cwd, change.path);
    const loc = locatePath(ctx.ws, abs, ctx.project);
    if (!loc) continue;
    const role = roleByAgentId(loc.child, payload.agentId) ?? roleOf(loc.child);
    const rel = loc.rel.split(path.sep).join("/");
    const copied = loc.child.copiedFiles?.includes(rel) === true;
    let patch = "";
    if (change.kind !== "deleted" && !copied) {
      try {
        patch = filePatch(loc.child.worktree!, loc.rel);
      } catch {
        patch = "";
      }
    }
    appendEvent(loc.project, {
      ts: ts(payload),
      actor: actorFor(loc.childId, role),
      type: `file.${change.kind}`,
      target: loc.childId,
      payload: {
        path: rel,
        kind: change.kind,
        ...(copied ? { copiedFile: true } : {}),
        lines: { added: change.added, removed: change.removed },
        tool: payload.toolName ?? null,
      },
      patch,
    });
  }
  return {};
}

export const HANDLERS: Record<string, (ctx: HookContext, payload: HookPayload) => HookOutput> = {
  sessionStart: onSessionStart,
  sessionEnd: onSessionEnd,
  subagentStart: onSubagentStart,
  subagentStop: onSubagentStop,
  postToolUse: onPostToolUse,
};

export function runHook(event: string, payload: HookPayload, env: NodeJS.ProcessEnv = process.env): HookOutput {
  const handler = HANDLERS[event];
  if (!handler) return {};
  const ctx = resolveContext(payload, env);
  if (!ctx) return {};
  return handler(ctx, payload);
}
