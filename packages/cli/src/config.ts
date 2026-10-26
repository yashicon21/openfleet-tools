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
  /** Spending limits for every run (`config set budget.<key> <n>`); a project can override them. */
  budget?: Partial<BudgetLimits>;
  /** Model per agent role, per host (`config set models.<host>.<role> <model>`); unset roles use `default`, then the host's own default. */
  models?: Partial<Record<Host, RoleModels>>;
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
/** Settings with no default: `pricing` is set by editing openfleet.json, `greenfield` and `budget` with `config set <group>.<key>`. */
const OPTIONAL_KEYS = ["pricing", "greenfield", "budget", "models"];

/** Keys under `models.<host>`: the agent roles, `extensions` (extension agents) and `default` (everything else). */
export const MODEL_KEYS = [
  "default",
  "coordinator",
  "repo-coordinator",
  "planner",
  "baseline",
  "implementer",
  "tester",
  "extensions",
] as const;
export type ModelKey = (typeof MODEL_KEYS)[number];
export type RoleModels = Partial<Record<ModelKey, string>>;
/** Model names as the hosts spell them: `claude-sonnet-5-5`, `sonnet`, `Claude Sonnet 5.5`, `gpt-5 (preview)`, `opus[1m]`. */
const MODEL_NAME = /^[A-Za-z0-9][\w.:/ ()[\]-]{0,99}$/;

export interface BudgetLimits {
  /** Tokens (input, output and cache) the run may use in total, read from the host transcripts. */
  maxTokens: number;
  /** USD the run may cost, priced with `pricing`. */
  maxCost: number;
}
export const BUDGET_KEYS: (keyof BudgetLimits)[] = ["maxTokens", "maxCost"];
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

export function parseBudget(value: unknown): Partial<BudgetLimits> {
  if (!isPlainObject(value)) throw new UserError("budget must be an object of limits.");
  const out: Partial<BudgetLimits> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!(BUDGET_KEYS as string[]).includes(k)) {
      throw new UserError(`Unknown budget setting "${k}". Known: ${BUDGET_KEYS.join(", ")}.`);
    }
    const n = typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v;
    const ok = typeof n === "number" && Number.isFinite(n) && n > 0 && (k === "maxCost" || Number.isInteger(n));
    if (!ok) {
      throw new UserError(
        `budget.${k} must be a positive ${k === "maxCost" ? "number (USD)" : "integer"} (got ${JSON.stringify(v)}).`,
      );
    }
    out[k as keyof BudgetLimits] = n;
  }
  return out;
}

export function parseModels(value: unknown): Partial<Record<Host, RoleModels>> {
  if (!isPlainObject(value)) throw new UserError("models must be an object keyed by host (copilot, claude).");
  const out: Partial<Record<Host, RoleModels>> = {};
  for (const [host, roles] of Object.entries(value)) {
    if (!isHost(host)) throw new UserError(`models: unknown host "${host}". Use ${HOSTS.join(" or ")}.`);
    if (!isPlainObject(roles)) throw new UserError(`models.${host} must be an object of role → model.`);
    const entry: RoleModels = {};
    for (const [k, m] of Object.entries(roles)) {
      if (!(MODEL_KEYS as readonly string[]).includes(k)) {
        throw new UserError(`models.${host}: unknown key "${k}". Known: ${MODEL_KEYS.join(", ")}.`);
      }
      if (typeof m !== "string" || !MODEL_NAME.test(m.trim())) {
        throw new UserError(`models.${host}.${k} must be a model name (got ${JSON.stringify(m)}).`);
      }
      entry[k as ModelKey] = m.trim();
    }
    out[host] = entry;
  }
  return out;
}

/** The model an agent of `key` uses on `host`, if one is configured. */
export function modelFor(config: WorkspaceConfig, host: Host, key: Exclude<ModelKey, "default">): string | undefined {
  const m = config.models?.[host];
  return m?.[key] ?? m?.default;
}

/** `config set models.<host>.<key> <model>`; an empty value removes the key. */
function setModel(ws: Workspace, key: string, value: string): WorkspaceConfig {
  const [, host, role, ...rest] = key.split(".");
  if (!host || !role || rest.length) {
    throw new UserError(`Use: npx openfleet config set models.<${HOSTS.join("|")}>.<${MODEL_KEYS.join("|")}> <model>`);
  }
  const next = updateMarker(ws, (current) => {
    const models = isPlainObject(current.models) ? { ...current.models } : {};
    const forHost = isPlainObject(models[host]) ? { ...models[host] } : {};
    if (value.trim() === "") delete forHost[role];
    else forHost[role] = value;
    models[host] = forHost;
    parseModels(models);
    const out = { ...current, models };
    if (!Object.keys(forHost).length) delete (out.models as Record<string, unknown>)[host];
    if (!Object.keys(out.models).length) delete (out as Record<string, unknown>).models;
    return out;
  });
  return { ...DEFAULT_CONFIG, ...validate(next, configFile(ws)) };
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
  budget: parseBudget,
  models: parseModels,
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
      if (
        err instanceof UserError &&
        (key === "pricing" || key === "greenfield" || key === "budget" || key === "models")
      )
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
  if (key.startsWith("models.")) return setModel(ws, key, value);
  const group = (["greenfield", "budget"] as const).find((g) => key.startsWith(`${g}.`));
  if (group) {
    const sub = key.slice(group.length + 1);
    const parsed = PARSERS[group]({ [sub]: value });
    const next = updateMarker(ws, (current) => ({
      ...current,
      [group]: { ...(isPlainObject(current[group]) ? current[group] : {}), ...parsed },
    }));
    return { ...DEFAULT_CONFIG, ...validate(next, configFile(ws)) };
  }
  if (OPTIONAL_KEYS.includes(key)) {
    throw new UserError(
      key === "greenfield"
        ? `Set one greenfield limit at a time: npx openfleet config set greenfield.<${GREENFIELD_LIMIT_KEYS.join("|")}> <n>`
        : key === "budget"
          ? `Set one budget limit at a time: npx openfleet config set budget.<${BUDGET_KEYS.join("|")}> <n>`
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
