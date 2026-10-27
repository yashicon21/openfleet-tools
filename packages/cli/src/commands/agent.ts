// `npx openfleet agent start|status|wait|result|reply|stop`: role sessions (agentMode "session").
import fs from "node:fs";
import path from "node:path";
import {
  jobResult,
  listJobs,
  readJob,
  replyJob,
  runJob,
  startJob,
  stopJob,
  sweepLost,
  view,
  waitJobs,
  withoutReport,
} from "../jobs.js";
import { projectPaths, requireWorkspace, UserError, validateProjectName } from "../workspace.js";
import { out } from "./output.js";

export const AGENT_USAGE = `Usage:
  openfleet agent start <project> <child> --role <planner|baseline|implementer|tester> [--message <text> | --message-file <f>]
  openfleet agent start <project> [child] --agent <extension phase agent> [--message <text> | --message-file <f>]
  openfleet agent status <project> [job]
  openfleet agent wait <project> [--repo <repo>] [--job <job>] [--timeout <seconds>]
  openfleet agent result <project> <job> [--out <file>]
  openfleet agent reply <project> <job> --message <text> | --message-file <f>
  openfleet agent stop <project> <job> [--reason <text>]`;

export interface AgentFlags {
  role?: string;
  agent?: string;
  message?: string;
  "message-file"?: string;
  job?: string;
  timeout?: string;
  reason?: string;
  repo?: string;
  out?: string;
}

function message(flags: AgentFlags): string | undefined {
  if (flags.message !== undefined && flags["message-file"] !== undefined) {
    throw new UserError("Pass --message or --message-file, not both.");
  }
  if (flags["message-file"] !== undefined) {
    try {
      return fs.readFileSync(flags["message-file"], "utf8");
    } catch {
      throw new UserError(`Cannot read --message-file ${flags["message-file"]}.`);
    }
  }
  return flags.message;
}

function print(v: unknown): void {
  out(JSON.stringify(v, null, 2));
}

function fail(err: unknown): void {
  process.stderr.write(`openfleet: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}

export function cmdAgent(args: string[], flags: AgentFlags): number {
  const [sub, projectArg, arg] = args;
  if (!sub) throw new UserError(AGENT_USAGE);
  const ws = requireWorkspace();
  const project = validateProjectName(projectArg);
  const p = projectPaths(ws, project);
  if (!fs.existsSync(p.state)) throw new UserError(`Unknown project "${project}".`);
  const needJob = () => {
    if (!arg) throw new UserError(AGENT_USAGE);
    return arg;
  };
  switch (sub) {
    case "start": {
      if (!!flags.role === !!flags.agent) throw new UserError(AGENT_USAGE);
      print(startJob({ ws, project, child: arg, role: flags.role, agent: flags.agent, message: message(flags) }));
      return 0;
    }
    case "status": {
      sweepLost(p);
      print(arg ? view(readJob(p, arg)) : { jobs: listJobs(p).map(view) });
      return 0;
    }
    case "wait": {
      const seconds = flags.timeout === undefined ? 540 : Number(flags.timeout);
      if (!Number.isFinite(seconds) || seconds < 0) throw new UserError("--timeout must be a number of seconds.");
      waitJobs(p, { jobId: flags.job, owner: flags.repo, timeoutMs: seconds * 1000 }).then(print, fail);
      return 0;
    }
    case "result": {
      const res = jobResult(p, needJob());
      if (flags.out) {
        fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
        fs.writeFileSync(flags.out, withoutReport(res.text));
        print({ ...res, text: undefined, savedTo: path.resolve(flags.out) });
      } else print(res);
      return 0;
    }
    case "reply": {
      const text = message(flags);
      if (!text?.trim()) throw new UserError("agent reply needs --message or --message-file.");
      print(replyJob(ws, p, needJob(), text));
      return 0;
    }
    case "stop":
      print(stopJob(ws, p, needJob(), flags.reason));
      return 0;
    case "run":
      // Internal: the detached job runner started by `start` and `reply`.
      runJob(ws, project, needJob()).then(() => undefined, fail);
      return 0;
    default:
      throw new UserError(AGENT_USAGE);
  }
}
