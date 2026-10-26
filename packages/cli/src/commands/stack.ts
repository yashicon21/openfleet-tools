// `npx openfleet stack <project> <repo>`: split a grouped repo's integration branch into a stack
// of smaller PRs (GitHub stacked pull requests, `gh stack`), one layer per merged child.
import fs from "node:fs";
import { appendEvent, readEvents } from "../events.js";
import { git, tryGit } from "../git.js";
import { idSlug, membersOf } from "../groups.js";
import { readRepos } from "../repos.js";
import { readState, updateState } from "../state.js";
import { projectPaths, requireWorkspace, UserError, validateProjectName } from "../workspace.js";
import { out } from "./output.js";

export const STACK_USAGE = `Usage: openfleet stack <project> <repo>
  Creates one branch per merged child of <repo>'s integration branch, in merge order (the top layer is the
  integration branch itself), and prints the gh stack commands that open them as stacked draft PRs.`;

export interface StackLayer {
  /** The child whose merge ends this layer (the top layer also holds any integration fixes). */
  child: string;
  branch: string;
  sha: string;
}

export function cmdStack(args: string[]): number {
  const ws = requireWorkspace();
  const p = projectPaths(ws, validateProjectName(args[0]));
  const repo = args[1];
  if (!repo) throw new UserError(STACK_USAGE);
  const state = readState(p);
  const integration = state.children[repo];
  if (!integration?.integration) {
    throw new UserError(`Repo "${repo}" has one child, so it gets one PR. Stacks need a repo with several children.`);
  }
  if (integration.phase !== "done")
    throw new UserError(`Integration child ${repo} is "${integration.phase}", not "done".`);
  const { worktree, branch: top } = integration;
  if (!worktree || !top || !fs.existsSync(worktree)) throw new UserError(`Repo ${repo} has no integration worktree.`);
  if ((tryGit(worktree, ["status", "--porcelain"]) ?? "").trim()) {
    throw new UserError(`The integration worktree of ${repo} has uncommitted changes. Commit them first.`);
  }

  const shas = new Map<string, string>();
  for (const e of readEvents(p)) {
    if (e.type === "child.merged" && e.target && typeof e.payload.sha === "string") shas.set(e.target, e.payload.sha);
  }
  const merged = membersOf(state, repo)
    .filter((id) => state.children[id]!.merged && shas.has(id))
    .sort((a, b) => (state.children[a]!.mergedAt ?? "").localeCompare(state.children[b]!.mergedAt ?? ""));
  if (merged.length < 2) {
    throw new UserError(
      `Repo ${repo} has ${merged.length} merged child(ren); a stack needs at least two. Open one PR.`,
    );
  }

  const repoPath = integration.repoPath ?? worktree;
  const layers: StackLayer[] = merged.map((id, i) => {
    const last = i === merged.length - 1;
    const branch = last ? top : `${top}--stack-${i + 1}-${idSlug(id)}`;
    const sha = last ? git(worktree, ["rev-parse", "HEAD"]).trim() : shas.get(id)!;
    if (!last) git(repoPath, ["branch", "--force", branch, sha]);
    return { child: id, branch, sha };
  });
  const base = readRepos(ws).repos[repo]?.defaultBranch ?? integration.baseBranch ?? "main";

  updateState(p, (s) => {
    s.children[repo]!.stack = layers;
  });
  appendEvent(p, { actor: "coordinator", type: "stack.created", target: repo, payload: { base, layers } });
  out(
    JSON.stringify(
      {
        repo,
        base,
        worktree,
        layers,
        commands: [
          `gh stack init --base ${base} ${layers.map((l) => l.branch).join(" ")}`,
          "gh stack submit --auto",
          "gh stack view --json",
        ],
      },
      null,
      2,
    ),
  );
  return 0;
}
