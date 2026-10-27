// Spending limits for a run: tokens (from the host transcripts, as `openfleet report` reads them)
// and cost (priced with `pricing`). `npx openfleet claim` checks them before every spawn and
// halts the run when one is reached, so a hands-off run cannot spend without bound.
import { readConfig, type BudgetLimits } from "./config.js";
import { jobSessions } from "./jobstore.js";
import { DEFAULT_HOST } from "./hosts.js";
import { readEvents } from "./events.js";
import { sessionIds } from "./report/model.js";
import { readTokenUsage, totalTokens } from "./report/tokens.js";
import type { ProjectState } from "./state.js";
import type { ProjectPaths, Workspace } from "./workspace.js";

/** Share of a limit at which `budget.warning` is logged. */
export const BUDGET_WARN_AT = 0.8;

export interface BudgetStatus {
  limits: Partial<BudgetLimits>;
  tokens: number;
  /** USD, when `pricing` covers the models used. */
  cost?: number;
  /** Models with usage but no price; their tokens count toward `maxTokens` but not `maxCost`. */
  unpriced: string[];
  /** Set when a limit is reached: what was used of what. */
  over?: string;
  /** Set at `BUDGET_WARN_AT` of a limit. */
  near?: string;
}

/** The project's limits over the workspace `budget`. */
export function effectiveBudget(ws: Workspace, state: ProjectState): Partial<BudgetLimits> {
  return { ...readConfig(ws).budget, ...state.budget };
}

function fmt(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

/** Usage so far against the limits. Without limits, nothing is read. */
export function budgetStatus(
  ws: Workspace,
  p: ProjectPaths,
  state: ProjectState,
  env: NodeJS.ProcessEnv = process.env,
): BudgetStatus {
  const limits = effectiveBudget(ws, state);
  if (limits.maxTokens === undefined && limits.maxCost === undefined) return { limits, tokens: 0, unpriced: [] };
  const report = readTokenUsage({
    host: state.host ?? DEFAULT_HOST,
    cwd: ws.root,
    sessionIds: sessionIds(readEvents(p), state),
    jobs: jobSessions(p),
    pricing: limits.maxCost !== undefined ? readConfig(ws).pricing : undefined,
    env,
  });
  const tokens = report ? totalTokens(report.total) : 0;
  const cost = report?.cost?.total;
  const status: BudgetStatus = {
    limits,
    tokens,
    ...(cost !== undefined ? { cost } : {}),
    unpriced: report?.cost?.unpriced ?? [],
  };
  const checks: [number | undefined, number | undefined, (v: number) => string][] = [
    [tokens, limits.maxTokens, (v) => `${fmt(v)} tokens`],
    [cost, limits.maxCost, (v) => `$${v.toFixed(2)}`],
  ];
  for (const [used, max, show] of checks) {
    if (used === undefined || max === undefined) continue;
    if (used >= max) status.over ??= `${show(used)} of ${show(max)} used`;
    else if (used >= max * BUDGET_WARN_AT) status.near ??= `${show(used)} of ${show(max)} used`;
  }
  return status;
}
