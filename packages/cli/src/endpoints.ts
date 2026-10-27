// Named model endpoints (`endpoints.<name>` in openfleet.json) for roles that run as their own
// sessions. A role model `<endpoint>:<model>` (for example `ollama:qwen3-coder:30b`) sends that
// role's Claude Code session to the endpoint's Anthropic-compatible server. No proxy: the session
// gets `ANTHROPIC_BASE_URL` and friends in its own env. Copilot CLI has no such setting, so
// endpoints are Claude Code only; `roleHosts` runs a role on Claude Code under a Copilot coordinator.
import { spawnSync } from "node:child_process";
import { HOSTS, isHost, type Host } from "./hosts.js";
import { UserError } from "./workspace.js";

export interface Endpoint {
  /** Base URL of an Anthropic Messages API compatible server, e.g. `http://localhost:11434` (Ollama). */
  baseUrl: string;
  /** Literal token; only for local servers, because openfleet.json is committed. */
  token?: string;
  /** Name of the env var that holds the token, read when a session starts. */
  tokenEnv?: string;
  /** Smallest context window (tokens) a role session needs on this endpoint. Default 32768. */
  minContext?: number;
}
export type Endpoints = Record<string, Endpoint>;

export const ENDPOINT_KEYS: (keyof Endpoint)[] = ["baseUrl", "token", "tokenEnv", "minContext"];
export const DEFAULT_MIN_CONTEXT = 32_768;
const ENDPOINT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];

/** Roles that run as their own sessions and may use an endpoint or another host. */
export const SESSION_ROLES = ["planner", "baseline", "implementer", "tester", "extensions"] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];
export function isSessionRole(key: string): key is SessionRole {
  return (SESSION_ROLES as readonly string[]).includes(key);
}

/** How child roles run: as subagents of the coordinator's session, or as their own CLI-started sessions. */
export const AGENT_MODES = ["subagent", "session"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function parseEndpoint(name: string, raw: unknown): Endpoint {
  const bad = (why: string) => new UserError(`endpoints.${name} ${why}`);
  if (!isPlainObject(raw)) throw bad("must be an object with baseUrl and token or tokenEnv.");
  for (const k of Object.keys(raw)) {
    if (!(ENDPOINT_KEYS as string[]).includes(k))
      throw bad(`: unknown key "${k}". Known: ${ENDPOINT_KEYS.join(", ")}.`);
  }
  const { baseUrl, token, tokenEnv, minContext } = raw;
  let url: URL | undefined;
  try {
    url = typeof baseUrl === "string" ? new URL(baseUrl) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || !["http:", "https:"].includes(url.protocol)) throw bad("needs baseUrl, an http(s) URL.");
  const out: Endpoint = { baseUrl: (baseUrl as string).replace(/\/+$/, "") };
  if (token !== undefined) {
    if (typeof token !== "string" || !token) throw bad(".token must be a non-empty string.");
    if (!isLocalUrl(out.baseUrl)) {
      throw bad(
        `.token is only allowed for local servers (openfleet.json is committed). Use tokenEnv: npx openfleet config set endpoints.${name}.tokenEnv <ENV_VAR>`,
      );
    }
    out.token = token;
  }
  if (tokenEnv !== undefined) {
    if (typeof tokenEnv !== "string" || !ENV_NAME.test(tokenEnv)) throw bad(".tokenEnv must be an env var name.");
    out.tokenEnv = tokenEnv;
  }
  if (out.token && out.tokenEnv) throw bad("has both token and tokenEnv; keep one.");
  if (minContext !== undefined) {
    const n = typeof minContext === "string" && /^\d+$/.test(minContext.trim()) ? Number(minContext) : minContext;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1024) throw bad(".minContext must be an integer >= 1024.");
    out.minContext = n;
  }
  return out;
}

export function parseEndpoints(value: unknown): Endpoints {
  if (!isPlainObject(value)) throw new UserError("endpoints must be an object keyed by endpoint name.");
  const out: Endpoints = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!ENDPOINT_NAME.test(name)) {
      throw new UserError(`endpoints: "${name}" is not a valid name (lowercase letters, digits and -).`);
    }
    out[name] = parseEndpoint(name, raw);
  }
  return out;
}

export function parseRoleHosts(value: unknown): Partial<Record<SessionRole, Host>> {
  if (!isPlainObject(value)) throw new UserError("roleHosts must be an object of role → host.");
  const out: Partial<Record<SessionRole, Host>> = {};
  for (const [role, host] of Object.entries(value)) {
    if (!isSessionRole(role)) {
      throw new UserError(`roleHosts: unknown role "${role}". Known: ${SESSION_ROLES.join(", ")}.`);
    }
    if (typeof host !== "string" || !isHost(host)) {
      throw new UserError(`roleHosts.${role} must be one of ${HOSTS.join(", ")} (got ${JSON.stringify(host)}).`);
    }
    out[role] = host;
  }
  return out;
}

export function parseAgentMode(value: unknown): AgentMode {
  if (typeof value === "string" && (AGENT_MODES as readonly string[]).includes(value)) return value as AgentMode;
  throw new UserError(`agentMode must be one of ${AGENT_MODES.join(", ")} (got ${JSON.stringify(value)}).`);
}

export interface ModelRef {
  /** Endpoint name, when the value starts with `<endpoint>:`. */
  endpoint?: string;
  model: string;
}

/**
 * Split a configured model value. `ollama:qwen3-coder:30b` is endpoint `ollama`, model
 * `qwen3-coder:30b` when `ollama` is a configured endpoint. A value with a lowercase prefix and a
 * colon that names no endpoint is refused, so a typo never silently goes to the host's own provider.
 */
export function splitModel(value: string, endpoints: Endpoints | undefined, where: string): ModelRef {
  const m = /^([a-z][a-z0-9-]*):(.+)$/.exec(value);
  if (!m) return { model: value };
  const [, name, model] = m as unknown as [string, string, string];
  if (endpoints?.[name]) return { endpoint: name, model };
  const known = Object.keys(endpoints ?? {});
  throw new UserError(
    `${where}: "${name}" is not a configured endpoint${known.length ? ` (known: ${known.join(", ")})` : ""}. ` +
      `Add it first: npx openfleet config set endpoints.${name}.baseUrl <url>`,
  );
}

/** Env a Claude Code session needs to use `ep` with `model`. Background and subagent calls stay on the endpoint too. */
export function endpointEnv(ep: Endpoint, model: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const token = ep.token ?? (ep.tokenEnv ? env[ep.tokenEnv] : undefined);
  if (ep.tokenEnv && !token) {
    throw new UserError(`Set ${ep.tokenEnv} (the token for ${ep.baseUrl}) in the environment and try again.`);
  }
  return {
    ANTHROPIC_BASE_URL: ep.baseUrl,
    ANTHROPIC_AUTH_TOKEN: token ?? "openfleet",
    // An API key in the shell would win over the auth token.
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
  };
}

// ---------------------------------------------------------------- preflight

export interface HttpResult {
  status: number;
  body?: unknown;
  error?: string;
}
/** Synchronous JSON request; injectable for tests. */
export type HttpJson = (url: string, init?: { method?: "GET" | "POST"; body?: unknown; token?: string }) => HttpResult;

export const httpJson: HttpJson = (url, init = {}) => {
  const script = `const [url, method, body, token] = process.argv.slice(1);
fetch(url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body || undefined, signal: AbortSignal.timeout(5000) })
  .then(async (r) => { const t = await r.text(); let b; try { b = JSON.parse(t); } catch {} process.stdout.write(JSON.stringify({ status: r.status, body: b })); },
        (e) => { process.stdout.write(JSON.stringify({ status: 0, error: String(e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e) })); });`;
  const res = spawnSync(
    process.execPath,
    [
      "-e",
      script,
      url,
      init.method ?? "GET",
      init.body === undefined ? "" : JSON.stringify(init.body),
      init.token ?? "",
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  try {
    return JSON.parse(res.stdout) as HttpResult;
  } catch {
    return { status: 0, error: (res.stderr || res.error?.message || "timed out").trim() };
  }
};

export type EndpointCheck = "endpoint" | "endpoint-model" | "endpoint-context" | "endpoint-tools";

export interface EndpointCheckResult {
  endpoint: string;
  model: string;
  check: EndpointCheck;
  ok: boolean;
  /** A problem the server did not let us confirm; reported, but it does not fail preflight. */
  warning?: boolean;
  error?: string;
}

/** Context length an Ollama `/api/show` reply reports (`model_info.<arch>.context_length`). */
function showContext(body: unknown): number | undefined {
  const info = isPlainObject(body) && isPlainObject(body.model_info) ? body.model_info : undefined;
  if (!info) return undefined;
  for (const [k, v] of Object.entries(info)) if (k.endsWith(".context_length") && typeof v === "number") return v;
  return undefined;
}

/** Names an Ollama `/api/tags` or OpenAI-style `/v1/models` reply lists. */
function listedModels(body: unknown): string[] | undefined {
  if (!isPlainObject(body)) return undefined;
  const list = Array.isArray(body.models) ? body.models : Array.isArray(body.data) ? body.data : undefined;
  if (!list) return undefined;
  return list.flatMap((m) =>
    isPlainObject(m) ? [m.name, m.model, m.id].filter((x): x is string => typeof x === "string") : [],
  );
}

const withLatest = (m: string) => (m.includes(":") ? m : `${m}:latest`);

/**
 * Check that a role's endpoint can serve it: the server answers, it has the model, the model's
 * context (and, for a loaded Ollama model, the server's context setting) is at least `minContext`,
 * and the model supports tool calls. Servers that do not report something get a warning.
 */
export function checkEndpoint(
  name: string,
  ep: Endpoint,
  model: string,
  { http = httpJson, env = process.env }: { http?: HttpJson; env?: NodeJS.ProcessEnv } = {},
): EndpointCheckResult[] {
  const token = ep.token ?? (ep.tokenEnv ? env[ep.tokenEnv] : undefined);
  const base = { endpoint: name, model };
  const out: EndpointCheckResult[] = [];
  const minContext = ep.minContext ?? DEFAULT_MIN_CONTEXT;
  const ollama = http(`${ep.baseUrl}/api/version`, { token });
  const isOllama = ollama.status === 200;
  const models = isOllama ? http(`${ep.baseUrl}/api/tags`, { token }) : http(`${ep.baseUrl}/v1/models`, { token });
  if (!isOllama && models.status === 0) {
    out.push({
      ...base,
      check: "endpoint",
      ok: false,
      error: `${ep.baseUrl} is not reachable (${models.error ?? ollama.error ?? "no response"}). Start the server (for Ollama: \`ollama serve\`) or fix endpoints.${name}.baseUrl.`,
    });
    return out;
  }
  if (ep.tokenEnv && !token) {
    out.push({
      ...base,
      check: "endpoint",
      ok: false,
      error: `Set ${ep.tokenEnv}; endpoints.${name} reads its token from it.`,
    });
    return out;
  }
  if (models.status === 401 || models.status === 403) {
    out.push({
      ...base,
      check: "endpoint",
      ok: false,
      error: `${ep.baseUrl} refused the token (HTTP ${models.status}).`,
    });
    return out;
  }
  out.push({ ...base, check: "endpoint", ok: true });
  const names = listedModels(models.body);
  if (!names) {
    out.push({
      ...base,
      check: "endpoint-model",
      ok: true,
      warning: true,
      error: "the server does not list its models",
    });
  } else if (!names.some((n) => n === model || withLatest(n) === withLatest(model))) {
    out.push({
      ...base,
      check: "endpoint-model",
      ok: false,
      error: isOllama ? `not on the server. Run \`ollama pull ${model}\`.` : "not listed by the server.",
    });
    return out;
  } else out.push({ ...base, check: "endpoint-model", ok: true });
  if (!isOllama) {
    out.push({
      ...base,
      check: "endpoint-context",
      ok: true,
      warning: true,
      error: "the server does not report a context length",
    });
    return out;
  }
  const show = http(`${ep.baseUrl}/api/show`, { method: "POST", body: { model }, token });
  const trained = showContext(show.body);
  const ps = http(`${ep.baseUrl}/api/ps`, { token });
  const loaded =
    isPlainObject(ps.body) && Array.isArray(ps.body.models)
      ? (ps.body.models as unknown[]).find(
          (m) => isPlainObject(m) && (m.name === model || m.model === model || m.name === withLatest(model)),
        )
      : undefined;
  const served = isPlainObject(loaded) && typeof loaded.context_length === "number" ? loaded.context_length : undefined;
  if (trained !== undefined && trained < minContext) {
    out.push({
      ...base,
      check: "endpoint-context",
      ok: false,
      error: `${model} supports ${trained} tokens of context; OpenFleet needs ${minContext}. Pick a larger-context model or lower endpoints.${name}.minContext.`,
    });
  } else if (served !== undefined && served < minContext) {
    out.push({
      ...base,
      check: "endpoint-context",
      ok: false,
      error: `the server runs ${model} with a ${served}-token context; OpenFleet needs ${minContext}. Restart it with \`OLLAMA_CONTEXT_LENGTH=${minContext} ollama serve\`.`,
    });
  } else if (served === undefined) {
    out.push({
      ...base,
      check: "endpoint-context",
      ok: true,
      warning: true,
      error: `the model is not loaded, so the server's context setting is unknown. Make sure \`ollama serve\` runs with OLLAMA_CONTEXT_LENGTH=${minContext} or more.`,
    });
  } else out.push({ ...base, check: "endpoint-context", ok: true });
  const caps = isPlainObject(show.body) && Array.isArray(show.body.capabilities) ? show.body.capabilities : undefined;
  if (caps && !caps.includes("tools")) {
    out.push({ ...base, check: "endpoint-tools", ok: false, error: `${model} does not support tool calls.` });
  } else out.push({ ...base, check: "endpoint-tools", ok: true, ...(caps ? {} : { warning: true }) });
  return out;
}
