import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installedCoreVersion, syncExtensions } from "../src/core.js";
import { addExtension } from "../src/extensions.js";
import { readJson } from "../src/fsutil.js";
import { claudeModel, claudeTools, pluginDir, renderForHost, toClaudeAgent } from "../src/hosts.js";
import { publishFixture, tmpDir, workspace } from "./helpers.js";

function files(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((rel) => fs.statSync(path.join(dir, rel)).isFile());
}

describe("renderForHost", () => {
  it("returns text without markers unchanged", () => {
    const text = "# Title\n\nNo markers, even mentioning host: here.\n";
    expect(renderForHost(text, "copilot")).toBe(text);
    expect(renderForHost(text, "claude")).toBe(text);
  });

  it("keeps the active host's inline part and drops the others", () => {
    const text = "Reply with <!--host:copilot-->`write_agent`<!--host:claude-->`SendMessage`<!--/host-->, then log it.";
    expect(renderForHost(text, "copilot")).toBe("Reply with `write_agent`, then log it.");
    expect(renderForHost(text, "claude")).toBe("Reply with `SendMessage`, then log it.");
  });

  it("supports parts that span lines and drops lines left empty by markers", () => {
    const text = ["a", "<!--host:claude-->", "only claude", "<!--/host-->", "b"].join("\n");
    expect(renderForHost(text, "copilot")).toBe("a\nb");
    expect(renderForHost(text, "claude")).toBe("a\nonly claude\nb");
  });

  it("rejects unknown hosts", () => {
    expect(() => renderForHost("<!--host:nope-->x<!--/host-->", "copilot")).toThrow(/Unknown host/);
  });
});

describe("Claude agent conversion", () => {
  it("maps tool aliases and model names", () => {
    expect(claudeTools(["read", "search", "edit", "execute"])).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Edit",
      "Write",
      "Bash",
    ]);
    expect(claudeTools(["read", "search", "agent"])).toEqual(["Read", "Grep", "Glob", "Agent", "SendMessage"]);
    expect(claudeModel("claude-sonnet-4.5")).toBe("sonnet");
    expect(claudeModel("gpt-5")).toBe("gpt-5");
  });

  it("rewrites frontmatter and keeps the body", () => {
    const md = '---\nname: openfleet-planner\ndescription: Plans.\ntools: ["read", "search"]\n---\n\nBody\n';
    expect(toClaudeAgent(md)).toBe(
      '---\nname: "openfleet-planner"\ndescription: "Plans."\ntools: Read, Grep, Glob\n---\n\nBody\n',
    );
  });
});

describe("generated plugins", () => {
  it("installs a Claude Code plugin next to the Copilot one", () => {
    const ws = workspace();
    const root = pluginDir(ws, "claude");
    const manifest = readJson<Record<string, unknown>>(path.join(root, ".claude-plugin", "plugin.json"));
    expect(manifest).toMatchObject({ name: "openfleet", license: "MIT", version: installedCoreVersion(ws) });

    const hooks = readJson<{ hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> }>(
      path.join(root, "hooks", "hooks.json"),
    ).hooks;
    expect(Object.keys(hooks).sort()).toEqual([
      "PostToolUse",
      "SessionEnd",
      "SessionStart",
      "SubagentStart",
      "SubagentStop",
    ]);
    expect(hooks.SubagentStart![0]!.matcher).toBe("^(openfleet:)?openfleet-");
    expect(hooks.SubagentStop![0]!.matcher).toBe("^(openfleet:)?openfleet-");
    expect(hooks.SubagentStart![0]!.hooks[0]!.command).toBe(
      'node "${CLAUDE_PLUGIN_ROOT}/../lib/hooks/main.js" claude subagentStart',
    );
    expect(fs.existsSync(path.join(root, "..", "lib", "hooks", "main.js"))).toBe(true);

    const agent = (name: string) => fs.readFileSync(path.join(root, "agents", `${name}.md`), "utf8");
    expect(agent("openfleet-planner")).toMatch(/^tools: Read, Grep, Glob$/m);
    expect(agent("openfleet-implementer")).toMatch(/^tools: Read, Grep, Glob, Edit, Write, Bash$/m);
    expect(agent("openfleet-tester")).toMatch(/^tools: Read, Grep, Glob, Bash$/m);
    expect(agent("openfleet-repo-coordinator")).toMatch(/^tools: Read, Grep, Glob, Bash, Agent, SendMessage$/m);
    expect(agent("openfleet-coordinator")).not.toMatch(/^tools:/m);
    expect(agent("openfleet-coordinator")).toContain("`subagent_type`");
  });

  it("renders host parts for each plugin and leaves no markers or foreign tool names", () => {
    const ws = workspace();
    const copilot = [path.join(ws.core, "agents"), path.join(ws.core, "skills")];
    const claude = [path.join(pluginDir(ws, "claude"), "agents"), path.join(pluginDir(ws, "claude"), "skills")];
    const read = (dir: string) => files(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
    for (const text of [...copilot, ...claude].flatMap(read)) expect(text).not.toMatch(/<!--\s*(host:|\/host)/);
    const claudeText = claude.flatMap(read).join("\n");
    expect(claudeText).not.toMatch(/read_agent|write_agent|ask_user/);
    expect(claudeText).toContain("SendMessage");
    const copilotText = copilot.flatMap(read).join("\n");
    expect(copilotText).toContain("read_agent");
    expect(copilotText).not.toMatch(/SendMessage|AskUserQuestion/);
  });

  it("generates extension agents and command skills for both hosts", () => {
    const ws = workspace();
    addExtension(ws, publishFixture(tmpDir()), installedCoreVersion(ws)!);
    syncExtensions(ws);
    const copilotAgents = files(path.join(ws.core, "agents"));
    const claudeAgents = files(path.join(pluginDir(ws, "claude"), "agents"));
    expect(copilotAgents.filter((f) => f.startsWith("openfleet-ext-")).map((f) => f.replace(".agent.md", ""))).toEqual(
      claudeAgents.filter((f) => f.startsWith("openfleet-ext-")).map((f) => f.replace(".md", "")),
    );
    expect(claudeAgents.some((f) => f.startsWith("openfleet-ext-publish"))).toBe(true);
    const phase = claudeAgents.find((f) => f.startsWith("openfleet-ext-publish-post-test"))!;
    expect(fs.readFileSync(path.join(pluginDir(ws, "claude"), "agents", phase), "utf8")).toMatch(
      /^tools: Read, Grep, Glob, Bash$/m,
    );
    const skills = (dir: string) => fs.readdirSync(dir).filter((s) => s.startsWith("openfleet-ext-"));
    expect(skills(path.join(pluginDir(ws, "claude"), "skills"))).toEqual(skills(path.join(ws.core, "skills")));
  });
});
