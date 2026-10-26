// `copyFiles`: local, uncommitted files (env files, credentials) copied from a repo's main
// checkout into each worktree. They must never be staged, committed or logged.
import fs from "node:fs";
import path from "node:path";
import { isFile, isInside, realish } from "./fsutil.js";
import { git, tryGit } from "./git.js";
import type { ProjectPaths } from "./workspace.js";

const EXCLUDE_MARKER = "# openfleet copyFiles";

/** Normalised repo-relative path, or an error message. */
export function checkCopyPath(raw: unknown): { rel: string } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "must be a non-empty string" };
  if (path.isAbsolute(raw)) return { error: "must be relative to the repo root" };
  const rel = path.posix.normalize(raw.replace(/\\/g, "/"));
  if (rel === "." || rel.startsWith("../") || rel === "..") return { error: "must stay inside the repo" };
  if (rel.split("/").includes(".git")) return { error: "must not point into .git" };
  return { rel };
}

export interface CopyResult {
  copied: string[];
  missing: string[];
  invalid: { path: string; error: string }[];
}

/**
 * Copy `files` from `repoPath` into `worktree` (refreshing earlier copies), then keep git from
 * ever staging them: tracked files get `--skip-worktree` in the worktree's own index, untracked
 * files are added to the repository's `info/exclude`.
 */
export function copyIntoWorktree(repoPath: string, worktree: string, files: readonly unknown[]): CopyResult {
  const result: CopyResult = { copied: [], missing: [], invalid: [] };
  for (const raw of files) {
    const checked = checkCopyPath(raw);
    if ("error" in checked) {
      result.invalid.push({ path: String(raw), error: checked.error });
      continue;
    }
    const { rel } = checked;
    const src = path.join(repoPath, rel);
    if (!isFile(src) || !isInside(realish(repoPath), realish(src))) {
      result.missing.push(rel);
      continue;
    }
    const dest = path.join(worktree, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    protect(worktree, rel);
    result.copied.push(rel);
  }
  return result;
}

function isTracked(worktree: string, rel: string): boolean {
  return tryGit(worktree, ["ls-files", "--error-unmatch", "--", rel]) !== undefined;
}

function protect(worktree: string, rel: string): void {
  if (isTracked(worktree, rel)) {
    git(worktree, ["update-index", "--skip-worktree", "--", rel]);
    return;
  }
  const exclude = path.resolve(worktree, git(worktree, ["rev-parse", "--git-path", "info/exclude"]).trim());
  const line = `/${rel}`;
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  if (current.split("\n").includes(line)) return;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  const marker = current.includes(EXCLUDE_MARKER) ? "" : `${EXCLUDE_MARKER}\n`;
  fs.appendFileSync(exclude, `${prefix}${marker}${line}\n`);
}

const ENV_LINE = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*[=:]\s*(.+?)\s*$/;
const JSON_PAIR = /"[^"\n]+"\s*:\s*"([^"\n]+)"/g;
const MIN_SECRET = 6;

function unquote(v: string): string {
  const t = v.replace(/\s+#.*$/, "").trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

/** Values that look like secrets in an env, YAML or JSON file. Short and boolean/numeric values are ignored. */
export function secretValues(text: string): string[] {
  const out = new Set<string>();
  const add = (v: string) => {
    if (v.length >= MIN_SECRET && !/^(true|false|null|\d+(\.\d+)?)$/i.test(v)) out.add(v);
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = ENV_LINE.exec(line);
    if (m) add(unquote(m[1]!));
  }
  for (const m of text.matchAll(JSON_PAIR)) add(m[1]!);
  return [...out];
}

interface StateLike {
  children?: Record<string, { worktree?: string; copiedFiles?: string[] }>;
}

/** Secret values from every copied file of the project, longest first, for redaction. */
export function copiedSecrets(p: ProjectPaths): string[] {
  let state: StateLike;
  try {
    state = JSON.parse(fs.readFileSync(p.state, "utf8")) as StateLike;
  } catch {
    return [];
  }
  const values = new Set<string>();
  for (const child of Object.values(state.children ?? {})) {
    if (!child.worktree || !child.copiedFiles?.length) continue;
    for (const rel of child.copiedFiles) {
      const file = path.join(child.worktree, rel);
      try {
        if (fs.statSync(file).size > 256 * 1024) continue;
        for (const v of secretValues(fs.readFileSync(file, "utf8"))) values.add(v);
      } catch {
        // missing or unreadable: nothing to redact
      }
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}
