import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import semver from "semver";
import { copyDir, isDir, isFile, isInside, readJson, readJsonOr, writeJson } from "./fsutil.js";
import { headSha, isGitRepo } from "./git.js";
import { UserError, type Workspace } from "./workspace.js";
import { HOSTS, isHost, type Host } from "./hosts.js";

export const MANIFEST = "openfleet.extension.json";
export const SLOTS = ["pre-spec", "post-plan", "plans-ready", "pre-implement", "post-test", "post-run"] as const;
/** Slots that run once per child. `pre-spec`, `plans-ready` and `post-run` run once per project. */
export const CHILD_SLOTS: readonly Slot[] = ["post-plan", "pre-implement", "post-test"];
/** Slots whose entries may be blocking: the per-child slots and the `plans-ready` gate. */
export const BLOCKING_SLOTS: readonly Slot[] = [...CHILD_SLOTS, "plans-ready"];
export const ROLES = ["coordinator", "repo-coordinator", "planner", "baseline", "implementer", "tester"] as const;
export const PERMISSIONS = ["read", "write", "shell", "web"] as const;
export const BUILTIN_COMMANDS = [
  "init",
  "update",
  "new",
  "resume",
  "status",
  "list",
  "clean",
  "report",
  "add",
  "remove",
  "extensions",
  "event",
  "state",
  "worktree",
  "ext",
  "next",
  "gate",
  "baseline",
  "claim",
  "ack",
  "scope",
  "merge",
  "escalate",
  "help",
  "version",
];

export type Slot = (typeof SLOTS)[number];
export type ExtRole = (typeof ROLES)[number];
export type Permission = (typeof PERMISSIONS)[number];

export const MANIFEST_VERSION = 2;
export const DEFAULT_TIMEOUT_MINUTES = 30;

export interface PhaseEntry {
  slot: Slot;
  /** Markdown instructions (relative path). */
  instructions: string;
  /** Default false (advisory). A blocking failure fails the child. */
  blocking?: boolean;
  /** Run only if at least one of these paths exists in the child's worktree. */
  when?: { files: string[] };
  /** Default 30. */
  timeoutMinutes?: number;
  /** Agent hosts this phase runs in. Default: every host. */
  hosts?: Host[];
}

export interface AugmentEntry {
  role: ExtRole;
  /** Markdown instructions (relative path), appended to the role's agent prompt. */
  instructions: string;
  /** Agent hosts whose role agent gets these instructions. Default: every host. */
  hosts?: Host[];
}

/** Whether a phase or augment applies to a host (no `hosts` means every host). */
export function forHost(entry: { hosts?: readonly Host[] }, host: Host): boolean {
  return !entry.hosts || entry.hosts.includes(host);
}

function validateHosts(dir: string, raw: unknown, at: string): void {
  if (raw === undefined) return;
  if (
    !Array.isArray(raw) ||
    !raw.length ||
    !raw.every((h) => typeof h === "string" && isHost(h)) ||
    new Set(raw).size !== raw.length
  ) {
    fail(dir, `"${at}.hosts" must be a non-empty list of unique hosts from ${HOSTS.join(", ")}`);
  }
}

export interface SettingDecl {
  default: string;
  description?: string;
}

export interface ExtensionManifest {
  manifest: typeof MANIFEST_VERSION;
  name: string;
  version: string;
  description?: string;
  /** Semver range of compatible @openfleet-tools/cli core versions. */
  core: string;
  phases?: PhaseEntry[];
  augments?: AugmentEntry[];
  /** CLI command name -> Markdown skill (relative path). */
  commands?: Record<string, string>;
  /** Defaults to ["read"]. Applies to every phase agent and command of the extension. */
  permissions?: Permission[];
  settings?: Record<string, SettingDecl>;
}

export interface LockEntry {
  name: string;
  /** Git URL or absolute local path the extension was installed from. */
  source: string;
  /** Pinned commit SHA (git sources) or "local". */
  sha: string;
  /** sha256 of installed contents. */
  hash: string;
  version: string;
  enabled: boolean;
  disabledReason?: string;
  installedAt: string;
}

export interface LockFile {
  v: 1;
  extensions: LockEntry[];
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SETTING_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
const ALLOWED_EXT = new Set([".md", ".json", ".txt", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);
const ALLOWED_BARE = new Set(["LICENSE", "LICENCE", "NOTICE", "COPYING", ".gitignore", ".gitattributes"]);

export function emptyLock(): LockFile {
  return { v: 1, extensions: [] };
}

export function readLock(ws: Workspace): LockFile {
  return readJsonOr<LockFile>(ws.lockFile, emptyLock());
}

export function writeLock(ws: Workspace, lock: LockFile): void {
  writeJson(ws.lockFile, lock);
}

function fail(dir: string, msg: string): never {
  throw new UserError(`Invalid extension at ${dir}: ${msg}`);
}

function relFile(dir: string, rel: unknown, field: string): string {
  if (typeof rel !== "string" || !rel) fail(dir, `"${field}" must be a relative path`);
  const abs = path.resolve(dir, rel);
  if (!isInside(dir, abs)) fail(dir, `"${field}" escapes the extension folder`);
  if (!isFile(abs)) fail(dir, `"${field}" file not found: ${rel}`);
  if (path.extname(abs) !== ".md") fail(dir, `"${field}" must be a Markdown file`);
  return rel;
}

function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) fail(base, `symlinks are not allowed (${path.relative(base, abs)})`);
    if (entry.isDirectory()) walk(abs, base, out);
    else out.push(abs);
  }
  return out;
}

/** Extensions are instruction-only: reject anything that could execute. */
export function assertInstructionOnly(dir: string): void {
  for (const file of walk(dir)) {
    const rel = path.relative(dir, file);
    const base = path.basename(file);
    const ext = path.extname(file).toLowerCase();
    if (!ALLOWED_EXT.has(ext) && !ALLOWED_BARE.has(base)) {
      fail(dir, `only Markdown/JSON/text/image files are allowed; found ${rel}`);
    }
    if ((fs.statSync(file).mode & 0o111) !== 0) fail(dir, `executable files are not allowed (${rel})`);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Build the v2 equivalent of a v1 manifest, for the rejection message. */
function v1Equivalent(m: Record<string, unknown>): string {
  const { mode, slot, role, instructions, ...rest } = m;
  const rel = typeof instructions === "string" ? instructions : "instructions.md";
  const v2: Record<string, unknown> = { manifest: MANIFEST_VERSION, ...rest };
  if (mode === "augment") v2.augments = [{ role, instructions: rel }];
  else v2.phases = [{ slot, instructions: rel }];
  return JSON.stringify(v2, null, 2);
}

function validatePhase(dir: string, raw: unknown, i: number): PhaseEntry {
  const at = `phases[${i}]`;
  if (!isObject(raw)) fail(dir, `"${at}" must be an object`);
  for (const k of Object.keys(raw)) {
    if (!["slot", "instructions", "blocking", "when", "timeoutMinutes", "hosts"].includes(k))
      fail(dir, `unknown field "${at}.${k}"`);
  }
  if (!SLOTS.includes(raw.slot as Slot)) fail(dir, `"${at}.slot" must be one of ${SLOTS.join(", ")}`);
  relFile(dir, raw.instructions, `${at}.instructions`);
  if (raw.blocking !== undefined && typeof raw.blocking !== "boolean") fail(dir, `"${at}.blocking" must be a boolean`);
  if (raw.blocking === true && !BLOCKING_SLOTS.includes(raw.slot as Slot)) {
    fail(dir, `"${at}.blocking" is only supported in the slots ${BLOCKING_SLOTS.join(", ")}`);
  }
  if (raw.when !== undefined) {
    const files = isObject(raw.when) ? raw.when.files : undefined;
    if (
      !isObject(raw.when) ||
      Object.keys(raw.when).some((k) => k !== "files") ||
      !Array.isArray(files) ||
      !files.length ||
      !files.every((f) => typeof f === "string" && f && !path.isAbsolute(f) && !f.split(/[\\/]/).includes(".."))
    ) {
      fail(dir, `"${at}.when" must be { "files": [<relative paths>] }`);
    }
  }
  if (
    raw.timeoutMinutes !== undefined &&
    (typeof raw.timeoutMinutes !== "number" || !Number.isInteger(raw.timeoutMinutes) || raw.timeoutMinutes < 1)
  ) {
    fail(dir, `"${at}.timeoutMinutes" must be a positive integer`);
  }
  validateHosts(dir, raw.hosts, at);
  return raw as unknown as PhaseEntry;
}

function validateAugment(dir: string, raw: unknown, i: number): AugmentEntry {
  const at = `augments[${i}]`;
  if (!isObject(raw)) fail(dir, `"${at}" must be an object`);
  for (const k of Object.keys(raw)) {
    if (!["role", "instructions", "hosts"].includes(k)) fail(dir, `unknown field "${at}.${k}"`);
  }
  if (!ROLES.includes(raw.role as ExtRole)) fail(dir, `"${at}.role" must be one of ${ROLES.join(", ")}`);
  relFile(dir, raw.instructions, `${at}.instructions`);
  validateHosts(dir, raw.hosts, at);
  return raw as unknown as AugmentEntry;
}

export function validateManifest(dir: string): ExtensionManifest {
  const file = path.join(dir, MANIFEST);
  if (!isFile(file)) fail(dir, `missing ${MANIFEST}`);
  let m: Record<string, unknown>;
  try {
    m = readJson<Record<string, unknown>>(file);
  } catch (err) {
    fail(dir, `${MANIFEST} is not valid JSON (${(err as Error).message})`);
  }
  if (m.manifest !== MANIFEST_VERSION) {
    if (m.manifest === undefined && (m.mode !== undefined || m.slot !== undefined || m.role !== undefined)) {
      fail(
        dir,
        `manifest version 1 ("mode"/"slot"/"role") is no longer supported. Use manifest version 2, for example:\n${v1Equivalent(m)}`,
      );
    }
    fail(dir, `"manifest" must be ${MANIFEST_VERSION}`);
  }
  for (const k of ["mode", "slot", "role", "instructions"]) {
    if (m[k] !== undefined) fail(dir, `"${k}" is not a manifest v2 field; use "phases" and "augments"`);
  }
  if (typeof m.name !== "string" || !NAME.test(m.name)) fail(dir, `"name" must match ${NAME}`);
  if (typeof m.version !== "string" || !semver.valid(m.version)) fail(dir, `"version" must be a semver version`);
  if (typeof m.core !== "string" || !semver.validRange(m.core)) fail(dir, `"core" must be a semver range`);
  if (m.description !== undefined && typeof m.description !== "string") fail(dir, `"description" must be a string`);
  if (m.phases !== undefined && !Array.isArray(m.phases)) fail(dir, `"phases" must be an array`);
  if (m.augments !== undefined && !Array.isArray(m.augments)) fail(dir, `"augments" must be an array`);
  const phases = ((m.phases ?? []) as unknown[]).map((p, i) => validatePhase(dir, p, i));
  const augments = ((m.augments ?? []) as unknown[]).map((a, i) => validateAugment(dir, a, i));
  if (!phases.length && !augments.length) fail(dir, `at least one "phases" or "augments" entry is required`);
  if (m.commands !== undefined) {
    if (!isObject(m.commands)) fail(dir, `"commands" must be an object of name -> skill.md`);
    for (const [cmd, skill] of Object.entries(m.commands)) {
      if (!NAME.test(cmd)) fail(dir, `command name "${cmd}" must match ${NAME}`);
      if (BUILTIN_COMMANDS.includes(cmd)) fail(dir, `command "${cmd}" collides with a built-in command`);
      relFile(dir, skill, `commands.${cmd}`);
    }
  }
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions) || !m.permissions.every((p) => PERMISSIONS.includes(p as Permission))) {
      fail(dir, `"permissions" must be a subset of ${PERMISSIONS.join(", ")}`);
    }
  }
  if (m.settings !== undefined) {
    if (!isObject(m.settings)) fail(dir, `"settings" must be an object of key -> { default, description }`);
    for (const [key, decl] of Object.entries(m.settings)) {
      if (!SETTING_KEY.test(key)) fail(dir, `setting key "${key}" must match ${SETTING_KEY}`);
      if (!isObject(decl) || typeof decl.default !== "string") fail(dir, `"settings.${key}.default" must be a string`);
      if (decl.description !== undefined && typeof decl.description !== "string") {
        fail(dir, `"settings.${key}.description" must be a string`);
      }
    }
  }
  assertInstructionOnly(dir);
  return m as unknown as ExtensionManifest;
}

/** Generated agent name for each phase entry, in manifest order. Unique per entry. */
export function phaseAgentNames(m: ExtensionManifest): string[] {
  const seen: Record<string, number> = {};
  return (m.phases ?? []).map((p) => {
    const n = (seen[p.slot] = (seen[p.slot] ?? 0) + 1);
    return `openfleet-ext-${m.name}-${p.slot}${n > 1 ? `-${n}` : ""}`;
  });
}

// ---------------------------------------------------------------- settings

export const SETTINGS_FILE = "extensions.config.json";

export type ExtensionsConfig = Record<string, Record<string, string>>;

export function readExtensionsConfig(ws: Workspace): ExtensionsConfig {
  const file = path.join(ws.root, SETTINGS_FILE);
  if (!isFile(file)) return {};
  let raw: unknown;
  try {
    raw = readJson<unknown>(file);
  } catch (err) {
    throw new UserError(`openfleet/${SETTINGS_FILE} is not valid JSON (${(err as Error).message})`);
  }
  if (!isObject(raw)) throw new UserError(`openfleet/${SETTINGS_FILE} must be an object of extension -> settings`);
  for (const [ext, values] of Object.entries(raw)) {
    if (!isObject(values) || !Object.values(values).every((v) => typeof v === "string")) {
      throw new UserError(`openfleet/${SETTINGS_FILE}: "${ext}" must be an object of key -> string value`);
    }
  }
  return raw as ExtensionsConfig;
}

/** Declared defaults overlaid with workspace overrides. Rejects override keys the manifest does not declare. */
export function resolveSettings(m: ExtensionManifest, config: ExtensionsConfig): Record<string, string> {
  const decls = m.settings ?? {};
  const overrides = config[m.name] ?? {};
  for (const key of Object.keys(overrides)) {
    if (!(key in decls)) {
      const known = Object.keys(decls);
      throw new UserError(
        `openfleet/${SETTINGS_FILE}: extension "${m.name}" does not declare setting "${key}"` +
          (known.length ? ` (declared: ${known.join(", ")})` : " (it declares no settings)"),
      );
    }
  }
  return Object.fromEntries(Object.entries(decls).map(([k, d]) => [k, overrides[k] ?? d.default]));
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Markdown `## Settings` section for an extension's prompts, or "" when it declares none. */
export function settingsSection(m: ExtensionManifest, values: Record<string, string>): string {
  const keys = Object.keys(m.settings ?? {});
  if (!keys.length) return "";
  const rows = keys.map((k) => `| \`${k}\` | ${cell(values[k] ?? "")} | ${cell(m.settings![k]!.description ?? "")} |`);
  return [
    `## Settings`,
    "",
    `Resolved settings for extension \`${m.name}\` (workspace overrides from \`openfleet/${SETTINGS_FILE}\`):`,
    "",
    "| Key | Value | Description |",
    "| --- | ----- | ----------- |",
    ...rows,
  ].join("\n");
}

export function permissionsOf(m: ExtensionManifest): Permission[] {
  const set = new Set<Permission>(["read", ...(m.permissions ?? [])]);
  return PERMISSIONS.filter((p) => set.has(p));
}

/** Map declared permissions to a Copilot custom-agent tool allow-list. */
export function toolsFor(perms: Permission[]): string[] {
  const tools = ["read", "search"];
  if (perms.includes("write")) tools.push("edit");
  if (perms.includes("shell")) tools.push("execute");
  if (perms.includes("web")) tools.push("web");
  return tools;
}

export function describePermissions(m: ExtensionManifest): string {
  const perms = permissionsOf(m);
  const lines = perms.map((p) => {
    switch (p) {
      case "read":
        return "  - read: read and search files";
      case "write":
        return "  - write: create and edit files";
      case "shell":
        return "  - shell: run shell commands";
      case "web":
        return "  - web: fetch URLs / search the web";
    }
  });
  return lines.join("\n");
}

export function isCompatible(m: ExtensionManifest, coreVersion: string): boolean {
  return semver.satisfies(coreVersion, m.core, { includePrerelease: true });
}

function hashDir(dir: string): string {
  const h = crypto.createHash("sha256");
  for (const file of walk(dir).sort()) {
    h.update(path.relative(dir, file).split(path.sep).join("/"));
    h.update("\0");
    h.update(fs.readFileSync(file));
    h.update("\0");
  }
  return h.digest("hex");
}

function looksLikePath(source: string): boolean {
  return (
    source.startsWith(".") ||
    source.startsWith("/") ||
    source.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(source) ||
    isDir(path.resolve(source))
  );
}

interface Fetched {
  dir: string;
  source: string;
  sha: string;
  cleanup: () => void;
}

function fetchSource(source: string, cwd: string): Fetched {
  if (looksLikePath(source)) {
    const abs = path.resolve(cwd, source.replace(/^~(?=$|\/)/, os.homedir()));
    if (!isDir(abs)) throw new UserError(`Extension path not found: ${abs}`);
    const sha = isGitRepo(abs) ? (headSha(abs) ?? "local") : "local";
    return { dir: abs, source: abs, sha, cleanup: () => {} };
  }
  const [url, ref] = source.split("#") as [string, string | undefined];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openfleet-ext-"));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  try {
    execFileSync("git", ["clone", "--quiet", url, tmp], { stdio: ["ignore", "ignore", "pipe"] });
    if (ref) execFileSync("git", ["checkout", "--quiet", ref], { cwd: tmp, stdio: ["ignore", "ignore", "pipe"] });
    const sha = headSha(tmp);
    if (!sha) throw new Error("could not resolve HEAD");
    return { dir: tmp, source: url, sha, cleanup };
  } catch (err) {
    cleanup();
    const stderr = String((err as { stderr?: string | Buffer }).stderr ?? (err as Error).message).trim();
    throw new UserError(`Failed to fetch extension from ${source}: ${stderr}`);
  }
}

export interface AddResult {
  entry: LockEntry;
  manifest: ExtensionManifest;
  replaced: boolean;
}

export function addExtension(ws: Workspace, source: string, coreVersion: string, cwd = process.cwd()): AddResult {
  const fetched = fetchSource(source, cwd);
  try {
    const manifest = validateManifest(fetched.dir);
    if (!isCompatible(manifest, coreVersion)) {
      throw new UserError(
        `Extension "${manifest.name}" requires core ${manifest.core}, but installed core is ${coreVersion}.`,
      );
    }
    const dest = path.join(ws.extensions, manifest.name);
    fs.rmSync(dest, { recursive: true, force: true });
    copyDir(fetched.dir, dest, (rel) => rel === ".git" || rel.startsWith(`.git${path.sep}`));
    const lock = readLock(ws);
    const entry: LockEntry = {
      name: manifest.name,
      source: fetched.source,
      sha: fetched.sha,
      hash: hashDir(dest),
      version: manifest.version,
      enabled: true,
      installedAt: new Date().toISOString(),
    };
    const idx = lock.extensions.findIndex((e) => e.name === manifest.name);
    if (idx >= 0) lock.extensions[idx] = entry;
    else lock.extensions.push(entry);
    writeLock(ws, lock);
    return { entry, manifest, replaced: idx >= 0 };
  } finally {
    fetched.cleanup();
  }
}

export function removeExtension(ws: Workspace, name: string): void {
  const lock = readLock(ws);
  const idx = lock.extensions.findIndex((e) => e.name === name);
  if (idx < 0 && !isDir(path.join(ws.extensions, name))) {
    throw new UserError(`Extension "${name}" is not installed.`);
  }
  if (idx >= 0) lock.extensions.splice(idx, 1);
  writeLock(ws, lock);
  fs.rmSync(path.join(ws.extensions, name), { recursive: true, force: true });
}

export interface LoadedExtension {
  entry: LockEntry;
  manifest: ExtensionManifest;
  dir: string;
}

/** Enabled, valid extensions in lock order. Invalid ones are reported via `warn`. */
export function loadExtensions(ws: Workspace, warn: (msg: string) => void = () => {}): LoadedExtension[] {
  const out: LoadedExtension[] = [];
  for (const entry of readLock(ws).extensions) {
    if (!entry.enabled) continue;
    const dir = path.join(ws.extensions, entry.name);
    try {
      out.push({ entry, manifest: validateManifest(dir), dir });
    } catch (err) {
      warn(`Skipping extension "${entry.name}": ${(err as Error).message}`);
    }
  }
  return out;
}

/** Disable extensions whose `core` range excludes `coreVersion`. Returns names disabled. */
export function disableIncompatible(ws: Workspace, coreVersion: string): string[] {
  const lock = readLock(ws);
  const disabled: string[] = [];
  for (const entry of lock.extensions) {
    if (!entry.enabled) continue;
    const dir = path.join(ws.extensions, entry.name);
    let reason: string | undefined;
    try {
      const m = validateManifest(dir);
      if (!isCompatible(m, coreVersion)) reason = `requires core ${m.core}, installed core is ${coreVersion}`;
    } catch (err) {
      reason = (err as Error).message;
    }
    if (reason) {
      entry.enabled = false;
      entry.disabledReason = reason;
      disabled.push(entry.name);
    }
  }
  if (disabled.length) writeLock(ws, lock);
  return disabled;
}
