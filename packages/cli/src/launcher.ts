import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { qualifiedAgentName } from "./attribution.js";
import fs from "node:fs";
import { isDir, realish } from "./fsutil.js";
import { out, warn } from "./commands/output.js";
import { deniedChecks, runChecks } from "./preflight.js";
import { readRepos } from "./repos.js";
import { DEFAULT_HOST, HOST_LABEL, pluginDir, type Host } from "./hosts.js";
import { appSandboxContainer, detectSandbox, inheritedSandboxMessage, sandboxWarning } from "./sandbox.js";
import { projectPaths, UserError, type Workspace } from "./workspace.js";

export interface LaunchOptions {
  ws: Workspace;
  /** Agent host to launch. Default: Copilot CLI. */
  host?: Host;
  agent: string;
  prompt?: string;
  sessionId?: string;
  /**
   * `true` when `sessionId` is a brand-new UUID (or there is none). Only then is `--name` passed:
   * Copilot rejects `--name` together with a `--session-id` that resolves to an existing session.
   */
  newSession?: boolean;
  /** Name for a new session; ignored when resuming one. */
  name?: string;
  project?: string;
  /** Extra args forwarded verbatim to the host CLI (after `--`). */
  passthrough?: string[];
  /** Keep the host's per-tool permission prompts (`--ask`). Default: auto-approve tools. */
  ask?: boolean;
}

/**
 * Whether Copilot still has a session: `$COPILOT_HOME/session-state/<id>` (default `~/.copilot`).
 * `undefined` when the session store itself is missing, so the answer is unknown.
 */
export function copilotSessionExists(id: string, env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const home = env.COPILOT_HOME || path.join(env.HOME || os.homedir(), ".copilot");
  const store = path.join(home, "session-state");
  if (!isDir(store)) return undefined;
  return isDir(path.join(store, id));
}

/**
 * Whether Claude Code still has a session: `$CLAUDE_CONFIG_DIR/projects/<dir>/<id>.jsonl`
 * (default `~/.claude`). `undefined` when the session store itself is missing.
 */
export function claudeSessionExists(id: string, env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const home = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude");
  const store = path.join(home, "projects");
  if (!isDir(store)) return undefined;
  return fs.readdirSync(store).some((dir) => fs.existsSync(path.join(store, dir, `${id}.jsonl`)));
}

export function sessionExists(host: Host, id: string, env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  return host === "claude" ? claudeSessionExists(id, env) : copilotSessionExists(id, env);
}

/** Host CLI binary: `OPENFLEET_COPILOT_BIN` / `OPENFLEET_CLAUDE_BIN`, else the host's command on PATH. */
export function hostBinary(host: Host = DEFAULT_HOST, env: NodeJS.ProcessEnv = process.env): string {
  return host === "claude" ? env.OPENFLEET_CLAUDE_BIN || "claude" : env.OPENFLEET_COPILOT_BIN || "copilot";
}

/**
 * Oldest Claude Code release with everything OpenFleet relies on: `agent_id`/`agent_type` in hook
 * payloads (2.1.69), SubagentStart `additionalContext` and `SendMessage` (by 2.1.77) and nested
 * subagents on by default (2.1.219).
 */
export const MIN_CLAUDE_VERSION = "2.1.219";

function versionParts(v: string): number[] {
  return v.split(".").map((n) => Number.parseInt(n, 10) || 0);
}

export function compareVersions(a: string, b: string): number {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** Parses `claude --version` output (e.g. `2.1.280 (Claude Code)`). */
export function parseClaudeVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1];
}

/** Refuses Claude Code releases older than MIN_CLAUDE_VERSION. Unknown versions only warn. */
export function checkClaudeVersion(output: string): void {
  const version = parseClaudeVersion(output);
  if (!version) {
    warn(`Could not read the Claude Code version; OpenFleet needs ${MIN_CLAUDE_VERSION} or later.`);
    return;
  }
  if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
    throw new UserError(
      `Claude Code ${version} is too old for OpenFleet (needs ${MIN_CLAUDE_VERSION} or later). ` +
        "Upgrade it with `claude update` and try again.",
    );
  }
}

/**
 * Directories the session's agents work in, passed as `--add-dir` so path verification stays on
 * without prompting: the workspace root, the project's worktrees, cloned repos and known local repos.
 */
export function allowedDirs(ws: Workspace, project?: string): string[] {
  const dirs = new Set<string>();
  const add = (p: string) => {
    if (!isDir(p)) return;
    dirs.add(p);
    dirs.add(realish(p));
  };
  add(ws.root);
  if (project) add(projectPaths(ws, project).worktrees);
  add(ws.repos);
  for (const repo of Object.values(readRepos(ws).repos)) {
    if (repo.path) add(path.resolve(ws.root, repo.path));
  }
  return [...dirs];
}

export function buildCopilotArgs(opts: LaunchOptions): string[] {
  const args = ["--plugin-dir", opts.ws.core, "--agent", qualifiedAgentName(opts.agent)];
  if (opts.sessionId) args.push("--session-id", opts.sessionId);
  if (opts.name && (opts.newSession || !opts.sessionId)) args.push("--name", opts.name);
  // Tools run without prompts; paths stay limited to allowedDirs and URLs still prompt.
  if (!opts.ask) args.push("--allow-all-tools");
  for (const dir of allowedDirs(opts.ws, opts.project)) args.push("--add-dir", dir);
  if (opts.prompt) args.push("-i", opts.prompt);
  args.push(...(opts.passthrough ?? []));
  return args;
}

/**
 * Claude Code args. The prompt goes first because `--add-dir` and `--allowedTools` are variadic.
 * Edits are auto-accepted and Bash is allowed; paths stay limited to allowedDirs. Never
 * `bypassPermissions` or `--dangerously-skip-permissions`.
 */
export function buildClaudeArgs(opts: LaunchOptions): string[] {
  const args = opts.prompt ? [opts.prompt] : [];
  args.push("--plugin-dir", pluginDir(opts.ws, "claude"), "--agent", qualifiedAgentName(opts.agent));
  const fresh = opts.newSession || !opts.sessionId;
  if (opts.sessionId) args.push(fresh ? "--session-id" : "--resume", opts.sessionId);
  if (opts.name && fresh) args.push("--name", opts.name);
  if (!opts.ask) args.push("--permission-mode", "acceptEdits", "--allowedTools", "Bash");
  for (const dir of allowedDirs(opts.ws, opts.project)) args.push("--add-dir", dir);
  args.push(...(opts.passthrough ?? []));
  return args;
}

export function buildArgs(opts: LaunchOptions): string[] {
  return (opts.host ?? DEFAULT_HOST) === "claude" ? buildClaudeArgs(opts) : buildCopilotArgs(opts);
}

export function launchEnv(opts: LaunchOptions, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    OPENFLEET_HOST: opts.host ?? DEFAULT_HOST,
    OPENFLEET_WORKSPACE: opts.ws.root,
    ...(opts.project ? { OPENFLEET_PROJECT: opts.project } : {}),
  };
}

/**
 * Probe git writes from the OpenFleet process itself. If the OS denies them here, the sandbox is
 * inherited from the launching shell and nothing inside the host can fix it, so fail before launching.
 */
export function inheritedSandboxCheck(
  ws: Workspace,
  project?: string,
  env: NodeJS.ProcessEnv = process.env,
  host: Host = DEFAULT_HOST,
): void {
  const denied = deniedChecks(runChecks(ws, project));
  if (!denied.length) return;
  const container = appSandboxContainer(env);
  throw new UserError(
    [
      inheritedSandboxMessage(host),
      ...(container ? [`This process runs inside a macOS App Sandbox (container ${container}).`] : []),
      "",
      "Denied:",
      ...denied.map((c) => `  - ${c.repo ?? "workspace"}: ${c.check} ${c.path} (${c.code})`),
    ].join("\n"),
  );
}

function notFound(host: Host, bin: string): UserError {
  const install =
    host === "claude"
      ? "Install Claude Code (https://code.claude.com)"
      : "Install GitHub Copilot CLI (https://github.com/github/copilot-cli)";
  return new UserError(`Could not find \`${bin}\`. ${install} and try again.`);
}

/** Checks Claude Code's version and that the workspace has its generated plugin. */
function prepareClaude(ws: Workspace, bin: string): void {
  const res = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT") throw notFound("claude", bin);
  checkClaudeVersion(`${res.stdout ?? ""}`);
  if (!fs.existsSync(path.join(pluginDir(ws, "claude"), ".claude-plugin", "plugin.json"))) {
    throw new UserError("This workspace has no Claude Code plugin yet. Run `npx openfleet update` and try again.");
  }
}

/** Launch the host CLI interactively in the workspace root. Returns its exit code. */
export function launch(opts: LaunchOptions): number {
  const host = opts.host ?? DEFAULT_HOST;
  const bin = hostBinary(host);
  // Create the worktrees dir up front so it can be passed to --add-dir before any worktree exists.
  if (opts.project) fs.mkdirSync(projectPaths(opts.ws, opts.project).worktrees, { recursive: true });
  inheritedSandboxCheck(opts.ws, opts.project, process.env, host);
  if (host === "claude") prepareClaude(opts.ws, bin);
  else {
    const sandbox = detectSandbox(opts.passthrough ?? [], opts.ws.root);
    if (sandbox.enabled) warn(sandboxWarning(sandbox.source));
  }
  if (host !== DEFAULT_HOST) out(`Launching ${HOST_LABEL[host]} (${bin}).`);
  const res = spawnSync(bin, buildArgs(opts), {
    cwd: opts.ws.root,
    stdio: "inherit",
    env: launchEnv(opts),
  });
  if (res.error) {
    if ((res.error as NodeJS.ErrnoException).code === "ENOENT") throw notFound(host, bin);
    throw res.error;
  }
  return res.status ?? 1;
}
