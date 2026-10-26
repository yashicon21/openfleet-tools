// `npx openfleet next | gate | baseline`: helpers for the plan-first run loop.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkCopyPath } from "../copyfiles.js";
import { appendEvent } from "../events.js";
import { groupOf } from "../groups.js";
import { formatFailure, preflight } from "../preflight.js";
import { scheduleFor, TOP } from "../schedule.js";
import { activeChildren, readState, updateState, type ProjectState } from "../state.js";
import { projectPaths, requireWorkspace, UserError, validateProjectName } from "../workspace.js";
import { out } from "./output.js";

/** `npx openfleet preflight <project>`: JSON report on stdout; on failure the hint on stderr and exit 1. */
export function cmdPreflight(args: string[]): number {
  const ws = requireWorkspace();
  const report = preflight(ws, validateProjectName(args[0]));
  out(JSON.stringify(report, null, 2));
  if (report.ok) return 0;
  process.stderr.write(formatFailure(report) + "\n");
  return 1;
}

export const NEXT_USAGE = `Usage:
  openfleet next <project>               actions for the top coordinator (+ "delegated" repo actions)
  openfleet next <project> --repo <repo> actions for that repo's coordinator`;

export const GATE_USAGE = `Usage:
  openfleet gate <project> consistent [--child <id>[,<id>…]]               top-level check (all repos)
  openfleet gate <project> consistent --repo <repo> [--child <id>[,<id>…]] repo coordinator's sibling check
  openfleet gate <project> open`;

export const BASELINE_USAGE = `Usage:
  openfleet baseline <project> <child> --report <json>
  openfleet baseline <project> <child> --check`;

function fileHash(file: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/** Baseline files whose content changed (or that were deleted) since the baseline passed. */
export function baselineChanges(worktree: string, hashes: Record<string, string>): string[] {
  return Object.entries(hashes)
    .filter(([rel, hash]) => fileHash(path.join(worktree, rel)) !== hash)
    .map(([rel]) => rel);
}

function print(state: ProjectState, owner: string = TOP): void {
  out(JSON.stringify(scheduleFor(state, owner), null, 2));
}

export function cmdNext(args: string[], flags: { repo?: string } = {}): number {
  const ws = requireWorkspace();
  const state = readState(projectPaths(ws, validateProjectName(args[0])));
  if (flags.repo !== undefined && !state.children[flags.repo]?.integration) {
    throw new UserError(`Repo "${flags.repo}" has no repo coordinator (it needs two or more children).`);
  }
  print(state, flags.repo ?? TOP);
  return 0;
}

function cmdRepoConsistent(p: ReturnType<typeof projectPaths>, repo: string, flags: { child?: string }): number {
  let checked: string[] = [];
  const next = updateState(p, (s) => {
    if (!s.children[repo]?.integration) throw new UserError(`Repo "${repo}" has no repo coordinator.`);
    const members = activeChildren(s).filter(([id]) => groupOf(s, id) === repo);
    const waiting = members.filter(([, c]) => ["pending", "planning", "plan-review"].includes(c.phase));
    if (!s.plansReady && waiting.length) {
      throw new UserError(
        `Not every plan in ${repo} is validated yet: ${waiting.map(([id, c]) => `${id} (${c.phase})`).join(", ")}.`,
      );
    }
    checked = flags.child
      ? flags.child.split(",").map((id) => id.trim())
      : members.filter(([, c]) => c.phase === "planned" && !c.repoConsistent).map(([id]) => id);
    if (!checked.length) throw new UserError(`No validated plans in ${repo} are waiting for the repo check.`);
    for (const id of checked) {
      const c = s.children[id];
      if (!c || groupOf(s, id) !== repo) throw new UserError(`Child "${id}" is not part of repo ${repo}.`);
      if (c.phase !== "planned") throw new UserError(`Child ${id} is "${c.phase}", not "planned".`);
      c.repoConsistent = true;
    }
  });
  appendEvent(p, {
    actor: `${repo}/repo-coordinator`,
    type: "plans.consistent",
    payload: {
      repo,
      children: checked,
      plans: Object.fromEntries(checked.map((id) => [id, next.children[id]!.plan ?? null])),
      gateOpen: next.plansReady === true,
    },
  });
  print(next, repo);
  return 0;
}

export function cmdGate(args: string[], flags: { child?: string; repo?: string }): number {
  const ws = requireWorkspace();
  const p = projectPaths(ws, validateProjectName(args[0]));
  const sub = args[1];
  if (sub === "consistent" && flags.repo !== undefined) return cmdRepoConsistent(p, flags.repo, flags);
  if (sub === "consistent") {
    let checked: string[] = [];
    const next = updateState(p, (s) => {
      const active = activeChildren(s).filter(([, c]) => !c.integration);
      if (!s.plansReady) {
        const waiting = active.filter(([, c]) => ["pending", "planning", "plan-review"].includes(c.phase));
        if (waiting.length) {
          throw new UserError(
            `Not every plan is validated yet: ${waiting.map(([id, c]) => `${id} (${c.phase})`).join(", ")}.`,
          );
        }
      }
      checked = flags.child
        ? flags.child.split(",").map((id) => id.trim())
        : active
            .filter(([id, c]) => c.phase === "planned" && !c.consistent && (!groupOf(s, id) || c.repoConsistent))
            .map(([id]) => id);
      if (!checked.length) throw new UserError("No validated plans are waiting for a consistency check.");
      for (const id of checked) {
        const c = s.children[id];
        if (!c) throw new UserError(`Unknown child "${id}".`);
        if (c.phase !== "planned") throw new UserError(`Child ${id} is "${c.phase}", not "planned".`);
        if (groupOf(s, id) && !c.repoConsistent) {
          throw new UserError(
            `Child ${id} has not passed its repo coordinator's check (gate consistent --repo ${c.repo}).`,
          );
        }
        c.consistent = true;
      }
    });
    appendEvent(p, {
      actor: "coordinator",
      type: "plans.consistent",
      payload: {
        children: checked,
        plans: Object.fromEntries(checked.map((id) => [id, next.children[id]!.plan ?? null])),
        gateOpen: next.plansReady === true,
      },
    });
    print(next);
    return 0;
  }
  if (sub === "open") {
    const next = updateState(p, (s) => {
      const active = activeChildren(s).filter(([, c]) => !c.integration);
      if (!active.length) throw new UserError("No active children: the gate cannot open.");
      const notReady = active.filter(([, c]) => c.phase !== "done" && !(c.phase === "planned" && c.consistent));
      if (notReady.length) {
        throw new UserError(
          `These plans have not passed the consistency check: ${notReady.map(([id, c]) => `${id} (${c.phase})`).join(", ")}.`,
        );
      }
      s.plansReady = true;
    });
    print(next);
    return 0;
  }
  throw new UserError(GATE_USAGE);
}

export function cmdBaseline(args: string[], flags: { report?: string; check?: boolean }): number {
  const ws = requireWorkspace();
  const p = projectPaths(ws, validateProjectName(args[0]));
  const childId = args[1];
  if (childId && flags.check) {
    const c = readState(p).children[childId];
    if (!c) throw new UserError(`Unknown child "${childId}".`);
    if (!c.baselinePassed || !c.worktree) throw new UserError(`Child ${childId} has no passed baseline.`);
    const hashes = c.baselineHashes ?? {};
    const changed = baselineChanges(c.worktree, hashes);
    out(
      JSON.stringify({ child: childId, changed, unchanged: Object.keys(hashes).filter((f) => !changed.includes(f)) }),
    );
    return 0;
  }
  if (!childId || flags.report === undefined) throw new UserError(BASELINE_USAGE);
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(flags.report) as Record<string, unknown>;
  } catch (err) {
    throw new UserError(`Invalid JSON for --report: ${(err as Error).message}`);
  }
  if (typeof r !== "object" || r === null || Array.isArray(r)) throw new UserError("--report must be a JSON object");
  if ((r.status ?? "done") !== "done") {
    throw new UserError(`Only a passing baseline is recorded. Handle a failed baseline with the normal retries.`);
  }
  if (!Array.isArray(r.files) || !r.files.length)
    throw new UserError(`report "files" must list the baseline test files`);
  const files = r.files.map((f) => {
    const checked = checkCopyPath(f);
    if ("error" in checked) throw new UserError(`report "files": "${String(f)}" ${checked.error}`);
    return checked.rel;
  });
  for (const k of ["command", "summary", "results"] as const) {
    if (r[k] !== undefined && typeof r[k] !== "string") throw new UserError(`report "${k}" must be a string`);
  }
  const next = updateState(p, (s) => {
    const c = s.children[childId];
    if (!c) throw new UserError(`Unknown child "${childId}".`);
    if (!c.baseline) throw new UserError(`Child ${childId} has no baseline phase (set "baseline": true).`);
    if (!c.worktree) throw new UserError(`Child ${childId} has no worktree.`);
    const hashes: Record<string, string> = {};
    for (const f of files) {
      const h = fileHash(path.join(c.worktree, f));
      if (!h) throw new UserError(`Baseline file ${f} does not exist in ${c.worktree}.`);
      hashes[f] = h;
    }
    c.baselineFiles = files;
    c.baselineHashes = hashes;
    c.baselinePassed = true;
    if (c.phase === "baseline") c.phase = "planned";
  });
  appendEvent(p, {
    actor: `${childId}/baseline`,
    type: "baseline.passed",
    target: childId,
    payload: {
      files,
      command: r.command ?? null,
      results: r.results ?? null,
      summary: r.summary ?? "",
    },
  });
  out(JSON.stringify(next.children[childId], null, 2));
  return 0;
}
