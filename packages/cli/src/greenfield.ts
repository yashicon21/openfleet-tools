// Scope guard for greenfield projects: a run builds an MVP slice, everything else goes to
// the spec's `## Follow-ups`. Checked by the CLI before the spec can be approved.
import type { ProjectState } from "./state.js";

export interface GreenfieldLimits {
  /** Children of kind `service`. */
  maxServices: number;
  /** All children (integration children of grouped repos are not counted). */
  maxChildren: number;
  /** Numbered or bulleted items under a child's **Acceptance criteria** in spec.md. */
  maxCriteriaPerChild: number;
}

export const DEFAULT_GREENFIELD_LIMITS: GreenfieldLimits = { maxServices: 5, maxChildren: 12, maxCriteriaPerChild: 8 };
export const GREENFIELD_LIMIT_KEYS = Object.keys(DEFAULT_GREENFIELD_LIMITS) as (keyof GreenfieldLimits)[];

const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;
const EMPTY_ITEM = /^(?:none|n\/a|—|-|tbd)\.?$/i;

/** Body lines of each `## ` section, keyed by lower-case heading. */
function sections(lines: string[], level: "##" | "###"): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur: string[] | undefined;
  let fence = false;
  const heading = new RegExp(`^${level}\\s+(.+?)\\s*#*\\s*$`);
  const higher = level === "###" ? /^#{1,2}\s/ : /^#\s/;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : heading.exec(line);
    if (m) {
      cur = [];
      out.set(m[1]!.replace(/`/g, "").trim().toLowerCase(), cur);
    } else if (!fence && higher.test(line)) cur = undefined;
    else cur?.push(line);
  }
  return out;
}

/** Items of the spec's `## Follow-ups` section ("None" and similar placeholders are dropped); undefined if missing. */
export function specFollowUps(md: string): string[] | undefined {
  const all = sections(md.split("\n"), "##");
  const body = all.get("follow-ups") ?? all.get("follow ups") ?? all.get("followups");
  if (!body) return undefined;
  return body.map((l) => ITEM.exec(l)?.[1]).filter((t): t is string => t !== undefined && !EMPTY_ITEM.test(t.trim()));
}

/** Acceptance criteria per child id, from the `### <child id>` blocks under `## Per-child requirements`. */
export function specCriteria(md: string): Map<string, number> {
  const body = sections(md.split("\n"), "##").get("per-child requirements") ?? [];
  const out = new Map<string, number>();
  for (const [id, lines] of sections(body, "###")) {
    let inCriteria = false;
    let n = 0;
    for (const line of lines) {
      if (/^[-*+]\s+\*\*/.test(line)) {
        inCriteria = /^[-*+]\s+\*\*acceptance criteria:?\*\*/i.test(line);
        continue;
      }
      if (inCriteria && /^\s+/.test(line) && ITEM.test(line)) n++;
    }
    out.set(id, n);
  }
  return out;
}

function limitHint(key: keyof GreenfieldLimits): string {
  return `npx openfleet config set greenfield.${key} <n>`;
}

/**
 * Everything that keeps a greenfield spec from being approved: children without a kind, too many
 * services or children, too many acceptance criteria for one child, or no `## Follow-ups` items.
 */
export function greenfieldViolations(
  state: ProjectState,
  spec: string | undefined,
  limits: GreenfieldLimits,
): string[] {
  const problems: string[] = [];
  const children = Object.entries(state.children).filter(([, c]) => !c.integration);
  const unkinded = children.filter(([, c]) => !c.kind).map(([id]) => id);
  if (state.greenfield && unkinded.length) {
    problems.push(
      `Every greenfield child needs a kind (setup, contracts, service, frontend or system). Missing: ${unkinded.join(", ")}.`,
    );
  }
  const services = children.filter(([, c]) => c.kind === "service").map(([id]) => id);
  if (services.length > limits.maxServices) {
    problems.push(
      `${services.length} services (${services.join(", ")}), but the limit is ${limits.maxServices}. ` +
        `Keep the core flow and move the rest to ## Follow-ups, or raise it with ${limitHint("maxServices")}.`,
    );
  }
  if (children.length > limits.maxChildren) {
    problems.push(
      `${children.length} children, but the limit is ${limits.maxChildren}. ` +
        `Merge or cut children (move them to ## Follow-ups), or raise it with ${limitHint("maxChildren")}.`,
    );
  }
  if (spec === undefined) {
    problems.push("spec.md is missing.");
    return problems;
  }
  const criteria = specCriteria(spec);
  for (const [id] of children) {
    const n = criteria.get(id.toLowerCase()) ?? 0;
    if (n > limits.maxCriteriaPerChild) {
      problems.push(
        `Child ${id} has ${n} acceptance criteria, but the limit is ${limits.maxCriteriaPerChild}. ` +
          `Keep the core ones and move the rest to ## Follow-ups, or raise it with ${limitHint("maxCriteriaPerChild")}.`,
      );
    }
  }
  const followUps = specFollowUps(spec);
  if (followUps === undefined) {
    problems.push("spec.md has no ## Follow-ups section. List everything cut from this MVP slice there.");
  } else if (!followUps.length) {
    problems.push("spec.md's ## Follow-ups section is empty. List everything cut from this MVP slice there.");
  }
  return problems;
}

/** Raw body of the spec's `## <heading>` section (trimmed), or undefined if it is missing. */
export function specSection(md: string, heading: string): string | undefined {
  const body = sections(md.split("\n"), "##").get(heading.toLowerCase());
  return body?.join("\n").trim();
}
