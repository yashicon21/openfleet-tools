// `npx openfleet ext …`: helpers the coordinator uses to run extension phase slots deterministically.
import fs from "node:fs";
import path from "node:path";
import { readCoreIndex, type SlotEntry } from "../coreindex.js";
import { appendEvent } from "../events.js";
import { syncExtensions } from "../core.js";
import { DEFAULT_HOST } from "../hosts.js";
import {
  forHost,
  loadExtensions,
  readExtensionsConfig,
  resolveSettings,
  SETTINGS_FILE,
  SLOTS,
  type Slot,
} from "../extensions.js";
import { writeJson } from "../fsutil.js";
import { withLock } from "../lock.js";
import { readRepos } from "../repos.js";
import { activeChildren, dependentsOf, readState, updateState, type ChildState, type ProjectState } from "../state.js";
import { projectPaths, requireWorkspace, UserError, validateProjectName, type Workspace } from "../workspace.js";
import { out, warn } from "./output.js";

export const EXT_USAGE = `Usage:
  openfleet ext plan <project> <slot> [--child <id>]
  openfleet ext result <project> <extension> --slot <slot> [--child <id>] --report <json>
  openfleet ext fail <project> <extension> --slot <slot> [--child <id>] --reason <text>
  openfleet ext settings [--unset]
  openfleet ext settings set <extension> <key> <value>`;

export interface ExtFlags {
  child?: string;
  slot?: string;
  report?: string;
  reason?: string;
  unset?: boolean;
}

function slotOf(raw: string | undefined): Slot {
  if (!SLOTS.includes(raw as Slot)) throw new UserError(`Slot must be one of ${SLOTS.join(", ")}.\n${EXT_USAGE}`);
  return raw as Slot;
}

function childOf(state: ProjectState, id: string | undefined): ChildState | undefined {
  if (id === undefined) return undefined;
  const child = state.children[id];
  if (!child) throw new UserError(`Unknown child "${id}".`);
  return child;
}

function childDirs(child: ChildState): string[] {
  const root = child.worktree ?? child.repoPath;
  if (!root) return [];
  return [...new Set([child.package ? path.join(root, child.package) : root, root])];
}

/**
 * Directories `when.files` is checked in. A child slot checks the child's package
 * directory and its repo root. A project slot checks every child; before any child
 * exists, it checks the local checkouts in repos.json.
 */
export function whenDirs(ws: Workspace, state: ProjectState, child: ChildState | undefined): string[] {
  if (child) return childDirs(child);
  const dirs = Object.values(state.children).flatMap(childDirs);
  if (dirs.length) return [...new Set(dirs)];
  return Object.values(readRepos(ws).repos)
    .filter((r) => r.path)
    .map((r) => path.resolve(ws.root, r.path!));
}

export function whenMatches(entry: SlotEntry, dirs: string[]): boolean {
  if (!entry.when) return true;
  return entry.when.files.some((f) => dirs.some((d) => fs.existsSync(path.join(d, f))));
}

function cmdPlan(ws: Workspace, args: string[], flags: ExtFlags): number {
  const name = validateProjectName(args[0]);
  const slot = slotOf(args[1]);
  const p = projectPaths(ws, name);
  const state = readState(p);
  const child = childOf(state, flags.child);
  const entries = readCoreIndex(ws)?.slots[slot] ?? [];
  const dirs = whenDirs(ws, state, child);
  const host = state.host ?? DEFAULT_HOST;
  const run: SlotEntry[] = [];
  const skipped: (SlotEntry & { reason: string })[] = [];
  for (const entry of entries) {
    const hostOk = forHost(entry, host);
    if (hostOk && whenMatches(entry, dirs)) {
      run.push(entry);
      continue;
    }
    const reason = hostOk
      ? `none of ${entry.when!.files.join(", ")} exist`
      : `not available on host ${host} (hosts: ${entry.hosts!.join(", ")})`;
    if (!hostOk) warn(`Skipping ${entry.agent} in ${slot}: ${reason}.`);
    skipped.push({ ...entry, reason });
    appendEvent(p, {
      actor: "coordinator",
      type: "extension.skipped",
      target: flags.child ?? null,
      payload: { extension: entry.extension, agent: entry.agent, slot, reason, checked: dirs },
    });
  }
  out(JSON.stringify({ slot, child: flags.child ?? null, run, skipped }, null, 2));
  return 0;
}

interface Report {
  status: "done" | "failed";
  summary: string;
  outputs?: Record<string, string>;
  followUps?: string[];
}

export function parseReport(raw: string | undefined): Report {
  if (raw === undefined) throw new UserError(`--report is required.\n${EXT_USAGE}`);
  let r: unknown;
  try {
    r = JSON.parse(raw);
  } catch (err) {
    throw new UserError(`Invalid JSON for --report: ${(err as Error).message}`);
  }
  if (typeof r !== "object" || r === null || Array.isArray(r)) throw new UserError("--report must be a JSON object");
  const o = r as Record<string, unknown>;
  const status = o.status ?? "done";
  if (status !== "done" && status !== "failed") throw new UserError(`report "status" must be "done" or "failed"`);
  if (o.summary !== undefined && typeof o.summary !== "string")
    throw new UserError(`report "summary" must be a string`);
  if (o.outputs !== undefined) {
    const outputs = o.outputs;
    if (typeof outputs !== "object" || outputs === null || Array.isArray(outputs)) {
      throw new UserError(`report "outputs" must be an object of key -> string`);
    }
    for (const [k, v] of Object.entries(outputs)) {
      if (!k || typeof v !== "string") throw new UserError(`report "outputs.${k}" must be a string (flat values only)`);
    }
  }
  if (o.followUps !== undefined && (!Array.isArray(o.followUps) || !o.followUps.every((f) => typeof f === "string"))) {
    throw new UserError(`report "followUps" must be an array of strings`);
  }
  return {
    status,
    summary: o.summary ?? "",
    ...(o.outputs !== undefined ? { outputs: o.outputs as Record<string, string> } : {}),
    ...(o.followUps !== undefined ? { followUps: o.followUps } : {}),
  };
}

function cmdResult(ws: Workspace, args: string[], flags: ExtFlags): number {
  const name = validateProjectName(args[0]);
  const ext = args[1];
  if (!ext) throw new UserError(EXT_USAGE);
  const slot = slotOf(flags.slot);
  const p = projectPaths(ws, name);
  const childId = flags.child;
  childOf(readState(p), childId);
  const report = parseReport(flags.report);
  const outputs = report.outputs ?? {};
  const followUps = report.followUps ?? [];
  if (Object.keys(outputs).length && !childId) throw new UserError("Outputs need --child: they belong to a child.");
  appendEvent(p, {
    actor: "coordinator",
    type: "extension.ran",
    target: childId ?? null,
    payload: { extension: ext, slot, status: report.status, summary: report.summary },
  });
  if (Object.keys(outputs).length || followUps.length) {
    updateState(p, (s) => {
      const merge = (prev: string[] | undefined) => [...new Set([...(prev ?? []), ...followUps])];
      if (!childId) {
        if (followUps.length) s.followUps = { ...s.followUps, [ext]: merge(s.followUps?.[ext]) };
        return;
      }
      const c = s.children[childId]!;
      if (Object.keys(outputs).length) c.outputs = { ...c.outputs, [ext]: { ...c.outputs?.[ext], ...outputs } };
      if (followUps.length) c.followUps = { ...c.followUps, [ext]: merge(c.followUps?.[ext]) };
      if (outputs.prUrl) c.prUrl = outputs.prUrl;
    });
    appendEvent(p, {
      actor: "coordinator",
      type: "extension.outputs",
      target: childId ?? null,
      payload: { extension: ext, slot, outputs, followUps },
    });
  }
  const state = readState(p);
  out(JSON.stringify(childId ? state.children[childId] : { followUps: state.followUps ?? {} }, null, 2));
  return 0;
}

function cmdFail(ws: Workspace, args: string[], flags: ExtFlags): number {
  const name = validateProjectName(args[0]);
  const ext = args[1];
  if (!ext) throw new UserError(EXT_USAGE);
  const slot = slotOf(flags.slot);
  if (!flags.reason) throw new UserError(`--reason is required.\n${EXT_USAGE}`);
  const reason = flags.reason;
  const p = projectPaths(ws, name);
  const childId = flags.child;
  childOf(readState(p), childId);
  let blocked: string[] = [];
  let child: ChildState | undefined;
  if (childId) {
    const next = updateState(p, (s) => {
      const c = s.children[childId]!;
      c.phase = "failed";
      c.notes = `extension ${ext} (${slot}) failed: ${reason}`;
      blocked = dependentsOf(s, childId).filter((id) => s.children[id]!.phase !== "done");
      for (const id of blocked) {
        s.children[id]!.phase = "blocked";
        s.children[id]!.notes = `dependency ${childId} failed`;
      }
    });
    child = next.children[childId];
  } else if (slot === "plans-ready") {
    // The gate cannot open: nothing is implemented. Every active child waits for `resume`.
    updateState(p, (s) => {
      blocked = activeChildren(s)
        .filter(([, c]) => c.phase !== "done")
        .map(([id]) => id);
      for (const id of blocked) {
        s.children[id]!.phase = "blocked";
        s.children[id]!.notes = `plans-ready extension ${ext} failed`;
      }
    });
  }
  appendEvent(p, {
    actor: "coordinator",
    type: "extension.failed",
    target: childId ?? null,
    payload: { extension: ext, slot, reason, attempts: 2, blocked },
  });
  if (childId) {
    appendEvent(p, {
      actor: "coordinator",
      type: "child.failed",
      target: childId,
      payload: {
        reason: `extension ${ext} (${slot}) failed: ${reason}`,
        retries: child?.retries ?? 0,
        findings: [reason],
        worktree: child?.worktree ?? null,
        blocked,
      },
    });
  }
  out(JSON.stringify({ failed: childId ?? null, blocked }, null, 2));
  return 0;
}

export interface SettingInfo {
  extension: string;
  key: string;
  default: string;
  description: string;
  /** The workspace override, if any. */
  value?: string;
  set: boolean;
}

/** Every setting declared by an enabled extension, with its workspace override (if any). */
export function listSettings(ws: Workspace): SettingInfo[] {
  const config = readExtensionsConfig(ws);
  const rows: SettingInfo[] = [];
  for (const { manifest: m } of loadExtensions(ws, warn)) {
    resolveSettings(m, config);
    for (const [key, decl] of Object.entries(m.settings ?? {})) {
      const value = config[m.name]?.[key];
      rows.push({
        extension: m.name,
        key,
        default: decl.default,
        description: decl.description ?? "",
        ...(value !== undefined ? { value } : {}),
        set: value !== undefined,
      });
    }
  }
  return rows;
}

/** Write one workspace-level override to extensions.config.json, validated like core does. */
export function setSetting(ws: Workspace, ext: string, key: string, value: string): void {
  const m = loadExtensions(ws, warn).find((e) => e.manifest.name === ext)?.manifest;
  if (!m) throw new UserError(`Extension "${ext}" is not installed (or is disabled).`);
  withLock(path.join(ws.root, `${SETTINGS_FILE}.lock`), () => {
    const config = readExtensionsConfig(ws);
    const next = { ...config, [ext]: { ...config[ext], [key]: value } };
    resolveSettings(m, next);
    writeJson(path.join(ws.root, SETTINGS_FILE), next);
  });
  // Generated agents embed the resolved settings.
  syncExtensions(ws, warn);
}

function cmdSettings(ws: Workspace, rest: string[], flags: ExtFlags): number {
  if (rest[0] === "set") {
    const [, ext, key, value] = rest;
    if (!ext || !key || value === undefined || rest.length > 4) throw new UserError(EXT_USAGE);
    setSetting(ws, ext, key, value);
    out(JSON.stringify({ extension: ext, key, value }, null, 2));
    return 0;
  }
  if (rest.length) throw new UserError(EXT_USAGE);
  const rows = listSettings(ws);
  out(JSON.stringify(flags.unset ? rows.filter((r) => !r.set) : rows, null, 2));
  return 0;
}

export function cmdExt(args: string[], flags: ExtFlags): number {
  const ws = requireWorkspace();
  const [sub, ...rest] = args;
  switch (sub) {
    case "plan":
      return cmdPlan(ws, rest, flags);
    case "result":
      return cmdResult(ws, rest, flags);
    case "fail":
      return cmdFail(ws, rest, flags);
    case "settings":
      return cmdSettings(ws, rest, flags);
    default:
      throw new UserError(EXT_USAGE);
  }
}
