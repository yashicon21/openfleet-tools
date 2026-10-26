#!/usr/bin/env node
// Entry point invoked by the generated hooks.json: `node lib/hooks/main.js [host] <event>`.
// Without a host the payload is treated as Copilot's. Never fails the host session: errors are logged and the hook exits 0.
import fs from "node:fs";
import path from "node:path";
import { formatOutput, normalizePayload, parseHookArgs } from "./adapters.js";
import { resolveContext, runHook, type HookPayload } from "./handlers.js";

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main(): void {
  const { host, event } = parseHookArgs(process.argv.slice(2));
  let payload: HookPayload = {};
  try {
    const raw = readStdin();
    payload = normalizePayload(host, raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {});
    const text = formatOutput(host, event, runHook(event, payload));
    if (text) process.stdout.write(text);
  } catch (err) {
    try {
      const ctx = resolveContext(payload);
      if (ctx) {
        fs.appendFileSync(
          path.join(ctx.ws.root, ".hook-errors.log"),
          `${new Date().toISOString()} ${event}: ${(err as Error).stack ?? String(err)}\n`,
        );
      }
    } catch {
      // ignore
    }
  }
}

main();
