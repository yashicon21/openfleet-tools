import path from "node:path";
import { packageVersion } from "../core.js";
import { projectPaths, type Workspace } from "../workspace.js";
import { buildModel, type ReportOptions } from "./model.js";
import { renderReport } from "./render.js";

export { buildModel, deriveModel, DEFAULT_GAP_MINUTES, type ReportModel } from "./model.js";
export { renderReport } from "./render.js";

export function defaultReportPath(ws: Workspace, project: string): string {
  return path.join(projectPaths(ws, project).dir, "report.html");
}

/** Build the HTML report for a project (past or in progress). */
export function generateReport(ws: Workspace, project: string, opts: ReportOptions = {}): string {
  return renderReport(buildModel(ws, project, { version: packageVersion(), ...opts }));
}
