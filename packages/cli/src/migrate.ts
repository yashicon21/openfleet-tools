// Schema versions of the workspace's JSON files, and their migrations. Readers refuse a file whose
// schema differs from this CLI's: newer means "upgrade the CLI", older means "run `npx openfleet
// update`", which migrates every file in place (keeping a `.v<N>.bak` copy of each original).
// events.jsonl is append-only and never rewritten: new fields are only ever added to events.
import fs from "node:fs";
import { readJson, writeJson } from "./fsutil.js";
import { listProjectNames, projectPaths, UserError, type Workspace } from "./workspace.js";

export type SchemaKind = "state" | "repos" | "lock";

/** Current schema version per file kind. Bump it together with a migration below. */
export const SCHEMA_VERSIONS: Record<SchemaKind, number> = { state: 1, repos: 1, lock: 1 };

export interface Migration {
  /** Version this step reads; it writes `from + 1`. */
  from: number;
  up(doc: Record<string, unknown>): Record<string, unknown>;
}

/** Steps per file kind, oldest first. Empty while every schema is still at v1. */
export const MIGRATIONS: Record<SchemaKind, Migration[]> = { state: [], repos: [], lock: [] };

const LABEL: Record<SchemaKind, string> = {
  state: "project state",
  repos: "repos.json",
  lock: "extensions.lock.json",
};

function versionOf(doc: unknown): number | undefined {
  const v = (doc as { v?: unknown } | null)?.v;
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

/** Refuse a file this CLI cannot read as it is. `current` is injectable for tests. */
export function checkSchema(kind: SchemaKind, file: string, doc: unknown, current = SCHEMA_VERSIONS[kind]): void {
  const v = versionOf(doc);
  if (v === undefined)
    throw new UserError(`${file} has no schema version ("v"); it is not an OpenFleet ${LABEL[kind]} file.`);
  if (v > current) {
    throw new UserError(
      `${file} was written by a newer OpenFleet (${LABEL[kind]} schema v${v}; this CLI reads v${current}). ` +
        "Upgrade the CLI: `npm install @openfleet-tools/cli@latest`, then run `npx openfleet update`.",
    );
  }
  if (v < current) {
    throw new UserError(
      `${file} uses an older ${LABEL[kind]} schema (v${v}; this CLI reads v${current}). Run \`npx openfleet update\` to migrate the workspace.`,
    );
  }
}

export interface MigratedFile {
  file: string;
  kind: SchemaKind;
  from: number;
  to: number;
  backup: string;
}

/** Bring one file up to `current`, writing a backup of the original first. */
export function migrateFile(
  kind: SchemaKind,
  file: string,
  migrations: Migration[] = MIGRATIONS[kind],
  current = SCHEMA_VERSIONS[kind],
): MigratedFile | undefined {
  if (!fs.existsSync(file)) return undefined;
  let doc = readJson<Record<string, unknown>>(file);
  const from = versionOf(doc);
  if (from === undefined || from >= current) {
    checkSchema(kind, file, doc, current);
    return undefined;
  }
  for (let v = from; v < current; v++) {
    const step = migrations.find((m) => m.from === v);
    if (!step) throw new UserError(`No migration for ${LABEL[kind]} schema v${v} → v${v + 1} (${file}).`);
    doc = { ...step.up(doc), v: v + 1 };
  }
  const backup = `${file}.v${from}.bak`;
  fs.copyFileSync(file, backup);
  writeJson(file, doc);
  return { file, kind, from, to: current, backup };
}

/** Migrate repos.json, extensions.lock.json and every project's state.json (run by `update`). */
export function migrateWorkspace(
  ws: Workspace,
  migrations: Record<SchemaKind, Migration[]> = MIGRATIONS,
  current: Record<SchemaKind, number> = SCHEMA_VERSIONS,
): MigratedFile[] {
  const files: [SchemaKind, string][] = [
    ["repos", ws.reposFile],
    ["lock", ws.lockFile],
    ...listProjectNames(ws).map((name): [SchemaKind, string] => ["state", projectPaths(ws, name).state]),
  ];
  const out: MigratedFile[] = [];
  for (const [kind, file] of files) {
    const m = migrateFile(kind, file, migrations[kind], current[kind]);
    if (m) out.push(m);
  }
  return out;
}
