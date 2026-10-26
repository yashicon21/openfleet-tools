// Workspace-level settings in openfleet.json, the workspace root marker. They apply to every
// project in the workspace. Agents change them only through `npx openfleet config set`.
// openfleet.json also records the core `version` the workspace was last initialized or updated with.
import fs from "node:fs";
import { readJson, writeJson } from "./fsutil.js";
import { DEFAULT_GREENFIELD_LIMITS, GREENFIELD_LIMIT_KEYS, type GreenfieldLimits } from "./greenfield.js";
import { DEFAULT_HOST, HOSTS, isHost, type Host } from "./hosts.js";
import { withLock } from "./lock.js";
import { UserError, type Workspace } from "./workspace.js";

export interface WorkspaceConfig {
  /** Children with a running or claimed planner, baseline, implementer or tester, across all projects. */
  maxParallel: number;
  /** Agent host new projects launch in (`--host` overrides it for one run). */
  host: Host;
  /** Optional token prices per model, used only by `openfleet report`. Edit openfleet.json to set it. */
  pricing?: Pricing;
  /** Scope caps for greenfield projects, checked before the spec is approved (`config set greenfield.<key> <n>`). */
  greenfield?: Partial<GreenfieldLimits>;
}

/** USD per million tokens. Cache writes: `cacheWrite5m`/`cacheWrite1h` where the host tells them apart, else `cacheWrite`. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}
export type Pricing = Record<string, ModelPrice>;

export const DEFAULT_MAX_PARALLEL = 6;
export const DEFAULT_CONFIG: WorkspaceConfig = { maxParallel: DEFAULT_MAX_PARALLEL, host: DEFAULT_HOST };
const KEYS = Object.keys(DEFAULT_CONFIG) as (keyof WorkspaceConfig)[];
/** Settings with no default: `pricing` is set by editing openfleet.json, `greenfield` with `config set greenfield.<key>`. */
const OPTIONAL_KEYS = ["pricing", "greenfield"];
const PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite5m", "cacheWrite1h"];
const REQUIRED_PRICE_FIELDS = ["input", "output", "cacheRead"];

/** Non-setting keys openfleet.json may hold. */
const META_KEYS = ["version"];

export function configFile(ws: Workspace): string {
  return ws.marker;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseMaxParallel(value: unknown): number {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    throw new UserError(`maxParallel must be a positive integer (got ${JSON.stringify(value)}).`);
  }
  return n;
}

export function parseHost(value: unknown): Host {
  if (typeof value === "string" && isHost(value)) return value;
  throw new UserError(`host must be one of ${HOSTS.join(", ")} (got ${JSON.stringify(value)}).`);
}

export function parsePricing(value: unknown): Pricing {
  const bad = (why: string) => new UserError(`pricing ${why}`);
  if (!isPlainObject(value)) throw bad("must be an object keyed by model name.");
  const out: Pricing = {};
  for (const [model, raw] of Object.entries(value)) {
    if (!isPlainObject(raw)) throw bad(`.${model} must be an object of USD-per-million-token prices.`);
    for (const [k, v] of Object.entries(raw)) {
      if (!PRICE_FIELDS.includes(k))
        throw bad(`.${model}: unknown field ${k}. Known fields: ${PRICE_FIELDS.join(", ")}.`);
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw bad(`.${model}.${k} must be a number >= 0.`);
    }
    for (const k of REQUIRED_PRICE_FIELDS) if (raw[k] === undefined) throw bad(`.${model} needs ${k}.`);
    out[model] = raw as unknown as ModelPrice;
  }
  return out;
}

function parseLimit(key: string, value: unknown): number {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    throw new UserError(`greenfield.${key} must be a positive integer (got ${JSON.stringify(value)}).`);
  }
  return n;
}

export function parseGreenfield(value: unknown): Partial<GreenfieldLimits> {
  if (!isPlainObject(value)) throw new UserError("greenfield must be an object of limits.");
  const out: Partial<GreenfieldLimits> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!(GREENFIELD_LIMIT_KEYS as string[]).includes(k)) {
      throw new UserError(`Unknown greenfield setting "${k}". Known: ${GREENFIELD_LIMIT_KEYS.join(", ")}.`);
    }
    out[k as keyof GreenfieldLimits] = parseLimit(k, v);
  }
  return out;
}

/** Effective greenfield caps: openfleet.json `greenfield` over the defaults. */
export function greenfieldLimits(config: WorkspaceConfig): GreenfieldLimits {
  return { ...DEFAULT_GREENFIELD_LIMITS, ...config.greenfield };
}

const PARSERS: { [K in keyof WorkspaceConfig]-?: (value: unknown) => WorkspaceConfig[K] } = {
  maxParallel: parseMaxParallel,
  host: parseHost,
  pricing: parsePricing,
  greenfield: parseGreenfield,
};

function validate(raw: unknown, file: string): Partial<WorkspaceConfig> {
  if (!isPlainObject(raw)) throw new UserError(`${file} must be a JSON object.`);
  if (raw.version !== undefined && typeof raw.version !== "string") {
    throw new UserError(`${file}: version must be a string.`);
  }
  const known = [...KEYS, ...OPTIONAL_KEYS];
  const unknown = Object.keys(raw).filter((k) => !known.includes(k) && !META_KEYS.includes(k));
  if (unknown.length) {
    throw new UserError(`${file}: unknown key(s) ${unknown.join(", ")}. Known keys: ${known.join(", ")}.`);
  }
  const out: Record<string, unknown> = {};
  for (const key of known as (keyof WorkspaceConfig)[]) {
    if (raw[key] === undefined) continue;
    try {
      out[key] = PARSERS[key](raw[key]);
    } catch (err) {
      if (err instanceof UserError && (key === "pricing" || key === "greenfield"))
        throw new UserError(`${file}: ${err.message}`);
      throw err;
    }
  }
  return out;
}

/** The effective workspace config: openfleet.json over the defaults (a missing file means defaults). */
export function readConfig(ws: Workspace): WorkspaceConfig {
  const file = configFile(ws);
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...validate(readJson(file), file) };
}

/** Validate and write one key under a workspace lock. Returns the new effective config. */
export function setConfig(ws: Workspace, key: string, value: string): WorkspaceConfig {
  if (key.startsWith("greenfield.")) {
    const sub = key.slice("greenfield.".length);
    const parsed = parseGreenfield({ [sub]: value });
    const next = updateMarker(ws, (current) => ({
      ...current,
      greenfield: { ...(isPlainObject(current.greenfield) ? current.greenfield : {}), ...parsed },
    }));
    return { ...DEFAULT_CONFIG, ...validate(next, configFile(ws)) };
  }
  if (OPTIONAL_KEYS.includes(key)) {
    throw new UserError(
      key === "greenfield"
        ? `Set one greenfield limit at a time: npx openfleet config set greenfield.<${GREENFIELD_LIMIT_KEYS.join("|")}> <n>`
        : `Set "${key}" by editing ${configFile(ws)} (see the CLI README).`,
    );
  }
  if (!(KEYS as string[]).includes(key)) {
    throw new UserError(`Unknown config key "${key}". Known keys: ${KEYS.join(", ")}.`);
  }
  const parsed = PARSERS[key as keyof WorkspaceConfig](value);
  const next = updateMarker(ws, (current) => ({ ...current, [key]: parsed }));
  return { ...DEFAULT_CONFIG, ...validate(next, configFile(ws)) };
}

/** Record the core version in openfleet.json, creating it with the default settings if missing. */
export function writeWorkspaceVersion(ws: Workspace, version: string): void {
  updateMarker(ws, (current) => {
    const settings = { ...current };
    delete settings.version;
    return { version, ...DEFAULT_CONFIG, ...settings };
  });
}

/** Read-modify-write openfleet.json under its lock, keeping keys the change does not touch. */
function updateMarker(
  ws: Workspace,
  change: (current: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const file = configFile(ws);
  return withLock(`${file}.lock`, () => {
    const current = fs.existsSync(file) ? readJson(file) : {};
    validate(current, file);
    const next = change(current as Record<string, unknown>);
    writeJson(file, next);
    return next;
  });
}
