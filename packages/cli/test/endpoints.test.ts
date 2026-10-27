import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/commands/project.js";
import { syncExtensions } from "../src/core.js";
import { agentModeOf, readConfig, roleTarget, setConfig } from "../src/config.js";
import { checkEndpoint, endpointEnv, splitModel, type HttpJson, type HttpResult } from "../src/endpoints.js";
import { readJson } from "../src/fsutil.js";
import { parseFrontmatter, pluginDir } from "../src/hosts.js";
import { endpointChecks, preflight } from "../src/preflight.js";
import { readState, updateState } from "../src/state.js";
import { projectPaths, UserError } from "../src/workspace.js";
import { gitRepo, tmpDir, workspace } from "./helpers.js";

const OLLAMA = "http://localhost:11434";

/** A fake Ollama server: routes by path. */
function ollama(opts: { models?: string[]; trained?: number; loaded?: number; tools?: boolean; down?: boolean } = {}) {
  const { models = ["qwen3-coder:30b"], trained = 262_144, loaded, tools = true, down = false } = opts;
  const calls: string[] = [];
  const http: HttpJson = (url): HttpResult => {
    calls.push(url);
    if (down) return { status: 0, error: "ECONNREFUSED" };
    const p = new URL(url).pathname;
    if (p === "/api/version") return { status: 200, body: { version: "0.14.0" } };
    if (p === "/api/tags") return { status: 200, body: { models: models.map((name) => ({ name, model: name })) } };
    if (p === "/api/show") {
      return {
        status: 200,
        body: {
          model_info: { "qwen3moe.context_length": trained },
          capabilities: tools ? ["completion", "tools"] : ["completion"],
        },
      };
    }
    if (p === "/api/ps") {
      return {
        status: 200,
        body: { models: loaded === undefined ? [] : [{ name: models[0], context_length: loaded }] },
      };
    }
    return { status: 404 };
  };
  return { http, calls };
}

function sessionWorkspace() {
  const ws = workspace();
  setConfig(ws, "agentMode", "session");
  setConfig(ws, "endpoints.ollama.baseUrl", OLLAMA);
  setConfig(ws, "endpoints.ollama.token", "ollama");
  return ws;
}

describe("endpoints config", () => {
  it("stores endpoints, role hosts and the agent mode and resolves role targets", () => {
    const ws = sessionWorkspace();
    setConfig(ws, "models.claude.default", "sonnet");
    setConfig(ws, "models.claude.implementer", "ollama:qwen3-coder:30b");
    setConfig(ws, "roleHosts.implementer", "claude");
    expect(readJson<Record<string, unknown>>(ws.marker)).toMatchObject({
      agentMode: "session",
      endpoints: { ollama: { baseUrl: OLLAMA, token: "ollama" } },
      roleHosts: { implementer: "claude" },
      models: { claude: { default: "sonnet", implementer: "ollama:qwen3-coder:30b" } },
    });
    const config = readConfig(ws);
    expect(agentModeOf(config)).toBe("session");
    expect(roleTarget(config, "copilot", "implementer")).toEqual({
      host: "claude",
      model: "qwen3-coder:30b",
      endpoint: { name: "ollama", baseUrl: OLLAMA, token: "ollama" },
    });
    expect(roleTarget(config, "claude", "planner")).toEqual({ host: "claude", model: "sonnet" });
    expect(roleTarget(config, "copilot", "tester")).toEqual({ host: "copilot" });
  });

  it("keeps endpoint models out of agent files", () => {
    const ws = sessionWorkspace();
    setConfig(ws, "models.claude.implementer", "ollama:qwen3-coder:30b");
    const file = path.join(pluginDir(ws, "claude"), "agents", "openfleet-implementer.md");
    syncExtensions(ws);
    const model = parseFrontmatter(fs.readFileSync(file, "utf8")).fields.find(([k]) => k === "model");
    expect(model).toBeUndefined();
  });

  it("defaults to subagent mode and requires session mode for endpoints and role hosts", () => {
    const ws = workspace();
    expect(agentModeOf(readConfig(ws))).toBe("subagent");
    setConfig(ws, "endpoints.ollama.baseUrl", OLLAMA);
    expect(() => setConfig(ws, "models.claude.implementer", "ollama:qwen3-coder:30b")).toThrow(
      /needs role sessions.*config set agentMode session/,
    );
    expect(() => setConfig(ws, "roleHosts.implementer", "claude")).toThrow(/needs role sessions/);
    setConfig(ws, "agentMode", "session");
    setConfig(ws, "models.claude.implementer", "ollama:qwen3-coder:30b");
    expect(() => setConfig(ws, "agentMode", "subagent")).toThrow(/needs role sessions/);
    expect(() => setConfig(ws, "agentMode", "threads")).toThrow(/agentMode must be one of subagent, session/);
  });

  it("refuses endpoints on Copilot, on judgment roles and unknown endpoint names", () => {
    const ws = sessionWorkspace();
    expect(() => setConfig(ws, "models.copilot.implementer", "ollama:qwen3-coder:30b")).toThrow(
      /Claude Code only.*roleHosts\.implementer claude/,
    );
    expect(() => setConfig(ws, "models.claude.coordinator", "ollama:qwen3-coder:30b")).toThrow(
      /runs in the coordinator's session/,
    );
    expect(() => setConfig(ws, "models.claude.default", "ollama:qwen3-coder:30b")).toThrow(/default model/);
    expect(() => setConfig(ws, "models.claude.tester", "olama:qwen3-coder:30b")).toThrow(
      /"olama" is not a configured endpoint \(known: ollama\)/,
    );
    // An endpoint still in use cannot be removed.
    setConfig(ws, "models.claude.tester", "ollama:qwen3-coder:30b");
    expect(() => setConfig(ws, "endpoints.ollama", "")).toThrow(/"ollama" is not a configured endpoint/);
    setConfig(ws, "models.claude.tester", "");
    setConfig(ws, "endpoints.ollama", "");
    expect(readConfig(ws).endpoints).toBeUndefined();
  });

  it("validates endpoint fields and keeps literal tokens to local servers", () => {
    const ws = workspace();
    expect(() => setConfig(ws, "endpoints.lab.baseUrl", "ftp://x")).toThrow(/http\(s\) URL/);
    setConfig(ws, "endpoints.lab.baseUrl", "https://llm.example.com/");
    expect(readConfig(ws).endpoints?.lab?.baseUrl).toBe("https://llm.example.com");
    expect(() => setConfig(ws, "endpoints.lab.token", "sk-123")).toThrow(/only allowed for local servers.*tokenEnv/);
    setConfig(ws, "endpoints.lab.tokenEnv", "LAB_TOKEN");
    expect(() => setConfig(ws, "endpoints.lab.tokenEnv", "bad-name")).toThrow(/env var name/);
    expect(() => setConfig(ws, "endpoints.lab.minContext", "100")).toThrow(/>= 1024/);
    setConfig(ws, "endpoints.lab.minContext", "65536");
    expect(() => setConfig(ws, "endpoints.lab.port", "1")).toThrow(/unknown key "port"/);
    expect(() => setConfig(ws, "endpoints.Lab.baseUrl", OLLAMA)).toThrow(/not a valid name/);
    expect(() => setConfig(ws, "endpoints", "x")).toThrow(/one endpoints entry at a time/);
    expect(readConfig(ws).endpoints).toEqual({
      lab: { baseUrl: "https://llm.example.com", tokenEnv: "LAB_TOKEN", minContext: 65536 },
    });
  });

  it("splits endpoint models and leaves plain model names alone", () => {
    const eps = { ollama: { baseUrl: OLLAMA } };
    expect(splitModel("ollama:qwen3-coder:30b", eps, "x")).toEqual({ endpoint: "ollama", model: "qwen3-coder:30b" });
    expect(splitModel("claude-sonnet-5-5", eps, "x")).toEqual({ model: "claude-sonnet-5-5" });
    expect(splitModel("Claude Sonnet 5.5", eps, "x")).toEqual({ model: "Claude Sonnet 5.5" });
    expect(() => splitModel("lab:m", eps, "models.claude.tester")).toThrow(UserError);
  });

  it("builds the session env for an endpoint", () => {
    const env = endpointEnv({ baseUrl: OLLAMA, token: "ollama" }, "qwen3-coder:30b", {});
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: OLLAMA,
      ANTHROPIC_AUTH_TOKEN: "ollama",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3-coder:30b",
      CLAUDE_CODE_SUBAGENT_MODEL: "qwen3-coder:30b",
    });
    expect(endpointEnv({ baseUrl: "https://x", tokenEnv: "T" }, "m", { T: "secret" }).ANTHROPIC_AUTH_TOKEN).toBe(
      "secret",
    );
    expect(() => endpointEnv({ baseUrl: "https://x", tokenEnv: "T" }, "m", {})).toThrow(/Set T/);
  });
});

describe("endpoint preflight", () => {
  const ep = { baseUrl: OLLAMA, token: "ollama" };
  const failed = (r: ReturnType<typeof checkEndpoint>) => r.filter((c) => !c.ok).map((c) => c.check);

  it("passes a reachable Ollama with the model, enough context and tool support", () => {
    const r = checkEndpoint("ollama", ep, "qwen3-coder:30b", { http: ollama({ loaded: 65_536 }).http });
    expect(r.every((c) => c.ok && !c.warning)).toBe(true);
    expect(r.map((c) => c.check)).toEqual(["endpoint", "endpoint-model", "endpoint-context", "endpoint-tools"]);
  });

  it("fails when the server is down, the model is missing, the context is short or tools are missing", () => {
    expect(failed(checkEndpoint("ollama", ep, "qwen3-coder:30b", { http: ollama({ down: true }).http }))).toEqual([
      "endpoint",
    ]);
    const missing = checkEndpoint("ollama", ep, "devstral", { http: ollama().http });
    expect(missing.find((c) => !c.ok)?.error).toMatch(/ollama pull devstral/);
    const short = checkEndpoint("ollama", ep, "qwen3-coder:30b", { http: ollama({ loaded: 4096 }).http });
    expect(short.find((c) => !c.ok)?.error).toMatch(/OLLAMA_CONTEXT_LENGTH=32768 ollama serve/);
    const small = checkEndpoint("ollama", { ...ep, minContext: 300_000 }, "qwen3-coder:30b", {
      http: ollama({ loaded: 300_000 }).http,
    });
    expect(small.find((c) => !c.ok)?.error).toMatch(/supports 262144 tokens/);
    expect(
      failed(checkEndpoint("ollama", ep, "qwen3-coder:30b", { http: ollama({ loaded: 65_536, tools: false }).http })),
    ).toEqual(["endpoint-tools"]);
  });

  it("warns when the model is not loaded, so the server context is unknown", () => {
    const r = checkEndpoint("ollama", ep, "qwen3-coder", { http: ollama({ models: ["qwen3-coder:latest"] }).http });
    expect(r.every((c) => c.ok)).toBe(true);
    expect(r.find((c) => c.check === "endpoint-context")?.warning).toBe(true);
  });

  it("runs from project preflight once per endpoint model, only in session mode", () => {
    const root = tmpDir();
    const repo = gitRepo(path.join(root, "web"));
    const ws = sessionWorkspace();
    fs.writeFileSync(ws.reposFile, JSON.stringify({ v: 1, repos: { web: { path: repo, defaultBranch: "main" } } }));
    setConfig(ws, "models.claude.implementer", "ollama:qwen3-coder:30b");
    setConfig(ws, "models.claude.tester", "ollama:qwen3-coder:30b");
    createProject(ws, "p");
    updateState(projectPaths(ws, "p"), (st) => {
      st.host = "claude";
    });
    const fake = ollama({ loaded: 4096 });
    const report = preflight(ws, "p", undefined, { http: fake.http });
    expect(report.ok).toBe(false);
    expect(report.hint).toMatch(/model endpoints/);
    expect(fake.calls.filter((u) => u.endsWith("/api/version"))).toHaveLength(1);
    expect(readState(projectPaths(ws, "p")).preflight?.ok).toBe(false);
    // A Copilot project without role hosts has no Claude Code roles, so no endpoint checks.
    updateState(projectPaths(ws, "p"), (st) => {
      st.host = "copilot";
    });
    expect(endpointChecks(ws, readState(projectPaths(ws, "p")), { http: fake.http })).toEqual([]);
  });
});
