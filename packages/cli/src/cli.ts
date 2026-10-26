import { parseArgs } from "node:util";
import { packageVersion } from "./core.js";
import { cmdAdd, cmdExtensions, cmdRemove, runExtensionCommand } from "./commands/extensions.js";
import { cmdExt } from "./commands/ext.js";
import { cmdEvent, cmdSpecCheck, cmdState, cmdWorktree } from "./commands/internal.js";
import { out } from "./commands/output.js";
import { cmdAck, cmdClaim, cmdEscalate, cmdMerge, cmdScope } from "./commands/repo.js";
import { cmdRepo } from "./commands/repos.js";
import { cmdReport } from "./commands/report.js";
import { cmdStack } from "./commands/stack.js";
import { cmdBaseline, cmdGate, cmdNext, cmdPreflight } from "./commands/run.js";
import { cmdClean, cmdContinue, cmdList, cmdNew, cmdResume, cmdStatus } from "./commands/project.js";
import { cmdConfig, cmdInit, cmdUpdate } from "./commands/workspace.js";
import { hintFor } from "./sandbox.js";
import { UserError } from "./workspace.js";
import { MIN_CLAUDE_VERSION } from "./launcher.js";

export const HELP = `openfleet — coordinate one change across many repos with GitHub Copilot CLI or Claude Code

Usage: npx openfleet <command> [options] [-- <host args>]

Workspace
  init [--host copilot|claude] Create the workspace in the current directory and install core.
                               Asks which host to use (no terminal or CI: copilot); --host skips the question
  update                       Replace core with this CLI version and re-sync extensions
  config                       Show workspace settings (openfleet.json) as JSON
  config set <key> <value>     Change a workspace setting: maxParallel (default 6) caps planners,
                               baseline testers, implementers and testers running at once, across all projects;
                               host (copilot | claude, default copilot) picks the agent host for new projects;
                               greenfield.maxServices (default 5), greenfield.maxChildren (12) and
                               greenfield.maxCriteriaPerChild (8) cap a greenfield spec before it can be approved

Projects
  new <name> ["<request>"] [--ask] [--host copilot|claude]
                               Create a project and launch the coordinator (--host overrides config host)
  resume <name> [--fresh] [--ask] [--host <host>]
                               Continue a project in its host session (--fresh starts a new one).
                               A project keeps the host it was created with
  continue <project> [name] [--ask] [--host <host>]
                               Start the next slice of a finished greenfield project (default name <project>-2):
                               its spec draft holds the previous Follow-ups, Layout and Stack; repos are reused
  status [name] [--json]       Show a project's children (grouped by repo), phases and open questions
  list                         List projects
  clean <name> [--branches] [--force]
                               Remove the project's child and integration worktrees (and branches)
  report <name> [--out <file>] [--open] [--gap <min>]
                               Write an HTML report of the run (default projects/<name>/report.html).
                               Pauses longer than --gap minutes (default 15) are collapsed

Repos
  repo create <key> [--github <owner/name>] [--project <name>]
                               Create an empty repo in repos/<key> (initial commit on main) for a greenfield
                               project and register it in repos.json; --github also creates a private GitHub repo
  repo confirm <key> [--package <name> [--path <dir>]] [--build <cmd>] [--test <cmd>] [--e2e <cmd>] [--copy-file <f>]
                               Record confirmed commands (and local copyFiles) for a repo or package in repos.json

Extensions
  add <git-url[#ref]|path>     Install or update an extension
  remove <name>                Uninstall an extension
  extensions                   List installed extensions

Agent helpers (used by OpenFleet agents)
  state <project> [--patch <json>] [--actor <a>]
  event <project> --type <t> [--actor <a>] [--target <child>] [--payload <json>] [--patch-file <f>]
  worktree <project> <child> [--repo <key>] [--branch <b>] [--package <p>] [--base <ref>]
  ext plan <project> <slot> [--child <id>]
  ext result <project> <extension> --slot <s> [--child <id>] --report <json>
  ext fail <project> <extension> --slot <s> [--child <id>] --reason <text>
  ext settings [--unset]
                               List declared extension settings (JSON); --unset: only those not yet set
  ext settings set <ext> <key> <value>
                               Write a workspace-level setting to extensions.config.json
  spec-check <project>         Greenfield projects: list what blocks spec approval (caps, kinds, Follow-ups)
  preflight <project>          Check that git can write ref locks and worktrees in every repo (sandbox check)
  next <project> [--repo <repo>]
                               Print the next scheduling actions (plans first, then the gate)
  gate <project> consistent [--repo <repo>] [--child <id>[,<id>…]]
                               Record that plans agree (plans.consistent); --repo: one repo's sibling check
  gate <project> open          Open the plans-ready gate
  baseline <project> <child> --report <json> | --check
                               Record a passed baseline, or check the diff for unlisted baseline edits
  claim <project> <child> <role>
                               Reserve a spawn (workspace maxParallel, one claim per role); prints claimed or wait
  ack <project> <child> <role> Re-print a child's assignment (optional; fallback id binding)
  scope <project> <child> --check
                               List changed files outside a path-scoped child's paths
  merge <project> <child>      Merge a done child into its repo's integration branch
  stack <project> <repo>       Split a grouped repo into stacked draft PRs: one branch per merged child, in order
  escalate <project> <child> --question <text> | --resolve --decision <text>
                               Block a child on a cross-repo question, or resolve it

  help, version
Sessions auto-approve tool use (Copilot: \`--allow-all-tools\`; Claude Code: \`--permission-mode
acceptEdits --allowedTools Bash\`). File access stays limited to the workspace, its worktrees and
known repos, and URL access still prompts. Pass \`--ask\` to \`new\`, \`resume\` or an extension command
to be prompted for every tool instead.
Arguments after \`--\` are passed to the host CLI unchanged (e.g. \`-- --yolo\` for copilot).
Claude Code needs ${MIN_CLAUDE_VERSION} or later.
`;

function splitPassthrough(argv: string[]): [string[], string[]] {
  const i = argv.indexOf("--");
  return i < 0 ? [argv, []] : [argv.slice(0, i), argv.slice(i + 1)];
}

function parse<T extends Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }>>(
  args: string[],
  options: T,
) {
  return parseArgs({ args, options, allowPositionals: true, strict: true });
}

export function run(argv: string[]): number {
  const [args, passthrough] = splitPassthrough(argv);
  const [command, ...rest] = args;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      out(HELP);
      return 0;
    case "version":
    case "--version":
    case "-v":
      out(packageVersion());
      return 0;
    case "init": {
      const { values } = parse(rest, { host: { type: "string" } });
      return cmdInit({ host: values.host });
    }
    case "update":
      return cmdUpdate();
    case "config":
      return cmdConfig(parse(rest, {}).positionals);
    case "new": {
      const { values, positionals } = parse(rest, { ask: { type: "boolean" }, host: { type: "string" } });
      return cmdNew(positionals, passthrough, { ask: values.ask, host: values.host });
    }
    case "resume": {
      const { values, positionals } = parse(rest, {
        fresh: { type: "boolean" },
        ask: { type: "boolean" },
        host: { type: "string" },
      });
      return cmdResume(positionals, passthrough, { fresh: values.fresh, ask: values.ask, host: values.host });
    }
    case "continue": {
      const { values, positionals } = parse(rest, { ask: { type: "boolean" }, host: { type: "string" } });
      return cmdContinue(positionals, passthrough, { ask: values.ask, host: values.host });
    }
    case "status": {
      const { values, positionals } = parse(rest, { json: { type: "boolean" } });
      return cmdStatus(positionals, { json: values.json });
    }
    case "list":
      return cmdList();
    case "clean": {
      const { values, positionals } = parse(rest, { branches: { type: "boolean" }, force: { type: "boolean" } });
      return cmdClean(positionals, values);
    }
    case "report": {
      const { values, positionals } = parse(rest, {
        out: { type: "string" },
        open: { type: "boolean" },
        gap: { type: "string" },
      });
      return cmdReport(positionals, values);
    }
    case "repo": {
      const { values, positionals } = parse(rest, {
        github: { type: "string" },
        project: { type: "string" },
        package: { type: "string" },
        path: { type: "string" },
        build: { type: "string" },
        test: { type: "string" },
        e2e: { type: "string" },
        "copy-file": { type: "string", multiple: true },
      });
      return cmdRepo(positionals, values);
    }
    case "add":
      return cmdAdd(parse(rest, {}).positionals);
    case "remove":
      return cmdRemove(parse(rest, {}).positionals);
    case "extensions":
      return cmdExtensions();
    case "state": {
      const { values, positionals } = parse(rest, { patch: { type: "string" }, actor: { type: "string" } });
      return cmdState(positionals, values);
    }
    case "event": {
      const { values, positionals } = parse(rest, {
        type: { type: "string" },
        actor: { type: "string" },
        target: { type: "string" },
        payload: { type: "string" },
        "patch-file": { type: "string" },
      });
      return cmdEvent(positionals, values);
    }
    case "worktree": {
      const { values, positionals } = parse(rest, {
        repo: { type: "string" },
        branch: { type: "string" },
        package: { type: "string" },
        base: { type: "string" },
      });
      return cmdWorktree(positionals, values);
    }
    case "ext": {
      const { values, positionals } = parse(rest, {
        child: { type: "string" },
        slot: { type: "string" },
        report: { type: "string" },
        reason: { type: "string" },
        unset: { type: "boolean" },
      });
      return cmdExt(positionals, values);
    }
    case "spec-check":
      return cmdSpecCheck(parse(rest, {}).positionals);
    case "preflight":
      return cmdPreflight(parse(rest, {}).positionals);
    case "next": {
      const { values, positionals } = parse(rest, { repo: { type: "string" } });
      return cmdNext(positionals, values);
    }
    case "gate": {
      const { values, positionals } = parse(rest, { child: { type: "string" }, repo: { type: "string" } });
      return cmdGate(positionals, values);
    }
    case "claim":
      return cmdClaim(parse(rest, {}).positionals);
    case "ack":
      return cmdAck(parse(rest, {}).positionals);
    case "scope": {
      const { values, positionals } = parse(rest, { check: { type: "boolean" } });
      return cmdScope(positionals, values);
    }
    case "stack":
      return cmdStack(parse(rest, {}).positionals);
    case "merge":
      return cmdMerge(parse(rest, {}).positionals);
    case "escalate": {
      const { values, positionals } = parse(rest, {
        question: { type: "string" },
        resolve: { type: "boolean" },
        decision: { type: "string" },
        actor: { type: "string" },
      });
      return cmdEscalate(positionals, values);
    }
    case "baseline": {
      const { values, positionals } = parse(rest, { report: { type: "string" }, check: { type: "boolean" } });
      return cmdBaseline(positionals, values);
    }
    default: {
      const ask = rest.includes("--ask");
      const code = runExtensionCommand(
        command,
        rest.filter((a) => a !== "--ask"),
        passthrough,
        { ask },
      );
      if (code === undefined) throw new UserError(`Unknown command "${command}". Run \`npx openfleet help\`.`);
      return code;
    }
  }
}

/** User-facing text for an error: the message (plus a hint for permission errors); a stack only for bugs. */
export function errorMessage(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  if (err instanceof UserError || e.code?.startsWith("ERR_PARSE_ARGS")) return e.message;
  if (e.code === "EPERM" || e.code === "EACCES" || e.code === "EROFS") {
    const hint = hintFor(e.code);
    return `${e.message}${hint ? `\n\n${hint}` : ""}`;
  }
  return e.stack ?? String(err);
}

export function main(argv = process.argv.slice(2)): void {
  try {
    process.exitCode = run(argv);
  } catch (err) {
    process.stderr.write(`openfleet: ${errorMessage(err)}\n`);
    process.exitCode = 1;
  }
}
