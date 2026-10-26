// Token usage for `openfleet report`, read from host transcripts when they are on this machine.
// Claude Code: ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl, plus
//   <sessionId>/subagents/*.jsonl with *.meta.json giving `agentType`.
// Copilot CLI: $COPILOT_HOME/session-state/<sessionId>/events.jsonl (`session.usage_record`).
// Copies of a session share messages, so each API message is counted once, by message id.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelPrice, Pricing } from "../config.js";
import type { Host } from "../hosts.js";
import { roleOf } from "./timeline.js";

export interface Usage {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  /** Cache writes whose lifetime the host does not report. */
  cacheWrite: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export function emptyUsage(): Usage {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

export function totalTokens(u: Usage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite + u.cacheWrite5m + u.cacheWrite1h;
}

function add(into: Usage, u: Usage): void {
  into.calls += u.calls;
  into.input += u.input;
  into.output += u.output;
  into.cacheRead += u.cacheRead;
  into.cacheWrite += u.cacheWrite;
  into.cacheWrite5m += u.cacheWrite5m;
  into.cacheWrite1h += u.cacheWrite1h;
}

export interface Message {
  id: string;
  model: string;
  role: string;
  usage: Usage;
}

export interface Cost {
  total: number;
  byRole: Record<string, number>;
  byModel: Record<string, number>;
  /** Models with usage but no (complete) price; their tokens are left out of `total`. */
  unpriced: string[];
}

export interface TokenReport {
  host: Host;
  files: string[];
  messages: number;
  /** Messages seen more than once (session copies) and counted once. */
  duplicates: number;
  total: Usage;
  byRole: Record<string, Usage>;
  byModel: Record<string, Usage>;
  cost?: Cost;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function readLines(file: string): unknown[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // torn line
    }
  }
  return out;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Claude Code stores a project's sessions under its cwd with every non-alphanumeric character as `-`. */
export function claudeProjectDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude");
  return path.join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

export function copilotSessionDir(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.COPILOT_HOME || path.join(env.HOME || os.homedir(), ".copilot");
  return path.join(home, "session-state", sessionId);
}

/** Messages with usage in one Claude Code transcript file. */
export function claudeMessages(file: string, role: string): Message[] {
  const out: Message[] = [];
  for (const line of readLines(file)) {
    if (!isObj(line) || line.type !== "assistant" || !isObj(line.message)) continue;
    const m = line.message;
    const u = m.usage;
    if (!isObj(u) || typeof m.id !== "string") continue;
    const cc = isObj(u.cache_creation) ? u.cache_creation : undefined;
    const w5 = num(cc?.ephemeral_5m_input_tokens);
    const w1 = num(cc?.ephemeral_1h_input_tokens);
    const writes = num(u.cache_creation_input_tokens);
    out.push({
      id: m.id,
      model: typeof m.model === "string" ? m.model : "unknown",
      role,
      usage: {
        calls: 1,
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cacheRead: num(u.cache_read_input_tokens),
        cacheWrite: cc ? Math.max(0, writes - w5 - w1) : writes,
        cacheWrite5m: w5,
        cacheWrite1h: w1,
      },
    });
  }
  return out;
}

/** Claude Code transcripts for `sessionIds`: main session (coordinator) plus subagents by agentType. */
export function claudeFiles(dir: string, sessionIds: string[]): { file: string; role: string }[] {
  const out: { file: string; role: string }[] = [];
  for (const id of sessionIds) {
    const main = path.join(dir, `${id}.jsonl`);
    if (fs.existsSync(main)) out.push({ file: main, role: "coordinator" });
    const sub = path.join(dir, id, "subagents");
    let names: string[];
    try {
      names = fs.readdirSync(sub).filter((n) => n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      let agentType: unknown;
      try {
        agentType = (JSON.parse(fs.readFileSync(path.join(sub, name.replace(/\.jsonl$/, ".meta.json")), "utf8")) as Obj)
          .agentType;
      } catch {
        agentType = undefined;
      }
      out.push({ file: path.join(sub, name), role: roleOf(agentType) });
    }
  }
  return out;
}

/** Messages with usage in a Copilot CLI session (`session.usage_record`, keyed by `apiCallId`). */
export function copilotMessages(file: string): Message[] {
  const lines = readLines(file);
  const agentRole = new Map<string, string>();
  for (const l of lines) {
    if (isObj(l) && l.type === "subagent.started" && isObj(l.data)) {
      const id = typeof l.agentId === "string" ? l.agentId : l.data.agentId;
      if (typeof id === "string") agentRole.set(id, roleOf(l.data.agentName ?? l.data.agentType));
    }
  }
  const out: Message[] = [];
  lines.forEach((l, i) => {
    if (!isObj(l) || l.type !== "session.usage_record" || !isObj(l.data) || !isObj(l.data.usage)) return;
    const u = l.data.usage;
    const agentId = typeof l.agentId === "string" ? l.agentId : u.agentId;
    const read = num(u.cacheReadTokens);
    const write = num(u.cacheWriteTokens);
    out.push({
      id: typeof u.apiCallId === "string" ? u.apiCallId : `${file}#${i}`,
      model: typeof u.model === "string" ? u.model : "unknown",
      role: typeof agentId === "string" ? (agentRole.get(agentId) ?? "other") : "coordinator",
      usage: {
        calls: 1,
        // Copilot's inputTokens include cache reads and writes.
        input: Math.max(0, num(u.inputTokens) - read - write),
        output: num(u.outputTokens),
        cacheRead: read,
        cacheWrite: write,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      },
    });
  });
  return out;
}

/**
 * One entry per message id. Copies of a session repeat a message, and Claude Code writes one line
 * per streamed content block with growing counts, so repeats keep the largest value of each field.
 * Host-generated `<synthetic>` messages carry no real usage and are dropped.
 */
export function dedupe(messages: Message[]): { unique: Message[]; duplicates: number } {
  const byId = new Map<string, Message>();
  let duplicates = 0;
  for (const m of messages) {
    if (m.model === "<synthetic>") continue;
    const prev = byId.get(m.id);
    if (!prev) {
      byId.set(m.id, { ...m, usage: { ...m.usage } });
      continue;
    }
    duplicates++;
    for (const k of Object.keys(prev.usage) as (keyof Usage)[]) prev.usage[k] = Math.max(prev.usage[k], m.usage[k]);
  }
  return { unique: [...byId.values()], duplicates };
}

/** Sum messages by role and model, counting each message id once. */
export function aggregate(host: Host, files: string[], messages: Message[]): TokenReport {
  const { unique, duplicates } = dedupe(messages);
  const report: TokenReport = {
    host,
    files,
    messages: unique.length,
    duplicates,
    total: emptyUsage(),
    byRole: {},
    byModel: {},
  };
  for (const m of unique) {
    add(report.total, m.usage);
    add((report.byRole[m.role] ??= emptyUsage()), m.usage);
    add((report.byModel[m.model] ??= emptyUsage()), m.usage);
  }
  return report;
}

const normModel = (m: string): string => m.toLowerCase().replace(/[^a-z0-9]/g, "-");

/** Price for a model: exact key first, then ignoring case and `.`/`-`/`_` differences. */
export function priceFor(pricing: Pricing, model: string): ModelPrice | undefined {
  if (pricing[model]) return pricing[model];
  const n = normModel(model);
  return Object.entries(pricing).find(([k]) => normModel(k) === n)?.[1];
}

/** USD for one usage at one price, or undefined when a needed price is missing. */
export function costOf(u: Usage, p: ModelPrice): number | undefined {
  const w = p.cacheWrite;
  const parts: [number, number | undefined][] = [
    [u.input, p.input],
    [u.output, p.output],
    [u.cacheRead, p.cacheRead],
    [u.cacheWrite, w ?? p.cacheWrite5m],
    [u.cacheWrite5m, p.cacheWrite5m ?? w],
    [u.cacheWrite1h, p.cacheWrite1h ?? w],
  ];
  let usd = 0;
  for (const [tokens, price] of parts) {
    if (!tokens) continue;
    if (price === undefined) return undefined;
    usd += (tokens / 1_000_000) * price;
  }
  return usd;
}

/** Cost per role and model. Needs the per-message split, so it is computed from messages. */
export function computeCost(messages: Message[], pricing: Pricing): Cost {
  const cost: Cost = { total: 0, byRole: {}, byModel: {}, unpriced: [] };
  for (const m of dedupe(messages).unique) {
    const p = priceFor(pricing, m.model);
    const usd = p ? costOf(m.usage, p) : undefined;
    if (usd === undefined) {
      if (!cost.unpriced.includes(m.model)) cost.unpriced.push(m.model);
      continue;
    }
    cost.total += usd;
    cost.byRole[m.role] = (cost.byRole[m.role] ?? 0) + usd;
    cost.byModel[m.model] = (cost.byModel[m.model] ?? 0) + usd;
  }
  return cost;
}

export interface TokenSource {
  host: Host;
  /** Workspace root: the host session's cwd. */
  cwd: string;
  sessionIds: string[];
  pricing?: Pricing;
  env?: NodeJS.ProcessEnv;
}

/** Token usage for a run, or undefined when no transcript is found. */
export function readTokenUsage(src: TokenSource): TokenReport | undefined {
  const env = src.env ?? process.env;
  const ids = [...new Set(src.sessionIds)];
  const files: string[] = [];
  const messages: Message[] = [];
  if (src.host === "claude") {
    for (const { file, role } of claudeFiles(claudeProjectDir(src.cwd, env), ids)) {
      files.push(file);
      messages.push(...claudeMessages(file, role));
    }
  } else {
    for (const id of ids) {
      const file = path.join(copilotSessionDir(id, env), "events.jsonl");
      if (!fs.existsSync(file)) continue;
      files.push(file);
      messages.push(...copilotMessages(file));
    }
  }
  if (!messages.length) return undefined;
  const report = aggregate(src.host, files, messages);
  if (src.pricing && Object.keys(src.pricing).length) report.cost = computeCost(messages, src.pricing);
  return report;
}
