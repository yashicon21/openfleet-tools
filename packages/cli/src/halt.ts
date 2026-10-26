// Halting a run: a spending limit was reached (`claim`), or the user ran `pause` or `cancel`.
// While `state.halt` is set, `claim` returns `stop` and `next` returns only a `halt` action, so the
// coordinators spawn nothing more, let in-flight agents finish and end. `resume` clears it.
import { appendEvent } from "./events.js";
import { updateState, type Halt, type HaltReason, type ProjectState } from "./state.js";
import type { ProjectPaths } from "./workspace.js";

/** What the coordinator does on each halt reason (also shown by `status`). */
export const HALT_HINT: Record<HaltReason, string> = {
  budget:
    "A spending limit was reached. Raise it (`npx openfleet config set budget.<key> <n>`, or the project's `budget` in state.json), then `npx openfleet resume <name>`.",
  paused: "Paused. `npx openfleet resume <name>` continues where it stopped.",
  cancelled: "Cancelled. Worktrees and branches are kept; `npx openfleet resume <name> --reopen` continues anyway.",
};

/** Record a halt and log `run.halted`. An existing halt is kept, except that `cancelled` replaces any. */
export function haltRun(
  p: ProjectPaths,
  reason: HaltReason,
  detail: string | undefined,
  actor: string,
  extra: (s: ProjectState) => void = () => {},
): ProjectState {
  let halt: Halt | undefined;
  const next = updateState(
    p,
    (s) => {
      if (s.halt && reason !== "cancelled") return;
      halt = { reason, at: new Date().toISOString(), ...(detail ? { detail } : {}) };
      if (reason === "cancelled") halt.from = s.status;
      s.halt = halt;
      extra(s);
    },
    actor,
  );
  if (halt) {
    appendEvent(p, {
      actor,
      type: "run.halted",
      target: null,
      payload: { reason, detail: detail ?? null },
    });
  }
  return next;
}

/** Clear a halt (on `resume`) and log `run.resumed`. A cancelled run returns to its earlier status. */
export function clearHalt(p: ProjectPaths, actor = "cli"): ProjectState {
  let was: Halt | undefined;
  const next = updateState(
    p,
    (s) => {
      was = s.halt;
      if (!was) return;
      if (was.reason === "cancelled" && s.status === "cancelled") s.status = was.from ?? "running";
      delete s.halt;
      delete s.budgetWarned;
    },
    actor,
  );
  if (was) appendEvent(p, { actor, type: "run.resumed", target: null, payload: { reason: was.reason } });
  return next;
}
