// Greenfield preflight: the toolchains the chosen stack needs are on PATH, and the package
// registries they install from are reachable. Fails early with an install hint instead of
// letting a setup child discover it halfway through scaffolding.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Always needed for a greenfield run: scaffolding, git and docker-compose for the system child. */
export const BASE_TOOLCHAINS = ["node", "git", "docker"];

const INSTALL: Record<string, string> = {
  node: "https://nodejs.org (or a version manager such as nvm or fnm)",
  npm: "comes with Node.js: https://nodejs.org",
  pnpm: "`corepack enable pnpm` or https://pnpm.io/installation",
  yarn: "`corepack enable yarn` or https://yarnpkg.com",
  bun: "https://bun.sh",
  git: "https://git-scm.com/downloads",
  docker: "Docker Desktop or Docker Engine with the compose plugin: https://docs.docker.com/get-docker/",
  python3: "https://www.python.org/downloads/",
  uv: "https://docs.astral.sh/uv/getting-started/installation/",
  poetry: "https://python-poetry.org/docs/#installation",
  go: "https://go.dev/doc/install",
  cargo: "https://rustup.rs",
  java: "a JDK, for example https://adoptium.net",
  mvn: "https://maven.apache.org/install.html",
  gradle: "https://gradle.org/install/",
  dotnet: "https://dot.net",
  gh: "https://cli.github.com",
};

const TOOLCHAIN = /^[A-Za-z0-9._+-]+$/;

export function installHint(cmd: string): string {
  return INSTALL[cmd] ? `Install ${cmd}: ${INSTALL[cmd]}` : `Install ${cmd} and make sure it is on PATH.`;
}

/** The toolchains to check: the base set plus the project's, deduplicated, valid names only. */
export function toolchainsFor(recorded: readonly string[] | undefined): string[] {
  return [...new Set([...BASE_TOOLCHAINS, ...(recorded ?? [])])].filter((t) => TOOLCHAIN.test(t));
}

/** Whether `cmd` is an executable on PATH (no command is run). */
export function onPath(cmd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try {
        const file = path.join(dir, cmd + ext);
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) return true;
      } catch {
        // keep looking
      }
    }
  }
  return false;
}

/** Package registries the toolchains install from, honouring the usual mirror settings. */
export function registriesFor(toolchains: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>();
  const has = (...names: string[]) => names.some((n) => toolchains.includes(n));
  if (has("node", "npm", "pnpm", "yarn", "bun")) {
    out.add(env.npm_config_registry || env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org/");
  }
  if (has("python3", "python", "uv", "pip", "poetry")) {
    out.add(env.UV_INDEX_URL || env.PIP_INDEX_URL || "https://pypi.org/simple/");
  }
  if (has("go")) {
    const proxy = (env.GOPROXY ?? "").split(/[,|]/)[0]?.trim();
    if (proxy !== "off" && proxy !== "direct") out.add(proxy || "https://proxy.golang.org/");
  }
  return [...out];
}

export interface UrlProbe {
  (url: string): { ok: boolean; error?: string };
}

/** HTTP(S) GET with a timeout in a child process (preflight is synchronous). Any HTTP response counts as reachable. */
export const probeUrl: UrlProbe = (url) => {
  const script = `fetch(process.argv[1], { method: "GET", redirect: "manual", signal: AbortSignal.timeout(8000) })
    .then(() => process.exit(0), (e) => { console.error(String(e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e)); process.exit(1); });`;
  const res = spawnSync(process.execPath, ["-e", script, url], { encoding: "utf8", timeout: 12000 });
  if (res.status === 0) return { ok: true };
  return { ok: false, error: (res.stderr || res.error?.message || "timed out").trim() };
};
