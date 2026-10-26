import fs from "node:fs";
import path from "node:path";
import { installCore, installedCoreVersion, packageVersion } from "../core.js";
import { disableIncompatible, emptyLock, SETTINGS_FILE } from "../extensions.js";
import { parseHost, readConfig, setConfig, writeWorkspaceVersion } from "../config.js";
import { DEFAULT_HOST, HOST_LABEL, HOSTS, type Host } from "../hosts.js";
import { realish, writeJson } from "../fsutil.js";
import { emptyRepos } from "../repos.js";
import { findWorkspace, MARKER, requireWorkspace, UserError, workspaceAt, type Workspace } from "../workspace.js";
import { out, warn } from "./output.js";

export const WORKSPACE_GITIGNORE = `# Managed by OpenFleet
node_modules/
core/
repos/
projects/*/worktrees/
projects/*/patches/
projects/*/.events.seq
projects/*/.*.lock
.hook-errors.log
`;

/** Entries `init` creates in the workspace root; any of them in a folder without openfleet.json is a clash. */
const MANAGED_ENTRIES = [
  "core",
  "extensions",
  "projects",
  "repos",
  "repos.json",
  "extensions.lock.json",
  SETTINGS_FILE,
  `${MARKER}.lock`,
];

function clashes(root: string): string[] {
  return MANAGED_ENTRIES.filter((name) => fs.existsSync(path.join(root, name)));
}

/** Lines of WORKSPACE_GITIGNORE that an existing .gitignore does not contain. */
export function missingGitignoreLines(file: string): string[] {
  const have = new Set(
    fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim()),
  );
  return WORKSPACE_GITIGNORE.split("\n").filter((l) => l && !l.startsWith("#") && !have.has(l));
}

function ensureFile(file: string, write: () => void): boolean {
  if (fs.existsSync(file)) return false;
  write();
  return true;
}

export interface InitResult {
  ws: Workspace;
  created: boolean;
  /** True when init wrote `.gitignore`; false when one already existed (the suggested lines are printed instead). */
  gitignoreWritten: boolean;
}

/** Scaffold an OpenFleet workspace in `root` (idempotent) and install core. */
export function initWorkspace(root: string): InitResult {
  const existing = findWorkspace(root);
  if (existing && existing.root !== realish(root)) {
    warn(`Already inside the OpenFleet workspace at ${existing.root}; initializing there.`);
  }
  if (!existing) {
    const found = clashes(root);
    if (found.length) {
      throw new UserError(
        `Cannot create an OpenFleet workspace in ${realish(root)}: it already contains ${found.join(", ")}.\n` +
          "Run it in an empty folder or a new subfolder instead.",
      );
    }
  }
  const ws = existing ?? workspaceAt(realish(root));
  const created = !existing;
  fs.mkdirSync(ws.extensions, { recursive: true });
  fs.mkdirSync(ws.projects, { recursive: true });
  for (const dir of [ws.extensions, ws.projects]) {
    ensureFile(path.join(dir, ".gitkeep"), () => fs.writeFileSync(path.join(dir, ".gitkeep"), ""));
  }
  ensureFile(ws.reposFile, () => writeJson(ws.reposFile, emptyRepos()));
  ensureFile(ws.lockFile, () => writeJson(ws.lockFile, emptyLock()));
  writeWorkspaceVersion(ws, packageVersion());
  const gi = path.join(ws.root, ".gitignore");
  const gitignoreWritten = ensureFile(gi, () => fs.writeFileSync(gi, WORKSPACE_GITIGNORE));
  installCore(ws, warn);
  return { ws, created, gitignoreWritten };
}

export interface InitOptions {
  /** `--host`: skips the prompt and overrides the saved host. */
  host?: string;
  /** Whether init may ask which host to use (a TTY outside CI). */
  interactive?: boolean;
  /** Reads one answer; `undefined` means end of input. */
  ask?: (question: string) => string | undefined;
}

const HOST_QUESTION =
  "Which agent host should this workspace use?\n" +
  HOSTS.map((h, i) => `  ${i + 1}) ${HOST_LABEL[h]} (${h})`).join("\n") +
  `\nHost [${DEFAULT_HOST}]: `;

/** Map a prompt answer to a host: a number, a host name or empty for the default; `null` when invalid. */
export function hostFromAnswer(answer: string): Host | null {
  const a = answer.trim().toLowerCase();
  if (!a) return DEFAULT_HOST;
  if (/^\d+$/.test(a)) return HOSTS[Number(a) - 1] ?? null;
  return (HOSTS as readonly string[]).includes(a) ? (a as Host) : null;
}

/**
 * Host init saves: `--host` wins; an existing workspace keeps its setting; a new one asks
 * when interactive and otherwise uses the default. `undefined` means leave openfleet.json as is.
 */
export function resolveInitHost(created: boolean, opts: InitOptions): Host | undefined {
  if (opts.host !== undefined) return parseHost(opts.host);
  if (!created) return undefined;
  if (!opts.interactive || !opts.ask) return DEFAULT_HOST;
  for (;;) {
    const answer = opts.ask(HOST_QUESTION);
    if (answer === undefined) return DEFAULT_HOST;
    const host = hostFromAnswer(answer);
    if (host) return host;
    warn(`Answer 1, 2, ${HOSTS.join(" or ")}.`);
  }
}

/** Read one line from stdin synchronously; `undefined` at end of input or when stdin cannot be read. */
export function readLineSync(question: string): string | undefined {
  process.stdout.write(question);
  const buf = Buffer.alloc(1);
  let line = "";
  for (;;) {
    let n: number;
    try {
      n = fs.readSync(0, buf, 0, 1, null);
    } catch (err) {
      // A TTY stdin may be non-blocking: wait for the user to type instead of giving up.
      if ((err as NodeJS.ErrnoException).code === "EAGAIN") {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        continue;
      }
      return line || undefined;
    }
    if (n === 0) return line || undefined;
    const ch = buf.toString("utf8");
    if (ch === "\n") return line.replace(/\r$/, "");
    line += ch;
  }
}

export function cmdInit(opts: InitOptions = {}): number {
  if (opts.host !== undefined) parseHost(opts.host);
  const { ws, created, gitignoreWritten } = initWorkspace(process.cwd());
  const interactive = opts.interactive ?? (Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI);
  const chosen = resolveInitHost(created, { ask: readLineSync, ...opts, interactive });
  const host = chosen === undefined ? readConfig(ws).host : setConfig(ws, "host", chosen).host;
  out(`${created ? "Created" : "Refreshed"} OpenFleet workspace at ${ws.root} (core ${packageVersion()}).`);
  out(`Host: ${HOST_LABEL[host]} (change it with \`npx openfleet config set host <${HOSTS.join("|")}>\`).`);
  const missing = gitignoreWritten ? [] : missingGitignoreLines(path.join(ws.root, ".gitignore"));
  if (missing.length) {
    out("");
    out(`${path.join(ws.root, ".gitignore")} already exists; OpenFleet left it unchanged. Consider adding:`);
    for (const line of missing) out(`  ${line}`);
  }
  out("");
  out("Next:");
  out('  npx openfleet new <project-name> "<what you want to change>"');
  return 0;
}

export function cmdUpdate(): number {
  const ws = requireWorkspace();
  const before = installedCoreVersion(ws);
  const version = packageVersion();
  const disabled = disableIncompatible(ws, version);
  for (const name of disabled) {
    warn(
      `Disabled extension "${name}": not compatible with core ${version}. Update it, then \`npx openfleet add\` it again.`,
    );
  }
  installCore(ws, warn);
  writeWorkspaceVersion(ws, version);
  out(`Updated OpenFleet core ${before ?? "(none)"} → ${version}.`);
  return 0;
}

const CONFIG_USAGE = "Usage: npx openfleet config | npx openfleet config set <key> <value>";

/** `config` prints the effective workspace settings; `config set <key> <value>` validates and writes one. */
export function cmdConfig(args: string[]): number {
  const ws = requireWorkspace();
  if (!args.length) {
    out(JSON.stringify(readConfig(ws), null, 2));
    return 0;
  }
  const [sub, key, value, ...extra] = args;
  if (sub !== "set" || !key || value === undefined || extra.length) throw new UserError(CONFIG_USAGE);
  out(JSON.stringify(setConfig(ws, key, value), null, 2));
  return 0;
}
