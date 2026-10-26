// Agent hosts OpenFleet can run in: Copilot CLI and Claude Code. New workspaces pick one at init.
// One `core/` source is rendered per host: shared text plus host-only blocks, and per-host
// plugin layouts and tool names.
import path from "node:path";
import type { Workspace } from "./workspace.js";

export const HOSTS = ["copilot", "claude"] as const;
export type Host = (typeof HOSTS)[number];
export const DEFAULT_HOST: Host = "copilot";

export function isHost(value: unknown): value is Host {
  return typeof value === "string" && (HOSTS as readonly string[]).includes(value);
}

export const HOST_LABEL: Record<Host, string> = { copilot: "Copilot CLI", claude: "Claude Code" };

/** Directory `--plugin-dir` points at for a host. Copilot's plugin is the core root. */
export function pluginDir(ws: Workspace, host: Host): string {
  return host === "claude" ? path.join(ws.core, "claude") : ws.core;
}

const MARKER = /<!--\s*(?:host:([a-z]+)|\/host)\s*-->/g;

/**
 * Keep shared text and the parts for `host`; drop the other hosts' parts and every marker.
 * A part starts with `<!--host:<name>-->` and runs to the next marker (another `<!--host:…-->`
 * or `<!--/host-->`), usually on the same line so Markdown formatters leave it alone. A line
 * left empty only because its markers were removed is dropped. Text without markers is unchanged.
 */
export function renderForHost(text: string, host: Host): string {
  if (!text.includes("host:")) return text;
  const out: string[] = [];
  let current: string | undefined;
  for (const line of text.split("\n")) {
    let kept = "";
    let last = 0;
    let marked = false;
    for (const m of line.matchAll(MARKER)) {
      if (current === undefined || current === host) kept += line.slice(last, m.index);
      if (m[1] !== undefined && !isHost(m[1])) throw new Error(`Unknown host "${m[1]}" in a host marker.`);
      current = m[1];
      last = m.index + m[0].length;
      marked = true;
    }
    if (current === undefined || current === host) kept += line.slice(last);
    if (marked && kept.trim() === "") continue;
    if (!marked && current !== undefined && current !== host) continue;
    out.push(kept);
  }
  return out.join("\n");
}

const CLAUDE_TOOLS: Record<string, string[]> = {
  read: ["Read"],
  search: ["Grep", "Glob"],
  edit: ["Edit", "Write"],
  execute: ["Bash"],
  shell: ["Bash"],
  web: ["WebFetch", "WebSearch"],
  agent: ["Agent", "SendMessage"],
};

/** Claude-only tool lists for agents that have no `tools` on Copilot (all tools) but need one here. */
const CLAUDE_AGENT_TOOLS: Record<string, string[]> = {
  // Spawns role agents (nested subagents need `Agent`), runs helpers, never edits code.
  "openfleet-repo-coordinator": ["read", "search", "execute", "agent"],
};

/** Map Copilot tool aliases to Claude Code tool names (unknown names pass through). */
export function claudeTools(tools: string[]): string[] {
  const out = new Set<string>();
  for (const t of tools) for (const name of CLAUDE_TOOLS[t] ?? [t]) out.add(name);
  return [...out];
}

/** Copilot model names that differ on Claude Code. Unlisted models pass through unchanged. */
export function claudeModel(model: string): string {
  const m = /^claude-(opus|sonnet|haiku)\b/.exec(model);
  return m ? m[1]! : model;
}

interface Frontmatter {
  fields: [string, string][];
  body: string;
}

/** Split a `---` frontmatter block into raw `key: value` pairs (single-line values only). */
export function parseFrontmatter(text: string): Frontmatter {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { fields: [], body: text };
  const fields: [string, string][] = [];
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fields.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return { fields, body: text.slice(m[0].length) };
}

function yamlValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * Convert a rendered Copilot agent file (`*.agent.md`) into a Claude Code agent (`agents/*.md`):
 * `tools` becomes a comma list of Claude tool names and `model` is mapped. Other fields are kept.
 */
export function toClaudeAgent(copilotAgent: string): string {
  const { fields, body } = parseFrontmatter(copilotAgent);
  const name = fields.find(([k]) => k === "name")?.[1];
  const extra = name ? CLAUDE_AGENT_TOOLS[String(yamlValue(name))] : undefined;
  if (extra && !fields.some(([k]) => k === "tools")) fields.push(["tools", JSON.stringify(extra)]);
  const lines = fields.map(([k, raw]) => {
    const v = yamlValue(raw);
    if (k === "tools" && Array.isArray(v)) return `tools: ${claudeTools(v.map(String)).join(", ")}`;
    if (k === "model" && typeof v === "string") return `model: ${claudeModel(v)}`;
    return `${k}: ${typeof v === "string" ? JSON.stringify(v) : raw}`;
  });
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

/** Claude Code `hooks/hooks.json`: one shared handler, called as `main.js claude <event>`. */
export function claudeHooks(): Record<string, unknown> {
  const cmd = (event: string, timeout: number) => ({
    type: "command",
    command: `node "\${CLAUDE_PLUGIN_ROOT}/../lib/hooks/main.js" claude ${event}`,
    timeout,
  });
  return {
    description: "OpenFleet event capture and assignment injection.",
    hooks: {
      SessionStart: [{ hooks: [cmd("sessionStart", 10)] }],
      SessionEnd: [{ hooks: [cmd("sessionEnd", 10)] }],
      SubagentStart: [{ matcher: "^(openfleet:)?openfleet-", hooks: [cmd("subagentStart", 10)] }],
      SubagentStop: [{ matcher: "^(openfleet:)?openfleet-", hooks: [cmd("subagentStop", 30)] }],
      PostToolUse: [{ matcher: "^(Write|Edit|MultiEdit|Bash)$", hooks: [cmd("postToolUse", 10)] }],
    },
  };
}

export function claudePluginManifest(copilotPlugin: Record<string, unknown>): Record<string, unknown> {
  const { name, description, version, license } = copilotPlugin;
  return { name, description, version, license };
}
