// Copilot CLI's command sandbox (enabled with `/sandbox enable`, `--sandbox` or a managed
// policy) can block writes inside `.git`. `--add-dir` only affects Copilot's path
// verification, not the sandbox, so OpenFleet detects what it can and explains the rest.
// The process tree can also inherit an OS sandbox from the shell that started OpenFleet.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_HOST, HOST_LABEL, isHost, type Host } from "./hosts.js";

/** Host of the current session: set by the launcher in `OPENFLEET_HOST`, default Copilot. */
export function currentHost(env: NodeJS.ProcessEnv = process.env): Host {
  const v = env.OPENFLEET_HOST;
  return v && isHost(v) ? v : DEFAULT_HOST;
}

const HOST_SANDBOX_CAUSE: Record<Host, string[]> = {
  copilot: [
    "  2. Copilot CLI's command sandbox is on. Run `/sandbox disable`, start without `--sandbox`, or add the",
    "     repo paths to `sandbox.userPolicy.filesystem.readwritePaths` in ~/.copilot/settings.json (the",
    "     sandbox may still protect .git, which git needs for ref locks and worktrees).",
  ],
  claude: [
    "  2. Claude Code's sandbox is on (`sandbox.enabled` in its settings). Turn it off with `/sandbox`, or",
    "     allow writes to the repo paths in its sandbox settings (the sandbox may still protect .git, which",
    "     git needs for ref locks and worktrees).",
  ],
};

export function sandboxHint(host: Host = currentHost()): string {
  const label = HOST_LABEL[host];
  return [
    'Writes were denied with EPERM ("Operation not permitted"): a sandbox is blocking them. Likely causes, in order:',
    `  1. OpenFleet or ${label} was started from a sandboxed shell (an IDE or app-embedded terminal, or an`,
    "     agent's shell), so the whole process tree is sandboxed. Start it from a normal terminal.",
    ...HOST_SANDBOX_CAUSE[host],
    "  3. A managed OS policy on this device. Ask your administrator.",
    "Full Disk Access does not fix this.",
  ].join("\n");
}

export function inheritedSandboxMessage(host: Host = currentHost()): string {
  const label = HOST_LABEL[host];
  return [
    `OpenFleet cannot write where git needs to, even before ${label} starts, so the sandbox is inherited`,
    `from the shell that launched it and nothing inside ${label} can fix it. Start \`npx openfleet\` from a`,
    "normal terminal (not an IDE, app-embedded or agent shell). If it still fails there, a managed OS",
    "policy is blocking the writes. Full Disk Access does not fix this.",
  ].join("\n");
}

/** Copilot wording, kept for callers that predate host support. */
export const SANDBOX_HINT = sandboxHint("copilot");
export const INHERITED_SANDBOX_MESSAGE = inheritedSandboxMessage("copilot");

export const PERMISSIONS_HINT =
  "File permissions deny this access. Check the owner and mode of the path (`ls -ld <path>`) and fix them.";

/** "Operation not permitted" (EPERM) is what the sandbox returns; plain permission errors are EACCES. */
export function isSandboxDenial(text: string): boolean {
  return /Operation not permitted|\bEPERM\b/.test(text);
}

export function hintFor(codeOrText: string, host: Host = currentHost()): string | undefined {
  if (isSandboxDenial(codeOrText)) return sandboxHint(host);
  if (/\bEACCES\b|Permission denied/.test(codeOrText)) return PERMISSIONS_HINT;
  return undefined;
}

export interface SandboxDetection {
  /** `true`: sandboxing is on; `false`: explicitly off for this session; `undefined`: unknown. */
  enabled: boolean | undefined;
  source?: string;
}

function settingEnabled(file: string): boolean | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const nested = (json.sandbox as { enabled?: unknown } | undefined)?.enabled;
    const value = typeof nested === "boolean" ? nested : json["sandbox.enabled"];
    return typeof value === "boolean" ? value : undefined;
  } catch {
    // JSON with comments: fall back to a plain match.
    const m = /"sandbox(?:\.enabled"\s*:|"\s*:\s*\{[^}]*"enabled"\s*:)\s*(true|false)/.exec(text);
    return m ? m[1] === "true" : undefined;
  }
}

/**
 * Best-effort: the `--sandbox`/`--no-sandbox` flags win, then the user's `settings.json`
 * (`$COPILOT_HOME`, default `~/.copilot`) and the workspace's `.github/copilot/settings*.json`.
 * Enterprise-managed policies cannot be read reliably, so `npx openfleet preflight` checks the
 * actual writes inside the session.
 */
export function detectSandbox(
  passthrough: readonly string[],
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): SandboxDetection {
  if (passthrough.includes("--no-sandbox")) return { enabled: false, source: "--no-sandbox" };
  if (passthrough.includes("--sandbox")) return { enabled: true, source: "--sandbox" };
  const home = env.COPILOT_HOME || path.join(env.HOME || os.homedir(), ".copilot");
  const files = [
    path.join(workspaceRoot, ".github", "copilot", "settings.local.json"),
    path.join(workspaceRoot, ".github", "copilot", "settings.json"),
    path.join(home, "settings.json"),
  ];
  for (const file of files) {
    const v = settingEnabled(file);
    if (v !== undefined) return { enabled: v, source: file };
  }
  return { enabled: undefined };
}

export function sandboxWarning(source: string | undefined): string {
  return [
    `Copilot CLI's command sandbox looks enabled (${source ?? "unknown source"}).`,
    "OpenFleet creates git worktrees, which needs writes inside each repo's .git directory, and the",
    "sandbox may block them (`--add-dir` does not change the sandbox). If `npx openfleet preflight`",
    "fails in the session: run `/sandbox disable`, start without `--sandbox` (or pass `-- --no-sandbox`),",
    "or add the repo paths to `sandbox.userPolicy.filesystem.readwritePaths` in ~/.copilot/settings.json.",
  ].join("\n");
}

/** macOS App Sandbox sets this for every sandboxed app and its child processes. */
export function appSandboxContainer(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.APP_SANDBOX_CONTAINER_ID || undefined;
}
