// Commands for coordinators of repos with several children:
// `claim`, `ack`, `scope --check`, `merge` and `escalate`.
import fs from "node:fs";
import path from "node:path";
import { claim } from "../claim.js";
import { appendEvent } from "../events.js";
import { git, headSha, snapshotWorktree, tryGit } from "../git.js";
import { groupOf, isSetup, membersOf, outOfScope, scopeGlobs } from "../groups.js";
import { childContext, repoContext } from "../hooks/handlers.js";
import { readState, updateState, type ChildPhase, type ChildState, type Role } from "../state.js";
import { projectPaths, requireWorkspace, UserError, validateProjectName } from "../workspace.js";
import { out } from "./output.js";

export const CLAIM_USAGE = `Usage: openfleet claim <project> <child> <role>
  role: planner | baseline | implementer | tester | repo-coordinator
Prints {"result":"claimed",…} (spawn the agent now) or {"result":"wait",…} (retry after retryAfterSeconds).`;
export const ACK_USAGE = "Usage: openfleet ack <project> <child> <role>";
export const SCOPE_USAGE = "Usage: openfleet scope <project> <child> --check";
export const MERGE_USAGE = "Usage: openfleet merge <project> <child>";
export const ESCALATE_USAGE = `Usage:
  openfleet escalate <project> <child> --question <text>
  openfleet escalate <project> <child> --resolve --decision <text>`;

export function cmdClaim(args: string[]): number {
  const ws = requireWorkspace();
  const project = validateProjectName(args[0]);
  if (!args[1] || !args[2]) throw new UserError(CLAIM_USAGE);
  out(JSON.stringify(claim(ws, project, args[1], args[2]), null, 2));
  return 0;
}

/** First command every OpenFleet subagent runs: prints its assignment and lets the hook bind its agent id. */
export function cmdAck(args: string[]): number {
  const ws = requireWorkspace();
  const p = projectPaths(ws, validateProjectName(args[0]));
  const [, childId, role] = args;
  if (!childId || !role) throw new UserError(ACK_USAGE);
  const state = readState(p);
  if (!state.children[childId]) throw new UserError(`Unknown child "${childId}".`);
  out(role === "repo-coordinator" ? repoContext(p, state, childId) : childContext(p, state, childId, role as Role));
  return 0;
}

export function changedFiles(c: ChildState): string[] {
  if (!c.worktree || !fs.existsSync(c.worktree)) return [];
  return snapshotWorktree(c.worktree, c.baseSha ?? "HEAD", c.copiedFiles ?? []).files.map((f) => f.path);
}

export function cmdScope(args: string[], flags: { check?: boolean }): number {
  const ws = requireWorkspace();
  const p = projectPaths(ws, validateProjectName(args[0]));
  const childId = args[1];
  if (!childId || !flags.check) throw new UserError(SCOPE_USAGE);
  const c = readState(p).children[childId];
  if (!c) throw new UserError(`Unknown child "${childId}".`);
  const changed = changedFiles(c);
  const outside = outOfScope(c, changed);
  out(
    JSON.stringify(
      {
        child: childId,
        scoped: scopeGlobs(c) !== undefined,
        scope: scopeGlobs(c) ?? [],
        changed,
        outside,
        ok: !outside.length,
      },
      null,
      2,
    ),
  );
  return 0;
}

function rebasing(worktree: string): boolean {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const rel = tryGit(worktree, ["rev-parse", "--git-path", dir])?.trim();
    if (rel && fs.existsSync(path.resolve(worktree, rel))) return true;
  }
  return false;
}

function unmerged(worktree: string): string[] {
  return (tryGit(worktree, ["diff", "--name-only", "--diff-filter=U"]) ?? "").split("\n").filter(Boolean);
}

const COMMIT_ENV = { ...process.env, GIT_EDITOR: "true" };

export function cmdMerge(args: string[]): number {
  const ws = requireWorkspace();
  const p = projectPaths(ws, validateProjectName(args[0]));
  const childId = args[1];
  if (!childId) throw new UserError(MERGE_USAGE);
  const state = readState(p);
  const c = state.children[childId];
  if (!c) throw new UserError(`Unknown child "${childId}".`);
  const repo = groupOf(state, childId);
  if (!repo) throw new UserError(`Child ${childId} is not part of a repo with a repo coordinator.`);
  if (c.phase !== "done") throw new UserError(`Child ${childId} is "${c.phase}", not "done".`);
  if (c.merged) throw new UserError(`Child ${childId} is already merged.`);
  const integration = state.children[repo]!;
  if (!integration.worktree || !integration.branch || !fs.existsSync(integration.worktree)) {
    throw new UserError(`Repo ${repo} has no integration worktree. Run: npx openfleet worktree ${p.name} ${repo}`);
  }
  const setup = membersOf(state, repo).find((id) => id !== childId && isSetup(id, state.children[id]!));
  if (setup && !state.children[setup]!.merged && state.children[setup]!.phase !== "failed") {
    throw new UserError(`Merge the setup child ${setup} first.`);
  }
  if (!c.worktree || !c.branch) throw new UserError(`Child ${childId} has no worktree.`);

  // 1. Commit the child's work on its own branch (finishing a resolved rebase first).
  if (rebasing(c.worktree)) {
    git(c.worktree, ["add", "-A"]);
    const left = unmerged(c.worktree);
    if (left.length) throw new UserError(`Child ${childId} still has unresolved conflicts: ${left.join(", ")}.`);
    git(c.worktree, ["-c", "core.hooksPath=/dev/null", "rebase", "--continue"], { env: COMMIT_ENV });
  }
  git(c.worktree, ["add", "-A"]);
  if (tryGit(c.worktree, ["diff", "--cached", "--quiet"]) === undefined) {
    git(c.worktree, ["commit", "--quiet", "--no-verify", "-m", `openfleet(${p.name}): ${childId}`]);
  }

  // 2. Merge it into the integration branch.
  const merged = tryGit(integration.worktree, ["merge", "--no-ff", "--no-edit", "--quiet", c.branch]);
  if (merged !== undefined) {
    const sha = headSha(integration.worktree);
    updateState(p, (s) => {
      const child = s.children[childId]!;
      child.merged = true;
      child.mergedAt = new Date().toISOString();
      delete child.conflict;
    });
    appendEvent(p, {
      actor: `${repo}/repo-coordinator`,
      type: "child.merged",
      target: childId,
      payload: { into: integration.branch, branch: c.branch, sha: sha ?? null },
    });
    out(JSON.stringify({ child: childId, result: "merged", into: integration.branch, sha }, null, 2));
    return 0;
  }

  // 3. Conflict: abort, then rebase the child onto the integration branch for its implementer to resolve.
  const files = unmerged(integration.worktree);
  tryGit(integration.worktree, ["merge", "--abort"]);
  const outside = outOfScope(c, files);
  const onto = integration.branch;
  const tip = git(c.worktree, ["rev-parse", onto]).trim();
  const base = git(c.worktree, ["merge-base", "HEAD", onto]).trim();
  git(c.worktree, ["reset", "--soft", base]);
  git(c.worktree, ["commit", "--quiet", "--no-verify", "--allow-empty", "-m", `openfleet(${p.name}): ${childId}`]);
  tryGit(c.worktree, ["rebase", onto]);
  const next = updateState(
    p,
    (s) => {
      const child = s.children[childId]!;
      child.phase = "planned";
      child.conflict = { files, outside, onto };
      child.baseSha = tip;
      delete child.lastSnapshot;
      delete child.merged;
    },
    `${repo}/repo-coordinator`,
  );
  appendEvent(p, {
    actor: `${repo}/repo-coordinator`,
    type: "merge.conflict",
    target: childId,
    payload: { into: onto, files, outside, scopeViolation: outside.length > 0 },
  });
  out(
    JSON.stringify(
      { child: childId, result: "conflict", files, outside, phase: next.children[childId]!.phase },
      null,
      2,
    ),
  );
  return 0;
}

const RESUME_PHASE: Partial<Record<ChildPhase, ChildPhase>> = {
  pending: "pending",
  planning: "pending",
  "plan-review": "pending",
  planned: "planned",
  baseline: "planned",
  implementing: "planned",
  testing: "planned",
  "post-test": "planned",
};

export function cmdEscalate(
  args: string[],
  flags: { question?: string; resolve?: boolean; decision?: string; actor?: string },
): number {
  const ws = requireWorkspace();
  const p = projectPaths(ws, validateProjectName(args[0]));
  const childId = args[1];
  if (!childId) throw new UserError(ESCALATE_USAGE);
  if (flags.resolve) {
    if (!flags.decision) throw new UserError(ESCALATE_USAGE);
    let question = "";
    const next = updateState(p, (s) => {
      const c = s.children[childId];
      if (!c) throw new UserError(`Unknown child "${childId}".`);
      if (c.blockedReason !== "needs-escalation" || !c.escalation) {
        throw new UserError(`Child ${childId} has no open escalation.`);
      }
      question = c.escalation.question;
      c.phase = RESUME_PHASE[c.escalation.phase] ?? "pending";
      c.decisions = [...(c.decisions ?? []), flags.decision!];
      delete c.escalation;
    });
    appendEvent(p, {
      actor: flags.actor ?? "coordinator",
      type: "question.answered",
      target: childId,
      payload: { question, answer: flags.decision, escalated: true },
    });
    out(JSON.stringify(next.children[childId], null, 2));
    return 0;
  }
  if (!flags.question) throw new UserError(ESCALATE_USAGE);
  const next = updateState(p, (s) => {
    const c = s.children[childId];
    if (!c) throw new UserError(`Unknown child "${childId}".`);
    if (c.phase === "done" || c.phase === "failed" || c.phase === "blocked") {
      throw new UserError(`Child ${childId} is "${c.phase}".`);
    }
    c.escalation = { question: flags.question!, phase: c.phase, at: new Date().toISOString() };
    c.phase = "blocked";
    c.blockedReason = "needs-escalation";
    delete c.pendingSpawn;
    delete c.claimedAt;
  });
  const repo = next.children[childId]!.repo;
  appendEvent(p, {
    actor: flags.actor ?? `${repo}/repo-coordinator`,
    type: "question.escalated",
    target: childId,
    payload: { question: flags.question, repo },
  });
  out(JSON.stringify(next.children[childId], null, 2));
  return 0;
}
