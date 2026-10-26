import { DEFAULT_HOST, isHost, type Host } from "../hosts.js";
import type { HookOutput, HookPayload } from "./handlers.js";

const EVENTS = ["sessionStart", "sessionEnd", "subagentStart", "subagentStop", "postToolUse"] as const;
export type HookEvent = (typeof EVENTS)[number];

/** Parses `<host> <event>` or the legacy `<event>` (Copilot). Event names may be camelCase or PascalCase. */
export function parseHookArgs(argv: string[]): { host: Host; event: string } {
  const [first = "", second] = argv;
  const [host, raw] = isHost(first) ? [first, second ?? ""] : [DEFAULT_HOST, first];
  const event = raw ? raw[0]!.toLowerCase() + raw.slice(1) : "";
  return { host, event };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Normalises a host's raw hook payload into OpenFleet's internal shape. */
export function normalizePayload(host: Host, raw: Record<string, unknown>): HookPayload {
  if (host === "copilot") return { ...raw, host };
  const out: HookPayload = { host };
  const set = (key: keyof HookPayload, value: unknown) => {
    if (value !== undefined) out[key] = value;
  };
  set("sessionId", str(raw.session_id));
  set("cwd", str(raw.cwd));
  set("source", str(raw.source));
  set("reason", str(raw.reason));
  set("agentId", str(raw.agent_id));
  set("agentName", str(raw.agent_type));
  set("agentType", str(raw.agent_type));
  set("toolName", str(raw.tool_name));
  set("toolArgs", raw.tool_input);
  set("response", str(raw.last_assistant_message));
  return out;
}

const PASCAL: Record<string, string> = {
  sessionStart: "SessionStart",
  subagentStart: "SubagentStart",
};

/** Formats a handler's output for the host, or returns undefined when nothing should be written. */
export function formatOutput(host: Host, event: string, out: HookOutput): string | undefined {
  if (!out.additionalContext) return undefined;
  if (host === "copilot") return JSON.stringify(out);
  const hookEventName = PASCAL[event];
  if (!hookEventName) return undefined;
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: out.additionalContext } });
}

export function isHookEvent(event: string): event is HookEvent {
  return (EVENTS as readonly string[]).includes(event);
}
