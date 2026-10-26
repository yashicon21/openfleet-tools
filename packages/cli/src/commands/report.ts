// `npx openfleet report <project>`: write a self-contained HTML report of a run.
import { spawn } from "node:child_process";
import path from "node:path";
import { writeFileAtomic } from "../fsutil.js";
import { DEFAULT_GAP_MINUTES, defaultReportPath, generateReport } from "../report/index.js";
import { readState } from "../state.js";
import { projectPaths, requireWorkspace, UserError, validateProjectName } from "../workspace.js";
import { out, warn } from "./output.js";

const USAGE = "Usage: npx openfleet report <project> [--out <file>] [--open] [--gap <minutes>]";

function parseGap(value: string | undefined): number {
  if (value === undefined) return DEFAULT_GAP_MINUTES;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0)
    throw new UserError(`--gap must be a positive number of minutes (got "${value}").`);
  return n;
}

function openInBrowser(file: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [file]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", file]]
        : ["xdg-open", [file]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => warn(`Could not open ${file}; open it in a browser.`));
    child.unref();
  } catch {
    warn(`Could not open ${file}; open it in a browser.`);
  }
}

export function cmdReport(args: string[], opts: { out?: string; open?: boolean; gap?: string } = {}): number {
  const ws = requireWorkspace();
  if (args.length !== 1) throw new UserError(USAGE);
  const name = validateProjectName(args[0]);
  readState(projectPaths(ws, name));
  const html = generateReport(ws, name, { gapMinutes: parseGap(opts.gap) });
  const file = opts.out ? path.resolve(opts.out) : defaultReportPath(ws, name);
  writeFileAtomic(file, html);
  out(`Wrote ${file}`);
  if (opts.open) openInBrowser(file);
  return 0;
}
