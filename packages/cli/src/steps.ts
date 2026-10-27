// Step mode (`split.implementer: "steps"`): the planner ends its plan with a `## Steps` list, and
// the implementer job runs each step in a fresh session, so a small-context model only ever holds
// one step. Earlier steps' work is on disk in the worktree; the prompt names what was done before.
import crypto from "node:crypto";
import { tryGit } from "./git.js";

export interface PlanStep {
  /** 1-based number in the plan. */
  n: number;
  title: string;
  /** The step's full text from the plan. */
  text: string;
}

/** The `## Steps` section of a plan as numbered items (continuation lines kept with their item). */
export function parseSteps(plan: string): PlanStep[] {
  const lines = plan.split("\n");
  const start = lines.findIndex((l) => /^##\s+Steps\s*$/i.test(l.trim()));
  if (start < 0) return [];
  const steps: PlanStep[] = [];
  let fence = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (!fence && /^#{1,2}\s/.test(line)) break;
    const m = fence ? null : /^(\d+)[.)]\s+(.*)$/.exec(line);
    if (m) {
      const body = m[2]!.trim();
      const bold = /^\*\*(.+?)\*\*/.exec(body);
      const title = (bold?.[1] ?? body).replace(/[\s—:-]+$/, "").slice(0, 100);
      steps.push({ n: steps.length + 1, title, text: body });
    } else if (steps.length) {
      steps.at(-1)!.text += `\n${line}`;
    }
  }
  for (const s of steps) s.text = s.text.trimEnd();
  return steps;
}

/** Identifies a plan's steps, so a later job of the same plan skips the steps already done. */
export function stepsHash(steps: PlanStep[]): string {
  return crypto
    .createHash("sha256")
    .update(steps.map((s) => s.text).join("\n\x00"))
    .digest("hex")
    .slice(0, 16);
}

/** What the planner adds when the implementer runs in steps. */
export const PLANNER_STEPS_NOTE = [
  "## Steps (required)",
  "",
  "The implementer runs your plan **one step at a time, each step in a fresh session** of a model with a small context. It sees only its step, the titles of the steps before it and the files on disk.",
  "End the plan with a `## Steps` section: a numbered list in order, usually 3–12 steps. Each step is one line that starts with a bold title, then the files it touches, what to change and a quick check command if there is one, for example:",
  "",
  "```",
  "1. **Add the invoice model** — `src/models/invoice.ts`: add the `Invoice` type and `toJSON()`. Check: `pnpm tsc --noEmit`.",
  "```",
  "",
  "Keep each step small (a few files, one concern) and complete on its own once the steps before it are done. Keep a rename and all its call sites in one step. Put the contract tests in their own step, after the code they test.",
].join("\n");

/** Changed files in a worktree, for the next step's prompt (at most 40 lines). */
export function worktreeChanges(worktree: string | undefined): string {
  if (!worktree) return "";
  const out = tryGit(worktree, ["status", "--short", "--untracked-files=all"])?.trimEnd() ?? "";
  const lines = out ? out.split("\n") : [];
  return lines.length > 40 ? [...lines.slice(0, 40), `… ${lines.length - 40} more`].join("\n") : lines.join("\n");
}

export interface StepPromptInput {
  child: string;
  project: string;
  step: PlanStep;
  total: number;
  /** Titles of the steps done before this one. */
  done: PlanStep[];
  assignment: string;
  changes: string;
  /** The coordinator's message (findings, guidance), on the first step a job runs. */
  message?: string;
  /** Why the previous attempt of this step failed, on a retry. */
  previous?: string;
}

export function stepPrompt(i: StepPromptInput): string {
  const sections = [
    `Implement step ${i.step.n} of ${i.total} of the approved plan for child \`${i.child}\` of project \`${i.project}\`.`,
    i.assignment,
    `## Your step (${i.step.n} of ${i.total})\n\n${i.step.text}`,
    [
      "## Done before you",
      "",
      i.done.length
        ? i.done.map((s) => `${s.n}. ${s.title} (done)`).join("\n")
        : "Nothing yet: this is the first step.",
      ...(i.changes ? ["", "Changed files in the worktree so far:", "", "```", i.changes, "```"] : []),
    ].join("\n"),
    [
      "## Rules for this step",
      "",
      "- Do **only this step**. Other sessions do the other steps, before and after you: do not start them, and do not undo work from earlier steps.",
      "- Read the files you need from the worktree. You do not need the whole plan unless your step is unclear.",
      "- Run the step's check if it names one, and fix what this step broke.",
      "- End with your `openfleet-report` block for this step: `status` `done`, `question` (with `question`) or `failed`, and a `summary` of what you changed.",
    ].join("\n"),
    i.previous ? `## Previous attempt of this step failed\n\n${i.previous}` : "",
    i.message?.trim() ? `## From the coordinator\n\n${i.message.trim()}` : "",
  ];
  return sections.filter(Boolean).join("\n\n");
}
