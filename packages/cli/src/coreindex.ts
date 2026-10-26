// Kept dependency-free: hooks import this from the copied core/lib.
import path from "node:path";
import type { ExtRole, Slot } from "./extensions.js";
import { isFile, readJson } from "./fsutil.js";
import type { Workspace } from "./workspace.js";
import type { Host } from "./hosts.js";

export interface SlotEntry {
  extension: string;
  /** Qualified agent name, e.g. `openfleet:openfleet-ext-<name>-<slot>`. */
  agent: string;
  blocking: boolean;
  when?: { files: string[] };
  timeoutMinutes: number;
  /** Hosts the phase runs in; missing means every host. */
  hosts?: Host[];
}

export interface CoreIndex {
  v: 2;
  coreVersion: string;
  /** Phase entries per slot, in lock order then manifest order. */
  slots: Record<Slot, SlotEntry[]>;
  augments: Record<ExtRole, string[]>;
  commands: Record<string, { extension: string; agent: string; skill: string }>;
  /** Resolved settings per extension (declared defaults + workspace overrides). */
  settings: Record<string, Record<string, string>>;
}

export function readCoreIndex(ws: Workspace): CoreIndex | undefined {
  const file = path.join(ws.core, "extensions.json");
  return isFile(file) ? readJson<CoreIndex>(file) : undefined;
}

/** Find the slot entry for a (possibly qualified) phase agent name. */
export function findSlotEntry(index: CoreIndex, agentName: string): (SlotEntry & { slot: Slot }) | undefined {
  const bare = agentName.includes(":") ? agentName.slice(agentName.indexOf(":") + 1) : agentName;
  for (const [slot, list] of Object.entries(index.slots) as [Slot, SlotEntry[]][]) {
    const hit = list.find((e) => e.agent === agentName || e.agent.endsWith(`:${bare}`));
    if (hit) return { ...hit, slot };
  }
  return undefined;
}
