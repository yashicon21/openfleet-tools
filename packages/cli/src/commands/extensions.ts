import { syncExtensions, installedCoreVersion, packageVersion } from "../core.js";
import { readCoreIndex } from "../coreindex.js";
import { addExtension, describePermissions, phaseAgentNames, readLock, removeExtension } from "../extensions.js";
import { launch } from "../launcher.js";
import { requireWorkspace, UserError } from "../workspace.js";
import { out, warn } from "./output.js";
import { readConfig } from "../config.js";

export function cmdAdd(args: string[]): number {
  const ws = requireWorkspace();
  const source = args[0];
  if (!source) throw new UserError("Usage: openfleet add <git-url[#ref]|path>");
  const coreVersion = installedCoreVersion(ws) ?? packageVersion();
  const { entry, manifest, replaced } = addExtension(ws, source, coreVersion);
  syncExtensions(ws, warn);
  out(
    `${replaced ? "Updated" : "Added"} extension ${manifest.name}@${manifest.version} (${entry.sha === "local" ? "local" : entry.sha.slice(0, 12)}).`,
  );
  const agents = phaseAgentNames(manifest);
  (manifest.phases ?? []).forEach((p, i) => {
    const extra = [p.blocking ? "blocking" : "advisory", p.when ? `when ${p.when.files.join(", ")}` : ""];
    out(`Phase: ${p.slot} (${extra.filter(Boolean).join(", ")}) runs as agent openfleet:${agents[i]}.`);
  });
  for (const a of manifest.augments ?? []) out(`Augment: appended to the ${a.role} agent's instructions.`);
  const settings = Object.keys(manifest.settings ?? {});
  if (settings.length) out(`Settings: ${settings.join(", ")} (override in extensions.config.json).`);
  out("Declared permissions:");
  out(describePermissions(manifest));
  const cmds = Object.keys(manifest.commands ?? {});
  if (cmds.length) out(`Commands: ${cmds.map((c) => `npx openfleet ${c}`).join(", ")}`);
  return 0;
}

export function cmdRemove(args: string[]): number {
  const ws = requireWorkspace();
  const name = args[0];
  if (!name) throw new UserError("Usage: openfleet remove <extension>");
  removeExtension(ws, name);
  syncExtensions(ws, warn);
  out(`Removed extension ${name}.`);
  return 0;
}

export function cmdExtensions(): number {
  const ws = requireWorkspace();
  const lock = readLock(ws);
  if (!lock.extensions.length) {
    out("No extensions installed. Add one with `npx openfleet add <git-url|path>`.");
    return 0;
  }
  for (const e of lock.extensions) {
    out(
      `${e.enabled ? "✓" : "✗"} ${e.name}@${e.version}  ${e.source}  ${e.sha === "local" ? "local" : e.sha.slice(0, 12)}${e.disabledReason ? `  (disabled: ${e.disabledReason})` : ""}`,
    );
  }
  return 0;
}

/** Try to run an extension-declared command. Returns undefined when no extension declares it. */
export function runExtensionCommand(
  command: string,
  args: string[],
  passthrough: string[],
  opts: { ask?: boolean } = {},
): number | undefined {
  const ws = requireWorkspace();
  if (!readCoreIndex(ws)?.commands[command]) return undefined;
  const cmd = syncExtensions(ws, warn).commands[command];
  if (!cmd) return undefined;
  const prompt = [
    `Run the OpenFleet extension command \`openfleet ${command}\` from extension \`${cmd.extension}\`.`,
    `Use the skill \`${cmd.skill}\` and follow its instructions exactly.`,
    args.length ? `Arguments: ${args.join(" ")}` : "No arguments were given.",
  ].join("\n");
  return launch({
    ws,
    agent: cmd.agent,
    prompt,
    newSession: true,
    name: `openfleet ${command}`,
    passthrough,
    ask: opts.ask,
    host: readConfig(ws).host,
  });
}
