// One self-contained HTML page for `openfleet report`: inline CSS and SVG, no scripts, fonts or
// network requests. Tooltips use SVG <title>. All text from the run is escaped.
import { escapeHtml as esc, markdown } from "./markdown.js";
import type { ChildReport, ReportModel } from "./model.js";
import { makeAxis, type Axis, type Segment } from "./timeline.js";
import { totalTokens, type Usage } from "./tokens.js";

const pad = (n: number) => String(n).padStart(2, "0");

export function fmtDur(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

const clock = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function fmtDate(t: number): string {
  const d = new Date(t);
  const off = -d.getTimezoneOffset();
  const tz = `UTC${off >= 0 ? "+" : "−"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(t)} ${tz}`;
}

const num = (n: number) => n.toLocaleString("en-US");

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

const PHASES = [
  ["pending", "pending"],
  ["planning", "planning"],
  ["plan-review", "plan review"],
  ["planned", "planned, waiting"],
  ["baseline", "baseline tests"],
  ["implementing", "implementing"],
  ["testing", "testing"],
  ["post-test", "post-test"],
  ["done", "done"],
  ["blocked", "blocked"],
  ["failed", "failed"],
] as const;

const PROJECT_PHASES = [
  ["specifying", "spec"],
  ["running", "running"],
  ["finalizing", "finalizing"],
] as const;

const ROLE_ORDER = ["coordinator", "repo-coordinator", "planner", "baseline", "implementer", "tester"];
const roleClass = (r: string) => (ROLE_ORDER.includes(r) || r === "extension" ? r : "other");
const roleLabel = (r: string) =>
  ({
    coordinator: "Top coordinator",
    "repo-coordinator": "Repo coordinator",
    planner: "Planners",
    baseline: "Baseline testers",
    implementer: "Implementers",
    tester: "Testers",
    extension: "Extensions",
  })[r] ?? r;

const CSS = `
:root{--ground:#0e0e10;--raised:#1c1b21;--line:#45434c;--grid:#2c2b33;--fg:#f4f4f6;--muted:#a8a6af;--card:#eef0f2;--card-sunk:#dfe2e6;--ink:#2b1e1b;--ink-muted:#5f5754;--cyan:#48a6ee;--magenta:#ee5ad6;--lilac:#b07ad6;--yellow:#edeb3c;--counter:#1632e6;--success:#17703a;--ok:#3ccf74;--bad:#ff6b5e;--display:"Russo One","Arial Black",Impact,sans-serif;--sans:"Saira Semi Condensed","Arial Narrow",system-ui,sans-serif;--mono:"Share Tech Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--ground);color:var(--fg);font-family:var(--sans);font-size:18px;line-height:1.5;font-weight:500}
code,.mono{font-family:var(--mono);font-size:.95em}a{color:var(--cyan)}
.wrap{max-width:1180px;margin:0 auto;padding:0 28px}
header.top{position:sticky;top:0;z-index:10;background:rgba(14,14,16,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
header.top .wrap{display:flex;align-items:center;gap:24px;height:56px}
.brand{font-family:var(--display);font-size:14px;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;flex-shrink:0}.brand span{color:var(--yellow)}
nav{display:flex;gap:18px;margin-left:auto;overflow-x:auto;white-space:nowrap;scrollbar-width:none;min-width:0}nav a{color:var(--muted);text-decoration:none;font-size:15px}nav a:hover{color:var(--fg)}
section{padding:72px 0;border-bottom:1px solid var(--line);scroll-margin-top:56px}
.eyebrow{font-family:var(--display);font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--yellow);margin:0 0 12px}
h1{font-family:var(--display);font-weight:400;font-size:clamp(36px,7vw,80px);line-height:1;margin:0 0 20px;overflow-wrap:anywhere}
h2{font-family:var(--display);font-weight:400;font-size:clamp(26px,3.6vw,42px);line-height:1.1;margin:0 0 16px}
h3{font-family:var(--display);font-weight:400;font-size:20px;margin:28px 0 10px}h4{font-family:var(--display);font-weight:400;font-size:17px;margin:18px 0 8px}
p.lead{font-size:21px;color:var(--muted);max-width:820px;margin:0 0 28px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-top:36px}
.kpi{background:var(--raised);border:1px solid var(--line);border-radius:6px;padding:16px 18px 14px}
.kpi b{display:block;font-family:var(--mono);font-weight:400;font-size:clamp(24px,2.8vw,36px);line-height:1.1;font-variant-numeric:tabular-nums}
.kpi small{font-family:var(--display);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.kpi.c b{color:var(--cyan)}.kpi.m b{color:var(--magenta)}.kpi.y b{color:var(--yellow)}.kpi.g b{color:var(--ok)}
.card{background:var(--card);color:var(--ink);border-radius:8px;padding:22px 26px;overflow-wrap:anywhere}
.card a{color:var(--counter)}.card .muted{color:var(--ink-muted)}
.prose{max-width:900px}.prose p,.prose li{color:var(--fg)}.prose blockquote{margin:12px 0;padding:8px 14px;background:var(--raised);border-radius:6px;color:var(--muted)}
pre{background:var(--raised);border:1px solid var(--line);border-radius:6px;padding:12px;overflow-x:auto}
.repos{display:grid;gap:18px}.repo h3{margin-top:0}
.nodes{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.node{background:var(--raised);border:1px solid var(--line);border-radius:6px;padding:8px 12px;font-family:var(--mono);font-size:15px;color:var(--fg)}
.node.setup{border-color:var(--magenta);color:var(--magenta)}.node.integration{border-color:var(--ok);color:var(--ok)}.node.failed,.node.blocked{border-color:var(--bad);color:var(--bad)}
.node small{display:block;font-family:var(--sans);color:var(--muted);font-size:12px}
.chart{background:var(--raised);border:1px solid var(--line);border-radius:8px;padding:16px;overflow-x:auto}
.chart svg{display:block;width:100%;height:auto;min-width:720px}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:14px;color:var(--muted);margin-top:12px}
.legend i{display:inline-block;width:14px;height:10px;border-radius:2px;margin-right:6px;vertical-align:middle}
svg text{font-family:var(--sans);fill:var(--muted);font-size:12px}svg .lbl{fill:var(--fg);font-size:13px}svg .mono{font-family:var(--mono)}svg .hl{fill:var(--fg)}
.grid{stroke:var(--grid)}.pause{fill:url(#hatch)}
.ph-pending{fill:#2a2930}.ph-planning{fill:var(--magenta)}.ph-plan-review{fill:var(--lilac)}.ph-planned{fill:#3a3942}.ph-baseline{fill:#8a6cf0}.ph-implementing{fill:var(--cyan)}.ph-testing{fill:var(--yellow)}.ph-post-test,.ph-done{fill:var(--ok)}.ph-blocked{fill:#a35a2a}.ph-failed{fill:var(--bad)}
.ph-specifying{fill:var(--lilac)}.ph-running{fill:var(--cyan)}.ph-finalizing{fill:var(--ok)}.ph-other{fill:#6b6873}
.bg-pending{background:#2a2930}.bg-planning{background:var(--magenta)}.bg-plan-review{background:var(--lilac)}.bg-planned{background:#3a3942}.bg-baseline{background:#8a6cf0}.bg-implementing{background:var(--cyan)}.bg-testing{background:var(--yellow)}.bg-post-test,.bg-done{background:var(--ok)}.bg-blocked{background:#a35a2a}.bg-failed{background:var(--bad)}.bg-pause{background:repeating-linear-gradient(45deg,#45434c 0 3px,transparent 3px 6px)}
.open{opacity:.55}.merged{fill:#fff;stroke:var(--ground)}.rejected{fill:none;stroke:var(--bad);stroke-width:2.5}
.area{fill:rgba(72,166,238,.25);stroke:var(--cyan);stroke-width:2}
.bars{display:grid;gap:10px;max-width:760px}.bar{display:grid;grid-template-columns:150px 1fr 56px;align-items:center;gap:12px}
.bar span{color:var(--muted);font-size:15px}.bar b{font-family:var(--mono);font-weight:400;text-align:right}.bar div{height:14px;border-radius:2px}
.r-coordinator{background:#d6d4dc}.r-repo-coordinator{background:#9b98a6}.r-planner{background:var(--magenta)}.r-baseline{background:#8a6cf0}.r-implementer{background:var(--cyan)}.r-tester{background:var(--yellow)}.r-extension{background:var(--ok)}.r-other{background:#6b6873}
.tbl{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:16px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.card th,.card td{border-bottom-color:var(--card-sunk)}
th{font-family:var(--display);font-weight:400;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}.card th{color:var(--ink-muted)}
td.n{font-family:var(--mono)}td.n,th.n{text-align:right;white-space:nowrap}td:first-child{white-space:nowrap}tr.total td{font-weight:700;border-top:2px solid var(--card-sunk)}
.add{color:var(--success)}.del{color:#b3261e}.pass{color:var(--success)}.fail{color:#b3261e}
.dbar{display:flex;height:10px;min-width:60px;border-radius:2px;overflow:hidden;background:var(--card-sunk)}.dbar i{display:block;height:100%}.dbar .a{background:var(--success)}.dbar .d{background:#b3261e}
details{margin-top:14px}summary{cursor:pointer;color:var(--cyan)}
.callout{border:1px solid var(--line);padding:14px 18px;background:var(--raised);border-radius:6px;margin:18px 0;color:var(--muted)}.callout b{color:var(--fg)}
.assump{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}.assump .card{padding:16px 18px}
.assump .who{font-family:var(--display);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--counter)}.assump h4{margin:6px 0;font-family:var(--sans);font-weight:700;font-size:17px}.assump p{margin:4px 0 0;font-size:16px}
footer{padding:36px 0 56px;color:var(--muted);font-size:14px}
@media (max-width:640px){.wrap{padding:0 16px}section{padding:48px 0}body{font-size:17px}p.lead{font-size:18px}.bar{grid-template-columns:110px 1fr 44px}header.top .wrap{gap:12px}}
@media print{header.top{position:static}section{page-break-inside:avoid;padding:32px 0}}
`;

// ------------------------------------------------------------------ svg helpers

const W = 1140;
const L = 200;
const R = 1124;

interface Ticks {
  defs: string;
  grid: string;
  labels: string;
}

const STEPS_MIN = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 720, 1440];

/** Grid lines and clock labels for active time, plus hatched bands for pauses. */
function axisParts(ax: Axis, top: number, height: number, activeTotal: number): Ticks {
  const x = (t: number) => L + ax.frac(t) * (R - L);
  const stepMin = STEPS_MIN.find((s) => activeTotal / 60_000 / s <= 9) ?? 1440;
  const step = stepMin * 60_000;
  const lines: string[] = [];
  const labels: string[] = [];
  let lastX = -Infinity;
  const start = Math.ceil(ax.t0 / step) * step;
  for (let t = start; t <= ax.t1; t += step) {
    if (ax.gaps.some((g) => t > g.start && t < g.end)) continue;
    const px = x(t);
    lines.push(`<line class="grid" x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${top}" y2="${top + height}"/>`);
    if (px - lastX >= 46 && px <= R - 16) {
      labels.push(
        `<text class="mono" x="${px.toFixed(1)}" y="${top + height + 16}" text-anchor="middle">${clock(t)}</text>`,
      );
      lastX = px;
    }
  }
  for (const g of ax.gaps) {
    const x0 = x(g.start);
    const x1 = x(g.end);
    const mid = (x0 + x1) / 2;
    lines.push(
      `<rect class="pause" x="${(x0 + 1).toFixed(1)}" y="${top}" width="${Math.max(1, x1 - x0 - 2).toFixed(1)}" height="${height}"><title>Paused ${fmtDur(g.end - g.start)}: no events from ${clock(g.start)} to ${clock(g.end)}</title></rect>`,
    );
    labels.push(
      `<text x="${mid.toFixed(1)}" y="${top - 6}" text-anchor="middle" font-size="11">paused ${fmtDur(g.end - g.start)}</text>`,
    );
  }
  const defs = `<defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#45434c" stroke-width="3"/></pattern></defs>`;
  return { defs, grid: lines.join(""), labels: labels.join("") };
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function bars(segs: Segment[], x: (t: number) => number, y: number, h: number, who: string, project = false): string {
  return segs
    .map((s) => {
      const x0 = x(s.start);
      const w = Math.max(1.5, x(s.end) - x0);
      const known = project ? PROJECT_PHASES.some(([p]) => p === s.phase) : PHASES.some(([p]) => p === s.phase);
      const cls = `ph-${known ? s.phase : "other"}${s.open ? " open" : ""}`;
      const tip = `${who} · ${s.phase}${s.open ? " (still running)" : ""}\n${clock(s.start)} → ${clock(s.end)} (${fmtDur(s.end - s.start)})`;
      return `<rect class="${cls}" x="${x0.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${h}" rx="2"><title>${esc(tip)}</title></rect>`;
    })
    .join("");
}

function gantt(m: ReportModel, ax: Axis): string {
  const rows = m.children;
  const top = 34;
  const rowH = 28;
  const height = (rows.length + 1) * rowH;
  const x = (t: number) => L + ax.frac(t) * (R - L);
  const parts = axisParts(ax, top - 4, height + 4, m.activeMs);
  const body: string[] = [];
  body.push(`<text class="lbl hl" x="${L - 10}" y="${top + 18}" text-anchor="end">project</text>`);
  body.push(bars(m.projectSegments, x, top + 6, rowH - 12, "project", true));
  for (const s of m.projectSegments) {
    const w = x(s.end) - x(s.start);
    const label = PROJECT_PHASES.find(([p]) => p === s.phase)?.[1] ?? s.phase;
    if (w > label.length * 7 + 8) {
      body.push(
        `<text x="${((x(s.start) + x(s.end)) / 2).toFixed(1)}" y="${top - 12}" text-anchor="middle" class="hl">${esc(label)}</text>`,
      );
    }
  }
  rows.forEach((c, i) => {
    const y = top + (i + 1) * rowH;
    body.push(
      `<text class="lbl" x="${L - 10}" y="${y + 18}" text-anchor="end"><title>${esc(c.id)}</title>${esc(truncate(c.label, 26))}</text>`,
    );
    body.push(bars(c.segments, x, y + 6, rowH - 12, c.id));
    for (const r of c.planRejections) {
      body.push(
        `<circle class="rejected" cx="${x(r.ts).toFixed(1)}" cy="${y + rowH / 2}" r="6"><title>${esc(`${c.id}: plan sent back (${r.reason}) at ${clock(r.ts)}`)}</title></circle>`,
      );
    }
    if (c.mergedAt !== undefined && c.mergedAt >= m.t0) {
      const mx = x(c.mergedAt);
      body.push(
        `<path class="merged" d="M${mx.toFixed(1)} ${y + 3} l6 11 l-6 11 l-6 -11z"><title>${esc(`${c.id} merged at ${clock(c.mergedAt)}`)}</title></path>`,
      );
    }
  });
  const H = top + height + 26;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Phases of every child over time">${parts.defs}${parts.grid}${body.join("")}${parts.labels}</svg>`;
}

function concurrencyChart(m: ReportModel, ax: Axis): string {
  const top = 24;
  const h = 180;
  const x = (t: number) => L + ax.frac(t) * (R - L);
  const peak = Math.max(1, m.peakAgents);
  const y = (n: number) => top + h - (n / peak) * h;
  const parts = axisParts(ax, top, h, m.activeMs);
  const pts: string[] = [`M${x(m.t0).toFixed(1)} ${y(0)}`];
  let n = 0;
  for (const s of m.concurrency) {
    pts.push(`L${x(s.t).toFixed(1)} ${y(n).toFixed(1)}`, `L${x(s.t).toFixed(1)} ${y(s.n).toFixed(1)}`);
    n = s.n;
  }
  pts.push(`L${x(m.t1).toFixed(1)} ${y(n).toFixed(1)}`, `L${x(m.t1).toFixed(1)} ${y(0)}`, "Z");
  const yt: string[] = [];
  const stepN = Math.max(1, Math.ceil(peak / 5));
  for (let k = stepN; k <= peak; k += stepN) {
    yt.push(
      `<line class="grid" x1="${L}" x2="${R}" y1="${y(k).toFixed(1)}" y2="${y(k).toFixed(1)}"/><text class="mono" x="${L - 10}" y="${(y(k) + 4).toFixed(1)}" text-anchor="end">${k}</text>`,
    );
  }
  const peakAt = m.concurrency.find((s) => s.n === m.peakAgents);
  const peakLbl = peakAt
    ? `<text class="hl" x="${Math.min(R - 60, x(peakAt.t) + 6).toFixed(1)}" y="${(y(peak) - 6).toFixed(1)}">peak ${peak}</text>`
    : "";
  return `<svg viewBox="0 0 ${W} ${top + h + 28}" role="img" aria-label="Agents running at once over time">${parts.defs}${yt.join("")}${parts.grid}<path class="area" d="${pts.join(" ")}"><title>Agents running at once</title></path>${peakLbl}<text class="lbl" x="${L - 40}" y="${top - 8}" text-anchor="end">agents</text>${parts.labels}</svg>`;
}

function legend(items: [string, string][]): string {
  return `<div class="legend">${items.map(([cls, label]) => `<span>${cls ? `<i class="${cls}"></i>` : ""}${esc(label)}</span>`).join("")}</div>`;
}

// ------------------------------------------------------------------ sections

interface Section {
  id: string;
  nav: string;
  eyebrow: string;
  title: string;
  /** Trusted HTML: any run data in it must already be escaped. `code` spans become <code>. */
  lead?: string;
  body: string;
}

function kpi(value: string, label: string, cls = ""): string {
  return `<div class="kpi ${cls}"><b>${esc(value)}</b><small>${esc(label)}</small></div>`;
}

function splitSection(m: ReportModel): Section {
  const repos = m.repos
    .map((r) => {
      const nodes = r.children
        .map((c) => {
          const deps = c.dependsOn.length
            ? c.dependsOn.length > 3
              ? `after ${c.dependsOn.length} children`
              : `after ${c.dependsOn.map((d) => m.children.find((x) => x.id === d)?.label ?? d).join(", ")}`
            : c.kind === "integration"
              ? "merges every child"
              : "";
          const cls = c.phase === "failed" || c.phase === "blocked" ? c.phase : c.kind;
          return `<div class="node ${cls}" title="${esc(c.id)}">${esc(c.label)}<small>${esc(c.phase)}${deps ? ` · ${esc(deps)}` : ""}</small></div>`;
        })
        .join("");
      const members = r.children.filter((c) => c.kind !== "integration").length;
      return `<div class="repo"><h3>${esc(r.repo)} <small class="mono" style="color:var(--muted);font-size:14px">${plural(members, "child", "children")}</small></h3><div class="nodes">${nodes}</div></div>`;
    })
    .join("");
  const n = m.children.filter((c) => c.kind !== "integration").length;
  return {
    id: "split",
    nav: "Split",
    eyebrow: "How the work was split",
    title: `${plural(m.repos.length, "repo")}, ${plural(n, "child", "children")}.`,
    lead: "Each child is one unit of work with its own worktree and branch. Repos with several children merge them into one integration branch, setup first.",
    body: `<div class="repos">${repos}</div>`,
  };
}

function runSection(m: ReportModel, ax: Axis): Section {
  const pauses = m.gaps.length
    ? ` ${plural(m.gaps.length, "pause")} longer than ${m.gapMinutes} min (${fmtDur(m.wallMs - m.activeMs)} in total) ${m.gaps.length === 1 ? "is" : "are"} collapsed into the hatched band${m.gaps.length === 1 ? "" : "s"}.`
    : "";
  const used = new Set(m.children.flatMap((c) => c.segments.map((s) => s.phase)));
  const items: [string, string][] = PHASES.filter(([p]) => used.has(p)).map(([p, l]) => [`bg-${p}`, l]);
  if (m.children.some((c) => c.mergedAt !== undefined)) items.push(["", "◆ merged"]);
  if (m.children.some((c) => c.planRejections.length)) items.push(["", "○ plan sent back"]);
  if (m.gaps.length) items.push(["bg-pause", "paused"]);
  return {
    id: "run",
    nav: "Timeline",
    eyebrow: "The whole run",
    title: "Every child, every phase, on one timeline.",
    lead: `${fmtDur(m.activeMs)} of active work over ${fmtDur(m.wallMs)} of wall-clock time.${pauses}${m.inProgress ? " The run is still in progress; faded bars are still running." : ""}`,
    body: `<div class="chart">${gantt(m, ax)}</div>${legend(items)}`,
  };
}

function plansSection(m: ReportModel): Section | undefined {
  const rows = m.children.filter((c) => c.planSubmitted !== undefined || c.planRejections.length);
  if (!rows.length) return undefined;
  const body = rows
    .map((c) => {
      const planningStart = c.segments.find((s) => s.phase === "planning")?.start;
      const took =
        planningStart !== undefined && c.planValidated !== undefined ? fmtDur(c.planValidated - planningStart) : "–";
      const rej = c.planRejections.length
        ? c.planRejections
            .map(
              (r) =>
                `<b class="fail">${esc(r.reason || "rejected")}</b>${r.details.length ? `: ${esc(truncate(r.details.join("; "), 220))}` : ""}`,
            )
            .join("<br>")
        : "";
      return `<tr><td>${esc(c.label)}</td><td class="n">${c.planSubmitted !== undefined ? clock(c.planSubmitted) : "–"}</td><td class="n">${c.planValidated !== undefined ? clock(c.planValidated) : "–"}</td><td class="n">${took}</td><td>${rej}</td></tr>`;
    })
    .join("");
  const p = m.plans;
  const facts = [
    `${plural(p.submitted, "plan")} submitted, ${num(p.validated)} validated, ${num(p.rejected)} sent back.`,
    p.consistentAt.length
      ? `Plans were checked against each other at ${[...new Set(p.consistentAt.map(clock))].join(", ")}.`
      : "",
    p.gateAt !== undefined ? `The first code was written at ${clock(p.gateAt)}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    id: "plans",
    nav: "Plans",
    eyebrow: "The plan gate",
    title: p.rejected
      ? `${plural(p.submitted, "plan")}, ${num(p.rejected)} sent back before any code was written.`
      : `${plural(p.submitted, "plan")}, all checked before any code was written.`,
    lead: facts,
    body: `<div class="card tbl"><table><thead><tr><th>Child</th><th class="n">Submitted</th><th class="n">Validated</th><th class="n">Planning took</th><th>Sent back</th></tr></thead><tbody>${body}</tbody></table></div>`,
  };
}

function agentsSection(m: ReportModel, ax: Axis): Section | undefined {
  if (!m.agents.length) return undefined;
  const max = Math.max(...m.spawnsByRole.map(([, n]) => n));
  const bar = m.spawnsByRole
    .map(
      ([role, n]) =>
        `<div class="bar"><span>${esc(roleLabel(role))}</span><div class="r-${roleClass(role)}" style="width:${((n / max) * 100).toFixed(1)}%"></div><b>${n}</b></div>`,
    )
    .join("");
  const inferred = m.agents.filter((a) => a.inferred).length;
  return {
    id: "agents",
    nav: "Agents",
    eyebrow: "Agents",
    title: `${plural(m.agents.length, "agent spawn")}, up to ${m.peakAgents} at once.`,
    lead: "Agents running at once, from spawn to stop. The top coordinator session is not counted.",
    body: `<div class="chart">${concurrencyChart(m, ax)}</div>${inferred ? `<p class="legend">${plural(inferred, "agent")} logged no stop; each one is counted until the next session start, the next spawn for the same child and role, or the end of the data.</p>` : ""}<h3>Spawns by role</h3><div class="bars">${bar}</div>`,
  };
}

function diffBar(c: ChildReport, max: number): string {
  if (!c.diff || !max) return "";
  const a = (c.diff.added / max) * 100;
  const d = (c.diff.removed / max) * 100;
  return `<div class="dbar" title="+${c.diff.added} / −${c.diff.removed}"><i class="a" style="width:${a.toFixed(1)}%"></i><i class="d" style="width:${d.toFixed(1)}%"></i></div>`;
}

function testCell(c: ChildReport): string {
  if (!c.tests.length) return "–";
  const last = c.tests[c.tests.length - 1]!;
  return last.passed ? `<span class="pass">pass</span>` : `<span class="fail">fail</span>`;
}

function changeSection(m: ReportModel): Section | undefined {
  const rows = m.children.filter((c) => c.diff);
  if (!rows.length) return undefined;
  const max = Math.max(1, ...rows.map((c) => c.diff!.added + c.diff!.removed));
  const body = rows
    .map(
      (c) =>
        `<tr><td>${esc(c.label)}${c.diff!.source === "git" ? ' <small class="muted">(git)</small>' : ""}</td><td class="n">${num(c.diff!.files)}</td><td class="n add">+${num(c.diff!.added)}</td><td class="n del">−${num(c.diff!.removed)}</td><td style="width:30%">${diffBar(c, max)}</td><td class="n">${c.retries}</td><td>${testCell(c)}</td><td>${c.merged ? "merged" : esc(c.phase)}</td></tr>`,
    )
    .join("");
  return {
    id: "change",
    nav: "Change",
    eyebrow: "What changed",
    title: `+${num(m.diff.added)} / −${num(m.diff.removed)} lines across ${plural(m.diff.files, "file")}.`,
    lead: "From each child's latest worktree snapshot (or git when there is none). Totals use the integration branch where a repo has one.",
    body: `<div class="card tbl"><table><thead><tr><th>Child</th><th class="n">Files</th><th class="n">Added</th><th class="n">Removed</th><th></th><th class="n">Retries</th><th>Tester</th><th>Outcome</th></tr></thead><tbody>${body}</tbody></table></div>`,
  };
}

function testsSection(m: ReportModel): Section | undefined {
  if (!m.tests.runs) return undefined;
  const rows = m.children.filter((c) => c.tests.length);
  const body = rows
    .map((c) => {
      const passed = c.tests.filter((t) => t.passed).length;
      return `<tr><td>${esc(c.label)}</td><td class="n">${c.tests.length}</td><td class="n pass">${passed}</td><td class="n fail">${c.tests.length - passed}</td><td>${testCell(c)}</td></tr>`;
    })
    .join("");
  const failures = rows.flatMap((c) => c.tests.filter((t) => !t.passed).map((t) => ({ c, t })));
  const fails = failures.length
    ? `<details><summary>${plural(failures.length, "failed run")}</summary><div class="tbl"><table><thead><tr><th>Time</th><th>Child</th><th>Command</th><th class="n">Exit</th><th>Summary</th></tr></thead><tbody>${failures
        .map(
          ({ c, t }) =>
            `<tr><td class="n">${clock(t.ts)}</td><td>${esc(c.label)}</td><td><code>${esc(truncate(t.command, 120))}</code></td><td class="n">${t.exitCode ?? "–"}</td><td>${esc(truncate(t.summary, 300))}</td></tr>`,
        )
        .join("")}</tbody></table></div></details>`
    : "";
  return {
    id: "tests",
    nav: "Tests",
    eyebrow: "Tests",
    title: `${plural(m.tests.runs, "test run")}, ${num(m.tests.passed)} passed.`,
    lead: "Every command a baseline tester or tester ran (`test.run` events). A failed run sends the child back to its implementer until retries run out.",
    body: `<div class="card tbl"><table><thead><tr><th>Child</th><th class="n">Runs</th><th class="n">Passed</th><th class="n">Failed</th><th>Last result</th></tr></thead><tbody>${body}</tbody></table></div>${fails}`,
  };
}

function usageRow(label: string, u: Usage, cost?: number, showCost = false): string {
  const writes = u.cacheWrite + u.cacheWrite5m + u.cacheWrite1h;
  return `<tr><td>${esc(label)}</td><td class="n">${num(u.calls)}</td><td class="n">${num(u.output)}</td><td class="n">${num(u.input)}</td><td class="n">${num(writes)}</td><td class="n">${num(u.cacheRead)}</td><td class="n">${num(totalTokens(u))}</td>${showCost ? `<td class="n">${cost === undefined ? "no price" : usd(cost)}</td>` : ""}</tr>`;
}

function tokensSection(m: ReportModel): Section {
  const t = m.tokens;
  if (!t) {
    return {
      id: "tokens",
      nav: "Tokens",
      eyebrow: "Tokens and cost",
      title: "Token usage: not available.",
      lead: `No ${m.host === "claude" ? "Claude Code" : "Copilot CLI"} transcripts for this run's sessions were found on this machine.`,
      body: "",
    };
  }
  const showCost = t.cost !== undefined;
  const head = `<thead><tr><th></th><th class="n">Calls</th><th class="n">Output</th><th class="n">Fresh input</th><th class="n">Cache writes</th><th class="n">Cache reads</th><th class="n">Total</th>${showCost ? '<th class="n">Cost</th>' : ""}</tr></thead>`;
  const roles = Object.entries(t.byRole).sort(
    (a, b) => (ROLE_ORDER.indexOf(a[0]) + 1 || 99) - (ROLE_ORDER.indexOf(b[0]) + 1 || 99),
  );
  const byRole = roles.map(([r, u]) => usageRow(roleLabel(r), u, t.cost?.byRole[r], showCost)).join("");
  const byModel = Object.entries(t.byModel)
    .map(([mod, u]) => usageRow(mod, u, t.cost?.byModel[mod], showCost))
    .join("");
  const total = usageRow("Total", t.total, t.cost?.total, showCost).replace("<tr>", '<tr class="total">');
  const reads = totalTokens(t.total) ? Math.round((t.total.cacheRead / totalTokens(t.total)) * 100) : 0;
  const notes: string[] = [
    `${plural(t.messages, "API message")} from ${plural(t.files.length, "transcript")}, each counted once by message id${t.duplicates ? ` (${num(t.duplicates)} repeated entries merged)` : ""}. ${reads}% of the tokens are cache reads.`,
  ];
  if (!showCost) notes.push("Add a <code>pricing</code> table to <code>openfleet.json</code> to show cost.");
  else if (t.cost!.unpriced.length) {
    notes.push(
      `No price for ${t.cost!.unpriced.map((x) => `<code>${esc(x)}</code>`).join(", ")}; those tokens are not in the cost.`,
    );
  }
  if (showCost)
    notes.push(
      "Cost uses the prices in <code>openfleet.json</code>. On a subscription plan, usage counts against plan limits instead.",
    );
  return {
    id: "tokens",
    nav: "Tokens",
    eyebrow: "Tokens and cost",
    title: showCost
      ? `${fmtTokens(totalTokens(t.total))} tokens, about ${usd(t.cost!.total)}.`
      : `${fmtTokens(totalTokens(t.total))} tokens across ${plural(t.total.calls, "API call")}.`,
    lead: notes.join(" "),
    body: `<h3>By role</h3><div class="card tbl"><table>${head}<tbody>${byRole}${total}</tbody></table></div><h3>By model</h3><div class="card tbl"><table>${head}<tbody>${byModel}</tbody></table></div>`,
  };
}

function assumptionsSection(m: ReportModel): Section | undefined {
  if (m.summary.assumptions) {
    return {
      id: "assumptions",
      nav: "Decisions",
      eyebrow: "Assumptions and decisions",
      title: "Decisions made without stopping the run.",
      body: `<div class="prose">${markdown(m.summary.assumptions)}</div>`,
    };
  }
  if (!m.assumptions.length) return undefined;
  const cards = m.assumptions
    .map(
      (a) =>
        `<div class="card"><div class="who">${esc(a.child)} · ${esc(a.actor)}</div><h4>${esc(truncate(a.question, 200))}</h4><p>${esc(a.decision)}</p>${a.rationale ? `<p class="muted">${esc(a.rationale)}</p>` : ""}</div>`,
    )
    .join("");
  return {
    id: "assumptions",
    nav: "Decisions",
    eyebrow: "Assumptions and decisions",
    title: `${plural(m.assumptions.length, "decision")} made without stopping the run.`,
    lead: "Every `assumption` event: questions the coordinators answered themselves so the run could continue.",
    body: `<div class="assump">${cards}</div>`,
  };
}

function textSection(
  id: string,
  nav: string,
  eyebrow: string,
  title: string,
  md: string | undefined,
): Section | undefined {
  if (!md) return undefined;
  return { id, nav, eyebrow, title, body: `<div class="prose">${markdown(md)}</div>` };
}

function topSection(m: ReportModel): string {
  const k: string[] = [
    kpi(fmtDur(m.activeMs), "active time", "c"),
    kpi(fmtDur(m.wallMs), "wall clock"),
    kpi(num(m.children.filter((c) => c.kind !== "integration").length), "children", "m"),
    kpi(num(m.agents.length), "agent spawns", "y"),
    kpi(num(m.peakAgents), "agents at once", "y"),
    kpi(`${num(m.tests.passed)}/${num(m.tests.runs)}`, "test runs passed", "g"),
    kpi(`+${fmtTokens(m.diff.added)}`, `lines added, ${fmtTokens(m.diff.removed)} removed`, "g"),
  ];
  if (m.plans.rejected) k.push(kpi(num(m.plans.rejected), "plans sent back", "m"));
  if (m.retries) k.push(kpi(num(m.retries), "retries", "m"));
  if (m.tokens) k.push(kpi(fmtTokens(totalTokens(m.tokens.total)), "tokens", "c"));
  if (m.tokens?.cost) k.push(kpi(usd(m.tokens.cost.total), "cost", "c"));
  const meta = [
    m.status,
    m.host === "claude" ? "Claude Code" : "Copilot CLI",
    m.origin,
    m.completionMode,
    `${fmtDate(m.t0)} → ${clock(m.t1)}`,
  ]
    .filter(Boolean)
    .map((s) => esc(s!))
    .join(" · ");
  return `<section id="top"><div class="wrap"><p class="eyebrow">OpenFleet run report</p><h1>${esc(m.project)}</h1>${m.title ? `<p class="lead">${esc(m.title)}</p>` : ""}<p class="mono" style="color:var(--muted)">${meta}</p><div class="kpis">${k.join("")}</div></div></section>`;
}

function renderSection(s: Section, i: number): string {
  return `<section id="${s.id}"><div class="wrap"><p class="eyebrow">${pad(i + 1)} · ${esc(s.eyebrow)}</p><h2>${esc(s.title)}</h2>${s.lead ? `<p class="lead">${s.lead.replace(/`([^`]+)`/g, "<code>$1</code>")}</p>` : ""}${s.body}</div></section>`;
}

export function renderReport(m: ReportModel): string {
  const ax = makeAxis(m.t0, Math.max(m.t1, m.t0 + 1), m.gaps);
  const ask: Section | undefined = m.goal
    ? {
        id: "ask",
        nav: "Ask",
        eyebrow: "The ask",
        title: m.title ?? "What the run set out to do.",
        body: `<div class="prose">${markdown(m.goal)}</div>`,
      }
    : undefined;
  const list = [
    ask,
    splitSection(m),
    runSection(m, ax),
    plansSection(m),
    agentsSection(m, ax),
    changeSection(m),
    testsSection(m),
    textSection("coverage", "Coverage", "Coverage", "Test coverage.", m.summary.coverage),
    tokensSection(m),
    assumptionsSection(m),
    textSection("follow-ups", "Follow-ups", "Follow-ups", "What people need to do next.", m.summary.followUps),
    textSection("lessons", "Lessons", "Lessons", "Lessons for the next run.", m.summary.lessons),
  ].filter((s): s is Section => s !== undefined);
  const nav = list.map((s) => `<a href="#${s.id}">${esc(s.nav)}</a>`).join("");
  const footer = `Generated by <code>openfleet report</code>${m.version ? ` ${esc(m.version)}` : ""} at ${fmtDate(m.generatedAt)} from ${plural(m.eventCount, "event")} in <code>projects/${esc(m.project)}/events.jsonl</code>, <code>state.json</code>, <code>spec.md</code> and <code>summary.md</code>.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="openfleet report">
<title>${esc(m.project)} · OpenFleet run report</title>
<style>${CSS}</style>
</head>
<body>
<header class="top"><div class="wrap"><div class="brand">Open<span>Fleet</span> · report</div><nav>${nav}</nav></div></header>
<main>
${topSection(m)}
${list.map(renderSection).join("\n")}
</main>
<footer><div class="wrap">${footer}</div></footer>
</body>
</html>
`;
}
