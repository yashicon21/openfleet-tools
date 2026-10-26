// Child ids, repo groups (repos with several children and a repo coordinator) and
// the deterministic scope check for path-scoped children.
import type { ChildState, ProjectState } from "./state.js";
import { UserError } from "./workspace.js";

/**
 * Child ids:
 * - `<repo>`: the whole repo. For a grouped repo this is its integration child.
 * - `<repo>:<package>`: one monorepo package (the key in repos.json `packages`).
 * - `<repo>[:<package>]/<unit>`: a path-scoped child (a page, module or service).
 */
const ID = /^([A-Za-z0-9._-]+)(?::(@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+))?(?:\/([a-z0-9][a-z0-9._-]*))?$/;

/** Unit name of the shared-setup child the grill creates for each repo with scoped children. */
export const SETUP_UNIT = "setup";

export interface ChildIdParts {
  repo: string;
  package?: string;
  unit?: string;
}

export function parseChildId(id: string): ChildIdParts | undefined {
  const m = ID.exec(id);
  if (!m) return undefined;
  return { repo: m[1]!, ...(m[2] ? { package: m[2] } : {}), ...(m[3] ? { unit: m[3] } : {}) };
}

export function requireChildId(id: string | undefined): ChildIdParts {
  const parts = id ? parseChildId(id) : undefined;
  if (!parts) {
    throw new UserError(
      `Invalid child id "${id ?? ""}". Use <repo>, <repo>:<package> or <repo>[:<package>]/<unit> (unit: lowercase letters, digits, ".", "_", "-").`,
    );
  }
  return parts;
}

/** Branch-safe form of a child id: `web:ui/button` → `web-ui-button`. */
export function idSlug(id: string): string {
  return id.replace(/[:/@]+/g, "-").replace(/^-+/, "");
}

/** Default branch for a child: the repo-level branch, or `<repo branch>--<slug>` for grouped members. */
export function defaultBranch(project: string, id: string, integrationBranch?: string): string {
  const base = integrationBranch ?? `openfleet/${project}`;
  return parseChildId(id)?.repo === id ? base : `${base}--${idSlug(id)}`;
}

/** Non-integration children of `repo`, in insertion order. */
export function membersOf(state: ProjectState, repo: string): string[] {
  return Object.entries(state.children)
    .filter(([, c]) => c.repo === repo && !c.integration)
    .map(([id]) => id);
}

/** Repo key of the group `id` belongs to, if its repo has a repo coordinator. */
export function groupOf(state: ProjectState, id: string): string | undefined {
  const c = state.children[id];
  if (!c || c.integration) return undefined;
  return state.children[c.repo]?.integration ? c.repo : undefined;
}

export function isSetup(id: string, c: ChildState): boolean {
  return c.setup === true || c.kind === "setup" || parseChildId(id)?.unit === SETUP_UNIT;
}

/**
 * Keep one integration child per repo with two or more children (keyed by the repo,
 * depending on every member) and drop it again while it is untouched and unneeded.
 */
export function syncIntegrationChildren(state: ProjectState): void {
  const repos = new Set(Object.values(state.children).map((c) => c.repo));
  for (const repo of repos) {
    const members = membersOf(state, repo).filter((id) => id !== repo);
    const existing = state.children[repo];
    if (members.length >= 2 || (existing?.integration && members.length)) {
      if (existing && !existing.integration) {
        throw new UserError(
          `Repo "${repo}" has several children, so the child id "${repo}" is reserved for its integration result. Rename that child (for example "${repo}/main" or "${repo}:<package>").`,
        );
      }
      if (existing?.integration && members.length < 2 && !existing.worktree && existing.phase === "pending") {
        delete state.children[repo];
        continue;
      }
      state.children[repo] = {
        phase: "pending",
        retries: 0,
        agentIds: {},
        ...existing,
        repo,
        integration: true,
        dependsOn: members,
      };
    } else if (existing?.integration) {
      delete state.children[repo];
    }
  }
}

// ---------------------------------------------------------------- scope

/** Minimal glob: `**` (any depth), `*` and `?` (within a segment), `{a,b}`. A bare directory matches everything below it. */
export function globToRegExp(glob: string, top = true): RegExp {
  let g = glob.replace(/^\.\//, "").replace(/\/+$/, "");
  if (top && !/[*?{]/.test(g)) g = `${g}{,/**}`;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!;
    if (ch === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (ch === "{") {
      const end = g.indexOf("}", i);
      if (end < 0) {
        re += "\\{";
        continue;
      }
      const alts = g.slice(i + 1, end).split(",");
      re += `(?:${alts.map((a) => globToRegExp(a, false).source.slice(1, -1)).join("|")})`;
      i = end;
    } else re += /[.+^$()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${re}$`);
}

/** Repo-relative globs this child may change: its `paths` (relative to its package) plus `allowPaths` and baseline tests. */
export function scopeGlobs(c: ChildState): string[] | undefined {
  if (!c.paths?.length) return undefined;
  const prefix = c.package ? `${c.package.replace(/\/+$/, "")}/` : "";
  return [...c.paths, ...(c.allowPaths ?? [])].map((g) => prefix + g.replace(/^\.\//, ""));
}

export function inScope(c: ChildState, rel: string): boolean {
  const globs = scopeGlobs(c);
  if (!globs) return true;
  if (c.baselineFiles?.includes(rel)) return true;
  return globs.some((g) => globToRegExp(g).test(rel));
}

/** Changed files outside the child's scope. Children without `paths` are never out of scope. */
export function outOfScope(c: ChildState, changed: string[]): string[] {
  return changed.filter((f) => !inScope(c, f));
}
